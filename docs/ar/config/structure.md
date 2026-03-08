# هيكل التهيئة

يستخدم sing-box تنسيق تهيئة قائم على JSON مع هيكل جذري محدد جيداً. يعتمد تحليل التهيئة على مفكك JSON واعٍ بالسياق مع سجلات أنواع للأنواع متعددة الأشكال.

**المصدر**: `option/options.go`، `option/inbound.go`، `option/outbound.go`، `option/endpoint.go`، `option/dns.go`، `option/route.go`، `option/service.go`، `option/experimental.go`

## هيكل الخيارات الجذري

```go
type _Options struct {
    RawMessage   json.RawMessage      `json:"-"`
    Schema       string               `json:"$schema,omitempty"`
    Log          *LogOptions          `json:"log,omitempty"`
    DNS          *DNSOptions          `json:"dns,omitempty"`
    NTP          *NTPOptions          `json:"ntp,omitempty"`
    Certificate  *CertificateOptions  `json:"certificate,omitempty"`
    Endpoints    []Endpoint           `json:"endpoints,omitempty"`
    Inbounds     []Inbound            `json:"inbounds,omitempty"`
    Outbounds    []Outbound           `json:"outbounds,omitempty"`
    Route        *RouteOptions        `json:"route,omitempty"`
    Services     []Service            `json:"services,omitempty"`
    Experimental *ExperimentalOptions `json:"experimental,omitempty"`
}

type Options _Options
```

### مثال تهيئة

```json
{
  "$schema": "https://sing-box.sagernet.org/schema.json",
  "log": {
    "level": "info"
  },
  "dns": {
    "servers": [...],
    "rules": [...]
  },
  "inbounds": [
    {"type": "tun", "tag": "tun-in", ...},
    {"type": "mixed", "tag": "mixed-in", ...}
  ],
  "outbounds": [
    {"type": "direct", "tag": "direct"},
    {"type": "vless", "tag": "proxy", ...},
    {"type": "selector", "tag": "select", ...}
  ],
  "endpoints": [
    {"type": "wireguard", "tag": "wg", ...}
  ],
  "route": {
    "rules": [...],
    "rule_set": [...],
    "final": "proxy"
  },
  "services": [
    {"type": "resolved", "tag": "resolved-dns", ...}
  ],
  "experimental": {
    "cache_file": {"enabled": true},
    "clash_api": {"external_controller": "127.0.0.1:9090"}
  }
}
```

## التحقق

تقوم طريقة `Options.UnmarshalJSONContext` بالتحقق:

```go
func (o *Options) UnmarshalJSONContext(ctx context.Context, content []byte) error {
    decoder := json.NewDecoderContext(ctx, bytes.NewReader(content))
    decoder.DisallowUnknownFields()  // تحليل صارم
    err := decoder.Decode((*_Options)(o))
    o.RawMessage = content
    return checkOptions(o)
}
```

فحوصات ما بعد التحليل:
- **وسوم المنافذ الواردة المكررة**: لا يُسمح لمنفذين واردين بمشاركة نفس الوسم
- **وسوم المنافذ الصادرة/نقاط النهاية المكررة**: وسوم المنافذ الصادرة ونقاط النهاية تشترك في مساحة أسماء واحدة؛ لا يُسمح بالتكرار

```go
func checkInbounds(inbounds []Inbound) error {
    seen := make(map[string]bool)
    for i, inbound := range inbounds {
        tag := inbound.Tag
        if tag == "" { tag = F.ToString(i) }
        if seen[tag] { return E.New("duplicate inbound tag: ", tag) }
        seen[tag] = true
    }
    return nil
}
```

## تحليل المنافذ الواردة/الصادرة/نقاط النهاية المنوعة

المنافذ الواردة والصادرة ونقاط النهاية وخوادم DNS والخدمات جميعها تستخدم نفس النمط للتحليل متعدد الأشكال لـ JSON: حقل `type` يحدد أي هيكل خيارات يُستخدم لتحليل الحقول المتبقية.

