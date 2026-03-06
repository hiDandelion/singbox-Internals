# Configuration Structure

sing-box uses a JSON-based configuration format with a well-defined root structure. Configuration parsing leverages a context-aware JSON decoder with type registries for polymorphic types.

**Source**: `option/options.go`, `option/inbound.go`, `option/outbound.go`, `option/endpoint.go`, `option/dns.go`, `option/route.go`, `option/service.go`, `option/experimental.go`

## Root Options Struct

```go
type _Options struct {
    RawMessage   json.RawMessage      `json:"-"`
    Schema       string               `json:"$schema,omitempty"`
    Log          *LogOptions          `json:"log,omitempty"`
    DNS          *DNSOptions          `json:"dns,omitempty"`
    NTP          *NTPOptions          `json:"ntp,omitempty"`
    Certificate  *CertificateOptions  `json:"certificate,omitempty"`
    Endpoints    []Endpoint           `json:"endpoints,omitempty"`
    Inbounds     []Inbound            `json:"inbounds,omitempty"`
    Outbounds    []Outbound           `json:"outbounds,omitempty"`
    Route        *RouteOptions        `json:"route,omitempty"`
    Services     []Service            `json:"services,omitempty"`
    Experimental *ExperimentalOptions `json:"experimental,omitempty"`
}

type Options _Options
```

### Example Configuration

```json
{
  "$schema": "https://sing-box.sagernet.org/schema.json",
  "log": {
    "level": "info"
  },
  "dns": {
    "servers": [...],
    "rules": [...]
  },
  "inbounds": [
    {"type": "tun", "tag": "tun-in", ...},
    {"type": "mixed", "tag": "mixed-in", ...}
  ],
  "outbounds": [
    {"type": "direct", "tag": "direct"},
    {"type": "vless", "tag": "proxy", ...},
    {"type": "selector", "tag": "select", ...}
  ],
  "endpoints": [
    {"type": "wireguard", "tag": "wg", ...}
  ],
  "route": {
    "rules": [...],
    "rule_set": [...],
    "final": "proxy"
  },
  "services": [
    {"type": "resolved", "tag": "resolved-dns", ...}
  ],
  "experimental": {
    "cache_file": {"enabled": true},
    "clash_api": {"external_controller": "127.0.0.1:9090"}
  }
}
```

## Validation

The `Options.UnmarshalJSONContext` method performs validation:

```go
func (o *Options) UnmarshalJSONContext(ctx context.Context, content []byte) error {
    decoder := json.NewDecoderContext(ctx, bytes.NewReader(content))
    decoder.DisallowUnknownFields()  // strict parsing
    err := decoder.Decode((*_Options)(o))
    o.RawMessage = content
    return checkOptions(o)
}
```

Post-parse validation checks:
- **Duplicate inbound tags**: No two inbounds may share the same tag
- **Duplicate outbound/endpoint tags**: Outbound and endpoint tags share a namespace; no duplicates allowed

```go
func checkInbounds(inbounds []Inbound) error {
    seen := make(map[string]bool)
    for i, inbound := range inbounds {
        tag := inbound.Tag
        if tag == "" { tag = F.ToString(i) }
        if seen[tag] { return E.New("duplicate inbound tag: ", tag) }
        seen[tag] = true
    }
    return nil
}
```

## Typed Inbound/Outbound/Endpoint Parsing

Inbounds, outbounds, endpoints, DNS servers, and services all use the same pattern for polymorphic JSON parsing: a `type` field selects which options struct to parse the remaining fields into.

### The Pattern

Each typed struct has the same structure:

```go
type _Inbound struct {
    Type    string `json:"type"`
    Tag     string `json:"tag,omitempty"`
    Options any    `json:"-"`          // type-specific options, not in JSON directly
}
```

### Context-Aware Deserialization

The unmarshalling uses Go's `context.Context` to carry type registries:

```go
func (h *Inbound) UnmarshalJSONContext(ctx context.Context, content []byte) error {
    // 1. Parse "type" and "tag" fields
    err := json.UnmarshalContext(ctx, content, (*_Inbound)(h))

    // 2. Look up the options registry from context
    registry := service.FromContext[InboundOptionsRegistry](ctx)

    // 3. Create a typed options struct for this type
    options, loaded := registry.CreateOptions(h.Type)

    // 4. Parse remaining fields (excluding type/tag) into the typed struct
    err = badjson.UnmarshallExcludedContext(ctx, content, (*_Inbound)(h), options)

    // 5. Store the parsed options
    h.Options = options
    return nil
}
```

The `badjson.UnmarshallExcluded` function is key -- it parses a JSON object while excluding fields that were already parsed by a different struct. This allows the `type` and `tag` to be handled separately from the protocol-specific options.

### Registry Interfaces

```go
type InboundOptionsRegistry interface {
    CreateOptions(inboundType string) (any, bool)
}

type OutboundOptionsRegistry interface {
    CreateOptions(outboundType string) (any, bool)
}

type EndpointOptionsRegistry interface {
    CreateOptions(endpointType string) (any, bool)
}

type DNSTransportOptionsRegistry interface {
    CreateOptions(transportType string) (any, bool)
}

type ServiceOptionsRegistry interface {
    CreateOptions(serviceType string) (any, bool)
}
```

