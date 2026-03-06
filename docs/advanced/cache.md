# Cache File

The cache file provides persistent storage for various runtime state using a bbolt (embedded B+tree) database. It persists FakeIP mappings, selected outbound choices, Clash mode, remote rule set contents, and rejected DNS response cache (RDRC).

**Source**: `experimental/cachefile/`

## Architecture

```go
type CacheFile struct {
    ctx               context.Context
    path              string
    cacheID           []byte           // optional namespace prefix
    storeFakeIP       bool
    storeRDRC         bool
    rdrcTimeout       time.Duration    // default: 7 days
    DB                *bbolt.DB

    // Async write buffers
    saveMetadataTimer *time.Timer
    saveFakeIPAccess  sync.RWMutex
    saveDomain        map[netip.Addr]string
    saveAddress4      map[string]netip.Addr
    saveAddress6      map[string]netip.Addr
    saveRDRCAccess    sync.RWMutex
    saveRDRC          map[saveRDRCCacheKey]bool
}
```

## Bucket Structure

The database uses several top-level buckets:

| Bucket Name | Key | Description |
|-------------|---------|-------------|
| `selected` | group tag | Selected outbound for Selector groups |
| `group_expand` | group tag | UI expand/collapse state |
| `clash_mode` | cache ID | Current Clash API mode |
| `rule_set` | rule set tag | Cached remote rule set content |
| `rdrc2` | transport name (sub-bucket) | Rejected DNS response cache |
| `fakeip_address` | IP bytes | FakeIP address-to-domain mapping |
| `fakeip_domain4` | domain string | FakeIP domain-to-IPv4 mapping |
| `fakeip_domain6` | domain string | FakeIP domain-to-IPv6 mapping |
| `fakeip_metadata` | fixed key | FakeIP allocator state |

### Cache ID Namespacing

When `cache_id` is configured, most buckets are nested under a cache-ID-prefixed top-level bucket (byte `0x00` + cache ID bytes). This allows multiple sing-box instances to share the same database file:

```go
func (c *CacheFile) bucket(t *bbolt.Tx, key []byte) *bbolt.Bucket {
    if c.cacheID == nil {
        return t.Bucket(key)
    }
    bucket := t.Bucket(c.cacheID)  // namespace bucket
    if bucket == nil {
        return nil
    }
    return bucket.Bucket(key)  // actual bucket within namespace
}
```

## Startup and Recovery

```go
func (c *CacheFile) Start(stage adapter.StartStage) error {
    // Only runs at StartStateInitialize
    // 1. Open bbolt with 1-second timeout, retry up to 10 times
    // 2. On corruption (ErrInvalid, ErrChecksum, ErrVersionMismatch):
    //    delete file and retry
    // 3. Clean up unknown buckets (garbage collection)
    // 4. Set file ownership via platform chown
}
```

The database has a self-healing mechanism -- if it detects corruption during access, it deletes and recreates the file:

```go
func (c *CacheFile) resetDB() {
    c.DB.Close()
    os.Remove(c.path)
    db, err := bbolt.Open(c.path, 0o666, ...)
    if err == nil {
        c.DB = db
    }
}
```

All database access methods (`view`, `batch`, `update`) wrap operations with panic recovery that triggers `resetDB()` on corruption.

## Selected Outbound Cache

Persists user selections for Selector outbound groups:

```go
func (c *CacheFile) LoadSelected(group string) string
func (c *CacheFile) StoreSelected(group, selected string) error
```

Used by the Selector outbound group to remember which outbound the user chose across restarts.

## Clash Mode Cache

```go
func (c *CacheFile) LoadMode() string
func (c *CacheFile) StoreMode(mode string) error
```

Persists the current Clash API mode ("Rule", "Global", "Direct") so it survives restarts.

## Rule Set Cache

Remote rule sets are cached with their content, last update time, and HTTP ETag:

```go
func (c *CacheFile) LoadRuleSet(tag string) *adapter.SavedBinary
func (c *CacheFile) SaveRuleSet(tag string, set *adapter.SavedBinary) error
```

The `SavedBinary` struct contains:
- `Content []byte` -- the raw rule set data (JSON or SRS binary)
- `LastUpdated time.Time` -- when it was last successfully fetched
- `LastEtag string` -- HTTP ETag for conditional requests

## FakeIP Cache

