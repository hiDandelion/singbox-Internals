# Direct、Block 和 DNS Outbound

这三种 outbound 类型承担基本的路由功能：`direct` 直接连接到目标而不使用代理，`block` 拒绝所有连接，`dns` 拦截 DNS 流量进行内部解析。

**源码**: `protocol/direct/outbound.go`, `protocol/direct/inbound.go`, `protocol/direct/loopback_detect.go`, `protocol/block/outbound.go`, `protocol/dns/outbound.go`, `protocol/dns/handle.go`

## Direct Outbound

### 架构

```go
type Outbound struct {
    outbound.Adapter
    ctx            context.Context
    logger         logger.ContextLogger
    dialer         dialer.ParallelInterfaceDialer
    domainStrategy C.DomainStrategy
    fallbackDelay  time.Duration
    isEmpty        bool
}
```

direct outbound 实现了多个拨号器 interface：

```go
var (
    _ N.ParallelDialer             = (*Outbound)(nil)
    _ dialer.ParallelNetworkDialer = (*Outbound)(nil)
    _ dialer.DirectDialer          = (*Outbound)(nil)
    _ adapter.DirectRouteOutbound  = (*Outbound)(nil)
)
```

### 网络支持

Direct 支持 TCP、UDP 和 ICMP（用于 ping/traceroute）：

```go
outbound.NewAdapterWithDialerOptions(C.TypeDirect, tag,
    []string{N.NetworkTCP, N.NetworkUDP, N.NetworkICMP}, options.DialerOptions)
```

### Detour 限制

Direct outbound 不能使用 detour（会造成循环）：

```go
if options.Detour != "" {
    return nil, E.New("`detour` is not supported in direct context")
}
```

### IsEmpty 检测

direct outbound 跟踪自身是否有非默认配置。路由器使用此信息来优化路由决策：

```go
outbound.isEmpty = reflect.DeepEqual(options.DialerOptions, option.DialerOptions{UDPFragmentDefault: true})
```

### 连接建立

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    ctx, metadata := adapter.ExtendContext(ctx)
    metadata.Outbound = h.Tag()
    metadata.Destination = destination
    return h.dialer.DialContext(ctx, network, destination)
}
```

### 并行拨号

Direct outbound 支持 Happy Eyeballs（并行 IPv4/IPv6）连接尝试：

```go
func (h *Outbound) DialParallel(ctx, network, destination, destinationAddresses) (net.Conn, error) {
    return dialer.DialParallelNetwork(ctx, h.dialer, network, destination,
        destinationAddresses, destinationAddresses[0].Is6(), nil, nil, nil, h.fallbackDelay)
}
```

### ICMP / 直连路由

Direct outbound 通过 `DirectRouteOutbound` interface 支持 ICMP 连接用于 ping/traceroute：

```go
func (h *Outbound) NewDirectRouteConnection(metadata, routeContext, timeout) (tun.DirectRouteDestination, error) {
    destination, _ := ping.ConnectDestination(ctx, h.logger,
        common.MustCast[*dialer.DefaultDialer](h.dialer).DialerForICMPDestination(metadata.Destination.Addr).Control,
        metadata.Destination.Addr, routeContext, timeout)
    return destination, nil
}
```

### 网络策略拨号

outbound 支持多路径连接的高级网络策略选项：

```go
func (h *Outbound) DialParallelNetwork(ctx, network, destination, destinationAddresses,
    networkStrategy, networkType, fallbackNetworkType, fallbackDelay) (net.Conn, error) {
    return dialer.DialParallelNetwork(ctx, h.dialer, network, destination,
        destinationAddresses, destinationAddresses[0].Is6(),
        networkStrategy, networkType, fallbackNetworkType, fallbackDelay)
}
```

## Direct Inbound

direct inbound 接受原始 TCP/UDP 连接并路由它们，支持可选的目标地址覆盖：

```go
type Inbound struct {
    inbound.Adapter
    overrideOption      int    // 0=无, 1=地址+端口, 2=地址, 3=端口
    overrideDestination M.Socksaddr
}
```

### 覆盖选项

```go
if options.OverrideAddress != "" && options.OverridePort != 0 {
    inbound.overrideOption = 1  // 替换地址和端口
} else if options.OverrideAddress != "" {
    inbound.overrideOption = 2  // 仅替换地址
} else if options.OverridePort != 0 {
    inbound.overrideOption = 3  // 仅替换端口
}
```

## 环回检测

`loopBackDetector` 通过跟踪连接来防止路由环路：

```go
type loopBackDetector struct {
    networkManager   adapter.NetworkManager
    connMap          map[netip.AddrPort]netip.AddrPort    // TCP
    packetConnMap    map[uint16]uint16                     // UDP（基于端口）
}
```

它包装出站连接并检查入站连接是否在映射中：

```go
func (l *loopBackDetector) CheckConn(source, local netip.AddrPort) bool {
    destination, loaded := l.connMap[source]
    return loaded && destination != local
}
```

注意：环回检测目前在源码中已被注释掉，但基础设施仍然保留。

## Block Outbound

最简单的 outbound——它使用 `EPERM` 拒绝所有连接：

```go
type Outbound struct {
    outbound.Adapter
    logger logger.ContextLogger
}

