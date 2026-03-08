# واجهة المنصة

توفر واجهة المنصة طبقة تجريد للمنصات المحمولة (Android/iOS) لدمج sing-box في التطبيقات الأصلية عبر ربطات gomobile. تتعامل مع إدارة جهاز TUN، ومراقبة الشبكة، وتحديد العمليات، والعمليات على مستوى النظام.

**المصدر**: `experimental/libbox/`، `adapter/platform.go`

## هندسة ذات طبقتين

يوجد نوعان من `PlatformInterface`:

1. **`adapter.PlatformInterface`** (داخلي) -- الواجهة المستخدمة داخل نواة sing-box
2. **`libbox.PlatformInterface`** (خارجي) -- الواجهة المتوافقة مع gomobile التي ينفذها التطبيق المضيف

`platformInterfaceWrapper` في libbox يجسر بينهما:

```go
var _ adapter.PlatformInterface = (*platformInterfaceWrapper)(nil)

type platformInterfaceWrapper struct {
    iif                    PlatformInterface  // واجهة gomobile من التطبيق المضيف
    useProcFS              bool
    networkManager         adapter.NetworkManager
    myTunName              string
    defaultInterfaceAccess sync.Mutex
    defaultInterface       *control.Interface
    isExpensive            bool
    isConstrained          bool
}
```

## adapter.PlatformInterface (داخلي)

```go
type PlatformInterface interface {
    Initialize(networkManager NetworkManager) error

    UsePlatformAutoDetectInterfaceControl() bool
    AutoDetectInterfaceControl(fd int) error

    UsePlatformInterface() bool
    OpenInterface(options *tun.Options, platformOptions TunPlatformOptions) (tun.Tun, error)

    UsePlatformDefaultInterfaceMonitor() bool
    CreateDefaultInterfaceMonitor(logger logger.Logger) tun.DefaultInterfaceMonitor

    UsePlatformNetworkInterfaces() bool
    NetworkInterfaces() ([]NetworkInterface, error)

    UnderNetworkExtension() bool
    NetworkExtensionIncludeAllNetworks() bool

    ClearDNSCache()
    RequestPermissionForWIFIState() error
    ReadWIFIState() WIFIState
    SystemCertificates() []string

    UsePlatformConnectionOwnerFinder() bool
    FindConnectionOwner(request *FindConnectionOwnerRequest) (*ConnectionOwner, error)

    UsePlatformWIFIMonitor() bool

    UsePlatformNotification() bool
    SendNotification(notification *Notification) error

    UsePlatformNeighborResolver() bool
    StartNeighborMonitor(listener NeighborUpdateListener) error
    CloseNeighborMonitor(listener NeighborUpdateListener) error
}
```

كل طريقة `UsePlatform*()` تُرجع true للإشارة إلى أن المنصة توفر تلك القدرة، مما يجعل sing-box يستخدم تطبيق المنصة بدلاً من تطبيق Go الافتراضي.

## libbox.PlatformInterface (خارجي/gomobile)

```go
type PlatformInterface interface {
    LocalDNSTransport() LocalDNSTransport
    UsePlatformAutoDetectInterfaceControl() bool
    AutoDetectInterfaceControl(fd int32) error
    OpenTun(options TunOptions) (int32, error)          // يُرجع واصف ملف
    UseProcFS() bool
    FindConnectionOwner(ipProtocol int32, sourceAddress string,
        sourcePort int32, destinationAddress string,
        destinationPort int32) (*ConnectionOwner, error)
    StartDefaultInterfaceMonitor(listener InterfaceUpdateListener) error
    CloseDefaultInterfaceMonitor(listener InterfaceUpdateListener) error
    GetInterfaces() (NetworkInterfaceIterator, error)
    UnderNetworkExtension() bool
    IncludeAllNetworks() bool
    ReadWIFIState() *WIFIState
    SystemCertificates() StringIterator
    ClearDNSCache()
    SendNotification(notification *Notification) error
    StartNeighborMonitor(listener NeighborUpdateListener) error
    CloseNeighborMonitor(listener NeighborUpdateListener) error
    RegisterMyInterface(name string)
}
```

الاختلافات الرئيسية عن الواجهة الداخلية:
- تستخدم `int32` بدلاً من `int` (توافق gomobile)
- تُرجع مكررات بدلاً من شرائح (gomobile لا يدعم شرائح Go)
- `OpenTun` يُرجع واصف ملف خام بدلاً من كائن `tun.Tun`
- `StringIterator` يغلف `[]string` لاستهلاك gomobile

