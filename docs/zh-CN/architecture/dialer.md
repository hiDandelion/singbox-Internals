# Dialer 系统

Dialer 系统是出站连接工厂。它在 Go 的 `net.Dialer` 基础上包装了协议特定的功能：域名解析、detour 路由、TCP Fast Open、接口绑定和并行连接。

**源码**: `common/dialer/`

## Dialer 创建

```go
func New(ctx context.Context, options option.DialerOptions, isDomain bool) (N.Dialer, error)
```

此工厂函数根据选项构建 dialer 链：

```
DefaultDialer → [ResolveDialer] → [DetourDialer]
     ↓
  BindInterface / RoutingMark / ProtectFunc
  TCP Fast Open
  连接超时
  域名解析（如果 isDomain）
```

## DefaultDialer

基础 dialer 在 `net.Dialer` 上包装了平台特定的套接字选项：

```go
type DefaultDialer struct {
    dialer4           tcpDialer    // IPv4 dialer
    dialer6           tcpDialer    // IPv6 dialer
    udpDialer4        net.Dialer
    udpDialer6        net.Dialer
    udpAddr4          string
    udpAddr6          string
    isWireGuardListener bool
    networkManager    adapter.NetworkManager
    networkStrategy   *C.NetworkStrategy
}
```

功能：
- **双栈**: IPv4 和 IPv6 分别使用独立的 dialer
- **套接字选项**: `SO_MARK`, `SO_BINDTODEVICE`, `IP_TRANSPARENT`
- **TCP Fast Open**: 通过 `tfo-go` 库实现
- **连接超时**: `C.TCPConnectTimeout`（默认 15 秒）

### 并行接口 Dialer

用于具有多个网络接口的移动设备：

```go
type ParallelInterfaceDialer interface {
    DialParallelInterface(ctx, network, destination, strategy, networkType, fallbackType, fallbackDelay) (net.Conn, error)
    ListenSerialInterfacePacket(ctx, destination, strategy, networkType, fallbackType, fallbackDelay) (net.PacketConn, error)
}
```

根据策略尝试不同的网络接口（例如优先 WiFi，延迟后回退到蜂窝网络）。

### 并行网络 Dialer

Happy Eyeballs 风格的双栈并行拨号：

```go
type ParallelNetworkDialer interface {
    DialParallelNetwork(ctx, network, destination, destinationAddresses, strategy, networkType, fallbackType, fallbackDelay) (net.Conn, error)
}
```

## DetourDialer

通过另一个出站路由流量：

```go
type DetourDialer struct {
    outboundManager adapter.OutboundManager
    detour          string  // 要使用的出站标签
}

func (d *DetourDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    outbound, _ := d.outboundManager.Outbound(d.detour)
    return outbound.DialContext(ctx, network, destination)
}
```

当出站指定 `detour` 以链式通过另一个出站时使用（例如 VLESS -> direct）。

## ResolveDialer

包装 dialer 以在拨号前解析域名：

```go
type ResolveDialer struct {
    dialer    N.Dialer
    dnsRouter adapter.DNSRouter
    strategy  C.DomainStrategy
    server    string
}

func (d *ResolveDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    if destination.IsFqdn() {
        addresses, err := d.dnsRouter.Lookup(ctx, destination.Fqdn, options)
        // 使用解析的地址进行并行拨号
        return N.DialSerial(ctx, d.dialer, network, destination, addresses)
    }
    return d.dialer.DialContext(ctx, network, destination)
}
```

## WireGuard Dialer

用于 WireGuard 的特殊 dialer，使用 WireGuard endpoint 的网络：

```go
type WireGuardDialer struct {
    dialer N.Dialer
}
```

## 串行/并行拨号

```go
// 逐个尝试地址
func DialSerial(ctx, dialer, network, destination, addresses) (net.Conn, error)

// 使用网络策略尝试（接口选择）
func DialSerialNetwork(ctx, dialer, network, destination, addresses,
    strategy, networkType, fallbackType, fallbackDelay) (net.Conn, error)

// 使用地址选择监听数据包
func ListenSerialNetworkPacket(ctx, dialer, destination, addresses,
    strategy, networkType, fallbackType, fallbackDelay) (net.PacketConn, netip.Addr, error)
```

## Dialer 选项

```go
type DialerOptions struct {
    Detour              string
    BindInterface       string
    Inet4BindAddress    *ListenAddress
    Inet6BindAddress    *ListenAddress
    ProtectPath         string
    RoutingMark         uint32
    ReuseAddr           bool
    ConnectTimeout      Duration
    TCPFastOpen         bool
    TCPMultiPath        bool
    UDPFragment         *bool
    UDPFragmentDefault  bool
    DomainResolver      *DomainResolveOptions
    NetworkStrategy     *NetworkStrategy
    NetworkType         Listable[InterfaceType]
    FallbackNetworkType Listable[InterfaceType]
    FallbackDelay       Duration
    IsWireGuardListener bool
}
```
