# Транспорты DNS

Исходный код: `dns/transport_registry.go`, `dns/transport_adapter.go`, `dns/transport/base.go`, `dns/transport/connector.go`, `dns/transport/udp.go`, `dns/transport/tcp.go`, `dns/transport/tls.go`, `dns/transport/https.go`

## Реестр транспортов

Реестр использует обобщения (generics) Go для типобезопасной регистрации транспортов:

```go
func RegisterTransport[Options any](registry *TransportRegistry, transportType string,
    constructor TransportConstructorFunc[Options]) {
    registry.register(transportType, func() any {
        return new(Options)
    }, func(ctx context.Context, logger log.ContextLogger, tag string, rawOptions any) (adapter.DNSTransport, error) {
        var options *Options
        if rawOptions != nil {
            options = rawOptions.(*Options)
        }
        return constructor(ctx, logger, tag, common.PtrValueOrDefault(options))
    })
}
```

Обобщённый тип `Options` стирается при регистрации через обёртки `any`, позволяя реестру хранить гетерогенные конструкторы, обеспечивая при этом типобезопасное создание при регистрации.

Каждый транспорт регистрирует себя:
```go
func RegisterUDP(registry *dns.TransportRegistry)  { dns.RegisterTransport[option.RemoteDNSServerOptions](...) }
func RegisterTCP(registry *dns.TransportRegistry)  { dns.RegisterTransport[option.RemoteDNSServerOptions](...) }
func RegisterTLS(registry *dns.TransportRegistry)  { dns.RegisterTransport[option.RemoteTLSDNSServerOptions](...) }
func RegisterHTTPS(registry *dns.TransportRegistry) { dns.RegisterTransport[option.RemoteHTTPSDNSServerOptions](...) }
```

## Базовый транспорт

Предоставляет конечный автомат и отслеживание активных запросов для плавного завершения работы:

```go
type TransportState int

const (
    StateNew TransportState = iota
    StateStarted
    StateClosing
    StateClosed
)

type BaseTransport struct {
    dns.TransportAdapter
    Logger logger.ContextLogger
    mutex           sync.Mutex
    state           TransportState
    inFlight        int32
    queriesComplete chan struct{}
    closeCtx        context.Context
    closeCancel     context.CancelFunc
}
```

### Жизненный цикл запроса

```go
func (t *BaseTransport) BeginQuery() bool {
    t.mutex.Lock()
    defer t.mutex.Unlock()
    if t.state != StateStarted { return false }
    t.inFlight++
    return true
}

func (t *BaseTransport) EndQuery() {
    t.mutex.Lock()
    if t.inFlight > 0 { t.inFlight-- }
    if t.inFlight == 0 && t.queriesComplete != nil {
        close(t.queriesComplete)
    }
    t.mutex.Unlock()
}
```

### Плавное завершение работы

```go
func (t *BaseTransport) Shutdown(ctx context.Context) error {
    t.state = StateClosing
    if t.inFlight == 0 {
        t.state = StateClosed
        t.closeCancel()
        return nil
    }
    t.queriesComplete = make(chan struct{})
    t.closeCancel()
    select {
    case <-queriesComplete:  // Wait for in-flight queries
    case <-ctx.Done():       // Timeout
    }
    t.state = StateClosed
    return nil
}
```

## Обобщённый коннектор

Предоставляет управление соединениями с защитой от дублирования (singleflight) и обнаружением рекурсивного подключения:

```go
type Connector[T any] struct {
    dial      func(ctx context.Context) (T, error)
    callbacks ConnectorCallbacks[T]
    access           sync.Mutex
    connection       T
    hasConnection    bool
    connectionCancel context.CancelFunc
    connecting       chan struct{}  // Singleflight signal
    closeCtx context.Context
}
```

### Получение соединения с защитой от дублирования

```go
func (c *Connector[T]) Get(ctx context.Context) (T, error) {
    for {
        c.access.Lock()
        // Fast path: existing connection
        if c.hasConnection && !c.callbacks.IsClosed(c.connection) {
            return c.connection, nil
        }
        // Recursive dial detection
        if isRecursiveConnectorDial(ctx, c) {
            return zero, errRecursiveConnectorDial
        }
        // Singleflight: wait for in-progress dial
        if c.connecting != nil {
            <-c.connecting
            continue  // Retry after dial completes
        }
        // Initiate new dial
        c.connecting = make(chan struct{})
        c.access.Unlock()
        connection, cancel, err := c.dialWithCancellation(dialContext)
        // Store and return
    }
}
```

Обнаружение рекурсивного подключения использует ключ контекста для отслеживания коннектора, по которому устанавливается соединение:

```go
func isRecursiveConnectorDial[T any](ctx context.Context, connector *Connector[T]) bool {
    dialConnector, loaded := ctx.Value(contextKeyConnecting{}).(*Connector[T])
    return loaded && dialConnector == connector
}
```

## Транспорт UDP

Наиболее сложный транспорт, реализующий мультиплексирование на основе обратных вызовов через одно UDP-соединение:

```go
type UDPTransport struct {
    *BaseTransport
    dialer     N.Dialer
    serverAddr M.Socksaddr
    udpSize    atomic.Int32
    connector  *Connector[*Connection]
    callbackAccess sync.RWMutex
    queryId        uint16
    callbacks      map[uint16]*udpCallback
}
```

