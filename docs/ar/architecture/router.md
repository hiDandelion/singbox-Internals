# الموجّه والقواعد

الموجّه هو محرك القرار المركزي. يطابق الاتصالات مع القواعد وينفّذ الإجراءات. على عكس Xray-core حيث تختار القواعد ببساطة وسم صادر، تنتج قواعد sing-box **إجراءات** يمكنها الاستكشاف وحل DNS والتوجيه والرفض واعتراض DNS.

**المصدر**: `route/router.go`، `route/route.go`، `route/rule/`

## هيكل الموجّه

```go
type Router struct {
    ctx               context.Context
    logger            log.ContextLogger
    inbound           adapter.InboundManager
    outbound          adapter.OutboundManager
    dns               adapter.DNSRouter
    dnsTransport      adapter.DNSTransportManager
    connection        adapter.ConnectionManager
    network           adapter.NetworkManager
    rules             []adapter.Rule
    ruleSets          []adapter.RuleSet
    ruleSetMap        map[string]adapter.RuleSet
    processSearcher   process.Searcher
    neighborResolver  adapter.NeighborResolver
    trackers          []adapter.ConnectionTracker
}
```

## تدفق توجيه الاتصال

### `RouteConnectionEx` (TCP)

```go
func (r *Router) RouteConnectionEx(ctx, conn, metadata, onClose) {
    err := r.routeConnection(ctx, conn, metadata, onClose)
    if err != nil {
        N.CloseOnHandshakeFailure(conn, onClose, err)
    }
}
```

### `routeConnection` (داخلي)

1. **فحص التحويل**: إذا كان `metadata.InboundDetour` معيّناً، يُحقن في ذلك الوارد
2. **فحص Mux/UoT**: رفض عناوين mux/UoT العامة المهملة
3. **مطابقة القواعد**: استدعاء `matchRule()` للعثور على القاعدة المطابقة
4. **توزيع الإجراء**:
   - `RuleActionRoute` ← البحث عن الصادر، التحقق من دعم TCP
   - `RuleActionBypass` ← تجاوز مباشر أو عبر صادر
   - `RuleActionReject` ← إرجاع خطأ
   - `RuleActionHijackDNS` ← المعالجة كتدفق DNS
5. **الصادر الافتراضي**: إذا لم تطابق أي قاعدة، يُستخدم الصادر الافتراضي
6. **تتبع الاتصال**: التغليف بالمتتبعات (إحصائيات Clash API)
7. **التسليم**: استدعاء `outbound.NewConnectionEx()` أو `connectionManager.NewConnection()`

## مطابقة القواعد (`matchRule`)

حلقة المطابقة الأساسية:

```go
func (r *Router) matchRule(ctx, metadata, preMatch, supportBypass, inputConn, inputPacketConn) (
    selectedRule, selectedRuleIndex, buffers, packetBuffers, fatalErr,
) {
    // الخطوة 1: اكتشاف العملية
    if r.processSearcher != nil && metadata.ProcessInfo == nil {
        processInfo, _ := process.FindProcessInfo(r.processSearcher, ...)
        metadata.ProcessInfo = processInfo
    }

    // الخطوة 2: حل الجوار (عنوان MAC، اسم المضيف)
    if r.neighborResolver != nil && metadata.SourceMACAddress == nil {
        mac, _ := r.neighborResolver.LookupMAC(metadata.Source.Addr)
        hostname, _ := r.neighborResolver.LookupHostname(metadata.Source.Addr)
    }

    // الخطوة 3: بحث FakeIP
    if metadata.Destination.Addr.IsValid() && r.dnsTransport.FakeIP() != nil {
        domain, loaded := r.dnsTransport.FakeIP().Store().Lookup(metadata.Destination.Addr)
        if loaded {
            metadata.OriginDestination = metadata.Destination
            metadata.Destination = M.Socksaddr{Fqdn: domain, Port: metadata.Destination.Port}
            metadata.FakeIP = true
        }
    }

    // الخطوة 4: بحث DNS العكسي
    if metadata.Domain == "" {
        domain, loaded := r.dns.LookupReverseMapping(metadata.Destination.Addr)
        if loaded { metadata.Domain = domain }
    }

    // الخطوة 5: التكرار على القواعد
    for currentRuleIndex, currentRule := range r.rules {
        metadata.ResetRuleCache()
        if !currentRule.Match(metadata) {
            continue
        }

        // تطبيق خيارات المسار من القاعدة
        // ...

        // تنفيذ الإجراء
        switch action := currentRule.Action().(type) {
        case *R.RuleActionSniff:
            // فحص البيانات، تعيين metadata.Protocol/Domain
        case *R.RuleActionResolve:
            // حل DNS، تعيين metadata.DestinationAddresses
        case *R.RuleActionRoute:
            selectedRule = currentRule
            break match
        case *R.RuleActionReject:
            selectedRule = currentRule
            break match
        case *R.RuleActionHijackDNS:
            selectedRule = currentRule
            break match
        case *R.RuleActionBypass:
            selectedRule = currentRule
            break match
        }
    }
}
```

## إجراءات القواعد

### التوجيه (نهائي)

```go
type RuleActionRoute struct {
    Outbound string
    RuleActionRouteOptions
}

type RuleActionRouteOptions struct {
    OverrideAddress         M.Socksaddr
    OverridePort            uint16
    NetworkStrategy         *C.NetworkStrategy
    NetworkType             []C.InterfaceType
    FallbackNetworkType     []C.InterfaceType
    FallbackDelay           time.Duration
    UDPDisableDomainUnmapping bool
    UDPConnect              bool
    UDPTimeout              time.Duration
    TLSFragment             bool
    TLSRecordFragment       bool
}
```

