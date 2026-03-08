# Trojan 协议

Trojan 是一种旨在模仿 HTTPS 流量的代理协议。它使用基于 SHA-224 哈希的密码认证方案，并支持在无法识别流量时回退到真实的 Web 服务器。

**源码**: `protocol/trojan/`, `transport/trojan/`

## 线路格式

Trojan 协议使用一种简单的、对 TLS 友好的线路格式：

```
+----------+------+---------+----------+------+----------+
| Password | CRLF | Command | Address  | CRLF | Payload  |
| (56 hex) | \r\n | (1 byte)| (variable)|\r\n | (variable)|
+----------+------+---------+----------+------+----------+
```

### 密码推导

密码被转换为 56 字节的十六进制编码 SHA-224 哈希：

```go
const KeyLength = 56

func Key(password string) [KeyLength]byte {
    var key [KeyLength]byte
    hash := sha256.New224()                    // SHA-224，非 SHA-256
    hash.Write([]byte(password))
    hex.Encode(key[:], hash.Sum(nil))          // 28 字节 -> 56 个十六进制字符
    return key
}
```

SHA-224 产生 28 字节（224 位），十六进制编码后恰好为 56 个字符。在 handshake 中按原样传输（非 base64）。

### 命令

```go
const (
    CommandTCP = 1     // TCP 连接
    CommandUDP = 3     // UDP 关联
    CommandMux = 0x7f  // Trojan-Go 多路复用
)
```

### TCP Handshake

```
Client -> Server:
  [56 bytes: hex SHA224(password)]
  [2 bytes: \r\n]
  [1 byte: 0x01 (TCP)]
  [variable: SOCKS address (type + addr + port)]
  [2 bytes: \r\n]
  [payload data...]
```

实现中使用了缓冲区合并以提高效率：

```go
func ClientHandshake(conn net.Conn, key [KeyLength]byte, destination M.Socksaddr, payload []byte) error {
    headerLen := KeyLength + M.SocksaddrSerializer.AddrPortLen(destination) + 5
    header := buf.NewSize(headerLen + len(payload))
    header.Write(key[:])           // 56 字节密码哈希
    header.Write(CRLF)            // \r\n
    header.WriteByte(CommandTCP)  // 0x01
    M.SocksaddrSerializer.WriteAddrPort(header, destination)
    header.Write(CRLF)            // \r\n
    header.Write(payload)         // 合并的首个有效载荷
    conn.Write(header.Bytes())    // 单次写入系统调用
}
```

### UDP 包格式

在初始 handshake（使用 `CommandUDP`）之后，UDP 包的帧格式为：

```
+----------+--------+------+----------+
| Address  | Length | CRLF | Payload  |
| (variable)| (2 BE) | \r\n | (Length) |
+----------+--------+------+----------+
```

```go
func WritePacket(conn net.Conn, buffer *buf.Buffer, destination M.Socksaddr) error {
    header := buf.With(buffer.ExtendHeader(...))
    M.SocksaddrSerializer.WriteAddrPort(header, destination)
    binary.Write(header, binary.BigEndian, uint16(bufferLen))
    header.Write(CRLF)
    conn.Write(buffer.Bytes())
}

func ReadPacket(conn net.Conn, buffer *buf.Buffer) (M.Socksaddr, error) {
    destination := M.SocksaddrSerializer.ReadAddrPort(conn)
    var length uint16
    binary.Read(conn, binary.BigEndian, &length)
    rw.SkipN(conn, 2)  // 跳过 CRLF
    buffer.ReadFullFrom(conn, int(length))
    return destination, nil
}
```

### UDP 初始 Handshake

第一个 UDP 包同时包含 Trojan 头部和第一个包的地址/长度：

```
[56 bytes key][CRLF][0x03 UDP][dest addr][CRLF][dest addr][length][CRLF][payload]
                                  ^handshake^    ^first packet^
```

注意目标地址出现了两次：一次在 handshake 中，一次在包帧中。

## Trojan 服务层

`transport/trojan/service.go` 实现了服务端协议处理器：

```go
type Service[K comparable] struct {
    users           map[K][56]byte       // user -> key
    keys            map[[56]byte]K       // key -> user（反向查找）
    handler         Handler              // TCP + UDP 处理器
    fallbackHandler N.TCPConnectionHandlerEx
    logger          logger.ContextLogger
}
```

### 服务端连接处理

```go
func (s *Service[K]) NewConnection(ctx, conn, source, onClose) error {
    // 1. 读取 56 字节密码 key
    var key [KeyLength]byte
    n, err := conn.Read(key[:])
    if n != KeyLength {
        return s.fallback(ctx, conn, source, key[:n], ...)
    }

    // 2. 认证
    if user, loaded := s.keys[key]; loaded {
        ctx = auth.ContextWithUser(ctx, user)
    } else {
        return s.fallback(ctx, conn, source, key[:], ...)
    }

    // 3. 跳过 CRLF，读取命令
    rw.SkipN(conn, 2)
    binary.Read(conn, binary.BigEndian, &command)

    // 4. 读取目标地址，跳过尾部 CRLF
    destination := M.SocksaddrSerializer.ReadAddrPort(conn)
    rw.SkipN(conn, 2)

    // 5. 根据命令分发
    switch command {
    case CommandTCP:
        s.handler.NewConnectionEx(ctx, conn, source, destination, onClose)
    case CommandUDP:
        s.handler.NewPacketConnectionEx(ctx, &PacketConn{Conn: conn}, ...)
    default:  // CommandMux (0x7f)
        HandleMuxConnection(ctx, conn, source, s.handler, s.logger, onClose)
    }
}
```

### 回退机制

