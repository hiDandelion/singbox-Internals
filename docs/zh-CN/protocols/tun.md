# TUN Inbound

TUN（网络隧道）是 sing-box 中主要的透明代理机制。它创建一个虚拟网络接口来捕获所有系统流量。sing-box 使用 `sing-tun` 库，该库支持多种网络栈实现、自动路由和通过 nftables 的自动重定向。

**源码**: `protocol/tun/inbound.go`, `sing-tun`

## 架构

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

## MTU 选择

MTU 根据平台自动选择：

```go
if tunMTU == 0 {
    if platformInterface != nil && platformInterface.UnderNetworkExtension() {
        // iOS/macOS Network Extension：4064 (4096 - UTUN_IF_HEADROOM_SIZE)
        tunMTU = 4064
    } else if C.IsAndroid {
        // Android：某些设备在 65535 时会报告 ENOBUFS
        tunMTU = 9000
    } else {
        tunMTU = 65535
    }
}
```

## GSO（通用分段卸载）

GSO 在 Linux 上满足条件时自动启用：

```go
enableGSO := C.IsLinux && options.Stack == "gvisor" && platformInterface == nil && tunMTU > 0 && tunMTU < 49152
```

## 网络栈选项

`stack` 选项决定捕获的数据包如何处理：

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

### 可用栈

| 栈 | 说明 |
|-------|-------------|
| `gvisor` | Google 的用户态 TCP/IP 栈。兼容性最好，CPU 使用最高。 |
| `system` | 使用操作系统内核栈。CPU 使用较低，需要更多操作系统级别的设置。 |
| `mixed` | TCP 使用 gVisor，UDP 使用 system。平衡方案。 |

## 地址配置

IPv4 和 IPv6 地址从统一的 `Address` 列表中分离：

```go
address := options.Address
inet4Address := common.Filter(address, func(it netip.Prefix) bool {
    return it.Addr().Is4()
})
inet6Address := common.Filter(address, func(it netip.Prefix) bool {
    return it.Addr().Is6()
})
```

相同的模式适用于路由地址和路由排除地址。

## TUN 选项

完整的 TUN 选项结构包括：

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
    // ... 路由表索引、标记等
}
```

### UID 过滤

UID 范围可以指定为单个 UID 或范围：

```go
includeUID := uidToRange(options.IncludeUID)
if len(options.IncludeUIDRange) > 0 {
    includeUID, _ = parseRange(includeUID, options.IncludeUIDRange)
}
```

范围解析支持 `start:end` 格式：

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

### MAC 地址过滤

MAC 地址被解析用于局域网级别的过滤：

```go
for i, macString := range options.IncludeMACAddress {
    mac, _ := net.ParseMAC(macString)
    includeMACAddress = append(includeMACAddress, mac)
}
```

## 自动路由

当启用 `auto_route` 时，sing-box 自动配置路由表以将流量导向 TUN 接口。配置包括：

```go
IPRoute2TableIndex:    tableIndex,    // 默认: tun.DefaultIPRoute2TableIndex
IPRoute2RuleIndex:     ruleIndex,     // 默认: tun.DefaultIPRoute2RuleIndex
```

## 自动重定向

自动重定向使用 nftables 重定向流量，无需修改路由表。它需要 `auto_route`：

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

`DISABLE_NFTABLES` 环境变量可以强制使用 iptables 模式：

```go
disableNFTables, dErr := strconv.ParseBool(os.Getenv("DISABLE_NFTABLES"))
```

### 自动重定向标记

流量标记用于防止路由环路：

```go
AutoRedirectInputMark:  inputMark,   // 默认: tun.DefaultAutoRedirectInputMark
AutoRedirectOutputMark: outputMark,  // 默认: tun.DefaultAutoRedirectOutputMark
AutoRedirectResetMark:  resetMark,   // 默认: tun.DefaultAutoRedirectResetMark
AutoRedirectNFQueue:    nfQueue,     // 默认: tun.DefaultAutoRedirectNFQueue
```

## 路由地址集

TUN 支持来自规则集的动态路由地址集：

```go
for _, routeAddressSet := range options.RouteAddressSet {
    ruleSet, loaded := router.RuleSet(routeAddressSet)
    if !loaded {
        return nil, E.New("rule-set not found: ", routeAddressSet)
    }
    inbound.routeRuleSet = append(inbound.routeRuleSet, ruleSet)
}
```

当规则集更新时，路由地址会刷新：

```go
func (t *Inbound) updateRouteAddressSet(it adapter.RuleSet) {
    t.routeAddressSet = common.FlatMap(t.routeRuleSet, adapter.RuleSet.ExtractIPSet)
    t.routeExcludeAddressSet = common.FlatMap(t.routeExcludeRuleSet, adapter.RuleSet.ExtractIPSet)
    t.autoRedirect.UpdateRouteAddressSet()
}
```

## 两阶段启动

TUN 使用两阶段启动：

### 阶段 1：`StartStateStart`

1. 如适用则构建 Android 规则
2. 计算接口名称
3. 从规则集中提取路由地址
4. 打开 TUN 接口（平台相关或 `tun.New()`）
5. 创建网络栈

### 阶段 2：`StartStatePostStart`

1. 启动网络栈
2. 启动 TUN 接口
3. 初始化自动重定向（如启用）

```go
func (t *Inbound) Start(stage adapter.StartStage) error {
    switch stage {
    case adapter.StartStateStart:
        // 打开 TUN，创建栈
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

## 连接处理

### PrepareConnection

在建立连接之前，TUN 检查路由规则：

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
    // 处理 bypass、reject、ICMP 情况
}
```

### TCP/UDP 连接

通过路由器进行标准路由：

```go
func (t *Inbound) NewConnectionEx(ctx, conn, source, destination, onClose) {
    metadata.Inbound = t.tag
    metadata.InboundType = C.TypeTun
    metadata.Source = source
    metadata.Destination = destination
    t.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### 自动重定向处理器

一个独立的处理器类型处理自动重定向的连接：

```go
type autoRedirectHandler Inbound

func (t *autoRedirectHandler) NewConnectionEx(ctx, conn, source, destination, onClose) {
    // 相同模式，但日志记录为 "redirect connection"
    t.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## 平台集成

在移动平台（iOS/Android）上，TUN 使用平台 interface：

```go
if t.platformInterface != nil && t.platformInterface.UsePlatformInterface() {
    tunInterface, _ = t.platformInterface.OpenInterface(&tunOptions, t.platformOptions)
}
```

平台特定选项包括：
- `ForwarderBindInterface`：绑定转发器到特定接口（移动端）
- `IncludeAllNetworks`：iOS 的 Network Extension 选项
- `MultiPendingPackets`：小 MTU 下 Darwin 的变通方案

## 配置示例

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
