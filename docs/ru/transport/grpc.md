# Транспорт gRPC

Исходный код: `transport/v2raygrpc/`, `transport/v2raygrpclite/`, `transport/v2ray/grpc.go`, `transport/v2ray/grpc_lite.go`

## Обзор

sing-box предоставляет две реализации gRPC:

1. **Полный gRPC** (`v2raygrpc`): Использует `google.golang.org/grpc`, требует тег сборки `with_grpc`
2. **Облегченный gRPC** (`v2raygrpclite`): Реализация на основе необработанного HTTP/2 с использованием `golang.org/x/net/http2`, всегда доступна

Обе реализации поддерживают протокол V2Ray «Gun» -- двунаправленный потоковый gRPC-сервис, туннелирующий произвольные TCP-данные.

## Полная реализация gRPC

### Клиент

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

**Кэширование соединений** использует атомарный указатель + мьютекс (двойная проверка блокировки):

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

**Интеграция TLS**: Используется пользовательский адаптер `TLSTransportCredentials`, который связывает интерфейс TLS-конфигурации sing-box с `credentials.TransportCredentials` gRPC. Без TLS используется `insecure.NewCredentials()`.

**Параметры соединения** включают:
- Параметры keepalive (`IdleTimeout`, `PingTimeout`, `PermitWithoutStream`)
- Конфигурацию backoff (базовый 500 мс, множитель 1.5x, максимум 19 с)
- Пользовательский dialer, связывающий `N.Dialer` с `net.Conn`

### Пользовательское имя сервиса

Протокол Gun использует пользовательское имя сервиса для пути gRPC-метода:

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

Путь метода принимает вид `/<serviceName>/Tun`. Имя сервиса по умолчанию -- `GunService`.

### Сервер

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

Адаптирует двунаправленный gRPC-поток к `net.Conn`:

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

Protobuf-сообщение `Hunk` содержит единственное поле `Data`. Когда буфер чтения меньше полученного блока, избыточные данные кэшируются для последующих чтений.

## Облегченная реализация gRPC

### Проводной формат (протокол Gun)

Облегченная реализация вручную формирует проводной формат Gun поверх HTTP/2:

```
[0x00][4-byte big-endian frame length][0x0A][varint data length][data]
```

Где:
- `0x00`: Флаг сжатия gRPC (всегда без сжатия)
- Длина кадра: `1 + varint_length + data_length`
- `0x0A`: Тег поля Protobuf (поле 1, тип проводки 2 = ограниченная длина)
- Varint длина данных: Стандартное varint-кодирование длины данных в формате Protobuf

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

При чтении отбрасываются первые 6 байт (флаг сжатия + длина кадра + тег protobuf), считывается varint-длина данных, затем передаётся полезная нагрузка:

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

### Облегченный клиент

Использует `http2.Transport` напрямую с `io.Pipe` для двунаправленной потоковой передачи:

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

Заголовки клиента по умолчанию:
```go
var defaultClientHeader = http.Header{
    "Content-Type": []string{"application/grpc"},
    "User-Agent":   []string{"grpc-go/1.48.0"},
    "TE":           []string{"trailers"},
}
```

### Облегченный сервер

Выполняет валидацию специфических для gRPC требований:

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

Сервер поддерживает как TLS (h2), так и открытый текст (h2c) HTTP/2. Обработчик h2c обнаруживает преамбулу HTTP/2-соединения (`PRI * HTTP/2.0`).

### Резервирование буфера (Front Headroom)

Облегченный `GunConn` объявляет резервирование буфера для записи без копирования:

```go
func (c *GunConn) FrontHeadroom() int {
    return 6 + binary.MaxVarintLen64  // 6 + 10 = 16 bytes
}
```

## Конфигурация

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

| Поле | Описание |
|-------|-------------|
| `service_name` | Имя gRPC-сервиса для пути метода `/<name>/Tun` |
| `idle_timeout` | Таймаут бездействия для keepalive |
| `ping_timeout` | Таймаут пинга для keepalive |
| `permit_without_stream` | Разрешить keepalive-пинги без активных потоков (только полный gRPC) |
| `force_lite` | Принудительно использовать облегченную реализацию даже с тегом сборки `with_grpc` |
