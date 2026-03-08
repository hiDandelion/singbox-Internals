# نظرة عامة على البروتوكولات

يدعم sing-box أكثر من 20 بروتوكول وكيل (proxy)، وجميعها تتبع نمط محول (adapter) موحد. تطبيقات البروتوكولات هي أغلفة خفيفة تفوض معالجة تنسيق البيانات الفعلي إلى مكتبات `sing-*`.

**المصدر**: `protocol/`، `include/`

## نمط التسجيل

يسجل كل بروتوكول نفسه عبر نظام التضمين (include):

```go
// include/inbound.go
func InboundRegistry() *inbound.Registry {
    registry := inbound.NewRegistry()
    tun.RegisterInbound(registry)
    vless.RegisterInbound(registry)
    vmess.RegisterInbound(registry)
    trojan.RegisterInbound(registry)
    // ...
    return registry
}
```

يوفر كل بروتوكول دالة تسجيل:

```go
// protocol/vless/inbound.go
func RegisterInbound(registry adapter.InboundRegistry) {
    inbound.Register[option.VLESSInboundOptions](registry, C.TypeVLESS, NewInbound)
}
```

تربط الدالة العامة `Register` بين: `(نوع string، نوع الخيارات) ← دالة المصنع`.

## نمط الوارد (Inbound)

تتبع جميع الواردات هذا الهيكل:

```go
type Inbound struct {
    myInboundAdapter  // محول مضمن يحتوي على Tag()، Type()
    ctx      context.Context
    router   adapter.ConnectionRouterEx
    logger   log.ContextLogger
    listener *listener.Listener    // مستمع TCP
    service  *someprotocol.Service // خدمة البروتوكول
}

func NewInbound(ctx, router, logger, tag string, options) (adapter.Inbound, error) {
    // 1. إنشاء خدمة البروتوكول (من مكتبة sing-*)
    // 2. إنشاء المستمع
    // 3. ربط الخدمة → الموجه لمعالجة الاتصالات
}

func (h *Inbound) Start(stage adapter.StartStage) error {
    // بدء المستمع
}

func (h *Inbound) Close() error {
    // إغلاق المستمع + الخدمة
}

// يُستدعى بواسطة المستمع لكل اتصال جديد
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    // فك تشفير خاص بالبروتوكول يحدث هنا
    // ثم: h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## نمط الصادر (Outbound)

تُنفذ جميع الصادرات واجهة `N.Dialer`:

```go
type Outbound struct {
    myOutboundAdapter  // محول مضمن يحتوي على Tag()، Type()، Network()
    ctx       context.Context
    dialer    N.Dialer           // المتصل الأساسي (قد يكون تحويلة)
    transport *v2ray.Transport   // نقل V2Ray اختياري
    // خيارات خاصة بالبروتوكول
}

func NewOutbound(ctx, router, logger, tag string, options) (adapter.Outbound, error) {
    // 1. إنشاء المتصل الأساسي (افتراضي أو تحويلة)
    // 2. إنشاء نقل V2Ray إذا تم تكوينه
    // 3. تكوين خيارات البروتوكول
}

func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    // 1. الاتصال بالنقل
    // 2. تنفيذ مصافحة البروتوكول
    // 3. إرجاع الاتصال المغلف
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    // للبروتوكولات التي تدعم UDP
}
```

## فئات البروتوكولات

### بروتوكولات الوكيل (عميل/خادم)
| البروتوكول | وارد | صادر | المكتبة |
|----------|---------|----------|---------|
| VLESS | نعم | نعم | `sing-vmess` |
| VMess | نعم | نعم | `sing-vmess` |
| Trojan | نعم | نعم | `transport/trojan` (مدمج) |
| Shadowsocks | نعم | نعم | `sing-shadowsocks` / `sing-shadowsocks2` |
| ShadowTLS | نعم | نعم | `sing-shadowtls` |
| Hysteria2 | نعم | نعم | `sing-quic` |
| TUIC | نعم | نعم | `sing-quic` |
| AnyTLS | نعم | نعم | `sing-anytls` |
| NaiveProxy | نعم | نعم | مدمج |
| WireGuard | نقطة نهاية | نقطة نهاية | `wireguard-go` |
| Tailscale | نقطة نهاية | نقطة نهاية | `tailscale` |

### بروتوكولات الوكيل المحلية
| البروتوكول | وارد | صادر |
|----------|---------|----------|
| SOCKS4/5 | نعم | نعم |
| HTTP | نعم | نعم |
| Mixed (SOCKS+HTTP) | نعم | - |
| Redirect | نعم | - |
| TProxy | نعم | - |
| TUN | نعم | - |

### بروتوكولات الأدوات المساعدة
| البروتوكول | الغرض |
|----------|---------|
| Direct | اتصال صادر مباشر |
| Block | إسقاط جميع الاتصالات |
| DNS | التوجيه إلى موجه DNS |
| Selector | اختيار يدوي للصادر |
| URLTest | اختيار تلقائي بناءً على زمن الاستجابة |
| SSH | نفق SSH |
| Tor | شبكة Tor |

## تكامل نقل V2Ray

تدعم العديد من البروتوكولات وسائل نقل متوافقة مع V2Ray:

```go
// إنشاء النقل من الخيارات
transport, err := v2ray.NewServerTransport(ctx, logger, common.PtrValueOrDefault(options.Transport), tlsConfig, handler)

// أو من جانب العميل
transport, err := v2ray.NewClientTransport(ctx, dialer, serverAddr, common.PtrValueOrDefault(options.Transport), tlsConfig)
```

وسائل النقل المدعومة: WebSocket، gRPC، HTTP/2، HTTPUpgrade، QUIC.

## تكامل تعدد الإرسال (Multiplex)

يمكن للصادرات التغليف بتعدد الإرسال:

```go
if options.Multiplex != nil && options.Multiplex.Enabled {
    outbound.multiplexDialer, err = mux.NewClientWithOptions(ctx, outbound, muxOptions)
}
```

## سلسلة المعالجة

```
مستمع الوارد → فك تشفير البروتوكول → الموجه → مطابقة القاعدة → اختيار الصادر
    ↓                                                          ↓
قبول TCP/UDP                                          تشفير البروتوكول
    ↓                                                          ↓
خدمة البروتوكول                                        اتصال النقل
    ↓                                                          ↓
استخراج الوجهة                                     الاتصال البعيد
    ↓                                                          ↓
التوجيه إلى الصادر ─────────────────────────────→ ConnectionManager.Copy
```

## الاختلافات الرئيسية عن Xray-core

| الجانب | Xray-core | sing-box |
|--------|----------|----------|
| تنسيق البيانات | تشفير مدمج | مكتبة `sing-*` |
| نموذج الوارد | `proxy.Inbound.Process()` يُرجع Link | `adapter.Inbound` ← استدعاء الموجه |
| نموذج الصادر | `proxy.Outbound.Process()` مع Link | واجهة `N.Dialer` (DialContext/ListenPacket) |
| تدفق البيانات | Pipe Reader/Writer | net.Conn/PacketConn مباشر |
| Mux | mux مدمج + XUDP | مكتبة `sing-mux` |
| Vision/XTLS | مدمج في proxy.go | غير مدعوم (نهج مختلف) |
