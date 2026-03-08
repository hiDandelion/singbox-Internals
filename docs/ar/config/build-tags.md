# علامات البناء والتجميع الشرطي

يستخدم sing-box علامات بناء Go للتحكم في البروتوكولات والنقل والميزات المُجمعة في الملف الثنائي. يسمح هذا بإنتاج بناءات بسيطة تتضمن فقط الوظائف المطلوبة.

**المصدر**: `include/`

## الهندسة

يحتوي دليل `include/` على ملف `registry.go` الذي يعرّف تسجيلات البروتوكولات الافتراضية، بالإضافة إلى أزواج من الملفات للميزات الاختيارية: واحد بعلامة الميزة وآخر بنفيها.

### نقطة دخول السجل

```go
// include/registry.go
func Context(ctx context.Context) context.Context {
    return box.Context(ctx,
        InboundRegistry(),
        OutboundRegistry(),
        EndpointRegistry(),
        DNSTransportRegistry(),
        ServiceRegistry(),
    )
}
```

تنشئ هذه الدالة السياق مع جميع سجلات الأنواع المعبأة، والذي يُستخدم بعد ذلك أثناء تحليل التهيئة. تحدد السجلات أي قيم `type` صالحة للمنافذ الواردة والصادرة ونقاط النهاية وخوادم DNS والخدمات.

## البروتوكولات المضمنة دائماً

هذه البروتوكولات مسجلة بدون شروط في `registry.go`:

### المنافذ الواردة

| النوع | الحزمة | الوصف |
|------|---------|-------------|
| `tun` | `protocol/tun` | واجهة TUN |
| `redirect` | `protocol/redirect` | إعادة توجيه TCP (Linux) |
| `tproxy` | `protocol/redirect` | الوكيل الشفاف (Linux) |
| `direct` | `protocol/direct` | منفذ وارد مباشر |
| `socks` | `protocol/socks` | وكيل SOCKS4/5 |
| `http` | `protocol/http` | وكيل HTTP |
| `mixed` | `protocol/mixed` | وكيل مختلط HTTP + SOCKS5 |
| `shadowsocks` | `protocol/shadowsocks` | Shadowsocks |
| `vmess` | `protocol/vmess` | VMess |
| `trojan` | `protocol/trojan` | Trojan |
| `naive` | `protocol/naive` | NaiveProxy |
| `shadowtls` | `protocol/shadowtls` | ShadowTLS |
| `vless` | `protocol/vless` | VLESS |
| `anytls` | `protocol/anytls` | AnyTLS |

### المنافذ الصادرة

| النوع | الحزمة | الوصف |
|------|---------|-------------|
| `direct` | `protocol/direct` | منفذ صادر مباشر |
| `block` | `protocol/block` | حجب (رفض) |
| `selector` | `protocol/group` | مجموعة اختيار يدوي |
| `urltest` | `protocol/group` | مجموعة اختبار URL تلقائي |
| `socks` | `protocol/socks` | عميل SOCKS5 |
| `http` | `protocol/http` | عميل HTTP CONNECT |
| `shadowsocks` | `protocol/shadowsocks` | عميل Shadowsocks |
| `vmess` | `protocol/vmess` | عميل VMess |
| `trojan` | `protocol/trojan` | عميل Trojan |
| `tor` | `protocol/tor` | عميل Tor |
| `ssh` | `protocol/ssh` | عميل SSH |
| `shadowtls` | `protocol/shadowtls` | عميل ShadowTLS |
| `vless` | `protocol/vless` | عميل VLESS |
| `anytls` | `protocol/anytls` | عميل AnyTLS |

### ناقلات DNS

| النوع | الحزمة | الوصف |
|------|---------|-------------|
| `tcp` | `dns/transport` | DNS عبر TCP |
| `udp` | `dns/transport` | DNS عبر UDP |
| `tls` | `dns/transport` | DNS عبر TLS (DoT) |
| `https` | `dns/transport` | DNS عبر HTTPS (DoH) |
| `hosts` | `dns/transport/hosts` | ملف Hosts |
| `local` | `dns/transport/local` | محلل النظام |
| `fakeip` | `dns/transport/fakeip` | FakeIP |
| `resolved` | `service/resolved` | DNS محلول |

