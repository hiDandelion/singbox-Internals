# واجهات المحوّلات

تعرّف حزمة `adapter` الواجهات الأساسية التي تنفّذها جميع المكونات. تشكّل هذه الواجهات العقد بين طبقة التنسيق (Box، Router) وتنفيذات البروتوكولات.

**المصدر**: `adapter/`

## الواجهات الأساسية

### الوارد (Inbound)

```go
type Inbound interface {
    Lifecycle
    Type() string
    Tag() string
}

type TCPInjectableInbound interface {
    Inbound
    ConnectionHandlerEx
}

type UDPInjectableInbound interface {
    Inbound
    PacketConnectionHandlerEx
}
```

يستمع الوارد للاتصالات ويفك ترويسات البروتوكول. بعد فك الترميز، يستدعي الموجّه لتوجيه الاتصال. تدعم الواردات القابلة للحقن استقبال الاتصالات من واردات أخرى (تحويل).

### الصادر (Outbound)

```go
type Outbound interface {
    Type() string
    Tag() string
    Network() []string        // ["tcp"]، ["udp"]، أو ["tcp", "udp"]
    Dependencies() []string   // وسوم الصادرات التي يعتمد عليها
    N.Dialer                  // DialContext + ListenPacket
}
```

الصادر هو في الأساس `N.Dialer` — يمكنه إنشاء اتصالات TCP والاستماع لحزم UDP. هذا يعني أن الصادرات قابلة للتركيب: صادر VLESS يغلّف متصلاً مباشراً بتشفير البروتوكول.

### نقطة النهاية (Endpoint)

```go
type Endpoint interface {
    Lifecycle
    Type() string
    Tag() string
    Outbound  // نقاط النهاية هي أيضاً صادرات
}
```

نقاط النهاية هي مكونات مزدوجة الدور تعمل كوارد وصادر في آن واحد. WireGuard وTailscale هما نقاط نهاية — ينشئان واجهات شبكة افتراضية.

### الموجّه (Router)

```go
type Router interface {
    Lifecycle
    ConnectionRouter
    ConnectionRouterEx
    PreMatch(metadata InboundContext, ...) (tun.DirectRouteDestination, error)
    RuleSet(tag string) (RuleSet, bool)
    Rules() []Rule
    NeedFindProcess() bool
    NeedFindNeighbor() bool
    AppendTracker(tracker ConnectionTracker)
    ResetNetwork()
}

type ConnectionRouterEx interface {
    ConnectionRouter
    RouteConnectionEx(ctx context.Context, conn net.Conn, metadata InboundContext, onClose N.CloseHandlerFunc)
    RoutePacketConnectionEx(ctx context.Context, conn N.PacketConn, metadata InboundContext, onClose N.CloseHandlerFunc)
}
```

يطابق الموجّه القواعد ويوزّع الاتصالات على الصادرات. `RouteConnectionEx` هو المتغير غير المحجوب الذي يأخذ استدعاء `onClose` بدلاً من الحجب حتى الاكتمال.

### مدير الاتصالات (ConnectionManager)

```go
type ConnectionManager interface {
    Lifecycle
    Count() int
    CloseAll()
    TrackConn(conn net.Conn) net.Conn
    TrackPacketConn(conn net.PacketConn) net.PacketConn
    NewConnection(ctx context.Context, this N.Dialer, conn net.Conn, metadata InboundContext, onClose N.CloseHandlerFunc)
    NewPacketConnection(ctx context.Context, this N.Dialer, conn N.PacketConn, metadata InboundContext, onClose N.CloseHandlerFunc)
}
```

يتعامل مدير الاتصالات مع عملية الاتصال الفعلية + حلقة النسخ ثنائية الاتجاه. عندما لا ينفّذ الصادر `ConnectionHandlerEx` مباشرة، يفوّض الموجّه إلى مدير الاتصالات.

### مدير الشبكة (NetworkManager)

```go
type NetworkManager interface {
    Lifecycle
    InterfaceFinder() control.InterfaceFinder
    DefaultNetworkInterface() *NetworkInterface
    AutoDetectInterface() bool
    AutoDetectInterfaceFunc() control.Func
    ProtectFunc() control.Func
    DefaultOptions() NetworkOptions
    NetworkMonitor() tun.NetworkUpdateMonitor
    InterfaceMonitor() tun.DefaultInterfaceMonitor
    PackageManager() tun.PackageManager
    WIFIState() WIFIState
    ResetNetwork()
}
```

يدير حالة شبكة المنصة: اكتشاف الواجهات، علامات التوجيه، حماية المقابس (Android)، مراقبة WIFI.

### موجّه DNS (DNSRouter)

```go
type DNSRouter interface {
    Lifecycle
    Exchange(ctx context.Context, message *dns.Msg, options DNSQueryOptions) (*dns.Msg, error)
    Lookup(ctx context.Context, domain string, options DNSQueryOptions) ([]netip.Addr, error)
    ClearCache()
    LookupReverseMapping(ip netip.Addr) (string, bool)
    ResetNetwork()
}
```

### مدير نقل DNS (DNSTransportManager)

```go
type DNSTransportManager interface {
    Lifecycle
    Transports() []DNSTransport
    Transport(tag string) (DNSTransport, bool)
    Default() DNSTransport
    FakeIP() FakeIPTransport
    Remove(tag string) error
    Create(ctx context.Context, ...) error
}
```

## InboundContext — كائن البيانات الوصفية

