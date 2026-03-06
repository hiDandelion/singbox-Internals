# DNS Transports

Source: `dns/transport_registry.go`, `dns/transport_adapter.go`, `dns/transport/base.go`, `dns/transport/connector.go`, `dns/transport/udp.go`, `dns/transport/tcp.go`, `dns/transport/tls.go`, `dns/transport/https.go`

## Transport Registry

The registry uses Go generics for type-safe transport registration:

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

The generic `Options` type is erased at registration time via `any` wrappers, allowing the registry to store heterogeneous constructors while providing type-safe construction at registration.

Each transport registers itself:
```go
func RegisterUDP(registry *dns.TransportRegistry)  { dns.RegisterTransport[option.RemoteDNSServerOptions](...) }
func RegisterTCP(registry *dns.TransportRegistry)  { dns.RegisterTransport[option.RemoteDNSServerOptions](...) }
func RegisterTLS(registry *dns.TransportRegistry)  { dns.RegisterTransport[option.RemoteTLSDNSServerOptions](...) }
func RegisterHTTPS(registry *dns.TransportRegistry) { dns.RegisterTransport[option.RemoteHTTPSDNSServerOptions](...) }
```

## Base Transport

Provides a state machine and in-flight query tracking for graceful shutdown:

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

### Query Lifecycle

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

### Graceful Shutdown

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

## Generic Connector

Provides singleflight connection management with recursive dial detection:

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

### Singleflight Get

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

Recursive dial detection uses a context key to track the connector being dialed:

```go
func isRecursiveConnectorDial[T any](ctx context.Context, connector *Connector[T]) bool {
    dialConnector, loaded := ctx.Value(contextKeyConnecting{}).(*Connector[T])
    return loaded && dialConnector == connector
}
```

## UDP Transport

The most complex transport, implementing callback-based multiplexing over a single UDP connection:

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

### Query ID Management

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

### Exchange Flow

1. Get or create UDP connection via connector
2. Assign unique query ID, register callback
3. Send DNS message with assigned ID
4. Wait for callback signal, connection close, transport close, or context cancellation
5. Restore original message ID on response

### Receive Loop

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

### Truncation Fallback

If a UDP response has the `Truncated` flag, the transport automatically retries via TCP:

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

### EDNS0 UDP Size Tracking

The transport tracks the maximum UDP size from EDNS0 OPT records and resets the connection when a larger size is requested:

```go
if edns0Opt := message.IsEdns0(); edns0Opt != nil {
    udpSize := int32(edns0Opt.UDPSize())
    if t.udpSize.CompareAndSwap(current, udpSize) {
        t.connector.Reset()
    }
}
```

## TCP Transport

Simple per-query connection model:

```go
func (t *TCPTransport) Exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    conn, err := t.dialer.DialContext(ctx, N.NetworkTCP, t.serverAddr)
    defer conn.Close()
    WriteMessage(conn, 0, message)
    return ReadMessage(conn)
}
```

### DNS-over-TCP Wire Format

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

2-byte big-endian length prefix followed by the raw DNS message.

## TLS Transport (DoT)

Connection pooling via linked list:

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

After a successful exchange, the connection is returned to the pool:

```go
func (t *TLSTransport) exchange(ctx context.Context, message *mDNS.Msg, conn *tlsDNSConn) (*mDNS.Msg, error) {
    // ... write request, read response ...
    t.connections.PushBack(conn)  // Return to pool
    return response, nil
}
```

Default port: 853.

## HTTPS Transport (DoH)

Uses HTTP/2 POST with `application/dns-message` content type:

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

### Transport Reset on Timeout

If a query times out, the HTTP transport is reset to clear stale connections:

```go
if errors.Is(err, context.DeadlineExceeded) {
    t.transport.CloseIdleConnections()
    t.transport = t.transport.Clone()
    t.transportResetAt = time.Now()
}
```

Default path: `/dns-query`. Default port: 443.
