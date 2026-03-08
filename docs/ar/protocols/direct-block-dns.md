# صادرات Direct وBlock وDNS

تخدم هذه الأنواع الثلاثة من الصادرات وظائف توجيه أساسية: `direct` يتصل بالوجهة بدون وكيل، و`block` يرفض جميع الاتصالات، و`dns` يعترض حركة مرور DNS للحل الداخلي.

**المصدر**: `protocol/direct/outbound.go`، `protocol/direct/inbound.go`، `protocol/direct/loopback_detect.go`، `protocol/block/outbound.go`، `protocol/dns/outbound.go`، `protocol/dns/handle.go`

## صادر Direct

### البنية

```go
type Outbound struct {
    outbound.Adapter
    ctx            context.Context
    logger         logger.ContextLogger
    dialer         dialer.ParallelInterfaceDialer
    domainStrategy C.DomainStrategy
    fallbackDelay  time.Duration
    isEmpty        bool
}
```

ينفذ صادر Direct واجهات متصل متعددة:

```go
var (
    _ N.ParallelDialer             = (*Outbound)(nil)
    _ dialer.ParallelNetworkDialer = (*Outbound)(nil)
    _ dialer.DirectDialer          = (*Outbound)(nil)
    _ adapter.DirectRouteOutbound  = (*Outbound)(nil)
)
```

### دعم الشبكة

يدعم Direct بروتوكولات TCP وUDP وICMP (لـ ping/traceroute):

```go
outbound.NewAdapterWithDialerOptions(C.TypeDirect, tag,
    []string{N.NetworkTCP, N.NetworkUDP, N.NetworkICMP}, options.DialerOptions)
```

### قيد التحويلة

لا يمكن لصادر Direct استخدام تحويلة (detour) (سيكون ذلك دائرياً):

```go
if options.Detour != "" {
    return nil, E.New("`detour` is not supported in direct context")
}
```

### كشف الفراغ

يتتبع صادر Direct ما إذا كان لديه تكوين غير افتراضي. يُستخدم هذا من قبل الموجه لتحسين قرارات التوجيه:

```go
outbound.isEmpty = reflect.DeepEqual(options.DialerOptions, option.DialerOptions{UDPFragmentDefault: true})
```

### إنشاء الاتصال

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    ctx, metadata := adapter.ExtendContext(ctx)
    metadata.Outbound = h.Tag()
    metadata.Destination = destination
    return h.dialer.DialContext(ctx, network, destination)
}
```

### الاتصال المتوازي

يدعم صادر Direct خوارزمية Happy Eyeballs (محاولات اتصال IPv4/IPv6 متوازية):

```go
func (h *Outbound) DialParallel(ctx, network, destination, destinationAddresses) (net.Conn, error) {
    return dialer.DialParallelNetwork(ctx, h.dialer, network, destination,
        destinationAddresses, destinationAddresses[0].Is6(), nil, nil, nil, h.fallbackDelay)
}
```

### ICMP / المسار المباشر

يدعم صادر Direct اتصالات ICMP لـ ping/traceroute عبر واجهة `DirectRouteOutbound`:

```go
func (h *Outbound) NewDirectRouteConnection(metadata, routeContext, timeout) (tun.DirectRouteDestination, error) {
    destination, _ := ping.ConnectDestination(ctx, h.logger,
        common.MustCast[*dialer.DefaultDialer](h.dialer).DialerForICMPDestination(metadata.Destination.Addr).Control,
        metadata.Destination.Addr, routeContext, timeout)
    return destination, nil
}
```

### اتصال استراتيجية الشبكة

يدعم الصادر خيارات استراتيجية شبكة متقدمة لاتصالات المسارات المتعددة:

```go
func (h *Outbound) DialParallelNetwork(ctx, network, destination, destinationAddresses,
    networkStrategy, networkType, fallbackNetworkType, fallbackDelay) (net.Conn, error) {
    return dialer.DialParallelNetwork(ctx, h.dialer, network, destination,
        destinationAddresses, destinationAddresses[0].Is6(),
        networkStrategy, networkType, fallbackNetworkType, fallbackDelay)
}
```

## وارد Direct

يقبل وارد Direct اتصالات TCP/UDP الخام ويوجهها مع تجاوز وجهة اختياري:

```go
type Inbound struct {
    inbound.Adapter
    overrideOption      int    // 0=لا شيء، 1=العنوان+المنفذ، 2=العنوان، 3=المنفذ
    overrideDestination M.Socksaddr
}
```

### خيارات التجاوز

```go
if options.OverrideAddress != "" && options.OverridePort != 0 {
    inbound.overrideOption = 1  // استبدال كل من العنوان والمنفذ
} else if options.OverrideAddress != "" {
    inbound.overrideOption = 2  // استبدال العنوان فقط
} else if options.OverridePort != 0 {
    inbound.overrideOption = 3  // استبدال المنفذ فقط
}
```

## كشف الحلقات

يمنع `loopBackDetector` حلقات التوجيه عن طريق تتبع الاتصالات:

```go
type loopBackDetector struct {
    networkManager   adapter.NetworkManager
    connMap          map[netip.AddrPort]netip.AddrPort    // TCP
    packetConnMap    map[uint16]uint16                     // UDP (قائم على المنفذ)
}
```

يغلف الاتصالات الصادرة ويفحص الاتصالات الواردة مقابل الخريطة:

```go
func (l *loopBackDetector) CheckConn(source, local netip.AddrPort) bool {
    destination, loaded := l.connMap[source]
    return loaded && destination != local
}
```

ملاحظة: كشف الحلقات معطل حالياً في الكود المصدري لكن البنية التحتية لا تزال موجودة.

## صادر Block

أبسط صادر -- يرفض جميع الاتصالات بـ `EPERM`:

```go
type Outbound struct {
    outbound.Adapter
    logger logger.ContextLogger
}

