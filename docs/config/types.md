# Custom Option Types

sing-box defines several custom types in the `option` package for configuration parsing. These types handle the conversion between human-readable JSON values and internal Go representations.

**Source**: `option/types.go`, `option/inbound.go`, `option/outbound.go`, `option/udp_over_tcp.go`

## NetworkList

Accepts either a single network string or an array, stored internally as a newline-separated string:

```go
type NetworkList string

func (v *NetworkList) UnmarshalJSON(content []byte) error {
    // Accepts: "tcp" or ["tcp", "udp"]
    // Valid values: "tcp", "udp"
    // Stored as "tcp\nudp"
}

func (v NetworkList) Build() []string {
    // Returns ["tcp", "udp"] if empty (default: both)
    return strings.Split(string(v), "\n")
}
```

**JSON examples**:
```json
"tcp"
["tcp", "udp"]
```

## DomainStrategy

Maps between string strategy names and internal constants:

```go
type DomainStrategy C.DomainStrategy

// Mapping:
//   ""              -> DomainStrategyAsIS
//   "as_is"         -> DomainStrategyAsIS
//   "prefer_ipv4"   -> DomainStrategyPreferIPv4
//   "prefer_ipv6"   -> DomainStrategyPreferIPv6
//   "ipv4_only"     -> DomainStrategyIPv4Only
//   "ipv6_only"     -> DomainStrategyIPv6Only
```

**JSON examples**:
```json
""
"prefer_ipv4"
"ipv6_only"
```

## DNSQueryType

Handles DNS query types as either numeric values or standard string names (via the `miekg/dns` library):

```go
type DNSQueryType uint16

func (t *DNSQueryType) UnmarshalJSON(bytes []byte) error {
    // Accepts: 28 or "AAAA"
    // Uses mDNS.StringToType and mDNS.TypeToString for conversion
}

func (t DNSQueryType) MarshalJSON() ([]byte, error) {
    // Outputs string name if known, otherwise numeric value
}
```

**JSON examples**:
```json
"A"
"AAAA"
28
```

## NetworkStrategy

Maps network strategy string names to internal constants:

```go
type NetworkStrategy C.NetworkStrategy

func (n *NetworkStrategy) UnmarshalJSON(content []byte) error {
    // Uses C.StringToNetworkStrategy lookup map
}
```

## InterfaceType

Represents network interface types (WIFI, Cellular, Ethernet, Other):

```go
type InterfaceType C.InterfaceType

func (t InterfaceType) Build() C.InterfaceType {
    return C.InterfaceType(t)
}

func (t *InterfaceType) UnmarshalJSON(content []byte) error {
    // Uses C.StringToInterfaceType lookup map
}
```

**JSON examples**:
```json
"wifi"
"cellular"
"ethernet"
```

## UDPTimeoutCompat

Handles backward-compatible UDP timeout values -- accepts either a raw number (seconds) or a duration string:

```go
type UDPTimeoutCompat badoption.Duration

func (c *UDPTimeoutCompat) UnmarshalJSON(data []byte) error {
    // First try: parse as integer (seconds)
    var valueNumber int64
    err := json.Unmarshal(data, &valueNumber)
    if err == nil {
        *c = UDPTimeoutCompat(time.Second * time.Duration(valueNumber))
        return nil
    }
    // Fallback: parse as duration string (e.g., "5m")
    return json.Unmarshal(data, (*badoption.Duration)(c))
}
```

**JSON examples**:
```json
300
"5m"
"30s"
```

## DomainResolveOptions

Supports shorthand (just a server name) or full object:

```go
type DomainResolveOptions struct {
    Server       string
    Strategy     DomainStrategy
    DisableCache bool
    RewriteTTL   *uint32
    ClientSubnet *badoption.Prefixable
}

func (o *DomainResolveOptions) UnmarshalJSON(bytes []byte) error {
    // Try string: "dns-server-tag"
    // Fall back to full object
}

func (o DomainResolveOptions) MarshalJSON() ([]byte, error) {
    // If only Server is set, marshal as string
    // Otherwise marshal as object
}
```

**JSON examples**:
```json
"my-dns-server"

{
  "server": "my-dns-server",
  "strategy": "ipv4_only",
  "disable_cache": true,
  "rewrite_ttl": 300,
  "client_subnet": "1.2.3.0/24"
}
```

## UDPOverTCPOptions

Supports shorthand boolean or full object:

```go
type UDPOverTCPOptions struct {
    Enabled bool  `json:"enabled,omitempty"`
    Version uint8 `json:"version,omitempty"`
}

func (o *UDPOverTCPOptions) UnmarshalJSON(bytes []byte) error {
    // Try bool: true/false
    // Fall back to full object
}

func (o UDPOverTCPOptions) MarshalJSON() ([]byte, error) {
    // If version is default (0 or current), marshal as bool
    // Otherwise marshal as object
}
```

**JSON examples**:
```json
true

{
  "enabled": true,
  "version": 2
}
```

## Listable[T] (from badoption)

Not defined in `option/types.go` but used extensively throughout. `badoption.Listable[T]` accepts either a single value or an array:

```go
type Listable[T any] []T

func (l *Listable[T]) UnmarshalJSON(content []byte) error {
    // Try array first, then single value
}
```

**JSON examples**:
```json
"value"
["value1", "value2"]

443
[443, 8443]
```

## Duration (from badoption)

`badoption.Duration` wraps `time.Duration` with JSON string parsing:

```go
type Duration time.Duration

func (d *Duration) UnmarshalJSON(bytes []byte) error {
    // Parses Go duration strings: "5s", "1m30s", "24h"
}
```

**JSON examples**:
```json
"30s"
"5m"
"24h"
"1h30m"
```

## Addr (from badoption)

`badoption.Addr` wraps `netip.Addr` with JSON string parsing:

**JSON examples**:
```json
"127.0.0.1"
"::1"
"0.0.0.0"
```

## Prefix (from badoption)

`badoption.Prefix` wraps `netip.Prefix` for CIDR notation:

**JSON examples**:
```json
"198.18.0.0/15"
"fc00::/7"
```

## Prefixable (from badoption)

`badoption.Prefixable` extends prefix parsing to accept bare addresses (which are treated as /32 or /128):

**JSON examples**:
```json
"192.168.1.0/24"
"192.168.1.1"
```

## FwMark

`FwMark` is used for Linux routing marks (`SO_MARK`). It is defined elsewhere in the option package and accepts integer values:

**JSON example**:
```json
255
```

## Reimplementation Notes

1. **Shorthand patterns**: Many types support both a simple form (string/bool) and a full object form. Deserialization should attempt the simple form first, then fall back to the complex form
2. **Listable[T]**: This is the single most frequently used custom type. Virtually every array field in the configuration accepts both single values and arrays
3. **Duration parsing**: Uses Go's `time.ParseDuration` format, which supports: `ns`, `us`/`\u00b5s`, `ms`, `s`, `m`, `h`
4. **DNS query types**: The `miekg/dns` library's `StringToType` map provides the canonical mapping between names like `"AAAA"` and numeric values like `28`
5. **NetworkList**: The internal newline-separated storage is an implementation detail -- a reimplementation could use a simple string slice
6. **UDPTimeoutCompat**: The dual number/string parsing is for backward compatibility with older configs that used plain seconds
