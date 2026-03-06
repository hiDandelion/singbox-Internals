# gRPC Transport

Source: `transport/v2raygrpc/`, `transport/v2raygrpclite/`, `transport/v2ray/grpc.go`, `transport/v2ray/grpc_lite.go`

## Overview

sing-box provides two gRPC implementations:

1. **Full gRPC** (`v2raygrpc`): Uses `google.golang.org/grpc`, requires build tag `with_grpc`
2. **Lite gRPC** (`v2raygrpclite`): Raw HTTP/2 implementation using `golang.org/x/net/http2`, always available

Both implement the V2Ray "Gun" protocol -- a bidirectional streaming gRPC service that tunnels arbitrary TCP data.

## Full gRPC Implementation

### Client

```go
type Client struct {
    ctx         context.Context
    dialer      N.Dialer
    serverAddr  string
    serviceName string
    dialOptions []grpc.DialOption
    conn        atomic.Pointer[grpc.ClientConn]
    connAccess  sync.Mutex
}
```

**Connection caching** uses atomic pointer + mutex (double-checked locking):

```go
func (c *Client) connect() (*grpc.ClientConn, error) {
    conn := c.conn.Load()
    if conn != nil && conn.GetState() != connectivity.Shutdown {
        return conn, nil
    }
    c.connAccess.Lock()
    defer c.connAccess.Unlock()
    conn = c.conn.Load()  // Re-check after lock
    if conn != nil && conn.GetState() != connectivity.Shutdown {
        return conn, nil
    }
    conn, err := grpc.DialContext(c.ctx, c.serverAddr, c.dialOptions...)
    c.conn.Store(conn)
    return conn, nil
}
```

**TLS integration**: Uses a custom `TLSTransportCredentials` adapter that bridges sing-box's TLS config interface to gRPC's `credentials.TransportCredentials`. Without TLS, uses `insecure.NewCredentials()`.

**Dial options** include:
- Keepalive parameters (`IdleTimeout`, `PingTimeout`, `PermitWithoutStream`)
- Backoff config (500ms base, 1.5x multiplier, 19s max)
- Custom dialer bridging `N.Dialer` to `net.Conn`

### Custom Service Name

The Gun protocol uses a custom service name for the gRPC method path:

```go
func ServerDesc(name string) grpc.ServiceDesc {
    return grpc.ServiceDesc{
        ServiceName: name,
        Streams: []grpc.StreamDesc{{
            StreamName:    "Tun",
            Handler:       _GunService_Tun_Handler,
            ServerStreams: true,
            ClientStreams: true,
        }},
        Metadata: "gun.proto",
    }
}

func (c *gunServiceClient) TunCustomName(ctx context.Context, name string, opts ...grpc.CallOption) (GunService_TunClient, error) {
    stream, err := c.cc.NewStream(ctx, &ServerDesc(name).Streams[0], "/"+name+"/Tun", opts...)
    // ...
}
```

The method path becomes `/<serviceName>/Tun`. Default service name is `GunService`.

### Server

```go
func (s *Server) Tun(server GunService_TunServer) error {
    conn := NewGRPCConn(server, nil)
    var source M.Socksaddr
    // Extract source from gRPC peer info
    if remotePeer, loaded := peer.FromContext(server.Context()); loaded {
        source = M.SocksaddrFromNet(remotePeer.Addr)
    }
    // Override with X-Forwarded-For if present (CDN support)
    if grpcMetadata, loaded := gM.FromIncomingContext(server.Context()); loaded {
        forwardFrom := strings.Join(grpcMetadata.Get("X-Forwarded-For"), ",")
        // Parse last valid address from comma-separated list
    }
    done := make(chan struct{})
    go s.handler.NewConnectionEx(log.ContextWithNewID(s.ctx), conn, source, M.Socksaddr{},
        N.OnceClose(func(it error) { close(done) }))
    <-done  // Block until connection handler completes
    return nil
}
```

### GRPCConn

Adapts a gRPC bidirectional stream to `net.Conn`:

```go
type GRPCConn struct {
    GunService          // Send/Recv interface
    cache     []byte    // Buffered data from oversized Recv
    cancel    context.CancelCauseFunc
    closeOnce sync.Once
}

func (c *GRPCConn) Read(b []byte) (n int, err error) {
    if len(c.cache) > 0 {
        n = copy(b, c.cache)
        c.cache = c.cache[n:]
        return
    }
    hunk, err := c.Recv()
    n = copy(b, hunk.Data)
    if n < len(hunk.Data) {
        c.cache = hunk.Data[n:]
    }
    return
}
```

