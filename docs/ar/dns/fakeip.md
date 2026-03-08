# وسيلة نقل FakeIP لـ DNS

المصدر: `dns/transport/fakeip/fakeip.go`، `dns/transport/fakeip/store.go`، `dns/transport/fakeip/memory.go`

## نظرة عامة

يقوم FakeIP بتعيين عناوين IP اصطناعية من نطاقات مُعدة مسبقاً لاستعلامات DNS. بدلاً من حل النطاق إلى عنوان IP الحقيقي، يخصص FakeIP عنواناً فريداً من مجمع ويحتفظ بتعيين ثنائي الاتجاه (نطاق <-> IP). عند إجراء اتصال بعنوان FakeIP، يحل الموجه النطاق الأصلي ويتصل بالوجهة الحقيقية.

## وسيلة النقل

```go
var _ adapter.FakeIPTransport = (*Transport)(nil)

type Transport struct {
    dns.TransportAdapter
    logger logger.ContextLogger
    store  adapter.FakeIPStore
}

func (t *Transport) Exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    question := message.Question[0]
    if question.Qtype != mDNS.TypeA && question.Qtype != mDNS.TypeAAAA {
        return nil, E.New("only IP queries are supported by fakeip")
    }
    address, err := t.store.Create(dns.FqdnToDomain(question.Name), question.Qtype == mDNS.TypeAAAA)
    return dns.FixedResponse(message.Id, question, []netip.Addr{address}, C.DefaultDNSTTL), nil
}

func (t *Transport) Store() adapter.FakeIPStore {
    return t.store
}
```

يتم دعم استعلامات A و AAAA فقط. أنواع الاستعلامات الأخرى (MX، TXT، إلخ) تُرجع خطأ.

تنفذ وسيلة النقل واجهة `adapter.FakeIPTransport` التي توفر `Store()` للوصول المباشر إلى مخزن FakeIP.

## المخزن

يدير المخزن تخصيص عناوين IP والتعيين ثنائي الاتجاه للنطاق/العنوان:

```go
type Store struct {
    ctx        context.Context
    logger     logger.Logger
    inet4Range netip.Prefix
    inet6Range netip.Prefix
    inet4Last  netip.Addr    // Broadcast address (upper bound)
    inet6Last  netip.Addr
    storage    adapter.FakeIPStorage

    addressAccess sync.Mutex
    inet4Current  netip.Addr  // Last allocated IPv4
    inet6Current  netip.Addr  // Last allocated IPv6
}
```

### تخصيص عناوين IP

تخصيص تسلسلي مع الالتفاف:

```go
func (s *Store) Create(domain string, isIPv6 bool) (netip.Addr, error) {
    // Check if domain already has an address
    if address, loaded := s.storage.FakeIPLoadDomain(domain, isIPv6); loaded {
        return address, nil
    }

    s.addressAccess.Lock()
    defer s.addressAccess.Unlock()

    // Double-check after lock
    if address, loaded := s.storage.FakeIPLoadDomain(domain, isIPv6); loaded {
        return address, nil
    }

    var address netip.Addr
    if !isIPv6 {
        nextAddress := s.inet4Current.Next()
        if nextAddress == s.inet4Last || !s.inet4Range.Contains(nextAddress) {
            nextAddress = s.inet4Range.Addr().Next().Next()  // Wrap around, skip network+first
        }
        s.inet4Current = nextAddress
        address = nextAddress
    } else {
        // Same logic for IPv6
    }

    s.storage.FakeIPStore(address, domain)
    s.storage.FakeIPSaveMetadataAsync(&adapter.FakeIPMetadata{...})
    return address, nil
}
```

يتخطى التخصيص عنوان الشبكة وأول عنوان مضيف (`.0` و `.1` بمصطلحات IPv4)، بدءاً من العنوان الثالث. عند استنفاد النطاق، يلتف حول نفسه ويعيد تدوير العناوين المستخدمة سابقاً.

### حساب عنوان البث

```go
func broadcastAddress(prefix netip.Prefix) netip.Addr {
    addr := prefix.Addr()
    raw := addr.As16()
    bits := prefix.Bits()
    if addr.Is4() { bits += 96 }
    for i := bits; i < 128; i++ {
        raw[i/8] |= 1 << (7 - i%8)
    }
    if addr.Is4() {
        return netip.AddrFrom4([4]byte(raw[12:]))
    }
    return netip.AddrFrom16(raw)
}
```

