# بروتوكولات SOCKS وHTTP وMixed

ينفذ sing-box بروتوكولات SOCKS4/5 وHTTP CONNECT ومستمعاً مدمجاً "mixed" يكتشف البروتوكول تلقائياً. تتشارك البروتوكولات الثلاثة في أنماط متشابهة: الاستماع على TCP فقط، TLS اختياري، مصادقة اسم المستخدم/كلمة المرور، ودعم UoT (UDP-over-TCP).

**المصدر**: `protocol/socks/inbound.go`، `protocol/http/inbound.go`، `protocol/mixed/inbound.go`، `protocol/socks/outbound.go`، `protocol/http/outbound.go`

## وارد SOCKS

### البنية

```go
type Inbound struct {
    inbound.Adapter
    router        adapter.ConnectionRouterEx
    logger        logger.ContextLogger
    listener      *listener.Listener
    authenticator *auth.Authenticator
    udpTimeout    time.Duration
}
```

ينفذ وارد SOCKS واجهة `adapter.TCPInjectableInbound`:

```go
var _ adapter.TCPInjectableInbound = (*Inbound)(nil)
```

### معالجة الاتصال

يتم تفويض اتصالات SOCKS إلى `sing/protocol/socks.HandleConnectionEx`، التي تعالج مصافحة SOCKS4/5 الكاملة:

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    err := socks.HandleConnectionEx(ctx, conn, std_bufio.NewReader(conn),
        h.authenticator,
        adapter.NewUpstreamHandlerEx(metadata, h.newUserConnection, h.streamUserPacketConnection),
        h.listener,         // مستمع ربط UDP
        h.udpTimeout,
        metadata.Source,
        onClose,
    )
    N.CloseOnHandshakeFailure(conn, onClose, err)
}
```

يستقبل المعالج اتصالات TCP المفككة واتصالات حزم UDP بعد مصافحة SOCKS:

```go
func (h *Inbound) newUserConnection(ctx, conn, metadata, onClose) {
    metadata.Inbound = h.Tag()
    metadata.InboundType = h.Type()
    user, loaded := auth.UserFromContext[string](ctx)
    if loaded {
        metadata.User = user
    }
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### دعم UoT

يتم تغليف الموجه بدعم UoT لمعالجة UDP-over-TCP:

```go
inbound.router = uot.NewRouter(router, logger)
```

### مستمع TCP فقط

يستمع SOCKS على TCP فقط. يتم معالجة اتصالات ربط UDP من خلال آلية ترحيل UDP في SOCKS5 (باستخدام `listener` كهدف ربط UDP):

```go
inbound.listener = listener.New(listener.Options{
    Network:           []string{N.NetworkTCP},
    ConnectionHandler: inbound,
})
```

## وارد HTTP

### البنية

```go
type Inbound struct {
    inbound.Adapter
    router        adapter.ConnectionRouterEx
    logger        log.ContextLogger
    listener      *listener.Listener
    authenticator *auth.Authenticator
    tlsConfig     tls.ServerConfig
}
```

### دعم TLS مع kTLS

يدعم وارد HTTP تفعيل TLS مع توافق kTLS:

```go
if options.TLS != nil {
    tlsConfig, _ := tls.NewServerWithOptions(tls.ServerOptions{
        KTLSCompatible: true,
    })
    inbound.tlsConfig = tlsConfig
}
```

### معالجة الاتصال

يتم إجراء مصافحة TLS أولاً (إذا تم تكوينها)، ثم يعالج معالج HTTP CONNECT الطلب:

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    if h.tlsConfig != nil {
        tlsConn, _ := tls.ServerHandshake(ctx, conn, h.tlsConfig)
        conn = tlsConn
    }
    err := http.HandleConnectionEx(ctx, conn, std_bufio.NewReader(conn),
        h.authenticator,
        adapter.NewUpstreamHandlerEx(metadata, h.newUserConnection, h.streamUserPacketConnection),
        metadata.Source,
        onClose,
    )
}
```

### وكيل النظام

يمكن لوارد HTTP تكوين نفسه كوكيل النظام:

```go
inbound.listener = listener.New(listener.Options{
    SetSystemProxy:    options.SetSystemProxy,
    SystemProxySOCKS:  false,
})
```

## وارد Mixed

يجمع وارد Mixed بين SOCKS وHTTP على منفذ واحد عن طريق فحص أول بايت من كل اتصال.

### البنية

```go
type Inbound struct {
    inbound.Adapter
    router        adapter.ConnectionRouterEx
    logger        log.ContextLogger
    listener      *listener.Listener
    authenticator *auth.Authenticator
    tlsConfig     tls.ServerConfig
    udpTimeout    time.Duration
}
```

### اكتشاف البروتوكول

المنطق الأساسي يفحص أول بايت لتحديد البروتوكول:

```go
func (h *Inbound) newConnection(ctx, conn, metadata, onClose) error {
    if h.tlsConfig != nil {
        conn = tls.ServerHandshake(ctx, conn, h.tlsConfig)
    }
    reader := std_bufio.NewReader(conn)
    headerBytes, _ := reader.Peek(1)

    switch headerBytes[0] {
    case socks4.Version, socks5.Version:
        // SOCKS4 (0x04) أو SOCKS5 (0x05)
        return socks.HandleConnectionEx(ctx, conn, reader, h.authenticator, ...)
    default:
        // أي شيء آخر يُعامل كـ HTTP
        return http.HandleConnectionEx(ctx, conn, reader, h.authenticator, ...)
    }
}
```

- **SOCKS4**: أول بايت هو `0x04`
- **SOCKS5**: أول بايت هو `0x05`
- **HTTP**: أي بايت أول آخر (عادة `C` لـ CONNECT، `G` لـ GET، إلخ)

### وكيل النظام (Mixed)

عند تعيين mixed كوكيل النظام، يُبلغ عن منفذ SOCKS:

```go
inbound.listener = listener.New(listener.Options{
    SetSystemProxy:    options.SetSystemProxy,
    SystemProxySOCKS:  true,  // الإعلان عن منفذ SOCKS في وكيل النظام
})
```

## صادر SOCKS

يتصل صادر SOCKS عبر خادم SOCKS5 علوي. تم تنفيذه في `protocol/socks/outbound.go` ويستخدم نوع `Client` من مكتبة `sing/protocol/socks`.

## صادر HTTP

يتصل صادر HTTP عبر وكيل HTTP CONNECT علوي. يدعم TLS إلى خادم الوكيل.

## الأنماط المشتركة

### مصادقة المستخدم

تستخدم أنواع الوارد الثلاثة نفس آلية المصادقة:

```go
authenticator := auth.NewAuthenticator(options.Users)
```

المستخدمون هم بنى `auth.User` تحتوي على حقول `Username` و`Password`. يتم تمرير المصادق إلى معالجات البروتوكول.

### البيانات الوصفية للمستخدم

بعد المصادقة، يتم استخراج اسم المستخدم من السياق وتخزينه في البيانات الوصفية:

```go
user, loaded := auth.UserFromContext[string](ctx)
if loaded {
    metadata.User = user
}
```

### TCP القابل للحقن

ينفذ كل من وارد SOCKS وMixed واجهة `adapter.TCPInjectableInbound`، مما يسمح للمكونات الأخرى بحقن اتصالات TCP فيها (تُستخدم بواسطة آليات الوكيل الشفاف).

## أمثلة على التكوين

### وارد SOCKS

```json
{
  "type": "socks",
  "tag": "socks-in",
  "listen": "127.0.0.1",
  "listen_port": 1080,
  "users": [
    { "username": "user1", "password": "pass1" }
  ]
}
```

### وارد HTTP (مع TLS)

```json
{
  "type": "http",
  "tag": "http-in",
  "listen": "127.0.0.1",
  "listen_port": 8080,
  "users": [
    { "username": "user1", "password": "pass1" }
  ],
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  },
  "set_system_proxy": true
}
```

### وارد Mixed

```json
{
  "type": "mixed",
  "tag": "mixed-in",
  "listen": "127.0.0.1",
  "listen_port": 2080,
  "users": [
    { "username": "user1", "password": "pass1" }
  ],
  "set_system_proxy": true
}
```
