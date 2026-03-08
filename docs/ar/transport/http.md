# نقل HTTP

المصدر: `transport/v2rayhttp/client.go`، `transport/v2rayhttp/server.go`، `transport/v2rayhttp/conn.go`، `transport/v2rayhttp/pool.go`، `transport/v2rayhttp/force_close.go`

## نظرة عامة

يُنفِّذ نقل HTTP نفق HTTP المتوافق مع V2Ray مع دعم الوضع المزدوج:

- **HTTP/1.1** (نص واضح): يستخدم TCP خامًا مع اختطاف الاتصال
- **HTTP/2** (TLS): يستخدم `golang.org/x/net/http2` مع تدفق ثنائي الاتجاه قائم على الأنابيب

يدعم النقل أيضًا h2c (HTTP/2 بنص واضح) على جانب الخادم.

## العميل

### اختيار الوضع

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

وجود TLS يُحدد الوضع: النص الواضح يستخدم `http.Transport`، و TLS يستخدم `http2.Transport`. الطريقة الافتراضية هي `PUT`.

### اتصال HTTP/1.1

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

يُغلِّف `HTTPConn` اتصال TCP خامًا، ويكتب طلب HTTP بتكاسل عند أول `Write` ويقرأ استجابة HTTP عند أول `Read`:

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

يُسلسَل طلب HTTP يدويًا (بدون استخدام `request.Write`) لتجنب الترميز المقطع:

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

### اتصال HTTP/2

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

يستخدم `HTTP2Conn` الدالة `io.Pipe` لجسم الطلب (اتجاه الكتابة) وجسم الاستجابة للقراءة. إعداد الاتصال غير متزامن -- استدعاء `RoundTrip` يعمل في goroutine.

**نمط الإعداد المتأخر**: يتوقف `HTTP2Conn` عند `Read` حتى يُستدعى `Setup`:

```go
func (c *HTTP2Conn) Read(b []byte) (n int, err error) {
    if c.reader == nil {
        <-c.create  // Wait for Setup
        if c.err != nil { return 0, c.err }
    }
    return c.reader.Read(b)
}
```

### اختيار المضيف العشوائي

عندما يكون هناك عدة مضيفين مُعدَّين، يختار العميل واحدًا عشوائيًا لكل طلب:

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

بالنسبة لـ HTTP/2، المضيف الافتراضي عندما لا يكون هناك مضيف مُعدّ هو `www.example.com` (توافق V2Ray).

## الخادم

### دعم البروتوكول المزدوج

يتعامل الخادم مع طلبات HTTP/1.1 و HTTP/2:

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

بالنسبة لـ HTTP/1.1، يُختطف الاتصال من خادم HTTP، مما يسمح بالوصول المباشر إلى TCP. بالنسبة لـ HTTP/2، يعمل جسم الطلب كتدفق القراءة وكاتب الاستجابة كتدفق الكتابة.

### إعدادات TLS

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

## HTTP2ConnWrapper (كتابات آمنة للخيوط)

تتطلب تدفقات HTTP/2 كتابات متزامنة. يوفر `HTTP2ConnWrapper` هذا:

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

تُعلِّم دالة `CloseWrapper` الاتصال كمغلق دون إغلاق التدفق الأساسي فعليًا. هذا يمنع سباقات الكتابة بعد الإغلاق عندما تكتمل goroutine معالج HTTP/2.

## DupContext

ترتبط سياقات معالج HTTP بعمر الطلب وتُلغى عندما يعود المعالج. يفصل `DupContext` معرف السجل إلى سياق خلفي جديد:

```go
func DupContext(ctx context.Context) context.Context {
    id, loaded := log.IDFromContext(ctx)
    if !loaded { return context.Background() }
    return log.ContextWithID(context.Background(), id)
}
```

## إعادة تعيين النقل

تُغلق دالة `ResetTransport` اتصالات HTTP/2 الخاملة بالقوة باستخدام وصول غير آمن للمؤشرات:

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

يستخدم هذا `go:linkname` للوصول إلى دالة `connPool` الداخلية لـ `http2.Transport`، التي ليست مُصدَّرة. يفك هيكل `efaceWords` قيمة الواجهة للحصول على مؤشر `clientConnPool` الأساسي.

## الإعدادات

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
