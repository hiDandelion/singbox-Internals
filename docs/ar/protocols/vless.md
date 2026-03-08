# بروتوكول VLESS

VLESS هو بروتوكول وكيل خفيف يستخدم مصادقة قائمة على UUID. يفوض sing-box تنسيق بيانات VLESS إلى مكتبة `sing-vmess/vless`.

**المصدر**: `protocol/vless/`، `sing-vmess/vless/`

## بنية الوارد (Inbound)

```go
type Inbound struct {
    inbound.Adapter
    ctx       context.Context
    router    adapter.ConnectionRouterEx
    logger    logger.ContextLogger
    listener  *listener.Listener
    users     []option.VLESSUser
    service   *vless.Service[int]     // خدمة VLESS من sing-vmess
    tlsConfig tls.ServerConfig
    transport adapter.V2RayServerTransport
}
```

### البناء

```go
func NewInbound(ctx, router, logger, tag, options) (adapter.Inbound, error) {
    // 1. إنشاء غلاف موجه UoT (معالجة UDP-over-TCP)
    inbound.router = uot.NewRouter(router, logger)

    // 2. إنشاء غلاف موجه mux (معالجة تعدد الإرسال)
    inbound.router = mux.NewRouterWithOptions(inbound.router, logger, options.Multiplex)

    // 3. إنشاء خدمة VLESS مع قائمة المستخدمين
    service := vless.NewService[int](logger, adapter.NewUpstreamContextHandlerEx(
        inbound.newConnectionEx,        // معالج TCP
        inbound.newPacketConnectionEx,   // معالج UDP
    ))
    service.UpdateUsers(indices, uuids, flows)

    // 4. تكوين TLS (اختياري)
    inbound.tlsConfig = tls.NewServerWithOptions(...)
    // متوافق مع kTLS فقط عندما: لا يوجد نقل، لا يوجد mux، لا يوجد تدفق (Vision)

    // 5. نقل V2Ray (اختياري: WS، gRPC، HTTP، إلخ)
    inbound.transport = v2ray.NewServerTransport(ctx, ..., inbound.tlsConfig, handler)

    // 6. مستمع TCP
    inbound.listener = listener.New(...)
}
```

### تدفق الاتصال

```
اتصال TCP → [مصافحة TLS] → VLESS Service.NewConnection()
                                          ↓
                                   فك تشفير رأس VLESS
                                   مصادقة UUID
                                   استخراج الوجهة
                                          ↓
                                   newConnectionEx() / newPacketConnectionEx()
                                          ↓
                                   تعيين البيانات الوصفية (Inbound، User)
                                          ↓
                                   router.RouteConnectionEx()
```

عند تكوين نقل V2Ray:
```
اتصال TCP → Transport.Serve() → معالج النقل → [TLS تمت معالجته مسبقاً] → خدمة VLESS
```

### توافق kTLS

يتم تفعيل kTLS (TLS على مستوى النواة) عندما:
- لا يوجد نقل V2Ray (TCP خام + TLS)
- لا يوجد تعدد إرسال
- لا يوجد تدفق Vision (جميع المستخدمين لديهم تدفق فارغ)

هذا يسمح للنواة بمعالجة تشفير TLS لأداء أفضل.

## بنية الصادر (Outbound)

```go
type Outbound struct {
    outbound.Adapter
    logger          logger.ContextLogger
    dialer          N.Dialer
    client          *vless.Client        // عميل VLESS من sing-vmess
    serverAddr      M.Socksaddr
    multiplexDialer *mux.Client
    tlsConfig       tls.Config
    tlsDialer       tls.Dialer
    transport       adapter.V2RayClientTransport
    packetAddr      bool     // استخدام ترميز packetaddr
    xudp            bool     // استخدام ترميز XUDP (افتراضي)
}
```

### تدفق الاتصال

