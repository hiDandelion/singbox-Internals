# HTTP 传输

源码：`transport/v2rayhttp/client.go`、`transport/v2rayhttp/server.go`、`transport/v2rayhttp/conn.go`、`transport/v2rayhttp/pool.go`、`transport/v2rayhttp/force_close.go`

## 概述

HTTP 传输实现了兼容 V2Ray 的 HTTP 隧道，支持双模式：

- **HTTP/1.1**（明文）：使用原始 TCP 加连接劫持
- **HTTP/2**（TLS）：使用 `golang.org/x/net/http2` 加基于管道的双向流

传输层在服务端还支持 h2c（明文 HTTP/2）。

## 客户端

### 模式选择

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

TLS 的存在决定模式：明文使用 `http.Transport`，TLS 使用 `http2.Transport`。默认方法为 `PUT`。

### HTTP/1.1 连接

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

`HTTPConn` 包装原始 TCP 连接，在首次 `Write` 时延迟写入 HTTP 请求，在首次 `Read` 时读取 HTTP 响应：

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

HTTP 请求被手动序列化（不使用 `request.Write`）以避免分块编码：

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

### HTTP/2 连接

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

`HTTP2Conn` 使用 `io.Pipe` 作为请求体（写入方向），使用响应体进行读取。连接建立是异步的 —— `RoundTrip` 调用在 goroutine 中运行。

**延迟建立模式**：`HTTP2Conn` 在 `Setup` 被调用前阻塞 `Read`：

```go
func (c *HTTP2Conn) Read(b []byte) (n int, err error) {
    if c.reader == nil {
        <-c.create  // Wait for Setup
        if c.err != nil { return 0, c.err }
    }
    return c.reader.Read(b)
}
```

### 主机随机化

当配置了多个主机时，客户端每次请求随机选择一个：

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

对于 HTTP/2，未配置主机时默认主机为 `www.example.com`（V2Ray 兼容性）。

## 服务端

### 双协议支持

服务端同时处理 HTTP/1.1 和 HTTP/2 请求：

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

对于 HTTP/1.1，连接从 HTTP 服务器劫持，允许直接 TCP 访问。对于 HTTP/2，请求体作为读取流，响应写入器作为写入流。

### TLS 配置

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

## HTTP2ConnWrapper（线程安全写入）

HTTP/2 流需要同步写入。`HTTP2ConnWrapper` 提供此功能：

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

`CloseWrapper` 方法将连接标记为已关闭，但不实际关闭底层流。这防止了 HTTP/2 handler goroutine 完成时的写后关闭竞态条件。

## DupContext

HTTP handler 的 context 与请求生命周期绑定，当 handler 返回时会被取消。`DupContext` 将日志 ID 分离到新的后台 context 中：

```go
func DupContext(ctx context.Context) context.Context {
    id, loaded := log.IDFromContext(ctx)
    if !loaded { return context.Background() }
    return log.ContextWithID(context.Background(), id)
}
```

## 传输重置

`ResetTransport` 函数使用 unsafe 指针访问强制关闭空闲的 HTTP/2 连接：

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

这里使用 `go:linkname` 访问 `http2.Transport` 的内部 `connPool` 方法，该方法未导出。`efaceWords` struct 解码 interface 值以获取底层 `clientConnPool` 指针。

## 配置

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