### الاستكشاف (غير نهائي)

```go
type RuleActionSniff struct {
    StreamSniffers []sniff.StreamSniffer
    PacketSniffers []sniff.PacketSniffer
    SnifferNames   []string
    Timeout        time.Duration
    OverrideDestination bool
}
```

يفحص الاستكشاف بيانات الاتصال لاكتشاف البروتوكول والنطاق. لـ TCP، يستخدم `sniff.PeekStream()`. لـ UDP، يستخدم `sniff.PeekPacket()`.

### الحل (غير نهائي)

```go
type RuleActionResolve struct {
    Server       string
    Strategy     C.DomainStrategy
    DisableCache bool
    RewriteTTL   *uint32
    ClientSubnet netip.Prefix
}
```

يحل DNS لنطاق الوجهة ويخزّن عناوين IP في `metadata.DestinationAddresses`.

### الرفض (نهائي)

```go
type RuleActionReject struct {
    Method string  // "default"، "drop"، "reply"
}
```

### اعتراض DNS (نهائي)

يعترض الاتصال ويعالجه كاستعلام DNS، يُحوَّل إلى موجّه DNS.

### التجاوز (نهائي)

```go
type RuleActionBypass struct {
    Outbound string
    RuleActionRouteOptions
}
```

## واجهة القاعدة

```go
type Rule interface {
    HeadlessRule
    SimpleLifecycle
    Type() string
    Action() RuleAction
}

type HeadlessRule interface {
    Match(metadata *InboundContext) bool
    String() string
}
```

### أنواع القواعد

- **DefaultRule**: قاعدة قياسية بشروط + إجراء
- **LogicalRule**: تركيب AND/OR من قواعد فرعية

### عناصر الشروط

يتحقق كل شرط من جانب واحد من البيانات الوصفية:

| الشرط | الحقل | المطابقة |
|-----------|-------|----------|
| `domain` | نطاق الوجهة | كامل، لاحقة، كلمة مفتاحية، تعبير نمطي |
| `ip_cidr` | عنوان IP للوجهة | نطاق CIDR |
| `source_ip_cidr` | عنوان IP المصدر | نطاق CIDR |
| `port` | منفذ الوجهة | دقيق أو نطاق |
| `source_port` | منفذ المصدر | دقيق أو نطاق |
| `protocol` | البروتوكول المستكشف | مطابقة دقيقة |
| `network` | TCP/UDP | مطابقة دقيقة |
| `inbound` | وسم الوارد | مطابقة دقيقة |
| `outbound` | الصادر الحالي | مطابقة دقيقة |
| `package_name` | حزمة Android | مطابقة دقيقة |
| `process_name` | اسم العملية | مطابقة دقيقة |
| `process_path` | مسار العملية | دقيق أو تعبير نمطي |
| `user` / `user_id` | مستخدم نظام التشغيل | مطابقة دقيقة |
| `clash_mode` | وضع Clash API | مطابقة دقيقة |
| `wifi_ssid` / `wifi_bssid` | حالة WIFI | مطابقة دقيقة |
| `network_type` | نوع الواجهة | wifi/cellular/ethernet/other |
| `network_is_expensive` | شبكة مقاسة | قيمة منطقية |
| `network_is_constrained` | شبكة مقيّدة | قيمة منطقية |
| `ip_is_private` | عنوان IP خاص | قيمة منطقية |
| `ip_accept_any` | IP محلول | قيمة منطقية |
| `source_mac_address` | عنوان MAC المصدر | مطابقة دقيقة |
| `source_hostname` | اسم مضيف المصدر | مطابقة نطاق |
| `query_type` | نوع استعلام DNS | A/AAAA/إلخ. |
| `rule_set` | مطابقة مجموعة قواعد | مفوّضة |
| `auth_user` | مستخدم مصادقة البروكسي | مطابقة دقيقة |
| `client` | عميل TLS (JA3) | مطابقة دقيقة |

## مجموعات القواعد

مجموعات القواعد هي مجموعات من القواعد تُحمّل من ملفات محلية أو عناوين URL بعيدة:

```go
type RuleSet interface {
    Name() string
    StartContext(ctx, startContext) error
    PostStart() error
    Metadata() RuleSetMetadata
    ExtractIPSet() []*netipx.IPSet
    IncRef() / DecRef()  // عد المراجع
    HeadlessRule         // يمكن استخدامها كشرط
}
```

### مجموعات القواعد المحلية

تُحمّل من ملفات `.srs` الثنائية (تنسيق مجموعة قواعد sing-box).

### مجموعات القواعد البعيدة

تُنزّل من عناوين URL، وتُخزّن مؤقتاً، وتُحدّث تلقائياً. تُنزّل مجموعات قواعد متعددة بشكل متزامن (5 كحد أقصى بالتوازي).

## توجيه DNS

تُوجّه استعلامات DNS بشكل منفصل عبر `dns.Router`:

```go
type DNSRule interface {
    Rule
    WithAddressLimit() bool
    MatchAddressLimit(metadata *InboundContext) bool
}
```

تمتلك قواعد DNS القدرة الإضافية على المطابقة على عناوين الاستجابة (لتصفية استجابات DNS غير المرغوبة).
