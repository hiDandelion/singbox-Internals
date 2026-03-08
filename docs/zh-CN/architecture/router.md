# 路由器与规则

路由器是核心决策引擎。它将连接与规则进行匹配并执行动作。与 Xray-core 中规则仅选择出站标签不同，sing-box 的规则产生**动作**，可以执行嗅探、DNS 解析、路由、拒绝或 DNS 劫持。

**源码**: `route/router.go`, `route/route.go`, `route/rule/`

## Router 结构体

```go
type Router struct {
    ctx               context.Context
    logger            log.ContextLogger
    inbound           adapter.InboundManager
    outbound          adapter.OutboundManager
    dns               adapter.DNSRouter
    dnsTransport      adapter.DNSTransportManager
    connection        adapter.ConnectionManager
    network           adapter.NetworkManager
    rules             []adapter.Rule
    ruleSets          []adapter.RuleSet
    ruleSetMap        map[string]adapter.RuleSet
    processSearcher   process.Searcher
    neighborResolver  adapter.NeighborResolver
    trackers          []adapter.ConnectionTracker
}
```

## 连接路由流程

### `RouteConnectionEx` (TCP)

```go
func (r *Router) RouteConnectionEx(ctx, conn, metadata, onClose) {
    err := r.routeConnection(ctx, conn, metadata, onClose)
    if err != nil {
        N.CloseOnHandshakeFailure(conn, onClose, err)
    }
}
```

### `routeConnection`（内部方法）

1. **Detour 检查**: 如果设置了 `metadata.InboundDetour`，则注入到该入站
2. **Mux/UoT 检查**: 拒绝已弃用的全局 mux/UoT 地址
3. **规则匹配**: 调用 `matchRule()` 查找匹配的规则
4. **动作分派**:
   - `RuleActionRoute` -> 查找出站，验证 TCP 支持
   - `RuleActionBypass` -> 直接或出站绕过
   - `RuleActionReject` -> 返回错误
   - `RuleActionHijackDNS` -> 作为 DNS 流处理
5. **默认出站**: 如果没有规则匹配，使用默认出站
6. **连接追踪**: 用追踪器包装（Clash API 统计）
7. **移交**: 调用 `outbound.NewConnectionEx()` 或 `connectionManager.NewConnection()`

## 规则匹配 (`matchRule`)

核心匹配循环：

```go
func (r *Router) matchRule(ctx, metadata, preMatch, supportBypass, inputConn, inputPacketConn) (
    selectedRule, selectedRuleIndex, buffers, packetBuffers, fatalErr,
) {
    // 步骤 1: 进程发现
    if r.processSearcher != nil && metadata.ProcessInfo == nil {
        processInfo, _ := process.FindProcessInfo(r.processSearcher, ...)
        metadata.ProcessInfo = processInfo
    }

    // 步骤 2: 邻居解析（MAC 地址、主机名）
    if r.neighborResolver != nil && metadata.SourceMACAddress == nil {
        mac, _ := r.neighborResolver.LookupMAC(metadata.Source.Addr)
        hostname, _ := r.neighborResolver.LookupHostname(metadata.Source.Addr)
    }

    // 步骤 3: FakeIP 查询
    if metadata.Destination.Addr.IsValid() && r.dnsTransport.FakeIP() != nil {
        domain, loaded := r.dnsTransport.FakeIP().Store().Lookup(metadata.Destination.Addr)
        if loaded {
            metadata.OriginDestination = metadata.Destination
            metadata.Destination = M.Socksaddr{Fqdn: domain, Port: metadata.Destination.Port}
            metadata.FakeIP = true
        }
    }

    // 步骤 4: 反向 DNS 查询
    if metadata.Domain == "" {
        domain, loaded := r.dns.LookupReverseMapping(metadata.Destination.Addr)
        if loaded { metadata.Domain = domain }
    }

    // 步骤 5: 规则遍历
    for currentRuleIndex, currentRule := range r.rules {
        metadata.ResetRuleCache()
        if !currentRule.Match(metadata) {
            continue
        }

        // 应用规则中的路由选项
        // ...

        // 执行动作
        switch action := currentRule.Action().(type) {
        case *R.RuleActionSniff:
            // 窥探数据，设置 metadata.Protocol/Domain
        case *R.RuleActionResolve:
            // DNS 解析，设置 metadata.DestinationAddresses
        case *R.RuleActionRoute:
            selectedRule = currentRule
            break match
        case *R.RuleActionReject:
            selectedRule = currentRule
            break match
        case *R.RuleActionHijackDNS:
            selectedRule = currentRule
            break match
        case *R.RuleActionBypass:
            selectedRule = currentRule
            break match
        }
    }
}
```

## 规则动作

### Route（终端动作）

