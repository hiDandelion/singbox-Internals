# وسائل نقل Hosts و Local لـ DNS

المصدر: `dns/transport/hosts/hosts.go`، `dns/transport/hosts/hosts_file.go`، `dns/transport/local/local.go`، `dns/transport/dhcp/dhcp.go`

## وسيلة نقل Hosts

تحل وسيلة نقل Hosts النطاقات مقابل إدخالات ملف hosts والتعيينات المُعرفة مسبقاً.

### البنية

```go
type Transport struct {
    dns.TransportAdapter
    files      []*File
    predefined map[string][]netip.Addr
}
```

### أولوية البحث

1. **الإدخالات المُعرفة مسبقاً** يتم فحصها أولاً (التعيينات داخل التكوين)
2. **ملفات Hosts** يتم فحصها بالترتيب

```go
func (t *Transport) Exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    question := message.Question[0]
    domain := mDNS.CanonicalName(question.Name)
    if question.Qtype == mDNS.TypeA || question.Qtype == mDNS.TypeAAAA {
        if addresses, ok := t.predefined[domain]; ok {
            return dns.FixedResponse(message.Id, question, addresses, C.DefaultDNSTTL), nil
        }
        for _, file := range t.files {
            addresses := file.Lookup(domain)
            if len(addresses) > 0 {
                return dns.FixedResponse(message.Id, question, addresses, C.DefaultDNSTTL), nil
            }
        }
    }
    return &mDNS.Msg{
        MsgHdr: mDNS.MsgHdr{Id: message.Id, Rcode: mDNS.RcodeNameError, Response: true},
        Question: []mDNS.Question{question},
    }, nil
}
```

يتم التعامل فقط مع استعلامات A و AAAA. النطاقات غير القابلة للحل تُرجع NXDOMAIN. الاستعلامات غير المتعلقة بالعناوين تُرجع أيضاً NXDOMAIN.

### الإنشاء

```go
func NewTransport(ctx context.Context, logger log.ContextLogger, tag string,
    options option.HostsDNSServerOptions) (adapter.DNSTransport, error) {
    if len(options.Path) == 0 {
        files = append(files, NewFile(DefaultPath))  // /etc/hosts
    } else {
        for _, path := range options.Path {
            files = append(files, NewFile(filemanager.BasePath(ctx, os.ExpandEnv(path))))
        }
    }
    if options.Predefined != nil {
        for _, entry := range options.Predefined.Entries() {
            predefined[mDNS.CanonicalName(entry.Key)] = entry.Value
        }
    }
}
```

يتم تحويل أسماء النطاقات إلى الشكل القانوني (أحرف صغيرة، FQDN مع نقطة لاحقة) عبر `mDNS.CanonicalName`.

### تحليل ملف Hosts

توفر بنية `File` تحليلاً كسولاً مع التخزين المؤقت:

```go
type File struct {
    path    string
    access  sync.Mutex
    modTime time.Time
    modSize int64
    entries map[string][]netip.Addr
    lastCheck time.Time
}
```

**إبطال ذاكرة التخزين المؤقت**: يُعاد تحليل الملف فقط عندما:
- مرت أكثر من 5 ثوانٍ منذ آخر فحص، و
- تغير وقت تعديل الملف أو حجمه

```go
func (f *File) Lookup(domain string) []netip.Addr {
    f.access.Lock()
    defer f.access.Unlock()
    if time.Since(f.lastCheck) > 5*time.Second {
        stat, err := os.Stat(f.path)
        if stat.ModTime() != f.modTime || stat.Size() != f.modSize {
            f.entries = parseHostsFile(f.path)
            f.modTime = stat.ModTime()
            f.modSize = stat.Size()
        }
        f.lastCheck = time.Now()
    }
    return f.entries[domain]
}
```

**قواعد التحليل**:
- الأسطر التي تبدأ بـ `#` هي تعليقات
- كل سطر: `<IP> <اسم المضيف1> [اسم المضيف2] ...`
- يتم تحويل أسماء المضيفات إلى الشكل القانوني (أحرف صغيرة + نقطة لاحقة)
- يتم دعم عناوين IPv4 و IPv6
- يتم تجميع الإدخالات المتعددة لنفس اسم المضيف

### المسار الافتراضي

