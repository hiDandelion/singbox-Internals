# Shadowsocks 协议

Shadowsocks 是一种加密代理协议。sing-box 实现了三种 inbound 模式（单用户、多用户、中继）和一种 outbound，使用两个不同的库后端：`sing-shadowsocks` 用于 inbound，`sing-shadowsocks2` 用于 outbound。

**源码**: `protocol/shadowsocks/inbound.go`, `inbound_multi.go`, `inbound_relay.go`, `outbound.go`

## 架构概览

Shadowsocks inbound 使用工厂模式——一个 `NewInbound` 函数根据配置分发到三种实现之一：

```go
func NewInbound(ctx, router, logger, tag, options) (adapter.Inbound, error) {
    if len(options.Users) > 0 && len(options.Destinations) > 0 {
        return nil, E.New("users and destinations must not be combined")
    }
    if len(options.Users) > 0 || options.Managed {
        return newMultiInbound(...)    // 多用户模式
    } else if len(options.Destinations) > 0 {
        return newRelayInbound(...)    // 中继模式
    } else {
        return newInbound(...)         // 单用户模式
    }
}
```

## 库分离：sing-shadowsocks 与 sing-shadowsocks2

| 库 | 用途 | 加密方式 |
|---------|-------|---------|
| `sing-shadowsocks` | Inbound（服务端） | `shadowaead`（旧版 AEAD）、`shadowaead_2022`（SIP022） |
| `sing-shadowsocks2` | Outbound（客户端） | 所有方式的统一 interface |

outbound 导入 `sing-shadowsocks2`，该库提供统一的 `shadowsocks.Method` interface：

```go
import "github.com/sagernet/sing-shadowsocks2"

method, _ := shadowsocks.CreateMethod(ctx, options.Method, shadowsocks.MethodOptions{
    Password: options.Password,
})
```

## 单用户 Inbound

```go
type Inbound struct {
    inbound.Adapter
    ctx      context.Context
    router   adapter.ConnectionRouterEx
    logger   logger.ContextLogger
    listener *listener.Listener
    service  shadowsocks.Service         // 来自 sing-shadowsocks
}
```

### 加密方式选择

方法字符串决定使用哪种实现：

```go
switch {
case options.Method == shadowsocks.MethodNone:
    // 无加密（明文代理）
    service = shadowsocks.NewNoneService(udpTimeout, handler)

case common.Contains(shadowaead.List, options.Method):
    // 旧版 AEAD 加密：aes-128-gcm, aes-256-gcm, chacha20-ietf-poly1305
    service = shadowaead.NewService(method, nil, password, udpTimeout, handler)

case common.Contains(shadowaead_2022.List, options.Method):
    // Shadowsocks 2022 加密：2022-blake3-aes-128-gcm 等
    service = shadowaead_2022.NewServiceWithPassword(method, password, udpTimeout, handler, timeFunc)
}
```

### AEAD 加密方式（旧版）

`shadowaead` 包支持原始的 AEAD 方法：
- `aes-128-gcm`
- `aes-256-gcm`
- `chacha20-ietf-poly1305`

密钥推导使用 EVP_BytesToKey 函数（兼容 OpenSSL）。

### Shadowsocks 2022 (SIP022)

`shadowaead_2022` 包实现了现代 Shadowsocks 2022 协议：
- `2022-blake3-aes-128-gcm`
- `2022-blake3-aes-256-gcm`
- `2022-blake3-chacha20-poly1305`

关键特性：
- 基于 BLAKE3 的密钥推导
- 内置重放保护
- 基于时间的认证（需要 NTP 同步）

### 双栈监听器

单用户 inbound 同时监听 TCP 和 UDP：

```go
inbound.listener = listener.New(listener.Options{
    Network:                  options.Network.Build(),   // ["tcp", "udp"]
    ConnectionHandler:        inbound,                   // TCP
    PacketHandler:            inbound,                   // UDP
    ThreadUnsafePacketWriter: true,
})
```

TCP 连接通过 `NewConnectionEx` 处理：
```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    err := h.service.NewConnection(ctx, conn, adapter.UpstreamMetadata(metadata))
    N.CloseOnHandshakeFailure(conn, onClose, err)
}
```

UDP 包通过 `NewPacketEx` 处理：
```go
func (h *Inbound) NewPacketEx(buffer *buf.Buffer, source M.Socksaddr) {
    h.service.NewPacket(h.ctx, &stubPacketConn{h.listener.PacketWriter()}, buffer, M.Metadata{Source: source})
}
```

## 多用户 Inbound

```go
type MultiInbound struct {
    inbound.Adapter
    ctx      context.Context
    router   adapter.ConnectionRouterEx
    logger   logger.ContextLogger
    listener *listener.Listener
    service  shadowsocks.MultiService[int]   // 多用户服务
    users    []option.ShadowsocksUser
    tracker  adapter.SSMTracker              // 可选的流量跟踪
}
```

### 多用户服务创建

```go
if common.Contains(shadowaead_2022.List, options.Method) {
    // SIP022 多用户：服务器密码 + 每用户密码（iPSK）
    service = shadowaead_2022.NewMultiServiceWithPassword[int](
        method, options.Password, udpTimeout, handler, timeFunc)
} else if common.Contains(shadowaead.List, options.Method) {
    // 旧版 AEAD 多用户
    service = shadowaead.NewMultiService[int](method, udpTimeout, handler)
}
```

