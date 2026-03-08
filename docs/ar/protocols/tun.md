# وارد TUN

TUN (نفق الشبكة) هو آلية الوكيل الشفاف الرئيسية في sing-box. ينشئ واجهة شبكة افتراضية تلتقط جميع حركة مرور النظام. يستخدم sing-box مكتبة `sing-tun` التي تدعم تنفيذات مكدس شبكة متعددة، والتوجيه التلقائي، وإعادة التوجيه التلقائي عبر nftables.

**المصدر**: `protocol/tun/inbound.go`، `sing-tun`

## البنية

```go
type Inbound struct {
    tag                         string
    ctx                         context.Context
    router                      adapter.Router
    networkManager              adapter.NetworkManager
    logger                      log.ContextLogger
    tunOptions                  tun.Options
    udpTimeout                  time.Duration
    stack                       string
    tunIf                       tun.Tun
    tunStack                    tun.Stack
    platformInterface           adapter.PlatformInterface
    platformOptions             option.TunPlatformOptions
    autoRedirect                tun.AutoRedirect
    routeRuleSet                []adapter.RuleSet
    routeRuleSetCallback        []*list.Element[adapter.RuleSetUpdateCallback]
    routeExcludeRuleSet         []adapter.RuleSet
    routeExcludeRuleSetCallback []*list.Element[adapter.RuleSetUpdateCallback]
    routeAddressSet             []*netipx.IPSet
    routeExcludeAddressSet      []*netipx.IPSet
}
```

## اختيار MTU

يتم اختيار MTU تلقائياً بناءً على المنصة:

```go
if tunMTU == 0 {
    if platformInterface != nil && platformInterface.UnderNetworkExtension() {
        // iOS/macOS Network Extension: 4064 (4096 - UTUN_IF_HEADROOM_SIZE)
        tunMTU = 4064
    } else if C.IsAndroid {
        // Android: بعض الأجهزة تبلغ عن ENOBUFS مع 65535
        tunMTU = 9000
    } else {
        tunMTU = 65535
    }
}
```

## GSO (تفريغ التجزئة العام)

يتم تفعيل GSO تلقائياً على Linux عند استيفاء الشروط:

```go
enableGSO := C.IsLinux && options.Stack == "gvisor" && platformInterface == nil && tunMTU > 0 && tunMTU < 49152
```

## خيارات مكدس الشبكة

يحدد خيار `stack` كيفية معالجة الحزم الملتقطة:

```go
tunStack, _ := tun.NewStack(t.stack, tun.StackOptions{
    Context:                t.ctx,
    Tun:                    tunInterface,
    TunOptions:             t.tunOptions,
    UDPTimeout:             t.udpTimeout,
    Handler:                t,
    Logger:                 t.logger,
    ForwarderBindInterface: forwarderBindInterface,
    InterfaceFinder:        t.networkManager.InterfaceFinder(),
    IncludeAllNetworks:     includeAllNetworks,
})
```

### المكدسات المتاحة

| المكدس | الوصف |
|-------|-------------|
| `gvisor` | مكدس TCP/IP لفضاء المستخدم من Google. أفضل توافق، أعلى استهلاك للمعالج. |
| `system` | يستخدم مكدس نواة نظام التشغيل. استهلاك أقل للمعالج، يتطلب إعداداً على مستوى نظام التشغيل. |
| `mixed` | gVisor لـ TCP، النظام لـ UDP. نهج متوازن. |

## تكوين العناوين

يتم فصل عناوين IPv4 وIPv6 من قائمة `Address` الموحدة:

```go
address := options.Address
inet4Address := common.Filter(address, func(it netip.Prefix) bool {
    return it.Addr().Is4()
})
inet6Address := common.Filter(address, func(it netip.Prefix) bool {
    return it.Addr().Is6()
})
```

ينطبق نفس النمط على عناوين المسار وعناوين استثناء المسار.

## خيارات TUN

هيكل خيارات TUN الكامل يتضمن:

```go
tun.Options{
    Name:                 options.InterfaceName,
    MTU:                  tunMTU,
    GSO:                  enableGSO,
    Inet4Address:         inet4Address,
    Inet6Address:         inet6Address,
    AutoRoute:            options.AutoRoute,
    StrictRoute:          options.StrictRoute,
    IncludeInterface:     options.IncludeInterface,
    ExcludeInterface:     options.ExcludeInterface,
    IncludeUID:           includeUID,
    ExcludeUID:           excludeUID,
    IncludeAndroidUser:   options.IncludeAndroidUser,
    IncludePackage:       options.IncludePackage,
    ExcludePackage:       options.ExcludePackage,
    IncludeMACAddress:    includeMACAddress,
    ExcludeMACAddress:    excludeMACAddress,
    // ... فهارس جدول التوجيه، العلامات، إلخ
}
```

