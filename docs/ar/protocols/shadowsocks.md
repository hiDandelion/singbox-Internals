# بروتوكول Shadowsocks

Shadowsocks هو بروتوكول وكيل مشفر. ينفذ sing-box ثلاثة أوضاع للوارد (مستخدم واحد، متعدد المستخدمين، ترحيل) وصادر واحد، باستخدام مكتبتين مختلفتين: `sing-shadowsocks` للوارد و`sing-shadowsocks2` للصادر.

**المصدر**: `protocol/shadowsocks/inbound.go`، `inbound_multi.go`، `inbound_relay.go`، `outbound.go`

## نظرة عامة على البنية

يستخدم وارد Shadowsocks نمط المصنع -- تقوم دالة `NewInbound` واحدة بالتوزيع إلى أحد التنفيذات الثلاثة بناءً على التكوين:

```go
func NewInbound(ctx, router, logger, tag, options) (adapter.Inbound, error) {
    if len(options.Users) > 0 && len(options.Destinations) > 0 {
        return nil, E.New("users and destinations must not be combined")
    }
    if len(options.Users) > 0 || options.Managed {
        return newMultiInbound(...)    // وضع متعدد المستخدمين
    } else if len(options.Destinations) > 0 {
        return newRelayInbound(...)    // وضع الترحيل
    } else {
        return newInbound(...)         // وضع مستخدم واحد
    }
}
```

## تقسيم المكتبات: sing-shadowsocks مقابل sing-shadowsocks2

| المكتبة | الاستخدام | التشفيرات |
|---------|-------|---------|
| `sing-shadowsocks` | الوارد (الخادم) | `shadowaead` (AEAD القديم)، `shadowaead_2022` (SIP022) |
| `sing-shadowsocks2` | الصادر (العميل) | واجهة موحدة لجميع الطرق |

يستورد الصادر `sing-shadowsocks2` الذي يوفر واجهة `shadowsocks.Method` موحدة:

```go
import "github.com/sagernet/sing-shadowsocks2"

method, _ := shadowsocks.CreateMethod(ctx, options.Method, shadowsocks.MethodOptions{
    Password: options.Password,
})
```

## وارد المستخدم الواحد

```go
type Inbound struct {
    inbound.Adapter
    ctx      context.Context
    router   adapter.ConnectionRouterEx
    logger   logger.ContextLogger
    listener *listener.Listener
    service  shadowsocks.Service         // من sing-shadowsocks
}
```

### اختيار التشفير

تحدد سلسلة الطريقة أي تنفيذ يُستخدم:

```go
switch {
case options.Method == shadowsocks.MethodNone:
    // بدون تشفير (وكيل عادي)
    service = shadowsocks.NewNoneService(udpTimeout, handler)

case common.Contains(shadowaead.List, options.Method):
    // تشفيرات AEAD القديمة: aes-128-gcm، aes-256-gcm، chacha20-ietf-poly1305
    service = shadowaead.NewService(method, nil, password, udpTimeout, handler)

case common.Contains(shadowaead_2022.List, options.Method):
    // تشفيرات Shadowsocks 2022: 2022-blake3-aes-128-gcm، إلخ
    service = shadowaead_2022.NewServiceWithPassword(method, password, udpTimeout, handler, timeFunc)
}
```

### تشفيرات AEAD (القديمة)

تدعم حزمة `shadowaead` طرق AEAD الأصلية:
- `aes-128-gcm`
- `aes-256-gcm`
- `chacha20-ietf-poly1305`

يستخدم اشتقاق المفتاح دالة EVP_BytesToKey (متوافقة مع OpenSSL).

### Shadowsocks 2022 (SIP022)

تنفذ حزمة `shadowaead_2022` بروتوكول Shadowsocks 2022 الحديث:
- `2022-blake3-aes-128-gcm`
- `2022-blake3-aes-256-gcm`
- `2022-blake3-chacha20-poly1305`

الميزات الرئيسية:
- اشتقاق مفتاح قائم على BLAKE3
- حماية مدمجة من إعادة التشغيل
- مصادقة قائمة على الوقت (تتطلب مزامنة NTP)