### النمط

كل هيكل منوع له نفس البنية:

```go
type _Inbound struct {
    Type    string `json:"type"`
    Tag     string `json:"tag,omitempty"`
    Options any    `json:"-"`          // خيارات خاصة بالنوع، ليست في JSON مباشرة
}
```

### التحليل الواعي بالسياق

يستخدم فك التسلسل `context.Context` في Go لحمل سجلات الأنواع:

```go
func (h *Inbound) UnmarshalJSONContext(ctx context.Context, content []byte) error {
    // 1. تحليل حقلي "type" و "tag"
    err := json.UnmarshalContext(ctx, content, (*_Inbound)(h))

    // 2. البحث عن سجل الخيارات من السياق
    registry := service.FromContext[InboundOptionsRegistry](ctx)

    // 3. إنشاء هيكل خيارات منوع لهذا النوع
    options, loaded := registry.CreateOptions(h.Type)

    // 4. تحليل الحقول المتبقية (باستثناء type/tag) في الهيكل المنوع
    err = badjson.UnmarshallExcludedContext(ctx, content, (*_Inbound)(h), options)

    // 5. تخزين الخيارات المحللة
    h.Options = options
    return nil
}
```

دالة `badjson.UnmarshallExcluded` هي المفتاح -- تحلل كائن JSON مع استبعاد الحقول التي تم تحليلها بالفعل بواسطة هيكل مختلف. هذا يسمح بمعالجة `type` و `tag` بشكل منفصل عن خيارات البروتوكول الخاصة.

### واجهات السجل

```go
type InboundOptionsRegistry interface {
    CreateOptions(inboundType string) (any, bool)
}

type OutboundOptionsRegistry interface {
    CreateOptions(outboundType string) (any, bool)
}

type EndpointOptionsRegistry interface {
    CreateOptions(endpointType string) (any, bool)
}

type DNSTransportOptionsRegistry interface {
    CreateOptions(transportType string) (any, bool)
}

type ServiceOptionsRegistry interface {
    CreateOptions(serviceType string) (any, bool)
}
```

## خيارات DNS

تهيئة DNS لها هيكل مزدوج للتوافق مع الإصدارات السابقة:

```go
type DNSOptions struct {
    RawDNSOptions        // التنسيق الحالي
    LegacyDNSOptions     // التنسيق المهمل (يُرقى تلقائياً)
}

type RawDNSOptions struct {
    Servers        []DNSServerOptions `json:"servers,omitempty"`
    Rules          []DNSRule          `json:"rules,omitempty"`
    Final          string             `json:"final,omitempty"`
    ReverseMapping bool               `json:"reverse_mapping,omitempty"`
    DNSClientOptions
}
```

خوادم DNS تستخدم نفس النمط المنوع:

```go
type DNSServerOptions struct {
    Type    string `json:"type,omitempty"`
    Tag     string `json:"tag,omitempty"`
    Options any    `json:"-"`
}
```

تنسيق خادم DNS القديم (معتمد على URL مثل `tls://1.1.1.1`) يُرقى تلقائياً إلى التنسيق المنوع الجديد أثناء فك التسلسل.

## خيارات المسار

```go
type RouteOptions struct {
    GeoIP                      *GeoIPOptions
    Geosite                    *GeositeOptions
    Rules                      []Rule
    RuleSet                    []RuleSet
    Final                      string
    FindProcess                bool
    FindNeighbor               bool
    AutoDetectInterface        bool
    OverrideAndroidVPN         bool
    DefaultInterface           string
    DefaultMark                FwMark
    DefaultDomainResolver      *DomainResolveOptions
    DefaultNetworkStrategy     *NetworkStrategy
    DefaultNetworkType         badoption.Listable[InterfaceType]
    DefaultFallbackNetworkType badoption.Listable[InterfaceType]
    DefaultFallbackDelay       badoption.Duration
}
```