func New(ctx, router, logger, tag, _ option.StubOptions) (adapter.Outbound, error) {
    return &Outbound{
        Adapter: outbound.NewAdapter(C.TypeBlock, tag, []string{N.NetworkTCP, N.NetworkUDP}, nil),
        logger:  logger,
    }, nil
}

func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    h.logger.InfoContext(ctx, "blocked connection to ", destination)
    return nil, syscall.EPERM
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    h.logger.InfoContext(ctx, "blocked packet connection to ", destination)
    return nil, syscall.EPERM
}
```

التفاصيل الرئيسية:
- يستخدم `option.StubOptions` (بنية فارغة) لأنه لا حاجة لتكوين
- يُرجع `syscall.EPERM` (وليس خطأ عام)، يمكن اكتشافه بواسطة المتصلين
- يدعم كل من TCP وUDP (كلاهما محظور)

## صادر DNS

يعترض صادر DNS الاتصالات التي تحمل حركة مرور DNS ويحلها باستخدام موجه DNS الداخلي.

### البنية

```go
type Outbound struct {
    outbound.Adapter
    router adapter.DNSRouter
    logger logger.ContextLogger
}
```

### الاتصال العادي غير مدعوم

لا يدعم صادر DNS `DialContext` أو `ListenPacket` العادية:

```go
func (d *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    return nil, os.ErrInvalid
}
```

بدلاً من ذلك، ينفذ `NewConnectionEx` و`NewPacketConnectionEx` لمعالجة رسائل DNS مباشرة.

### DNS عبر التيار (TCP)

تتم معالجة اتصالات DNS عبر TCP في حلقة، بقراءة رسائل DNS مسبوقة بالطول:

```go
func (d *Outbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    metadata.Destination = M.Socksaddr{}
    for {
        conn.SetReadDeadline(time.Now().Add(C.DNSTimeout))
        err := HandleStreamDNSRequest(ctx, d.router, conn, metadata)
        if err != nil {
            conn.Close()
            return
        }
    }
}
```

### تنسيق بيانات DNS عبر التيار

يستخدم DNS عبر TCP بادئة طول 2 بايت:

```go
func HandleStreamDNSRequest(ctx, router, conn, metadata) error {
    // 1. قراءة بادئة الطول 2 بايت
    var queryLength uint16
    binary.Read(conn, binary.BigEndian, &queryLength)

    // 2. قراءة رسالة DNS
    buffer := buf.NewSize(int(queryLength))
    buffer.ReadFullFrom(conn, int(queryLength))

    // 3. فك التعبئة والتوجيه
    var message mDNS.Msg
    message.Unpack(buffer.Bytes())

    // 4. التبادل عبر موجه DNS (غير متزامن)
    go func() {
        response, _ := router.Exchange(ctx, &message, adapter.DNSQueryOptions{})
        // كتابة الاستجابة مسبوقة بالطول
        binary.BigEndian.PutUint16(responseBuffer.ExtendHeader(2), uint16(len(n)))
        conn.Write(responseBuffer.Bytes())
    }()
}
```

### DNS عبر الحزم (UDP)

تتم معالجة حزم DNS عبر UDP بشكل متزامن مع مهلة خمول:

```go
func (d *Outbound) NewPacketConnectionEx(ctx, conn, metadata, onClose) {
    NewDNSPacketConnection(ctx, d.router, conn, nil, metadata)
}
```

معالج الحزم:
1. يقرأ حزم DNS من الاتصال
2. يفك تعبئة كل حزمة كرسالة DNS
3. يتبادل عبر موجه DNS في goroutine
4. يكتب الاستجابة مع دعم اقتطاع DNS
5. يستخدم ملغياً مع `C.DNSTimeout` لكشف الخمول

```go
go func() {
    response, _ := router.Exchange(ctx, &message, adapter.DNSQueryOptions{})
    responseBuffer, _ := dns.TruncateDNSMessage(&message, response, 1024)
    conn.WritePacket(responseBuffer, destination)
}()
```

## أمثلة على التكوين

### Direct

```json
{
  "type": "direct",
  "tag": "direct-out"
}
```

### Direct مع استراتيجية النطاق

```json
{
  "type": "direct",
  "tag": "direct-out",
  "domain_strategy": "prefer_ipv4"
}
```

### Block

```json
{
  "type": "block",
  "tag": "block-out"
}
```

### DNS

```json
{
  "type": "dns",
  "tag": "dns-out"
}
```

### وارد Direct (مع تجاوز)

```json
{
  "type": "direct",
  "tag": "direct-in",
  "listen": "::",
  "listen_port": 5353,
  "override_address": "8.8.8.8",
  "override_port": 53
}
```
