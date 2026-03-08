# VMess 协议

VMess 是 V2Ray 原生代理协议，具有基于 UUID 认证的 AEAD 加密功能。sing-box 将 VMess 线路格式完全委托给 `sing-vmess` 库处理。

**源码**: `protocol/vmess/inbound.go`, `protocol/vmess/outbound.go`, `sing-vmess`

## sing-vmess 集成

sing-box 并未自行实现 VMess 线路格式，而是使用 `github.com/sagernet/sing-vmess` 库，该库提供：

- `vmess.Service[int]` -- 服务端 VMess 协议处理器，泛型参数为用户键类型
- `vmess.Client` -- 客户端 VMess 协议处理器
- `vmess.ServiceOption` / `vmess.ClientOption` -- 用于配置的函数式选项
- `packetaddr` -- 用于 UDP-over-TCP 的包地址编码

这与 **Xray-core** 的主要区别在于，Xray-core 在其代码库中直接实现 VMess。sing-box 的方式提供了更清晰的关注点分离。

## Inbound 架构

```go
type Inbound struct {
    inbound.Adapter
    ctx       context.Context
    router    adapter.ConnectionRouterEx
    logger    logger.ContextLogger
    listener  *listener.Listener
    service   *vmess.Service[int]       // sing-vmess 服务，以用户索引为键
    users     []option.VMessUser
    tlsConfig tls.ServerConfig
    transport adapter.V2RayServerTransport
}
```

### 构造流程

```go
func NewInbound(ctx, router, logger, tag, options) (adapter.Inbound, error) {
    // 1. 使用 UoT（UDP-over-TCP）支持包装路由器
    inbound.router = uot.NewRouter(router, logger)

    // 2. 使用 mux（多路复用）支持包装路由器
    inbound.router = mux.NewRouterWithOptions(inbound.router, logger, options.Multiplex)

    // 3. 配置 VMess 服务选项
    //    - NTP 时间函数（VMess 对时间敏感）
    //    - 当使用 V2Ray 传输层时禁用头部保护
    serviceOptions = append(serviceOptions, vmess.ServiceWithTimeFunc(timeFunc))
    if options.Transport != nil {
        serviceOptions = append(serviceOptions, vmess.ServiceWithDisableHeaderProtection())
    }

    // 4. 创建服务并注册用户（index -> UUID + alterId）
    service := vmess.NewService[int](handler, serviceOptions...)
    service.UpdateUsers(indices, uuids, alterIds)

    // 5. 可选 TLS
    // 6. 可选 V2Ray 传输层（WebSocket、gRPC、HTTP、QUIC）
    // 7. TCP 监听器
}
```

### 关键设计：使用传输层时禁用头部保护

当配置了 V2Ray 传输层（WebSocket、gRPC 等）时，会传入 `vmess.ServiceWithDisableHeaderProtection()`。这是因为传输层已经提供了自己的帧格式，使得 VMess 的头部保护变得冗余且可能产生问题。