### Управление идентификаторами запросов

```go
func (t *UDPTransport) nextAvailableQueryId() (uint16, error) {
    start := t.queryId
    for {
        t.queryId++
        if _, exists := t.callbacks[t.queryId]; !exists {
            return t.queryId, nil
        }
        if t.queryId == start {
            return 0, E.New("no available query ID")
        }
    }
}
```

### Поток обмена

1. Получить или создать UDP-соединение через коннектор
2. Назначить уникальный идентификатор запроса, зарегистрировать обратный вызов
3. Отправить DNS-сообщение с назначенным идентификатором
4. Ожидать сигнала обратного вызова, закрытия соединения, закрытия транспорта или отмены контекста
5. Восстановить исходный идентификатор сообщения в ответе

### Цикл приёма

```go
func (t *UDPTransport) recvLoop(conn *Connection) {
    for {
        buffer := buf.NewSize(int(t.udpSize.Load()))
        _, err := buffer.ReadOnceFrom(conn)
        // Parse DNS message
        // Look up callback by message ID
        callback.response = &message
        close(callback.done)  // Signal waiting Exchange
    }
}
```

### Откат при усечении

Если UDP-ответ имеет флаг `Truncated`, транспорт автоматически повторяет попытку через TCP:

```go
func (t *UDPTransport) Exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    response, err := t.exchange(ctx, message)
    if response.Truncated {
        t.Logger.InfoContext(ctx, "response truncated, retrying with TCP")
        return t.exchangeTCP(ctx, message)
    }
    return response, nil
}
```

### Отслеживание размера UDP через EDNS0

Транспорт отслеживает максимальный размер UDP из записей EDNS0 OPT и сбрасывает соединение при запросе большего размера:

```go
if edns0Opt := message.IsEdns0(); edns0Opt != nil {
    udpSize := int32(edns0Opt.UDPSize())
    if t.udpSize.CompareAndSwap(current, udpSize) {
        t.connector.Reset()
    }
}
```

## Транспорт TCP

Простая модель -- одно соединение на запрос:

```go
func (t *TCPTransport) Exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    conn, err := t.dialer.DialContext(ctx, N.NetworkTCP, t.serverAddr)
    defer conn.Close()
    WriteMessage(conn, 0, message)
    return ReadMessage(conn)
}
```

### Проводной формат DNS-over-TCP

```go
func WriteMessage(writer io.Writer, messageId uint16, message *mDNS.Msg) error {
    binary.Write(buffer, binary.BigEndian, uint16(requestLen))
    // Pack DNS message into buffer
    writer.Write(buffer.Bytes())
}

func ReadMessage(reader io.Reader) (*mDNS.Msg, error) {
    var responseLen uint16
    binary.Read(reader, binary.BigEndian, &responseLen)
    // Read responseLen bytes and unpack
}
```

2-байтовый префикс длины в формате big-endian, за которым следует необработанное DNS-сообщение.

## Транспорт TLS (DoT)

Пул соединений на основе связного списка:

```go
type TLSTransport struct {
    *BaseTransport
    dialer      tls.Dialer
    serverAddr  M.Socksaddr
    connections list.List[*tlsDNSConn]
}

func (t *TLSTransport) Exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    // Try pooled connection first
    t.access.Lock()
    conn := t.connections.PopFront()
    t.access.Unlock()
    if conn != nil {
        response, err := t.exchange(ctx, message, conn)
        if err == nil { return response, nil }
        // Discard failed pooled connection
    }
    // Create new TLS connection
    tlsConn, err := t.dialer.DialTLSContext(ctx, t.serverAddr)
    return t.exchange(ctx, message, &tlsDNSConn{Conn: tlsConn})
}
```

После успешного обмена соединение возвращается в пул:

```go
func (t *TLSTransport) exchange(ctx context.Context, message *mDNS.Msg, conn *tlsDNSConn) (*mDNS.Msg, error) {
    // ... write request, read response ...
    t.connections.PushBack(conn)  // Return to pool
    return response, nil
}
```

Порт по умолчанию: 853.

## Транспорт HTTPS (DoH)

Использует HTTP/2 POST с типом содержимого `application/dns-message`:

```go
const MimeType = "application/dns-message"

func (t *HTTPSTransport) exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    exMessage := *message
    exMessage.Id = 0        // DoH strips message ID
    exMessage.Compress = true
    request, _ := http.NewRequestWithContext(ctx, http.MethodPost, t.destination.String(), bytes.NewReader(rawMessage))
    request.Header.Set("Content-Type", MimeType)
    request.Header.Set("Accept", MimeType)
    response, err := currentTransport.RoundTrip(request)
    // Parse response body as DNS message
}
```

### Сброс транспорта по таймауту

Если запрос завершается по таймауту, HTTP-транспорт сбрасывается для очистки устаревших соединений:

```go
if errors.Is(err, context.DeadlineExceeded) {
    t.transport.CloseIdleConnections()
    t.transport = t.transport.Clone()
    t.transportResetAt = time.Now()
}
```

Путь по умолчанию: `/dns-query`. Порт по умолчанию: 443.
