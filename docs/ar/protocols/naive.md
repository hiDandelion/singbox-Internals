# بروتوكول NaiveProxy

يخفي NaiveProxy حركة مرور الوكيل كحركة مرور HTTP/2 أو HTTP/3 عادية باستخدام طريقة CONNECT. ينفذ الوارد خادماً متوافقاً مع NaiveProxy مع دعم الحشو، بينما يستخدم الصادر مكتبة Cronet (مكدس شبكة Chromium) لمحاكاة عميل Chrome حقيقي.

**المصدر**: `protocol/naive/inbound.go`، `protocol/naive/inbound_conn.go`، `protocol/naive/outbound.go`، `protocol/naive/quic/`

## بنية الوارد

```go
type Inbound struct {
    inbound.Adapter
    ctx              context.Context
    router           adapter.ConnectionRouterEx
    logger           logger.ContextLogger
    listener         *listener.Listener
    network          []string
    networkIsDefault bool
    authenticator    *auth.Authenticator
    tlsConfig        tls.ServerConfig
    httpServer       *http.Server
    h3Server         io.Closer
}
```

### نقل مزدوج: HTTP/2 + HTTP/3

يدعم NaiveProxy كلاً من HTTP/2 (TCP) وHTTP/3 (QUIC). تكون الشبكة الافتراضية TCP، مع UDP اختياري لـ HTTP/3:

```go
if common.Contains(inbound.network, N.NetworkUDP) {
    if options.TLS == nil || !options.TLS.Enabled {
        return nil, E.New("TLS is required for QUIC server")
    }
}
```

### خادم HTTP/2 (TCP)

يخدم مستمع TCP بروتوكول HTTP/2 عبر h2c (HTTP/2 بنص واضح) مع TLS اختياري:

```go
n.httpServer = &http.Server{
    Handler: h2c.NewHandler(n, &http2.Server{}),
}

go func() {
    listener := net.Listener(tcpListener)
    if n.tlsConfig != nil {
        // التأكد من وجود ALPN لـ HTTP/2
        if !common.Contains(n.tlsConfig.NextProtos(), http2.NextProtoTLS) {
            n.tlsConfig.SetNextProtos(append([]string{http2.NextProtoTLS}, n.tlsConfig.NextProtos()...))
        }
        listener = aTLS.NewListener(tcpListener, n.tlsConfig)
    }
    n.httpServer.Serve(listener)
}()
```

### خادم HTTP/3 (QUIC)

يتم تهيئة HTTP/3 عبر مؤشر دالة قابل للتكوين:

```go
var ConfigureHTTP3ListenerFunc func(ctx, logger, listener, handler, tlsConfig, options) (io.Closer, error)
```

يتم تسجيل هذا خارجياً في `protocol/naive/quic/inbound_init.go`، الذي يستخدم مكتبة `sing-quic` مع تحكم في الازدحام قابل للتكوين.

### معالجة طلب CONNECT

المنطق الأساسي للبروتوكول موجود في `ServeHTTP`:

```go
func (n *Inbound) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
    // 1. رفض الطلبات غير CONNECT
    if request.Method != "CONNECT" {
        rejectHTTP(writer, http.StatusBadRequest)
        return
    }

    // 2. طلب رأس الحشو (يميز NaiveProxy عن CONNECT العادي)
    if request.Header.Get("Padding") == "" {
        rejectHTTP(writer, http.StatusBadRequest)
        return
    }

    // 3. المصادقة عبر رأس Proxy-Authorization
    userName, password, authOk := sHttp.ParseBasicAuth(request.Header.Get("Proxy-Authorization"))
    if authOk {
        authOk = n.authenticator.Verify(userName, password)
    }
    if !authOk {
        rejectHTTP(writer, http.StatusProxyAuthRequired)
        return
    }

    // 4. إرسال الاستجابة مع حشو
    writer.Header().Set("Padding", generatePaddingHeader())
    writer.WriteHeader(http.StatusOK)
    writer.(http.Flusher).Flush()

    // 5. استخراج الوجهة من رؤوس مخصصة أو قياسية
    hostPort := request.Header.Get("-connect-authority")
    if hostPort == "" {
        hostPort = request.URL.Host
    }

    // 6. تغليف الاتصال بحشو لأول 8 إطارات
    // HTTP/1.1: اختطاف الاتصال
    // HTTP/2: استخدام request.Body + كاتب الاستجابة
}
```

