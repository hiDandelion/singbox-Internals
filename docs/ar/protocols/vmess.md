# بروتوكول VMess

VMess هو بروتوكول الوكيل الأصلي لـ V2Ray ويتميز بمصادقة قائمة على UUID مع تشفير AEAD. يفوض sing-box تنسيق بيانات VMess بالكامل إلى مكتبة `sing-vmess`.

**المصدر**: `protocol/vmess/inbound.go`، `protocol/vmess/outbound.go`، `sing-vmess`

## تكامل sing-vmess

لا ينفذ sing-box تنسيق بيانات VMess بنفسه. بدلاً من ذلك، يستخدم مكتبة `github.com/sagernet/sing-vmess` التي توفر:

- `vmess.Service[int]` -- معالج بروتوكول VMess من جانب الخادم، عام على نوع مفتاح المستخدم
- `vmess.Client` -- معالج بروتوكول VMess من جانب العميل
- `vmess.ServiceOption` / `vmess.ClientOption` -- خيارات وظيفية للتكوين
- `packetaddr` -- ترميز عنوان الحزمة لـ UDP-over-TCP

هذا اختلاف جوهري عن **Xray-core** الذي ينفذ VMess مباشرة في قاعدة الكود الخاصة به. يوفر نهج sing-box فصلاً أنظف للمسؤوليات.

## بنية الوارد (Inbound)

```go
type Inbound struct {
    inbound.Adapter
    ctx       context.Context
    router    adapter.ConnectionRouterEx
    logger    logger.ContextLogger
    listener  *listener.Listener
    service   *vmess.Service[int]       // خدمة sing-vmess، مفهرسة بفهرس المستخدم
    users     []option.VMessUser
    tlsConfig tls.ServerConfig
    transport adapter.V2RayServerTransport
}
```

### تدفق البناء

```go
func NewInbound(ctx, router, logger, tag, options) (adapter.Inbound, error) {
    // 1. تغليف الموجه بدعم UoT (UDP-over-TCP)
    inbound.router = uot.NewRouter(router, logger)

    // 2. تغليف الموجه بدعم mux (تعدد الإرسال)
    inbound.router = mux.NewRouterWithOptions(inbound.router, logger, options.Multiplex)

    // 3. تكوين خيارات خدمة VMess
    //    - دالة وقت NTP (VMess حساس للوقت)
    //    - تعطيل حماية الرأس عند استخدام نقل V2Ray
    serviceOptions = append(serviceOptions, vmess.ServiceWithTimeFunc(timeFunc))
    if options.Transport != nil {
        serviceOptions = append(serviceOptions, vmess.ServiceWithDisableHeaderProtection())
    }

    // 4. إنشاء الخدمة وتسجيل المستخدمين (فهرس -> UUID + alterId)
    service := vmess.NewService[int](handler, serviceOptions...)
    service.UpdateUsers(indices, uuids, alterIds)

    // 5. TLS اختياري
    // 6. نقل V2Ray اختياري (WebSocket، gRPC، HTTP، QUIC)
    // 7. مستمع TCP
}
```

### تصميم رئيسي: تعطيل حماية الرأس مع النقل

عند تكوين نقل V2Ray (WebSocket، gRPC، إلخ)، يتم تمرير `vmess.ServiceWithDisableHeaderProtection()`. هذا لأن طبقة النقل توفر بالفعل تأطيرها الخاص، مما يجعل حماية رأس VMess زائدة وقد تكون إشكالية.

