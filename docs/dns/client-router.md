# DNS Client and Router

Source: `dns/client.go`, `dns/router.go`, `dns/rcode.go`, `dns/client_truncate.go`, `dns/client_log.go`, `dns/extension_edns0_subnet.go`

## DNS Client

### Structure

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

Two cache modes:
- **Shared cache** (`cache`): Keyed by `dns.Question` (Name + Qtype + Qclass)
- **Independent cache** (`transportCache`): Keyed by `transportCacheKey` (Question + transport tag), so each transport has its own cache namespace

The cache uses `github.com/sagernet/sing/contrab/freelru` (a sharded LRU cache). Default capacity is 1024 entries.

### Exchange

The core `Exchange` method handles the full query lifecycle:

```go
func (c *Client) Exchange(ctx context.Context, transport adapter.DNSTransport,
    message *dns.Msg, options adapter.DNSQueryOptions,
    responseChecker func(responseAddrs []netip.Addr) bool) (*dns.Msg, error)
```

#### Step 1: Strategy Filtering

Immediately returns empty success for mismatched strategies:

```go
if question.Qtype == dns.TypeA && options.Strategy == C.DomainStrategyIPv6Only ||
   question.Qtype == dns.TypeAAAA && options.Strategy == C.DomainStrategyIPv4Only {
    return FixedResponseStatus(message, dns.RcodeSuccess), nil
}
```

#### Step 2: Client Subnet

```go
clientSubnet := options.ClientSubnet
if !clientSubnet.IsValid() {
    clientSubnet = c.clientSubnet
}
if clientSubnet.IsValid() {
    message = SetClientSubnet(message, clientSubnet)
}
```

#### Step 3: Cache Check

Only "simple requests" are cacheable (single question, no extra records except OPT, no client subnet in options):

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

Cache deduplication prevents concurrent identical queries:

```go
cond, loaded := c.cacheLock.LoadOrStore(question, make(chan struct{}))
if loaded {
    select {
    case <-cond:     // Wait for first query to complete
    case <-ctx.Done(): return nil, ctx.Err()
    }
}
```

#### Step 4: Cache Load with TTL Adjustment

```go
func (c *Client) loadResponse(question dns.Question, transport adapter.DNSTransport) (*dns.Msg, int) {
    response, expireAt, loaded = c.cache.GetWithLifetime(question)
    // Calculate remaining TTL
    nowTTL := int(expireAt.Sub(timeNow).Seconds())
    // Adjust record TTLs: subtract elapsed time
    duration := uint32(originTTL - nowTTL)
    for _, record := range recordList {
        record.Header().Ttl = record.Header().Ttl - duration
    }
    return response, nowTTL
}
```

Cached responses are copied (`response.Copy()`) to prevent mutation. TTLs are adjusted to reflect time elapsed since caching.

#### Step 5: RDRC Check

```go
if c.rdrc != nil {
    rejected := c.rdrc.LoadRDRC(transport.Tag(), question.Name, question.Qtype)
    if rejected {
        return nil, ErrResponseRejectedCached
    }
}
```

#### Step 6: Transport Exchange

```go
ctx, cancel := context.WithTimeout(ctx, c.timeout)
response, err := transport.Exchange(ctx, message)
cancel()
```

Default timeout is `C.DNSTimeout`.

#### Step 7: Response Validation

If a `responseChecker` is provided, the response addresses are validated:

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

#### Step 8: TTL Normalization

All records in the response are set to the minimum TTL found. If `options.RewriteTTL` is set, that value overrides.

For negative responses (NXDOMAIN with no answers), the SOA minimum TTL is used:

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

#### Step 9: HTTPS Record Filtering

For HTTPS queries with domain strategy, address hints are filtered:

```go
if question.Qtype == dns.TypeHTTPS {
    if options.Strategy == C.DomainStrategyIPv4Only {
        // Remove IPv6 hints
    } else if options.Strategy == C.DomainStrategyIPv6Only {
        // Remove IPv4 hints
    }
}
```

### Lookup

Parallel A/AAAA queries:

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

`sortAddresses` orders results by strategy: PreferIPv6 puts AAAA first, everything else puts A first.

## DNS Router

### Rule Matching

```go
func (r *Router) matchDNS(ctx context.Context, allowFakeIP bool, ruleIndex int,
    isAddressQuery bool, options *adapter.DNSQueryOptions) (adapter.DNSTransport, adapter.DNSRule, int) {
    for ; currentRuleIndex < len(r.rules); currentRuleIndex++ {
        currentRule := r.rules[currentRuleIndex]
        if currentRule.WithAddressLimit() && !isAddressQuery {
            continue  // Skip address-limit rules for non-address queries
        }
        metadata.ResetRuleCache()
        if currentRule.Match(metadata) {
            switch action := currentRule.Action().(type) {
            case *R.RuleActionDNSRoute:
                transport, loaded := r.transport.Transport(action.Server)
                // Apply strategy, cache, TTL, client subnet options
                return transport, currentRule, currentRuleIndex
            case *R.RuleActionDNSRouteOptions:
                // Modify options and continue matching
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

Rules with address limits are only evaluated for address queries (A, AAAA, HTTPS).

### Reverse Mapping

When enabled, the router stores IP-to-domain mappings with TTL-based expiration:

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

FakeIP responses are excluded from reverse mapping since they return synthetic addresses.

### Network Reset

On network changes, the router clears all caches and resets all transports:

```go
func (r *Router) ResetNetwork() {
    r.ClearCache()
    for _, transport := range r.transport.Transports() {
        transport.Reset()
    }
}
```

## Helper Types

### RcodeError

```go
type RcodeError int

var RcodeNameError = RcodeError(dns.RcodeNameError)

func (e RcodeError) Error() string {
    return dns.RcodeToString[int(e)]
}
```

### MessageToAddresses

Extracts IP addresses from a DNS response, including HTTPS SVCB hints:

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
