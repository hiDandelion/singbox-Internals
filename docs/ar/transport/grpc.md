# نقل gRPC

المصدر: `transport/v2raygrpc/`، `transport/v2raygrpclite/`، `transport/v2ray/grpc.go`، `transport/v2ray/grpc_lite.go`

## نظرة عامة

يوفر sing-box تنفيذين لـ gRPC:

1. **gRPC كامل** (`v2raygrpc`): يستخدم `google.golang.org/grpc`، يتطلب علامة البناء `with_grpc`
2. **gRPC خفيف** (`v2raygrpclite`): تنفيذ HTTP/2 خام باستخدام `golang.org/x/net/http2`، متاح دائمًا

كلاهما يُنفِّذ بروتوكول V2Ray "Gun" -- خدمة gRPC ثنائية الاتجاه تنقل بيانات TCP عشوائية عبر نفق.

## تنفيذ gRPC الكامل

### العميل

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

**التخزين المؤقت للاتصال** يستخدم مؤشرًا ذريًا + قفلًا متبادلًا (قفل مزدوج التحقق):

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

**تكامل TLS**: يستخدم محول `TLSTransportCredentials` مخصصًا يربط واجهة إعدادات TLS الخاصة بـ sing-box مع `credentials.TransportCredentials` الخاص بـ gRPC. بدون TLS، يستخدم `insecure.NewCredentials()`.

**خيارات الاتصال** تتضمن:
- معاملات البقاء على قيد الحياة (`IdleTimeout`، `PingTimeout`، `PermitWithoutStream`)
- إعدادات التراجع (أساس 500 مللي ثانية، مُضاعف 1.5، حد أقصى 19 ثانية)
- طالب اتصال مخصص يربط `N.Dialer` بـ `net.Conn`

### اسم الخدمة المخصص

يستخدم بروتوكول Gun اسم خدمة مخصصًا لمسار دالة gRPC:

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

يصبح مسار الدالة `/<serviceName>/Tun`. اسم الخدمة الافتراضي هو `GunService`.

### الخادم

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

يُكيِّف تدفق gRPC ثنائي الاتجاه ليكون `net.Conn`:

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

تحتوي رسالة Protobuf `Hunk` على حقل `Data` واحد. عندما يكون مخزن القراءة أصغر من القطعة المُستقبَلة، تُخزَّن البيانات الزائدة مؤقتًا للقراءات التالية.

## تنفيذ gRPC الخفيف

### صيغة السلك (بروتوكول Gun)

يبني التنفيذ الخفيف صيغة سلك Gun يدويًا فوق HTTP/2:

```
[0x00][4-byte big-endian frame length][0x0A][varint data length][data]
```

حيث:
- `0x00`: علامة ضغط gRPC (غير مضغوط دائمًا)
- طول الإطار: `1 + varint_length + data_length`
- `0x0A`: وسم حقل Protobuf (الحقل 1، نوع السلك 2 = محدد الطول)
- طول بيانات Varint: ترميز varint قياسي لـ Protobuf لطول البيانات

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

تتجاهل القراءة أول 6 بايتات (علامة الضغط + طول الإطار + وسم Protobuf)، ثم تقرأ طول بيانات varint، ثم تبث الحمولة:

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

### العميل الخفيف

يستخدم `http2.Transport` مباشرة مع `io.Pipe` للتدفق ثنائي الاتجاه:

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

ترويسات العميل الافتراضية:
```go
var defaultClientHeader = http.Header{
    "Content-Type": []string{"application/grpc"},
    "User-Agent":   []string{"grpc-go/1.48.0"},
    "TE":           []string{"trailers"},
}
```

### الخادم الخفيف

يتحقق من متطلبات gRPC المحددة:

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

يدعم الخادم كلاً من TLS (h2) و النص الواضح (h2c) لـ HTTP/2. يكتشف معالج h2c مقدمة اتصال HTTP/2 (`PRI * HTTP/2.0`).

### المساحة الاحتياطية الأمامية

يُعلن `GunConn` الخفيف عن مساحة احتياطية أمامية للكتابات بدون نسخ:

```go
func (c *GunConn) FrontHeadroom() int {
    return 6 + binary.MaxVarintLen64  // 6 + 10 = 16 bytes
}
```

## الإعدادات

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

| الحقل | الوصف |
|-------|-------------|
| `service_name` | اسم خدمة gRPC لمسار الدالة `/<name>/Tun` |
| `idle_timeout` | مهلة الخمول للبقاء على قيد الحياة |
| `ping_timeout` | مهلة ping للبقاء على قيد الحياة |
| `permit_without_stream` | السماح بنبضات البقاء على قيد الحياة بدون تدفقات نشطة (gRPC الكامل فقط) |
| `force_lite` | فرض التنفيذ الخفيف حتى مع علامة البناء `with_grpc` |
