# نظام المتصل

نظام المتصل هو مصنع الاتصالات الصادرة. يغلّف `net.Dialer` في Go بميزات خاصة بالبروتوكول: حل النطاقات، توجيه التحويل، TCP Fast Open، ربط الواجهة، والاتصالات المتوازية.

**المصدر**: `common/dialer/`

## إنشاء المتصل

```go
func New(ctx context.Context, options option.DialerOptions, isDomain bool) (N.Dialer, error)
```

تبني دالة المصنع هذه سلسلة متصلين بناءً على الخيارات:

```
DefaultDialer → [ResolveDialer] → [DetourDialer]
     ↓
  BindInterface / RoutingMark / ProtectFunc
  TCP Fast Open
  مهلة الاتصال
  حل النطاقات (إذا isDomain)
```

## DefaultDialer

المتصل الأساسي يغلّف `net.Dialer` بخيارات مقبس خاصة بالمنصة:

```go
type DefaultDialer struct {
    dialer4           tcpDialer    // متصل IPv4
    dialer6           tcpDialer    // متصل IPv6
    udpDialer4        net.Dialer
    udpDialer6        net.Dialer
    udpAddr4          string
    udpAddr6          string
    isWireGuardListener bool
    networkManager    adapter.NetworkManager
    networkStrategy   *C.NetworkStrategy
}
```

الميزات:
- **مكدس مزدوج**: متصلون منفصلون لـ IPv4 وIPv6
- **خيارات المقبس**: `SO_MARK`، `SO_BINDTODEVICE`، `IP_TRANSPARENT`
- **TCP Fast Open**: عبر مكتبة `tfo-go`
- **مهلة الاتصال**: `C.TCPConnectTimeout` (15 ثانية افتراضياً)

### المتصل المتوازي للواجهات

للأجهزة المحمولة ذات واجهات شبكة متعددة:

```go
type ParallelInterfaceDialer interface {
    DialParallelInterface(ctx, network, destination, strategy, networkType, fallbackType, fallbackDelay) (net.Conn, error)
    ListenSerialInterfacePacket(ctx, destination, strategy, networkType, fallbackType, fallbackDelay) (net.PacketConn, error)
}
```

يجرب واجهات شبكة مختلفة بناءً على الاستراتيجية (مثل تفضيل WiFi، الرجوع إلى الخلوي بعد تأخير).

### المتصل المتوازي للشبكة

اتصال متوازٍ بأسلوب Happy Eyeballs للمكدس المزدوج:

```go
type ParallelNetworkDialer interface {
    DialParallelNetwork(ctx, network, destination, destinationAddresses, strategy, networkType, fallbackType, fallbackDelay) (net.Conn, error)
}
```

## DetourDialer

يوجّه حركة المرور عبر صادر آخر:

```go
type DetourDialer struct {
    outboundManager adapter.OutboundManager
    detour          string  // وسم الصادر المستخدم
}

func (d *DetourDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    outbound, _ := d.outboundManager.Outbound(d.detour)
    return outbound.DialContext(ctx, network, destination)
}
```

يُستخدم عندما يحدد صادر `detour` للتسلسل عبر صادر آخر (مثل VLESS ← direct).

## ResolveDialer

يغلّف متصلاً لحل النطاقات قبل الاتصال:

```go
type ResolveDialer struct {
    dialer    N.Dialer
    dnsRouter adapter.DNSRouter
    strategy  C.DomainStrategy
    server    string
}

func (d *ResolveDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    if destination.IsFqdn() {
        addresses, err := d.dnsRouter.Lookup(ctx, destination.Fqdn, options)
        // استخدام العناوين المحلولة مع الاتصال المتوازي
        return N.DialSerial(ctx, d.dialer, network, destination, addresses)
    }
    return d.dialer.DialContext(ctx, network, destination)
}
```

## متصل WireGuard

متصل خاص بـ WireGuard يستخدم شبكة نقطة نهاية WireGuard:

```go
type WireGuardDialer struct {
    dialer N.Dialer
}
```

## الاتصال التسلسلي/المتوازي

```go
// تجربة العناوين واحداً تلو الآخر
func DialSerial(ctx, dialer, network, destination, addresses) (net.Conn, error)

// التجربة مع استراتيجية الشبكة (اختيار الواجهة)
func DialSerialNetwork(ctx, dialer, network, destination, addresses,
    strategy, networkType, fallbackType, fallbackDelay) (net.Conn, error)

// الاستماع للحزم مع اختيار العنوان
func ListenSerialNetworkPacket(ctx, dialer, destination, addresses,
    strategy, networkType, fallbackType, fallbackDelay) (net.PacketConn, netip.Addr, error)
```

## خيارات المتصل

```go
type DialerOptions struct {
    Detour              string
    BindInterface       string
    Inet4BindAddress    *ListenAddress
    Inet6BindAddress    *ListenAddress
    ProtectPath         string
    RoutingMark         uint32
    ReuseAddr           bool
    ConnectTimeout      Duration
    TCPFastOpen         bool
    TCPMultiPath        bool
    UDPFragment         *bool
    UDPFragmentDefault  bool
    DomainResolver      *DomainResolveOptions
    NetworkStrategy     *NetworkStrategy
    NetworkType         Listable[InterfaceType]
    FallbackNetworkType Listable[InterfaceType]
    FallbackDelay       Duration
    IsWireGuardListener bool
}
```
