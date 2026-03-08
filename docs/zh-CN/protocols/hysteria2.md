# Hysteria2 协议

Hysteria2 是一种基于 QUIC 的代理协议，具有通过 Brutal 拥塞控制算法进行带宽协商、Salamander 混淆和 HTTP/3 伪装等特性。sing-box 将协议实现委托给 `sing-quic/hysteria2`。

**源码**: `protocol/hysteria2/inbound.go`, `protocol/hysteria2/outbound.go`, `sing-quic/hysteria2`

## 架构概览

inbound 和 outbound 都是 `sing-quic/hysteria2` 库的轻量级包装：

```go
// Inbound
type Inbound struct {
    inbound.Adapter
    router       adapter.Router
    logger       log.ContextLogger
    listener     *listener.Listener
    tlsConfig    tls.ServerConfig
    service      *hysteria2.Service[int]
    userNameList []string
}

// Outbound
type Outbound struct {
    outbound.Adapter
    logger logger.ContextLogger
    client *hysteria2.Client
}
```

## TLS 要求

Hysteria2 在两端都无条件要求 TLS：

```go
if options.TLS == nil || !options.TLS.Enabled {
    return nil, C.ErrTLSRequired
}
```

## Salamander 混淆

Salamander 是唯一支持的混淆类型。它在 QUIC 包外层包裹一层混淆，防止深度包检测识别其为 QUIC：

```go
var salamanderPassword string
if options.Obfs != nil {
    if options.Obfs.Password == "" {
        return nil, E.New("missing obfs password")
    }
    switch options.Obfs.Type {
    case hysteria2.ObfsTypeSalamander:
        salamanderPassword = options.Obfs.Password
    default:
        return nil, E.New("unknown obfs type: ", options.Obfs.Type)
    }
}
```

当启用 Salamander 时，客户端和服务端的密码必须匹配。

## 带宽协商（Brutal CC）

Hysteria2 的核心特性是其 Brutal 拥塞控制算法，要求客户端声明其带宽。服务端也可以设置带宽限制：

```go
service, err := hysteria2.NewService[int](hysteria2.ServiceOptions{
    Context:               ctx,
    Logger:                logger,
    BrutalDebug:           options.BrutalDebug,
    SendBPS:               uint64(options.UpMbps * hysteria.MbpsToBps),
    ReceiveBPS:            uint64(options.DownMbps * hysteria.MbpsToBps),
    SalamanderPassword:    salamanderPassword,
    TLSConfig:             tlsConfig,
    IgnoreClientBandwidth: options.IgnoreClientBandwidth,
    UDPTimeout:            udpTimeout,
    Handler:               inbound,
    MasqueradeHandler:     masqueradeHandler,
})
```

关键带宽字段：

- **SendBPS / ReceiveBPS**：服务端的发送和接收带宽（比特每秒），通过 `hysteria.MbpsToBps` 从 Mbps 转换
- **IgnoreClientBandwidth**：为 true 时，服务端忽略客户端声明的带宽并使用自身设置
- **BrutalDebug**：启用拥塞控制的调试日志

outbound 类似地声明其带宽：

```go
client, err := hysteria2.NewClient(hysteria2.ClientOptions{
    SendBPS:    uint64(options.UpMbps * hysteria.MbpsToBps),
    ReceiveBPS: uint64(options.DownMbps * hysteria.MbpsToBps),
    // ...
})
```

## 伪装

当收到非 Hysteria2 流量（如 Web 浏览器）时，inbound 可以提供伪装响应。支持三种伪装类型：

### 文件服务器
```go
case C.Hysterai2MasqueradeTypeFile:
    masqueradeHandler = http.FileServer(http.Dir(options.Masquerade.FileOptions.Directory))
```

### 反向代理
```go
case C.Hysterai2MasqueradeTypeProxy:
    masqueradeURL, _ := url.Parse(options.Masquerade.ProxyOptions.URL)
    masqueradeHandler = &httputil.ReverseProxy{
        Rewrite: func(r *httputil.ProxyRequest) {
            r.SetURL(masqueradeURL)
            if !options.Masquerade.ProxyOptions.RewriteHost {
                r.Out.Host = r.In.Host
            }
        },
    }
```

