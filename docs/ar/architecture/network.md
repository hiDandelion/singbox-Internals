# مدير الشبكة

يتعامل مدير الشبكة مع الشبكات الخاصة بالمنصة: اكتشاف الواجهات، مراقبة المسارات، حماية المقابس، وتتبع حالة WIFI.

**المصدر**: `route/network.go`، `adapter/network.go`

## الواجهة

```go
type NetworkManager interface {
    Lifecycle
    Initialize(ruleSets []RuleSet)
    InterfaceFinder() control.InterfaceFinder
    UpdateInterfaces() error
    DefaultNetworkInterface() *NetworkInterface
    NetworkInterfaces() []NetworkInterface
    AutoDetectInterface() bool
    AutoDetectInterfaceFunc() control.Func
    ProtectFunc() control.Func
    DefaultOptions() NetworkOptions
    RegisterAutoRedirectOutputMark(mark uint32) error
    AutoRedirectOutputMark() uint32
    NetworkMonitor() tun.NetworkUpdateMonitor
    InterfaceMonitor() tun.DefaultInterfaceMonitor
    PackageManager() tun.PackageManager
    NeedWIFIState() bool
    WIFIState() WIFIState
    ResetNetwork()
}
```

## الميزات الرئيسية

### الاكتشاف التلقائي للواجهة

عند التفعيل، يربط sing-box تلقائياً الاتصالات الصادرة بواجهة الشبكة الافتراضية. هذا يمنع حلقات التوجيه عند تفعيل TUN — بدون ذلك، ستعود حركة المرور الصادرة إلى جهاز TUN.

```go
func (m *NetworkManager) AutoDetectInterfaceFunc() control.Func
```

يُرجع دالة تحكم مقبس تربط المقابس بالواجهة الافتراضية الحالية باستخدام `SO_BINDTODEVICE` (Linux) أو ما يعادلها.

### دالة الحماية (Android)

على Android، يجب "حماية" المقابس لتجاوز VPN:

```go
func (m *NetworkManager) ProtectFunc() control.Func
```

تستدعي هذه واجهة منصة Android لتعليم المقابس بـ `VpnService.protect()`.

### مراقبة الواجهة

يراقب `InterfaceMonitor` تغييرات الشبكة:

```go
type DefaultInterfaceMonitor interface {
    Start() error
    Close() error
    DefaultInterface() *Interface
    RegisterCallback(callback func()) *list.Element[func()]
    UnregisterCallback(element *list.Element[func()])
}
```

عند تغيّر الواجهة الافتراضية (مثل WiFi ← خلوي)، تُمسح جميع ذاكرات DNS المؤقتة وقد تُعاد تعيين الاتصالات.

### استراتيجية الشبكة

للأجهزة متعددة الواجهات، تتحكم استراتيجية الشبكة في الواجهات المستخدمة:

```go
type NetworkOptions struct {
    BindInterface        string
    RoutingMark          uint32
    DomainResolver       string
    DomainResolveOptions DNSQueryOptions
    NetworkStrategy      *C.NetworkStrategy
    NetworkType          []C.InterfaceType
    FallbackNetworkType  []C.InterfaceType
    FallbackDelay        time.Duration
}
```

الاستراتيجيات:
- **افتراضي**: استخدام واجهة النظام الافتراضية
- **تفضيل الخلوي**: محاولة الخلوي أولاً، ثم الرجوع إلى WiFi
- **تفضيل WiFi**: محاولة WiFi أولاً، ثم الرجوع إلى الخلوي
- **هجين**: استخدام الاثنين معاً (مسارات متعددة)

### حالة WIFI

للقواعد التي تطابق على SSID/BSSID الخاص بـ WIFI:

```go
type WIFIState struct {
    SSID  string
    BSSID string
}
```

يُحصل عليها عبر واجهات برمجة خاصة بالمنصة (NetworkManager على Linux، CoreWLAN على macOS، WifiManager على Android).

### أنواع واجهات الشبكة

```go
type InterfaceType uint8

const (
    InterfaceTypeWIFI     InterfaceType = iota
    InterfaceTypeCellular
    InterfaceTypeEthernet
    InterfaceTypeOther
)
```

### علامة التوجيه

على Linux، تُستخدم علامة التوجيه (`SO_MARK`) لاختيار جداول التوجيه. هذا ضروري لعمل TUN — تُعلَّم الحزم الصادرة لتتجاوز قاعدة توجيه TUN.
