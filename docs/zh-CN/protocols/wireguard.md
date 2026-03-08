# WireGuard 协议

sing-box 中的 WireGuard 以 **Endpoint**（而非 inbound/outbound 对）方式实现，使用 `wireguard-go` 库，支持两种设备后端：gVisor 用户态网络和系统 TUN。该 endpoint 同时支持入站和出站流量、用于 ICMP/ping 的 NAT 设备包装以及对等节点 DNS 解析。

**源码**: `protocol/wireguard/endpoint.go`, `transport/wireguard/endpoint.go`, `transport/wireguard/device.go`, `transport/wireguard/device_nat.go`

## Endpoint 架构

WireGuard 使用 `endpoint.Adapter` 模式，这是 inbound+outbound 的组合：

```go
type Endpoint struct {
    endpoint.Adapter
    ctx            context.Context
    router         adapter.Router
    dnsRouter      adapter.DNSRouter
    logger         logger.ContextLogger
    localAddresses []netip.Prefix
    endpoint       *wireguard.Endpoint
}
```

它实现了多个 interface：

```go
var (
    _ adapter.OutboundWithPreferredRoutes = (*Endpoint)(nil)
    _ dialer.PacketDialerWithDestination  = (*Endpoint)(nil)
)
```

### 网络支持

WireGuard 支持 TCP、UDP 和 ICMP：

```go
endpoint.NewAdapterWithDialerOptions(C.TypeWireGuard, tag,
    []string{N.NetworkTCP, N.NetworkUDP, N.NetworkICMP}, options.DialerOptions)
```

## Device Interface

`Device` interface 抽象了不同的 WireGuard 隧道实现：

```go
type Device interface {
    wgTun.Device       // 读/写数据包
    N.Dialer           // DialContext / ListenPacket
    Start() error
    SetDevice(device *device.Device)
    Inet4Address() netip.Addr
    Inet6Address() netip.Addr
}
```

### Device 工厂

`NewDevice` 工厂根据 `System` 标志选择实现：

```go
func NewDevice(options DeviceOptions) (Device, error) {
    if !options.System {
        return newStackDevice(options)        // gVisor 用户态协议栈
    } else if !tun.WithGVisor {
        return newSystemDevice(options)       // 系统 TUN 设备
    } else {
        return newSystemStackDevice(options)  // 系统 TUN + gVisor 协议栈
    }
}
```

- **Stack Device**（默认）：通过 gVisor 的纯用户态网络。不需要内核 TUN 设备。
- **System Device**：在操作系统上创建真实的 TUN 接口。需要提升权限。
- **System Stack Device**：系统 TUN 配合 gVisor 进行包处理。

## NAT Device 包装器

`NatDevice` 包装 `Device` 以通过源地址重写提供 ICMP/ping 支持：

```go
type NatDevice interface {
    Device
    CreateDestination(metadata, routeContext, timeout) (tun.DirectRouteDestination, error)
}

type natDeviceWrapper struct {
    Device
    ctx            context.Context
    logger         logger.ContextLogger
    packetOutbound chan *buf.Buffer
    rewriter       *ping.SourceRewriter
    buffer         [][]byte
}
```

### NAT Device 创建

如果底层设备不原生支持 NAT，则应用包装器：

```go
tunDevice, _ := NewDevice(deviceOptions)
natDevice, isNatDevice := tunDevice.(NatDevice)
if !isNatDevice {
    natDevice = NewNATDevice(options.Context, options.Logger, tunDevice)
}
```

### 数据包拦截

NAT 包装器拦截读操作以注入出站 ICMP 响应，拦截写操作以重写 ICMP 源地址：

```go
func (d *natDeviceWrapper) Read(bufs [][]byte, sizes []int, offset int) (n int, err error) {
    select {
    case packet := <-d.packetOutbound:
        defer packet.Release()
        sizes[0] = copy(bufs[0][offset:], packet.Bytes())
        return 1, nil
    default:
    }
    return d.Device.Read(bufs, sizes, offset)
}

func (d *natDeviceWrapper) Write(bufs [][]byte, offset int) (int, error) {
    for _, buffer := range bufs {
        handled, err := d.rewriter.WriteBack(buffer[offset:])
        if handled {
            // ICMP 响应在内部处理
        } else {
            d.buffer = append(d.buffer, buffer)
        }
    }
    // 将非 ICMP 包转发给真实设备
    d.Device.Write(d.buffer, offset)
}
```

## 传输层 Endpoint

`transport/wireguard/endpoint.go` 管理 WireGuard 设备的生命周期：

```go
type Endpoint struct {
    options        EndpointOptions
    peers          []peerConfig
    ipcConf        string
    allowedAddress []netip.Prefix
    tunDevice      Device
    natDevice      NatDevice
    device         *device.Device
    allowedIPs     *device.AllowedIPs
}
```

### IPC 配置

WireGuard 配置通过 IPC 协议字符串传递给 `wireguard-go`：