```go
type RuleActionRoute struct {
    Outbound string
    RuleActionRouteOptions
}

type RuleActionRouteOptions struct {
    OverrideAddress         M.Socksaddr
    OverridePort            uint16
    NetworkStrategy         *C.NetworkStrategy
    NetworkType             []C.InterfaceType
    FallbackNetworkType     []C.InterfaceType
    FallbackDelay           time.Duration
    UDPDisableDomainUnmapping bool
    UDPConnect              bool
    UDPTimeout              time.Duration
    TLSFragment             bool
    TLSRecordFragment       bool
}
```

### Sniff（非终端动作）

```go
type RuleActionSniff struct {
    StreamSniffers []sniff.StreamSniffer
    PacketSniffers []sniff.PacketSniffer
    SnifferNames   []string
    Timeout        time.Duration
    OverrideDestination bool
}
```

嗅探会窥探连接数据以检测协议和域名。对于 TCP，使用 `sniff.PeekStream()`。对于 UDP，使用 `sniff.PeekPacket()`。

### Resolve（非终端动作）

```go
type RuleActionResolve struct {
    Server       string
    Strategy     C.DomainStrategy
    DisableCache bool
    RewriteTTL   *uint32
    ClientSubnet netip.Prefix
}
```

对目标域名进行 DNS 解析，并将 IP 存储在 `metadata.DestinationAddresses` 中。

### Reject（终端动作）

```go
type RuleActionReject struct {
    Method string  // "default", "drop", "reply"
}
```

### HijackDNS（终端动作）

拦截连接并将其作为 DNS 查询处理，转发到 DNS 路由器。

### Bypass（终端动作）

```go
type RuleActionBypass struct {
    Outbound string
    RuleActionRouteOptions
}
```

## Rule 接口

```go
type Rule interface {
    HeadlessRule
    SimpleLifecycle
    Type() string
    Action() RuleAction
}

type HeadlessRule interface {
    Match(metadata *InboundContext) bool
    String() string
}
```

### 规则类型

- **DefaultRule**: 带有条件 + 动作的标准规则
- **LogicalRule**: 子规则的 AND/OR 组合

### 条件项

每个条件检查元数据的一个方面：

| 条件 | 字段 | 匹配方式 |
|-----------|-------|----------|
| `domain` | 目标域名 | 完整匹配、后缀、关键词、正则 |
| `ip_cidr` | 目标 IP | CIDR 范围 |
| `source_ip_cidr` | 源 IP | CIDR 范围 |
| `port` | 目标端口 | 精确匹配或范围 |
| `source_port` | 源端口 | 精确匹配或范围 |
| `protocol` | 嗅探到的协议 | 精确匹配 |
| `network` | TCP/UDP | 精确匹配 |
| `inbound` | 入站标签 | 精确匹配 |
| `outbound` | 当前出站 | 精确匹配 |
| `package_name` | Android 包名 | 精确匹配 |
| `process_name` | 进程名称 | 精确匹配 |
| `process_path` | 进程路径 | 精确匹配或正则 |
| `user` / `user_id` | 操作系统用户 | 精确匹配 |
| `clash_mode` | Clash API 模式 | 精确匹配 |
| `wifi_ssid` / `wifi_bssid` | WIFI 状态 | 精确匹配 |
| `network_type` | 接口类型 | wifi/cellular/ethernet/other |
| `network_is_expensive` | 计费网络 | 布尔值 |
| `network_is_constrained` | 受限网络 | 布尔值 |
| `ip_is_private` | 私有 IP | 布尔值 |
| `ip_accept_any` | IP 已解析 | 布尔值 |
| `source_mac_address` | 源 MAC 地址 | 精确匹配 |
| `source_hostname` | 源主机名 | 域名匹配 |
| `query_type` | DNS 查询类型 | A/AAAA 等 |
| `rule_set` | 规则集匹配 | 委托匹配 |
| `auth_user` | 代理认证用户 | 精确匹配 |
| `client` | TLS 客户端 (JA3) | 精确匹配 |

## 规则集

规则集是从本地文件或远程 URL 加载的规则集合：

```go
type RuleSet interface {
    Name() string
    StartContext(ctx, startContext) error
    PostStart() error
    Metadata() RuleSetMetadata
    ExtractIPSet() []*netipx.IPSet
    IncRef() / DecRef()  // 引用计数
    HeadlessRule         // 可用作条件
}
```

### 本地规则集

从 `.srs` 二进制文件（sing-box 规则集格式）加载。

### 远程规则集

从 URL 下载，缓存并自动更新。多个规则集并发下载（最多 5 个并行）。

## DNS 路由

DNS 查询通过 `dns.Router` 单独路由：

```go
type DNSRule interface {
    Rule
    WithAddressLimit() bool
    MatchAddressLimit(metadata *InboundContext) bool
}
```

DNS 规则具有额外的能力，可以匹配响应地址（用于过滤不需要的 DNS 响应）。
