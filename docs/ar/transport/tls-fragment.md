# تجزئة TLS ClientHello

المصدر: `common/tlsfragment/index.go`، `common/tlsfragment/conn.go`، `common/tlsfragment/wait_linux.go`، `common/tlsfragment/wait_darwin.go`، `common/tlsfragment/wait_windows.go`، `common/tlsfragment/wait_stub.go`

## نظرة عامة

تقسم تجزئة TLS رسالة TLS ClientHello عند حدود تسميات نطاق SNI (مؤشر اسم الخادم). تُستخدم هذه التقنية لتجاوز الفحص العميق للحزم (DPI) الذي يقرأ SNI لتحديد النطاق المستهدف. بتقسيم SNI عبر عدة مقاطع TCP أو سجلات TLS، تفشل أنظمة DPI البسيطة في إعادة تجميع النطاق ومطابقته.

## وضعا التجزئة

### وضع splitPacket

يقسم ClientHello إلى عدة مقاطع TCP عند حدود تسميات نطاق SNI. يُرسل كل مقطع كحزمة TCP منفصلة مع تفعيل `TCP_NODELAY`، وينتظر المرسل إشعار ACK لكل مقطع قبل إرسال التالي.

### وضع splitRecord

يُعيد تغليف كل جزء كسجل TLS منفصل بإضافة ترويسة طبقة سجل TLS الأصلية (نوع المحتوى + الإصدار) مع حقل طول جديد. هذا يُنشئ عدة سجلات TLS صالحة من ClientHello واحد.

يمكن الجمع بين الوضعين: `splitRecord` يُنشئ سجلات TLS منفصلة، و `splitPacket` يُرسل كل سجل كمقطع TCP فردي مع انتظار ACK.

## استخراج SNI

تُحلل دالة `IndexTLSServerName` رسالة TLS ClientHello خام لتحديد موقع امتداد SNI:

```go
func IndexTLSServerName(payload []byte) *MyServerName {
    if len(payload) < recordLayerHeaderLen || payload[0] != contentType {
        return nil  // Not a TLS handshake
    }
    segmentLen := binary.BigEndian.Uint16(payload[3:5])
    serverName := indexTLSServerNameFromHandshake(payload[recordLayerHeaderLen:])
    serverName.Index += recordLayerHeaderLen
    return serverName
}
```

يمر المُحلل عبر:
1. ترويسة طبقة سجل TLS (5 بايتات)
2. ترويسة المصافحة (6 بايتات) -- يتحقق من نوع المصافحة 1 (ClientHello)
3. البيانات العشوائية (32 بايت)
4. معرف الجلسة (طول متغير)
5. مجموعات التشفير (طول متغير)
6. طرق الضغط (طول متغير)
7. الامتدادات -- يبحث عن امتداد SNI (النوع 0x0000)

يُرجع `MyServerName` مع إزاحة البايت والطول والقيمة النصية لـ SNI.

## اتصال التجزئة

```go
type Conn struct {
    net.Conn
    tcpConn            *net.TCPConn
    ctx                context.Context
    firstPacketWritten bool
    splitPacket        bool
    splitRecord        bool
    fallbackDelay      time.Duration
}
```

يعترض `Conn` فقط أول استدعاء `Write` (ClientHello). الكتابات اللاحقة تمر مباشرة.

### خوارزمية التقسيم

```go
func (c *Conn) Write(b []byte) (n int, err error) {
    if !c.firstPacketWritten {
        defer func() { c.firstPacketWritten = true }()
        serverName := IndexTLSServerName(b)
        if serverName != nil {
            // 1. Enable TCP_NODELAY for splitPacket mode
            // 2. Parse domain labels, skip public suffix
            splits := strings.Split(serverName.ServerName, ".")
            if publicSuffix := publicsuffix.List.PublicSuffix(serverName.ServerName); publicSuffix != "" {
                splits = splits[:len(splits)-strings.Count(serverName.ServerName, ".")]
            }
            // 3. Random split point within each label
            for i, split := range splits {
                splitAt := rand.Intn(len(split))
                splitIndexes = append(splitIndexes, currentIndex+splitAt)
            }
            // 4. Send fragments
            for i := 0; i <= len(splitIndexes); i++ {
                // Extract payload slice
                if c.splitRecord {
                    // Re-wrap with TLS record header
                    buffer.Write(b[:3])              // Content type + version
                    binary.Write(&buffer, binary.BigEndian, payloadLen)
                    buffer.Write(payload)
                }
                if c.splitPacket {
                    writeAndWaitAck(c.ctx, c.tcpConn, payload, c.fallbackDelay)
                }
            }
            // 5. Restore TCP_NODELAY to false
            return len(b), nil
        }
    }
    return c.Conn.Write(b)
}
```