## DNS Options

DNS configuration has a dual structure for backward compatibility:

```go
type DNSOptions struct {
    RawDNSOptions        // current format
    LegacyDNSOptions     // deprecated format (auto-upgraded)
}

type RawDNSOptions struct {
    Servers        []DNSServerOptions `json:"servers,omitempty"`
    Rules          []DNSRule          `json:"rules,omitempty"`
    Final          string             `json:"final,omitempty"`
    ReverseMapping bool               `json:"reverse_mapping,omitempty"`
    DNSClientOptions
}
```

DNS servers use the same typed pattern:

```go
type DNSServerOptions struct {
    Type    string `json:"type,omitempty"`
    Tag     string `json:"tag,omitempty"`
    Options any    `json:"-"`
}
```

Legacy DNS server format (URL-based like `tls://1.1.1.1`) is automatically upgraded to the new typed format during deserialization.

## Route Options

```go
type RouteOptions struct {
    GeoIP                      *GeoIPOptions
    Geosite                    *GeositeOptions
    Rules                      []Rule
    RuleSet                    []RuleSet
    Final                      string
    FindProcess                bool
    FindNeighbor               bool
    AutoDetectInterface        bool
    OverrideAndroidVPN         bool
    DefaultInterface           string
    DefaultMark                FwMark
    DefaultDomainResolver      *DomainResolveOptions
    DefaultNetworkStrategy     *NetworkStrategy
    DefaultNetworkType         badoption.Listable[InterfaceType]
    DefaultFallbackNetworkType badoption.Listable[InterfaceType]
    DefaultFallbackDelay       badoption.Duration
}
```

## Experimental Options

```go
type ExperimentalOptions struct {
    CacheFile *CacheFileOptions `json:"cache_file,omitempty"`
    ClashAPI  *ClashAPIOptions  `json:"clash_api,omitempty"`
    V2RayAPI  *V2RayAPIOptions  `json:"v2ray_api,omitempty"`
    Debug     *DebugOptions     `json:"debug,omitempty"`
}
```

## Log Options

```go
type LogOptions struct {
    Disabled     bool   `json:"disabled,omitempty"`
    Level        string `json:"level,omitempty"`
    Output       string `json:"output,omitempty"`
    Timestamp    bool   `json:"timestamp,omitempty"`
    DisableColor bool   `json:"-"`      // internal, not from JSON
}
```

## Common Option Types

### ListenOptions (Inbound)

```go
type ListenOptions struct {
    Listen               *badoption.Addr
    ListenPort           uint16
    BindInterface        string
    RoutingMark          FwMark
    ReuseAddr            bool
    NetNs                string
    DisableTCPKeepAlive  bool
    TCPKeepAlive         badoption.Duration
    TCPKeepAliveInterval badoption.Duration
    TCPFastOpen          bool
    TCPMultiPath         bool
    UDPFragment          *bool
    UDPTimeout           UDPTimeoutCompat
    Detour               string
}
```

### DialerOptions (Outbound)

```go
type DialerOptions struct {
    Detour               string
    BindInterface        string
    Inet4BindAddress     *badoption.Addr
    Inet6BindAddress     *badoption.Addr
    ProtectPath          string
    RoutingMark          FwMark
    NetNs                string
    ConnectTimeout       badoption.Duration
    TCPFastOpen          bool
    TCPMultiPath         bool
    DomainResolver       *DomainResolveOptions
    NetworkStrategy      *NetworkStrategy
    NetworkType          badoption.Listable[InterfaceType]
    FallbackNetworkType  badoption.Listable[InterfaceType]
    FallbackDelay        badoption.Duration
}
```

### ServerOptions (Outbound)

```go
type ServerOptions struct {
    Server     string `json:"server"`
    ServerPort uint16 `json:"server_port"`
}

func (o ServerOptions) Build() M.Socksaddr {
    return M.ParseSocksaddrHostPort(o.Server, o.ServerPort)
}
```

## Reimplementation Notes

1. **Context-aware JSON parsing** is central to the design. The `context.Context` carries type registries injected at startup, enabling polymorphic parsing without reflection or code generation
2. **`badjson.UnmarshallExcluded`** is a custom JSON parser that allows two structs to share the same JSON object, splitting fields between them. This is how `type`/`tag` are separated from protocol options
3. **`DisallowUnknownFields`** is enabled, making the parser strict -- typos in field names cause parse errors
4. **Legacy migration** is handled inline during deserialization (e.g., legacy DNS server URLs, deprecated inbound fields). The `dontUpgrade` context flag allows serialization round-trips without triggering migration
5. **Validation** is minimal at parse time -- only tag uniqueness is checked. Semantic validation (e.g., required fields, valid addresses) happens during service construction
6. **`RawMessage`** is stored on the root `Options` to allow re-serialization or forwarding of the original configuration
