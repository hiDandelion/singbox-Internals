# TUIC 协议

TUIC 是一种基于 QUIC 的代理协议，具有 UUID 认证、可配置的拥塞控制和两种不同的 UDP 中继模式。sing-box 将协议实现委托给 `sing-quic/tuic`。

**源码**: `protocol/tuic/inbound.go`, `protocol/tuic/outbound.go`, `sing-quic/tuic`

## 架构概览

```go
// Inbound
type Inbound struct {
    inbound.Adapter
    router       adapter.ConnectionRouterEx
    logger       log.ContextLogger
    listener     *listener.Listener
    tlsConfig    tls.ServerConfig
    server       *tuic.Service[int]
    userNameList []string
}

// Outbound
type Outbound struct {
    outbound.Adapter
    logger    logger.ContextLogger
    client    *tuic.Client
    udpStream bool
}
```

## TLS 要求

与 Hysteria2 一样，TUIC 在两端都要求 TLS：

```go
if options.TLS == nil || !options.TLS.Enabled {
    return nil, C.ErrTLSRequired
}
```

## 基于 UUID 的认证

用户通过 UUID + 密码对进行认证。UUID 从字符串格式解析：

```go
var userUUIDList [][16]byte
for index, user := range options.Users {
    userUUID, err := uuid.FromString(user.UUID)
    if err != nil {
        return nil, E.Cause(err, "invalid uuid for user ", index)
    }
    userUUIDList = append(userUUIDList, userUUID)
    userPasswordList = append(userPasswordList, user.Password)
}
service.UpdateUsers(userList, userUUIDList, userPasswordList)
```

outbound 类似地使用单个 UUID + 密码：

```go
userUUID, err := uuid.FromString(options.UUID)
client, _ := tuic.NewClient(tuic.ClientOptions{
    UUID:     userUUID,
    Password: options.Password,
    // ...
})
```

## 拥塞控制

TUIC 支持可配置的拥塞控制算法：

```go
service, _ := tuic.NewService[int](tuic.ServiceOptions{
    CongestionControl: options.CongestionControl,
    // ...
})
```

`CongestionControl` 字段接受算法名称（如 "bbr"、"cubic"）。这同时适用于 inbound 和 outbound。

## 零 RTT Handshake

TUIC 支持 0-RTT QUIC handshake 以降低延迟：

```go
tuic.ServiceOptions{
    ZeroRTTHandshake: options.ZeroRTTHandshake,
    // ...
}
```

## 认证超时和心跳

```go
tuic.ServiceOptions{
    AuthTimeout: time.Duration(options.AuthTimeout),
    Heartbeat:   time.Duration(options.Heartbeat),
    // ...
}
```

- **AuthTimeout**：客户端在 QUIC handshake 后完成认证的时间限制
- **Heartbeat**：保持 QUIC 连接活跃的心跳间隔

## UDP 中继模式

TUIC 有两种 UDP 中继模式，仅在 outbound 上配置：

### Native 模式（默认）

每个 UDP 包作为单独的 QUIC 数据报发送。这是最高效的模式，但需要 QUIC 数据报支持：

```go
case "native":
    // tuicUDPStream 保持为 false
```

### QUIC Stream 模式

UDP 包通过 QUIC stream 序列化。当 QUIC 数据报不可用时使用此模式：

```go
case "quic":
    tuicUDPStream = true
```

### UDP-over-Stream 模式

第三种选项（`udp_over_stream`）使用 UoT（UDP-over-TCP）编码。与 `udp_relay_mode` 互斥：

```go
if options.UDPOverStream && options.UDPRelayMode != "" {
    return nil, E.New("udp_over_stream is conflict with udp_relay_mode")
}
```

当 `udp_over_stream` 激活时，UDP 连接通过类似 TCP 的流使用 `uot` 包进行隧道传输：

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    case N.NetworkUDP:
        if h.udpStream {
            streamConn, _ := h.client.DialConn(ctx, uot.RequestDestination(uot.Version))
            return uot.NewLazyConn(streamConn, uot.Request{
                IsConnect:   true,
                Destination: destination,
            }), nil
        }
}
```

## UoT Router（Inbound）

inbound 使用 UoT 支持包装其路由器以处理 UDP-over-TCP 连接：

```go
inbound.router = uot.NewRouter(router, logger)
```

## 监听器模型

与 Hysteria2 一样，TUIC 监听 UDP：

```go
func (h *Inbound) Start(stage adapter.StartStage) error {
    h.tlsConfig.Start()
    packetConn, _ := h.listener.ListenUDP()
    return h.server.Start(packetConn)
}
```

## 连接处理

标准的 sing-box TCP/UDP 连接路由，从 context 中提取用户信息：

```go
func (h *Inbound) NewConnectionEx(ctx, conn, source, destination, onClose) {
    userID, _ := auth.UserFromContext[int](ctx)
    if userName := h.userNameList[userID]; userName != "" {
        metadata.User = userName
    }
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## Outbound 连接

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    switch N.NetworkName(network) {
    case N.NetworkTCP:
        return h.client.DialConn(ctx, destination)
    case N.NetworkUDP:
        if h.udpStream {
            // UoT 路径
        } else {
            conn, _ := h.ListenPacket(ctx, destination)
            return bufio.NewBindPacketConn(conn, destination), nil
        }
    }
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    if h.udpStream {
        streamConn, _ := h.client.DialConn(ctx, uot.RequestDestination(uot.Version))
        return uot.NewLazyConn(streamConn, uot.Request{
            IsConnect:   false,
            Destination: destination,
        }), nil
    }
    return h.client.ListenPacket(ctx)
}
```

## 网络接口更新

与 Hysteria2 一样，TUIC 在网络变化时关闭 QUIC 连接：

```go
func (h *Outbound) InterfaceUpdated() {
    _ = h.client.CloseWithError(E.New("network changed"))
}
```

## 配置示例

### Inbound

```json
{
  "type": "tuic",
  "tag": "tuic-in",
  "listen": "::",
  "listen_port": 443,
  "users": [
    {
      "name": "user1",
      "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
      "password": "user-password"
    }
  ],
  "congestion_control": "bbr",
  "zero_rtt_handshake": true,
  "auth_timeout": "3s",
  "heartbeat": "10s",
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  }
}
```

### Outbound（Native UDP）

```json
{
  "type": "tuic",
  "tag": "tuic-out",
  "server": "example.com",
  "server_port": 443,
  "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
  "password": "user-password",
  "congestion_control": "bbr",
  "udp_relay_mode": "native",
  "zero_rtt_handshake": true,
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```

### Outbound（UDP over Stream）

```json
{
  "type": "tuic",
  "tag": "tuic-uot",
  "server": "example.com",
  "server_port": 443,
  "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
  "password": "user-password",
  "udp_over_stream": true,
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```
