# 协议概览

sing-box 支持 20 多种代理协议，所有协议都遵循一致的适配器模式。协议实现是轻量级的包装层，将实际的线路格式处理委托给 `sing-*` 库。

**源码**: `protocol/`, `include/`

## 注册模式

每个协议都通过 include 系统进行注册：

```go
// include/inbound.go
func InboundRegistry() *inbound.Registry {
    registry := inbound.NewRegistry()
    tun.RegisterInbound(registry)
    vless.RegisterInbound(registry)
    vmess.RegisterInbound(registry)
    trojan.RegisterInbound(registry)
    // ...
    return registry
}
```

每个协议都提供一个注册函数：

```go
// protocol/vless/inbound.go
func RegisterInbound(registry adapter.InboundRegistry) {
    inbound.Register[option.VLESSInboundOptions](registry, C.TypeVLESS, NewInbound)
}
```

泛型 `Register` 函数的映射关系为：`(type string, options type) → factory function`。

## Inbound 模式

所有 inbound 都遵循以下结构：

```go
type Inbound struct {
    myInboundAdapter  // 内嵌适配器，包含 Tag(), Type()
    ctx      context.Context
    router   adapter.ConnectionRouterEx
    logger   log.ContextLogger
    listener *listener.Listener    // TCP 监听器
    service  *someprotocol.Service // 协议服务
}

func NewInbound(ctx, router, logger, tag string, options) (adapter.Inbound, error) {
    // 1. 创建协议服务（来自 sing-* 库）
    // 2. 创建监听器
    // 3. 将服务连接到路由器进行连接处理
}

func (h *Inbound) Start(stage adapter.StartStage) error {
    // 启动监听器
}

func (h *Inbound) Close() error {
    // 关闭监听器和服务
}

// 监听器为每个新连接调用此方法
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    // 此处进行协议特定的解码
    // 然后: h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## Outbound 模式

所有 outbound 都实现 `N.Dialer`：

```go
type Outbound struct {
    myOutboundAdapter  // 内嵌适配器，包含 Tag(), Type(), Network()
    ctx       context.Context
    dialer    N.Dialer           // 底层拨号器（可能是 detour）
    transport *v2ray.Transport   // 可选的 V2Ray 传输层
    // 协议特定选项
}

func NewOutbound(ctx, router, logger, tag string, options) (adapter.Outbound, error) {
    // 1. 创建底层拨号器（默认或 detour）
    // 2. 如有配置则创建 V2Ray 传输层
    // 3. 配置协议选项
}

func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    // 1. 拨号传输层连接
    // 2. 执行协议 handshake
    // 3. 返回包装后的连接
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    // 用于支持 UDP 的协议
}
```

## 协议分类

### 代理协议（客户端/服务端）
| 协议 | Inbound | Outbound | 库 |
|----------|---------|----------|---------|
| VLESS | 是 | 是 | `sing-vmess` |
| VMess | 是 | 是 | `sing-vmess` |
| Trojan | 是 | 是 | `transport/trojan`（内置） |
| Shadowsocks | 是 | 是 | `sing-shadowsocks` / `sing-shadowsocks2` |
| ShadowTLS | 是 | 是 | `sing-shadowtls` |
| Hysteria2 | 是 | 是 | `sing-quic` |
| TUIC | 是 | 是 | `sing-quic` |
| AnyTLS | 是 | 是 | `sing-anytls` |
| NaiveProxy | 是 | 是 | 内置 |
| WireGuard | Endpoint | Endpoint | `wireguard-go` |
| Tailscale | Endpoint | Endpoint | `tailscale` |

### 本地代理协议
| 协议 | Inbound | Outbound |
|----------|---------|----------|
| SOCKS4/5 | 是 | 是 |
| HTTP | 是 | 是 |
| Mixed (SOCKS+HTTP) | 是 | - |
| Redirect | 是 | - |
| TProxy | 是 | - |
| TUN | 是 | - |

### 工具类协议
| 协议 | 用途 |
|----------|---------|
| Direct | 直连出站 |
| Block | 丢弃所有连接 |
| DNS | 转发到 DNS 路由器 |
| Selector | 手动选择出站 |
| URLTest | 基于延迟自动选择 |
| SSH | SSH 隧道 |
| Tor | Tor 网络 |

## V2Ray 传输层集成

许多协议支持 V2Ray 兼容的传输层：

```go
// 从选项创建传输层
transport, err := v2ray.NewServerTransport(ctx, logger, common.PtrValueOrDefault(options.Transport), tlsConfig, handler)

// 或客户端侧
transport, err := v2ray.NewClientTransport(ctx, dialer, serverAddr, common.PtrValueOrDefault(options.Transport), tlsConfig)
```

支持的传输层：WebSocket、gRPC、HTTP/2、HTTPUpgrade、QUIC。

## 多路复用集成

Outbound 可以使用多路复用进行包装：

```go
if options.Multiplex != nil && options.Multiplex.Enabled {
    outbound.multiplexDialer, err = mux.NewClientWithOptions(ctx, outbound, muxOptions)
}
```

## 处理链

```
Inbound Listener → 协议解码 → Router → 规则匹配 → Outbound 选择
    ↓                                                          ↓
TCP/UDP accept                                          协议编码
    ↓                                                          ↓
协议服务                                                传输层拨号
    ↓                                                          ↓
提取目标地址                                            远程连接
    ↓                                                          ↓
路由到 outbound ─────────────────────────────→ ConnectionManager.Copy
```

## 与 Xray-core 的主要区别

| 方面 | Xray-core | sing-box |
|--------|----------|----------|
| 线路格式 | 内置编码 | `sing-*` 库 |
| Inbound 模型 | `proxy.Inbound.Process()` 返回 Link | `adapter.Inbound` → router 回调 |
| Outbound 模型 | `proxy.Outbound.Process()` 使用 Link | `N.Dialer` interface (DialContext/ListenPacket) |
| 数据流 | Pipe Reader/Writer | 直接使用 net.Conn/PacketConn |
| Mux | 内置 mux + XUDP | `sing-mux` 库 |
| Vision/XTLS | 内置于 proxy.go | 不支持（采用不同方案） |
