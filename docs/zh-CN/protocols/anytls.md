# AnyTLS 协议

AnyTLS 是一种基于 TLS 的代理协议，具有会话多路复用、可配置的 padding 方案和空闲会话管理等特性。sing-box 集成了来自 `anytls` 项目的外部 `sing-anytls` 库。

**源码**: `protocol/anytls/inbound.go`, `protocol/anytls/outbound.go`, `sing-anytls`

## 架构概览

```go
// Inbound
type Inbound struct {
    inbound.Adapter
    tlsConfig tls.ServerConfig
    router    adapter.ConnectionRouterEx
    logger    logger.ContextLogger
    listener  *listener.Listener
    service   *anytls.Service
}

// Outbound
type Outbound struct {
    outbound.Adapter
    dialer    tls.Dialer
    server    M.Socksaddr
    tlsConfig tls.Config
    client    *anytls.Client
    uotClient *uot.Client
    logger    log.ContextLogger
}
```

## Inbound 实现

### TLS 处理

与 Hysteria2 要求 TLS 不同，AnyTLS 在 inbound 上使 TLS 可选——TLS handshake 在传递给服务之前显式处理：

```go
if options.TLS != nil && options.TLS.Enabled {
    tlsConfig, err := tls.NewServer(ctx, logger, common.PtrValueOrDefault(options.TLS))
    inbound.tlsConfig = tlsConfig
}
```

当配置了 TLS 时，每个连接在协议处理前都会进行 TLS handshake：

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    if h.tlsConfig != nil {
        tlsConn, err := tls.ServerHandshake(ctx, conn, h.tlsConfig)
        if err != nil {
            N.CloseOnHandshakeFailure(conn, onClose, err)
            return
        }
        conn = tlsConn
    }
    err := h.service.NewConnection(ctx, conn, metadata.Source, onClose)
}
```

### Padding 方案

AnyTLS 使用可配置的 padding 方案来混淆流量模式。方案定义为多行字符串：

```go
paddingScheme := padding.DefaultPaddingScheme
if len(options.PaddingScheme) > 0 {
    paddingScheme = []byte(strings.Join(options.PaddingScheme, "\n"))
}

service, _ := anytls.NewService(anytls.ServiceConfig{
    Users:         common.Map(options.Users, func(it option.AnyTLSUser) anytls.User {
        return (anytls.User)(it)
    }),
    PaddingScheme: paddingScheme,
    Handler:       (*inboundHandler)(inbound),
    Logger:        logger,
})
```

### 仅 TCP 监听器

AnyTLS 仅支持 TCP 连接：

```go
inbound.listener = listener.New(listener.Options{
    Network:           []string{N.NetworkTCP},
    ConnectionHandler: inbound,
})
```

### Inbound 处理器模式

AnyTLS 使用类型转换处理器模式（与 ShadowTLS 相同）。`Inbound` 类型处理原始连接，而 `inboundHandler` 类型别名处理解码后的连接：

```go
type inboundHandler Inbound

func (h *inboundHandler) NewConnectionEx(ctx, conn, source, destination, onClose) {
    metadata.Destination = destination.Unwrap()
    if userName, _ := auth.UserFromContext[string](ctx); userName != "" {
        metadata.User = userName
    }
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## Outbound 实现

### TLS 要求

outbound 要求 TLS：

```go
if options.TLS == nil || !options.TLS.Enabled {
    return nil, C.ErrTLSRequired
}
```

### TCP Fast Open 不兼容性

AnyTLS 明确与 TCP Fast Open 不兼容。TFO 创建延迟连接（推迟到首次写入时建立），但 AnyTLS 在 handshake 期间需要远程地址：

```go
if options.DialerOptions.TCPFastOpen {
    return nil, E.New("tcp_fast_open is not supported with anytls outbound")
}
```

### 会话池化

客户端维护一个空闲 TLS 会话池以复用连接。会话管理可配置：

```go
client, _ := anytls.NewClient(ctx, anytls.ClientConfig{
    Password:                 options.Password,
    IdleSessionCheckInterval: options.IdleSessionCheckInterval.Build(),
    IdleSessionTimeout:       options.IdleSessionTimeout.Build(),
    MinIdleSession:           options.MinIdleSession,
    DialOut:                  outbound.dialOut,
    Logger:                   logger,
})
```

关键会话参数：
- **IdleSessionCheckInterval**：检查空闲会话的频率
- **IdleSessionTimeout**：空闲会话被关闭前的等待时长
- **MinIdleSession**：池中维护的最少空闲会话数

### DialOut 函数

`DialOut` 回调为会话池创建新的 TLS 连接：

```go
func (h *Outbound) dialOut(ctx context.Context) (net.Conn, error) {
    return h.dialer.DialTLSContext(ctx, h.server)
}
```

### 通过 CreateProxy 建立 TCP 连接

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    switch N.NetworkName(network) {
    case N.NetworkTCP:
        return h.client.CreateProxy(ctx, destination)
    case N.NetworkUDP:
        return h.uotClient.DialContext(ctx, network, destination)
    }
}
```

### 通过 UoT 支持 UDP

UDP 通过 `uot` 包的 UDP-over-TCP 支持。UoT 客户端包装 AnyTLS 客户端的 `CreateProxy` 方法：

```go
outbound.uotClient = &uot.Client{
    Dialer:  (anytlsDialer)(client.CreateProxy),
    Version: uot.Version,
}
```

`anytlsDialer` 适配器将 `CreateProxy` 函数签名转换为 `N.Dialer` interface：

```go
type anytlsDialer func(ctx context.Context, destination M.Socksaddr) (net.Conn, error)

func (d anytlsDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    return d(ctx, destination)
}

func (d anytlsDialer) ListenPacket(ctx, destination) (net.PacketConn, error) {
    return nil, os.ErrInvalid
}
```

### UoT Router（Inbound）

inbound 使用 UoT 支持包装其路由器：

```go
inbound.router = uot.NewRouter(router, logger)
```

## 配置示例

### Inbound

```json
{
  "type": "anytls",
  "tag": "anytls-in",
  "listen": "::",
  "listen_port": 443,
  "users": [
    { "name": "user1", "password": "user-password" }
  ],
  "padding_scheme": [
    "0:100",
    "200:500"
  ],
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  }
}
```

### Outbound

```json
{
  "type": "anytls",
  "tag": "anytls-out",
  "server": "example.com",
  "server_port": 443,
  "password": "user-password",
  "idle_session_check_interval": "30s",
  "idle_session_timeout": "30s",
  "min_idle_session": 1,
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```
