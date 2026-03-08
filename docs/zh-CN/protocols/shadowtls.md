# ShadowTLS 协议

ShadowTLS 是一种传输层协议，通过劫持与真实服务器的 TLS handshake，将代理流量伪装为合法的 TLS 流量。它支持三个协议版本，复杂程度逐步递增。

**源码**: `protocol/shadowtls/inbound.go`, `protocol/shadowtls/outbound.go`, `sing-shadowtls`

## 协议概念

与传统的基于 TLS 的代理使用自签证书（可通过证书检查检测到）不同，ShadowTLS 与合法服务器（如 `www.microsoft.com`）执行真实的 TLS handshake，使观察者无法将 handshake 与正常的 HTTPS 流量区分开。handshake 完成后，数据通道被劫持以承载代理流量。

## 协议版本

### 版本 1

最简单的版本。客户端通过 ShadowTLS 服务器发起 TLS handshake，服务器将其转发到真实的 TLS 服务器（"handshake 服务器"）。handshake 完成后，TLS 连接被重新用于传输代理数据。

**限制**：强制使用 TLS 1.2 以确保可预测的 handshake 行为。

```go
if options.Version == 1 {
    options.TLS.MinVersion = "1.2"
    options.TLS.MaxVersion = "1.2"
}
```

### 版本 2

增加了基于密码的认证。服务器可以区分合法的 ShadowTLS 客户端和探测器。支持基于 SNI 的 handshake 服务器：

```go
if options.Version > 1 {
    handshakeForServerName = make(map[string]shadowtls.HandshakeConfig)
    for _, entry := range options.HandshakeForServerName.Entries() {
        handshakeForServerName[entry.Key] = shadowtls.HandshakeConfig{
            Server: entry.Value.ServerOptions.Build(),
            Dialer: handshakeDialer,
        }
    }
}
```

### 版本 3

最先进的版本。引入了基于 session ID 的通道绑定——客户端和服务器将认证数据嵌入 TLS session ID 中，无需额外的往返即可完成验证。

```go
case 3:
    if idConfig, loaded := tlsConfig.(tls.WithSessionIDGenerator); loaded {
        // 使用 TLS 库的 session ID 钩子
        tlsHandshakeFunc = func(ctx, conn, sessionIDGenerator) error {
            idConfig.SetSessionIDGenerator(sessionIDGenerator)
            return tls.ClientHandshake(ctx, conn, tlsConfig)
        }
    } else {
        // 回退到标准 TLS 并手动注入 session ID
        stdTLSConfig := tlsConfig.STDConfig()
        tlsHandshakeFunc = shadowtls.DefaultTLSHandshakeFunc(password, stdTLSConfig)
    }
```

## Inbound 架构

```go
type Inbound struct {
    inbound.Adapter
    router   adapter.Router
    logger   logger.ContextLogger
    listener *listener.Listener
    service  *shadowtls.Service
}
```

### 服务配置

```go
service, _ := shadowtls.NewService(shadowtls.ServiceConfig{
    Version:  options.Version,
    Password: options.Password,
    Users: common.Map(options.Users, func(it option.ShadowTLSUser) shadowtls.User {
        return (shadowtls.User)(it)
    }),
    Handshake: shadowtls.HandshakeConfig{
        Server: options.Handshake.ServerOptions.Build(),
        Dialer: handshakeDialer,
    },
    HandshakeForServerName: handshakeForServerName,  // 基于 SNI 的路由
    StrictMode:             options.StrictMode,
    WildcardSNI:            shadowtls.WildcardSNI(options.WildcardSNI),
    Handler:                (*inboundHandler)(inbound),
    Logger:                 logger,
})
```

关键字段：

- **Handshake**：默认的 handshake 目标服务器
- **HandshakeForServerName**：SNI 到 handshake 服务器的映射，用于多域名支持
- **StrictMode**：拒绝认证失败的连接（而非静默转发）
- **WildcardSNI**：接受任何 SNI 值（适用于 CDN 场景）

### 通配符 SNI

`WildcardSNI` 选项控制 SNI 的处理方式：

```go
serverIsDomain := options.Handshake.ServerIsDomain()
if options.WildcardSNI != option.ShadowTLSWildcardSNIOff {
    serverIsDomain = true  // 强制域名解析以支持通配符
}
```

### 连接流程（Inbound）

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    // ShadowTLS 服务处理整个 handshake 转发和数据提取
    err := h.service.NewConnection(ctx, conn, metadata.Source, metadata.Destination, onClose)
    N.CloseOnHandshakeFailure(conn, onClose, err)
}
```

ShadowTLS 服务提取真实数据流后，调用 inbound 处理器：

```go
type inboundHandler Inbound