The `Hunk` protobuf message contains a single `Data` field. When the read buffer is smaller than the received chunk, excess data is cached for subsequent reads.

## Lite gRPC Implementation

### Wire Format (Gun Protocol)

The lite implementation manually constructs the Gun wire format over HTTP/2:

```
[0x00][4-byte big-endian frame length][0x0A][varint data length][data]
```

Where:
- `0x00`: gRPC compressed flag (always uncompressed)
- Frame length: `1 + varint_length + data_length`
- `0x0A`: Protobuf field tag (field 1, wire type 2 = length-delimited)
- Varint data length: Standard protobuf varint encoding of data length

```go
func (c *GunConn) Write(b []byte) (n int, err error) {
    varLen := varbin.UvarintLen(uint64(len(b)))
    buffer := buf.NewSize(6 + varLen + len(b))
    header := buffer.Extend(6 + varLen)
    header[0] = 0x00
    binary.BigEndian.PutUint32(header[1:5], uint32(1+varLen+len(b)))
    header[5] = 0x0A
    binary.PutUvarint(header[6:], uint64(len(b)))
    common.Must1(buffer.Write(b))
    _, err = c.writer.Write(buffer.Bytes())
    if c.flusher != nil {
        c.flusher.Flush()
    }
    return len(b), nil
}
```

Reading discards the first 6 bytes (compressed flag + frame length + protobuf tag), reads the varint data length, then streams the payload:

```go
func (c *GunConn) read(b []byte) (n int, err error) {
    if c.readRemaining > 0 {
        // Continue reading from current frame
    }
    _, err = c.reader.Discard(6)
    dataLen, err := binary.ReadUvarint(c.reader)
    c.readRemaining = int(dataLen)
    // Read up to readRemaining bytes
}
```

### Lite Client

Uses `http2.Transport` directly with `io.Pipe` for bidirectional streaming:

```go
func (c *Client) DialContext(ctx context.Context) (net.Conn, error) {
    pipeInReader, pipeInWriter := io.Pipe()
    request := &http.Request{
        Method: http.MethodPost,
        Body:   pipeInReader,
        URL:    c.url,  // /<serviceName>/Tun
        Header: defaultClientHeader,  // Content-Type: application/grpc
    }
    conn := newLateGunConn(pipeInWriter)
    go func() {
        response, err := c.transport.RoundTrip(request)
        conn.setup(response.Body, err)
    }()
    return conn, nil
}
```

Default client headers:
```go
var defaultClientHeader = http.Header{
    "Content-Type": []string{"application/grpc"},
    "User-Agent":   []string{"grpc-go/1.48.0"},
    "TE":           []string{"trailers"},
}
```

### Lite Server

Validates gRPC-specific requirements:

```go
func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
    // Handle h2c preface
    if request.Method == "PRI" && len(request.Header) == 0 && request.URL.Path == "*" {
        s.h2cHandler.ServeHTTP(writer, request)
        return
    }
    // Validate path: /<serviceName>/Tun
    // Validate method: POST
    // Validate content-type: application/grpc
    writer.Header().Set("Content-Type", "application/grpc")
    writer.Header().Set("TE", "trailers")
    writer.WriteHeader(http.StatusOK)
    conn := v2rayhttp.NewHTTP2Wrapper(newGunConn(request.Body, writer, writer.(http.Flusher)))
    s.handler.NewConnectionEx(...)
}
```

The server supports both TLS (h2) and cleartext (h2c) HTTP/2. The h2c handler detects the HTTP/2 connection preface (`PRI * HTTP/2.0`).

### Front Headroom

The lite `GunConn` declares front headroom for zero-copy writes:

```go
func (c *GunConn) FrontHeadroom() int {
    return 6 + binary.MaxVarintLen64  // 6 + 10 = 16 bytes
}
```

## Configuration

```json
{
  "transport": {
    "type": "grpc",
    "service_name": "TunService",
    "idle_timeout": "15s",
    "ping_timeout": "15s",
    "permit_without_stream": false,
    "force_lite": false
  }
}
```

| Field | Description |
|-------|-------------|
| `service_name` | gRPC service name for method path `/<name>/Tun` |
| `idle_timeout` | Keepalive idle timeout |
| `ping_timeout` | Keepalive ping timeout |
| `permit_without_stream` | Allow keepalive pings without active streams (full gRPC only) |
| `force_lite` | Force lite implementation even with `with_grpc` build tag |