`InboundContext` هو هيكل البيانات الوصفية المركزي الذي يتدفق عبر خط الأنابيب بالكامل:

```go
type InboundContext struct {
    // الهوية
    Inbound     string         // وسم الوارد
    InboundType string         // نوع الوارد (مثل "vless")
    Network     string         // "tcp" أو "udp"
    Source      M.Socksaddr    // عنوان العميل
    Destination M.Socksaddr    // عنوان الهدف
    User        string         // المستخدم المصادق عليه
    Outbound    string         // وسم الصادر المختار

    // نتائج الاستكشاف
    Protocol     string        // البروتوكول المكتشف (مثل "tls"، "http")
    Domain       string        // اسم النطاق المستكشف
    Client       string        // العميل المكتشف (مثل "chrome")
    SniffContext any
    SniffError   error

    // ذاكرة التوجيه المؤقتة
    IPVersion            uint8
    OriginDestination    M.Socksaddr
    RouteOriginalDestination M.Socksaddr
    DestinationAddresses []netip.Addr     // عناوين IP المحلولة
    SourceGeoIPCode      string
    GeoIPCode            string
    ProcessInfo          *ConnectionOwner
    SourceMACAddress     net.HardwareAddr
    SourceHostname       string
    QueryType            uint16
    FakeIP               bool

    // خيارات المسار (تُعيّن بواسطة إجراءات القواعد)
    NetworkStrategy     *C.NetworkStrategy
    NetworkType         []C.InterfaceType
    FallbackNetworkType []C.InterfaceType
    FallbackDelay       time.Duration
    UDPDisableDomainUnmapping bool
    UDPConnect                bool
    UDPTimeout                time.Duration
    TLSFragment               bool
    TLSFragmentFallbackDelay  time.Duration
    TLSRecordFragment         bool

    // ذاكرة مطابقة القواعد المؤقتة (تُعاد تعيينها بين القواعد)
    IPCIDRMatchSource            bool
    IPCIDRAcceptEmpty            bool
    SourceAddressMatch           bool
    SourcePortMatch              bool
    DestinationAddressMatch      bool
    DestinationPortMatch         bool
    DidMatch                     bool
    IgnoreDestinationIPCIDRMatch bool
}
```

### ربط السياق

يُخزّن InboundContext في سياق Go:

```go
// التخزين في السياق
func WithContext(ctx context.Context, inboundContext *InboundContext) context.Context

// الاسترجاع من السياق
func ContextFrom(ctx context.Context) *InboundContext

// النسخ والتخزين (لخطوط الأنابيب الفرعية)
func ExtendContext(ctx context.Context) (context.Context, *InboundContext)
```

## واجهات المعالج

تعالج المعالجات الاتصالات الواردة:

```go
// معالج اتصال TCP
type ConnectionHandlerEx interface {
    NewConnectionEx(ctx context.Context, conn net.Conn, metadata InboundContext, onClose N.CloseHandlerFunc)
}

// معالج اتصال حزم UDP
type PacketConnectionHandlerEx interface {
    NewPacketConnectionEx(ctx context.Context, conn N.PacketConn, metadata InboundContext, onClose N.CloseHandlerFunc)
}
```

نمط استدعاء `onClose` هو محوري في تصميم sing-box — فهو يتيح معالجة الاتصالات بشكل غير محجوب. عند اكتمال الاتصال (نجاح أو خطأ)، يُستدعى `onClose` مرة واحدة بالضبط.

## محوّلات المنبع

أغلفة مساعدة تحوّل بين أنواع المعالجات:

```go
// معالج المسار — يغلّف ConnectionRouterEx ليعمل كمعالج منبع
func NewRouteHandlerEx(metadata InboundContext, router ConnectionRouterEx) UpstreamHandlerAdapterEx

// معالج المنبع — يغلّف معالجات الاتصال/الحزم
func NewUpstreamHandlerEx(metadata InboundContext, connHandler, pktHandler) UpstreamHandlerAdapterEx
```

تُستخدم هذه بواسطة تنفيذات البروتوكولات لربط المعالجات ببعضها. على سبيل المثال، وارد VLESS يفك الترويسة، ثم يستخدم `NewRouteHandlerEx` لتمرير الاتصال المفكوك إلى الموجّه.

## نمط المدير

تتبع جميع المديرين نفس النمط:

```go
type XxxManager interface {
    Lifecycle
    Xxxs() []Xxx              // عرض الكل
    Get(tag string) (Xxx, bool)  // الحصول بالوسم
    Remove(tag string) error     // الإزالة الديناميكية
    Create(ctx, ..., tag, type, options) error  // الإنشاء الديناميكي
}
```

يملك المديرون سجلاتهم ويتعاملون مع الإنشاء عبر نمط السجل:

```go
// ينشئ السجل نسخاً من النوع + الخيارات
type XxxRegistry interface {
    Create(ctx, ..., tag, type string, options any) (Xxx, error)
}
```

## متتبع الاتصالات

يُستخدم بواسطة Clash API وV2Ray API لمراقبة الاتصالات:

```go
type ConnectionTracker interface {
    RoutedConnection(ctx, conn, metadata, matchedRule, matchOutbound) net.Conn
    RoutedPacketConnection(ctx, conn, metadata, matchedRule, matchOutbound) N.PacketConn
}
```

يغلّف المتتبع الاتصالات لحساب البايتات وتتبع الاتصالات النشطة.
