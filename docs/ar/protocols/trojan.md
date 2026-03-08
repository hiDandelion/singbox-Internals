# بروتوكول Trojan

Trojan هو بروتوكول وكيل مصمم لمحاكاة حركة مرور HTTPS. يستخدم نظام مصادقة قائم على كلمة المرور مع تجزئة SHA-224 ويدعم التراجع (fallback) إلى خادم ويب حقيقي لحركة المرور غير المعروفة.

**المصدر**: `protocol/trojan/`، `transport/trojan/`

## تنسيق البيانات

يستخدم بروتوكول Trojan تنسيق بيانات بسيط ومتوافق مع TLS:

```
+----------+------+---------+----------+------+----------+
| Password | CRLF | Command | Address  | CRLF | Payload  |
| (56 hex) | \r\n | (1 byte)| (variable)|\r\n | (variable)|
+----------+------+---------+----------+------+----------+
```

### اشتقاق كلمة المرور

يتم تحويل كلمة المرور إلى تجزئة SHA-224 مشفرة بالست عشري بطول 56 بايت:

```go
const KeyLength = 56

func Key(password string) [KeyLength]byte {
    var key [KeyLength]byte
    hash := sha256.New224()                    // SHA-224، وليس SHA-256
    hash.Write([]byte(password))
    hex.Encode(key[:], hash.Sum(nil))          // 28 بايت -> 56 حرف ست عشري
    return key
}
```

تنتج SHA-224 خرجاً بحجم 28 بايت (224 بت)، والتي تُشفر بالست عشري إلى 56 حرفاً بالضبط. يتم إرسالها كما هي (وليس base64) في المصافحة.

### الأوامر

```go
const (
    CommandTCP = 1     // اتصال TCP
    CommandUDP = 3     // ربط UDP
    CommandMux = 0x7f  // تعدد إرسال Trojan-Go
)
```

### مصافحة TCP

```
العميل -> الخادم:
  [56 بايت: SHA224(password) بالست عشري]
  [2 بايت: \r\n]
  [1 بايت: 0x01 (TCP)]
  [متغير: عنوان SOCKS (النوع + العنوان + المنفذ)]
  [2 بايت: \r\n]
  [بيانات الحمولة...]
```

يستخدم التنفيذ دمج المخازن المؤقتة للكفاءة:

```go
func ClientHandshake(conn net.Conn, key [KeyLength]byte, destination M.Socksaddr, payload []byte) error {
    headerLen := KeyLength + M.SocksaddrSerializer.AddrPortLen(destination) + 5
    header := buf.NewSize(headerLen + len(payload))
    header.Write(key[:])           // 56 بايت تجزئة كلمة المرور
    header.Write(CRLF)            // \r\n
    header.WriteByte(CommandTCP)  // 0x01
    M.SocksaddrSerializer.WriteAddrPort(header, destination)
    header.Write(CRLF)            // \r\n
    header.Write(payload)         // الحمولة الأولى المدمجة
    conn.Write(header.Bytes())    // استدعاء كتابة واحد
}
```

### تنسيق حزمة UDP

بعد المصافحة الأولية (التي تستخدم `CommandUDP`)، يتم تأطير حزم UDP كالتالي:

```
+----------+--------+------+----------+
| Address  | Length | CRLF | Payload  |
| (variable)| (2 BE) | \r\n | (Length) |
+----------+--------+------+----------+
```

```go
func WritePacket(conn net.Conn, buffer *buf.Buffer, destination M.Socksaddr) error {
    header := buf.With(buffer.ExtendHeader(...))
    M.SocksaddrSerializer.WriteAddrPort(header, destination)
    binary.Write(header, binary.BigEndian, uint16(bufferLen))
    header.Write(CRLF)
    conn.Write(buffer.Bytes())
}

func ReadPacket(conn net.Conn, buffer *buf.Buffer) (M.Socksaddr, error) {
    destination := M.SocksaddrSerializer.ReadAddrPort(conn)
    var length uint16
    binary.Read(conn, binary.BigEndian, &length)
    rw.SkipN(conn, 2)  // تخطي CRLF
    buffer.ReadFullFrom(conn, int(length))
    return destination, nil
}
```

### المصافحة الأولية لـ UDP

