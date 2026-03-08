# UDP-over-TCP (UoT)

المصدر: `common/uot/router.go`

## نظرة عامة

يُنقل UoT (UDP-over-TCP) حركة مرور UDP عبر اتصالات TCP. يعترض الاتصالات المُوجَّهة إلى عناوين حارسة سحرية ويحولها إلى اتصالات قائمة على الحزم باستخدام `github.com/sagernet/sing/common/uot`.

## العناوين السحرية

عنوانان حارسان يُشيران إلى اتصالات UoT:

- `uot.MagicAddress` -- بروتوكول UoT الحالي مع ترويسة طلب
- `uot.LegacyMagicAddress` -- بروتوكول UoT القديم بدون ترويسة طلب

## الموجه

يُغلِّف `Router` موجه `ConnectionRouterEx` موجودًا ويعترض الاتصالات حسب FQDN الوجهة:

```go
type Router struct {
    router adapter.ConnectionRouterEx
    logger logger.ContextLogger
}

func NewRouter(router adapter.ConnectionRouterEx, logger logger.ContextLogger) *Router {
    return &Router{router, logger}
}
```

### معالجة الاتصالات (متغير Ex)

```go
func (r *Router) RouteConnectionEx(ctx context.Context, conn net.Conn,
    metadata adapter.InboundContext, onClose N.CloseHandlerFunc) {
    switch metadata.Destination.Fqdn {
    case uot.MagicAddress:
        request, err := uot.ReadRequest(conn)
        if err != nil {
            N.CloseOnHandshakeFailure(conn, onClose, err)
            return
        }
        if request.IsConnect {
            r.logger.InfoContext(ctx, "inbound UoT connect connection to ", request.Destination)
        } else {
            r.logger.InfoContext(ctx, "inbound UoT connection to ", request.Destination)
        }
        metadata.Domain = metadata.Destination.Fqdn
        metadata.Destination = request.Destination
        r.router.RoutePacketConnectionEx(ctx, uot.NewConn(conn, *request), metadata, onClose)
        return

    case uot.LegacyMagicAddress:
        r.logger.InfoContext(ctx, "inbound legacy UoT connection")
        metadata.Domain = metadata.Destination.Fqdn
        metadata.Destination = M.Socksaddr{Addr: netip.IPv4Unspecified()}
        r.RoutePacketConnectionEx(ctx, uot.NewConn(conn, uot.Request{}), metadata, onClose)
        return
    }
    r.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### ترويسة طلب UoT

بالنسبة للبروتوكول الحالي (`uot.MagicAddress`)، تُقرأ ترويسة طلب من الاتصال:

- **الوجهة**: عنوان وجهة UDP الفعلي
- **IsConnect**: علامة منطقية تُشير إلى وضع الاتصال مقابل الوضع العادي

في وضع الاتصال، يتصرف الاتصال كمقبس UDP متصل بوجهة واحدة. في الوضع العادي، تحمل كل حزمة عنوان وجهتها الخاص.

### البروتوكول القديم

البروتوكول القديم (`uot.LegacyMagicAddress`) لا يحتوي على ترويسة طلب. تُعيَّن الوجهة إلى `0.0.0.0` (IPv4 غير محدد)، ويُستخدم `Request{}` فارغ.

### التمرير

الاتصالات التي لا تتطابق مع أي عنوان سحري تُمرَّر إلى الموجه الأساسي بدون تغيير:

```go
r.router.RouteConnectionEx(ctx, conn, metadata, onClose)
```

### تحويل اتصال الحزم

يُغلِّف `uot.NewConn(conn, request)` اتصال TCP كـ `N.PacketConn`. يؤطر بروتوكول UoT حزم UDP الفردية داخل تدفق TCP، معالجًا:
- تأطير طول الحزمة
- عنونة الوجهة لكل حزمة (في الوضع غير المتصل)
- تدفق الحزم ثنائي الاتجاه

يُوجَّه اتصال الحزم الناتج بعد ذلك عبر `RoutePacketConnectionEx` للمعالجة القياسية لـ UDP.
