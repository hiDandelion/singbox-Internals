# الاستكشاف

يكتشف استكشاف البروتوكولات بروتوكول طبقة التطبيق عبر فحص البايتات الأولى من الاتصال. هذا يتيح التوجيه المبني على النطاق حتى عندما يتصل العميل بعنوان IP.

**المصدر**: `common/sniff/`، `route/route.go`

## بنية الاستكشاف

يحدث الاستكشاف كإجراء قاعدة، وليس كخطوة ثابتة في خط الأنابيب:

```json
{
  "route": {
    "rules": [
      {
        "action": "sniff",
        "timeout": "300ms"
      },
      {
        "protocol": "tls",
        "domain_suffix": [".example.com"],
        "action": "route",
        "outbound": "proxy"
      }
    ]
  }
}
```

هذا يعني أنه يمكنك الاستكشاف بشكل مشروط (فقط لواردات أو منافذ معينة، إلخ.) واستخدام النتائج في القواعد اللاحقة.

## كاشفات التدفق (TCP)

```go
type StreamSniffer = func(ctx context.Context, metadata *adapter.InboundContext, reader io.Reader) error
```

### الكاشفات المتوفرة

| الكاشف | البروتوكول | الاكتشاف |
|---------|----------|-----------|
| `TLSClientHello` | `tls` | نوع سجل TLS 0x16، نوع المصافحة 0x01، امتداد SNI |
| `HTTPHost` | `http` | طريقة HTTP + ترويسة Host |
| `StreamDomainNameQuery` | `dns` | استعلام DNS عبر TCP |
| `BitTorrent` | `bittorrent` | بايتات مصافحة BitTorrent السحرية |
| `SSH` | `ssh` | بادئة "SSH-" |
| `RDP` | `rdp` | ترويسة RDP TPKT |

### استكشاف TLS

```go
func TLSClientHello(ctx context.Context, metadata *adapter.InboundContext, reader io.Reader) error {
    // تحليل ترويسة سجل TLS
    // تحليل رسالة مصافحة ClientHello
    // استخراج SNI من الامتدادات
    // استخراج ALPN من الامتدادات
    // تعيين metadata.Protocol = "tls"
    // تعيين metadata.Domain = SNI
    // تعيين metadata.Client (فئة بصمة JA3)
    // تعيين metadata.SniffContext = &TLSContext{ALPN, ClientHello}
}
```

يخزّن كاشف TLS أيضاً ClientHello الكامل في `SniffContext` لبصمة JA3 والاستخدام اللاحق بواسطة خادم REALITY.

### استكشاف HTTP

```go
func HTTPHost(ctx context.Context, metadata *adapter.InboundContext, reader io.Reader) error {
    // التحقق من طريقة HTTP (GET, POST, إلخ.)
    // تحليل الترويسات للعثور على Host
    // تعيين metadata.Protocol = "http"
    // تعيين metadata.Domain = قيمة ترويسة Host
}
```

## كاشفات الحزم (UDP)

```go
type PacketSniffer = func(ctx context.Context, metadata *adapter.InboundContext, packet []byte) error
```

### الكاشفات المتوفرة

| الكاشف | البروتوكول | الاكتشاف |
|---------|----------|-----------|
| `QUICClientHello` | `quic` | حزمة QUIC الأولية + TLS ClientHello |
| `DomainNameQuery` | `dns` | حزمة استعلام DNS |
| `STUNMessage` | `stun` | بايتات رسالة STUN السحرية |
| `UTP` | `bittorrent` | uTP (بروتوكول النقل المصغر) |
| `UDPTracker` | `bittorrent` | متتبع BitTorrent UDP |
| `DTLSRecord` | `dtls` | ترويسة سجل DTLS |
| `NTP` | `ntp` | تنسيق حزمة NTP |

### استكشاف QUIC

استكشاف QUIC هو الأكثر تعقيداً — يجب أن:
1. يحلل ترويسة حزمة QUIC الأولية
2. يفك تشفير حماية ترويسة QUIC
3. يفك تشفير حمولة QUIC (باستخدام السر الأولي المشتق من معرّف الاتصال)
4. يجد إطار CRYPTO الذي يحتوي على TLS ClientHello
5. يحلل ClientHello لاستخراج SNI

يمكن أن تمتد ClientHello في QUIC عبر حزم متعددة، لذا يُرجع الكاشف `sniff.ErrNeedMoreData` وسيقرأ الموجّه حزماً إضافية.

## PeekStream

```go
func PeekStream(
    ctx context.Context,
    metadata *adapter.InboundContext,
    conn net.Conn,
    existingBuffers []*buf.Buffer,
    buffer *buf.Buffer,
    timeout time.Duration,
    sniffers ...StreamSniffer,
) error {
    // إذا كانت هناك بيانات مخزنة، محاولة استكشافها أولاً
    if len(existingBuffers) > 0 {
        reader := io.MultiReader(buffers..., buffer)
        for _, sniffer := range sniffers {
            err := sniffer(ctx, metadata, reader)
            if err == nil { return nil }
        }
    }

    // قراءة بيانات جديدة مع مهلة
    conn.SetReadDeadline(time.Now().Add(timeout))
    _, err := buffer.ReadOnceFrom(conn)
    conn.SetReadDeadline(time.Time{})

    // تجربة كل كاشف
    reader := io.MultiReader(buffers..., buffer)
    for _, sniffer := range sniffers {
        err := sniffer(ctx, metadata, reader)
        if err == nil { return nil }
    }
    return ErrClientHelloNotFound
}
```

تُخزّن البيانات المستكشفة مؤقتاً وتُلحق في بداية الاتصال قبل إعادة التوجيه إلى الصادر (عبر `bufio.NewCachedConn`).

## PeekPacket

```go
func PeekPacket(
    ctx context.Context,
    metadata *adapter.InboundContext,
    packet []byte,
    sniffers ...PacketSniffer,
) error {
    for _, sniffer := range sniffers {
        err := sniffer(ctx, metadata, packet)
        if err == nil { return nil }
    }
    return ErrClientHelloNotFound
}
```

بالنسبة للحزم، لا حاجة للتخزين المؤقت — تُقرأ الحزمة بالكامل وتُمرر إلى الكاشفات.

## منطق التخطي

تُتخطى بعض المنافذ لأنها تستخدم بروتوكولات يبدأ فيها الخادم أولاً (يرسل الخادم بيانات قبل العميل):

```go
func Skip(metadata *adapter.InboundContext) bool {
    // تخطي البروتوكولات التي يبدأ فيها الخادم على المنافذ المعروفة
    switch metadata.Destination.Port {
    case 25, 110, 143, 465, 587, 993, 995: // SMTP, POP3, IMAP
        return true
    }
    return false
}
```

## تدفق نتيجة الاستكشاف

بعد الاستكشاف، تُثرى البيانات الوصفية:

```go
metadata.Protocol = "tls"          // البروتوكول المكتشف
metadata.Domain = "example.com"    // النطاق المستخرج
metadata.Client = "chrome"         // بصمة عميل TLS
```

إذا كان `OverrideDestination` معيّناً في إجراء الاستكشاف، تُحدّث الوجهة أيضاً:

```go
if action.OverrideDestination && M.IsDomainName(metadata.Domain) {
    metadata.Destination = M.Socksaddr{
        Fqdn: metadata.Domain,
        Port: metadata.Destination.Port,
    }
}
```

هذا يسمح للقواعد اللاحقة بالمطابقة على النطاق المستكشف، وسيتصل الصادر بالنطاق (وليس عنوان IP).