تتضمن أول حزمة UDP كلاً من رأس Trojan وعنوان/طول أول حزمة:

```
[56 بايت مفتاح][CRLF][0x03 UDP][عنوان الوجهة][CRLF][عنوان الوجهة][الطول][CRLF][الحمولة]
                                  ^المصافحة^    ^أول حزمة^
```

لاحظ أن عنوان الوجهة يظهر مرتين: مرة في المصافحة ومرة في إطار الحزمة.

## طبقة خدمة Trojan

ينفذ `transport/trojan/service.go` معالج البروتوكول من جانب الخادم:

```go
type Service[K comparable] struct {
    users           map[K][56]byte       // المستخدم -> المفتاح
    keys            map[[56]byte]K       // المفتاح -> المستخدم (بحث عكسي)
    handler         Handler              // معالج TCP + UDP
    fallbackHandler N.TCPConnectionHandlerEx
    logger          logger.ContextLogger
}
```

### معالجة الاتصال من جانب الخادم

```go
func (s *Service[K]) NewConnection(ctx, conn, source, onClose) error {
    // 1. قراءة مفتاح كلمة المرور بطول 56 بايت
    var key [KeyLength]byte
    n, err := conn.Read(key[:])
    if n != KeyLength {
        return s.fallback(ctx, conn, source, key[:n], ...)
    }

    // 2. المصادقة
    if user, loaded := s.keys[key]; loaded {
        ctx = auth.ContextWithUser(ctx, user)
    } else {
        return s.fallback(ctx, conn, source, key[:], ...)
    }

    // 3. تخطي CRLF، قراءة الأمر
    rw.SkipN(conn, 2)
    binary.Read(conn, binary.BigEndian, &command)

    // 4. قراءة عنوان الوجهة، تخطي CRLF اللاحق
    destination := M.SocksaddrSerializer.ReadAddrPort(conn)
    rw.SkipN(conn, 2)

    // 5. التوزيع بناءً على الأمر
    switch command {
    case CommandTCP:
        s.handler.NewConnectionEx(ctx, conn, source, destination, onClose)
    case CommandUDP:
        s.handler.NewPacketConnectionEx(ctx, &PacketConn{Conn: conn}, ...)
    default:  // CommandMux (0x7f)
        HandleMuxConnection(ctx, conn, source, s.handler, s.logger, onClose)
    }
}
```

### آلية التراجع (Fallback)

عند فشل المصادقة، تدعم الخدمة التراجع إلى خادم ويب حقيقي:

```go
func (s *Service[K]) fallback(ctx, conn, source, header, err, onClose) error {
    if s.fallbackHandler == nil {
        return E.Extend(err, "fallback disabled")
    }
    // إعادة البايتات المقروءة مسبقاً إلى الاتصال
    conn = bufio.NewCachedConn(conn, buf.As(header).ToOwned())
    s.fallbackHandler.NewConnectionEx(ctx, conn, source, M.Socksaddr{}, onClose)
    return nil
}
```

هذا أمر حاسم لمقاومة الرقابة: إذا أرسل مسبار بيانات غير Trojan، يتم تحويلها إلى خادم ويب حقيقي، مما يجعل الخدمة غير قابلة للتمييز عن موقع HTTPS عادي.

## دعم Mux (Trojan-Go)

يستخدم تنفيذ mux بروتوكول `smux` (Simple Multiplexer) للتوافق مع Trojan-Go:

```go
func HandleMuxConnection(ctx, conn, source, handler, logger, onClose) error {
    session, _ := smux.Server(conn, smuxConfig())
    for {
        stream, _ := session.AcceptStream()
        go newMuxConnection(ctx, stream, source, handler, logger)
    }
}
```

يحتوي كل تيار mux على بايت أمر خاص به ووجهة:

```go
func newMuxConnection0(ctx, conn, source, handler) error {
    reader := bufio.NewReader(conn)
    command, _ := reader.ReadByte()
    destination, _ := M.SocksaddrSerializer.ReadAddrPort(reader)
    switch command {
    case CommandTCP:
        handler.NewConnectionEx(ctx, conn, source, destination, nil)
    case CommandUDP:
        handler.NewPacketConnectionEx(ctx, &PacketConn{Conn: conn}, ...)
    }
}
```

يعطل تكوين smux الحفاظ على الاتصال:

