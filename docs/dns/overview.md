# DNS Subsystem Overview

Source: `dns/`, `dns/transport/`, `dns/transport/fakeip/`, `dns/transport/hosts/`, `dns/transport/local/`, `dns/transport/dhcp/`

## Architecture

sing-box's DNS subsystem consists of three core components:

```
                     +------------------+
                     |   DNS Router     |   Rule matching, transport selection
                     +------------------+
                            |
                     +------------------+
                     |   DNS Client     |   Caching, EDNS0, RDRC, TTL management
                     +------------------+
                            |
              +-------------+-------------+
              |             |             |
        +---------+   +---------+   +---------+
        | UDP     |   | HTTPS   |   | FakeIP  |   ... more transports
        +---------+   +---------+   +---------+
```

1. **DNS Router** (`dns/router.go`): Matches DNS queries against rules, selects the appropriate transport, handles domain strategy and reverse mapping
2. **DNS Client** (`dns/client.go`): Performs the actual DNS exchange with caching (freelru), EDNS0 client subnet injection, response domain rejection cache (RDRC), and TTL adjustment
3. **DNS Transports** (`dns/transport/`): Protocol-specific query execution (UDP, TCP, TLS, HTTPS, QUIC/HTTP3, FakeIP, Hosts, Local, DHCP)

### Supporting Components

- **Transport Registry** (`dns/transport_registry.go`): Generic type-safe registration of transport types
- **Transport Adapter** (`dns/transport_adapter.go`): Base struct with type/tag/dependencies/strategy/clientSubnet
- **Base Transport** (`dns/transport/base.go`): State machine (New/Started/Closing/Closed) with in-flight query tracking
- **Connector** (`dns/transport/connector.go`): Generic singleflight connection management

## Query Flow

### Exchange (raw DNS message)

1. **Router.Exchange** receives a `*dns.Msg`
2. Metadata extraction: query type, domain, IP version
3. If no explicit transport, match against DNS rules:
   - `RuleActionDNSRoute` -- select transport with options (strategy, cache, TTL, client subnet)
   - `RuleActionDNSRouteOptions` -- modify options without selecting transport
   - `RuleActionReject` -- return REFUSED or drop
   - `RuleActionPredefined` -- return pre-configured response
4. **Client.Exchange** performs the actual query:
   - Check cache (with deduplication via channel-based locking)
   - Check RDRC for previously rejected responses
   - Apply EDNS0 client subnet
   - Execute transport.Exchange with timeout
   - Validate response (address limit check)
   - Normalize TTLs
   - Store in cache
5. Store reverse mapping (IP -> domain) if enabled

### Lookup (domain to addresses)

1. **Router.Lookup** receives a domain string
2. Determines strategy (IPv4Only, IPv6Only, PreferIPv4, PreferIPv6, AsIS)
3. **Client.Lookup** dispatches:
   - IPv4Only: single A query
   - IPv6Only: single AAAA query
   - Otherwise: parallel A + AAAA queries via `task.Group`
4. Results sorted based on strategy preference

### Rule Retry Loop

When a rule has address limits (e.g., geoip restrictions on response addresses), the router retries with subsequent matching rules if the response is rejected:

```go
for {
    transport, rule, ruleIndex = r.matchDNS(ctx, true, ruleIndex, isAddressQuery, &dnsOptions)
    responseCheck := addressLimitResponseCheck(rule, metadata)
    response, err = r.client.Exchange(dnsCtx, transport, message, dnsOptions, responseCheck)
    if responseCheck != nil && rejected {
        continue  // Try next matching rule
    }
    break
}
```

## Key Design Decisions

### Deduplication

The cache uses channel-based deduplication to prevent thundering herd:

```go
cond, loaded := c.cacheLock.LoadOrStore(question, make(chan struct{}))
if loaded {
    <-cond  // Wait for the in-flight query to complete
} else {
    defer func() {
        c.cacheLock.Delete(question)
        close(cond)  // Signal waiters
    }()
}
```

### Loop Detection

DNS query loops (e.g., transport A needs to resolve its server address via transport A) are detected via context:

```go
contextTransport, loaded := transportTagFromContext(ctx)
if loaded && transport.Tag() == contextTransport {
    return nil, E.New("DNS query loopback in transport[", contextTransport, "]")
}
ctx = contextWithTransportTag(ctx, transport.Tag())
```

### RDRC (Response Domain Rejection Cache)

When a response is rejected by an address limit check, the domain/qtype/transport combination is cached in the RDRC to skip future queries against the same transport:

```go
if rejected {
    c.rdrc.SaveRDRCAsync(transport.Tag(), question.Name, question.Qtype, c.logger)
}
// On subsequent queries:
if c.rdrc.LoadRDRC(transport.Tag(), question.Name, question.Qtype) {
    return nil, ErrResponseRejectedCached
}
```

### EDNS0 Client Subnet

Applied before exchange when configured:

```go
clientSubnet := options.ClientSubnet
if !clientSubnet.IsValid() {
    clientSubnet = c.clientSubnet
}
if clientSubnet.IsValid() {
    message = SetClientSubnet(message, clientSubnet)
}
```
