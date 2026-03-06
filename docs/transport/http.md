# HTTP Transport

Source: `transport/v2rayhttp/client.go`, `transport/v2rayhttp/server.go`, `transport/v2rayhttp/conn.go`, `transport/v2rayhttp/pool.go`, `transport/v2rayhttp/force_close.go`

## Overview

The HTTP transport implements V2Ray-compatible HTTP tunneling with dual-mode support:

- **HTTP/1.1** (cleartext): Uses raw TCP with connection hijacking
- **HTTP/2** (TLS): Uses `golang.org/x/net/http2` with pipe-based bidirectional streaming

The transport also supports h2c (cleartext HTTP/2) on the server side.

## Client

### Mode Selection

```go
func NewClient(ctx context.Context, dialer N.Dialer, serverAddr M.Socksaddr,
    options option.V2RayHTTPOptions, tlsConfig tls.Config) (adapter.V2RayClientTransport, error) {
    var transport http.RoundTripper
    if tlsConfig == nil {
        transport = &http.Transport{...}  // HTTP/1.1
    } else {
        transport = &http2.Transport{...}  // HTTP/2
    }
    // ...
    return &Client{http2: tlsConfig != nil, transport: transport, ...}, nil
}
```

TLS presence determines the mode: cleartext uses `http.Transport`, TLS uses `http2.Transport`. Default method is `PUT`.

### HTTP/1.1 Connection

```go
func (c *Client) dialHTTP(ctx context.Context) (net.Conn, error) {
    conn, err := c.dialer.DialContext(ctx, N.NetworkTCP, c.serverAddr)
    request := &http.Request{
        Method: c.method,
        URL:    &c.requestURL,
        Header: c.headers.Clone(),
    }
    // Host selection from host list (random if multiple)
    return NewHTTP1Conn(conn, request), nil
}
```

The `HTTPConn` wraps a raw TCP connection, lazily writing the HTTP request on first `Write` and reading the HTTP response on first `Read`:

```go
func (c *HTTPConn) Write(b []byte) (int, error) {
    if !c.requestWritten {
        err := c.writeRequest(b)  // Write HTTP request + payload
        c.requestWritten = true
        return len(b), nil
    }
    return c.Conn.Write(b)  // Subsequent writes go directly to TCP
}

func (c *HTTPConn) Read(b []byte) (n int, err error) {
    if !c.responseRead {
        response, err := http.ReadResponse(reader, c.request)
        // Validate 200 status
        c.responseRead = true
    }
    return c.Conn.Read(b)  // Subsequent reads from TCP
}
```

The HTTP request is manually serialized (not using `request.Write`) to avoid chunked encoding:

```go
func (c *HTTPConn) writeRequest(payload []byte) error {
    writer := bufio.NewBufferedWriter(c.Conn, buf.New())
    writer.Write([]byte(F.ToString(c.request.Method, " ", c.request.URL.RequestURI(), " HTTP/1.1", CRLF)))
    for key, value := range c.request.Header {
        writer.Write([]byte(F.ToString(key, ": ", strings.Join(value, ", "), CRLF)))
    }
    writer.Write([]byte(CRLF))
    writer.Write(payload)
    return writer.Fallthrough()
}
```

### HTTP/2 Connection

```go
func (c *Client) dialHTTP2(ctx context.Context) (net.Conn, error) {
    pipeInReader, pipeInWriter := io.Pipe()
    request := &http.Request{
        Method: c.method,
        Body:   pipeInReader,
        URL:    &c.requestURL,
        Header: c.headers.Clone(),
    }
    conn := NewLateHTTPConn(pipeInWriter)
    go func() {
        response, err := c.transport.RoundTrip(request)
        conn.Setup(response.Body, err)
    }()
    return conn, nil
}
```

The `HTTP2Conn` uses `io.Pipe` for the request body (write direction) and the response body for reading. Connection setup is asynchronous -- the `RoundTrip` call runs in a goroutine.

**Late setup pattern**: The `HTTP2Conn` blocks on `Read` until `Setup` is called:

```go
func (c *HTTP2Conn) Read(b []byte) (n int, err error) {
    if c.reader == nil {
        <-c.create  // Wait for Setup
        if c.err != nil { return 0, c.err }
    }
    return c.reader.Read(b)
}
```

### Host Randomization

When multiple hosts are configured, the client randomly selects one per request:

```go
switch hostLen := len(c.host); hostLen {
case 0:
    request.Host = "www.example.com"  // HTTP/2 default (V2Ray compat)
case 1:
    request.Host = c.host[0]
default:
    request.Host = c.host[rand.Intn(hostLen)]
}
```