```go
func (h *vlessDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    // 1. إنشاء اتصال النقل
    if h.transport != nil {
        conn = h.transport.DialContext(ctx)
    } else if h.tlsDialer != nil {
        conn = h.tlsDialer.DialTLSContext(ctx, h.serverAddr)
    } else {
        conn = h.dialer.DialContext(ctx, "tcp", h.serverAddr)
    }

    // 2. مصافحة البروتوكول
    switch network {
    case "tcp":
        return h.client.DialEarlyConn(conn, destination)
    case "udp":
        if h.xudp {
            return h.client.DialEarlyXUDPPacketConn(conn, destination)
        } else if h.packetAddr {
            packetConn = h.client.DialEarlyPacketConn(conn, packetaddr.SeqPacketMagicAddress)
            return packetaddr.NewConn(packetConn, destination)
        } else {
            return h.client.DialEarlyPacketConn(conn, destination)
        }
    }
}
```

### البيانات المبكرة (Early Data)

تؤجل `DialEarlyConn` مصافحة VLESS حتى أول عملية كتابة. يتم إرسال رأس VLESS مع أول حزمة بيانات، مما يقلل عدد الرحلات ذهاباً وإياباً.

### تعدد الإرسال (Multiplex)

عند تفعيل تعدد الإرسال:

```go
outbound.multiplexDialer = mux.NewClientWithOptions((*vlessDialer)(outbound), logger, options.Multiplex)
```

يغلف عميل mux متصل VLESS. تتشارك اتصالات منطقية متعددة في اتصال VLESS واحد.

## ترميز حزم UDP

يدعم VLESS ثلاثة أوضاع لترميز UDP:

### XUDP (افتراضي)

عنونة لكل حزمة -- كل حزمة UDP تحمل عنوان وجهتها الخاص. يتيح NAT من نوع Full-Cone.

```go
h.client.DialEarlyXUDPPacketConn(conn, destination)
```

### PacketAddr

مشابه لـ XUDP لكن يستخدم تنسيق بيانات مختلف (`packetaddr.SeqPacketMagicAddress`).

### القديم (Legacy)

ترميز حزم VLESS بسيط -- جميع الحزم تذهب إلى نفس الوجهة.

```go
h.client.DialEarlyPacketConn(conn, destination)
```

## التكوين

```json
{
  "inbounds": [{
    "type": "vless",
    "listen": ":443",
    "users": [
      { "uuid": "...", "name": "user1", "flow": "" }
    ],
    "tls": { ... },
    "transport": { "type": "ws", "path": "/vless" },
    "multiplex": { "enabled": true }
  }],
  "outbounds": [{
    "type": "vless",
    "server": "example.com",
    "server_port": 443,
    "uuid": "...",
    "flow": "",
    "packet_encoding": "xudp",
    "tls": { ... },
    "transport": { "type": "ws", "path": "/vless" },
    "multiplex": { "enabled": true }
  }]
}
```

## الاختلافات الرئيسية عن VLESS في Xray-core

| الجانب | Xray-core | sing-box |
|--------|----------|----------|
| Vision/XTLS | دعم كامل (unsafe.Pointer) | غير مدعوم |
| تنسيق البيانات | تشفير مدمج | مكتبة `sing-vmess/vless` |
| Fallback | مدمج (name←ALPN←path) | غير مدعوم (استخدم مستمعاً منفصلاً) |
| XUDP | مدمج مع GlobalID | XUDP من `sing-vmess` |
| Mux | إطارات mux مدمجة | `sing-mux` (قائم على smux) |
| تدفق البيانات | Pipe Reader/Writer | تمرير net.Conn |
| الاتصال المسبق | مجمع اتصالات | غير مدمج |

## تنسيق البيانات (من sing-vmess)

### رأس الطلب
```
[1B Version=0x00]
[16B UUID]
[1B Addons length (N)]
[NB Addons protobuf]
[1B Command: 0x01=TCP, 0x02=UDP, 0x03=Mux]
[Address: Port(2B) + Type(1B) + Addr(var)]
```

### رأس الاستجابة
```
[1B Version=0x00]
[1B Addons length]
[NB Addons]
```

تنسيق البيانات متوافق مع VLESS في Xray-core.
