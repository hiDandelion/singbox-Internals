# Транспорт WebSocket

Исходный код: `transport/v2raywebsocket/client.go`, `transport/v2raywebsocket/server.go`, `transport/v2raywebsocket/conn.go`, `transport/v2raywebsocket/writer.go`

## Обзор

Транспорт WebSocket реализует V2Ray-совместимое туннелирование через WebSocket с использованием `github.com/sagernet/ws` (форк `gobwas/ws`). Поддерживается передача ранних данных (early data) для установки соединения с 0-RTT -- как через кодирование в URL-пути, так и через пользовательский HTTP-заголовок.

## Клиент

### Создание

```go
func NewClient(ctx context.Context, dialer N.Dialer, serverAddr M.Socksaddr,
    options option.V2RayWebsocketOptions, tlsConfig tls.Config) (adapter.V2RayClientTransport, error)
```

Ключевая логика настройки:
- Если TLS настроен, ALPN по умолчанию устанавливается в `["http/1.1"]`, а dialer оборачивается через `tls.NewDialer`
- Схема URL -- `ws` (открытый текст) или `wss` (TLS)
- Заголовок `Host` из опций переопределяет хост в URL
- User-Agent по умолчанию -- `"Go-http-client/1.1"`

### Установка соединения

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

Без ранних данных клиент выполняет немедленное обновление WebSocket через `ws.Dialer.Upgrade()`. С ранними данными возвращается ленивый `EarlyWebsocketConn`, который откладывает фактическое соединение до первой записи.

### Обновление до WebSocket

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

Заголовок `Sec-WebSocket-Protocol` извлекается в поле `Protocols` для корректного согласования подпротокола WebSocket. На время рукопожатия устанавливается дедлайн `TCPTimeout`, который затем сбрасывается.

## Ранние данные

Ранние данные позволяют встроить первую полезную нагрузку в рукопожатие WebSocket, обеспечивая 0-RTT:

### Два режима

1. **Режим URL-пути** (`earlyDataHeaderName == ""`): Ранние данные в кодировке base64 добавляются к URL-пути
2. **Режим пользовательского заголовка** (`earlyDataHeaderName != ""`): Ранние данные в кодировке base64 помещаются в указанный HTTP-заголовок (обычно `Sec-WebSocket-Protocol`)

### EarlyWebsocketConn

Эта структура использует ленивую инициализацию с атомарным указателем и каналом для синхронизации:

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

**Запись** (инициирует соединение):
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

**Чтение** (блокируется до существования соединения):
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

Метод `writeRequest` разделяет данные по границе `maxEarlyData`: данные в пределах лимита помещаются в рукопожатие, излишек записывается как обычный кадр WebSocket после установки соединения.

## Сервер

### Обработка запросов

Сервер валидирует входящий HTTP-запрос и извлекает ранние данные:

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

Когда `earlyDataHeaderName` пуст и `maxEarlyData > 0`, сервер принимает любой путь с префиксом настроенного пути и рассматривает суффикс как ранние данные в кодировке base64.

## WebsocketConn

Оборачивает необработанный `net.Conn` для чтения/записи кадров WebSocket:

### Чтение

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

Обрабатываются только бинарные кадры; текстовые кадры молча отбрасываются. Управляющие кадры (ping, pong, close) обрабатываются встроенным образом через обратный вызов `controlHandler`.

### Закрытие

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

Кадры закрытия на стороне клиента маскируются в соответствии с RFC WebSocket.

## Оптимизированный Writer

Структура `Writer` обеспечивает запись кадров без копирования (zero-copy) с использованием резервирования буфера:

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

Метод `FrontHeadroom()` возвращает 14 байт (максимальный заголовок WebSocket: 2 базовых + 8 расширенной длины + 4 ключа маски), позволяя вышестоящим аллокациям буферов резервировать место для заголовка, избегая копирования данных.

## Конфигурация

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

| Поле | Описание |
|-------|-------------|
| `path` | URL-путь для конечной точки WebSocket (автоматически добавляется префикс `/`) |
| `headers` | Дополнительные HTTP-заголовки; `Host` переопределяет хост URL |
| `max_early_data` | Максимальное количество байт для встраивания в рукопожатие (0 = отключено) |
| `early_data_header_name` | Имя заголовка для ранних данных (пустое = использовать URL-путь) |