## الميزات المقيدة بعلامات البناء

### QUIC (`with_quic`)

**الملفات**: `include/quic.go`، `include/quic_stub.go`

يمكّن البروتوكولات القائمة على QUIC:

```go
//go:build with_quic

func registerQUICInbounds(registry *inbound.Registry) {
    hysteria.RegisterInbound(registry)
    tuic.RegisterInbound(registry)
    hysteria2.RegisterInbound(registry)
}

func registerQUICOutbounds(registry *outbound.Registry) {
    hysteria.RegisterOutbound(registry)
    tuic.RegisterOutbound(registry)
    hysteria2.RegisterOutbound(registry)
}

func registerQUICTransports(registry *dns.TransportRegistry) {
    quic.RegisterTransport(registry)      // DNS عبر QUIC
    quic.RegisterHTTP3Transport(registry) // DNS عبر HTTP/3
}
```

يمكّن أيضاً:
- نقل V2Ray QUIC (`transport/v2rayquic`)
- دعم QUIC لـ NaiveProxy (`protocol/naive/quic`)

**سلوك البديل** (بدون العلامة): جميع أنواع QUIC تسجل لكن تُرجع `C.ErrQUICNotIncluded`:

```go
//go:build !with_quic

func registerQUICInbounds(registry *inbound.Registry) {
    inbound.Register[option.HysteriaInboundOptions](registry, C.TypeHysteria,
        func(...) (adapter.Inbound, error) {
            return nil, C.ErrQUICNotIncluded
        })
    // ... نفس الشيء لـ TUIC، Hysteria2
}
```

### WireGuard (`with_wireguard`)

**الملفات**: `include/wireguard.go`، `include/wireguard_stub.go`

يمكّن نقطة نهاية WireGuard:

```go
//go:build with_wireguard

func registerWireGuardEndpoint(registry *endpoint.Registry) {
    wireguard.RegisterEndpoint(registry)
}
```

**سلوك البديل**: يُرجع رسالة خطأ توجه المستخدمين لإعادة البناء بالعلامة.

### Clash API (`with_clash_api`)

**الملفات**: `include/clashapi.go`، `include/clashapi_stub.go`

يستخدم Clash API نمط الاستيراد بالأثر الجانبي:

```go
//go:build with_clash_api

import _ "github.com/sagernet/sing-box/experimental/clashapi"
```

دالة `init()` في حزمة `clashapi` تسجل المُنشئ عبر `experimental.RegisterClashServerConstructor(NewServer)`.

**سلوك البديل**: يسجل مُنشئاً يُرجع خطأ.

### V2Ray API (`with_v2ray_api`)

**الملفات**: `include/v2rayapi.go`، `include/v2rayapi_stub.go`

نفس نمط Clash API -- استيراد بالأثر الجانبي يطلق تسجيل `init()`.

### DHCP DNS (`with_dhcp`)

**الملفات**: `include/dhcp.go`، `include/dhcp_stub.go`

يمكّن اكتشاف خادم DNS القائم على DHCP.

### منفذ NaiveProxy الصادر (`with_naive`)

**الملفات**: `include/naive_outbound.go`، `include/naive_outbound_stub.go`

يمكّن NaiveProxy كبروتوكول صادر (عميل).

### Tailscale (`with_tailscale`)

**الملفات**: `include/tailscale.go`، `include/tailscale_stub.go`

يمكّن نقطة نهاية وناقل DNS من Tailscale.

### CCM/OCM

**الملفات**: `include/ccm.go`، `include/ccm_stub.go`، `include/ocm.go`، `include/ocm_stub.go`

خدمات إدارة التهيئة السحابية.

## نمط السجل

يستخدم نمط التسجيل أنواع Go العامة لربط نص نوع بهيكل خيارات:

