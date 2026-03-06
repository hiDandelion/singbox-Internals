# Rule Sets

Rule sets provide reusable collections of routing rules that can be loaded from inline definitions, local files, or remote URLs. They are the modern replacement for the legacy GeoIP/GeoSite databases.

**Source**: `common/srs/`, `route/rule/rule_set.go`, `route/rule/rule_set_local.go`, `route/rule/rule_set_remote.go`, `option/rule_set.go`

## SRS Binary Format

The SRS (Sing-box Rule Set) format is a compact binary representation of rule sets, designed for efficient loading and reduced file size compared to JSON source files.

### File Structure

```
+--------+--------+------------------------------+
| Magic  | Version| zlib-compressed rule data    |
| 3 bytes| 1 byte |                              |
+--------+--------+------------------------------+
```

```go
var MagicBytes = [3]byte{0x53, 0x52, 0x53} // ASCII "SRS"
```

### Version History

| Version | Constant | New Features |
|---------|----------|-------------|
| 1 | `RuleSetVersion1` | Initial format |
| 2 | `RuleSetVersion2` | AdGuard domain rules |
| 3 | `RuleSetVersion3` | `network_type`, `network_is_expensive`, `network_is_constrained` |
| 4 | `RuleSetVersion4` | `network_interface_address`, `default_interface_address` |

### Reading Process

```go
func Read(reader io.Reader, recover bool) (PlainRuleSetCompat, error) {
    // 1. Read and validate 3-byte magic header "SRS"
    // 2. Read 1-byte version number (big-endian uint8)
    // 3. Open zlib decompression reader
    // 4. Read uvarint for rule count
    // 5. Read each rule sequentially
}
```

The `recover` flag controls whether binary-optimized structures (like domain matchers and IP sets) are expanded back into their human-readable forms (string lists). This is used when decompiling `.srs` back to JSON.

### Compressed Data Layout

After the 4-byte header, all subsequent data is zlib-compressed (best compression level). Inside the decompressed stream:

```
[uvarint: rule_count]
[rule_0]
[rule_1]
...
[rule_N]
```

### Rule Encoding

Each rule begins with a `uint8` rule type byte:

| Type Byte | Meaning |
|-----------|---------|
| `0` | Default rule (flat conditions) |
| `1` | Logical rule (AND/OR of sub-rules) |

#### Default Rule Items

A default rule is a sequence of typed items terminated by `0xFF`:

```
[uint8: 0x00 (default rule)]
[uint8: item_type] [item_data...]
[uint8: item_type] [item_data...]
...
[uint8: 0xFF (final)]
[bool: invert]
```

Item type constants:

```go
const (
    ruleItemQueryType              uint8 = 0   // []uint16 (big-endian)
    ruleItemNetwork                uint8 = 1   // []string
    ruleItemDomain                 uint8 = 2   // domain.Matcher binary
    ruleItemDomainKeyword          uint8 = 3   // []string
    ruleItemDomainRegex            uint8 = 4   // []string
    ruleItemSourceIPCIDR           uint8 = 5   // IPSet binary
    ruleItemIPCIDR                 uint8 = 6   // IPSet binary
    ruleItemSourcePort             uint8 = 7   // []uint16 (big-endian)
    ruleItemSourcePortRange        uint8 = 8   // []string
    ruleItemPort                   uint8 = 9   // []uint16 (big-endian)
    ruleItemPortRange              uint8 = 10  // []string
    ruleItemProcessName            uint8 = 11  // []string
    ruleItemProcessPath            uint8 = 12  // []string
    ruleItemPackageName            uint8 = 13  // []string
    ruleItemWIFISSID               uint8 = 14  // []string
    ruleItemWIFIBSSID              uint8 = 15  // []string
    ruleItemAdGuardDomain          uint8 = 16  // AdGuardMatcher binary (v2+)
    ruleItemProcessPathRegex       uint8 = 17  // []string
    ruleItemNetworkType            uint8 = 18  // []uint8 (v3+)
    ruleItemNetworkIsExpensive     uint8 = 19  // no data (v3+)
    ruleItemNetworkIsConstrained   uint8 = 20  // no data (v3+)
    ruleItemNetworkInterfaceAddress uint8 = 21 // TypedMap (v4+)
    ruleItemDefaultInterfaceAddress uint8 = 22 // []Prefix (v4+)
    ruleItemFinal                  uint8 = 0xFF
)
```

#### String Array Encoding

```
[uvarint: count]
  [uvarint: string_length] [bytes: string_data]
  ...
```

#### uint16 Array Encoding

```
[uvarint: count]
[uint16 big-endian] [uint16 big-endian] ...
```

#### IP Set Encoding

IP sets are stored as ranges rather than CIDR prefixes for compactness:

```
[uint8: version (must be 1)]
[uint64 big-endian: range_count]
  [uvarint: from_addr_length] [bytes: from_addr]
  [uvarint: to_addr_length]   [bytes: to_addr]
  ...
```

The implementation uses `unsafe.Pointer` to directly reinterpret the internal structure of `netipx.IPSet` (which stores IP ranges as `{from, to}` pairs). IPv4 addresses are 4 bytes; IPv6 addresses are 16 bytes.

#### IP Prefix Encoding

Individual prefixes (used in v4+ network interface address rules):

```
[uvarint: addr_byte_length]
[bytes: addr_bytes]
[uint8: prefix_bits]
```

#### Logical Rule Encoding

```
[uint8: 0x01 (logical rule)]
[uint8: mode]  // 0 = AND, 1 = OR
[uvarint: sub_rule_count]
[sub_rule_0]
[sub_rule_1]
...
[bool: invert]
```

