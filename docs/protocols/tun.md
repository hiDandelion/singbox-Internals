# TUN Inbound

TUN (network TUNnel) is the primary transparent proxy mechanism in sing-box. It creates a virtual network interface that captures all system traffic. sing-box uses the `sing-tun` library which supports multiple network stack implementations, auto-routing, and auto-redirect via nftables.

**Source**: `protocol/tun/inbound.go`, `sing-tun`

## Architecture

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

## MTU Selection

MTU is auto-selected based on platform:

```go
if tunMTU == 0 {
    if platformInterface != nil && platformInterface.UnderNetworkExtension() {
        // iOS/macOS Network Extension: 4064 (4096 - UTUN_IF_HEADROOM_SIZE)
        tunMTU = 4064
    } else if C.IsAndroid {
        // Android: some devices report ENOBUFS with 65535
        tunMTU = 9000
    } else {
        tunMTU = 65535
    }
}
```

## GSO (Generic Segmentation Offload)

GSO is automatically enabled on Linux when conditions are met:

```go
enableGSO := C.IsLinux && options.Stack == "gvisor" && platformInterface == nil && tunMTU > 0 && tunMTU < 49152
```

## Network Stack Options

The `stack` option determines how captured packets are processed:

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

### Available Stacks

| Stack | Description |
|-------|-------------|
| `gvisor` | Google's userspace TCP/IP stack. Best compatibility, highest CPU. |
| `system` | Uses the OS kernel stack. Lower CPU, requires more OS-level setup. |
| `mixed` | gVisor for TCP, system for UDP. Balanced approach. |

## Address Configuration

IPv4 and IPv6 addresses are separated from the unified `Address` list:

```go
address := options.Address
inet4Address := common.Filter(address, func(it netip.Prefix) bool {
    return it.Addr().Is4()
})
inet6Address := common.Filter(address, func(it netip.Prefix) bool {
    return it.Addr().Is6()
})
```

The same pattern applies to route addresses and route exclude addresses.

## TUN Options

The full TUN options structure includes:

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
    // ... routing table indices, marks, etc.
}
```

### UID Filtering

UID ranges can be specified as individual UIDs or ranges:

```go
includeUID := uidToRange(options.IncludeUID)
if len(options.IncludeUIDRange) > 0 {
    includeUID, _ = parseRange(includeUID, options.IncludeUIDRange)
}
```

Range parsing supports the format `start:end`:

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

### MAC Address Filtering

MAC addresses are parsed for LAN-level filtering:

```go
for i, macString := range options.IncludeMACAddress {
    mac, _ := net.ParseMAC(macString)
    includeMACAddress = append(includeMACAddress, mac)
}
```

## Auto-Route

When `auto_route` is enabled, sing-box automatically configures routing tables to direct traffic through the TUN interface. Configuration includes:

```go
IPRoute2TableIndex:    tableIndex,    // default: tun.DefaultIPRoute2TableIndex
IPRoute2RuleIndex:     ruleIndex,     // default: tun.DefaultIPRoute2RuleIndex
```

## Auto-Redirect

Auto-redirect uses nftables to redirect traffic without modifying the routing table. It requires `auto_route`:

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

The `DISABLE_NFTABLES` environment variable can force iptables mode:

```go
disableNFTables, dErr := strconv.ParseBool(os.Getenv("DISABLE_NFTABLES"))
```

### Auto-Redirect Marks

Traffic marks are used to prevent routing loops:

```go
AutoRedirectInputMark:  inputMark,   // default: tun.DefaultAutoRedirectInputMark
AutoRedirectOutputMark: outputMark,  // default: tun.DefaultAutoRedirectOutputMark
AutoRedirectResetMark:  resetMark,   // default: tun.DefaultAutoRedirectResetMark
AutoRedirectNFQueue:    nfQueue,     // default: tun.DefaultAutoRedirectNFQueue
```

## Route Address Sets

TUN supports dynamic route address sets from rule-sets:

```go
for _, routeAddressSet := range options.RouteAddressSet {
    ruleSet, loaded := router.RuleSet(routeAddressSet)
    if !loaded {
        return nil, E.New("rule-set not found: ", routeAddressSet)
    }
    inbound.routeRuleSet = append(inbound.routeRuleSet, ruleSet)
}
```

When rule-sets update, route addresses are refreshed:

```go
func (t *Inbound) updateRouteAddressSet(it adapter.RuleSet) {
    t.routeAddressSet = common.FlatMap(t.routeRuleSet, adapter.RuleSet.ExtractIPSet)
    t.routeExcludeAddressSet = common.FlatMap(t.routeExcludeRuleSet, adapter.RuleSet.ExtractIPSet)
    t.autoRedirect.UpdateRouteAddressSet()
}
```

## Two-Phase Start

TUN uses a two-phase start:

### Phase 1: `StartStateStart`

1. Build Android rules if applicable
2. Calculate interface name
3. Extract route addresses from rule-sets
4. Open the TUN interface (platform-dependent or `tun.New()`)
5. Create the network stack

### Phase 2: `StartStatePostStart`

1. Start the network stack
2. Start the TUN interface
3. Initialize auto-redirect (if enabled)

```go
func (t *Inbound) Start(stage adapter.StartStage) error {
    switch stage {
    case adapter.StartStateStart:
        // Open TUN, create stack
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

## Connection Handling

### PrepareConnection

Before establishing connections, the TUN checks routing rules:

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
    // Handle bypass, reject, ICMP cases
}
```

### TCP/UDP Connections

Standard routing through the router:

```go
func (t *Inbound) NewConnectionEx(ctx, conn, source, destination, onClose) {
    metadata.Inbound = t.tag
    metadata.InboundType = C.TypeTun
    metadata.Source = source
    metadata.Destination = destination
    t.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### Auto-Redirect Handler

A separate handler type processes auto-redirected connections:

```go
type autoRedirectHandler Inbound

func (t *autoRedirectHandler) NewConnectionEx(ctx, conn, source, destination, onClose) {
    // Same pattern, but logged as "redirect connection"
    t.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## Platform Integration

On mobile platforms (iOS/Android), TUN uses the platform interface:

```go
if t.platformInterface != nil && t.platformInterface.UsePlatformInterface() {
    tunInterface, _ = t.platformInterface.OpenInterface(&tunOptions, t.platformOptions)
}
```

Platform-specific options include:
- `ForwarderBindInterface`: Bind forwarder to specific interface (mobile)
- `IncludeAllNetworks`: Network Extension option for iOS
- `MultiPendingPackets`: Workaround for Darwin with small MTU

## Configuration Example

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