### المستمع المزدوج

يستمع وارد المستخدم الواحد على كل من TCP وUDP:

```go
inbound.listener = listener.New(listener.Options{
    Network:                  options.Network.Build(),   // ["tcp", "udp"]
    ConnectionHandler:        inbound,                   // TCP
    PacketHandler:            inbound,                   // UDP
    ThreadUnsafePacketWriter: true,
})
```

تمر اتصالات TCP عبر `NewConnectionEx`:
```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    err := h.service.NewConnection(ctx, conn, adapter.UpstreamMetadata(metadata))
    N.CloseOnHandshakeFailure(conn, onClose, err)
}
```

تمر حزم UDP عبر `NewPacketEx`:
```go
func (h *Inbound) NewPacketEx(buffer *buf.Buffer, source M.Socksaddr) {
    h.service.NewPacket(h.ctx, &stubPacketConn{h.listener.PacketWriter()}, buffer, M.Metadata{Source: source})
}
```

## وارد متعدد المستخدمين

```go
type MultiInbound struct {
    inbound.Adapter
    ctx      context.Context
    router   adapter.ConnectionRouterEx
    logger   logger.ContextLogger
    listener *listener.Listener
    service  shadowsocks.MultiService[int]   // خدمة متعددة المستخدمين
    users    []option.ShadowsocksUser
    tracker  adapter.SSMTracker              // تتبع حركة المرور الاختياري
}
```

### إنشاء الخدمة متعددة المستخدمين

```go
if common.Contains(shadowaead_2022.List, options.Method) {
    // SIP022 متعدد المستخدمين: كلمة مرور الخادم + كلمات مرور لكل مستخدم (iPSK)
    service = shadowaead_2022.NewMultiServiceWithPassword[int](
        method, options.Password, udpTimeout, handler, timeFunc)
} else if common.Contains(shadowaead.List, options.Method) {
    // AEAD القديم متعدد المستخدمين
    service = shadowaead.NewMultiService[int](method, udpTimeout, handler)
}
```

بالنسبة لـ SIP022، يستخدم الوضع متعدد المستخدمين **مفتاح هوية مشترك مسبقاً (iPSK)**: يمتلك الخادم كلمة مرور رئيسية، ولكل مستخدم كلمة مرور فرعية تشتق مفتاح هوية فريد.

### إدارة المستخدمين

يمكن تحديث المستخدمين ديناميكياً:

```go
func (h *MultiInbound) UpdateUsers(users []string, uPSKs []string) error {
    err := h.service.UpdateUsersWithPasswords(indices, uPSKs)
    h.users = /* إعادة بناء قائمة المستخدمين */
    return err
}
```

### دعم الخادم المُدار

ينفذ `MultiInbound` واجهة `adapter.ManagedSSMServer` للتكامل مع إدارة خادم Shadowsocks:

```go
var _ adapter.ManagedSSMServer = (*MultiInbound)(nil)

func (h *MultiInbound) SetTracker(tracker adapter.SSMTracker) {
    h.tracker = tracker
}
```

عند تعيين متتبع، يتم تغليف الاتصالات والحزم لحساب حركة المرور:

```go
if h.tracker != nil {
    conn = h.tracker.TrackConnection(conn, metadata)
}
```

## وارد الترحيل (Relay)

وضع الترحيل خاص بـ Shadowsocks 2022 ويعمل كخادم ترحيل وسيط:

```go
type RelayInbound struct {
    inbound.Adapter
    service      *shadowaead_2022.RelayService[int]
    destinations []option.ShadowsocksDestination
}
```

لكل وجهة كلمة مرور خاصة بها وعنوان هدف:

```go
service = shadowaead_2022.NewRelayServiceWithPassword[int](
    method, password, udpTimeout, handler)
service.UpdateUsersWithPasswords(indices, passwords, destinations)
```

