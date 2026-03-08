# نظرة عامة على طبقة النقل

المصدر: `transport/v2ray/`، `common/tls/`، `common/mux/`، `common/uot/`، `common/tlsfragment/`

## البنية المعمارية

تقع طبقة النقل في sing-box بين طبقة بروتوكول الوكيل والشبكة الخام، وتوفر وسائل نقل تدفقية قابلة للتوصيل (WebSocket، gRPC، HTTP، QUIC، HTTP Upgrade)، ومتغيرات TLS (stdlib، uTLS، Reality، ECH، kTLS)، وتعدد الاتصالات (sing-mux)، ونفق UDP-over-TCP، وتجزئة بصمة TLS.

### خريطة المكونات

```
Proxy Protocol (VMess, Trojan, etc.)
    |
    v
+--------------------+
| V2Ray Transport    |  <-- WebSocket, gRPC, HTTP, QUIC, HTTPUpgrade
+--------------------+
    |
    v
+--------------------+
| TLS Layer          |  <-- STD, uTLS, Reality, ECH, kTLS
+--------------------+
    |
    v
+--------------------+
| Multiplexing       |  <-- sing-mux, UoT
+--------------------+
    |
    v
+--------------------+
| TLS Fragment       |  <-- ClientHello splitting
+--------------------+
    |
    v
  Raw TCP/UDP
```

### الواجهات الرئيسية

طبقة النقل منظمة حول واجهتي محول:

```go
// Server-side transport
type V2RayServerTransport interface {
    Network() []string
    Serve(listener net.Listener) error
    ServePacket(listener net.PacketConn) error
    Close() error
}

// Client-side transport
type V2RayClientTransport interface {
    DialContext(ctx context.Context) (net.Conn, error)
    Close() error
}
```

كل تنفيذ نقل (WebSocket، gRPC، HTTP، QUIC، HTTP Upgrade) يوفر نوعي خادم وعميل يستوفيان هاتين الواجهتين.

### اختيار النقل

يُحدد نوع النقل بثابت نصي في الإعدادات:

```json
{
  "transport": {
    "type": "ws",          // "http", "grpc", "quic", "httpupgrade"
    "path": "/path",
    "headers": {}
  }
}
```

يقوم المصنع `v2ray/transport.go` بالتوزيع بناءً على هذا النص عبر تبديل الأنواع في `NewServerTransport` و `NewClientTransport`.

### تبعيات علامات البناء

ليست جميع وسائل النقل متاحة دائمًا:

| النقل | علامة البناء المطلوبة | ملاحظات |
|-----------|-------------------|-------|
| WebSocket | لا شيء | متاح دائمًا |
| HTTP | لا شيء | متاح دائمًا |
| HTTP Upgrade | لا شيء | متاح دائمًا |
| gRPC (كامل) | `with_grpc` | يستخدم `google.golang.org/grpc` |
| gRPC (خفيف) | لا شيء | HTTP/2 خام، متاح دائمًا كبديل احتياطي |
| QUIC | `with_quic` | يستخدم `github.com/sagernet/quic-go` |
| uTLS | `with_utls` | مطلوب لـ Reality |
| ACME | `with_acme` | يستخدم certmagic |
| kTLS | Linux + go1.25 + `badlinkname` | تفريغ TLS على مستوى النواة |
| ECH | go1.24+ | دعم ECH في مكتبة Go القياسية |

### تدفق الاتصال

**جانب العميل** (الصادر):

1. تستدعي طبقة البروتوكول `transport.DialContext(ctx)` للحصول على `net.Conn`
2. ينشئ النقل اتصال TCP/UDP الأساسي عبر `N.Dialer` المُقدَّم
3. يُنفَّذ مصافحة TLS إذا كانت مُعدَّة (مغلفة عبر `tls.NewDialer`)
4. يُطبَّق التأطير الخاص بالنقل (ترقية WebSocket، تدفق HTTP/2، إلخ.)
5. يُعاد الاتصال الناتج لاستخدام طبقة البروتوكول

**جانب الخادم** (الوارد):

1. يقبل المستمع الوارد الاتصالات الخام
2. يبدأ `transport.Serve(listener)` خادم النقل (خادم HTTP، خادم gRPC، إلخ.)
3. يتحقق النقل من الطلبات الواردة (المسار، الترويسات، بروتوكول الترقية)
4. عند النجاح، يستدعي `handler.NewConnectionEx()` مع الاتصال المُفكَّك
5. يوجِّه المعالج الاتصال إلى مفكك شفرة بروتوكول الوكيل

### أنماط أمان الخيوط

تظهر عدة أنماط متكررة عبر طبقة النقل:

- **مؤشر ذري + قفل متبادل لتخزين الاتصالات مؤقتًا**: يُستخدم في عميل gRPC وعميل QUIC والبيانات المبكرة لـ WebSocket. المسار السريع يقرأ مؤشرًا ذريًا؛ المسار البطيء يحصل على قفل متبادل لإنشاء الاتصال.
- **اتصال كسول مع إشارة القناة**: يؤجل `EarlyWebsocketConn` و `GunConn` (الخفيف) و `HTTP2Conn` إعداد الاتصال حتى أول كتابة، باستخدام قناة للإشارة إلى القراء المتزامنين بالاكتمال.
- **`HTTP2ConnWrapper` للكتابات الآمنة للخيوط**: تتطلب تدفقات HTTP/2 كتابات متزامنة؛ يستخدم الغلاف قفلًا متبادلًا مع علامة `closed` لمنع الكتابة بعد الإغلاق.
- **`DupContext` لفصل السياق**: ترتبط سياقات معالج HTTP بعمر الطلب؛ يستخرج `DupContext` معرف السجل ويُنشئ سياقًا خلفيًا جديدًا للاتصالات طويلة العمر.

### معالجة الأخطاء

تُوحَّد أخطاء النقل من خلال عدة أغلفة:

- `wrapWsError`: يحول إطارات إغلاق WebSocket (الإغلاق العادي، بدون حالة) إلى `io.EOF`
- `baderror.WrapGRPC`: يوحد أخطاء تدفق gRPC
- `baderror.WrapH2`: يوحد أخطاء تدفق HTTP/2
- `qtls.WrapError`: يوحد أخطاء QUIC

تُرجع جميع اتصالات النقل `os.ErrInvalid` للعمليات المتعلقة بالمهلة الزمنية (`SetDeadline`، `SetReadDeadline`، `SetWriteDeadline`) وتُعيِّن `NeedAdditionalReadDeadline() bool` إلى `true`، مما يُشير إلى المُستدعي بإدارة مهلات القراءة خارجيًا.
