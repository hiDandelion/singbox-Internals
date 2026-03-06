# Platform Interface

The platform interface provides an abstraction layer for mobile platforms (Android/iOS) to integrate sing-box into native apps via gomobile bindings. It handles TUN device management, network monitoring, process identification, and system-level operations.

**Source**: `experimental/libbox/`, `adapter/platform.go`

## Two-Layer Architecture

There are two `PlatformInterface` types:

1. **`adapter.PlatformInterface`** (internal) -- the interface used within sing-box's core
2. **`libbox.PlatformInterface`** (external) -- the gomobile-compatible interface implemented by the host app

The `platformInterfaceWrapper` in libbox bridges between them:

```go
var _ adapter.PlatformInterface = (*platformInterfaceWrapper)(nil)

type platformInterfaceWrapper struct {
    iif                    PlatformInterface  // gomobile interface from host app
    useProcFS              bool
    networkManager         adapter.NetworkManager
    myTunName              string
    defaultInterfaceAccess sync.Mutex
    defaultInterface       *control.Interface
    isExpensive            bool
    isConstrained          bool
}
```

## adapter.PlatformInterface (Internal)

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

Each `UsePlatform*()` method returns true to indicate the platform provides that capability, causing sing-box to use the platform implementation instead of the default Go implementation.

## libbox.PlatformInterface (External/gomobile)