### 静态字符串
```go
case C.Hysterai2MasqueradeTypeString:
    masqueradeHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if options.Masquerade.StringOptions.StatusCode != 0 {
            w.WriteHeader(options.Masquerade.StringOptions.StatusCode)
        }
        w.Write([]byte(options.Masquerade.StringOptions.Content))
    })
```

## 端口跳跃

outbound 支持端口跳跃——连接到多个服务器端口以规避基于端口的限速：

```go
client, err := hysteria2.NewClient(hysteria2.ClientOptions{
    ServerAddress: options.ServerOptions.Build(),
    ServerPorts:   options.ServerPorts,         // 端口范围列表
    HopInterval:   time.Duration(options.HopInterval),  // 切换端口的频率
    // ...
})
```

## 监听器模型

与基于 TCP 的协议不同，Hysteria2 监听 UDP（QUIC）。inbound 通过监听 UDP 包并将它们传递给 QUIC 服务来启动：

```go
func (h *Inbound) Start(stage adapter.StartStage) error {
    if stage != adapter.StartStateStart {
        return nil
    }
    h.tlsConfig.Start()
    packetConn, err := h.listener.ListenUDP()
    if err != nil {
        return err
    }
    return h.service.Start(packetConn)
}
```

## 用户管理

用户通过整数索引标识，配有一个并行的名称列表用于日志记录：

```go
userList := make([]int, 0, len(options.Users))
userNameList := make([]string, 0, len(options.Users))
userPasswordList := make([]string, 0, len(options.Users))
for index, user := range options.Users {
    userList = append(userList, index)
    userNameList = append(userNameList, user.Name)
    userPasswordList = append(userPasswordList, user.Password)
}
service.UpdateUsers(userList, userPasswordList)
```

认证使用存储在 context 中的用户索引：

```go
userID, _ := auth.UserFromContext[int](ctx)
if userName := h.userNameList[userID]; userName != "" {
    metadata.User = userName
}
```

## 连接处理

TCP 和 UDP 连接都遵循标准的 sing-box 模式：

```go
func (h *Inbound) NewConnectionEx(ctx, conn, source, destination, onClose) {
    // 设置 metadata 字段
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}

func (h *Inbound) NewPacketConnectionEx(ctx, conn, source, destination, onClose) {
    // 设置 metadata 字段
    h.router.RoutePacketConnectionEx(ctx, conn, metadata, onClose)
}
```

## Outbound 连接

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    switch N.NetworkName(network) {
    case N.NetworkTCP:
        return h.client.DialConn(ctx, destination)
    case N.NetworkUDP:
        conn, err := h.ListenPacket(ctx, destination)
        return bufio.NewBindPacketConn(conn, destination), nil
    }
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    return h.client.ListenPacket(ctx)
}
```

## 网络接口更新

outbound 实现了 `adapter.InterfaceUpdateListener` 以在网络变化时关闭 QUIC 连接：

```go
func (h *Outbound) InterfaceUpdated() {
    h.client.CloseWithError(E.New("network changed"))
}
```

## 配置示例

### Inbound

```json
{
  "type": "hysteria2",
  "tag": "hy2-in",
  "listen": "::",
  "listen_port": 443,
  "up_mbps": 100,
  "down_mbps": 100,
  "obfs": {
    "type": "salamander",
    "password": "obfs-password"
  },
  "users": [
    { "name": "user1", "password": "user-password" }
  ],
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  },
  "masquerade": {
    "type": "proxy",
    "proxy": {
      "url": "https://www.example.com",
      "rewrite_host": true
    }
  }
}
```

### Outbound

```json
{
  "type": "hysteria2",
  "tag": "hy2-out",
  "server": "example.com",
  "server_port": 443,
  "up_mbps": 50,
  "down_mbps": 100,
  "password": "user-password",
  "obfs": {
    "type": "salamander",
    "password": "obfs-password"
  },
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```

### 使用端口跳跃

```json
{
  "type": "hysteria2",
  "tag": "hy2-hop",
  "server": "example.com",
  "server_ports": "443,8443-8500",
  "hop_interval": "30s",
  "password": "user-password",
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```
