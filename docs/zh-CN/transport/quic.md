# QUIC 传输

源码：`transport/v2rayquic/client.go`、`transport/v2rayquic/server.go`、`transport/v2rayquic/stream.go`、`transport/v2rayquic/init.go`

## 概述

QUIC 传输通过单个 QUIC 连接提供流多路复用。它需要 `with_quic` 构建标签，使用 `github.com/sagernet/quic-go`。TLS 是强制性的 —— QUIC 要求 TLS 1.3。

## 注册

QUIC 传输使用初始化时注册模式，因为它依赖于受构建标签控制的包：

```go
//go:build with_quic

package v2rayquic

func init() {
    v2ray.RegisterQUICConstructor(NewServer, NewClient)
}
```

## 客户端

### 连接缓存

客户端维护单个 QUIC 连接，每次拨号创建新的流：

```go
type Client struct {
    ctx        context.Context
    dialer     N.Dialer
    serverAddr M.Socksaddr
    tlsConfig  tls.Config
    quicConfig *quic.Config
    connAccess sync.Mutex
    conn       common.TypedValue[*quic.Conn]
    rawConn    net.Conn
}
```

`offer` 方法使用双重检查锁定来复用或建立 QUIC 连接：

```go
func (c *Client) offer() (*quic.Conn, error) {
    conn := c.conn.Load()
    if conn != nil && !common.Done(conn.Context()) {
        return conn, nil
    }
    c.connAccess.Lock()
    defer c.connAccess.Unlock()
    conn = c.conn.Load()
    if conn != nil && !common.Done(conn.Context()) {
        return conn, nil
    }
    return c.offerNew()
}
```

### 连接建立

```go
func (c *Client) offerNew() (*quic.Conn, error) {
    udpConn, err := c.dialer.DialContext(c.ctx, "udp", c.serverAddr)
    packetConn := bufio.NewUnbindPacketConn(udpConn)
    quicConn, err := qtls.Dial(c.ctx, packetConn, udpConn.RemoteAddr(), c.tlsConfig, c.quicConfig)
    c.conn.Store(quicConn)
    c.rawConn = udpConn
    return quicConn, nil
}
```

拨号器创建 UDP 连接，然后将其包装为 `PacketConn` 供 QUIC 库使用。`qtls.Dial` 是 sing-box 对 `quic.Dial` 的包装，用于适配 TLS 配置接口。

### 拨号

每次 `DialContext` 调用在缓存连接上打开一个新的 QUIC 流：

```go
func (c *Client) DialContext(ctx context.Context) (net.Conn, error) {
    conn, err := c.offer()
    stream, err := conn.OpenStream()
    return &StreamWrapper{Conn: conn, Stream: stream}, nil
}
```

### QUIC 配置

```go
quicConfig := &quic.Config{
    DisablePathMTUDiscovery: !C.IsLinux && !C.IsWindows,
}
if len(tlsConfig.NextProtos()) == 0 {
    tlsConfig.SetNextProtos([]string{http3.NextProtoH3})
}
```

路径 MTU 发现在非 Linux/Windows 平台上被禁用。默认 ALPN 为 `h3`（HTTP/3 协议标识符）。

## 服务端

### 接受循环

服务端使用两级接受循环 —— 一级用于 QUIC 连接，一级用于每个连接中的流：

```go
func (s *Server) ServePacket(listener net.PacketConn) error {
    quicListener, err := qtls.Listen(listener, s.tlsConfig, s.quicConfig)
    s.quicListener = quicListener
    go s.acceptLoop()
    return nil
}

func (s *Server) acceptLoop() {
    for {
        conn, err := s.quicListener.Accept(s.ctx)
        if err != nil { return }
        go func() {
            hErr := s.streamAcceptLoop(conn)
            if hErr != nil && !E.IsClosedOrCanceled(hErr) {
                s.logger.ErrorContext(conn.Context(), hErr)
            }
        }()
    }
}

func (s *Server) streamAcceptLoop(conn *quic.Conn) error {
    for {
        stream, err := conn.AcceptStream(s.ctx)
        if err != nil { return qtls.WrapError(err) }
        go s.handler.NewConnectionEx(conn.Context(),
            &StreamWrapper{Conn: conn, Stream: stream},
            M.SocksaddrFromNet(conn.RemoteAddr()), M.Socksaddr{}, nil)
    }
}
```

每个接受的 QUIC 连接生成一个 goroutine 来接受流。每个流生成一个 handler goroutine。

### 网络

与其他传输不同，QUIC 在 UDP 上服务：

```go
func (s *Server) Network() []string {
    return []string{N.NetworkUDP}
}

func (s *Server) Serve(listener net.Listener) error {
    return os.ErrInvalid  // TCP not supported
}
```

## StreamWrapper

将 QUIC 流适配为 `net.Conn`：

```go
type StreamWrapper struct {
    Conn *quic.Conn
    *quic.Stream
}

func (s *StreamWrapper) Read(p []byte) (n int, err error) {
    n, err = s.Stream.Read(p)
    return n, qtls.WrapError(err)
}

func (s *StreamWrapper) Write(p []byte) (n int, err error) {
    n, err = s.Stream.Write(p)
    return n, qtls.WrapError(err)
}

func (s *StreamWrapper) LocalAddr() net.Addr {
    return s.Conn.LocalAddr()
}

func (s *StreamWrapper) RemoteAddr() net.Addr {
    return s.Conn.RemoteAddr()
}

func (s *StreamWrapper) Close() error {
    s.CancelRead(0)
    s.Stream.Close()
    return nil
}
```

该包装器从 QUIC 连接提供 `LocalAddr`/`RemoteAddr`（因为流没有独立的地址），并通过 `qtls.WrapError` 包装 QUIC 错误。关闭时取消读取端并关闭写入端。

## 配置

```json
{
  "transport": {
    "type": "quic"
  }
}
```

QUIC 传输除了类型外没有额外的选项。TLS 始终是必需的，必须在入站/出站上单独配置。