对于 SIP022，多用户模式使用 **identity PSK (iPSK)**：服务器有一个主密码，每个用户有一个子密码来推导唯一的身份密钥。

### 用户管理

用户可以动态更新：

```go
func (h *MultiInbound) UpdateUsers(users []string, uPSKs []string) error {
    err := h.service.UpdateUsersWithPasswords(indices, uPSKs)
    h.users = /* 重建用户列表 */
    return err
}
```

### 托管服务器支持

`MultiInbound` 实现了 `adapter.ManagedSSMServer` 以集成 Shadowsocks 服务器管理：

```go
var _ adapter.ManagedSSMServer = (*MultiInbound)(nil)

func (h *MultiInbound) SetTracker(tracker adapter.SSMTracker) {
    h.tracker = tracker
}
```

当设置了跟踪器时，连接和数据包会被包装以进行流量统计：

```go
if h.tracker != nil {
    conn = h.tracker.TrackConnection(conn, metadata)
}
```

## 中继 Inbound

中继模式专用于 Shadowsocks 2022，作为中间中继服务器：

```go
type RelayInbound struct {
    inbound.Adapter
    service      *shadowaead_2022.RelayService[int]
    destinations []option.ShadowsocksDestination
}
```

每个目标地址有自己的密码和目标地址：

```go
service = shadowaead_2022.NewRelayServiceWithPassword[int](
    method, password, udpTimeout, handler)
service.UpdateUsersWithPasswords(indices, passwords, destinations)
```

中继接收使用服务器密钥加密的连接，解密以找到目标标识符，然后使用目标的密钥重新加密后转发。

## Outbound 实现

outbound 使用 `sing-shadowsocks2` 提供统一的加密 interface：

```go
type Outbound struct {
    outbound.Adapter
    logger          logger.ContextLogger
    dialer          N.Dialer
    method          shadowsocks.Method     // 来自 sing-shadowsocks2
    serverAddr      M.Socksaddr
    plugin          sip003.Plugin          // SIP003 插件支持
    uotClient       *uot.Client            // UDP-over-TCP
    multiplexDialer *mux.Client
}
```

### 连接建立

```go
func (h *shadowsocksDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    switch network {
    case "tcp":
        var outConn net.Conn
        if h.plugin != nil {
            outConn = h.plugin.DialContext(ctx)  // SIP003 插件
        } else {
            outConn = h.dialer.DialContext(ctx, "tcp", h.serverAddr)
        }
        return h.method.DialEarlyConn(outConn, destination)

    case "udp":
        outConn := h.dialer.DialContext(ctx, "udp", h.serverAddr)
        return bufio.NewBindPacketConn(h.method.DialPacketConn(outConn), destination)
    }
}
```

### SIP003 插件支持

Shadowsocks outbound 支持 SIP003 插件（如 simple-obfs、v2ray-plugin）：

```go
if options.Plugin != "" {
    outbound.plugin = sip003.CreatePlugin(ctx, options.Plugin, options.PluginOptions, ...)
}
```

### UDP-over-TCP

当原生 UDP 不可用时，UoT 通过 TCP Shadowsocks 连接提供 UDP 传输：

```go
uotOptions := options.UDPOverTCP
if uotOptions.Enabled {
    outbound.uotClient = &uot.Client{
        Dialer:  (*shadowsocksDialer)(outbound),
        Version: uotOptions.Version,
    }
}
```

## 重放保护

Shadowsocks 2022 协议通过基于时间的 nonce 提供内置重放保护。NTP 时间函数在服务创建时传入：

```go
shadowaead_2022.NewServiceWithPassword(method, password, udpTimeout, handler,
    ntp.TimeFuncFromContext(ctx))  // 确保时间同步的 nonce
```

## 配置示例

### 单用户

```json
{
  "type": "shadowsocks",
  "tag": "ss-in",
  "listen": "::",
  "listen_port": 8388,
  "method": "2022-blake3-aes-256-gcm",
  "password": "base64-encoded-32-byte-key"
}
```

### 多用户（SIP022 iPSK）

```json
{
  "type": "shadowsocks",
  "tag": "ss-multi",
  "listen": "::",
  "listen_port": 8388,
  "method": "2022-blake3-aes-256-gcm",
  "password": "server-main-key-base64",
  "users": [
    { "name": "user1", "password": "user1-key-base64" },
    { "name": "user2", "password": "user2-key-base64" }
  ]
}
```

### 中继

```json
{
  "type": "shadowsocks",
  "tag": "ss-relay",
  "listen": "::",
  "listen_port": 8388,
  "method": "2022-blake3-aes-256-gcm",
  "password": "relay-server-key",
  "destinations": [
    {
      "name": "dest1",
      "password": "dest1-key",
      "server": "dest1.example.com",
      "server_port": 8388
    }
  ]
}
```

### Outbound

```json
{
  "type": "shadowsocks",
  "tag": "ss-out",
  "server": "example.com",
  "server_port": 8388,
  "method": "2022-blake3-aes-256-gcm",
  "password": "base64-key",
  "udp_over_tcp": {
    "enabled": true,
    "version": 2
  },
  "multiplex": {
    "enabled": true,
    "protocol": "h2mux"
  }
}
```
