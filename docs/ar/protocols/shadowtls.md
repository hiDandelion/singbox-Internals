# بروتوكول ShadowTLS

ShadowTLS هو بروتوكول طبقة نقل يخفي حركة مرور الوكيل كحركة مرور TLS شرعية عن طريق اختطاف مصافحة TLS مع خادم حقيقي. يدعم ثلاثة إصدارات من البروتوكول بتطور متزايد.

**المصدر**: `protocol/shadowtls/inbound.go`، `protocol/shadowtls/outbound.go`، `sing-shadowtls`

## مفهوم البروتوكول

على عكس الوكلاء التقليديين القائمة على TLS التي تولد شهاداتها الخاصة (القابلة للكشف عبر فحص الشهادات)، يجري ShadowTLS مصافحة TLS حقيقية مع خادم شرعي (مثل `www.microsoft.com`)، مما يجعل المصافحة غير قابلة للتمييز عن حركة مرور HTTPS العادية بالنسبة للمراقبين. بعد المصافحة، يتم اختطاف قناة البيانات لنقل حركة مرور الوكيل.

## إصدارات البروتوكول

### الإصدار 1

الإصدار الأبسط. يبدأ العميل مصافحة TLS عبر خادم ShadowTLS، الذي يرحلها إلى خادم TLS حقيقي ("خادم المصافحة"). بعد اكتمال المصافحة، يُعاد استخدام اتصال TLS لبيانات الوكيل.

**القيد**: يفرض TLS 1.2 لضمان سلوك مصافحة متوقع.

```go
if options.Version == 1 {
    options.TLS.MinVersion = "1.2"
    options.TLS.MaxVersion = "1.2"
}
```

### الإصدار 2

يضيف مصادقة قائمة على كلمة المرور. يمكن للخادم التمييز بين عملاء ShadowTLS الشرعيين والمسابير. يدعم خوادم مصافحة لكل SNI:

```go
if options.Version > 1 {
    handshakeForServerName = make(map[string]shadowtls.HandshakeConfig)
    for _, entry := range options.HandshakeForServerName.Entries() {
        handshakeForServerName[entry.Key] = shadowtls.HandshakeConfig{
            Server: entry.Value.ServerOptions.Build(),
            Dialer: handshakeDialer,
        }
    }
}
```

### الإصدار 3

الإصدار الأكثر تقدماً. يقدم ربط القناة القائم على معرف الجلسة -- يقوم العميل والخادم بتضمين بيانات المصادقة داخل معرف جلسة TLS، مما يتيح التحقق بدون رحلة ذهاب وإياب إضافية.

```go
case 3:
    if idConfig, loaded := tlsConfig.(tls.WithSessionIDGenerator); loaded {
        // استخدام خطاف معرف جلسة مكتبة TLS
        tlsHandshakeFunc = func(ctx, conn, sessionIDGenerator) error {
            idConfig.SetSessionIDGenerator(sessionIDGenerator)
            return tls.ClientHandshake(ctx, conn, tlsConfig)
        }
    } else {
        // الرجوع إلى TLS القياسي مع حقن معرف الجلسة يدوياً
        stdTLSConfig := tlsConfig.STDConfig()
        tlsHandshakeFunc = shadowtls.DefaultTLSHandshakeFunc(password, stdTLSConfig)
    }
```

## بنية الوارد (Inbound)

```go
type Inbound struct {
    inbound.Adapter
    router   adapter.Router
    logger   logger.ContextLogger
    listener *listener.Listener
    service  *shadowtls.Service
}
```

### تكوين الخدمة

```go
service, _ := shadowtls.NewService(shadowtls.ServiceConfig{
    Version:  options.Version,
    Password: options.Password,
    Users: common.Map(options.Users, func(it option.ShadowTLSUser) shadowtls.User {
        return (shadowtls.User)(it)
    }),
    Handshake: shadowtls.HandshakeConfig{
        Server: options.Handshake.ServerOptions.Build(),
        Dialer: handshakeDialer,
    },
    HandshakeForServerName: handshakeForServerName,  // توجيه لكل SNI
    StrictMode:             options.StrictMode,
    WildcardSNI:            shadowtls.WildcardSNI(options.WildcardSNI),
    Handler:                (*inboundHandler)(inbound),
    Logger:                 logger,
})
```

الحقول الرئيسية:

- **Handshake**: خادم المصافحة الهدف الافتراضي
- **HandshakeForServerName**: خريطة SNI ← خادم المصافحة لدعم النطاقات المتعددة
- **StrictMode**: رفض الاتصالات التي تفشل في المصادقة (مقابل التحويل الصامت)
- **WildcardSNI**: قبول أي قيمة SNI (مفيد لسيناريوهات CDN)

### SNI بحرف البدل

يتحكم خيار `WildcardSNI` في كيفية معالجة SNI:

```go
serverIsDomain := options.Handshake.ServerIsDomain()
if options.WildcardSNI != option.ShadowTLSWildcardSNIOff {
    serverIsDomain = true  // فرض حل النطاق لحرف البدل
}
```

### تدفق الاتصال (الوارد)

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    // تعالج خدمة ShadowTLS كامل ترحيل المصافحة واستخراج البيانات
    err := h.service.NewConnection(ctx, conn, metadata.Source, metadata.Destination, onClose)
    N.CloseOnHandshakeFailure(conn, onClose, err)
}
```

بعد أن تستخرج خدمة ShadowTLS تيار البيانات الحقيقي، تستدعي معالج الوارد:

```go
type inboundHandler Inbound

