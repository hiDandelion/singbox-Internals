# بروتوكول WireGuard

يُنفذ WireGuard في sing-box **كنقطة نهاية (Endpoint)** (وليس كزوج وارد/صادر)، باستخدام مكتبة `wireguard-go` مع خلفيتي أجهزة: شبكات فضاء المستخدم عبر gVisor أو TUN النظام. تدعم نقطة النهاية حركة المرور الواردة والصادرة، وتغليف جهاز NAT لـ ICMP/ping، وحل DNS للأقران.

**المصدر**: `protocol/wireguard/endpoint.go`، `transport/wireguard/endpoint.go`، `transport/wireguard/device.go`، `transport/wireguard/device_nat.go`

## بنية نقطة النهاية

يستخدم WireGuard نمط `endpoint.Adapter`، وهو وارد+صادر مدمج:

```go
type Endpoint struct {
    endpoint.Adapter
    ctx            context.Context
    router         adapter.Router
    dnsRouter      adapter.DNSRouter
    logger         logger.ContextLogger
    localAddresses []netip.Prefix
    endpoint       *wireguard.Endpoint
}
```

ينفذ واجهات متعددة:

```go
var (
    _ adapter.OutboundWithPreferredRoutes = (*Endpoint)(nil)
    _ dialer.PacketDialerWithDestination  = (*Endpoint)(nil)
)
```

### دعم الشبكة

يدعم WireGuard بروتوكولات TCP وUDP وICMP:

```go
endpoint.NewAdapterWithDialerOptions(C.TypeWireGuard, tag,
    []string{N.NetworkTCP, N.NetworkUDP, N.NetworkICMP}, options.DialerOptions)
```

## واجهة الجهاز

تجرد واجهة `Device` تنفيذات أنفاق WireGuard المختلفة:

```go
type Device interface {
    wgTun.Device       // قراءة/كتابة الحزم
    N.Dialer           // DialContext / ListenPacket
    Start() error
    SetDevice(device *device.Device)
    Inet4Address() netip.Addr
    Inet6Address() netip.Addr
}
```

### مصنع الأجهزة

يختار مصنع `NewDevice` التنفيذ بناءً على علامة `System`:

```go
func NewDevice(options DeviceOptions) (Device, error) {
    if !options.System {
        return newStackDevice(options)        // مكدس فضاء المستخدم gVisor
    } else if !tun.WithGVisor {
        return newSystemDevice(options)       // جهاز TUN النظام
    } else {
        return newSystemStackDevice(options)  // TUN النظام + مكدس gVisor
    }
}
```

- **جهاز المكدس** (افتراضي): شبكات فضاء المستخدم البحتة عبر gVisor. لا حاجة لجهاز TUN النواة.
- **جهاز النظام**: ينشئ واجهة TUN حقيقية على نظام التشغيل. يتطلب صلاحيات مرتفعة.
- **جهاز مكدس النظام**: TUN النظام مع gVisor لمعالجة الحزم.

## غلاف جهاز NAT

يغلف `NatDevice` الجهاز `Device` لتوفير دعم ICMP/ping عبر إعادة كتابة عنوان المصدر:

```go
type NatDevice interface {
    Device
    CreateDestination(metadata, routeContext, timeout) (tun.DirectRouteDestination, error)
}

type natDeviceWrapper struct {
    Device
    ctx            context.Context
    logger         logger.ContextLogger
    packetOutbound chan *buf.Buffer
    rewriter       *ping.SourceRewriter
    buffer         [][]byte
}
```

### إنشاء جهاز NAT

إذا لم يدعم الجهاز الأساسي NAT أصلياً، يتم تطبيق الغلاف:

```go
tunDevice, _ := NewDevice(deviceOptions)
natDevice, isNatDevice := tunDevice.(NatDevice)
if !isNatDevice {
    natDevice = NewNATDevice(options.Context, options.Logger, tunDevice)
}
```

### اعتراض الحزم

يعترض غلاف NAT القراءات لحقن استجابات ICMP الصادرة ويعترض الكتابات لإعادة كتابة عناوين مصدر ICMP:

```go
func (d *natDeviceWrapper) Read(bufs [][]byte, sizes []int, offset int) (n int, err error) {
    select {
    case packet := <-d.packetOutbound:
        defer packet.Release()
        sizes[0] = copy(bufs[0][offset:], packet.Bytes())
        return 1, nil
    default:
    }
    return d.Device.Read(bufs, sizes, offset)
}

func (d *natDeviceWrapper) Write(bufs [][]byte, offset int) (int, error) {
    for _, buffer := range bufs {
        handled, err := d.rewriter.WriteBack(buffer[offset:])
        if handled {
            // تمت معالجة استجابة ICMP داخلياً
        } else {
            d.buffer = append(d.buffer, buffer)
        }
    }
    // تحويل الحزم غير ICMP إلى الجهاز الحقيقي
    d.Device.Write(d.buffer, offset)
}
```

## نقطة النهاية على مستوى النقل

يدير `transport/wireguard/endpoint.go` دورة حياة جهاز WireGuard:

```go
type Endpoint struct {
    options        EndpointOptions
    peers          []peerConfig
    ipcConf        string
    allowedAddress []netip.Prefix
    tunDevice      Device
    natDevice      NatDevice
    device         *device.Device
    allowedIPs     *device.AllowedIPs
}
```

### تكوين IPC

يتم تمرير تكوين WireGuard إلى `wireguard-go` عبر سلاسل بروتوكول IPC:

