# 平台 Interface

平台 interface 为移动平台（Android/iOS）提供抽象层，通过 gomobile 绑定将 sing-box 集成到原生应用中。它处理 TUN 设备管理、网络监控、进程识别和系统级操作。

**源码**：`experimental/libbox/`、`adapter/platform.go`

## 双层架构

存在两个 `PlatformInterface` 类型：

1. **`adapter.PlatformInterface`**（内部）-- sing-box 核心内部使用的 interface
2. **`libbox.PlatformInterface`**（外部）-- 由宿主应用实现的 gomobile 兼容 interface

libbox 中的 `platformInterfaceWrapper` 在两者之间进行桥接：

```go
var _ adapter.PlatformInterface = (*platformInterfaceWrapper)(nil)

type platformInterfaceWrapper struct {
    iif                    PlatformInterface  // 来自宿主应用的 gomobile interface
    useProcFS              bool
    networkManager         adapter.NetworkManager
    myTunName              string
    defaultInterfaceAccess sync.Mutex
    defaultInterface       *control.Interface
    isExpensive            bool
    isConstrained          bool
}
```

## adapter.PlatformInterface（内部）

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

每个 `UsePlatform*()` 方法返回 true 表示平台提供该功能，使 sing-box 使用平台实现而非默认的 Go 实现。

## libbox.PlatformInterface（外部/gomobile）

