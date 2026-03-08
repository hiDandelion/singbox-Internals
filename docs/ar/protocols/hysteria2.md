# بروتوكول Hysteria2

Hysteria2 هو بروتوكول وكيل قائم على QUIC يتميز بالتفاوض على عرض النطاق الترددي عبر خوارزمية التحكم في الازدحام Brutal، وتمويه Salamander، والتنكر بصورة HTTP/3. يفوض sing-box تنفيذ البروتوكول إلى `sing-quic/hysteria2`.

**المصدر**: `protocol/hysteria2/inbound.go`، `protocol/hysteria2/outbound.go`، `sing-quic/hysteria2`

## نظرة عامة على البنية

كل من الوارد والصادر هما أغلفة خفيفة حول مكتبة `sing-quic/hysteria2`:

```go
// الوارد
type Inbound struct {
    inbound.Adapter
    router       adapter.Router
    logger       log.ContextLogger
    listener     *listener.Listener
    tlsConfig    tls.ServerConfig
    service      *hysteria2.Service[int]
    userNameList []string
}

// الصادر
type Outbound struct {
    outbound.Adapter
    logger logger.ContextLogger
    client *hysteria2.Client
}
```

## متطلب TLS

يتطلب Hysteria2 TLS بشكل غير مشروط على كلا الجانبين:

```go
if options.TLS == nil || !options.TLS.Enabled {
    return nil, C.ErrTLSRequired
}
```

## تمويه Salamander

Salamander هو النوع الوحيد المدعوم للتمويه. يغلف حزم QUIC بطبقة تمويه لمنع الفحص العميق للحزم من التعرف عليها كـ QUIC:

```go
var salamanderPassword string
if options.Obfs != nil {
    if options.Obfs.Password == "" {
        return nil, E.New("missing obfs password")
    }
    switch options.Obfs.Type {
    case hysteria2.ObfsTypeSalamander:
        salamanderPassword = options.Obfs.Password
    default:
        return nil, E.New("unknown obfs type: ", options.Obfs.Type)
    }
}
```

عند تفعيل Salamander، يجب أن تتطابق كلمة المرور بين العميل والخادم.

## التفاوض على عرض النطاق الترددي (Brutal CC)

الميزة الأساسية لـ Hysteria2 هي خوارزمية التحكم في الازدحام Brutal، التي تتطلب من العميل الإعلان عن عرض النطاق الترددي الخاص به. يمكن للخادم أيضاً تعيين حدود عرض النطاق الترددي:

```go
service, err := hysteria2.NewService[int](hysteria2.ServiceOptions{
    Context:               ctx,
    Logger:                logger,
    BrutalDebug:           options.BrutalDebug,
    SendBPS:               uint64(options.UpMbps * hysteria.MbpsToBps),
    ReceiveBPS:            uint64(options.DownMbps * hysteria.MbpsToBps),
    SalamanderPassword:    salamanderPassword,
    TLSConfig:             tlsConfig,
    IgnoreClientBandwidth: options.IgnoreClientBandwidth,
    UDPTimeout:            udpTimeout,
    Handler:               inbound,
    MasqueradeHandler:     masqueradeHandler,
})
```

حقول عرض النطاق الترددي الرئيسية:

- **SendBPS / ReceiveBPS**: عرض نطاق الإرسال والاستقبال للخادم بالبت في الثانية، محول من Mbps باستخدام `hysteria.MbpsToBps`
- **IgnoreClientBandwidth**: عند التفعيل، يتجاهل الخادم عرض النطاق المعلن من العميل ويستخدم إعداداته الخاصة
- **BrutalDebug**: يفعل تسجيل التصحيح للتحكم في الازدحام

يعلن الصادر بالمثل عن عرض النطاق الترددي:

```go
client, err := hysteria2.NewClient(hysteria2.ClientOptions{
    SendBPS:    uint64(options.UpMbps * hysteria.MbpsToBps),
    ReceiveBPS: uint64(options.DownMbps * hysteria.MbpsToBps),
    // ...
})
```

## التنكر (Masquerade)

عند وصول حركة مرور غير Hysteria2 (مثل متصفح ويب)، يمكن للوارد تقديم استجابة تنكر. ثلاثة أنواع من التنكر مدعومة:

### خادم ملفات
```go
case C.Hysterai2MasqueradeTypeFile:
    masqueradeHandler = http.FileServer(http.Dir(options.Masquerade.FileOptions.Directory))
```

### وكيل عكسي
```go
case C.Hysterai2MasqueradeTypeProxy:
    masqueradeURL, _ := url.Parse(options.Masquerade.ProxyOptions.URL)
    masqueradeHandler = &httputil.ReverseProxy{
        Rewrite: func(r *httputil.ProxyRequest) {
            r.SetURL(masqueradeURL)
            if !options.Masquerade.ProxyOptions.RewriteHost {
                r.Out.Host = r.In.Host
            }
        },
    }
```