```go
privateKeyBytes, _ := base64.StdEncoding.DecodeString(options.PrivateKey)
privateKey := hex.EncodeToString(privateKeyBytes)
ipcConf := "private_key=" + privateKey
if options.ListenPort != 0 {
    ipcConf += "\nlisten_port=" + F.ToString(options.ListenPort)
}
```

يتم إنشاء تكوين القرين بالمثل:

```go
func (c peerConfig) GenerateIpcLines() string {
    ipcLines := "\npublic_key=" + c.publicKeyHex
    if c.endpoint.IsValid() {
        ipcLines += "\nendpoint=" + c.endpoint.String()
    }
    if c.preSharedKeyHex != "" {
        ipcLines += "\npreshared_key=" + c.preSharedKeyHex
    }
    for _, allowedIP := range c.allowedIPs {
        ipcLines += "\nallowed_ip=" + allowedIP.String()
    }
    if c.keepalive > 0 {
        ipcLines += "\npersistent_keepalive_interval=" + F.ToString(c.keepalive)
    }
    return ipcLines
}
```

### البدء على مرحلتين

تمتلك نقطة النهاية بدءاً على مرحلتين للتعامل مع حل DNS لنقاط نهاية الأقران:

```go
func (w *Endpoint) Start(stage adapter.StartStage) error {
    switch stage {
    case adapter.StartStateStart:
        return w.endpoint.Start(false)   // البدء بدون حل DNS
    case adapter.StartStatePostStart:
        return w.endpoint.Start(true)    // حل نطاقات الأقران الآن
    }
}
```

إذا كانت للأقران نقاط نهاية FQDN، يتم تأجيل الحل إلى `PostStart` عندما يكون DNS متاحاً:

```go
ResolvePeer: func(domain string) (netip.Addr, error) {
    endpointAddresses, _ := ep.dnsRouter.Lookup(ctx, domain, outboundDialer.(dialer.ResolveDialer).QueryOptions())
    return endpointAddresses[0], nil
},
```

### البايتات المحجوزة

يدعم WireGuard بايتات محجوزة لكل قرين (تُستخدم من قبل بعض التنفيذات مثل Cloudflare WARP):

```go
if len(rawPeer.Reserved) > 0 {
    if len(rawPeer.Reserved) != 3 {
        return nil, E.New("invalid reserved value, required 3 bytes")
    }
    copy(peer.reserved[:], rawPeer.Reserved[:])
}
```

### اختيار الربط

تستخدم نقطة النهاية تنفيذات ربط مختلفة بناءً على نوع المتصل:

```go
wgListener, isWgListener := common.Cast[dialer.WireGuardListener](e.options.Dialer)
if isWgListener {
    bind = conn.NewStdNetBind(wgListener.WireGuardControl())
} else {
    // ClientBind لاتصالات القرين الواحد
    bind = NewClientBind(ctx, logger, dialer, isConnect, connectAddr, reserved)
}
```

## نقطة النهاية على مستوى البروتوكول

يعالج `protocol/wireguard/endpoint.go` تكامل التوجيه:

### إعادة كتابة العنوان المحلي

يتم إعادة كتابة الاتصالات إلى عنوان نقطة نهاية WireGuard نفسها إلى عنوان الاسترجاع:

```go
func (w *Endpoint) NewConnectionEx(ctx, conn, source, destination, onClose) {
    for _, localPrefix := range w.localAddresses {
        if localPrefix.Contains(destination.Addr) {
            metadata.OriginDestination = destination
            if destination.Addr.Is4() {
                destination.Addr = netip.AddrFrom4([4]uint8{127, 0, 0, 1})
            } else {
                destination.Addr = netip.IPv6Loopback()
            }
            break
        }
    }
}
```

### حل DNS الصادر

يحل الصادر أسماء FQDN باستخدام موجه DNS:

```go
func (w *Endpoint) DialContext(ctx, network, destination) (net.Conn, error) {
    if destination.IsFqdn() {
        destinationAddresses, _ := w.dnsRouter.Lookup(ctx, destination.Fqdn, adapter.DNSQueryOptions{})
        return N.DialSerial(ctx, w.endpoint, network, destination, destinationAddresses)
    }
    return w.endpoint.DialContext(ctx, network, destination)
}
```

### المسارات المفضلة

تعلن نقطة النهاية عن العناوين التي يمكنها توجيهها، مما يمكّن الموجه من اختيارها للوجهات المطابقة:

```go
func (w *Endpoint) PreferredAddress(address netip.Addr) bool {
    return w.endpoint.Lookup(address) != nil
}
```

### تكامل مدير الإيقاف المؤقت

تستجيب نقطة النهاية لأحداث إيقاف/إيقاظ الجهاز (مثل نوم الهاتف المحمول):

```go
func (e *Endpoint) onPauseUpdated(event int) {
    switch event {
    case pause.EventDevicePaused, pause.EventNetworkPause:
        e.device.Down()
    case pause.EventDeviceWake, pause.EventNetworkWake:
        e.device.Up()
    }
}
```

## مثال على التكوين

```json
{
  "type": "wireguard",
  "tag": "wg-ep",
  "system": false,
  "name": "wg0",
  "mtu": 1420,
  "address": ["10.0.0.2/32", "fd00::2/128"],
  "private_key": "base64-encoded-private-key",
  "peers": [
    {
      "address": "server.example.com",
      "port": 51820,
      "public_key": "base64-encoded-public-key",
      "pre_shared_key": "optional-base64-psk",
      "allowed_ips": ["0.0.0.0/0", "::/0"],
      "persistent_keepalive_interval": 25,
      "reserved": [0, 0, 0]
    }
  ],
  "workers": 2
}
```