func (h *inboundHandler) NewConnectionEx(ctx, conn, source, destination, onClose) {
    metadata.Inbound = h.Tag()
    metadata.InboundType = h.Type()
    metadata.Source = source
    metadata.Destination = destination
    if userName, _ := auth.UserFromContext[string](ctx); userName != "" {
        metadata.User = userName
    }
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## بنية الصادر (Outbound)

```go
type Outbound struct {
    outbound.Adapter
    client *shadowtls.Client
}
```

صادر ShadowTLS يدعم TCP فقط ويعمل **كغلاف نقل** -- عادة ما يتم ربطه مع بروتوكول آخر (مثل Shadowsocks):

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    switch network {
    case "tcp":
        return h.client.DialContext(ctx)   // يُرجع اتصالاً "نظيفاً"
    default:
        return nil, os.ErrInvalid          // UDP غير مدعوم
    }
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    return nil, os.ErrInvalid              // UDP غير مدعوم
}
```

### متطلب TLS

يتطلب صادر ShadowTLS تفعيل TLS **إلزامياً**:

```go
if options.TLS == nil || !options.TLS.Enabled {
    return nil, C.ErrTLSRequired
}
```

### تكوين العميل

```go
client, _ := shadowtls.NewClient(shadowtls.ClientConfig{
    Version:      options.Version,
    Password:     options.Password,
    Server:       options.ServerOptions.Build(),
    Dialer:       outboundDialer,
    TLSHandshake: tlsHandshakeFunc,   // مصافحة خاصة بالإصدار
    Logger:       logger,
})
```

### مصافحة TLS الخاصة بالإصدار

```go
var tlsHandshakeFunc shadowtls.TLSHandshakeFunc

switch options.Version {
case 1, 2:
    // بسيط: فقط إجراء مصافحة TLS
    tlsHandshakeFunc = func(ctx, conn, _ TLSSessionIDGeneratorFunc) error {
        return common.Error(tls.ClientHandshake(ctx, conn, tlsConfig))
    }

case 3:
    // معقد: حقن مولد معرف الجلسة لربط القناة
    tlsHandshakeFunc = func(ctx, conn, sessionIDGenerator) error {
        idConfig.SetSessionIDGenerator(sessionIDGenerator)
        return common.Error(tls.ClientHandshake(ctx, conn, tlsConfig))
    }
}
```

## كيف يعمل ShadowTLS (بالتفصيل)

```
العميل                  خادم ShadowTLS          خادم TLS الحقيقي
  |                          |                          |
  |--- TLS ClientHello ---->|--- TLS ClientHello ----->|
  |                          |                          |
  |<-- TLS ServerHello -----|<-- TLS ServerHello ------|
  |<-- Certificate ---------|<-- Certificate ----------|
  |<-- ServerHelloDone -----|<-- ServerHelloDone ------|
  |                          |                          |
  |--- ClientKeyExchange -->|--- ClientKeyExchange --->|
  |--- ChangeCipherSpec --->|--- ChangeCipherSpec ---->|
  |--- Finished ----------->|--- Finished ------------>|
  |                          |                          |
  |<-- ChangeCipherSpec ----|<-- ChangeCipherSpec -----|
  |<-- Finished ------------|<-- Finished -------------|
  |                          |                          |
  |  [اكتملت مصافحة TLS - المراقب يرى شهادة صالحة]   |
  |                          |                          |
  |=== بيانات الوكيل =======>|  [البيانات لم تعد تُرسل  |
  |<=== بيانات الوكيل =======|   إلى خادم TLS الحقيقي]  |
```

بعد المصافحة، يقوم خادم ShadowTLS بما يلي:
1. قطع الاتصال عن خادم TLS الحقيقي
2. استخراج تيار بيانات الوكيل من العميل
3. تحويله إلى المعالج الداخلي المكون

## نمط الاستخدام المعتاد

يُستخدم ShadowTLS **كتحويلة (detour)** لبروتوكول آخر:

```json
{
  "outbounds": [
    {
      "type": "shadowsocks",
      "tag": "ss-out",
      "detour": "shadowtls-out",
      "method": "2022-blake3-aes-256-gcm",
      "password": "ss-password"
    },
    {
      "type": "shadowtls",
      "tag": "shadowtls-out",
      "server": "my-server.com",
      "server_port": 443,
      "version": 3,
      "password": "shadowtls-password",
      "tls": {
        "enabled": true,
        "server_name": "www.microsoft.com"
      }
    }
  ]
}
```

يتم نفق اتصال Shadowsocks عبر غلاف ShadowTLS، الذي يجري المصافحة بشهادة `www.microsoft.com` الحقيقية.

## مثال على التكوين (الوارد)

```json
{
  "type": "shadowtls",
  "tag": "shadowtls-in",
  "listen": "::",
  "listen_port": 443,
  "version": 3,
  "users": [
    { "name": "user1", "password": "user-password" }
  ],
  "handshake": {
    "server": "www.microsoft.com",
    "server_port": 443
  },
  "handshake_for_server_name": {
    "www.google.com": {
      "server": "www.google.com",
      "server_port": 443
    }
  },
  "strict_mode": true
}
```