## إدارة جهاز TUN

### فتح TUN

يحوّل غلاف المنصة بين أنواع TUN في libbox والأنواع الداخلية:

```go
func (w *platformInterfaceWrapper) OpenInterface(options *tun.Options, platformOptions) (tun.Tun, error) {
    // 1. بناء نطاقات التوجيه التلقائي
    routeRanges, _ := options.BuildAutoRouteRanges(true)

    // 2. استدعاء المنصة لفتح TUN (يُرجع fd)
    tunFd, _ := w.iif.OpenTun(&tunOptions{options, routeRanges, platformOptions})

    // 3. الحصول على اسم النفق من fd
    options.Name, _ = getTunnelName(tunFd)

    // 4. التسجيل مع مراقب الواجهة
    options.InterfaceMonitor.RegisterMyInterface(options.Name)

    // 5. نسخ fd (قد تغلق المنصة الأصلي)
    dupFd, _ := dup(int(tunFd))
    options.FileDescriptor = dupFd

    // 6. إنشاء tun.Tun من الخيارات
    return tun.New(*options)
}
```

دالة `getTunnelName` خاصة بالمنصة:
- **Darwin**: تقرأ اسم الواجهة من fd عبر `ioctl`
- **Linux**: تقرأ من الرابط الرمزي `/proc/self/fd/<fd>` وتستخرج اسم tun
- **أخرى**: تُرجع اسماً بديلاً

## مراقب الواجهة الافتراضية

مراقب الواجهة الافتراضية للمنصة يغلف عمليات استدعاء تغيير الشبكة من التطبيق المضيف:

```go
type platformDefaultInterfaceMonitor struct {
    *platformInterfaceWrapper
    logger      logger.Logger
    callbacks   list.List[tun.DefaultInterfaceUpdateCallback]
    myInterface string
}
```

### تدفق التحديث

عندما يكتشف التطبيق المضيف تغييراً في الشبكة:

```go
func (m *platformDefaultInterfaceMonitor) UpdateDefaultInterface(
    interfaceName string, interfaceIndex32 int32,
    isExpensive bool, isConstrained bool) {

    // 1. تحديث علامات التكلفة/القيود
    // 2. إخبار مدير الشبكة بتحديث الواجهات
    // 3. البحث عن الواجهة الجديدة بالفهرس
    // 4. تحديث الواجهة الافتراضية المخزنة
    // 5. إخطار جميع عمليات الاستدعاء المسجلة (إذا تغيرت الواجهة)
}
```

إذا كان `interfaceIndex32 == -1`، فإن الجهاز لا يملك اتصالاً بالشبكة (جميع عمليات الاستدعاء تتلقى `nil`).

على Android، قد يتم إرسال التحديث إلى goroutine جديد عبر `sFixAndroidStack` لتجنب خلل في وقت تشغيل Go يتعلق بأحجام مكدسات خيوط Android.

## تعداد واجهات الشبكة

```go
func (w *platformInterfaceWrapper) NetworkInterfaces() ([]adapter.NetworkInterface, error) {
    interfaceIterator, _ := w.iif.GetInterfaces()
    var interfaces []adapter.NetworkInterface
    for _, netInterface := range iteratorToArray(interfaceIterator) {
        // تخطي واجهة TUN الخاصة بنا
        if netInterface.Name == w.myTunName {
            continue
        }
        interfaces = append(interfaces, adapter.NetworkInterface{
            Interface: control.Interface{
                Index:     int(netInterface.Index),
                MTU:       int(netInterface.MTU),
                Name:      netInterface.Name,
                Addresses: common.Map(iteratorToArray(netInterface.Addresses), netip.MustParsePrefix),
                Flags:     linkFlags(uint32(netInterface.Flags)),
            },
            Type:        C.InterfaceType(netInterface.Type),
            DNSServers:  iteratorToArray(netInterface.DNSServer),
            Expensive:   netInterface.Metered || isDefault && w.isExpensive,
            Constrained: isDefault && w.isConstrained,
        })
    }
    // إزالة التكرار بالاسم
    return common.UniqBy(interfaces, func(it) string { return it.Name }), nil
}
```

أنواع الواجهات هي:
```go
const (
    InterfaceTypeWIFI     = int32(C.InterfaceTypeWIFI)
    InterfaceTypeCellular = int32(C.InterfaceTypeCellular)
    InterfaceTypeEthernet = int32(C.InterfaceTypeEthernet)
    InterfaceTypeOther    = int32(C.InterfaceTypeOther)
)
```