## الخيارات التجريبية

```go
type ExperimentalOptions struct {
    CacheFile *CacheFileOptions `json:"cache_file,omitempty"`
    ClashAPI  *ClashAPIOptions  `json:"clash_api,omitempty"`
    V2RayAPI  *V2RayAPIOptions  `json:"v2ray_api,omitempty"`
    Debug     *DebugOptions     `json:"debug,omitempty"`
}
```

## خيارات السجل

```go
type LogOptions struct {
    Disabled     bool   `json:"disabled,omitempty"`
    Level        string `json:"level,omitempty"`
    Output       string `json:"output,omitempty"`
    Timestamp    bool   `json:"timestamp,omitempty"`
    DisableColor bool   `json:"-"`      // داخلي، ليس من JSON
}
```

## أنواع الخيارات الشائعة

### ListenOptions (المنفذ الوارد)

```go
type ListenOptions struct {
    Listen               *badoption.Addr
    ListenPort           uint16
    BindInterface        string
    RoutingMark          FwMark
    ReuseAddr            bool
    NetNs                string
    DisableTCPKeepAlive  bool
    TCPKeepAlive         badoption.Duration
    TCPKeepAliveInterval badoption.Duration
    TCPFastOpen          bool
    TCPMultiPath         bool
    UDPFragment          *bool
    UDPTimeout           UDPTimeoutCompat
    Detour               string
}
```

### DialerOptions (المنفذ الصادر)

```go
type DialerOptions struct {
    Detour               string
    BindInterface        string
    Inet4BindAddress     *badoption.Addr
    Inet6BindAddress     *badoption.Addr
    ProtectPath          string
    RoutingMark          FwMark
    NetNs                string
    ConnectTimeout       badoption.Duration
    TCPFastOpen          bool
    TCPMultiPath         bool
    DomainResolver       *DomainResolveOptions
    NetworkStrategy      *NetworkStrategy
    NetworkType          badoption.Listable[InterfaceType]
    FallbackNetworkType  badoption.Listable[InterfaceType]
    FallbackDelay        badoption.Duration
}
```

### ServerOptions (المنفذ الصادر)

```go
type ServerOptions struct {
    Server     string `json:"server"`
    ServerPort uint16 `json:"server_port"`
}

func (o ServerOptions) Build() M.Socksaddr {
    return M.ParseSocksaddrHostPort(o.Server, o.ServerPort)
}
```

## ملاحظات إعادة التنفيذ

1. **تحليل JSON الواعي بالسياق** هو محوري للتصميم. `context.Context` يحمل سجلات الأنواع المحقونة عند بدء التشغيل، مما يمكّن التحليل متعدد الأشكال بدون انعكاس أو توليد كود
2. **`badjson.UnmarshallExcluded`** هو محلل JSON مخصص يسمح لهيكلين بمشاركة نفس كائن JSON، مع تقسيم الحقول بينهما. هكذا يتم فصل `type`/`tag` عن خيارات البروتوكول
3. **`DisallowUnknownFields`** مفعل، مما يجعل المحلل صارماً -- الأخطاء الإملائية في أسماء الحقول تسبب أخطاء تحليل
4. **الترقية من الإصدارات القديمة** تُعالج أثناء فك التسلسل (مثل عناوين URL لخوادم DNS القديمة، حقول المنافذ الواردة المهملة). علم السياق `dontUpgrade` يسمح بدورات التسلسل/فك التسلسل دون تشغيل الترقية
5. **التحقق** بسيط عند وقت التحليل -- يُفحص فقط تفرد الوسوم. التحقق الدلالي (مثل الحقول المطلوبة، العناوين الصالحة) يحدث أثناء إنشاء الخدمة
6. **`RawMessage`** يُخزن في `Options` الجذري للسماح بإعادة التسلسل أو إعادة توجيه التهيئة الأصلية