### سلوك الرفض

عند الرفض، يتم إرسال RST للاتصال بدلاً من الإغلاق الرشيق، لمحاكاة سلوك خادم ويب حقيقي:

```go
func rejectHTTP(writer http.ResponseWriter, statusCode int) {
    hijacker, ok := writer.(http.Hijacker)
    if !ok {
        writer.WriteHeader(statusCode)
        return
    }
    conn, _, _ := hijacker.Hijack()
    if tcpConn, isTCP := common.Cast[*net.TCPConn](conn); isTCP {
        tcpConn.SetLinger(0)  // RST بدلاً من FIN
    }
    conn.Close()
}
```

## بروتوكول الحشو

يضيف بروتوكول الحشو حشواً عشوائياً لأول 8 عمليات قراءة/كتابة لمقاومة بصمة حركة المرور.

### الثوابت والهيكل

```go
const paddingCount = 8

type paddingConn struct {
    readPadding      int   // الإطارات المقروءة مع حشو حتى الآن
    writePadding     int   // الإطارات المكتوبة مع حشو حتى الآن
    readRemaining    int   // بايتات البيانات المتبقية في الإطار الحالي
    paddingRemaining int   // بايتات الحشو المتبقية للتخطي
}
```

### تنسيق رأس الحشو

يستخدم رأس HTTP الخاص بالحشو نصاً عشوائياً من 30-62 حرفاً من مجموعة `!#$()+<>?@[]^`{}~`:

```go
func generatePaddingHeader() string {
    paddingLen := rand.Intn(32) + 30
    padding := make([]byte, paddingLen)
    bits := rand.Uint64()
    for i := 0; i < 16; i++ {
        padding[i] = "!#$()+<>?@[]^`{}"[bits&15]
        bits >>= 4
    }
    for i := 16; i < paddingLen; i++ {
        padding[i] = '~'
    }
    return string(padding)
}
```

### تنسيق البيانات (الإطار المحشو)

يتم ترميز كل من أول 8 إطارات كالتالي:

```
+---------------+----------+------+---------+
| Data Length   | Pad Size | Data | Padding |
| (2 bytes BE) | (1 byte) | (var)| (var)   |
+---------------+----------+------+---------+
```

```go
func (p *paddingConn) writeWithPadding(writer io.Writer, data []byte) (n int, err error) {
    if p.writePadding < paddingCount {
        paddingSize := rand.Intn(256)
        buffer := buf.NewSize(3 + len(data) + paddingSize)
        header := buffer.Extend(3)
        binary.BigEndian.PutUint16(header, uint16(len(data)))
        header[2] = byte(paddingSize)
        buffer.Write(data)
        buffer.Extend(paddingSize)  // بايتات حشو عشوائية
        _, err = writer.Write(buffer.Bytes())
        p.writePadding++
        return
    }
    // بعد 8 إطارات، الكتابة مباشرة
    return writer.Write(data)
}
```

### قراءة الإطارات المحشوة

```go
func (p *paddingConn) readWithPadding(reader io.Reader, buffer []byte) (n int, err error) {
    // إذا كانت هناك بيانات متبقية من الإطار الحالي، قراءتها
    if p.readRemaining > 0 { /* قراءة المتبقي */ }

    // تخطي أي حشو متبقي من الإطار السابق
    if p.paddingRemaining > 0 {
        rw.SkipN(reader, p.paddingRemaining)
    }

    // قراءة رأس الإطار المحشو التالي (3 بايت)
    if p.readPadding < paddingCount {
        io.ReadFull(reader, paddingHeader[:3])
        originalDataSize := binary.BigEndian.Uint16(paddingHeader[:2])
        paddingSize := int(paddingHeader[2])
        n, _ = reader.Read(buffer[:originalDataSize])
        p.readPadding++
        p.readRemaining = originalDataSize - n
        p.paddingRemaining = paddingSize
        return
    }

    // بعد 8 إطارات، القراءة مباشرة
    return reader.Read(buffer)
}
```

### قابلية استبدال الاتصال

بعد مرحلة الحشو (8 إطارات)، يصبح غلاف الحشو شفافاً:

```go
func (p *paddingConn) readerReplaceable() bool {
    return p.readPadding == paddingCount
}

