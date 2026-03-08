# DNS Client 与 Router

源码：`dns/client.go`、`dns/router.go`、`dns/rcode.go`、`dns/client_truncate.go`、`dns/client_log.go`、`dns/extension_edns0_subnet.go`

## DNS Client

### 结构

```go
type Client struct {
    timeout            time.Duration
    disableCache       bool
    disableExpire      bool
    independentCache   bool
    clientSubnet       netip.Prefix
    rdrc               adapter.RDRCStore
    initRDRCFunc       func() adapter.RDRCStore
    logger             logger.ContextLogger
    cache              freelru.Cache[dns.Question, *dns.Msg]
    cacheLock          compatible.Map[dns.Question, chan struct{}]
    transportCache     freelru.Cache[transportCacheKey, *dns.Msg]
    transportCacheLock compatible.Map[dns.Question, chan struct{}]
}
```

两种缓存模式：
- **共享缓存**（`cache`）：以 `dns.Question`（Name + Qtype + Qclass）为键
- **独立缓存**（`transportCache`）：以 `transportCacheKey`（Question + 传输层标签）为键，因此每个传输层拥有各自的缓存命名空间

缓存使用 `github.com/sagernet/sing/contrab/freelru`（一个分片 LRU 缓存）。默认容量为 1024 个条目。

### Exchange

核心 `Exchange` 方法处理完整的查询生命周期：

```go
func (c *Client) Exchange(ctx context.Context, transport adapter.DNSTransport,
    message *dns.Msg, options adapter.DNSQueryOptions,
    responseChecker func(responseAddrs []netip.Addr) bool) (*dns.Msg, error)
```

#### 步骤 1：策略过滤

对于策略不匹配的查询，立即返回空的成功响应：

```go
if question.Qtype == dns.TypeA && options.Strategy == C.DomainStrategyIPv6Only ||
   question.Qtype == dns.TypeAAAA && options.Strategy == C.DomainStrategyIPv4Only {
    return FixedResponseStatus(message, dns.RcodeSuccess), nil
}
```

#### 步骤 2：客户端子网

```go
clientSubnet := options.ClientSubnet
if !clientSubnet.IsValid() {
    clientSubnet = c.clientSubnet
}
if clientSubnet.IsValid() {
    message = SetClientSubnet(message, clientSubnet)
}
```

#### 步骤 3：缓存检查

只有"简单请求"才可缓存（单个问题、无额外记录（OPT 除外）、选项中无客户端子网）：

```go
isSimpleRequest := len(message.Question) == 1 &&
    len(message.Ns) == 0 &&
    (len(message.Extra) == 0 || len(message.Extra) == 1 &&
        message.Extra[0].Header().Rrtype == dns.TypeOPT &&
        message.Extra[0].Header().Class > 0 &&
        message.Extra[0].Header().Ttl == 0 &&
        len(message.Extra[0].(*dns.OPT).Option) == 0) &&
    !options.ClientSubnet.IsValid()
```

缓存去重防止并发的相同查询：

```go
cond, loaded := c.cacheLock.LoadOrStore(question, make(chan struct{}))
if loaded {
    select {
    case <-cond:     // 等待第一个查询完成
    case <-ctx.Done(): return nil, ctx.Err()
    }
}
```

#### 步骤 4：带 TTL 调整的缓存加载

```go
func (c *Client) loadResponse(question dns.Question, transport adapter.DNSTransport) (*dns.Msg, int) {
    response, expireAt, loaded = c.cache.GetWithLifetime(question)
    // 计算剩余 TTL
    nowTTL := int(expireAt.Sub(timeNow).Seconds())
    // 调整记录的 TTL：减去已过去的时间
    duration := uint32(originTTL - nowTTL)
    for _, record := range recordList {
        record.Header().Ttl = record.Header().Ttl - duration
    }
    return response, nowTTL
}
```

缓存的响应会被复制（`response.Copy()`）以防止被修改。TTL 会被调整以反映自缓存以来经过的时间。

#### 步骤 5：RDRC 检查

```go
if c.rdrc != nil {
    rejected := c.rdrc.LoadRDRC(transport.Tag(), question.Name, question.Qtype)
    if rejected {
        return nil, ErrResponseRejectedCached
    }
}
```

#### 步骤 6：传输层交换

```go
ctx, cancel := context.WithTimeout(ctx, c.timeout)
response, err := transport.Exchange(ctx, message)
cancel()
```

默认超时为 `C.DNSTimeout`。

#### 步骤 7：响应验证

如果提供了 `responseChecker`，则会验证响应中的地址：

```go
if responseChecker != nil {
    var rejected bool
    if response.Rcode != dns.RcodeSuccess && response.Rcode != dns.RcodeNameError {
        rejected = true
    } else if len(response.Answer) == 0 {
        rejected = !responseChecker(nil)
    } else {
        rejected = !responseChecker(MessageToAddresses(response))
    }
    if rejected {
        c.rdrc.SaveRDRCAsync(transport.Tag(), question.Name, question.Qtype, c.logger)
        return response, ErrResponseRejected
    }
}
```

#### 步骤 8：TTL 归一化