```go
privateKeyBytes, _ := base64.StdEncoding.DecodeString(options.PrivateKey)
privateKey := hex.EncodeToString(privateKeyBytes)
ipcConf := "private_key=" + privateKey
if options.ListenPort != 0 {
    ipcConf += "\nlisten_port=" + F.ToString(options.ListenPort)
}
```

对等节点配置以类似方式生成：

```go
func (c peerConfig) GenerateIpcLines() string {
    ipcLines := "\npublic_key=" + c.publicKeyHex
    if c.endpoint.IsValid() {
        ipcLines += "\nendpoint=" + c.endpoint.String()
    }
    if c.preSharedKeyHex != "" {
        ipcLines += "\npreshared_key=" + c.preSharedKeyHex
    }
    for _, allowedIP := range c.allowedIPs {
        ipcLines += "\nallowed_ip=" + allowedIP.String()
    }
    if c.keepalive > 0 {
        ipcLines += "\npersistent_keepalive_interval=" + F.ToString(c.keepalive)
    }
    return ipcLines
}
```

### 两阶段启动

endpoint 有两阶段启动以处理对等节点 endpoint 的 DNS 解析：

```go
func (w *Endpoint) Start(stage adapter.StartStage) error {
    switch stage {
    case adapter.StartStateStart:
        return w.endpoint.Start(false)   // 不进行 DNS 解析的启动
    case adapter.StartStatePostStart:
        return w.endpoint.Start(true)    // 现在解析对等节点域名
    }
}
```

如果对等节点有 FQDN endpoint，解析会推迟到 `PostStart` 阶段（此时 DNS 可用）：

```go
ResolvePeer: func(domain string) (netip.Addr, error) {
    endpointAddresses, _ := ep.dnsRouter.Lookup(ctx, domain, outboundDialer.(dialer.ResolveDialer).QueryOptions())
    return endpointAddresses[0], nil
},
```

### 保留字节

WireGuard 支持每个对等节点的保留字节（被某些实现如 Cloudflare WARP 使用）：

```go
if len(rawPeer.Reserved) > 0 {
    if len(rawPeer.Reserved) != 3 {
        return nil, E.New("invalid reserved value, required 3 bytes")
    }
    copy(peer.reserved[:], rawPeer.Reserved[:])
}
```

### Bind 选择

endpoint 根据拨号器类型使用不同的 bind 实现：

```go
wgListener, isWgListener := common.Cast[dialer.WireGuardListener](e.options.Dialer)
if isWgListener {
    bind = conn.NewStdNetBind(wgListener.WireGuardControl())
} else {
    // 用于单对等节点连接的 ClientBind
    bind = NewClientBind(ctx, logger, dialer, isConnect, connectAddr, reserved)
}
```

## 协议层 Endpoint

`protocol/wireguard/endpoint.go` 处理路由集成：

### 本地地址重写

到 WireGuard endpoint 自身地址的连接会被重写为回环地址：

```go
func (w *Endpoint) NewConnectionEx(ctx, conn, source, destination, onClose) {
    for _, localPrefix := range w.localAddresses {
        if localPrefix.Contains(destination.Addr) {
            metadata.OriginDestination = destination
            if destination.Addr.Is4() {
                destination.Addr = netip.AddrFrom4([4]uint8{127, 0, 0, 1})
            } else {
                destination.Addr = netip.IPv6Loopback()
            }
            break
        }
    }
}
```

### 出站 DNS 解析

outbound 使用 DNS 路由器解析 FQDN：

```go
func (w *Endpoint) DialContext(ctx, network, destination) (net.Conn, error) {
    if destination.IsFqdn() {
        destinationAddresses, _ := w.dnsRouter.Lookup(ctx, destination.Fqdn, adapter.DNSQueryOptions{})
        return N.DialSerial(ctx, w.endpoint, network, destination, destinationAddresses)
    }
    return w.endpoint.DialContext(ctx, network, destination)
}
```

### 首选路由

endpoint 通告其可路由的地址，使路由器能够为匹配的目标选择它：

```go
func (w *Endpoint) PreferredAddress(address netip.Addr) bool {
    return w.endpoint.Lookup(address) != nil
}
```

### 暂停管理器集成

endpoint 响应设备暂停/唤醒事件（如移动端休眠）：

```go
func (e *Endpoint) onPauseUpdated(event int) {
    switch event {
    case pause.EventDevicePaused, pause.EventNetworkPause:
        e.device.Down()
    case pause.EventDeviceWake, pause.EventNetworkWake:
        e.device.Up()
    }
}
```

## 配置示例

```json
{
  "type": "wireguard",
  "tag": "wg-ep",
  "system": false,
  "name": "wg0",
  "mtu": 1420,
  "address": ["10.0.0.2/32", "fd00::2/128"],
  "private_key": "base64-encoded-private-key",
  "peers": [
    {
      "address": "server.example.com",
      "port": 51820,
      "public_key": "base64-encoded-public-key",
      "pre_shared_key": "optional-base64-psk",
      "allowed_ips": ["0.0.0.0/0", "::/0"],
      "persistent_keepalive_interval": 25,
      "reserved": [0, 0, 0]
    }
  ],
  "workers": 2
}
```