```go
type PlatformInterface interface {
    LocalDNSTransport() LocalDNSTransport
    UsePlatformAutoDetectInterfaceControl() bool
    AutoDetectInterfaceControl(fd int32) error
    OpenTun(options TunOptions) (int32, error)          // returns file descriptor
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

Key differences from the internal interface:
- Uses `int32` instead of `int` (gomobile compatibility)
- Returns iterators instead of slices (gomobile does not support Go slices)
- `OpenTun` returns a raw file descriptor instead of a `tun.Tun` object
- `StringIterator` wraps `[]string` for gomobile consumption

## TUN Device Management

### Opening the TUN

The platform wrapper converts between libbox and internal TUN types:

```go
func (w *platformInterfaceWrapper) OpenInterface(options *tun.Options, platformOptions) (tun.Tun, error) {
    // 1. Build auto-route ranges
    routeRanges, _ := options.BuildAutoRouteRanges(true)

    // 2. Call platform to open TUN (returns fd)
    tunFd, _ := w.iif.OpenTun(&tunOptions{options, routeRanges, platformOptions})

    // 3. Get tunnel name from fd
    options.Name, _ = getTunnelName(tunFd)

    // 4. Register with interface monitor
    options.InterfaceMonitor.RegisterMyInterface(options.Name)

    // 5. Dup the fd (platform may close original)
    dupFd, _ := dup(int(tunFd))
    options.FileDescriptor = dupFd

    // 6. Create tun.Tun from options
    return tun.New(*options)
}
```

The `getTunnelName` function is platform-specific:
- **Darwin**: reads the interface name from the fd via `ioctl`
- **Linux**: reads from `/proc/self/fd/<fd>` symlink and extracts the tun name
- **Other**: returns a placeholder name

## Default Interface Monitor

The platform default interface monitor wraps the host app's network change callbacks:

```go
type platformDefaultInterfaceMonitor struct {
    *platformInterfaceWrapper
    logger      logger.Logger
    callbacks   list.List[tun.DefaultInterfaceUpdateCallback]
    myInterface string
}
```

### Update Flow

When the host app detects a network change:

```go
func (m *platformDefaultInterfaceMonitor) UpdateDefaultInterface(
    interfaceName string, interfaceIndex32 int32,
    isExpensive bool, isConstrained bool) {

    // 1. Update expense/constrained flags
    // 2. Tell network manager to refresh interfaces
    // 3. Look up the new interface by index
    // 4. Update stored default interface
    // 5. Notify all registered callbacks (if interface changed)
}
```

If `interfaceIndex32 == -1`, the device has no network connectivity (all callbacks receive `nil`).

On Android, the update may be dispatched to a new goroutine via `sFixAndroidStack` to work around a Go runtime bug with Android thread stacks.

## Network Interface Enumeration

```go
func (w *platformInterfaceWrapper) NetworkInterfaces() ([]adapter.NetworkInterface, error) {
    interfaceIterator, _ := w.iif.GetInterfaces()
    var interfaces []adapter.NetworkInterface
    for _, netInterface := range iteratorToArray(interfaceIterator) {
        // Skip our own TUN interface
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
    // Deduplicate by name
    return common.UniqBy(interfaces, func(it) string { return it.Name }), nil
}
```

Interface types are:
```go
const (
    InterfaceTypeWIFI     = int32(C.InterfaceTypeWIFI)
    InterfaceTypeCellular = int32(C.InterfaceTypeCellular)
    InterfaceTypeEthernet = int32(C.InterfaceTypeEthernet)
    InterfaceTypeOther    = int32(C.InterfaceTypeOther)
)
```

## Process Connection Owner

The platform wrapper supports two modes for finding connection owners:

```go
func (w *platformInterfaceWrapper) FindConnectionOwner(request) (*ConnectionOwner, error) {
    if w.useProcFS {
        // Mode 1: Direct procfs scanning (Android with root/VPN)
        uid := procfs.ResolveSocketByProcSearch(network, source, destination)
        return &ConnectionOwner{UserId: uid}, nil
    }
    // Mode 2: Delegate to platform (uses Android's ConnectivityManager)
    result, _ := w.iif.FindConnectionOwner(...)
    return &ConnectionOwner{
        UserId:             result.UserId,
        ProcessPath:        result.ProcessPath,
        AndroidPackageName: result.AndroidPackageName,
    }, nil
}
```

## Setup and Initialization

The `Setup()` function configures global paths and options for mobile platforms:

```go
type SetupOptions struct {
    BasePath                string   // app data directory
    WorkingPath             string   // working directory for config files
    TempPath                string   // temporary files
    FixAndroidStack         bool     // workaround for Go runtime bug
    CommandServerListenPort int32    // local command server port
    CommandServerSecret     string   // authentication secret
    LogMaxLines             int      // log buffer size
    Debug                   bool     // enable debug features
}
```

## System Proxy Status

```go
type SystemProxyStatus struct {
    Available bool
    Enabled   bool
}
```

This type represents whether system proxy configuration is available on the platform and whether it is currently enabled.

## iOS Network Extension

Two important flags for iOS Network Extension (NEPacketTunnelProvider):

- **`UnderNetworkExtension()`**: Returns true when running inside an iOS Network Extension process, which has different memory and capability constraints
- **`NetworkExtensionIncludeAllNetworks()`**: Returns true when the `includeAllNetworks` entitlement is active, which routes all device traffic (including system processes) through the tunnel

## Notifications

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

Notifications are used for system-level alerts (e.g., rule set update failures, certificate expiration warnings).

## On-Demand Rules (iOS)

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

These rules control when the VPN tunnel should be activated on iOS, based on network conditions (SSID, interface type, DNS configuration).

## Reimplementation Notes

1. **gomobile constraints**: The libbox interface uses `int32` instead of `int`, iterators instead of slices, and pointer types instead of value types. These are all gomobile limitations
2. **File descriptor duplication**: The TUN fd must be `dup()`-ed because the platform may close the original fd after returning it
3. **Interface filtering**: The TUN interface itself must be excluded from the list of network interfaces to prevent routing loops
4. **Android stack fix**: The `sFixAndroidStack` flag dispatches interface updates to new goroutines to work around Go issue #68760 related to Android thread stack sizes
5. **Bidirectional communication**: The platform interface is bidirectional -- the host app calls sing-box (via `BoxService`) and sing-box calls back to the host app (via `PlatformInterface`)
6. **Command server**: A separate local TCP server (not shown here) handles IPC between the host app UI and the sing-box service running in the background