func (p *paddingConn) writerReplaceable() bool {
    return p.writePadding == paddingCount
}
```

### نوعان من الاتصالات

- **`naiveConn`**: لاتصالات HTTP/1.1 المختطفة (يغلف `net.Conn`)
- **`naiveH2Conn`**: لتيارات HTTP/2 (يغلف `io.Reader` + `io.Writer` + `http.Flusher`)؛ يجب التدفق بعد كل كتابة

## بنية الصادر (Cronet)

يستخدم الصادر مكتبة Cronet (مكدس شبكة Chromium) لجعل الاتصالات غير قابلة للتمييز عن Chrome الحقيقي:

```go
//go:build with_naive_outbound

type Outbound struct {
    outbound.Adapter
    ctx       context.Context
    logger    logger.ContextLogger
    client    *cronet.NaiveClient
    uotClient *uot.Client
}
```

### علامة البناء

يتطلب الصادر علامة البناء `with_naive_outbound`.

### قيود TLS

العديد من خيارات TLS غير مدعومة لأن Cronet يدير TLS الخاص به:

```go
if options.TLS.DisableSNI { return nil, E.New("not supported") }
if options.TLS.Insecure { return nil, E.New("not supported") }
if len(options.TLS.ALPN) > 0 { return nil, E.New("not supported") }
if options.TLS.UTLS != nil { return nil, E.New("not supported") }
if options.TLS.Reality != nil { return nil, E.New("not supported") }
// ... والمزيد
```

### تكوين العميل

```go
client, _ := cronet.NewNaiveClient(cronet.NaiveClientOptions{
    ServerAddress:           serverAddress,
    ServerName:              serverName,
    Username:                options.Username,
    Password:                options.Password,
    InsecureConcurrency:     options.InsecureConcurrency,
    ExtraHeaders:            extraHeaders,
    TrustedRootCertificates: trustedRootCertificates,
    Dialer:                  outboundDialer,
    DNSResolver:             dnsResolver,
    ECHEnabled:              echEnabled,
    QUIC:                    options.QUIC,
    QUICCongestionControl:   quicCongestionControl,
})
```

### التحكم في ازدحام QUIC (الصادر)

يدعم الصادر خوارزميات متعددة للتحكم في ازدحام QUIC:

```go
switch options.QUICCongestionControl {
case "bbr":   quicCongestionControl = cronet.QUICCongestionControlBBR
case "bbr2":  quicCongestionControl = cronet.QUICCongestionControlBBRv2
case "cubic": quicCongestionControl = cronet.QUICCongestionControlCubic
case "reno":  quicCongestionControl = cronet.QUICCongestionControlReno
}
```

### دعم ECH

يدعم الصادر Encrypted Client Hello:

```go
if options.TLS.ECH != nil && options.TLS.ECH.Enabled {
    echEnabled = true
    echConfigList = block.Bytes  // "ECH CONFIGS" مفكك من PEM
}
```

### تكامل DNS

يستخدم الصادر موجه DNS الخاص بـ sing-box لحل الأسماء داخل Cronet:

```go
dnsResolver = func(dnsContext context.Context, request *mDNS.Msg) *mDNS.Msg {
    response, _ := dnsRouter.Exchange(dnsContext, request, outboundDialer.(dialer.ResolveDialer).QueryOptions())
    return response
}
```

### دعم UDP عبر UoT

يتوفر UDP فقط من خلال UDP-over-TCP:

```go
if uotOptions.Enabled {
    outbound.uotClient = &uot.Client{
        Dialer:  &naiveDialer{client},
        Version: uotOptions.Version,
    }
}
```

## أمثلة على التكوين

### الوارد

```json
{
  "type": "naive",
  "tag": "naive-in",
  "listen": "::",
  "listen_port": 443,
  "users": [
    { "username": "user1", "password": "pass1" }
  ],
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  }
}
```

### الصادر

```json
{
  "type": "naive",
  "tag": "naive-out",
  "server": "example.com",
  "server_port": 443,
  "username": "user1",
  "password": "pass1",
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  },
  "udp_over_tcp": {
    "enabled": true,
    "version": 2
  }
}
```
