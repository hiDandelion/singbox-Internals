# تعدد الاتصالات (sing-mux)

المصدر: `common/mux/client.go`، `common/mux/router.go`

## نظرة عامة

يدمج sing-box مكتبة `github.com/sagernet/sing-mux` لتعدد الاتصالات، مما يسمح بتدفقات منطقية متعددة عبر اتصال أساسي واحد. يدعم اختياريًا التحكم في الازدحام Brutal لفرض عرض النطاق الترددي.

## العميل

يُغلِّف العميل `N.Dialer` بقدرات التعدد:

```go
type Client = mux.Client

func NewClientWithOptions(dialer N.Dialer, logger logger.Logger, options option.OutboundMultiplexOptions) (*Client, error) {
    if !options.Enabled {
        return nil, nil
    }
    var brutalOptions mux.BrutalOptions
    if options.Brutal != nil && options.Brutal.Enabled {
        brutalOptions = mux.BrutalOptions{
            Enabled:    true,
            SendBPS:    uint64(options.Brutal.UpMbps * C.MbpsToBps),
            ReceiveBPS: uint64(options.Brutal.DownMbps * C.MbpsToBps),
        }
        if brutalOptions.SendBPS < mux.BrutalMinSpeedBPS {
            return nil, E.New("brutal: invalid upload speed")
        }
        if brutalOptions.ReceiveBPS < mux.BrutalMinSpeedBPS {
            return nil, E.New("brutal: invalid download speed")
        }
    }
    return mux.NewClient(mux.Options{
        Dialer:         &clientDialer{dialer},
        Logger:         logger,
        Protocol:       options.Protocol,
        MaxConnections: options.MaxConnections,
        MinStreams:      options.MinStreams,
        MaxStreams:      options.MaxStreams,
        Padding:        options.Padding,
        Brutal:         brutalOptions,
    })
}
```

### تجاوز السياق

يُغلِّف طالب اتصال العميل الطالب الأصلي لتطبيق تجاوزات السياق:

```go
type clientDialer struct {
    N.Dialer
}

func (d *clientDialer) DialContext(ctx context.Context, network string, destination M.Socksaddr) (net.Conn, error) {
    return d.Dialer.DialContext(adapter.OverrideContext(ctx), network, destination)
}
```

### التحكم في الازدحام Brutal

يفرض Brutal عرض نطاق ترددي ثابت عبر تحديد سرعات الرفع والتنزيل بالميغابت في الثانية. تُحوَّل السرعات إلى بايت في الثانية باستخدام `C.MbpsToBps`. يُفرض حد أدنى للسرعة (`mux.BrutalMinSpeedBPS`) لمنع الإعداد الخاطئ.

## الخادم (الموجه)

يستخدم جانب الخادم غلاف `Router` يعترض الاتصالات المُعلَّمة بالتعدد:

```go
type Router struct {
    router  adapter.ConnectionRouterEx
    service *mux.Service
}

func NewRouterWithOptions(router adapter.ConnectionRouterEx, logger logger.ContextLogger, options option.InboundMultiplexOptions) (adapter.ConnectionRouterEx, error) {
    if !options.Enabled {
        return router, nil
    }
    service, err := mux.NewService(mux.ServiceOptions{
        NewStreamContext: func(ctx context.Context, conn net.Conn) context.Context {
            return log.ContextWithNewID(ctx)
        },
        Logger:    logger,
        HandlerEx: adapter.NewRouteContextHandlerEx(router),
        Padding:   options.Padding,
        Brutal:    brutalOptions,
    })
    return &Router{router, service}, nil
}
```

### توجيه الاتصالات

يتحقق الموجه من الوجهة مقابل `mux.Destination` للكشف عن الاتصالات المُتعددة:

```go
func (r *Router) RouteConnectionEx(ctx context.Context, conn net.Conn, metadata adapter.InboundContext, onClose N.CloseHandlerFunc) {
    if metadata.Destination == mux.Destination {
        r.service.NewConnectionEx(adapter.WithContext(ctx, &metadata), conn,
            metadata.Source, metadata.Destination, onClose)
        return
    }
    r.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

`mux.Destination` هو عنوان حارس يُشير إلى اتصال مُتعدد. الاتصالات غير المُتعددة تمر إلى الموجه الأساسي بدون تغيير.

كل تدفق مُفكَّك يحصل على معرف سجل جديد عبر `NewStreamContext`.

## الإعدادات

### الصادر (العميل)

```json
{
  "multiplex": {
    "enabled": true,
    "protocol": "smux",
    "max_connections": 4,
    "min_streams": 4,
    "max_streams": 0,
    "padding": false,
    "brutal": {
      "enabled": true,
      "up_mbps": 100,
      "down_mbps": 100
    }
  }
}
```

### الوارد (الخادم)

```json
{
  "multiplex": {
    "enabled": true,
    "padding": false,
    "brutal": {
      "enabled": true,
      "up_mbps": 100,
      "down_mbps": 100
    }
  }
}
```

| الحقل | الوصف |
|-------|-------------|
| `protocol` | بروتوكول التعدد (h2mux، smux، yamux) |
| `max_connections` | الحد الأقصى للاتصالات الأساسية |
| `min_streams` | الحد الأدنى للتدفقات لكل اتصال قبل فتح اتصال جديد |
| `max_streams` | الحد الأقصى للتدفقات لكل اتصال (0 = بلا حد) |
| `padding` | تفعيل الحشو لمقاومة تحليل حركة المرور |
| `brutal.up_mbps` | سرعة الرفع بالميغابت في الثانية للتحكم في الازدحام Brutal |
| `brutal.down_mbps` | سرعة التنزيل بالميغابت في الثانية للتحكم في الازدحام Brutal |
