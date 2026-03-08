# دورة حياة Box

`Box` هو الحاوي الأعلى مستوى الذي يملك جميع المديرين والخدمات. تتبع دورة حياته نمط بدء متعدد المراحل لمعالجة ترتيب التبعيات المعقد.

**المصدر**: `box.go`، `adapter/lifecycle.go`

## هيكل Box

```go
type Box struct {
    createdAt       time.Time
    logFactory      log.Factory
    logger          log.ContextLogger
    network         *route.NetworkManager
    endpoint        *endpoint.Manager
    inbound         *inbound.Manager
    outbound        *outbound.Manager
    service         *boxService.Manager
    dnsTransport    *dns.TransportManager
    dnsRouter       *dns.Router
    connection      *route.ConnectionManager
    router          *route.Router
    internalService []adapter.LifecycleService  // cache-file, clash-api, v2ray-api, ntp
    done            chan struct{}
}
```

## الإنشاء (`New`)

تبني الدالة `New()` الرسم البياني الكامل للكائنات:

```go
func New(options Options) (*Box, error) {
    ctx := options.Context
    ctx = service.ContextWithDefaultRegistry(ctx)

    // 1. استرجاع السجلات من السياق
    endpointRegistry := service.FromContext[adapter.EndpointRegistry](ctx)
    inboundRegistry := service.FromContext[adapter.InboundRegistry](ctx)
    outboundRegistry := service.FromContext[adapter.OutboundRegistry](ctx)
    dnsTransportRegistry := service.FromContext[adapter.DNSTransportRegistry](ctx)
    serviceRegistry := service.FromContext[adapter.ServiceRegistry](ctx)

    // 2. إنشاء المديرين
    endpointManager := endpoint.NewManager(...)
    inboundManager := inbound.NewManager(...)
    outboundManager := outbound.NewManager(...)
    dnsTransportManager := dns.NewTransportManager(...)
    serviceManager := boxService.NewManager(...)

    // 3. تسجيل المديرين في السياق
    service.MustRegister[adapter.EndpointManager](ctx, endpointManager)
    service.MustRegister[adapter.InboundManager](ctx, inboundManager)
    // ... إلخ.

    // 4. إنشاء الموجّه وموجّه DNS
    dnsRouter := dns.NewRouter(ctx, logFactory, dnsOptions)
    networkManager := route.NewNetworkManager(ctx, ...)
    connectionManager := route.NewConnectionManager(...)
    router := route.NewRouter(ctx, ...)

    // 5. تهيئة قواعد الموجّه
    router.Initialize(routeOptions.Rules, routeOptions.RuleSet)
    dnsRouter.Initialize(dnsOptions.Rules)

    // 6. إنشاء جميع المكونات المُعدّة عبر السجلات
    for _, transportOptions := range dnsOptions.Servers {
        dnsTransportManager.Create(ctx, ..., transportOptions.Type, transportOptions.Options)
    }
    for _, endpointOptions := range options.Endpoints {
        endpointManager.Create(ctx, ..., endpointOptions.Type, endpointOptions.Options)
    }
    for _, inboundOptions := range options.Inbounds {
        inboundManager.Create(ctx, ..., inboundOptions.Type, inboundOptions.Options)
    }
    for _, outboundOptions := range options.Outbounds {
        outboundManager.Create(ctx, ..., outboundOptions.Type, outboundOptions.Options)
    }

    // 7. تعيين الصادر الافتراضي ونقل DNS الافتراضي
    outboundManager.Initialize(func() { return direct.NewOutbound(...) })
    dnsTransportManager.Initialize(func() { return local.NewTransport(...) })

    // 8. إنشاء الخدمات الداخلية (cache-file, clash-api, v2ray-api, ntp)
    // ...
}
```

## مراحل البدء

تستخدم واجهة دورة الحياة تعداد `StartStage`:

```go
type StartStage uint8

const (
    StartStateInitialize StartStage = iota  // المرحلة 0: الإعداد الداخلي
    StartStateStart                          // المرحلة 1: بدء الخدمة
    StartStatePostStart                      // المرحلة 2: خطافات ما بعد البدء
    StartStateStarted                        // المرحلة 3: التنظيف
)

type Lifecycle interface {
    Start(stage StartStage) error
    Close() error
}
```

### ترتيب تنفيذ المراحل

```
PreStart():
  المرحلة 0 (تهيئة): الخدمات الداخلية ← الشبكة ← نقل DNS ← موجّه DNS ←
                       الاتصال ← الموجّه ← الصادر ← الوارد ← نقطة النهاية ← الخدمة
  المرحلة 1 (بدء):   الصادر ← نقل DNS ← موجّه DNS ← الشبكة ←
                       الاتصال ← الموجّه

Start() (استكمال من PreStart):
  المرحلة 1 (بدء):   الخدمات الداخلية ← الوارد ← نقطة النهاية ← الخدمة
  المرحلة 2 (ما بعد البدء): الصادر ← الشبكة ← نقل DNS ← موجّه DNS ←
                       الاتصال ← الموجّه ← الوارد ← نقطة النهاية ← الخدمة ←
                       الخدمات الداخلية
  المرحلة 3 (مُبتدأ): الشبكة ← نقل DNS ← موجّه DNS ← الاتصال ←
                       الموجّه ← الصادر ← الوارد ← نقطة النهاية ← الخدمة ←
                       الخدمات الداخلية
```

### لماذا مراحل متعددة؟

- **تهيئة**: إنشاء الحالة الداخلية، حل التبعيات بين المديرين
- **بدء**: بدء الاستماع/الاتصال. تبدأ الصادرات أولاً (مطلوبة لنقل DNS والواردات)
- **ما بعد البدء**: المهام التي تتطلب تشغيل خدمات أخرى (مثل القواعد التي تشير إلى مجموعات قواعد)
- **مُبتدأ**: تنظيف البيانات المؤقتة، تشغيل جامع القمامة

## الإيقاف

```go
func (s *Box) Close() error {
    close(s.done)  // إشارة الإيقاف

    // الإغلاق بترتيب عكسي للتبعيات:
    // الخدمة ← نقطة النهاية ← الوارد ← الصادر ← الموجّه ←
    // الاتصال ← موجّه DNS ← نقل DNS ← الشبكة

    // ثم الخدمات الداخلية (cache-file, clash-api, إلخ.)
    // ثم المسجّل
}
```

## PreStart مقابل Start

يدعم sing-box وضعين للبدء:

- `Box.Start()` — بدء كامل، يستدعي `preStart()` ثم `start()` داخلياً
- `Box.PreStart()` — بدء جزئي لمنصات الأجهزة المحمولة حيث يجب أن تبدأ الواردات لاحقاً

يهيّئ PreStart كل شيء ويبدأ الصادرات/DNS/الموجّه، لكنه لا يبدأ الواردات/نقاط النهاية/الخدمات. هذا يسمح لطبقة المنصة بإعداد TUN قبل تدفق حركة المرور.

## مراقب المهام

تستخدم كل مرحلة `taskmonitor.New()` لتسجيل العمليات البطيئة:

```go
monitor := taskmonitor.New(s.logger, C.StartTimeout)
monitor.Start("start logger")
err := s.logFactory.Start()
monitor.Finish()
```

إذا تجاوزت مهمة ما `C.StartTimeout` (60 ثانية)، يتم تسجيل تحذير باسم المهمة.