يستقبل الترحيل الاتصالات المشفرة بمفتاح الخادم، ويفك تشفيرها لإيجاد معرف الوجهة، ثم يعيد تشفيرها بمفتاح الوجهة قبل التحويل.

## تنفيذ الصادر

يستخدم الصادر `sing-shadowsocks2` لواجهة تشفير موحدة:

```go
type Outbound struct {
    outbound.Adapter
    logger          logger.ContextLogger
    dialer          N.Dialer
    method          shadowsocks.Method     // من sing-shadowsocks2
    serverAddr      M.Socksaddr
    plugin          sip003.Plugin          // دعم إضافة SIP003
    uotClient       *uot.Client            // UDP-over-TCP
    multiplexDialer *mux.Client
}
```

### إنشاء الاتصال

```go
func (h *shadowsocksDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    switch network {
    case "tcp":
        var outConn net.Conn
        if h.plugin != nil {
            outConn = h.plugin.DialContext(ctx)  // إضافة SIP003
        } else {
            outConn = h.dialer.DialContext(ctx, "tcp", h.serverAddr)
        }
        return h.method.DialEarlyConn(outConn, destination)

    case "udp":
        outConn := h.dialer.DialContext(ctx, "udp", h.serverAddr)
        return bufio.NewBindPacketConn(h.method.DialPacketConn(outConn), destination)
    }
}
```

### دعم إضافة SIP003

يدعم صادر Shadowsocks إضافات SIP003 (مثل simple-obfs، v2ray-plugin):

```go
if options.Plugin != "" {
    outbound.plugin = sip003.CreatePlugin(ctx, options.Plugin, options.PluginOptions, ...)
}
```

### UDP-over-TCP

عندما لا يكون UDP الأصلي متاحاً، يوفر UoT نقل UDP عبر اتصال TCP لـ Shadowsocks:

```go
uotOptions := options.UDPOverTCP
if uotOptions.Enabled {
    outbound.uotClient = &uot.Client{
        Dialer:  (*shadowsocksDialer)(outbound),
        Version: uotOptions.Version,
    }
}
```

## حماية إعادة التشغيل

يتضمن بروتوكول Shadowsocks 2022 حماية مدمجة من إعادة التشغيل عبر قيم عشوائية فريدة قائمة على الوقت. يتم تمرير دالة وقت NTP أثناء إنشاء الخدمة:

```go
shadowaead_2022.NewServiceWithPassword(method, password, udpTimeout, handler,
    ntp.TimeFuncFromContext(ctx))  // يضمن قيم عشوائية متزامنة زمنياً
```

## أمثلة على التكوين

### مستخدم واحد

```json
{
  "type": "shadowsocks",
  "tag": "ss-in",
  "listen": "::",
  "listen_port": 8388,
  "method": "2022-blake3-aes-256-gcm",
  "password": "base64-encoded-32-byte-key"
}
```

### متعدد المستخدمين (SIP022 iPSK)

```json
{
  "type": "shadowsocks",
  "tag": "ss-multi",
  "listen": "::",
  "listen_port": 8388,
  "method": "2022-blake3-aes-256-gcm",
  "password": "server-main-key-base64",
  "users": [
    { "name": "user1", "password": "user1-key-base64" },
    { "name": "user2", "password": "user2-key-base64" }
  ]
}
```

### الترحيل

```json
{
  "type": "shadowsocks",
  "tag": "ss-relay",
  "listen": "::",
  "listen_port": 8388,
  "method": "2022-blake3-aes-256-gcm",
  "password": "relay-server-key",
  "destinations": [
    {
      "name": "dest1",
      "password": "dest1-key",
      "server": "dest1.example.com",
      "server_port": 8388
    }
  ]
}
```

### الصادر

```json
{
  "type": "shadowsocks",
  "tag": "ss-out",
  "server": "example.com",
  "server_port": 8388,
  "method": "2022-blake3-aes-256-gcm",
  "password": "base64-key",
  "udp_over_tcp": {
    "enabled": true,
    "version": 2
  },
  "multiplex": {
    "enabled": true,
    "protocol": "h2mux"
  }
}
```