```go
// Linux/macOS
var DefaultPath = "/etc/hosts"

// Windows
var DefaultPath = `C:\Windows\System32\drivers\etc\hosts`
```

## وسيلة نقل DNS المحلية

تحل وسيلة النقل المحلية استعلامات DNS باستخدام محلل النظام.

### البنية (غير Darwin)

```go
type Transport struct {
    dns.TransportAdapter
    ctx      context.Context
    logger   logger.ContextLogger
    hosts    *hosts.File
    dialer   N.Dialer
    preferGo bool
    resolved ResolvedResolver
}
```

### أولوية الحل

1. **systemd-resolved** (Linux فقط): إذا كان النظام يستخدم resolved، تُرسل الاستعلامات عبر D-Bus
2. **ملف hosts المحلي**: يتم فحصه قبل حل الشبكة
3. **محلل النظام**: يرجع إلى `net.Resolver` الخاص بـ Go

```go
func (t *Transport) Exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    // 1. Try systemd-resolved
    if t.resolved != nil {
        resolverObject := t.resolved.Object()
        if resolverObject != nil {
            return t.resolved.Exchange(resolverObject, ctx, message)
        }
    }
    // 2. Try local hosts file
    if question.Qtype == mDNS.TypeA || question.Qtype == mDNS.TypeAAAA {
        addresses := t.hosts.Lookup(dns.FqdnToDomain(question.Name))
        if len(addresses) > 0 {
            return dns.FixedResponse(message.Id, question, addresses, C.DefaultDNSTTL), nil
        }
    }
    // 3. System resolver
    return t.exchange(ctx, message, question.Name)
}
```

### كشف systemd-resolved

```go
func (t *Transport) Start(stage adapter.StartStage) error {
    switch stage {
    case adapter.StartStateInitialize:
        if !t.preferGo {
            if isSystemdResolvedManaged() {
                resolvedResolver, err := NewResolvedResolver(t.ctx, t.logger)
                if err == nil {
                    err = resolvedResolver.Start()
                    if err == nil {
                        t.resolved = resolvedResolver
                    }
                }
            }
        }
    }
}
```

إذا كان `preferGo` مضبوطاً على true، يتم استخدام محلل Go مباشرة، متجاوزاً systemd-resolved.

### متغير Darwin (macOS)

على macOS، تستخدم وسيلة النقل المحلية خوادم DNS المكتشفة عبر DHCP أو محلل النظام مع معالجة خاصة لنطاقات `.local` (mDNS).

## وسيلة نقل DHCP

تكتشف وسيلة نقل DHCP خوادم DNS ديناميكياً عبر DHCPv4:

### الاكتشاف

ترسل وسيلة النقل رسائل DHCPv4 Discover/Request على واجهة الشبكة المحددة وتستخرج عناوين خوادم DNS من رسائل DHCP Offer/Ack.

### مراقبة الواجهة

يتم تخزين خوادم DNS مؤقتاً لكل واجهة ويتم تحديثها عند:
- تغير حالة الواجهة (تشغيل/إيقاف الرابط)
- تغير عنوان الواجهة
- انتهاء صلاحية ذاكرة التخزين المؤقت

### تخزين الخوادم مؤقتاً

```go
type Transport struct {
    dns.TransportAdapter
    ctx           context.Context
    logger        logger.ContextLogger
    interfaceName string
    autoInterface bool
    // ...
    transportAccess sync.Mutex
    transports      []adapter.DNSTransport
    lastUpdate      time.Time
}
```

تنشئ وسيلة نقل DHCP وسائل نقل فرعية (عادةً UDP) لكل خادم DNS مكتشف وتفوض الاستعلامات إليها.

## التكوين

### Hosts

```json
{
  "dns": {
    "servers": [
      {
        "tag": "hosts",
        "type": "hosts",
        "path": ["/etc/hosts", "/custom/hosts"],
        "predefined": {
          "myserver.local": ["192.168.1.100"]
        }
      }
    ]
  }
}
```

### Local

```json
{
  "dns": {
    "servers": [
      {
        "tag": "local",
        "type": "local",
        "prefer_go": false
      }
    ]
  }
}
```

### DHCP

```json
{
  "dns": {
    "servers": [
      {
        "tag": "dhcp",
        "type": "dhcp",
        "interface": "eth0"
      }
    ]
  }
}
```
