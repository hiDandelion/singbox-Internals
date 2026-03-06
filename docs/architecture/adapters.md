# Adapter Interfaces

The `adapter` package defines the core interfaces that all components implement. These interfaces form the contract between the orchestration layer (Box, Router) and the protocol implementations.

**Source**: `adapter/`

## Core Interfaces

### Inbound

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

An inbound listens for connections and decodes protocol headers. After decoding, it calls the router to route the connection. Injectable inbounds support receiving connections from other inbounds (detour).

### Outbound

```go
type Outbound interface {
    Type() string
    Tag() string
    Network() []string        // ["tcp"], ["udp"], or ["tcp", "udp"]
    Dependencies() []string   // tags of outbounds this depends on
    N.Dialer                  // DialContext + ListenPacket
}
```

An outbound is fundamentally an `N.Dialer` — it can dial TCP connections and listen for UDP packets. This means outbounds are composable: a VLESS outbound wraps a direct dialer with protocol encoding.

### Endpoint

```go
type Endpoint interface {
    Lifecycle
    Type() string
    Tag() string
    Outbound  // endpoints are also outbounds
}
```

Endpoints are dual-role components that act as both inbound and outbound. WireGuard and Tailscale are endpoints — they create virtual network interfaces.

### Router

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

The router matches rules and dispatches connections to outbounds. `RouteConnectionEx` is the non-blocking variant that takes an `onClose` callback instead of blocking until completion.

### ConnectionManager

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

The connection manager handles the actual dial + bidirectional copy loop. When an outbound doesn't implement `ConnectionHandlerEx` directly, the router delegates to the connection manager.

### NetworkManager

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

Manages platform network state: interface detection, routing marks, socket protection (Android), WIFI monitoring.

### DNSRouter

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

### DNSTransportManager

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

## InboundContext — The Metadata Object

`InboundContext` is the central metadata struct that flows through the entire pipeline:

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

### Context Threading

InboundContext is stored in Go context:

```go
// Store in context
func WithContext(ctx context.Context, inboundContext *InboundContext) context.Context

// Retrieve from context
func ContextFrom(ctx context.Context) *InboundContext

// Clone and store (for sub-pipelines)
func ExtendContext(ctx context.Context) (context.Context, *InboundContext)
```

## Handler Interfaces

Handlers process incoming connections:

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

The `onClose` callback pattern is central to sing-box's design — it enables non-blocking connection handling. When a connection completes (success or error), `onClose` is called exactly once.

## Upstream Adapters

Utility wrappers that adapt between handler types:

```go
// Route handler — wraps a ConnectionRouterEx to act as an upstream handler
func NewRouteHandlerEx(metadata InboundContext, router ConnectionRouterEx) UpstreamHandlerAdapterEx

// Upstream handler — wraps connection/packet handlers
func NewUpstreamHandlerEx(metadata InboundContext, connHandler, pktHandler) UpstreamHandlerAdapterEx
```

These are used by protocol implementations to chain handlers together. For example, a VLESS inbound decodes the header, then uses `NewRouteHandlerEx` to pass the decoded connection to the router.

## Manager Pattern

All managers follow the same pattern:

```go
type XxxManager interface {
    Lifecycle
    Xxxs() []Xxx              // list all
    Get(tag string) (Xxx, bool)  // get by tag
    Remove(tag string) error     // dynamic removal
    Create(ctx, ..., tag, type, options) error  // dynamic creation
}
```

Managers own their registries and handle creation via the registry pattern:

```go
// Registry creates instances from type + options
type XxxRegistry interface {
    Create(ctx, ..., tag, type string, options any) (Xxx, error)
}
```

## Connection Tracker

Used by Clash API and V2Ray API for connection monitoring:

```go
type ConnectionTracker interface {
    RoutedConnection(ctx, conn, metadata, matchedRule, matchOutbound) net.Conn
    RoutedPacketConnection(ctx, conn, metadata, matchedRule, matchOutbound) N.PacketConn
}
```

The tracker wraps connections to count bytes and track active connections.
