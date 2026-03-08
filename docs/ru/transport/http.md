# Транспорт HTTP

Исходный код: `transport/v2rayhttp/client.go`, `transport/v2rayhttp/server.go`, `transport/v2rayhttp/conn.go`, `transport/v2rayhttp/pool.go`, `transport/v2rayhttp/force_close.go`

## Обзор

Транспорт HTTP реализует V2Ray-совместимое HTTP-туннелирование с поддержкой двух режимов:

- **HTTP/1.1** (открытый текст): Использует необработанный TCP с перехватом соединения (connection hijacking)
- **HTTP/2** (TLS): Использует `golang.org/x/net/http2` с двунаправленной потоковой передачей на основе pipe

Транспорт также поддерживает h2c (HTTP/2 в открытом тексте) на стороне сервера.

## Клиент

### Выбор режима

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

Наличие TLS определяет режим: открытый текст использует `http.Transport`, TLS использует `http2.Transport`. Метод по умолчанию -- `PUT`.

### HTTP/1.1-соединение

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

`HTTPConn` оборачивает необработанное TCP-соединение, лениво записывая HTTP-запрос при первой `Write` и считывая HTTP-ответ при первой `Read`:

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

HTTP-запрос сериализуется вручную (не через `request.Write`), чтобы избежать chunked-кодирования:

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

### HTTP/2-соединение

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

`HTTP2Conn` использует `io.Pipe` для тела запроса (направление записи) и тело ответа для чтения. Установка соединения асинхронна -- вызов `RoundTrip` выполняется в горутине.

**Паттерн отложенной установки**: `HTTP2Conn` блокирует `Read` до вызова `Setup`:

```go
func (c *HTTP2Conn) Read(b []byte) (n int, err error) {
    if c.reader == nil {
        <-c.create  // Wait for Setup
        if c.err != nil { return 0, c.err }
    }
    return c.reader.Read(b)
}
```

### Рандомизация хоста

Когда настроено несколько хостов, клиент случайным образом выбирает один для каждого запроса:

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

Для HTTP/2, когда хост не настроен, по умолчанию используется `www.example.com` (совместимость с V2Ray).

## Сервер

### Поддержка двух протоколов

Сервер обрабатывает как HTTP/1.1, так и HTTP/2 запросы:

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

Для HTTP/1.1 соединение перехватывается у HTTP-сервера, позволяя прямой доступ к TCP. Для HTTP/2 тело запроса служит потоком чтения, а writer ответа -- потоком записи.

### Конфигурация TLS

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

## HTTP2ConnWrapper (потокобезопасная запись)

HTTP/2-потоки требуют синхронизированных записей. `HTTP2ConnWrapper` обеспечивает это:

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

Метод `CloseWrapper` помечает соединение как закрытое, фактически не закрывая базовый поток. Это предотвращает состояние гонки запись-после-закрытия при завершении горутины обработчика HTTP/2.

## DupContext

Контексты HTTP-обработчиков привязаны к времени жизни запроса и отменяются при возврате из обработчика. `DupContext` отсоединяет идентификатор журнала в новый фоновый контекст:

```go
func DupContext(ctx context.Context) context.Context {
    id, loaded := log.IDFromContext(ctx)
    if !loaded { return context.Background() }
    return log.ContextWithID(context.Background(), id)
}
```

## Сброс транспорта

Функция `ResetTransport` принудительно закрывает неактивные HTTP/2-соединения с использованием небезопасного доступа к указателям:

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

Здесь используется `go:linkname` для доступа к внутреннему методу `connPool` у `http2.Transport`, который не экспортируется. Структура `efaceWords` декодирует значение интерфейса для получения указателя на базовый `clientConnPool`.

## Конфигурация

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
