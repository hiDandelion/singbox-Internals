# Router & Rules

The router is the central decision engine. It matches connections against rules and executes actions. Unlike Xray-core where rules simply select an outbound tag, sing-box rules produce **actions** that can sniff, resolve DNS, route, reject, or hijack DNS.

**Source**: `route/router.go`, `route/route.go`, `route/rule/`

## Router Structure

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

## Connection Routing Flow

### `RouteConnectionEx` (TCP)

```go
func (r *Router) RouteConnectionEx(ctx, conn, metadata, onClose) {
    err := r.routeConnection(ctx, conn, metadata, onClose)
    if err != nil {
        N.CloseOnHandshakeFailure(conn, onClose, err)
    }
}
```

### `routeConnection` (internal)

1. **Detour check**: If `metadata.InboundDetour` is set, inject into that inbound
2. **Mux/UoT check**: Reject deprecated global mux/UoT addresses
3. **Rule matching**: Call `matchRule()` to find matching rule
4. **Action dispatch**:
   - `RuleActionRoute` → look up outbound, verify TCP support
   - `RuleActionBypass` → direct or outbound bypass
   - `RuleActionReject` → return error
   - `RuleActionHijackDNS` → handle as DNS stream
5. **Default outbound**: If no rule matches, use default outbound
6. **Connection tracking**: Wrap with trackers (Clash API stats)
7. **Handoff**: Call `outbound.NewConnectionEx()` or `connectionManager.NewConnection()`

## Rule Matching (`matchRule`)

The core matching loop:

```go
func (r *Router) matchRule(ctx, metadata, preMatch, supportBypass, inputConn, inputPacketConn) (
    selectedRule, selectedRuleIndex, buffers, packetBuffers, fatalErr,
) {
    // Step 1: Process discovery
    if r.processSearcher != nil && metadata.ProcessInfo == nil {
        processInfo, _ := process.FindProcessInfo(r.processSearcher, ...)
        metadata.ProcessInfo = processInfo
    }

    // Step 2: Neighbor resolution (MAC address, hostname)
    if r.neighborResolver != nil && metadata.SourceMACAddress == nil {
        mac, _ := r.neighborResolver.LookupMAC(metadata.Source.Addr)
        hostname, _ := r.neighborResolver.LookupHostname(metadata.Source.Addr)
    }

    // Step 3: FakeIP lookup
    if metadata.Destination.Addr.IsValid() && r.dnsTransport.FakeIP() != nil {
        domain, loaded := r.dnsTransport.FakeIP().Store().Lookup(metadata.Destination.Addr)
        if loaded {
            metadata.OriginDestination = metadata.Destination
            metadata.Destination = M.Socksaddr{Fqdn: domain, Port: metadata.Destination.Port}
            metadata.FakeIP = true
        }
    }

    // Step 4: Reverse DNS lookup
    if metadata.Domain == "" {
        domain, loaded := r.dns.LookupReverseMapping(metadata.Destination.Addr)
        if loaded { metadata.Domain = domain }
    }

    // Step 5: Rule iteration
    for currentRuleIndex, currentRule := range r.rules {
        metadata.ResetRuleCache()
        if !currentRule.Match(metadata) {
            continue
        }

        // Apply route options from rule
        // ...

        // Execute action
        switch action := currentRule.Action().(type) {
        case *R.RuleActionSniff:
            // Peek at data, set metadata.Protocol/Domain
        case *R.RuleActionResolve:
            // DNS resolve, set metadata.DestinationAddresses
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

## Rule Actions

### Route (terminal)

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

### Sniff (non-terminal)

```go
type RuleActionSniff struct {
    StreamSniffers []sniff.StreamSniffer
    PacketSniffers []sniff.PacketSniffer
    SnifferNames   []string
    Timeout        time.Duration
    OverrideDestination bool
}
```

Sniffing peeks at the connection data to detect protocol and domain. For TCP, it uses `sniff.PeekStream()`. For UDP, it uses `sniff.PeekPacket()`.

### Resolve (non-terminal)

```go
type RuleActionResolve struct {
    Server       string
    Strategy     C.DomainStrategy
    DisableCache bool
    RewriteTTL   *uint32
    ClientSubnet netip.Prefix
}
```

DNS-resolves the destination domain and stores IPs in `metadata.DestinationAddresses`.

### Reject (terminal)

```go
type RuleActionReject struct {
    Method string  // "default", "drop", "reply"
}
```

### HijackDNS (terminal)

Intercepts the connection and handles it as a DNS query, forwarding to the DNS router.

### Bypass (terminal)

```go
type RuleActionBypass struct {
    Outbound string
    RuleActionRouteOptions
}
```

## Rule Interface

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

### Rule Types

- **DefaultRule**: Standard rule with conditions + action
- **LogicalRule**: AND/OR composition of sub-rules

### Condition Items

Each condition checks one aspect of the metadata:

| Condition | Field | Matching |
|-----------|-------|----------|
| `domain` | Destination domain | Full, suffix, keyword, regex |
| `ip_cidr` | Destination IP | CIDR range |
| `source_ip_cidr` | Source IP | CIDR range |
| `port` | Destination port | Exact or range |
| `source_port` | Source port | Exact or range |
| `protocol` | Sniffed protocol | Exact match |
| `network` | TCP/UDP | Exact match |
| `inbound` | Inbound tag | Exact match |
| `outbound` | Current outbound | Exact match |
| `package_name` | Android package | Exact match |
| `process_name` | Process name | Exact match |
| `process_path` | Process path | Exact or regex |
| `user` / `user_id` | OS user | Exact match |
| `clash_mode` | Clash API mode | Exact match |
| `wifi_ssid` / `wifi_bssid` | WIFI state | Exact match |
| `network_type` | Interface type | wifi/cellular/ethernet/other |
| `network_is_expensive` | Metered network | Boolean |
| `network_is_constrained` | Constrained network | Boolean |
| `ip_is_private` | Private IP | Boolean |
| `ip_accept_any` | IP resolved | Boolean |
| `source_mac_address` | Source MAC | Exact match |
| `source_hostname` | Source hostname | Domain match |
| `query_type` | DNS query type | A/AAAA/etc. |
| `rule_set` | Rule set match | Delegated |
| `auth_user` | Proxy auth user | Exact match |
| `client` | TLS client (JA3) | Exact match |

## Rule Sets

Rule sets are collections of rules loaded from local files or remote URLs:

```go
type RuleSet interface {
    Name() string
    StartContext(ctx, startContext) error
    PostStart() error
    Metadata() RuleSetMetadata
    ExtractIPSet() []*netipx.IPSet
    IncRef() / DecRef()  // reference counting
    HeadlessRule         // can be used as a condition
}
```

### Local Rule Sets

Loaded from `.srs` binary files (sing-box Rule Set format).

### Remote Rule Sets

Downloaded from URLs, cached, and auto-updated. Multiple rule sets download concurrently (max 5 parallel).

## DNS Routing

DNS queries are routed separately via `dns.Router`:

```go
type DNSRule interface {
    Rule
    WithAddressLimit() bool
    MatchAddressLimit(metadata *InboundContext) bool
}
```

DNS rules have the additional ability to match on response addresses (for filtering unwanted DNS responses).
