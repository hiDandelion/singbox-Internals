# WebSocket Transport

Source: `transport/v2raywebsocket/client.go`, `transport/v2raywebsocket/server.go`, `transport/v2raywebsocket/conn.go`, `transport/v2raywebsocket/writer.go`

## Overview

The WebSocket transport implements V2Ray-compatible WebSocket tunneling using `github.com/sagernet/ws` (a fork of `gobwas/ws`). It supports early data transmission for 0-RTT connection setup, either via URL path encoding or a custom HTTP header.

## Client

### Construction

```go
func NewClient(ctx context.Context, dialer N.Dialer, serverAddr M.Socksaddr,
    options option.V2RayWebsocketOptions, tlsConfig tls.Config) (adapter.V2RayClientTransport, error)
```

Key setup logic:
- If TLS is configured, ALPN defaults to `["http/1.1"]` and the dialer is wrapped with `tls.NewDialer`
- URL scheme is `ws` (cleartext) or `wss` (TLS)
- The `Host` header from options overrides the URL host
- Default User-Agent is `"Go-http-client/1.1"`

### Connection Establishment

```go
func (c *Client) DialContext(ctx context.Context) (net.Conn, error) {
    if c.maxEarlyData <= 0 {
        conn, err := c.dialContext(ctx, &c.requestURL, c.headers)
        // ... return WebsocketConn directly
    } else {
        return &EarlyWebsocketConn{Client: c, ctx: ctx, create: make(chan struct{})}, nil
    }
}
```

Without early data, the client performs an immediate WebSocket upgrade via `ws.Dialer.Upgrade()`. With early data, it returns a lazy `EarlyWebsocketConn` that defers the actual connection until the first write.

### WebSocket Upgrade

```go
func (c *Client) dialContext(ctx context.Context, requestURL *url.URL, headers http.Header) (*WebsocketConn, error) {
    conn, err := c.dialer.DialContext(ctx, N.NetworkTCP, c.serverAddr)
    // ...
    deadlineConn.SetDeadline(time.Now().Add(C.TCPTimeout))
    reader, _, err := ws.Dialer{Header: ws.HandshakeHeaderHTTP(headers), Protocols: protocols}.Upgrade(deadlineConn, requestURL)
    deadlineConn.SetDeadline(time.Time{})
    // If reader has buffered data, wrap conn with CachedConn
    return NewConn(conn, nil, ws.StateClientSide), nil
}
```

The `Sec-WebSocket-Protocol` header is extracted into the `Protocols` field for proper WebSocket subprotocol negotiation. A `TCPTimeout` deadline is set during the handshake, then cleared.

## Early Data

Early data allows embedding the first payload into the WebSocket handshake, achieving 0-RTT:

### Two Modes

1. **URL path mode** (`earlyDataHeaderName == ""`): The base64-encoded early data is appended to the URL path
2. **Custom header mode** (`earlyDataHeaderName != ""`): The base64-encoded early data is placed in the specified HTTP header (commonly `Sec-WebSocket-Protocol`)

### EarlyWebsocketConn

This struct uses lazy initialization with an atomic pointer and a channel for synchronization:

```go
type EarlyWebsocketConn struct {
    *Client
    ctx    context.Context
    conn   atomic.Pointer[WebsocketConn]
    access sync.Mutex
    create chan struct{}
    err    error
}
```

**Write** (triggers connection):
```go
func (c *EarlyWebsocketConn) Write(b []byte) (n int, err error) {
    conn := c.conn.Load()
    if conn != nil {
        return conn.Write(b)  // Fast path: already connected
    }
    c.access.Lock()
    defer c.access.Unlock()
    // ... double-check conn after acquiring lock
    err = c.writeRequest(b)   // Establish connection with early data
    c.err = err
    close(c.create)           // Signal readers
    // ...
}
```

**Read** (blocks until connection exists):
```go
func (c *EarlyWebsocketConn) Read(b []byte) (n int, err error) {
    conn := c.conn.Load()
    if conn == nil {
        <-c.create           // Wait for Write to establish connection
        if c.err != nil {
            return 0, c.err
        }
        conn = c.conn.Load()
    }
    return conn.Read(b)
}
```

