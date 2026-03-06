# Network Manager

The NetworkManager handles platform-specific networking: interface discovery, route monitoring, socket protection, and WIFI state tracking.

**Source**: `route/network.go`, `adapter/network.go`

## Interface

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

## Key Features

### Auto-Detect Interface

When enabled, sing-box automatically binds outbound connections to the default network interface. This prevents routing loops when TUN is active — without it, outbound traffic would re-enter the TUN device.

```go
func (m *NetworkManager) AutoDetectInterfaceFunc() control.Func
```

Returns a socket control function that binds sockets to the current default interface using `SO_BINDTODEVICE` (Linux) or equivalent.

### Protect Function (Android)

On Android, sockets must be "protected" to bypass the VPN:

```go
func (m *NetworkManager) ProtectFunc() control.Func
```

This calls into the Android platform interface to mark sockets with `VpnService.protect()`.

### Interface Monitoring

The `InterfaceMonitor` watches for network changes:

```go
type DefaultInterfaceMonitor interface {
    Start() error
    Close() error
    DefaultInterface() *Interface
    RegisterCallback(callback func()) *list.Element[func()]
    UnregisterCallback(element *list.Element[func()])
}
```

When the default interface changes (e.g., WiFi → cellular), all DNS caches are cleared and connections may be reset.

### Network Strategy

For multi-interface devices, the network strategy controls which interfaces to use:

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

Strategies:
- **Default**: Use the system default interface
- **Prefer cellular**: Try cellular first, fallback to WiFi
- **Prefer WiFi**: Try WiFi first, fallback to cellular
- **Hybrid**: Use both simultaneously (multi-path)

### WIFI State

For rules that match on WIFI SSID/BSSID:

```go
type WIFIState struct {
    SSID  string
    BSSID string
}
```

Obtained via platform-specific APIs (NetworkManager on Linux, CoreWLAN on macOS, WifiManager on Android).

### Network Interface Types

```go
type InterfaceType uint8

const (
    InterfaceTypeWIFI     InterfaceType = iota
    InterfaceTypeCellular
    InterfaceTypeEthernet
    InterfaceTypeOther
)
```

### Routing Mark

On Linux, the routing mark (`SO_MARK`) is used to select routing tables. This is essential for TUN operation — outbound packets are marked so they bypass the TUN routing rule.
