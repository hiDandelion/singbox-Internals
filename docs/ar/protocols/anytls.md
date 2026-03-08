# بروتوكول AnyTLS

AnyTLS هو بروتوكول وكيل قائم على TLS يتميز بتعدد إرسال الجلسات، وأنماط حشو قابلة للتكوين، وإدارة الجلسات الخاملة. يدمج sing-box مكتبة `sing-anytls` الخارجية من مشروع `anytls`.

**المصدر**: `protocol/anytls/inbound.go`، `protocol/anytls/outbound.go`، `sing-anytls`

## نظرة عامة على البنية

```go
// الوارد
type Inbound struct {
    inbound.Adapter
    tlsConfig tls.ServerConfig
    router    adapter.ConnectionRouterEx
    logger    logger.ContextLogger
    listener  *listener.Listener
    service   *anytls.Service
}

// الصادر
type Outbound struct {
    outbound.Adapter
    dialer    tls.Dialer
    server    M.Socksaddr
    tlsConfig tls.Config
    client    *anytls.Client
    uotClient *uot.Client
    logger    log.ContextLogger
}
```

## تنفيذ الوارد

### معالجة TLS

على عكس بروتوكولات مثل Hysteria2 التي تتطلب TLS، يجعل AnyTLS تفعيل TLS اختيارياً على الوارد -- يتم معالجة مصافحة TLS صراحة قبل تمريرها إلى الخدمة:

```go
if options.TLS != nil && options.TLS.Enabled {
    tlsConfig, err := tls.NewServer(ctx, logger, common.PtrValueOrDefault(options.TLS))
    inbound.tlsConfig = tlsConfig
}
```

عند تكوين TLS، يخضع كل اتصال لمصافحة TLS قبل معالجة البروتوكول:

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    if h.tlsConfig != nil {
        tlsConn, err := tls.ServerHandshake(ctx, conn, h.tlsConfig)
        if err != nil {
            N.CloseOnHandshakeFailure(conn, onClose, err)
            return
        }
        conn = tlsConn
    }
    err := h.service.NewConnection(ctx, conn, metadata.Source, onClose)
}
```

### نمط الحشو

يستخدم AnyTLS نمط حشو قابل للتكوين لإخفاء أنماط حركة المرور. يُعرّف النمط كنص متعدد الأسطر:

```go
paddingScheme := padding.DefaultPaddingScheme
if len(options.PaddingScheme) > 0 {
    paddingScheme = []byte(strings.Join(options.PaddingScheme, "\n"))
}

service, _ := anytls.NewService(anytls.ServiceConfig{
    Users:         common.Map(options.Users, func(it option.AnyTLSUser) anytls.User {
        return (anytls.User)(it)
    }),
    PaddingScheme: paddingScheme,
    Handler:       (*inboundHandler)(inbound),
    Logger:        logger,
})
```

### مستمع TCP فقط

يدعم AnyTLS اتصالات TCP فقط:

```go
inbound.listener = listener.New(listener.Options{
    Network:           []string{N.NetworkTCP},
    ConnectionHandler: inbound,
})
```

### نمط معالج الوارد

يستخدم AnyTLS نمط المعالج بتحويل النوع (نفس نمط ShadowTLS). يعالج النوع `Inbound` الاتصالات الخام، بينما يعالج اسم النوع المستعار `inboundHandler` الاتصالات المفككة:

```go
type inboundHandler Inbound

func (h *inboundHandler) NewConnectionEx(ctx, conn, source, destination, onClose) {
    metadata.Destination = destination.Unwrap()
    if userName, _ := auth.UserFromContext[string](ctx); userName != "" {
        metadata.User = userName
    }
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## تنفيذ الصادر

### متطلب TLS

يتطلب الصادر TLS:

```go
if options.TLS == nil || !options.TLS.Enabled {
    return nil, C.ErrTLSRequired
}
```

### عدم توافق TCP Fast Open

AnyTLS غير متوافق صراحة مع TCP Fast Open. ينشئ TFO اتصالات كسولة تؤجل الإنشاء حتى أول عملية كتابة، لكن AnyTLS يحتاج العنوان البعيد أثناء المصافحة:

```go
if options.DialerOptions.TCPFastOpen {
    return nil, E.New("tcp_fast_open is not supported with anytls outbound")
}
```

### تجميع الجلسات

يحافظ العميل على مجمع من جلسات TLS الخاملة لإعادة استخدام الاتصالات. إدارة الجلسات قابلة للتكوين:

```go
client, _ := anytls.NewClient(ctx, anytls.ClientConfig{
    Password:                 options.Password,
    IdleSessionCheckInterval: options.IdleSessionCheckInterval.Build(),
    IdleSessionTimeout:       options.IdleSessionTimeout.Build(),
    MinIdleSession:           options.MinIdleSession,
    DialOut:                  outbound.dialOut,
    Logger:                   logger,
})
```

معاملات الجلسة الرئيسية:
- **IdleSessionCheckInterval**: عدد مرات فحص الجلسات الخاملة
- **IdleSessionTimeout**: المدة قبل إغلاق جلسة خاملة
- **MinIdleSession**: الحد الأدنى لعدد الجلسات الخاملة للحفاظ عليها في المجمع

### دالة الاتصال الخارجي

تنشئ استدعاء `DialOut` اتصالات TLS جديدة لمجمع الجلسات:

```go
func (h *Outbound) dialOut(ctx context.Context) (net.Conn, error) {
    return h.dialer.DialTLSContext(ctx, h.server)
}
```

### اتصالات TCP عبر CreateProxy

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    switch N.NetworkName(network) {
    case N.NetworkTCP:
        return h.client.CreateProxy(ctx, destination)
    case N.NetworkUDP:
        return h.uotClient.DialContext(ctx, network, destination)
    }
}
```

### UDP عبر UoT

يُدعم UDP من خلال UDP-over-TCP باستخدام حزمة `uot`. يغلف عميل UoT طريقة `CreateProxy` لعميل AnyTLS:

```go
outbound.uotClient = &uot.Client{
    Dialer:  (anytlsDialer)(client.CreateProxy),
    Version: uot.Version,
}
```

يحول محول `anytlsDialer` توقيع دالة `CreateProxy` إلى واجهة `N.Dialer`:

```go
type anytlsDialer func(ctx context.Context, destination M.Socksaddr) (net.Conn, error)

func (d anytlsDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    return d(ctx, destination)
}

func (d anytlsDialer) ListenPacket(ctx, destination) (net.PacketConn, error) {
    return nil, os.ErrInvalid
}
```

### موجه UoT (الوارد)

يغلف الوارد موجهه بدعم UoT:

```go
inbound.router = uot.NewRouter(router, logger)
```

## أمثلة على التكوين

### الوارد

```json
{
  "type": "anytls",
  "tag": "anytls-in",
  "listen": "::",
  "listen_port": 443,
  "users": [
    { "name": "user1", "password": "user-password" }
  ],
  "padding_scheme": [
    "0:100",
    "200:500"
  ],
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  }
}
```

### الصادر

```json
{
  "type": "anytls",
  "tag": "anytls-out",
  "server": "example.com",
  "server_port": 443,
  "password": "user-password",
  "idle_session_check_interval": "30s",
  "idle_session_timeout": "30s",
  "min_idle_session": 1,
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```
