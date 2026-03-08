# Adapter 接口

`adapter` 包定义了所有组件实现的核心接口。这些接口构成了编排层（Box、Router）与协议实现之间的契约。

**源码**: `adapter/`

## 核心接口

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

Inbound 监听连接并解码协议头部。解码后，它调用路由器来路由连接。可注入的 Inbound 支持从其他 Inbound 接收连接（detour）。

### Outbound

```go
type Outbound interface {
    Type() string
    Tag() string
    Network() []string        // ["tcp"], ["udp"], 或 ["tcp", "udp"]
    Dependencies() []string   // 此出站依赖的出站标签
    N.Dialer                  // DialContext + ListenPacket
}
```

Outbound 本质上是一个 `N.Dialer` -- 它可以拨号 TCP 连接和监听 UDP 数据包。这意味着出站是可组合的：一个 VLESS 出站通过协议编码包装一个 direct dialer。

### Endpoint

```go
type Endpoint interface {
    Lifecycle
    Type() string
    Tag() string
    Outbound  // endpoint 同时也是出站
}
```

Endpoint 是同时充当入站和出站的双角色组件。WireGuard 和 Tailscale 就是 Endpoint -- 它们创建虚拟网络接口。

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

路由器匹配规则并将连接分派到出站。`RouteConnectionEx` 是非阻塞变体，它接受一个 `onClose` 回调而不是阻塞直到完成。

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

连接管理器处理实际的拨号 + 双向复制循环。当出站没有直接实现 `ConnectionHandlerEx` 时，路由器会委托给连接管理器。

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

管理平台网络状态：接口检测、路由标记、套接字保护（Android）、WIFI 监控。

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

## InboundContext -- 元数据对象

`InboundContext` 是贯穿整个管道的核心元数据结构体：

```go
type InboundContext struct {
    // 身份标识
    Inbound     string         // 入站标签
    InboundType string         // 入站类型 (例如 "vless")
    Network     string         // "tcp" 或 "udp"
    Source      M.Socksaddr    // 客户端地址
    Destination M.Socksaddr    // 目标地址
    User        string         // 已认证用户
    Outbound    string         // 已选择的出站标签

    // 嗅探结果
    Protocol     string        // 检测到的协议 (例如 "tls", "http")
    Domain       string        // 嗅探到的域名
    Client       string        // 检测到的客户端 (例如 "chrome")
    SniffContext any
    SniffError   error

    // 路由缓存
    IPVersion            uint8
    OriginDestination    M.Socksaddr
    RouteOriginalDestination M.Socksaddr
    DestinationAddresses []netip.Addr     // 解析得到的 IP
    SourceGeoIPCode      string
    GeoIPCode            string
    ProcessInfo          *ConnectionOwner
    SourceMACAddress     net.HardwareAddr
    SourceHostname       string
    QueryType            uint16
    FakeIP               bool

    // 路由选项（由规则动作设置）
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

    // 规则匹配缓存（在规则之间重置）
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

### Context 线程化

InboundContext 存储在 Go context 中：

```go
// 存入 context
func WithContext(ctx context.Context, inboundContext *InboundContext) context.Context

// 从 context 获取
func ContextFrom(ctx context.Context) *InboundContext

// 克隆并存入（用于子管道）
func ExtendContext(ctx context.Context) (context.Context, *InboundContext)
```

## Handler 接口

Handler 处理传入的连接：

```go
// TCP 连接处理器
type ConnectionHandlerEx interface {
    NewConnectionEx(ctx context.Context, conn net.Conn, metadata InboundContext, onClose N.CloseHandlerFunc)
}

// UDP 数据包连接处理器
type PacketConnectionHandlerEx interface {
    NewPacketConnectionEx(ctx context.Context, conn N.PacketConn, metadata InboundContext, onClose N.CloseHandlerFunc)
}
```

`onClose` 回调模式是 sing-box 设计的核心 -- 它实现了非阻塞的连接处理。当连接完成（成功或错误）时，`onClose` 恰好被调用一次。

## 上游适配器

在处理器类型之间进行适配的工具包装器：

```go
// Route handler -- 包装 ConnectionRouterEx 作为上游处理器
func NewRouteHandlerEx(metadata InboundContext, router ConnectionRouterEx) UpstreamHandlerAdapterEx

// Upstream handler -- 包装连接/数据包处理器
func NewUpstreamHandlerEx(metadata InboundContext, connHandler, pktHandler) UpstreamHandlerAdapterEx
```

这些被协议实现用于链式连接处理器。例如，VLESS 入站解码头部后，使用 `NewRouteHandlerEx` 将解码后的连接传递给路由器。

## Manager 模式

所有管理器遵循相同的模式：

```go
type XxxManager interface {
    Lifecycle
    Xxxs() []Xxx              // 列出所有
    Get(tag string) (Xxx, bool)  // 按标签获取
    Remove(tag string) error     // 动态移除
    Create(ctx, ..., tag, type, options) error  // 动态创建
}
```

管理器拥有自己的注册表，并通过注册表模式处理创建：

```go
// 注册表根据类型 + 选项创建实例
type XxxRegistry interface {
    Create(ctx, ..., tag, type string, options any) (Xxx, error)
}
```

## 连接追踪器

由 Clash API 和 V2Ray API 用于连接监控：

```go
type ConnectionTracker interface {
    RoutedConnection(ctx, conn, metadata, matchedRule, matchOutbound) net.Conn
    RoutedPacketConnection(ctx, conn, metadata, matchedRule, matchOutbound) N.PacketConn
}
```

追踪器包装连接以统计字节数和跟踪活跃连接。