```go
func smuxConfig() *smux.Config {
    config := smux.DefaultConfig()
    config.KeepAliveDisabled = true
    return config
}
```

## تنفيذ الوارد (Inbound)

```go
type Inbound struct {
    inbound.Adapter
    router                   adapter.ConnectionRouterEx
    logger                   log.ContextLogger
    listener                 *listener.Listener
    service                  *trojan.Service[int]
    users                    []option.TrojanUser
    tlsConfig                tls.ServerConfig
    fallbackAddr             M.Socksaddr
    fallbackAddrTLSNextProto map[string]M.Socksaddr  // تراجع قائم على ALPN
    transport                adapter.V2RayServerTransport
}
```

### التراجع القائم على ALPN

يدعم Trojan وجهات تراجع لكل ALPN، مما يسمح بأهداف تراجع مختلفة بناءً على البروتوكول المتفاوض عليه في TLS:

```go
func (h *Inbound) fallbackConnection(ctx, conn, metadata, onClose) {
    if len(h.fallbackAddrTLSNextProto) > 0 {
        if tlsConn, loaded := common.Cast[tls.Conn](conn); loaded {
            negotiatedProtocol := tlsConn.ConnectionState().NegotiatedProtocol
            fallbackAddr = h.fallbackAddrTLSNextProto[negotiatedProtocol]
        }
    }
    if !fallbackAddr.IsValid() {
        fallbackAddr = h.fallbackAddr  // التراجع الافتراضي
    }
    metadata.Destination = fallbackAddr
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### توافق kTLS

يفعل الوارد kTLS (TLS على مستوى النواة) عند استيفاء الشروط:

```go
tlsConfig, _ := tls.NewServerWithOptions(tls.ServerOptions{
    KTLSCompatible: transport.Type == "" && !multiplex.Enabled,
    // kTLS فقط عندما: لا يوجد نقل V2Ray ولا يوجد تعدد إرسال
})
```

## تنفيذ الصادر (Outbound)

```go
type Outbound struct {
    outbound.Adapter
    key             [56]byte              // مفتاح SHA224 محسوب مسبقاً
    multiplexDialer *mux.Client
    tlsConfig       tls.Config
    tlsDialer       tls.Dialer
    transport       adapter.V2RayClientTransport
}
```

يتم حساب المفتاح مرة واحدة عند البناء:

```go
outbound.key = trojan.Key(options.Password)
```

### تدفق الاتصال

```go
func (h *trojanDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    // 1. إنشاء الاتصال: النقل > TLS > TCP الخام
    var conn net.Conn
    if h.transport != nil {
        conn = h.transport.DialContext(ctx)
    } else if h.tlsDialer != nil {
        conn = h.tlsDialer.DialTLSContext(ctx, h.serverAddr)
    } else {
        conn = h.dialer.DialContext(ctx, "tcp", h.serverAddr)
    }

    // 2. التغليف ببروتوكول Trojan
    switch network {
    case "tcp":
        return trojan.NewClientConn(conn, h.key, destination)
    case "udp":
        return bufio.NewBindPacketConn(
            trojan.NewClientPacketConn(conn, h.key), destination)
    }
}
```

### البيانات المبكرة (الكتابة الكسولة)

ينفذ `ClientConn` واجهة `N.EarlyWriter`، مما يعني أن رأس Trojan يُرسل فقط عند أول استدعاء لـ `Write()`، مدمجاً مع أول حمولة:

```go
func (c *ClientConn) Write(p []byte) (n int, err error) {
    if c.headerWritten {
        return c.ExtendedConn.Write(p)
    }
    err = ClientHandshake(c.ExtendedConn, c.key, c.destination, p)
    c.headerWritten = true
    n = len(p)
    return
}
```

## مثال على التكوين

```json
{
  "type": "trojan",
  "tag": "trojan-in",
  "listen": "::",
  "listen_port": 443,
  "users": [
    { "name": "user1", "password": "my-secret-password" }
  ],
  "tls": {
    "enabled": true,
    "server_name": "example.com",
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  },
  "fallback": {
    "server": "127.0.0.1",
    "server_port": 8080
  },
  "fallback_for_alpn": {
    "h2": {
      "server": "127.0.0.1",
      "server_port": 8081
    }
  }
}
```