For HTTP/2, the default host when none is configured is `www.example.com` (V2Ray compatibility).

## Server

### Dual Protocol Support

The server handles both HTTP/1.1 and HTTP/2 requests:

```go
func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
    // h2c preface detection
    if request.Method == "PRI" && len(request.Header) == 0 && request.URL.Path == "*" {
        s.h2cHandler.ServeHTTP(writer, request)
        return
    }
    // Host validation (if configured)
    // Path validation
    // Method validation (if configured)

    if h, ok := writer.(http.Hijacker); ok {
        // HTTP/1.1: hijack the connection
        writer.WriteHeader(http.StatusOK)
        writer.(http.Flusher).Flush()
        conn, reader, err := h.Hijack()
        // Handle buffered data and request body
        s.handler.NewConnectionEx(DupContext(request.Context()), conn, source, ...)
    } else {
        // HTTP/2: use response writer as bidirectional stream
        writer.WriteHeader(http.StatusOK)
        conn := NewHTTP2Wrapper(&ServerHTTPConn{NewHTTPConn(request.Body, writer), flusher})
        s.handler.NewConnectionEx(request.Context(), conn, source, ...)
        <-done
        conn.CloseWrapper()
    }
}
```

For HTTP/1.1, the connection is hijacked from the HTTP server, allowing direct TCP access. For HTTP/2, the request body serves as the read stream and the response writer as the write stream.

### TLS Configuration

```go
func (s *Server) Serve(listener net.Listener) error {
    if s.tlsConfig != nil {
        // Ensure h2 is in ALPN
        if !common.Contains(s.tlsConfig.NextProtos(), http2.NextProtoTLS) {
            s.tlsConfig.SetNextProtos(append([]string{http2.NextProtoTLS}, s.tlsConfig.NextProtos()...))
        }
        listener = aTLS.NewListener(listener, s.tlsConfig)
    }
    return s.httpServer.Serve(listener)
}
```

## HTTP2ConnWrapper (Thread-Safe Writes)

HTTP/2 streams require synchronized writes. `HTTP2ConnWrapper` provides this:

```go
type HTTP2ConnWrapper struct {
    N.ExtendedConn
    access sync.Mutex
    closed bool
}

func (w *HTTP2ConnWrapper) Write(p []byte) (n int, err error) {
    w.access.Lock()
    defer w.access.Unlock()
    if w.closed { return 0, net.ErrClosed }
    return w.ExtendedConn.Write(p)
}

func (w *HTTP2ConnWrapper) CloseWrapper() {
    w.access.Lock()
    defer w.access.Unlock()
    w.closed = true
}
```

The `CloseWrapper` method marks the connection as closed without actually closing the underlying stream. This prevents write-after-close races when the HTTP/2 handler goroutine completes.

## DupContext

HTTP handler contexts are tied to request lifetime and cancel when the handler returns. `DupContext` detaches the log ID into a new background context:

```go
func DupContext(ctx context.Context) context.Context {
    id, loaded := log.IDFromContext(ctx)
    if !loaded { return context.Background() }
    return log.ContextWithID(context.Background(), id)
}
```

## Transport Reset

The `ResetTransport` function forcefully closes idle HTTP/2 connections using unsafe pointer access:

```go
func ResetTransport(rawTransport http.RoundTripper) http.RoundTripper {
    switch transport := rawTransport.(type) {
    case *http.Transport:
        transport.CloseIdleConnections()
        return transport.Clone()
    case *http2.Transport:
        connPool := transportConnPool(transport)  // go:linkname
        p := (*clientConnPool)((*efaceWords)(unsafe.Pointer(&connPool)).data)
        p.mu.Lock()
        for _, vv := range p.conns {
            for _, cc := range vv { cc.Close() }
        }
        p.mu.Unlock()
        return transport
    }
}

//go:linkname transportConnPool golang.org/x/net/http2.(*Transport).connPool
func transportConnPool(t *http2.Transport) http2.ClientConnPool
```

This uses `go:linkname` to access the internal `connPool` method of `http2.Transport`, which is not exported. The `efaceWords` struct decodes the interface value to get the underlying `clientConnPool` pointer.

## Configuration

```json
{
  "transport": {
    "type": "http",
    "host": ["cdn1.example.com", "cdn2.example.com"],
    "path": "/video",
    "method": "PUT",
    "headers": {},
    "idle_timeout": "15s",
    "ping_timeout": "15s"
  }
}
```