يحسب عنوان البث بتعيين جميع بتات المضيف إلى 1.

### الاستمرارية

يتحقق المخزن من وجود ملف تخزين مؤقت عند بدء التشغيل:

```go
func (s *Store) Start() error {
    cacheFile := service.FromContext[adapter.CacheFile](s.ctx)
    if cacheFile != nil && cacheFile.StoreFakeIP() {
        storage = cacheFile
    }
    if storage == nil {
        storage = NewMemoryStorage()
    }
    // Restore state if ranges match
    metadata := storage.FakeIPMetadata()
    if metadata != nil && metadata.Inet4Range == s.inet4Range && metadata.Inet6Range == s.inet6Range {
        s.inet4Current = metadata.Inet4Current
        s.inet6Current = metadata.Inet6Current
    } else {
        // Reset on range change
        s.inet4Current = s.inet4Range.Addr().Next()
        s.inet6Current = s.inet6Range.Addr().Next()
        storage.FakeIPReset()
    }
}
```

إذا تغيرت النطاقات المُعدة، تتم إعادة تعيين المخزن. وإلا، يُستأنف التخصيص من آخر موضع محفوظ.

عند الإغلاق، يتم حفظ البيانات الوصفية:

```go
func (s *Store) Close() error {
    return s.storage.FakeIPSaveMetadata(&adapter.FakeIPMetadata{
        Inet4Range:   s.inet4Range,
        Inet6Range:   s.inet6Range,
        Inet4Current: s.inet4Current,
        Inet6Current: s.inet6Current,
    })
}
```

### البحث

```go
func (s *Store) Lookup(address netip.Addr) (string, bool) {
    return s.storage.FakeIPLoad(address)
}

func (s *Store) Contains(address netip.Addr) bool {
    return s.inet4Range.Contains(address) || s.inet6Range.Contains(address)
}
```

## التخزين في الذاكرة

تنفيذ في الذاكرة باستخدام خرائط ثنائية الاتجاه:

```go
type MemoryStorage struct {
    addressByDomain4 map[string]netip.Addr
    addressByDomain6 map[string]netip.Addr
    domainByAddress  map[netip.Addr]string
}
```

ثلاث خرائط تحتفظ بالتعيين ثنائي الاتجاه:
- `addressByDomain4`: نطاق -> عنوان IPv4
- `addressByDomain6`: نطاق -> عنوان IPv6
- `domainByAddress`: عنوان (v4 أو v6) -> نطاق

### التخزين مع إعادة التدوير

عند تخزين تعيين عنوان-نطاق جديد، تتم إزالة أي تعيين موجود لنفس العنوان أولاً:

```go
func (s *MemoryStorage) FakeIPStore(address netip.Addr, domain string) error {
    if oldDomain, loaded := s.domainByAddress[address]; loaded {
        if address.Is4() {
            delete(s.addressByDomain4, oldDomain)
        } else {
            delete(s.addressByDomain6, oldDomain)
        }
    }
    s.domainByAddress[address] = domain
    if address.Is4() {
        s.addressByDomain4[domain] = address
    } else {
        s.addressByDomain6[domain] = address
    }
    return nil
}
```

هذا يتعامل مع حالة الالتفاف حيث يُعاد تدوير عنوان لنطاق جديد.

## التكوين

```json
{
  "dns": {
    "servers": [
      {
        "tag": "fakeip",
        "type": "fakeip",
        "inet4_range": "198.18.0.0/15",
        "inet6_range": "fc00::/18"
      }
    ]
  }
}
```

| الحقل | الوصف |
|-------|-------|
| `inet4_range` | نطاق IPv4 بتنسيق CIDR لتخصيص FakeIP |
| `inet6_range` | نطاق IPv6 بتنسيق CIDR لتخصيص FakeIP |

تستخدم النطاقات النموذجية عناوين التوثيق وفقاً لـ RFC 5737 (`198.18.0.0/15`) أو عناوين ULA (`fc00::/18`).