## Rule Set Types

### Factory Function

```go
func NewRuleSet(ctx, logger, options) (adapter.RuleSet, error) {
    switch options.Type {
    case "inline", "local", "":
        return NewLocalRuleSet(ctx, logger, options)
    case "remote":
        return NewRemoteRuleSet(ctx, logger, options), nil
    }
}
```

### Local Rule Set

`LocalRuleSet` handles both inline rules (embedded in config JSON) and file-based rule sets.

```go
type LocalRuleSet struct {
    ctx        context.Context
    logger     logger.Logger
    tag        string
    access     sync.RWMutex
    rules      []adapter.HeadlessRule
    metadata   adapter.RuleSetMetadata
    fileFormat string              // "source" (JSON) or "binary" (SRS)
    watcher    *fswatch.Watcher    // file change watcher
    callbacks  list.List[adapter.RuleSetUpdateCallback]
    refs       atomic.Int32        // reference counting
}
```

Key behaviors:
- **Inline mode**: Rules are parsed from `options.InlineOptions.Rules` at construction time
- **File mode**: Rules are loaded from `options.LocalOptions.Path` and an `fswatch.Watcher` is set up for automatic reloading on file changes
- **Format auto-detection**: File extension `.json` selects source format; `.srs` selects binary format
- **Hot reload**: When the watcher detects changes, `reloadFile()` re-reads and re-parses the file, then notifies all registered callbacks

### Remote Rule Set

`RemoteRuleSet` downloads rule sets from a URL with periodic auto-update.

```go
type RemoteRuleSet struct {
    ctx            context.Context
    cancel         context.CancelFunc
    logger         logger.ContextLogger
    outbound       adapter.OutboundManager
    options        option.RuleSet
    updateInterval time.Duration    // default: 24 hours
    dialer         N.Dialer
    access         sync.RWMutex
    rules          []adapter.HeadlessRule
    metadata       adapter.RuleSetMetadata
    lastUpdated    time.Time
    lastEtag       string           // HTTP ETag for conditional requests
    updateTicker   *time.Ticker
    cacheFile      adapter.CacheFile
    pauseManager   pause.Manager
    callbacks      list.List[adapter.RuleSetUpdateCallback]
    refs           atomic.Int32
}
```

Key behaviors:
- **Cache persistence**: On startup, loads cached content from `adapter.CacheFile` (bbolt database). If cached data exists, uses it immediately instead of downloading
- **ETag support**: Uses HTTP `If-None-Match` / `304 Not Modified` to avoid re-downloading unchanged rule sets
- **Download detour**: Can route download traffic through a specified outbound (e.g., to use a proxy to fetch rule sets)
- **Update loop**: After `PostStart()`, runs `loopUpdate()` in a goroutine that checks for updates at `updateInterval`
- **Memory management**: After updating, if `refs == 0` (no active rule references), the parsed rules are set to `nil` to free memory, with `runtime.GC()` called explicitly

## Reference Counting

Both `LocalRuleSet` and `RemoteRuleSet` implement reference counting via `atomic.Int32`:

```go
func (s *LocalRuleSet) IncRef()  { s.refs.Add(1) }
func (s *LocalRuleSet) DecRef()  {
    if s.refs.Add(-1) < 0 {
        panic("rule-set: negative refs")
    }
}
func (s *LocalRuleSet) Cleanup() {
    if s.refs.Load() == 0 {
        s.rules = nil  // free memory when no references
    }
}
```

This allows the router to track which rule sets are actively used by routing rules and free memory for unused ones.

## Rule Set Metadata

After loading rules, metadata is computed to determine what kinds of lookups are needed:

```go
type RuleSetMetadata struct {
    ContainsProcessRule bool  // needs process searcher
    ContainsWIFIRule    bool  // needs WIFI state
    ContainsIPCIDRRule  bool  // needs resolved IP addresses
}
```

These flags allow the router to skip expensive operations (like process name lookup or DNS resolution) when no rule set requires them.

## IP Set Extraction

Rule sets support extracting all IP CIDR items into `netipx.IPSet` values via `ExtractIPSet()`. This is used for system-level optimizations like TUN routing table configuration, where IP-based rules need to be applied at the network stack level rather than per-connection.

## Configuration

```json
{
  "route": {
    "rule_set": [
      {
        "type": "local",
        "tag": "geoip-cn",
        "format": "binary",
        "path": "geoip-cn.srs"
      },
      {
        "type": "remote",
        "tag": "geosite-category-ads",
        "format": "binary",
        "url": "https://example.com/geosite-category-ads.srs",
        "download_detour": "proxy",
        "update_interval": "24h"
      },
      {
        "tag": "my-rules",
        "rules": [
          {
            "domain_suffix": [".example.com"]
          }
        ]
      }
    ]
  }
}
```

## Reimplementation Notes

1. The SRS binary format uses Go's `encoding/binary` with big-endian byte order and `binary.ReadUvarint`/`varbin.WriteUvarint` for variable-length integers
2. Domain matching uses `sing/common/domain.Matcher` which has its own binary serialization format -- this is a dependency you must implement or import
3. The IP set binary format uses `unsafe.Pointer` to directly manipulate `netipx.IPSet` internals -- a reimplementation should use proper IP range serialization instead
4. zlib compression uses `zlib.BestCompression` level for writing
5. Format auto-detection checks file extensions: `.json` = source, `.srs` = binary
6. The ETag-based caching for remote rule sets must handle both `200 OK` (new content) and `304 Not Modified` (update timestamp only)