func (h *inboundHandler) NewConnectionEx(ctx, conn, source, destination, onClose) {
    metadata.Inbound = h.Tag()
    metadata.InboundType = h.Type()
    metadata.Source = source
    metadata.Destination = destination
    if userName, _ := auth.UserFromContext[string](ctx); userName != "" {
        metadata.User = userName
    }
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## Outbound 架构

```go
type Outbound struct {
    outbound.Adapter
    client *shadowtls.Client
}
```

ShadowTLS outbound 仅支持 TCP，作为**传输层包装器**——通常与其他协议（如 Shadowsocks）链式使用：

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    switch network {
    case "tcp":
        return h.client.DialContext(ctx)   // 返回一个"干净"的连接
    default:
        return nil, os.ErrInvalid          // 不支持 UDP
    }
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    return nil, os.ErrInvalid              // 不支持 UDP
}
```

### TLS 要求

ShadowTLS outbound **要求**启用 TLS：

```go
if options.TLS == nil || !options.TLS.Enabled {
    return nil, C.ErrTLSRequired
}
```

### 客户端配置

```go
client, _ := shadowtls.NewClient(shadowtls.ClientConfig{
    Version:      options.Version,
    Password:     options.Password,
    Server:       options.ServerOptions.Build(),
    Dialer:       outboundDialer,
    TLSHandshake: tlsHandshakeFunc,   // 版本特定的 handshake
    Logger:       logger,
})
```

### 版本特定的 TLS Handshake

```go
var tlsHandshakeFunc shadowtls.TLSHandshakeFunc

switch options.Version {
case 1, 2:
    // 简单：直接执行 TLS handshake
    tlsHandshakeFunc = func(ctx, conn, _ TLSSessionIDGeneratorFunc) error {
        return common.Error(tls.ClientHandshake(ctx, conn, tlsConfig))
    }

case 3:
    // 复杂：注入 session ID 生成器用于通道绑定
    tlsHandshakeFunc = func(ctx, conn, sessionIDGenerator) error {
        idConfig.SetSessionIDGenerator(sessionIDGenerator)
        return common.Error(tls.ClientHandshake(ctx, conn, tlsConfig))
    }
}
```

## ShadowTLS 工作原理（详解）

```
Client                  ShadowTLS Server          Real TLS Server
  |                          |                          |
  |--- TLS ClientHello ---->|--- TLS ClientHello ----->|
  |                          |                          |
  |<-- TLS ServerHello -----|<-- TLS ServerHello ------|
  |<-- Certificate ---------|<-- Certificate ----------|
  |<-- ServerHelloDone -----|<-- ServerHelloDone ------|
  |                          |                          |
  |--- ClientKeyExchange -->|--- ClientKeyExchange --->|
  |--- ChangeCipherSpec --->|--- ChangeCipherSpec ---->|
  |--- Finished ----------->|--- Finished ------------>|
  |                          |                          |
  |<-- ChangeCipherSpec ----|<-- ChangeCipherSpec -----|
  |<-- Finished ------------|<-- Finished -------------|
  |                          |                          |
  |  [TLS handshake 完成 - 观察者看到有效证书]          |
  |                          |                          |
  |=== Proxy Data =========>|  [数据不再发送到真实      |
  |<=== Proxy Data =========|   TLS 服务器]             |
```

handshake 完成后，ShadowTLS 服务器：
1. 断开与真实 TLS 服务器的连接
2. 从客户端提取代理数据流
3. 将其转发到配置的内部处理器

## 典型使用模式

ShadowTLS 作为另一个协议的 **detour** 使用：

```json
{
  "outbounds": [
    {
      "type": "shadowsocks",
      "tag": "ss-out",
      "detour": "shadowtls-out",
      "method": "2022-blake3-aes-256-gcm",
      "password": "ss-password"
    },
    {
      "type": "shadowtls",
      "tag": "shadowtls-out",
      "server": "my-server.com",
      "server_port": 443,
      "version": 3,
      "password": "shadowtls-password",
      "tls": {
        "enabled": true,
        "server_name": "www.microsoft.com"
      }
    }
  ]
}
```

Shadowsocks 连接通过 ShadowTLS 包装器进行隧道传输，ShadowTLS 使用 `www.microsoft.com` 的真实证书执行 handshake。

## 配置示例（Inbound）

```json
{
  "type": "shadowtls",
  "tag": "shadowtls-in",
  "listen": "::",
  "listen_port": 443,
  "version": 3,
  "users": [
    { "name": "user1", "password": "user-password" }
  ],
  "handshake": {
    "server": "www.microsoft.com",
    "server_port": 443
  },
  "handshake_for_server_name": {
    "www.google.com": {
      "server": "www.google.com",
      "server_port": 443
    }
  },
  "strict_mode": true
}
```