func New(ctx, router, logger, tag, _ option.StubOptions) (adapter.Outbound, error) {
    return &Outbound{
        Adapter: outbound.NewAdapter(C.TypeBlock, tag, []string{N.NetworkTCP, N.NetworkUDP}, nil),
        logger:  logger,
    }, nil
}

func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    h.logger.InfoContext(ctx, "blocked connection to ", destination)
    return nil, syscall.EPERM
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    h.logger.InfoContext(ctx, "blocked packet connection to ", destination)
    return nil, syscall.EPERM
}
```

关键细节：
- 使用 `option.StubOptions`（空 struct），因为不需要配置
- 返回 `syscall.EPERM`（非通用错误），调用方可以检测到
- 同时支持 TCP 和 UDP（两者都被阻止）

## DNS Outbound

DNS outbound 拦截携带 DNS 流量的连接，并使用内部 DNS 路由器进行解析。

### 架构

```go
type Outbound struct {
    outbound.Adapter
    router adapter.DNSRouter
    logger logger.ContextLogger
}
```

### 常规 Dial 不受支持

DNS outbound 不支持常规的 `DialContext` 或 `ListenPacket`：

```go
func (d *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    return nil, os.ErrInvalid
}
```

取而代之的是，它实现了 `NewConnectionEx` 和 `NewPacketConnectionEx` 来直接处理 DNS 消息。

### 流式 DNS（TCP）

TCP DNS 连接在循环中处理，读取长度前缀的 DNS 消息：

```go
func (d *Outbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    metadata.Destination = M.Socksaddr{}
    for {
        conn.SetReadDeadline(time.Now().Add(C.DNSTimeout))
        err := HandleStreamDNSRequest(ctx, d.router, conn, metadata)
        if err != nil {
            conn.Close()
            return
        }
    }
}
```

### 流式 DNS 线路格式

TCP 上的 DNS 使用 2 字节长度前缀：

```go
func HandleStreamDNSRequest(ctx, router, conn, metadata) error {
    // 1. 读取 2 字节长度前缀
    var queryLength uint16
    binary.Read(conn, binary.BigEndian, &queryLength)

    // 2. 读取 DNS 消息
    buffer := buf.NewSize(int(queryLength))
    buffer.ReadFullFrom(conn, int(queryLength))

    // 3. 解包并路由
    var message mDNS.Msg
    message.Unpack(buffer.Bytes())

    // 4. 通过 DNS 路由器交换（异步）
    go func() {
        response, _ := router.Exchange(ctx, &message, adapter.DNSQueryOptions{})
        // 写入长度前缀的响应
        binary.BigEndian.PutUint16(responseBuffer.ExtendHeader(2), uint16(len(n)))
        conn.Write(responseBuffer.Bytes())
    }()
}
```

### 包式 DNS（UDP）

UDP DNS 包使用空闲超时并发处理：

```go
func (d *Outbound) NewPacketConnectionEx(ctx, conn, metadata, onClose) {
    NewDNSPacketConnection(ctx, d.router, conn, nil, metadata)
}
```

包处理器：
1. 从连接读取 DNS 包
2. 将每个包解包为 DNS 消息
3. 在 goroutine 中通过 DNS 路由器交换
4. 将响应写回，支持 DNS 截断
5. 使用 `C.DNSTimeout` 的取消器进行空闲检测

```go
go func() {
    response, _ := router.Exchange(ctx, &message, adapter.DNSQueryOptions{})
    responseBuffer, _ := dns.TruncateDNSMessage(&message, response, 1024)
    conn.WritePacket(responseBuffer, destination)
}()
```

## 配置示例

### Direct

```json
{
  "type": "direct",
  "tag": "direct-out"
}
```

### 带域名策略的 Direct

```json
{
  "type": "direct",
  "tag": "direct-out",
  "domain_strategy": "prefer_ipv4"
}
```

### Block

```json
{
  "type": "block",
  "tag": "block-out"
}
```

### DNS

```json
{
  "type": "dns",
  "tag": "dns-out"
}
```

### Direct Inbound（带覆盖）

```json
{
  "type": "direct",
  "tag": "direct-in",
  "listen": "::",
  "listen_port": 5353,
  "override_address": "8.8.8.8",
  "override_port": 53
}
```
