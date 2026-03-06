# QUIC Transport

Source: `transport/v2rayquic/client.go`, `transport/v2rayquic/server.go`, `transport/v2rayquic/stream.go`, `transport/v2rayquic/init.go`

## Overview

The QUIC transport provides stream multiplexing over a single QUIC connection. It requires the `with_quic` build tag and uses `github.com/sagernet/quic-go`. TLS is mandatory -- QUIC requires TLS 1.3.

## Registration

The QUIC transport uses the init-time registration pattern since it depends on a build-tag-gated package:

```go
//go:build with_quic

package v2rayquic

func init() {
    v2ray.RegisterQUICConstructor(NewServer, NewClient)
}
```

## Client

### Connection Caching

The client maintains a single QUIC connection, creating new streams per dial:

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

The `offer` method uses double-checked locking to reuse or establish the QUIC connection:

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

### Connection Establishment

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

The dialer creates a UDP connection, then wraps it as a `PacketConn` for the QUIC library. `qtls.Dial` is a sing-box wrapper around `quic.Dial` that adapts the TLS config interface.

### Dial

Each `DialContext` call opens a new QUIC stream on the cached connection:

```go
func (c *Client) DialContext(ctx context.Context) (net.Conn, error) {
    conn, err := c.offer()
    stream, err := conn.OpenStream()
    return &StreamWrapper{Conn: conn, Stream: stream}, nil
}
```

### QUIC Configuration

```go
quicConfig := &quic.Config{
    DisablePathMTUDiscovery: !C.IsLinux && !C.IsWindows,
}
if len(tlsConfig.NextProtos()) == 0 {
    tlsConfig.SetNextProtos([]string{http3.NextProtoH3})
}
```

Path MTU discovery is disabled on non-Linux/Windows platforms. Default ALPN is `h3` (HTTP/3 protocol identifier).

## Server

### Accept Loop

The server uses a two-level accept loop -- one for QUIC connections, one for streams within each connection:

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

Each accepted QUIC connection spawns a goroutine that accepts streams. Each stream spawns a handler goroutine.

### Network

Unlike other transports, QUIC serves on UDP:

```go
func (s *Server) Network() []string {
    return []string{N.NetworkUDP}
}

func (s *Server) Serve(listener net.Listener) error {
    return os.ErrInvalid  // TCP not supported
}
```

## StreamWrapper

Adapts a QUIC stream to `net.Conn`:

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

The wrapper provides `LocalAddr`/`RemoteAddr` from the QUIC connection (since streams do not have independent addresses) and wraps QUIC errors via `qtls.WrapError`. Close cancels the read side and closes the write side.

## Configuration

```json
{
  "transport": {
    "type": "quic"
  }
}
```

QUIC transport has no additional options beyond the type. TLS is always required and must be configured separately on the inbound/outbound.
