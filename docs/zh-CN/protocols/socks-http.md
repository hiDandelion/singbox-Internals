# SOCKS、HTTP 和 Mixed 协议

sing-box 实现了 SOCKS4/5、HTTP CONNECT 和一个自动检测协议的组合 "mixed" 监听器。三者共享类似的模式：仅 TCP 监听、可选 TLS、用户名/密码认证以及 UoT（UDP-over-TCP）支持。

**源码**: `protocol/socks/inbound.go`, `protocol/http/inbound.go`, `protocol/mixed/inbound.go`, `protocol/socks/outbound.go`, `protocol/http/outbound.go`

## SOCKS Inbound

### 架构

```go
type Inbound struct {
    inbound.Adapter
    router        adapter.ConnectionRouterEx
    logger        logger.ContextLogger
    listener      *listener.Listener
    authenticator *auth.Authenticator
    udpTimeout    time.Duration
}
```

SOCKS inbound 实现了 `adapter.TCPInjectableInbound`：

```go
var _ adapter.TCPInjectableInbound = (*Inbound)(nil)
```

### 连接处理

SOCKS 连接被委托给 `sing/protocol/socks.HandleConnectionEx`，该函数处理完整的 SOCKS4/5 handshake：

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    err := socks.HandleConnectionEx(ctx, conn, std_bufio.NewReader(conn),
        h.authenticator,
        adapter.NewUpstreamHandlerEx(metadata, h.newUserConnection, h.streamUserPacketConnection),
        h.listener,         // UDP 关联监听器
        h.udpTimeout,
        metadata.Source,
        onClose,
    )
    N.CloseOnHandshakeFailure(conn, onClose, err)
}
```

处理器在 SOCKS handshake 之后接收解码的 TCP 连接和 UDP 包连接：

```go
func (h *Inbound) newUserConnection(ctx, conn, metadata, onClose) {
    metadata.Inbound = h.Tag()
    metadata.InboundType = h.Type()
    user, loaded := auth.UserFromContext[string](ctx)
    if loaded {
        metadata.User = user
    }
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### UoT 支持

路由器使用 UoT 支持进行包装以处理 UDP-over-TCP：

```go
inbound.router = uot.NewRouter(router, logger)
```

### 仅 TCP 监听器

SOCKS 仅在 TCP 上监听。UDP 关联连接通过 SOCKS5 UDP 中继机制处理（使用 `listener` 作为 UDP 关联目标）：

```go
inbound.listener = listener.New(listener.Options{
    Network:           []string{N.NetworkTCP},
    ConnectionHandler: inbound,
})
```

## HTTP Inbound

### 架构

```go
type Inbound struct {
    inbound.Adapter
    router        adapter.ConnectionRouterEx
    logger        log.ContextLogger
    listener      *listener.Listener
    authenticator *auth.Authenticator
    tlsConfig     tls.ServerConfig
}
```

### 支持 kTLS 的 TLS

HTTP inbound 支持启用 kTLS 兼容性的 TLS：

```go
if options.TLS != nil {
    tlsConfig, _ := tls.NewServerWithOptions(tls.ServerOptions{
        KTLSCompatible: true,
    })
    inbound.tlsConfig = tlsConfig
}
```

### 连接处理

先执行 TLS handshake（如有配置），然后 HTTP CONNECT 处理器处理请求：

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    if h.tlsConfig != nil {
        tlsConn, _ := tls.ServerHandshake(ctx, conn, h.tlsConfig)
        conn = tlsConn
    }
    err := http.HandleConnectionEx(ctx, conn, std_bufio.NewReader(conn),
        h.authenticator,
        adapter.NewUpstreamHandlerEx(metadata, h.newUserConnection, h.streamUserPacketConnection),
        metadata.Source,
        onClose,
    )
}
```

### 系统代理

HTTP inbound 可以将自身配置为系统代理：

```go
inbound.listener = listener.New(listener.Options{
    SetSystemProxy:    options.SetSystemProxy,
    SystemProxySOCKS:  false,
})
```

## Mixed Inbound

mixed inbound 通过查看每个连接的第一个字节，在单个端口上组合了 SOCKS 和 HTTP。

### 架构

```go
type Inbound struct {
    inbound.Adapter
    router        adapter.ConnectionRouterEx
    logger        log.ContextLogger
    listener      *listener.Listener
    authenticator *auth.Authenticator
    tlsConfig     tls.ServerConfig
    udpTimeout    time.Duration
}
```

### 协议检测

核心逻辑通过查看第一个字节来判断协议：

```go
func (h *Inbound) newConnection(ctx, conn, metadata, onClose) error {
    if h.tlsConfig != nil {
        conn = tls.ServerHandshake(ctx, conn, h.tlsConfig)
    }
    reader := std_bufio.NewReader(conn)
    headerBytes, _ := reader.Peek(1)

    switch headerBytes[0] {
    case socks4.Version, socks5.Version:
        // SOCKS4 (0x04) 或 SOCKS5 (0x05)
        return socks.HandleConnectionEx(ctx, conn, reader, h.authenticator, ...)
    default:
        // 其他任何情况视为 HTTP
        return http.HandleConnectionEx(ctx, conn, reader, h.authenticator, ...)
    }
}
```

- **SOCKS4**：第一个字节为 `0x04`
- **SOCKS5**：第一个字节为 `0x05`
- **HTTP**：任何其他第一个字节（通常 `C` 代表 CONNECT，`G` 代表 GET 等）

### 系统代理（Mixed）

当 mixed 设置为系统代理时，它报告 SOCKS 端口：

```go
inbound.listener = listener.New(listener.Options{
    SetSystemProxy:    options.SetSystemProxy,
    SystemProxySOCKS:  true,  // 在系统代理中通告 SOCKS 端口
})
```

## SOCKS Outbound

SOCKS outbound 通过上游 SOCKS5 服务器进行连接。实现在 `protocol/socks/outbound.go` 中，使用 `sing/protocol/socks` 库的 `Client` 类型。

## HTTP Outbound

HTTP outbound 通过上游 HTTP CONNECT 代理进行连接。支持到代理服务器的 TLS。

## 通用模式

### 用户认证

三种 inbound 类型都使用相同的认证机制：

```go
authenticator := auth.NewAuthenticator(options.Users)
```

用户是包含 `Username` 和 `Password` 字段的 `auth.User` struct。认证器被传递给协议处理器。

### 用户 Metadata

认证之后，用户名从 context 中提取并存储在 metadata 中：

```go
user, loaded := auth.UserFromContext[string](ctx)
if loaded {
    metadata.User = user
}
```

### TCP 注入

SOCKS 和 Mixed inbound 都实现了 `adapter.TCPInjectableInbound`，允许其他组件向它们注入 TCP 连接（被透明代理机制使用）。

## 配置示例

### SOCKS Inbound

```json
{
  "type": "socks",
  "tag": "socks-in",
  "listen": "127.0.0.1",
  "listen_port": 1080,
  "users": [
    { "username": "user1", "password": "pass1" }
  ]
}
```

### HTTP Inbound（带 TLS）

```json
{
  "type": "http",
  "tag": "http-in",
  "listen": "127.0.0.1",
  "listen_port": 8080,
  "users": [
    { "username": "user1", "password": "pass1" }
  ],
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  },
  "set_system_proxy": true
}
```

### Mixed Inbound

```json
{
  "type": "mixed",
  "tag": "mixed-in",
  "listen": "127.0.0.1",
  "listen_port": 2080,
  "users": [
    { "username": "user1", "password": "pass1" }
  ],
  "set_system_proxy": true
}
```