FakeIP maintains bidirectional mappings between fake IP addresses and domain names.

### Storage Layout

Three buckets work together:
- `fakeip_address`: `IP bytes -> domain string` (reverse lookup)
- `fakeip_domain4`: `domain -> IPv4 bytes` (forward lookup, IPv4)
- `fakeip_domain6`: `domain -> IPv6 bytes` (forward lookup, IPv6)

### Write Operations

```go
func (c *CacheFile) FakeIPStore(address netip.Addr, domain string) error {
    // 1. Read old domain for this address (if any)
    // 2. Store address -> domain
    // 3. Delete old domain -> address mapping
    // 4. Store new domain -> address mapping
}
```

### Async Write Optimization

FakeIP writes are performance-critical, so an async buffering layer is provided:

```go
func (c *CacheFile) FakeIPStoreAsync(address netip.Addr, domain string, logger) {
    // 1. Buffer the mapping in in-memory maps
    // 2. Spawn a goroutine to persist to bbolt
    // 3. Read operations check in-memory buffer first
}
```

The in-memory buffer (`saveDomain`, `saveAddress4`, `saveAddress6`) is checked by `FakeIPLoad` and `FakeIPLoadDomain` before falling back to the database, ensuring consistency during async writes.

### Metadata Persistence

FakeIP allocator metadata (current allocation pointer) is saved with a debounce timer:

```go
func (c *CacheFile) FakeIPSaveMetadataAsync(metadata *adapter.FakeIPMetadata) {
    // Uses time.AfterFunc with FakeIPMetadataSaveInterval
    // Resets timer on each call to batch rapid allocations
}
```

## RDRC (Rejected DNS Response Cache)

RDRC caches DNS responses that were rejected (e.g., empty or blocked responses), avoiding repeated lookups for domains known to be blocked.

### Storage Key

```go
type saveRDRCCacheKey struct {
    TransportName string
    QuestionName  string
    QType         uint16
}
```

In the database, the key is `[uint16 big-endian: qtype][domain string]`, nested under a sub-bucket named after the DNS transport.

### Expiration

Each RDRC entry stores an expiration timestamp:

```go
func (c *CacheFile) LoadRDRC(transportName, qName string, qType uint16) (rejected bool) {
    // 1. Check in-memory async buffer first
    // 2. Read from database
    // 3. Parse expiration timestamp (uint64 big-endian Unix seconds)
    // 4. If expired, delete the entry and return false
    // 5. If valid, return true (domain is rejected)
}

func (c *CacheFile) SaveRDRC(transportName, qName string, qType uint16) error {
    // Store with expiration = now + rdrcTimeout (default 7 days)
    // Key: [2 bytes qtype][domain bytes]
    // Value: [8 bytes expiration unix timestamp big-endian]
}
```

### Async RDRC Writes

Like FakeIP, RDRC writes are buffered in memory for immediate read-back:

```go
func (c *CacheFile) SaveRDRCAsync(transportName, qName string, qType uint16, logger) {
    // Buffer in saveRDRC map
    // Persist asynchronously in goroutine
}
```

## Configuration

```json
{
  "experimental": {
    "cache_file": {
      "enabled": true,
      "path": "cache.db",
      "cache_id": "my-instance",
      "store_fakeip": true,
      "store_rdrc": true,
      "rdrc_timeout": "168h"
    }
  }
}
```

## Reimplementation Notes

1. **bbolt** is a pure-Go embedded B+tree database (fork of boltdb). Any embedded key-value store with bucket/namespace support would work as a replacement (e.g., SQLite, LevelDB)
2. **Corruption recovery** is critical -- the cache file may be corrupted by crashes or power loss. The delete-and-recreate strategy is simple but effective
3. **Async write buffering** is important for FakeIP and RDRC performance. These operations happen on every DNS query and must not block the hot path
4. **Cache ID namespacing** allows multiple instances to share one database file without conflicts
5. **FakeIP bidirectional mapping** must be kept consistent -- when updating an address mapping, the old domain mapping must be deleted first
6. **RDRC timeout** controls how long rejected DNS responses are cached. The default of 7 days is appropriate for ad-blocking rule sets that don't change frequently
7. The `group_expand` bucket stores a single byte (`0` or `1`) for UI state in Clash dashboards -- this is purely cosmetic persistence