当认证失败时，服务支持回退到真实的 Web 服务器：

```go
func (s *Service[K]) fallback(ctx, conn, source, header, err, onClose) error {
    if s.fallbackHandler == nil {
        return E.Extend(err, "fallback disabled")
    }
    // 将已读取的字节重新添加到连接中
    conn = bufio.NewCachedConn(conn, buf.As(header).ToOwned())
    s.fallbackHandler.NewConnectionEx(ctx, conn, source, M.Socksaddr{}, onClose)
    return nil
}
```

这对审查抵抗至关重要：如果探测器发送非 Trojan 数据，它会被转发到真实的 Web 服务器，使该服务与正常的 HTTPS 站点无法区分。

## Mux 支持（Trojan-Go）

mux 实现使用 `smux`（Simple Multiplexer）以兼容 Trojan-Go：

```go
func HandleMuxConnection(ctx, conn, source, handler, logger, onClose) error {
    session, _ := smux.Server(conn, smuxConfig())
    for {
        stream, _ := session.AcceptStream()
        go newMuxConnection(ctx, stream, source, handler, logger)
    }
}
```

每个 mux 流包含自己的命令字节和目标地址：

```go
func newMuxConnection0(ctx, conn, source, handler) error {
    reader := bufio.NewReader(conn)
    command, _ := reader.ReadByte()
    destination, _ := M.SocksaddrSerializer.ReadAddrPort(reader)
    switch command {
    case CommandTCP:
        handler.NewConnectionEx(ctx, conn, source, destination, nil)
    case CommandUDP:
        handler.NewPacketConnectionEx(ctx, &PacketConn{Conn: conn}, ...)
    }
}
```

smux 配置禁用了 keepalive：

```go
func smuxConfig() *smux.Config {
    config := smux.DefaultConfig()
    config.KeepAliveDisabled = true
    return config
}
```

## Inbound 实现

```go
type Inbound struct {
    inbound.Adapter
    router                   adapter.ConnectionRouterEx
    logger                   log.ContextLogger
    listener                 *listener.Listener
    service                  *trojan.Service[int]
    users                    []option.TrojanUser
    tlsConfig                tls.ServerConfig
    fallbackAddr             M.Socksaddr
    fallbackAddrTLSNextProto map[string]M.Socksaddr  // 基于 ALPN 的回退
    transport                adapter.V2RayServerTransport
}
```

### 基于 ALPN 的回退

Trojan 支持基于 ALPN 的回退目标，允许根据 TLS 协商的协议选择不同的回退目标：

```go
func (h *Inbound) fallbackConnection(ctx, conn, metadata, onClose) {
    if len(h.fallbackAddrTLSNextProto) > 0 {
        if tlsConn, loaded := common.Cast[tls.Conn](conn); loaded {
            negotiatedProtocol := tlsConn.ConnectionState().NegotiatedProtocol
            fallbackAddr = h.fallbackAddrTLSNextProto[negotiatedProtocol]
        }
    }
    if !fallbackAddr.IsValid() {
        fallbackAddr = h.fallbackAddr  // 默认回退
    }
    metadata.Destination = fallbackAddr
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### kTLS 兼容性

inbound 在满足条件时启用 kTLS（内核 TLS）：

```go
tlsConfig, _ := tls.NewServerWithOptions(tls.ServerOptions{
    KTLSCompatible: transport.Type == "" && !multiplex.Enabled,
    // kTLS 仅在以下条件下启用：无 V2Ray 传输层且未启用多路复用
})
```

## Outbound 实现

```go
type Outbound struct {
    outbound.Adapter
    key             [56]byte              // 预计算的 SHA224 key
    multiplexDialer *mux.Client
    tlsConfig       tls.Config
    tlsDialer       tls.Dialer
    transport       adapter.V2RayClientTransport
}
```

key 在构造时一次性计算：

```go
outbound.key = trojan.Key(options.Password)
```

### 连接流程

```go
func (h *trojanDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    // 1. 建立连接：transport > TLS > 原始 TCP
    var conn net.Conn
    if h.transport != nil {
        conn = h.transport.DialContext(ctx)
    } else if h.tlsDialer != nil {
        conn = h.tlsDialer.DialTLSContext(ctx, h.serverAddr)
    } else {
        conn = h.dialer.DialContext(ctx, "tcp", h.serverAddr)
    }

    // 2. 使用 Trojan 协议包装
    switch network {
    case "tcp":
        return trojan.NewClientConn(conn, h.key, destination)
    case "udp":
        return bufio.NewBindPacketConn(
            trojan.NewClientPacketConn(conn, h.key), destination)
    }
}
```

### Early Data（延迟写入）

`ClientConn` 实现了 `N.EarlyWriter`，这意味着 Trojan 头部仅在第一次 `Write()` 调用时发送，与首个有效载荷合并：

```go
func (c *ClientConn) Write(p []byte) (n int, err error) {
    if c.headerWritten {
        return c.ExtendedConn.Write(p)
    }
    err = ClientHandshake(c.ExtendedConn, c.key, c.destination, p)
    c.headerWritten = true
    n = len(p)
    return
}
```

## 配置示例

```json
{
  "type": "trojan",
  "tag": "trojan-in",
  "listen": "::",
  "listen_port": 443,
  "users": [
    { "name": "user1", "password": "my-secret-password" }
  ],
  "tls": {
    "enabled": true,
    "server_name": "example.com",
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  },
  "fallback": {
    "server": "127.0.0.1",
    "server_port": 8080
  },
  "fallback_for_alpn": {
    "h2": {
      "server": "127.0.0.1",
      "server_port": 8081
    }
  }
}
```