```go
type PlatformInterface interface {
    LocalDNSTransport() LocalDNSTransport
    UsePlatformAutoDetectInterfaceControl() bool
    AutoDetectInterfaceControl(fd int32) error
    OpenTun(options TunOptions) (int32, error)          // 返回文件描述符
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

与内部 interface 的关键差异：
- 使用 `int32` 而非 `int`（gomobile 兼容性）
- 返回迭代器而非切片（gomobile 不支持 Go 切片）
- `OpenTun` 返回原始文件描述符而非 `tun.Tun` 对象
- `StringIterator` 为 gomobile 消费包装 `[]string`

## TUN 设备管理

### 打开 TUN

平台包装器在 libbox 和内部 TUN 类型之间进行转换：

```go
func (w *platformInterfaceWrapper) OpenInterface(options *tun.Options, platformOptions) (tun.Tun, error) {
    // 1. 构建自动路由范围
    routeRanges, _ := options.BuildAutoRouteRanges(true)

    // 2. 调用平台打开 TUN（返回 fd）
    tunFd, _ := w.iif.OpenTun(&tunOptions{options, routeRanges, platformOptions})

    // 3. 从 fd 获取隧道名称
    options.Name, _ = getTunnelName(tunFd)

    // 4. 向接口监视器注册
    options.InterfaceMonitor.RegisterMyInterface(options.Name)

    // 5. dup fd（平台可能关闭原始 fd）
    dupFd, _ := dup(int(tunFd))
    options.FileDescriptor = dupFd

    // 6. 从选项创建 tun.Tun
    return tun.New(*options)
}
```

`getTunnelName` 函数是平台特定的：
- **Darwin**：通过 `ioctl` 从 fd 读取接口名称
- **Linux**：从 `/proc/self/fd/<fd>` 符号链接读取并提取 tun 名称
- **其他**：返回占位符名称

## 默认接口监视器

平台默认接口监视器包装宿主应用的网络变化回调：

```go
type platformDefaultInterfaceMonitor struct {
    *platformInterfaceWrapper
    logger      logger.Logger
    callbacks   list.List[tun.DefaultInterfaceUpdateCallback]
    myInterface string
}
```

### 更新流程

当宿主应用检测到网络变化时：

```go
func (m *platformDefaultInterfaceMonitor) UpdateDefaultInterface(
    interfaceName string, interfaceIndex32 int32,
    isExpensive bool, isConstrained bool) {

    // 1. 更新 expense/constrained 标志
    // 2. 告知网络管理器刷新接口
    // 3. 按索引查找新接口
    // 4. 更新存储的默认接口
    // 5. 通知所有注册的回调（如果接口已变化）
}
```

如果 `interfaceIndex32 == -1`，设备没有网络连接（所有回调收到 `nil`）。

在 Android 上，更新可能通过 `sFixAndroidStack` 分派到新的 goroutine，以绕过 Go 运行时关于 Android 线程栈的 bug。

## 网络接口枚举

```go
func (w *platformInterfaceWrapper) NetworkInterfaces() ([]adapter.NetworkInterface, error) {
    interfaceIterator, _ := w.iif.GetInterfaces()
    var interfaces []adapter.NetworkInterface
    for _, netInterface := range iteratorToArray(interfaceIterator) {
        // 跳过我们自己的 TUN 接口
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
    // 按名称去重
    return common.UniqBy(interfaces, func(it) string { return it.Name }), nil
}
```

接口类型有：
```go
const (
    InterfaceTypeWIFI     = int32(C.InterfaceTypeWIFI)
    InterfaceTypeCellular = int32(C.InterfaceTypeCellular)
    InterfaceTypeEthernet = int32(C.InterfaceTypeEthernet)
    InterfaceTypeOther    = int32(C.InterfaceTypeOther)
)
```

## 进程连接所有者

平台包装器支持两种查找连接所有者的模式：

```go
func (w *platformInterfaceWrapper) FindConnectionOwner(request) (*ConnectionOwner, error) {
    if w.useProcFS {
        // 模式 1：直接 procfs 扫描（有 root/VPN 的 Android）
        uid := procfs.ResolveSocketByProcSearch(network, source, destination)
        return &ConnectionOwner{UserId: uid}, nil
    }
    // 模式 2：委派给平台（使用 Android 的 ConnectivityManager）
    result, _ := w.iif.FindConnectionOwner(...)
    return &ConnectionOwner{
        UserId:             result.UserId,
        ProcessPath:        result.ProcessPath,
        AndroidPackageName: result.AndroidPackageName,
    }, nil
}
```

## 设置与初始化

`Setup()` 函数为移动平台配置全局路径和选项：

```go
type SetupOptions struct {
    BasePath                string   // 应用数据目录
    WorkingPath             string   // 配置文件工作目录
    TempPath                string   // 临时文件
    FixAndroidStack         bool     // Go 运行时 bug 的解决方案
    CommandServerListenPort int32    // 本地命令服务器端口
    CommandServerSecret     string   // 认证密钥
    LogMaxLines             int      // 日志缓冲区大小
    Debug                   bool     // 启用调试功能
}
```

## 系统代理状态

```go
type SystemProxyStatus struct {
    Available bool
    Enabled   bool
}
```

此类型表示平台上系统代理配置是否可用以及是否当前已启用。

## iOS Network Extension

iOS Network Extension（NEPacketTunnelProvider）有两个重要标志：

- **`UnderNetworkExtension()`**：在 iOS Network Extension 进程内运行时返回 true，该进程有不同的内存和能力限制
- **`NetworkExtensionIncludeAllNetworks()`**：当 `includeAllNetworks` 授权激活时返回 true，该授权将所有设备流量（包括系统进程）路由通过隧道

## 通知

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

通知用于系统级警报（如规则集更新失败、证书过期警告）。

## 按需规则（iOS）

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

这些规则控制 iOS 上 VPN 隧道何时应该被激活，基于网络条件（SSID、接口类型、DNS 配置）。

## 重新实现注意事项

1. **gomobile 限制**：libbox interface 使用 `int32` 而非 `int`，迭代器而非切片，指针类型而非值类型。这些都是 gomobile 的限制
2. **文件描述符复制**：TUN fd 必须被 `dup()` 复制，因为平台可能在返回后关闭原始 fd
3. **接口过滤**：TUN 接口本身必须从网络接口列表中排除，以防止路由循环
4. **Android 栈修复**：`sFixAndroidStack` 标志将接口更新分派到新的 goroutine，以绕过与 Android 线程栈大小相关的 Go issue #68760
5. **双向通信**：平台 interface 是双向的 -- 宿主应用调用 sing-box（通过 `BoxService`），sing-box 回调宿主应用（通过 `PlatformInterface`）
6. **命令服务器**：一个单独的本地 TCP 服务器（此处未展示）处理宿主应用 UI 和后台运行的 sing-box 服务之间的 IPC
