# VLESS 协议

VLESS 是一种基于 UUID 认证的轻量级代理协议。sing-box 将 VLESS 线路格式委托给 `sing-vmess/vless` 库处理。

**源码**: `protocol/vless/`, `sing-vmess/vless/`

## Inbound 架构

```go
type Inbound struct {
    inbound.Adapter
    ctx       context.Context
    router    adapter.ConnectionRouterEx
    logger    logger.ContextLogger
    listener  *listener.Listener
    users     []option.VLESSUser
    service   *vless.Service[int]     // sing-vmess VLESS 服务
    tlsConfig tls.ServerConfig
    transport adapter.V2RayServerTransport
}
```

### 构造过程

```go
func NewInbound(ctx, router, logger, tag, options) (adapter.Inbound, error) {
    // 1. 创建 UoT 路由器包装（UDP-over-TCP 处理）
    inbound.router = uot.NewRouter(router, logger)

    // 2. 创建 mux 路由器包装（多路复用处理）
    inbound.router = mux.NewRouterWithOptions(inbound.router, logger, options.Multiplex)

    // 3. 使用用户列表创建 VLESS 服务
    service := vless.NewService[int](logger, adapter.NewUpstreamContextHandlerEx(
        inbound.newConnectionEx,        // TCP 处理器
        inbound.newPacketConnectionEx,   // UDP 处理器
    ))
    service.UpdateUsers(indices, uuids, flows)

    // 4. TLS 配置（可选）
    inbound.tlsConfig = tls.NewServerWithOptions(...)
    // 仅在以下条件下兼容 kTLS：无传输层、无 mux、无 flow（Vision）

    // 5. V2Ray 传输层（可选：WS、gRPC、HTTP 等）
    inbound.transport = v2ray.NewServerTransport(ctx, ..., inbound.tlsConfig, handler)

    // 6. TCP 监听器
    inbound.listener = listener.New(...)
}
```

### 连接流程

```
TCP Connection → [TLS Handshake] → VLESS Service.NewConnection()
                                          ↓
                                   解码 VLESS 头部
                                   认证 UUID
                                   提取目标地址
                                          ↓
                                   newConnectionEx() / newPacketConnectionEx()
                                          ↓
                                   设置 metadata (Inbound, User)
                                          ↓
                                   router.RouteConnectionEx()
```

当配置了 V2Ray 传输层时：
```
TCP Connection → Transport.Serve() → Transport Handler → [TLS 已处理] → VLESS Service
```

### kTLS 兼容性

kTLS（内核 TLS）在以下条件下启用：
- 无 V2Ray 传输层（原始 TCP + TLS）
- 无多路复用
- 无 Vision flow（所有用户的 flow 为空）

这允许内核处理 TLS 加密以获得更好的性能。

## Outbound 架构

```go
type Outbound struct {
    outbound.Adapter
    logger          logger.ContextLogger
    dialer          N.Dialer
    client          *vless.Client        // sing-vmess VLESS 客户端
    serverAddr      M.Socksaddr
    multiplexDialer *mux.Client
    tlsConfig       tls.Config
    tlsDialer       tls.Dialer
    transport       adapter.V2RayClientTransport
    packetAddr      bool     // 使用 packetaddr 编码
    xudp            bool     // 使用 XUDP 编码（默认）
}
```

### 拨号流程

```go
func (h *vlessDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    // 1. 建立传输层连接
    if h.transport != nil {
        conn = h.transport.DialContext(ctx)
    } else if h.tlsDialer != nil {
        conn = h.tlsDialer.DialTLSContext(ctx, h.serverAddr)
    } else {
        conn = h.dialer.DialContext(ctx, "tcp", h.serverAddr)
    }

    // 2. 协议握手
    switch network {
    case "tcp":
        return h.client.DialEarlyConn(conn, destination)
    case "udp":
        if h.xudp {
            return h.client.DialEarlyXUDPPacketConn(conn, destination)
        } else if h.packetAddr {
            packetConn = h.client.DialEarlyPacketConn(conn, packetaddr.SeqPacketMagicAddress)
            return packetaddr.NewConn(packetConn, destination)
        } else {
            return h.client.DialEarlyPacketConn(conn, destination)
        }
    }
}
```

### Early Data

`DialEarlyConn` 将 VLESS handshake 推迟到第一次写入时。VLESS 头部与第一个数据包一起发送，减少了往返次数。

### 多路复用

当启用多路复用时：

```go
outbound.multiplexDialer = mux.NewClientWithOptions((*vlessDialer)(outbound), logger, options.Multiplex)
```

mux 客户端包装 VLESS 拨号器。多个逻辑连接共享一个 VLESS 连接。

## UDP 包编码

VLESS 支持三种 UDP 编码模式：

### XUDP（默认）

逐包寻址——每个 UDP 包携带自己的目标地址。支持 Full-Cone NAT。

```go
h.client.DialEarlyXUDPPacketConn(conn, destination)
```

### PacketAddr

与 XUDP 类似，但使用不同的线路格式（`packetaddr.SeqPacketMagicAddress`）。

### 旧版

简单的 VLESS 包编码——所有包发送到相同的目标地址。

```go
h.client.DialEarlyPacketConn(conn, destination)
```

## 配置

```json
{
  "inbounds": [{
    "type": "vless",
    "listen": ":443",
    "users": [
      { "uuid": "...", "name": "user1", "flow": "" }
    ],
    "tls": { ... },
    "transport": { "type": "ws", "path": "/vless" },
    "multiplex": { "enabled": true }
  }],
  "outbounds": [{
    "type": "vless",
    "server": "example.com",
    "server_port": 443,
    "uuid": "...",
    "flow": "",
    "packet_encoding": "xudp",
    "tls": { ... },
    "transport": { "type": "ws", "path": "/vless" },
    "multiplex": { "enabled": true }
  }]
}
```

## 与 Xray-core VLESS 的主要区别

| 方面 | Xray-core | sing-box |
|--------|----------|----------|
| Vision/XTLS | 完全支持 (unsafe.Pointer) | 不支持 |
| 线路格式 | 内置编码 | `sing-vmess/vless` 库 |
| Fallback | 内置 (name→ALPN→path) | 不支持（使用单独的监听器） |
| XUDP | 内置，带 GlobalID | `sing-vmess` XUDP |
| Mux | 内置 mux 帧 | `sing-mux`（基于 smux） |
| 数据流 | Pipe Reader/Writer | net.Conn 直通 |
| 预连接 | 连接池 | 未内置 |

## 线路格式（来自 sing-vmess）

### 请求头
```
[1B Version=0x00]
[16B UUID]
[1B Addons length (N)]
[NB Addons protobuf]
[1B Command: 0x01=TCP, 0x02=UDP, 0x03=Mux]
[Address: Port(2B) + Type(1B) + Addr(var)]
```

### 响应头
```
[1B Version=0x00]
[1B Addons length]
[NB Addons]
```

线路格式与 Xray-core VLESS 兼容。
