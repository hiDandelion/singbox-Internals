# FakeIP DNS Transport

Source: `dns/transport/fakeip/fakeip.go`, `dns/transport/fakeip/store.go`, `dns/transport/fakeip/memory.go`

## Overview

FakeIP assigns synthetic IP addresses from configured ranges to DNS queries. Instead of resolving a domain to its real IP, FakeIP allocates a unique address from a pool and maintains a bidirectional mapping (domain <-> IP). When a connection is made to a FakeIP address, the router resolves the original domain and connects to the real destination.

## Transport

```go
var _ adapter.FakeIPTransport = (*Transport)(nil)

type Transport struct {
    dns.TransportAdapter
    logger logger.ContextLogger
    store  adapter.FakeIPStore
}

func (t *Transport) Exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    question := message.Question[0]
    if question.Qtype != mDNS.TypeA && question.Qtype != mDNS.TypeAAAA {
        return nil, E.New("only IP queries are supported by fakeip")
    }
    address, err := t.store.Create(dns.FqdnToDomain(question.Name), question.Qtype == mDNS.TypeAAAA)
    return dns.FixedResponse(message.Id, question, []netip.Addr{address}, C.DefaultDNSTTL), nil
}

func (t *Transport) Store() adapter.FakeIPStore {
    return t.store
}
```

Only A and AAAA queries are supported. Other query types (MX, TXT, etc.) return an error.

The transport implements `adapter.FakeIPTransport` which provides `Store()` for direct FakeIP store access.

## Store

The store manages IP allocation and the bidirectional domain/address mapping:

```go
type Store struct {
    ctx        context.Context
    logger     logger.Logger
    inet4Range netip.Prefix
    inet6Range netip.Prefix
    inet4Last  netip.Addr    // Broadcast address (upper bound)
    inet6Last  netip.Addr
    storage    adapter.FakeIPStorage

    addressAccess sync.Mutex
    inet4Current  netip.Addr  // Last allocated IPv4
    inet6Current  netip.Addr  // Last allocated IPv6
}
```

### IP Allocation

Sequential allocation with wrap-around:

```go
func (s *Store) Create(domain string, isIPv6 bool) (netip.Addr, error) {
    // Check if domain already has an address
    if address, loaded := s.storage.FakeIPLoadDomain(domain, isIPv6); loaded {
        return address, nil
    }

    s.addressAccess.Lock()
    defer s.addressAccess.Unlock()

    // Double-check after lock
    if address, loaded := s.storage.FakeIPLoadDomain(domain, isIPv6); loaded {
        return address, nil
    }

    var address netip.Addr
    if !isIPv6 {
        nextAddress := s.inet4Current.Next()
        if nextAddress == s.inet4Last || !s.inet4Range.Contains(nextAddress) {
            nextAddress = s.inet4Range.Addr().Next().Next()  // Wrap around, skip network+first
        }
        s.inet4Current = nextAddress
        address = nextAddress
    } else {
        // Same logic for IPv6
    }

    s.storage.FakeIPStore(address, domain)
    s.storage.FakeIPSaveMetadataAsync(&adapter.FakeIPMetadata{...})
    return address, nil
}
```

The allocation skips the network address and the first host address (`.0` and `.1` in IPv4 terms), starting from the third address. When the range is exhausted, it wraps around, recycling previously used addresses.

### Broadcast Address Calculation

```go
func broadcastAddress(prefix netip.Prefix) netip.Addr {
    addr := prefix.Addr()
    raw := addr.As16()
    bits := prefix.Bits()
    if addr.Is4() { bits += 96 }
    for i := bits; i < 128; i++ {
        raw[i/8] |= 1 << (7 - i%8)
    }
    if addr.Is4() {
        return netip.AddrFrom4([4]byte(raw[12:]))
    }
    return netip.AddrFrom16(raw)
}
```

Computes the broadcast address by setting all host bits to 1.

### Persistence

The store checks for a cache file on startup:

```go
func (s *Store) Start() error {
    cacheFile := service.FromContext[adapter.CacheFile](s.ctx)
    if cacheFile != nil && cacheFile.StoreFakeIP() {
        storage = cacheFile
    }
    if storage == nil {
        storage = NewMemoryStorage()
    }
    // Restore state if ranges match
    metadata := storage.FakeIPMetadata()
    if metadata != nil && metadata.Inet4Range == s.inet4Range && metadata.Inet6Range == s.inet6Range {
        s.inet4Current = metadata.Inet4Current
        s.inet6Current = metadata.Inet6Current
    } else {
        // Reset on range change
        s.inet4Current = s.inet4Range.Addr().Next()
        s.inet6Current = s.inet6Range.Addr().Next()
        storage.FakeIPReset()
    }
}
```

If the configured ranges change, the store is reset. Otherwise, allocation resumes from the last saved position.

On close, metadata is saved:

```go
func (s *Store) Close() error {
    return s.storage.FakeIPSaveMetadata(&adapter.FakeIPMetadata{
        Inet4Range:   s.inet4Range,
        Inet6Range:   s.inet6Range,
        Inet4Current: s.inet4Current,
        Inet6Current: s.inet6Current,
    })
}
```

### Lookup

```go
func (s *Store) Lookup(address netip.Addr) (string, bool) {
    return s.storage.FakeIPLoad(address)
}

func (s *Store) Contains(address netip.Addr) bool {
    return s.inet4Range.Contains(address) || s.inet6Range.Contains(address)
}
```

## Memory Storage

In-memory implementation using bidirectional maps:

```go
type MemoryStorage struct {
    addressByDomain4 map[string]netip.Addr
    addressByDomain6 map[string]netip.Addr
    domainByAddress  map[netip.Addr]string
}
```

Three maps maintain the bidirectional mapping:
- `addressByDomain4`: domain -> IPv4 address
- `addressByDomain6`: domain -> IPv6 address
- `domainByAddress`: address (v4 or v6) -> domain

### Store with Recycling

When storing a new address-domain mapping, any existing mapping for the same address is removed first:

```go
func (s *MemoryStorage) FakeIPStore(address netip.Addr, domain string) error {
    if oldDomain, loaded := s.domainByAddress[address]; loaded {
        if address.Is4() {
            delete(s.addressByDomain4, oldDomain)
        } else {
            delete(s.addressByDomain6, oldDomain)
        }
    }
    s.domainByAddress[address] = domain
    if address.Is4() {
        s.addressByDomain4[domain] = address
    } else {
        s.addressByDomain6[domain] = address
    }
    return nil
}
```

This handles the wrap-around case where an address is recycled to a new domain.

## Configuration

```json
{
  "dns": {
    "servers": [
      {
        "tag": "fakeip",
        "type": "fakeip",
        "inet4_range": "198.18.0.0/15",
        "inet6_range": "fc00::/18"
      }
    ]
  }
}
```

| Field | Description |
|-------|-------------|
| `inet4_range` | IPv4 CIDR range for FakeIP allocation |
| `inet6_range` | IPv6 CIDR range for FakeIP allocation |

Typical ranges use RFC 5737 documentation addresses (`198.18.0.0/15`) or ULA addresses (`fc00::/18`).