```go
// دالة تسجيل عامة
func Register[Options any](registry *Registry, typeName string,
    constructor func(ctx, router, logger, tag string, options Options) (adapter.Inbound, error)) {
    registry.register(typeName, func() any { return new(Options) }, constructor)
}
```

يسمح هذا للسجل بـ:
1. إنشاء هيكل خيارات بقيمة صفرية حسب اسم النوع (لتحليل JSON)
2. استدعاء المُنشئ بالخيارات المحللة (لإنشاء النسخة)

### كيف يتدفق التسجيل

```
include/registry.go
  -> InboundRegistry()
       -> tun.RegisterInbound(registry)
            -> inbound.Register[option.TunInboundOptions](registry, "tun", tun.NewInbound)
                 -> registry stores {"tun": {createOptions: () => new(TunInboundOptions), constructor: NewInbound}}

تحليل التهيئة:
  JSON {"type": "tun", ...}
    -> registry.CreateOptions("tun")  => *TunInboundOptions
    -> json.Unmarshal(content, options)
    -> tun.NewInbound(ctx, router, logger, tag, *options)
```

## بدائل البروتوكولات المزالة

بعض البروتوكولات مسجلة كبدائل تُرجع أخطاء وصفية:

```go
func registerStubForRemovedInbounds(registry *inbound.Registry) {
    inbound.Register[option.ShadowsocksInboundOptions](registry, C.TypeShadowsocksR,
        func(...) (adapter.Inbound, error) {
            return nil, E.New("ShadowsocksR is deprecated and removed in sing-box 1.6.0")
        })
}

func registerStubForRemovedOutbounds(registry *outbound.Registry) {
    // ShadowsocksR: أُزيل في 1.6.0
    // منفذ WireGuard الصادر: نُقل إلى نقطة نهاية في 1.11.0، أُزيل في 1.13.0
}
```

## ملفات خاصة بالمنصة

بعض ملفات include خاصة بالمنصة:

| الملف | المنصة | الغرض |
|------|----------|---------|
| `tz_android.go` | Android | معالجة المنطقة الزمنية |
| `tz_ios.go` | iOS | معالجة المنطقة الزمنية |
| `oom_killer.go` | (مقيد بعلامة) | خدمة قتل نفاد الذاكرة |
| `ccm_stub_darwin.go` | Darwin | بديل CCM لـ macOS |

## البناء بالعلامات

```bash
# بناء بسيط (البروتوكولات الأساسية فقط)
go build ./cmd/sing-box

# بناء كامل مع جميع الميزات الاختيارية
go build -tags "with_quic,with_wireguard,with_clash_api,with_v2ray_api,with_dhcp" ./cmd/sing-box

# مجموعة ميزات محددة
go build -tags "with_quic,with_clash_api" ./cmd/sing-box
```

## ملاحظات إعادة التنفيذ

1. **علامات الميزات**: في إعادة التنفيذ، تُترجم علامات البناء إلى علامات ميزات وقت التجميع. Rust يستخدم ميزات Cargo؛ Swift/C++ يستخدمان تعريفات المعالج المسبق. المبدأ الأساسي هو أن البروتوكولات غير المستخدمة يجب ألا تزيد حجم الملف الثنائي
2. **نمط البديل**: عند تعطيل ميزة، يظل sing-box يسجل اسم النوع بحيث ينتج تحليل التهيئة رسالة خطأ مفيدة بدلاً من "نوع غير معروف"
3. **الاستيراد بالأثر الجانبي**: نمط `_ "package"` يطلق دوال `init()`. في إعادة التنفيذ، استخدم استدعاءات تسجيل صريحة بدلاً من ذلك
4. **أنواع السجل العامة**: نمط `Register[Options any]` يربط مخطط JSON والمُنشئ معاً. تحتاج إعادة التنفيذ إلى آلية مكافئة للبناء متعدد الأشكال الآمن من حيث النوع
5. **التسجيلات الافتراضية**: البروتوكولات الأساسية (socks، http، shadowsocks، vmess، trojan، vless، direct، block، selector، urltest) يجب أن تكون متاحة دائماً بدون علامات ميزات