### معالجة اللاحقة العامة

تُستثنى تسميات النطاق التي تنتمي إلى اللاحقة العامة (مثل `.co.uk`، `.com.cn`) من التقسيم باستخدام `golang.org/x/net/publicsuffix`. هذا يضمن أن التقسيمات تحدث فقط ضمن الأجزاء ذات المعنى من اسم النطاق.

### معالجة البدل القيادي

إذا بدأ النطاق بـ `...` (مثل `...subdomain.example.com`)، يتم تخطي تسمية `...` القيادية ويُعدَّل الفهرس للأمام.

## انتظار ACK حسب المنصة

تتأكد دالة `writeAndWaitAck` من تأكيد كل مقطع TCP قبل إرسال التالي. يُنفَّذ هذا بشكل مختلف حسب المنصة:

### Linux (`wait_linux.go`)

يستخدم خيار المقبس `TCP_INFO` للتحقق من حقل `Unacked`:

```go
func waitAck(ctx context.Context, conn *net.TCPConn, fallbackDelay time.Duration) error {
    rawConn.Control(func(fd uintptr) {
        for {
            var info unix.TCPInfo
            infoBytes, _ := unix.GetsockoptTCPInfo(int(fd), unix.SOL_TCP, unix.TCP_INFO)
            if infoBytes.Unacked == 0 {
                return  // All segments acknowledged
            }
            time.Sleep(time.Millisecond)
        }
    })
}
```

### Darwin (`wait_darwin.go`)

يستخدم خيار المقبس `SO_NWRITE` للتحقق من البايتات غير المُرسلة:

```go
func waitAck(ctx context.Context, conn *net.TCPConn, fallbackDelay time.Duration) error {
    rawConn.Control(func(fd uintptr) {
        for {
            nwrite, _ := unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_NWRITE)
            if nwrite == 0 {
                return  // All data sent and acknowledged
            }
            time.Sleep(time.Millisecond)
        }
    })
}
```

### Windows (`wait_windows.go`)

يستخدم `winiphlpapi.WriteAndWaitAck` (غلاف مخصص لـ Windows API).

### البديل الاحتياطي (`wait_stub.go`)

على المنصات غير المدعومة، يرجع إلى `time.Sleep(fallbackDelay)`:

```go
func writeAndWaitAck(ctx context.Context, conn *net.TCPConn, b []byte, fallbackDelay time.Duration) error {
    _, err := conn.Write(b)
    if err != nil { return err }
    time.Sleep(fallbackDelay)
    return nil
}
```

التأخير الاحتياطي الافتراضي هو `C.TLSFragmentFallbackDelay`.

## قابلية استبدال الاتصال

```go
func (c *Conn) ReaderReplaceable() bool {
    return true  // Reader can always be replaced (no read interception)
}

func (c *Conn) WriterReplaceable() bool {
    return c.firstPacketWritten  // Writer replaceable after first write
}
```

بعد كتابة الحزمة الأولى، يصبح `Conn` شفافًا ويمكن تحسين كاتبه بعيدًا بواسطة خط أنابيب المخزن المؤقت.

## الإعدادات

تُعدّ تجزئة TLS كجزء من خيارات TLS:

```json
{
  "tls": {
    "enabled": true,
    "fragment": true,
    "record_fragment": true,
    "fragment_fallback_delay": "20ms"
  }
}
```

| الحقل | الوصف |
|-------|-------------|
| `fragment` | تفعيل تقسيم حزم TCP (وضع `splitPacket`) |
| `record_fragment` | تفعيل تقسيم سجلات TLS (وضع `splitRecord`) |
| `fragment_fallback_delay` | تأخير احتياطي على المنصات بدون كشف ACK |