The `writeRequest` method splits data at `maxEarlyData` boundary: data within the limit goes into the handshake, any excess is written as a normal WebSocket frame after connection.

## Server

### Request Handling

The server validates the incoming HTTP request and extracts early data:

```go
func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
    // Path validation
    // Early data extraction (URL path or custom header)
    earlyData, err = base64.RawURLEncoding.DecodeString(earlyDataStr)
    // WebSocket upgrade
    wsConn, _, _, err := ws.UpgradeHTTP(request, writer)
    conn = NewConn(wsConn, source, ws.StateServerSide)
    if len(earlyData) > 0 {
        conn = bufio.NewCachedConn(conn, buf.As(earlyData))
    }
    s.handler.NewConnectionEx(v2rayhttp.DupContext(request.Context()), conn, source, M.Socksaddr{}, nil)
}
```

When `earlyDataHeaderName` is empty and `maxEarlyData > 0`, the server accepts any path prefixed with the configured path and treats the suffix as base64-encoded early data.

## WebsocketConn

Wraps a raw `net.Conn` with WebSocket frame reading/writing:

### Read

```go
func (c *WebsocketConn) Read(b []byte) (n int, err error) {
    for {
        n, err = c.reader.Read(b)
        if n > 0 { return }
        // Get next frame
        header, err = c.reader.NextFrame()
        if header.OpCode.IsControl() {
            // Handle control frames (ping/pong/close)
            c.controlHandler(header, c.reader)
            continue
        }
        if header.OpCode&ws.OpBinary == 0 {
            c.reader.Discard()  // Skip non-binary frames
            continue
        }
    }
}
```

Only binary frames are processed; text frames are silently discarded. Control frames (ping, pong, close) are handled inline via the `controlHandler` callback.

### Close

```go
func (c *WebsocketConn) Close() error {
    c.Conn.SetWriteDeadline(time.Now().Add(C.TCPTimeout))
    frame := ws.NewCloseFrame(ws.NewCloseFrameBody(ws.StatusNormalClosure, ""))
    if c.state == ws.StateClientSide {
        frame = ws.MaskFrameInPlace(frame)
    }
    ws.WriteFrame(c.Conn, frame)
    c.Conn.Close()
    return nil
}
```

Client-side close frames are masked per the WebSocket RFC.

## Optimized Writer

The `Writer` struct provides zero-copy frame writing using buffer headroom:

```go
func (w *Writer) WriteBuffer(buffer *buf.Buffer) error {
    // Calculate payload bit length (1, 3, or 9 bytes)
    // Calculate header length (1 + payloadBitLength + optional 4 mask bytes)
    header := buffer.ExtendHeader(headerLen)
    header[0] = byte(ws.OpBinary) | 0x80  // FIN + Binary
    // Encode payload length
    if !w.isServer {
        // Client side: generate and apply mask
        maskKey := rand.Uint32()
        ws.Cipher(data, [4]byte(header[1+payloadBitLength:]), 0)
    }
    return w.writer.WriteBuffer(buffer)
}

func (w *Writer) FrontHeadroom() int {
    return 14  // Maximum header size (2 + 8 + 4)
}
```

The `FrontHeadroom()` method returns 14 bytes (maximum WebSocket header: 2 base + 8 extended length + 4 mask key), allowing upstream buffer allocations to reserve space for the header, avoiding data copies.

## Configuration

```json
{
  "transport": {
    "type": "ws",
    "path": "/tunnel",
    "headers": {
      "Host": "cdn.example.com"
    },
    "max_early_data": 2048,
    "early_data_header_name": "Sec-WebSocket-Protocol"
  }
}
```

| Field | Description |
|-------|-------------|
| `path` | URL path for WebSocket endpoint (auto-prefixed with `/`) |
| `headers` | Additional HTTP headers; `Host` overrides the URL host |
| `max_early_data` | Maximum bytes to embed in handshake (0 = disabled) |
| `early_data_header_name` | Header name for early data (empty = use URL path) |