## مالك اتصال العملية

يدعم غلاف المنصة وضعين للعثور على مالكي الاتصالات:

```go
func (w *platformInterfaceWrapper) FindConnectionOwner(request) (*ConnectionOwner, error) {
    if w.useProcFS {
        // الوضع 1: فحص procfs المباشر (Android مع صلاحيات root/VPN)
        uid := procfs.ResolveSocketByProcSearch(network, source, destination)
        return &ConnectionOwner{UserId: uid}, nil
    }
    // الوضع 2: تفويض للمنصة (يستخدم ConnectivityManager في Android)
    result, _ := w.iif.FindConnectionOwner(...)
    return &ConnectionOwner{
        UserId:             result.UserId,
        ProcessPath:        result.ProcessPath,
        AndroidPackageName: result.AndroidPackageName,
    }, nil
}
```

## الإعداد والتهيئة

دالة `Setup()` تهيئ المسارات والخيارات العامة للمنصات المحمولة:

```go
type SetupOptions struct {
    BasePath                string   // دليل بيانات التطبيق
    WorkingPath             string   // دليل العمل لملفات التهيئة
    TempPath                string   // الملفات المؤقتة
    FixAndroidStack         bool     // حل بديل لخلل وقت تشغيل Go
    CommandServerListenPort int32    // منفذ خادم الأوامر المحلي
    CommandServerSecret     string   // سر المصادقة
    LogMaxLines             int      // حجم مخزن السجل
    Debug                   bool     // تفعيل ميزات التصحيح
}
```

## حالة وكيل النظام

```go
type SystemProxyStatus struct {
    Available bool
    Enabled   bool
}
```

يمثل هذا النوع ما إذا كانت تهيئة وكيل النظام متاحة على المنصة وما إذا كانت مفعلة حالياً.

## امتداد شبكة iOS

علامتان مهمتان لامتداد شبكة iOS (NEPacketTunnelProvider):

- **`UnderNetworkExtension()`**: تُرجع true عند التشغيل داخل عملية امتداد شبكة iOS، والتي لها قيود مختلفة في الذاكرة والقدرات
- **`NetworkExtensionIncludeAllNetworks()`**: تُرجع true عندما يكون استحقاق `includeAllNetworks` نشطاً، مما يوجه كل حركة مرور الجهاز (بما في ذلك عمليات النظام) عبر النفق

## الإشعارات

```go
type Notification struct {
    Identifier string
    TypeName   string
    TypeID     int32
    Title      string
    Subtitle   string
    Body       string
    OpenURL    string
}
```

تُستخدم الإشعارات للتنبيهات على مستوى النظام (مثل فشل تحديث مجموعة القواعد، تحذيرات انتهاء صلاحية الشهادة).

## قواعد عند الطلب (iOS)

```go
type OnDemandRule interface {
    Target() int32
    DNSSearchDomainMatch() StringIterator
    DNSServerAddressMatch() StringIterator
    InterfaceTypeMatch() int32
    SSIDMatch() StringIterator
    ProbeURL() string
}
```

تتحكم هذه القواعد في متى يجب تنشيط نفق VPN على iOS، بناءً على ظروف الشبكة (SSID، نوع الواجهة، تهيئة DNS).

## ملاحظات إعادة التنفيذ

1. **قيود gomobile**: واجهة libbox تستخدم `int32` بدلاً من `int`، ومكررات بدلاً من شرائح، وأنواع مؤشرات بدلاً من أنواع قيم. هذه كلها قيود gomobile
2. **نسخ واصف الملف**: يجب نسخ fd الخاص بـ TUN باستخدام `dup()` لأن المنصة قد تغلق fd الأصلي بعد إرجاعه
3. **تصفية الواجهات**: يجب استبعاد واجهة TUN نفسها من قائمة واجهات الشبكة لمنع حلقات التوجيه
4. **إصلاح مكدس Android**: علم `sFixAndroidStack` يرسل تحديثات الواجهة إلى goroutines جديدة لتجنب مشكلة Go رقم #68760 المتعلقة بأحجام مكدسات خيوط Android
5. **الاتصال ثنائي الاتجاه**: واجهة المنصة ثنائية الاتجاه -- التطبيق المضيف يستدعي sing-box (عبر `BoxService`) و sing-box يستدعي التطبيق المضيف (عبر `PlatformInterface`)
6. **خادم الأوامر**: خادم TCP محلي منفصل (غير موضح هنا) يتعامل مع IPC بين واجهة التطبيق المضيف وخدمة sing-box العاملة في الخلفية