### نص ثابت
```go
case C.Hysterai2MasqueradeTypeString:
    masqueradeHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if options.Masquerade.StringOptions.StatusCode != 0 {
            w.WriteHeader(options.Masquerade.StringOptions.StatusCode)
        }
        w.Write([]byte(options.Masquerade.StringOptions.Content))
    })
```

## القفز بين المنافذ (Port Hopping)

يدعم الصادر القفز بين المنافذ -- الاتصال بمنافذ متعددة للخادم لتجنب الخنق لكل منفذ:

```go
client, err := hysteria2.NewClient(hysteria2.ClientOptions{
    ServerAddress: options.ServerOptions.Build(),
    ServerPorts:   options.ServerPorts,         // قائمة نطاقات المنافذ
    HopInterval:   time.Duration(options.HopInterval),  // كم مرة يتم تبديل المنافذ
    // ...
})
```

## نموذج المستمع

على عكس البروتوكولات القائمة على TCP، يستمع Hysteria2 على UDP (QUIC). يبدأ الوارد بالاستماع لحزم UDP وتمريرها إلى خدمة QUIC:

```go
func (h *Inbound) Start(stage adapter.StartStage) error {
    if stage != adapter.StartStateStart {
        return nil
    }
    h.tlsConfig.Start()
    packetConn, err := h.listener.ListenUDP()
    if err != nil {
        return err
    }
    return h.service.Start(packetConn)
}
```

## إدارة المستخدمين

يتم تحديد المستخدمين بفهرس عددي صحيح، مع قائمة أسماء موازية للتسجيل:

```go
userList := make([]int, 0, len(options.Users))
userNameList := make([]string, 0, len(options.Users))
userPasswordList := make([]string, 0, len(options.Users))
for index, user := range options.Users {
    userList = append(userList, index)
    userNameList = append(userNameList, user.Name)
    userPasswordList = append(userPasswordList, user.Password)
}
service.UpdateUsers(userList, userPasswordList)
```

تستخدم المصادقة فهرس المستخدم المخزن في السياق:

```go
userID, _ := auth.UserFromContext[int](ctx)
if userName := h.userNameList[userID]; userName != "" {
    metadata.User = userName
}
```

## معالجة الاتصال

تتبع اتصالات TCP وUDP نمط sing-box القياسي:

```go
func (h *Inbound) NewConnectionEx(ctx, conn, source, destination, onClose) {
    // تعيين حقول البيانات الوصفية
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}

func (h *Inbound) NewPacketConnectionEx(ctx, conn, source, destination, onClose) {
    // تعيين حقول البيانات الوصفية
    h.router.RoutePacketConnectionEx(ctx, conn, metadata, onClose)
}
```

## اتصال الصادر

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    switch N.NetworkName(network) {
    case N.NetworkTCP:
        return h.client.DialConn(ctx, destination)
    case N.NetworkUDP:
        conn, err := h.ListenPacket(ctx, destination)
        return bufio.NewBindPacketConn(conn, destination), nil
    }
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    return h.client.ListenPacket(ctx)
}
```

## تحديث الواجهة

ينفذ الصادر `adapter.InterfaceUpdateListener` للتعامل مع تغييرات الشبكة عن طريق إغلاق اتصال QUIC:

```go
func (h *Outbound) InterfaceUpdated() {
    h.client.CloseWithError(E.New("network changed"))
}
```

## أمثلة على التكوين

### الوارد

```json
{
  "type": "hysteria2",
  "tag": "hy2-in",
  "listen": "::",
  "listen_port": 443,
  "up_mbps": 100,
  "down_mbps": 100,
  "obfs": {
    "type": "salamander",
    "password": "obfs-password"
  },
  "users": [
    { "name": "user1", "password": "user-password" }
  ],
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  },
  "masquerade": {
    "type": "proxy",
    "proxy": {
      "url": "https://www.example.com",
      "rewrite_host": true
    }
  }
}
```

### الصادر

```json
{
  "type": "hysteria2",
  "tag": "hy2-out",
  "server": "example.com",
  "server_port": 443,
  "up_mbps": 50,
  "down_mbps": 100,
  "password": "user-password",
  "obfs": {
    "type": "salamander",
    "password": "obfs-password"
  },
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```

### مع القفز بين المنافذ

```json
{
  "type": "hysteria2",
  "tag": "hy2-hop",
  "server": "example.com",
  "server_ports": "443,8443-8500",
  "hop_interval": "30s",
  "password": "user-password",
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```