### تصفية UID

يمكن تحديد نطاقات UID كمعرفات فردية أو نطاقات:

```go
includeUID := uidToRange(options.IncludeUID)
if len(options.IncludeUIDRange) > 0 {
    includeUID, _ = parseRange(includeUID, options.IncludeUIDRange)
}
```

يدعم تحليل النطاقات تنسيق `start:end`:

```go
func parseRange(uidRanges []ranges.Range[uint32], rangeList []string) ([]ranges.Range[uint32], error) {
    for _, uidRange := range rangeList {
        subIndex := strings.Index(uidRange, ":")
        start, _ := strconv.ParseUint(uidRange[:subIndex], 0, 32)
        end, _ := strconv.ParseUint(uidRange[subIndex+1:], 0, 32)
        uidRanges = append(uidRanges, ranges.New(uint32(start), uint32(end)))
    }
}
```

### تصفية عنوان MAC

يتم تحليل عناوين MAC للتصفية على مستوى الشبكة المحلية:

```go
for i, macString := range options.IncludeMACAddress {
    mac, _ := net.ParseMAC(macString)
    includeMACAddress = append(includeMACAddress, mac)
}
```

## التوجيه التلقائي (Auto-Route)

عند تفعيل `auto_route`، يقوم sing-box تلقائياً بتكوين جداول التوجيه لتوجيه حركة المرور عبر واجهة TUN. يتضمن التكوين:

```go
IPRoute2TableIndex:    tableIndex,    // افتراضي: tun.DefaultIPRoute2TableIndex
IPRoute2RuleIndex:     ruleIndex,     // افتراضي: tun.DefaultIPRoute2RuleIndex
```

## إعادة التوجيه التلقائي (Auto-Redirect)

تستخدم إعادة التوجيه التلقائي nftables لإعادة توجيه حركة المرور بدون تعديل جدول التوجيه. تتطلب `auto_route`:

```go
if options.AutoRedirect {
    if !options.AutoRoute {
        return nil, E.New("`auto_route` is required by `auto_redirect`")
    }
    inbound.autoRedirect, _ = tun.NewAutoRedirect(tun.AutoRedirectOptions{
        TunOptions:             &inbound.tunOptions,
        Context:                ctx,
        Handler:                (*autoRedirectHandler)(inbound),
        Logger:                 logger,
        NetworkMonitor:         networkManager.NetworkMonitor(),
        InterfaceFinder:        networkManager.InterfaceFinder(),
        TableName:              "sing-box",
        DisableNFTables:        dErr == nil && disableNFTables,
        RouteAddressSet:        &inbound.routeAddressSet,
        RouteExcludeAddressSet: &inbound.routeExcludeAddressSet,
    })
}
```

يمكن لمتغير البيئة `DISABLE_NFTABLES` فرض وضع iptables:

```go
disableNFTables, dErr := strconv.ParseBool(os.Getenv("DISABLE_NFTABLES"))
```

### علامات إعادة التوجيه التلقائي

تُستخدم علامات حركة المرور لمنع حلقات التوجيه:

```go
AutoRedirectInputMark:  inputMark,   // افتراضي: tun.DefaultAutoRedirectInputMark
AutoRedirectOutputMark: outputMark,  // افتراضي: tun.DefaultAutoRedirectOutputMark
AutoRedirectResetMark:  resetMark,   // افتراضي: tun.DefaultAutoRedirectResetMark
AutoRedirectNFQueue:    nfQueue,     // افتراضي: tun.DefaultAutoRedirectNFQueue
```

## مجموعات عناوين المسار

يدعم TUN مجموعات عناوين مسار ديناميكية من مجموعات القواعد:

```go
for _, routeAddressSet := range options.RouteAddressSet {
    ruleSet, loaded := router.RuleSet(routeAddressSet)
    if !loaded {
        return nil, E.New("rule-set not found: ", routeAddressSet)
    }
    inbound.routeRuleSet = append(inbound.routeRuleSet, ruleSet)
}
```