响应中所有记录的 TTL 被设置为找到的最小 TTL。如果设置了 `options.RewriteTTL`，则使用该值覆盖。

对于否定响应（NXDOMAIN 且无应答），使用 SOA 的最小 TTL：

```go
func extractNegativeTTL(response *dns.Msg) (uint32, bool) {
    for _, record := range response.Ns {
        if soa, isSOA := record.(*dns.SOA); isSOA {
            return min(soa.Header().Ttl, soa.Minttl), true
        }
    }
    return 0, false
}
```

#### 步骤 9：HTTPS 记录过滤

对于带域名策略的 HTTPS 查询，地址提示会被过滤：

```go
if question.Qtype == dns.TypeHTTPS {
    if options.Strategy == C.DomainStrategyIPv4Only {
        // 移除 IPv6 提示
    } else if options.Strategy == C.DomainStrategyIPv6Only {
        // 移除 IPv4 提示
    }
}
```

### Lookup

并行 A/AAAA 查询：

```go
func (c *Client) Lookup(ctx context.Context, transport adapter.DNSTransport,
    domain string, options adapter.DNSQueryOptions, responseChecker func([]netip.Addr) bool) ([]netip.Addr, error) {
    if strategy == C.DomainStrategyIPv4Only {
        return c.lookupToExchange(ctx, transport, dnsName, dns.TypeA, options, responseChecker)
    } else if strategy == C.DomainStrategyIPv6Only {
        return c.lookupToExchange(ctx, transport, dnsName, dns.TypeAAAA, options, responseChecker)
    }
    var group task.Group
    group.Append("exchange4", func(ctx context.Context) error { ... })
    group.Append("exchange6", func(ctx context.Context) error { ... })
    err := group.Run(ctx)
    return sortAddresses(response4, response6, strategy), nil
}
```

`sortAddresses` 根据策略排序结果：PreferIPv6 将 AAAA 放在前面，其他情况将 A 放在前面。

## DNS Router

### 规则匹配

```go
func (r *Router) matchDNS(ctx context.Context, allowFakeIP bool, ruleIndex int,
    isAddressQuery bool, options *adapter.DNSQueryOptions) (adapter.DNSTransport, adapter.DNSRule, int) {
    for ; currentRuleIndex < len(r.rules); currentRuleIndex++ {
        currentRule := r.rules[currentRuleIndex]
        if currentRule.WithAddressLimit() && !isAddressQuery {
            continue  // 对非地址查询跳过带地址限制的规则
        }
        metadata.ResetRuleCache()
        if currentRule.Match(metadata) {
            switch action := currentRule.Action().(type) {
            case *R.RuleActionDNSRoute:
                transport, loaded := r.transport.Transport(action.Server)
                // 应用策略、缓存、TTL、客户端子网选项
                return transport, currentRule, currentRuleIndex
            case *R.RuleActionDNSRouteOptions:
                // 修改选项并继续匹配
            case *R.RuleActionReject:
                return nil, currentRule, currentRuleIndex
            case *R.RuleActionPredefined:
                return nil, currentRule, currentRuleIndex
            }
        }
    }
    return r.transport.Default(), nil, -1
}
```

带地址限制的规则仅对地址查询（A、AAAA、HTTPS）进行评估。

### 反向映射

启用后，路由器会存储 IP 到域名的映射，并带有基于 TTL 的过期：

```go
if r.dnsReverseMapping != nil && transport.Type() != C.DNSTypeFakeIP {
    for _, answer := range response.Answer {
        switch record := answer.(type) {
        case *mDNS.A:
            r.dnsReverseMapping.AddWithLifetime(
                M.AddrFromIP(record.A),
                FqdnToDomain(record.Hdr.Name),
                time.Duration(record.Hdr.Ttl)*time.Second)
        case *mDNS.AAAA:
            r.dnsReverseMapping.AddWithLifetime(...)
        }
    }
}
```

FakeIP 响应被排除在反向映射之外，因为它们返回的是合成地址。

### 网络重置

在网络变化时，路由器清除所有缓存并重置所有传输层：

```go
func (r *Router) ResetNetwork() {
    r.ClearCache()
    for _, transport := range r.transport.Transports() {
        transport.Reset()
    }
}
```

## 辅助类型

### RcodeError

```go
type RcodeError int

var RcodeNameError = RcodeError(dns.RcodeNameError)

func (e RcodeError) Error() string {
    return dns.RcodeToString[int(e)]
}
```

### MessageToAddresses

从 DNS 响应中提取 IP 地址，包括 HTTPS SVCB 提示：

```go
func MessageToAddresses(response *dns.Msg) []netip.Addr {
    for _, rawAnswer := range response.Answer {
        switch answer := rawAnswer.(type) {
        case *dns.A:     addresses = append(addresses, M.AddrFromIP(answer.A))
        case *dns.AAAA:  addresses = append(addresses, M.AddrFromIP(answer.AAAA))
        case *dns.HTTPS:
            for _, value := range answer.SVCB.Value {
                if value.Key() == dns.SVCB_IPV4HINT || value.Key() == dns.SVCB_IPV6HINT {
                    addresses = append(addresses, common.Map(strings.Split(value.String(), ","), M.ParseAddr)...)
                }
            }
        }
    }
}
```
