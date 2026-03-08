# Интерфейсы адаптеров

Пакет `adapter` определяет основные интерфейсы, которые реализуют все компоненты. Эти интерфейсы формируют контракт между слоем оркестрации (Box, Router) и реализациями протоколов.

**Исходный код**: `adapter/`

## Основные интерфейсы

### Входящий (Inbound)

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

Входящий прослушивает соединения и декодирует заголовки протоколов. После декодирования он вызывает маршрутизатор для маршрутизации соединения. Инжектируемые входящие поддерживают получение соединений от других входящих (detour).

### Исходящий (Outbound)

```go
type Outbound interface {
    Type() string
    Tag() string
    Network() []string        // ["tcp"], ["udp"], or ["tcp", "udp"]
    Dependencies() []string   // tags of outbounds this depends on
    N.Dialer                  // DialContext + ListenPacket
}
```

Исходящий по сути является `N.Dialer` -- он может устанавливать TCP-соединения и прослушивать UDP-пакеты. Это означает, что исходящие компонуемы: исходящий VLESS оборачивает прямой dialer с кодированием протокола.

### Конечная точка (Endpoint)

```go
type Endpoint interface {
    Lifecycle
    Type() string
    Tag() string
    Outbound  // endpoints are also outbounds
}
```

Конечные точки -- это компоненты двойного назначения, выступающие одновременно как входящие и исходящие. WireGuard и Tailscale являются конечными точками -- они создают виртуальные сетевые интерфейсы.

### Маршрутизатор (Router)

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

Маршрутизатор сопоставляет правила и направляет соединения к исходящим. `RouteConnectionEx` -- это неблокирующий вариант, принимающий обратный вызов `onClose` вместо блокировки до завершения.

### Менеджер соединений (ConnectionManager)

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

Менеджер соединений обрабатывает фактическое установление соединения и цикл двунаправленного копирования. Когда исходящий не реализует `ConnectionHandlerEx` напрямую, маршрутизатор делегирует задачу менеджеру соединений.

### Менеджер сети (NetworkManager)

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

Управляет сетевым состоянием платформы: обнаружение интерфейсов, метки маршрутизации, защита сокетов (Android), мониторинг WIFI.

### DNS-маршрутизатор (DNSRouter)

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

### Менеджер DNS-транспортов (DNSTransportManager)

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

## InboundContext -- объект метаданных

`InboundContext` -- это центральная структура метаданных, проходящая через весь конвейер:

```go
type InboundContext struct {
    // Identity
    Inbound     string         // inbound tag
    InboundType string         // inbound type (e.g., "vless")
    Network     string         // "tcp" or "udp"
    Source      M.Socksaddr    // client address
    Destination M.Socksaddr    // target address
    User        string         // authenticated user
    Outbound    string         // selected outbound tag

    // Sniffing results
    Protocol     string        // detected protocol (e.g., "tls", "http")
    Domain       string        // sniffed domain name
    Client       string        // detected client (e.g., "chrome")
    SniffContext any
    SniffError   error

    // Routing cache
    IPVersion            uint8
    OriginDestination    M.Socksaddr
    RouteOriginalDestination M.Socksaddr
    DestinationAddresses []netip.Addr     // resolved IPs
    SourceGeoIPCode      string
    GeoIPCode            string
    ProcessInfo          *ConnectionOwner
    SourceMACAddress     net.HardwareAddr
    SourceHostname       string
    QueryType            uint16
    FakeIP               bool

    // Route options (set by rule actions)
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

    // Rule matching cache (reset between rules)
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

### Передача через контекст

InboundContext хранится в контексте Go:

```go
// Store in context
func WithContext(ctx context.Context, inboundContext *InboundContext) context.Context

// Retrieve from context
func ContextFrom(ctx context.Context) *InboundContext

// Clone and store (for sub-pipelines)
func ExtendContext(ctx context.Context) (context.Context, *InboundContext)
```

## Интерфейсы обработчиков

Обработчики обрабатывают входящие соединения:

```go
// TCP connection handler
type ConnectionHandlerEx interface {
    NewConnectionEx(ctx context.Context, conn net.Conn, metadata InboundContext, onClose N.CloseHandlerFunc)
}

// UDP packet connection handler
type PacketConnectionHandlerEx interface {
    NewPacketConnectionEx(ctx context.Context, conn N.PacketConn, metadata InboundContext, onClose N.CloseHandlerFunc)
}
```

Паттерн обратного вызова `onClose` является центральным в архитектуре sing-box -- он обеспечивает неблокирующую обработку соединений. При завершении соединения (успешном или с ошибкой) `onClose` вызывается ровно один раз.

## Адаптеры верхнего уровня

Вспомогательные обёртки для преобразования между типами обработчиков:

```go
// Route handler — wraps a ConnectionRouterEx to act as an upstream handler
func NewRouteHandlerEx(metadata InboundContext, router ConnectionRouterEx) UpstreamHandlerAdapterEx

// Upstream handler — wraps connection/packet handlers
func NewUpstreamHandlerEx(metadata InboundContext, connHandler, pktHandler) UpstreamHandlerAdapterEx
```

Они используются реализациями протоколов для цепочки обработчиков. Например, входящий VLESS декодирует заголовок, а затем использует `NewRouteHandlerEx` для передачи декодированного соединения маршрутизатору.

## Паттерн менеджера

Все менеджеры следуют одному и тому же паттерну:

```go
type XxxManager interface {
    Lifecycle
    Xxxs() []Xxx              // list all
    Get(tag string) (Xxx, bool)  // get by tag
    Remove(tag string) error     // dynamic removal
    Create(ctx, ..., tag, type, options) error  // dynamic creation
}
```

Менеджеры владеют своими реестрами и обрабатывают создание через паттерн реестра:

```go
// Registry creates instances from type + options
type XxxRegistry interface {
    Create(ctx, ..., tag, type string, options any) (Xxx, error)
}
```

## Трекер соединений

Используется Clash API и V2Ray API для мониторинга соединений:

```go
type ConnectionTracker interface {
    RoutedConnection(ctx, conn, metadata, matchedRule, matchOutbound) net.Conn
    RoutedPacketConnection(ctx, conn, metadata, matchedRule, matchOutbound) N.PacketConn
}
```

Трекер оборачивает соединения для подсчёта байтов и отслеживания активных соединений.