عند تحديث مجموعات القواعد، يتم تحديث عناوين المسار:

```go
func (t *Inbound) updateRouteAddressSet(it adapter.RuleSet) {
    t.routeAddressSet = common.FlatMap(t.routeRuleSet, adapter.RuleSet.ExtractIPSet)
    t.routeExcludeAddressSet = common.FlatMap(t.routeExcludeRuleSet, adapter.RuleSet.ExtractIPSet)
    t.autoRedirect.UpdateRouteAddressSet()
}
```

## البدء على مرحلتين

يستخدم TUN بدءاً على مرحلتين:

### المرحلة 1: `StartStateStart`

1. بناء قواعد Android إذا كان ذلك قابلاً للتطبيق
2. حساب اسم الواجهة
3. استخراج عناوين المسار من مجموعات القواعد
4. فتح واجهة TUN (تعتمد على المنصة أو `tun.New()`)
5. إنشاء مكدس الشبكة

### المرحلة 2: `StartStatePostStart`

1. بدء مكدس الشبكة
2. بدء واجهة TUN
3. تهيئة إعادة التوجيه التلقائي (إذا كانت مفعلة)

```go
func (t *Inbound) Start(stage adapter.StartStage) error {
    switch stage {
    case adapter.StartStateStart:
        // فتح TUN، إنشاء المكدس
        if t.platformInterface != nil && t.platformInterface.UsePlatformInterface() {
            tunInterface, _ = t.platformInterface.OpenInterface(&tunOptions, t.platformOptions)
        } else {
            tunInterface, _ = tun.New(tunOptions)
        }
        tunStack, _ := tun.NewStack(t.stack, stackOptions)

    case adapter.StartStatePostStart:
        t.tunStack.Start()
        t.tunIf.Start()
        if t.autoRedirect != nil {
            t.autoRedirect.Start()
        }
    }
}
```

## معالجة الاتصال

### PrepareConnection

قبل إنشاء الاتصالات، يفحص TUN قواعد التوجيه:

```go
func (t *Inbound) PrepareConnection(network, source, destination, routeContext, timeout) (tun.DirectRouteDestination, error) {
    routeDestination, err := t.router.PreMatch(adapter.InboundContext{
        Inbound:     t.tag,
        InboundType: C.TypeTun,
        IPVersion:   ipVersion,
        Network:     network,
        Source:      source,
        Destination: destination,
    }, routeContext, timeout, false)
    // معالجة حالات التجاوز والرفض وICMP
}
```

### اتصالات TCP/UDP

التوجيه القياسي عبر الموجه:

```go
func (t *Inbound) NewConnectionEx(ctx, conn, source, destination, onClose) {
    metadata.Inbound = t.tag
    metadata.InboundType = C.TypeTun
    metadata.Source = source
    metadata.Destination = destination
    t.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### معالج إعادة التوجيه التلقائي

نوع معالج منفصل يعالج الاتصالات المعاد توجيهها تلقائياً:

```go
type autoRedirectHandler Inbound

func (t *autoRedirectHandler) NewConnectionEx(ctx, conn, source, destination, onClose) {
    // نفس النمط، لكن يُسجل كـ "redirect connection"
    t.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## تكامل المنصة

على المنصات المحمولة (iOS/Android)، يستخدم TUN واجهة المنصة:

```go
if t.platformInterface != nil && t.platformInterface.UsePlatformInterface() {
    tunInterface, _ = t.platformInterface.OpenInterface(&tunOptions, t.platformOptions)
}
```

تتضمن الخيارات الخاصة بالمنصة:
- `ForwarderBindInterface`: ربط المحول بواجهة محددة (الهاتف المحمول)
- `IncludeAllNetworks`: خيار Network Extension لـ iOS
- `MultiPendingPackets`: حل بديل لـ Darwin مع MTU صغير

## مثال على التكوين

```json
{
  "type": "tun",
  "tag": "tun-in",
  "interface_name": "tun0",
  "address": ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
  "mtu": 9000,
  "auto_route": true,
  "strict_route": true,
  "stack": "mixed",
  "route_address": ["0.0.0.0/0", "::/0"],
  "route_exclude_address": ["192.168.0.0/16"],
  "route_address_set": ["geoip-cn"],
  "auto_redirect": true,
  "include_package": ["com.example.app"],
  "exclude_package": ["com.example.excluded"],
  "udp_timeout": "5m"
}
```
