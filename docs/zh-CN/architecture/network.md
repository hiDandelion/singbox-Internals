# 网络管理器

NetworkManager 处理平台特定的网络功能：接口发现、路由监控、套接字保护和 WIFI 状态跟踪。

**源码**: `route/network.go`, `adapter/network.go`

## 接口

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

## 关键功能

### 自动检测接口

启用后，sing-box 自动将出站连接绑定到默认网络接口。这防止了 TUN 激活时的路由循环 -- 否则出站流量会重新进入 TUN 设备。

```go
func (m *NetworkManager) AutoDetectInterfaceFunc() control.Func
```

返回一个套接字控制函数，使用 `SO_BINDTODEVICE`（Linux）或等效方法将套接字绑定到当前默认接口。

### Protect 函数（Android）

在 Android 上，套接字必须被"保护"以绕过 VPN：

```go
func (m *NetworkManager) ProtectFunc() control.Func
```

这会调用 Android 平台接口，使用 `VpnService.protect()` 标记套接字。

### 接口监控

`InterfaceMonitor` 监视网络变化：

```go
type DefaultInterfaceMonitor interface {
    Start() error
    Close() error
    DefaultInterface() *Interface
    RegisterCallback(callback func()) *list.Element[func()]
    UnregisterCallback(element *list.Element[func()])
}
```

当默认接口发生变化（例如 WiFi -> 蜂窝网络）时，所有 DNS 缓存会被清除，连接可能会被重置。

### 网络策略

对于多接口设备，网络策略控制使用哪些接口：

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

策略：
- **Default**: 使用系统默认接口
- **Prefer cellular**: 优先使用蜂窝网络，回退到 WiFi
- **Prefer WiFi**: 优先使用 WiFi，回退到蜂窝网络
- **Hybrid**: 同时使用两者（多路径）

### WIFI 状态

用于匹配 WIFI SSID/BSSID 的规则：

```go
type WIFIState struct {
    SSID  string
    BSSID string
}
```

通过平台特定的 API 获取（Linux 上的 NetworkManager、macOS 上的 CoreWLAN、Android 上的 WifiManager）。

### 网络接口类型

```go
type InterfaceType uint8

const (
    InterfaceTypeWIFI     InterfaceType = iota
    InterfaceTypeCellular
    InterfaceTypeEthernet
    InterfaceTypeOther
)
```

### 路由标记

在 Linux 上，路由标记（`SO_MARK`）用于选择路由表。这对于 TUN 操作至关重要 -- 出站数据包被标记以绕过 TUN 路由规则。