### معالجة الاتصال

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    // 1. مصافحة TLS (فقط إذا تم تكوين TLS ولا يوجد نقل)
    //    عند استخدام النقل، يتم معالجة TLS بواسطة طبقة النقل
    if h.tlsConfig != nil && h.transport == nil {
        conn = tls.ServerHandshake(ctx, conn, h.tlsConfig)
    }

    // 2. التفويض إلى خدمة sing-vmess
    //    فك تشفير VMess والمصادقة وتحليل الأوامر تحدث هنا
    h.service.NewConnection(ctx, conn, metadata.Source, onClose)
}
```

بعد أن تفك الخدمة تشفير طلب VMess، تستدعي معالجات الوارد:

```go
func (h *Inbound) newConnectionEx(ctx, conn, metadata, onClose) {
    // استخراج فهرس المستخدم من السياق (معين بواسطة sing-vmess)
    userIndex, _ := auth.UserFromContext[int](ctx)
    user := h.users[userIndex].Name
    metadata.User = user
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### معالجة عنوان الحزمة (packetaddr)

لاتصالات حزم UDP، يستخدم VMess عنوان FQDN سحري `packetaddr.SeqPacketMagicAddress` للإشارة إلى أن الاتصال يحمل حزم UDP متعددة الإرسال:

```go
func (h *Inbound) newPacketConnectionEx(ctx, conn, metadata, onClose) {
    if metadata.Destination.Fqdn == packetaddr.SeqPacketMagicAddress {
        metadata.Destination = M.Socksaddr{}
        conn = packetaddr.NewConn(bufio.NewNetPacketConn(conn), metadata.Destination)
    }
    h.router.RoutePacketConnectionEx(ctx, conn, metadata, onClose)
}
```

## بنية الصادر (Outbound)

```go
type Outbound struct {
    outbound.Adapter
    logger          logger.ContextLogger
    dialer          N.Dialer
    client          *vmess.Client        // عميل sing-vmess
    serverAddr      M.Socksaddr
    multiplexDialer *mux.Client
    tlsConfig       tls.Config
    tlsDialer       tls.Dialer
    transport       adapter.V2RayClientTransport
    packetAddr      bool                 // ترميز packetaddr
    xudp            bool                 // ترميز XUDP
}
```

### أوضاع ترميز الحزم

يدعم صادر VMess ثلاثة أوضاع لترميز الحزم لـ UDP:

| الوضع | الحقل | الوصف |
|------|-------|-------------|
| (لا شيء) | افتراضي | UDP القياسي لـ VMess |
| `packetaddr` | `packetAddr=true` | يستخدم FQDN السحري لـ packetaddr لتعدد إرسال UDP |
| `xudp` | `xudp=true` | بروتوكول XUDP لتعدد إرسال UDP |

```go
switch options.PacketEncoding {
case "packetaddr":
    outbound.packetAddr = true
case "xudp":
    outbound.xudp = true
}
```

### الاختيار التلقائي للأمان

```go
security := options.Security
if security == "" {
    security = "auto"
}
if security == "auto" && outbound.tlsConfig != nil {
    security = "zero"  // استخدام تشفير صفري عند وجود TLS
}
```

عند تكوين TLS مسبقاً، يستخدم VMess تلقائياً أمان "zero" لتجنب التشفير المزدوج -- وهو تحسين للأداء.

### خيارات العميل

```go
var clientOptions []vmess.ClientOption
if options.GlobalPadding {
    clientOptions = append(clientOptions, vmess.ClientWithGlobalPadding())
}
if options.AuthenticatedLength {
    clientOptions = append(clientOptions, vmess.ClientWithAuthenticatedLength())
}
client, _ := vmess.NewClient(options.UUID, security, options.AlterId, clientOptions...)
```

- **GlobalPadding**: يضيف حشواً عشوائياً لجميع الحزم لمقاومة تحليل حركة المرور
- **AuthenticatedLength**: يتضمن طول الحمولة المصادق عليها في الرأس (وضع AEAD)

### إنشاء الاتصال

يعالج النوع `vmessDialer` الاتصال الفعلي:

```go
func (h *vmessDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    // 1. إنشاء الاتصال الأساسي
    //    الأولوية: النقل > TLS > TCP الخام
    if h.transport != nil {
        conn = h.transport.DialContext(ctx)
    } else if h.tlsDialer != nil {
        conn = h.tlsDialer.DialTLSContext(ctx, h.serverAddr)
    } else {
        conn = h.dialer.DialContext(ctx, "tcp", h.serverAddr)
    }

    // 2. التغليف ببروتوكول VMess (بيانات مبكرة / 0-RTT)
    switch network {
    case "tcp":
        return h.client.DialEarlyConn(conn, destination)
    case "udp":
        return h.client.DialEarlyPacketConn(conn, destination)
    }
}
```

بالنسبة لـ `ListenPacket`، يحدد وضع الترميز الغلاف:

```go
func (h *vmessDialer) ListenPacket(ctx, destination) (net.PacketConn, error) {
    conn := /* إنشاء الاتصال */
    if h.packetAddr {
        return packetaddr.NewConn(
            h.client.DialEarlyPacketConn(conn, M.Socksaddr{Fqdn: packetaddr.SeqPacketMagicAddress}),
            destination,
        )
    } else if h.xudp {
        return h.client.DialEarlyXUDPPacketConn(conn, destination)
    } else {
        return h.client.DialEarlyPacketConn(conn, destination)
    }
}
```

## دعم Mux

يتم دعم تعدد الإرسال عبر حزمة `common/mux`. من جانب الوارد، يتم تغليف الموجه بـ `mux.NewRouterWithOptions()`. من جانب الصادر، يغلف `mux.Client` متصل VMess:

```go
outbound.multiplexDialer, _ = mux.NewClientWithOptions((*vmessDialer)(outbound), logger, options.Multiplex)
```

عندما يكون mux نشطاً، يفوض `DialContext` و`ListenPacket` إلى عميل mux بدلاً من إنشاء اتصالات VMess فردية.

## الاختلافات عن Xray-core

| الجانب | sing-box | Xray-core |
|--------|----------|-----------|
| التنفيذ | يفوض إلى مكتبة `sing-vmess` | تنفيذ مدمج |
| AlterId | مدعوم لكن AEAD مفضل | دعم كامل للقديم |
| XUDP | مدعوم عبر `sing-vmess` | تنفيذ أصلي |
| حماية الرأس | معطلة عند وجود نقل | نشطة دائماً |
| أمان تلقائي | "zero" عند وجود TLS | "auto" بناءً على AlterId |
| مزامنة الوقت | تكامل سياق NTP | وقت النظام فقط |

## مثال على التكوين

```json
{
  "type": "vmess",
  "tag": "vmess-in",
  "listen": "::",
  "listen_port": 10086,
  "users": [
    {
      "name": "user1",
      "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
      "alterId": 0
    }
  ],
  "tls": {
    "enabled": true,
    "server_name": "example.com",
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  },
  "transport": {
    "type": "ws",
    "path": "/vmess"
  },
  "multiplex": {
    "enabled": true
  }
}
```

```json
{
  "type": "vmess",
  "tag": "vmess-out",
  "server": "example.com",
  "server_port": 10086,
  "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
  "security": "auto",
  "alter_id": 0,
  "global_padding": true,
  "authenticated_length": true,
  "packet_encoding": "xudp",
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  },
  "transport": {
    "type": "ws",
    "path": "/vmess"
  }
}
```
