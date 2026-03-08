# نقل WebSocket

المصدر: `transport/v2raywebsocket/client.go`، `transport/v2raywebsocket/server.go`، `transport/v2raywebsocket/conn.go`، `transport/v2raywebsocket/writer.go`

## نظرة عامة

يُنفِّذ نقل WebSocket نفق WebSocket المتوافق مع V2Ray باستخدام `github.com/sagernet/ws` (نسخة معدلة من `gobwas/ws`). يدعم إرسال البيانات المبكرة لإعداد اتصال 0-RTT، إما عبر ترميز مسار URL أو ترويسة HTTP مخصصة.

## العميل

### البناء

```go
func NewClient(ctx context.Context, dialer N.Dialer, serverAddr M.Socksaddr,
    options option.V2RayWebsocketOptions, tlsConfig tls.Config) (adapter.V2RayClientTransport, error)
```

منطق الإعداد الرئيسي:
- إذا كان TLS مُعدًّا، يكون ALPN الافتراضي `["http/1.1"]` ويُغلَّف طالب الاتصال بـ `tls.NewDialer`
- مخطط URL هو `ws` (نص واضح) أو `wss` (TLS)
- ترويسة `Host` من الخيارات تتجاوز مضيف URL
- وكيل المستخدم الافتراضي هو `"Go-http-client/1.1"`

### إنشاء الاتصال

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

بدون بيانات مبكرة، يُجري العميل ترقية WebSocket فورية عبر `ws.Dialer.Upgrade()`. مع البيانات المبكرة، يُرجع `EarlyWebsocketConn` كسولًا يؤجل الاتصال الفعلي حتى أول كتابة.

### ترقية WebSocket

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

تُستخرج ترويسة `Sec-WebSocket-Protocol` إلى حقل `Protocols` للتفاوض السليم على البروتوكول الفرعي لـ WebSocket. يُعيَّن موعد نهائي `TCPTimeout` أثناء المصافحة، ثم يُمسح.

## البيانات المبكرة

تسمح البيانات المبكرة بتضمين الحمولة الأولى في مصافحة WebSocket، محققة 0-RTT:

### وضعان

1. **وضع مسار URL** (`earlyDataHeaderName == ""`): تُلحق البيانات المبكرة المرمزة بـ base64 بمسار URL
2. **وضع الترويسة المخصصة** (`earlyDataHeaderName != ""`): توضع البيانات المبكرة المرمزة بـ base64 في ترويسة HTTP المحددة (عادة `Sec-WebSocket-Protocol`)

### EarlyWebsocketConn

يستخدم هذا الهيكل التهيئة الكسولة مع مؤشر ذري وقناة للتزامن:

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

**الكتابة** (تُحفِّز الاتصال):
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

**القراءة** (تنتظر حتى يوجد الاتصال):
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

تقسم دالة `writeRequest` البيانات عند حدود `maxEarlyData`: البيانات ضمن الحد تذهب إلى المصافحة، وأي فائض يُكتب كإطار WebSocket عادي بعد الاتصال.

## الخادم

### معالجة الطلبات

يتحقق الخادم من طلب HTTP الوارد ويستخرج البيانات المبكرة:

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

عندما يكون `earlyDataHeaderName` فارغًا و `maxEarlyData > 0`، يقبل الخادم أي مسار يبدأ بالمسار المُعدّ ويعامل اللاحقة كبيانات مبكرة مرمزة بـ base64.

## WebsocketConn

يُغلِّف `net.Conn` خامًا مع قراءة/كتابة إطارات WebSocket:

### القراءة

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

تُعالَج فقط الإطارات الثنائية؛ إطارات النص تُتجاهل بصمت. إطارات التحكم (ping، pong، إغلاق) تُعالَج مباشرة عبر استدعاء `controlHandler`.

### الإغلاق

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

إطارات الإغلاق من جانب العميل تُقنَّع وفقًا لمواصفات WebSocket RFC.

## الكاتب المُحسَّن

يوفر هيكل `Writer` كتابة إطارات بدون نسخ باستخدام المساحة الاحتياطية للمخزن المؤقت:

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

تُرجع دالة `FrontHeadroom()` القيمة 14 بايت (الحد الأقصى لترويسة WebSocket: 2 أساسية + 8 طول ممتد + 4 مفتاح قناع)، مما يسمح لتخصيصات المخزن المؤقت في المنبع بحجز مساحة للترويسة، متجنبة نسخ البيانات.

## الإعدادات

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

| الحقل | الوصف |
|-------|-------------|
| `path` | مسار URL لنقطة نهاية WebSocket (يُضاف تلقائيًا `/` في البداية) |
| `headers` | ترويسات HTTP إضافية؛ `Host` تتجاوز مضيف URL |
| `max_early_data` | الحد الأقصى للبايتات المُضمَّنة في المصافحة (0 = معطل) |
| `early_data_header_name` | اسم الترويسة للبيانات المبكرة (فارغ = استخدام مسار URL) |
