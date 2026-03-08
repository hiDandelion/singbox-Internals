# وسائل نقل DNS

المصدر: `dns/transport_registry.go`، `dns/transport_adapter.go`، `dns/transport/base.go`، `dns/transport/connector.go`، `dns/transport/udp.go`، `dns/transport/tcp.go`، `dns/transport/tls.go`، `dns/transport/https.go`

## سجل وسائل النقل

يستخدم السجل أنواع Go العامة (generics) لتسجيل وسائل النقل بشكل آمن النوع:

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

يتم محو النوع العام `Options` عند وقت التسجيل عبر أغلفة `any`، مما يسمح للسجل بتخزين مُنشئات غير متجانسة مع توفير إنشاء آمن النوع عند التسجيل.

تسجل كل وسيلة نقل نفسها:
```go
func RegisterUDP(registry *dns.TransportRegistry)  { dns.RegisterTransport[option.RemoteDNSServerOptions](...) }
func RegisterTCP(registry *dns.TransportRegistry)  { dns.RegisterTransport[option.RemoteDNSServerOptions](...) }
func RegisterTLS(registry *dns.TransportRegistry)  { dns.RegisterTransport[option.RemoteTLSDNSServerOptions](...) }
func RegisterHTTPS(registry *dns.TransportRegistry) { dns.RegisterTransport[option.RemoteHTTPSDNSServerOptions](...) }
```

## وسيلة النقل الأساسية

توفر آلة حالة وتتبع الاستعلامات قيد التنفيذ لإيقاف التشغيل بشكل سلس:

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

### دورة حياة الاستعلام

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

### إيقاف التشغيل بشكل سلس

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

## الموصل العام

يوفر إدارة اتصال من نوع singleflight مع كشف الاتصال التكراري:

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

### الحصول على اتصال من نوع Singleflight

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

يستخدم كشف الاتصال التكراري مفتاح سياق لتتبع الموصل الجاري الاتصال به:

```go
func isRecursiveConnectorDial[T any](ctx context.Context, connector *Connector[T]) bool {
    dialConnector, loaded := ctx.Value(contextKeyConnecting{}).(*Connector[T])
    return loaded && dialConnector == connector
}
```

## وسيلة نقل UDP

وسيلة النقل الأكثر تعقيداً، تنفذ تعدد إرسال قائم على الاستدعاءات الراجعة عبر اتصال UDP واحد:

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

### إدارة معرف الاستعلام

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

### تدفق Exchange

1. الحصول على اتصال UDP أو إنشاؤه عبر الموصل
2. تعيين معرف استعلام فريد وتسجيل الاستدعاء الراجع
3. إرسال رسالة DNS بالمعرف المعين
4. انتظار إشارة الاستدعاء الراجع، أو إغلاق الاتصال، أو إغلاق وسيلة النقل، أو إلغاء السياق
5. استعادة معرف الرسالة الأصلي في الاستجابة

### حلقة الاستقبال

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

### الرجوع عند الاقتطاع

إذا كانت استجابة UDP تحمل علامة `Truncated`، تعيد وسيلة النقل المحاولة تلقائياً عبر TCP:

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

### تتبع حجم UDP لـ EDNS0

تتبع وسيلة النقل الحجم الأقصى لـ UDP من سجلات EDNS0 OPT وتعيد تعيين الاتصال عند طلب حجم أكبر:

```go
if edns0Opt := message.IsEdns0(); edns0Opt != nil {
    udpSize := int32(edns0Opt.UDPSize())
    if t.udpSize.CompareAndSwap(current, udpSize) {
        t.connector.Reset()
    }
}
```

## وسيلة نقل TCP

نموذج اتصال لكل استعلام بسيط:

```go
func (t *TCPTransport) Exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    conn, err := t.dialer.DialContext(ctx, N.NetworkTCP, t.serverAddr)
    defer conn.Close()
    WriteMessage(conn, 0, message)
    return ReadMessage(conn)
}
```

### تنسيق DNS عبر TCP على مستوى السلك

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

بادئة طول من بايتين بترتيب big-endian متبوعة برسالة DNS الخام.

## وسيلة نقل TLS (DoT)

تجميع الاتصالات عبر قائمة مرتبطة:

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

بعد تبادل ناجح، يُعاد الاتصال إلى المجمع:

```go
func (t *TLSTransport) exchange(ctx context.Context, message *mDNS.Msg, conn *tlsDNSConn) (*mDNS.Msg, error) {
    // ... write request, read response ...
    t.connections.PushBack(conn)  // Return to pool
    return response, nil
}
```

المنفذ الافتراضي: 853.

## وسيلة نقل HTTPS (DoH)

تستخدم HTTP/2 POST مع نوع المحتوى `application/dns-message`:

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

### إعادة تعيين وسيلة النقل عند انتهاء المهلة

إذا انتهت مهلة الاستعلام، تتم إعادة تعيين وسيلة نقل HTTP لمسح الاتصالات القديمة:

```go
if errors.Is(err, context.DeadlineExceeded) {
    t.transport.CloseIdleConnections()
    t.transport = t.transport.Clone()
    t.transportResetAt = time.Now()
}
```

المسار الافتراضي: `/dns-query`. المنفذ الافتراضي: 443.