### 连接处理

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    // 1. TLS handshake（仅在配置了 TLS 且无传输层时）
    //    当使用传输层时，TLS 由传输层处理
    if h.tlsConfig != nil && h.transport == nil {
        conn = tls.ServerHandshake(ctx, conn, h.tlsConfig)
    }

    // 2. 委托给 sing-vmess 服务
    //    VMess 解密、认证、命令解析都在此处进行
    h.service.NewConnection(ctx, conn, metadata.Source, onClose)
}
```

服务解码 VMess 请求后，回调 inbound 的处理器：

```go
func (h *Inbound) newConnectionEx(ctx, conn, metadata, onClose) {
    // 从 context 中提取用户索引（由 sing-vmess 设置）
    userIndex, _ := auth.UserFromContext[int](ctx)
    user := h.users[userIndex].Name
    metadata.User = user
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### 包地址（packetaddr）处理

对于 UDP 包连接，VMess 使用魔术 FQDN 地址 `packetaddr.SeqPacketMagicAddress` 来标识连接携带多路复用的 UDP 包：

```go
func (h *Inbound) newPacketConnectionEx(ctx, conn, metadata, onClose) {
    if metadata.Destination.Fqdn == packetaddr.SeqPacketMagicAddress {
        metadata.Destination = M.Socksaddr{}
        conn = packetaddr.NewConn(bufio.NewNetPacketConn(conn), metadata.Destination)
    }
    h.router.RoutePacketConnectionEx(ctx, conn, metadata, onClose)
}
```

## Outbound 架构

```go
type Outbound struct {
    outbound.Adapter
    logger          logger.ContextLogger
    dialer          N.Dialer
    client          *vmess.Client        // sing-vmess 客户端
    serverAddr      M.Socksaddr
    multiplexDialer *mux.Client
    tlsConfig       tls.Config
    tlsDialer       tls.Dialer
    transport       adapter.V2RayClientTransport
    packetAddr      bool                 // packetaddr 编码
    xudp            bool                 // XUDP 编码
}
```

### 包编码模式

VMess outbound 支持三种 UDP 包编码模式：

| 模式 | 字段 | 说明 |
|------|-------|-------------|
| （无） | 默认 | 标准 VMess UDP |
| `packetaddr` | `packetAddr=true` | 使用 packetaddr 魔术 FQDN 进行 UDP 多路复用 |
| `xudp` | `xudp=true` | 用于 UDP 多路复用的 XUDP 协议 |

```go
switch options.PacketEncoding {
case "packetaddr":
    outbound.packetAddr = true
case "xudp":
    outbound.xudp = true
}
```

### 安全性自动选择

```go
security := options.Security
if security == "" {
    security = "auto"
}
if security == "auto" && outbound.tlsConfig != nil {
    security = "zero"  // 当存在 TLS 时使用零加密
}
```

当已经配置了 TLS 时，VMess 会自动使用 "zero" 安全性以避免双重加密——这是一种性能优化。

### 客户端选项

```go
var clientOptions []vmess.ClientOption
if options.GlobalPadding {
    clientOptions = append(clientOptions, vmess.ClientWithGlobalPadding())
}
if options.AuthenticatedLength {
    clientOptions = append(clientOptions, vmess.ClientWithAuthenticatedLength())
}
client, _ := vmess.NewClient(options.UUID, security, options.AlterId, clientOptions...)
```

- **GlobalPadding**：为所有数据包添加随机 padding 以抵抗流量分析
- **AuthenticatedLength**：在头部中包含已认证的有效载荷长度（AEAD 模式）

### 连接建立

`vmessDialer` 类型处理实际连接：

```go
func (h *vmessDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    // 1. 建立底层连接
    //    优先级：transport > TLS > 原始 TCP
    if h.transport != nil {
        conn = h.transport.DialContext(ctx)
    } else if h.tlsDialer != nil {
        conn = h.tlsDialer.DialTLSContext(ctx, h.serverAddr)
    } else {
        conn = h.dialer.DialContext(ctx, "tcp", h.serverAddr)
    }

    // 2. 使用 VMess 协议包装（early data / 0-RTT）
    switch network {
    case "tcp":
        return h.client.DialEarlyConn(conn, destination)
    case "udp":
        return h.client.DialEarlyPacketConn(conn, destination)
    }
}
```

对于 `ListenPacket`，编码模式决定了包装方式：

```go
func (h *vmessDialer) ListenPacket(ctx, destination) (net.PacketConn, error) {
    conn := /* 建立连接 */
    if h.packetAddr {
        return packetaddr.NewConn(
            h.client.DialEarlyPacketConn(conn, M.Socksaddr{Fqdn: packetaddr.SeqPacketMagicAddress}),
            destination,
        )
    } else if h.xudp {
        return h.client.DialEarlyXUDPPacketConn(conn, destination)
    } else {
        return h.client.DialEarlyPacketConn(conn, destination)
    }
}
```

## Mux 支持

多路复用通过 `common/mux` 包实现。在 inbound 侧，路由器使用 `mux.NewRouterWithOptions()` 进行包装。在 outbound 侧，`mux.Client` 包装 VMess 拨号器：

```go
outbound.multiplexDialer, _ = mux.NewClientWithOptions((*vmessDialer)(outbound), logger, options.Multiplex)
```

当 mux 激活时，`DialContext` 和 `ListenPacket` 委托给 mux 客户端，而不是创建独立的 VMess 连接。

## 与 Xray-core 的区别

| 方面 | sing-box | Xray-core |
|--------|----------|-----------|
| 实现 | 委托给 `sing-vmess` 库 | 内置实现 |
| AlterId | 支持但优先使用 AEAD | 完全支持旧版 |
| XUDP | 通过 `sing-vmess` 支持 | 原生实现 |
| 头部保护 | 使用传输层时禁用 | 始终启用 |
| 安全性自动选择 | 存在 TLS 时使用 "zero" | 基于 AlterId 的 "auto" |
| 时间同步 | NTP context 集成 | 仅使用系统时间 |

## 配置示例

```json
{
  "type": "vmess",
  "tag": "vmess-in",
  "listen": "::",
  "listen_port": 10086,
  "users": [
    {
      "name": "user1",
      "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
      "alterId": 0
    }
  ],
  "tls": {
    "enabled": true,
    "server_name": "example.com",
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  },
  "transport": {
    "type": "ws",
    "path": "/vmess"
  },
  "multiplex": {
    "enabled": true
  }
}
```

```json
{
  "type": "vmess",
  "tag": "vmess-out",
  "server": "example.com",
  "server_port": 10086,
  "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
  "security": "auto",
  "alter_id": 0,
  "global_padding": true,
  "authenticated_length": true,
  "packet_encoding": "xudp",
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  },
  "transport": {
    "type": "ws",
    "path": "/vmess"
  }
}
```
