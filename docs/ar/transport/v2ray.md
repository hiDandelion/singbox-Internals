# مصنع نقل V2Ray

المصدر: `transport/v2ray/transport.go`، `transport/v2ray/quic.go`، `transport/v2ray/grpc.go`، `transport/v2ray/grpc_lite.go`

## نمط المصنع

يستخدم مصنع نقل V2Ray أسماء أنواع عامة ومُوزِّع تبديل أنواع لإنشاء وسائل نقل الخادم والعميل. هذه هي نقطة الدخول الوحيدة لإنشاء جميع وسائل نقل V2Ray.

### أنواع المُنشئ العامة

```go
type (
    ServerConstructor[O any] func(
        ctx context.Context,
        logger logger.ContextLogger,
        options O,
        tlsConfig tls.ServerConfig,
        handler adapter.V2RayServerTransportHandler,
    ) (adapter.V2RayServerTransport, error)

    ClientConstructor[O any] func(
        ctx context.Context,
        dialer N.Dialer,
        serverAddr M.Socksaddr,
        options O,
        tlsConfig tls.Config,
    ) (adapter.V2RayClientTransport, error)
)
```

تُعامل هذه الأنواع العامة هيكل الخيارات `O` كمعامل، مما يسمح لكل نقل بتعريف نوع إعداداته الخاص مع مشاركة نفس توقيع المُنشئ.

### توزيع نقل الخادم

```go
func NewServerTransport(ctx context.Context, logger logger.ContextLogger,
    options option.V2RayTransportOptions, tlsConfig tls.ServerConfig,
    handler adapter.V2RayServerTransportHandler) (adapter.V2RayServerTransport, error) {
    if options.Type == "" {
        return nil, nil
    }
    switch options.Type {
    case C.V2RayTransportTypeHTTP:
        return v2rayhttp.NewServer(ctx, logger, options.HTTPOptions, tlsConfig, handler)
    case C.V2RayTransportTypeWebsocket:
        return v2raywebsocket.NewServer(ctx, logger, options.WebsocketOptions, tlsConfig, handler)
    case C.V2RayTransportTypeQUIC:
        if tlsConfig == nil {
            return nil, C.ErrTLSRequired
        }
        return NewQUICServer(ctx, logger, options.QUICOptions, tlsConfig, handler)
    case C.V2RayTransportTypeGRPC:
        return NewGRPCServer(ctx, logger, options.GRPCOptions, tlsConfig, handler)
    case C.V2RayTransportTypeHTTPUpgrade:
        return v2rayhttpupgrade.NewServer(ctx, logger, options.HTTPUpgradeOptions, tlsConfig, handler)
    default:
        return nil, E.New("unknown transport type: " + options.Type)
    }
}
```

السلوكيات الرئيسية:
- النوع الفارغ يُرجع `nil, nil` (لم يتم تعيين نقل)
- QUIC يتطلب TLS -- يُرجع `C.ErrTLSRequired` إذا كان `tlsConfig` فارغًا
- HTTP وWebSocket وHTTP Upgrade يُستوردون ويُستدعون مباشرة
- gRPC وQUIC يُوزَّعان عبر دوال وسيطة تتعامل مع تبديل علامات البناء

### توزيع نقل العميل

يتبع `NewClientTransport` نفس النمط. يستقبل متغير العميل `N.Dialer` و `M.Socksaddr` بدلاً من المعالج:

```go
func NewClientTransport(ctx context.Context, dialer N.Dialer, serverAddr M.Socksaddr,
    options option.V2RayTransportOptions, tlsConfig tls.Config) (adapter.V2RayClientTransport, error)
```

لاحظ أن إعدادات TLS هي `tls.Config` (واجهة العميل) مقابل `tls.ServerConfig` (واجهة الخادم).

## نمط تسجيل QUIC

يتطلب نقل QUIC علامة البناء `with_quic`. بما أن حزمة `v2ray` الأساسية لا تستطيع استيراد `v2rayquic` مباشرة (التي قد لا تكون مُترجَمة)، فإنها تستخدم نمط تسجيل:

```go
// quic.go
var (
    quicServerConstructor ServerConstructor[option.V2RayQUICOptions]
    quicClientConstructor ClientConstructor[option.V2RayQUICOptions]
)

func RegisterQUICConstructor(
    server ServerConstructor[option.V2RayQUICOptions],
    client ClientConstructor[option.V2RayQUICOptions],
) {
    quicServerConstructor = server
    quicClientConstructor = client
}

func NewQUICServer(...) (adapter.V2RayServerTransport, error) {
    if quicServerConstructor == nil {
        return nil, os.ErrInvalid
    }
    return quicServerConstructor(ctx, logger, options, tlsConfig, handler)
}
```

تُسجِّل حزمة `v2rayquic` نفسها عبر `init()`:

```go
// v2rayquic/init.go
//go:build with_quic

func init() {
    v2ray.RegisterQUICConstructor(NewServer, NewClient)
}
```

إذا تمت الترجمة بدون `with_quic`، تبقى المُنشئات فارغة (nil)، ويُرجع `NewQUICServer`/`NewQUICClient` الخطأ `os.ErrInvalid`.

## تبديل علامات بناء gRPC

يحتوي gRPC على تنفيذين يُتحكم بهما عبر علامات البناء:

**مع `with_grpc` (grpc.go)**:

```go
//go:build with_grpc

func NewGRPCServer(...) (adapter.V2RayServerTransport, error) {
    if options.ForceLite {
        return v2raygrpclite.NewServer(ctx, logger, options, tlsConfig, handler)
    }
    return v2raygrpc.NewServer(ctx, logger, options, tlsConfig, handler)
}
```

عندما تكون مكتبة gRPC الكاملة متاحة، لا يزال بإمكان المستخدم فرض التنفيذ الخفيف عبر `options.ForceLite`.

**بدون `with_grpc` (grpc_lite.go)**:

```go
//go:build !with_grpc

func NewGRPCServer(...) (adapter.V2RayServerTransport, error) {
    return v2raygrpclite.NewServer(ctx, logger, options, tlsConfig, handler)
}
```

بدون علامة البناء، يُستخدم التنفيذ الخفيف دائمًا بغض النظر عن `ForceLite`.

## الإعدادات

```json
{
  "transport": {
    "type": "ws",
    "path": "/path",
    "headers": {
      "Host": "example.com"
    },
    "max_early_data": 2048,
    "early_data_header_name": "Sec-WebSocket-Protocol"
  }
}
```

يحتوي هيكل `V2RayTransportOptions` على نص `Type` وهياكل خيارات فرعية لكل نوع نقل (`HTTPOptions`، `WebsocketOptions`، `QUICOptions`، `GRPCOptions`، `HTTPUpgradeOptions`). تُستخدم فقط الخيارات الفرعية المطابقة للنوع المحدد.
