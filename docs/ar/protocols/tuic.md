# بروتوكول TUIC

TUIC هو بروتوكول وكيل قائم على QUIC يتميز بمصادقة UUID، والتحكم في الازدحام القابل للتكوين، ووضعين مختلفين لترحيل UDP. يفوض sing-box تنفيذ البروتوكول إلى `sing-quic/tuic`.

**المصدر**: `protocol/tuic/inbound.go`، `protocol/tuic/outbound.go`، `sing-quic/tuic`

## نظرة عامة على البنية

```go
// الوارد
type Inbound struct {
    inbound.Adapter
    router       adapter.ConnectionRouterEx
    logger       log.ContextLogger
    listener     *listener.Listener
    tlsConfig    tls.ServerConfig
    server       *tuic.Service[int]
    userNameList []string
}

// الصادر
type Outbound struct {
    outbound.Adapter
    logger    logger.ContextLogger
    client    *tuic.Client
    udpStream bool
}
```

## متطلب TLS

مثل Hysteria2، يتطلب TUIC تفعيل TLS على كلا الجانبين:

```go
if options.TLS == nil || !options.TLS.Enabled {
    return nil, C.ErrTLSRequired
}
```

## المصادقة القائمة على UUID

تتم مصادقة المستخدمين عبر أزواج UUID + كلمة المرور. يتم تحليل UUID من تنسيق النص:

```go
var userUUIDList [][16]byte
for index, user := range options.Users {
    userUUID, err := uuid.FromString(user.UUID)
    if err != nil {
        return nil, E.Cause(err, "invalid uuid for user ", index)
    }
    userUUIDList = append(userUUIDList, userUUID)
    userPasswordList = append(userPasswordList, user.Password)
}
service.UpdateUsers(userList, userUUIDList, userPasswordList)
```

يستخدم الصادر بالمثل UUID واحد + كلمة مرور:

```go
userUUID, err := uuid.FromString(options.UUID)
client, _ := tuic.NewClient(tuic.ClientOptions{
    UUID:     userUUID,
    Password: options.Password,
    // ...
})
```

## التحكم في الازدحام

يدعم TUIC خوارزميات التحكم في الازدحام القابلة للتكوين:

```go
service, _ := tuic.NewService[int](tuic.ServiceOptions{
    CongestionControl: options.CongestionControl,
    // ...
})
```

يقبل حقل `CongestionControl` أسماء الخوارزميات (مثل "bbr"، "cubic"). ينطبق هذا على كل من الوارد والصادر.

## مصافحة صفر RTT

يدعم TUIC مصافحة QUIC بـ 0-RTT لتقليل زمن الاستجابة:

```go
tuic.ServiceOptions{
    ZeroRTTHandshake: options.ZeroRTTHandshake,
    // ...
}
```

## مهلة المصادقة ونبض القلب

```go
tuic.ServiceOptions{
    AuthTimeout: time.Duration(options.AuthTimeout),
    Heartbeat:   time.Duration(options.Heartbeat),
    // ...
}
```

- **AuthTimeout**: الحد الزمني لإكمال العميل المصادقة بعد مصافحة QUIC
- **Heartbeat**: فترة الحفاظ على الاتصال للحفاظ على اتصال QUIC

## أوضاع ترحيل UDP

لدى TUIC وضعان لترحيل UDP، يتم تكوينهما فقط على الصادر:

### الوضع الأصلي (Native) (افتراضي)

يتم إرسال كل حزمة UDP كمخطط بيانات QUIC فردي. هذا هو الوضع الأكثر كفاءة لكنه يتطلب دعم مخططات بيانات QUIC:

```go
case "native":
    // tuicUDPStream يبقى false
```

### وضع تيار QUIC

يتم تسلسل حزم UDP عبر تيار QUIC. يعمل هذا الوضع عندما لا تكون مخططات بيانات QUIC متاحة:

```go
case "quic":
    tuicUDPStream = true
```

### وضع UDP عبر التيار

خيار ثالث (`udp_over_stream`) يستخدم ترميز UoT (UDP-over-TCP). هذا حصري مع `udp_relay_mode`:

```go
if options.UDPOverStream && options.UDPRelayMode != "" {
    return nil, E.New("udp_over_stream is conflict with udp_relay_mode")
}
```

عندما يكون `udp_over_stream` نشطاً، يتم نفق اتصالات UDP عبر تيار شبيه بـ TCP باستخدام حزمة `uot`:

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    case N.NetworkUDP:
        if h.udpStream {
            streamConn, _ := h.client.DialConn(ctx, uot.RequestDestination(uot.Version))
            return uot.NewLazyConn(streamConn, uot.Request{
                IsConnect:   true,
                Destination: destination,
            }), nil
        }
}
```

## موجه UoT (الوارد)

يغلف الوارد موجهه بدعم UoT لمعالجة اتصالات UDP-over-TCP:

```go
inbound.router = uot.NewRouter(router, logger)
```

## نموذج المستمع

مثل Hysteria2، يستمع TUIC على UDP:

```go
func (h *Inbound) Start(stage adapter.StartStage) error {
    h.tlsConfig.Start()
    packetConn, _ := h.listener.ListenUDP()
    return h.server.Start(packetConn)
}
```

## معالجة الاتصال

توجيه اتصالات TCP/UDP القياسي في sing-box مع استخراج المستخدم من السياق:

```go
func (h *Inbound) NewConnectionEx(ctx, conn, source, destination, onClose) {
    userID, _ := auth.UserFromContext[int](ctx)
    if userName := h.userNameList[userID]; userName != "" {
        metadata.User = userName
    }
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## اتصالات الصادر

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    switch N.NetworkName(network) {
    case N.NetworkTCP:
        return h.client.DialConn(ctx, destination)
    case N.NetworkUDP:
        if h.udpStream {
            // مسار UoT
        } else {
            conn, _ := h.ListenPacket(ctx, destination)
            return bufio.NewBindPacketConn(conn, destination), nil
        }
    }
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    if h.udpStream {
        streamConn, _ := h.client.DialConn(ctx, uot.RequestDestination(uot.Version))
        return uot.NewLazyConn(streamConn, uot.Request{
            IsConnect:   false,
            Destination: destination,
        }), nil
    }
    return h.client.ListenPacket(ctx)
}
```

## تحديث الواجهة

مثل Hysteria2، يغلق TUIC اتصال QUIC عند تغيير الشبكة:

```go
func (h *Outbound) InterfaceUpdated() {
    _ = h.client.CloseWithError(E.New("network changed"))
}
```

## أمثلة على التكوين

### الوارد

```json
{
  "type": "tuic",
  "tag": "tuic-in",
  "listen": "::",
  "listen_port": 443,
  "users": [
    {
      "name": "user1",
      "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
      "password": "user-password"
    }
  ],
  "congestion_control": "bbr",
  "zero_rtt_handshake": true,
  "auth_timeout": "3s",
  "heartbeat": "10s",
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  }
}
```

### الصادر (UDP أصلي)

```json
{
  "type": "tuic",
  "tag": "tuic-out",
  "server": "example.com",
  "server_port": 443,
  "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
  "password": "user-password",
  "congestion_control": "bbr",
  "udp_relay_mode": "native",
  "zero_rtt_handshake": true,
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```

### الصادر (UDP عبر التيار)

```json
{
  "type": "tuic",
  "tag": "tuic-uot",
  "server": "example.com",
  "server_port": 443,
  "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
  "password": "user-password",
  "udp_over_stream": true,
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```
