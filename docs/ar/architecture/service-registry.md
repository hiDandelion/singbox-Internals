# سجل الخدمات

يستخدم sing-box `context.Context` في Go كحاوي خدمات لحقن التبعيات. هذا يلغي الكائنات المفردة العامة ويجعل رسم التبعيات صريحاً.

**المصدر**: `github.com/sagernet/sing/service`، `box.go`، `include/`

## كيف يعمل

توفر حزمة `sing/service` تسجيل خدمات مكتوب:

```go
// تسجيل خدمة في السياق
func ContextWith[T any](ctx context.Context, service T) context.Context

// استرجاع خدمة من السياق
func FromContext[T any](ctx context.Context) T

// التسجيل مع إثارة خطأ عند التكرار
func MustRegister[T any](ctx context.Context, service T)
```

تُفهرس الخدمات بواسطة **نوع الواجهة** وليس النوع الملموس. هذا يعني:

```go
// تسجيل NetworkManager
service.MustRegister[adapter.NetworkManager](ctx, networkManager)

// أي كود لديه السياق يمكنه استرجاعه
nm := service.FromContext[adapter.NetworkManager](ctx)
```

## التسجيل في Box.New()

أثناء `Box.New()`، يتم تسجيل جميع المديرين:

```go
// إنشاء المديرين
endpointManager := endpoint.NewManager(...)
inboundManager := inbound.NewManager(...)
outboundManager := outbound.NewManager(...)
dnsTransportManager := dns.NewTransportManager(...)
serviceManager := boxService.NewManager(...)

// التسجيل في السياق
service.MustRegister[adapter.EndpointManager](ctx, endpointManager)
service.MustRegister[adapter.InboundManager](ctx, inboundManager)
service.MustRegister[adapter.OutboundManager](ctx, outboundManager)
service.MustRegister[adapter.DNSTransportManager](ctx, dnsTransportManager)
service.MustRegister[adapter.ServiceManager](ctx, serviceManager)

// تسجيل الموجّه ومدير الشبكة وموجّه DNS ومدير الاتصالات أيضاً
service.MustRegister[adapter.Router](ctx, router)
service.MustRegister[adapter.NetworkManager](ctx, networkManager)
service.MustRegister[adapter.DNSRouter](ctx, dnsRouter)
service.MustRegister[adapter.ConnectionManager](ctx, connectionManager)
```

## نمط السجل

تُسجّل أنواع البروتوكولات عبر سجلات مكتوبة:

```go
type InboundRegistry interface {
    option.InboundOptionsRegistry
    Create(ctx, router, logger, tag, inboundType string, options any) (Inbound, error)
}

type OutboundRegistry interface {
    option.OutboundOptionsRegistry
    CreateOutbound(ctx, router, logger, tag, outboundType string, options any) (Outbound, error)
}
```

### كيف تُملأ السجلات

تستخدم حزمة `include/` وسوم البناء لتسجيل أنواع البروتوكولات:

```go
// include/inbound.go
func InboundRegistry() *inbound.Registry {
    registry := inbound.NewRegistry()
    tun.RegisterInbound(registry)
    socks.RegisterInbound(registry)
    http.RegisterInbound(registry)
    mixed.RegisterInbound(registry)
    direct.RegisterInbound(registry)
    // ... جميع أنواع البروتوكولات
    return registry
}
```

كل بروتوكول يسجّل نفسه:

```go
// protocol/vless/inbound.go
func RegisterInbound(registry adapter.InboundRegistry) {
    inbound.Register[option.VLESSInboundOptions](registry, C.TypeVLESS, NewInbound)
}
```

تربط الدالة العامة `Register` بين: سلسلة النوع ← نوع الخيارات ← دالة المصنع.

## تهيئة السياق

تعد الدالة `box.Context()` السياق بالسجلات:

```go
func Context(
    ctx context.Context,
    inboundRegistry adapter.InboundRegistry,
    outboundRegistry adapter.OutboundRegistry,
    endpointRegistry adapter.EndpointRegistry,
    dnsTransportRegistry adapter.DNSTransportRegistry,
    serviceRegistry adapter.ServiceRegistry,
) context.Context {
    ctx = service.ContextWith[adapter.InboundRegistry](ctx, inboundRegistry)
    ctx = service.ContextWith[adapter.OutboundRegistry](ctx, outboundRegistry)
    // ... إلخ.
    return ctx
}
```

تُستدعى هذه قبل `Box.New()`، عادةً في `cmd/sing-box/main.go`:

```go
ctx = box.Context(ctx,
    include.InboundRegistry(),
    include.OutboundRegistry(),
    include.EndpointRegistry(),
    include.DNSTransportRegistry(),
    include.ServiceRegistry(),
)
instance, err := box.New(box.Options{
    Context: ctx,
    Options: options,
})
```

## التسجيل المزدوج

يتم تسجيل كل من سجل الخيارات وسجل المحوّل:

```go
ctx = service.ContextWith[option.InboundOptionsRegistry](ctx, inboundRegistry)
ctx = service.ContextWith[adapter.InboundRegistry](ctx, inboundRegistry)
```

يُستخدم سجل الخيارات أثناء تحليل JSON لتحديد نوع هيكل الخيارات الصحيح. يُستخدم سجل المحوّل أثناء `Box.New()` لإنشاء النسخ من الخيارات.

## الاستخدام في المكونات

أي مكون لديه وصول إلى السياق يمكنه استرجاع الخدمات:

```go
// في مُنشئ الموجّه
func NewRouter(ctx context.Context, ...) *Router {
    return &Router{
        inbound:  service.FromContext[adapter.InboundManager](ctx),
        outbound: service.FromContext[adapter.OutboundManager](ctx),
        dns:      service.FromContext[adapter.DNSRouter](ctx),
        network:  service.FromContext[adapter.NetworkManager](ctx),
        // ...
    }
}
```

## المقارنة مع Xray-core

| الجانب | Xray-core | sing-box |
|--------|----------|----------|
| نمط حقن التبعيات | `RequireFeatures` + انعكاس | بحث مكتوب مبني على السياق |
| التسجيل | سجل ميزات عام على Instance | سجل خدمات لكل سياق |
| الحل | كسول (يُحل عند توفر جميع التبعيات) | فوري (يُحل وقت الإنشاء) |
| أمان الأنواع | تأكيد أنواع وقت التشغيل | أنواع عامة وقت الترجمة |
| دورة الحياة | Feature.Start() يُستدعى بواسطة Instance | Start(stage) متعدد المراحل |
