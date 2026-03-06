# GeoIP and GeoSite Databases

sing-box supports two legacy geographic database formats for IP and domain-based routing: GeoIP (MaxMind MMDB format) and GeoSite (custom binary format). These are being replaced by the newer rule set system but remain supported for backward compatibility.

**Source**: `common/geoip/`, `common/geosite/`, `option/route.go`

## GeoIP (MaxMind MMDB)

### Overview

GeoIP uses a modified MaxMind MMDB database with the database type identifier `sing-geoip` (not the standard MaxMind `GeoLite2-Country`). This is a purpose-built database that maps IP addresses directly to country codes.

### Reader Implementation

```go
type Reader struct {
    reader *maxminddb.Reader
}

func Open(path string) (*Reader, []string, error) {
    database, err := maxminddb.Open(path)
    if err != nil {
        return nil, nil, err
    }
    if database.Metadata.DatabaseType != "sing-geoip" {
        database.Close()
        return nil, nil, E.New("incorrect database type, expected sing-geoip, got ",
            database.Metadata.DatabaseType)
    }
    return &Reader{database}, database.Metadata.Languages, nil
}
```

Key points:
- **Database type validation**: Only accepts databases with type `sing-geoip`, rejecting standard MaxMind databases
- **Language codes**: Returns the list of available country codes via `database.Metadata.Languages`
- **Lookup**: Maps a `netip.Addr` directly to a country code string; returns `"unknown"` if not found

```go
func (r *Reader) Lookup(addr netip.Addr) string {
    var code string
    _ = r.reader.Lookup(addr.AsSlice(), &code)
    if code != "" {
        return code
    }
    return "unknown"
}
```

### MMDB Format

The MMDB format is a binary trie structure designed for efficient IP prefix lookup. The `maxminddb-golang` library handles parsing. For the `sing-geoip` variant:
- The data section stores simple string values (country codes) rather than nested structures
- The metadata section uses `Languages` to store the list of available country codes
- IPv4 and IPv6 addresses are both supported through the trie structure

### Configuration

```json
{
  "route": {
    "geoip": {
      "path": "geoip.db",
      "download_url": "https://github.com/SagerNet/sing-geoip/releases/latest/download/geoip.db",
      "download_detour": "proxy"
    }
  }
}
```

## GeoSite (Custom Binary Format)

### Overview

GeoSite is a custom binary database format that maps category codes (like `google`, `category-ads-all`) to lists of domain rules. Each domain rule has a type (exact, suffix, keyword, regex) and a value.

### File Structure

```
[uint8: version (0)]
[uvarint: entry_count]
  [uvarint: code_length] [bytes: code_string]
  [uvarint: byte_offset]
  [uvarint: item_count]
  ...
[domain items data...]
```

The file has two sections:
1. **Metadata section**: An index mapping category codes to byte offsets and item counts
2. **Data section**: The actual domain items, stored contiguously

### Item Types

```go
type ItemType = uint8

const (
    RuleTypeDomain        ItemType = 0  // Exact domain match
    RuleTypeDomainSuffix  ItemType = 1  // Domain suffix match (e.g., ".google.com")
    RuleTypeDomainKeyword ItemType = 2  // Domain contains keyword
    RuleTypeDomainRegex   ItemType = 3  // Regular expression match
)

type Item struct {
    Type  ItemType
    Value string
}
```

### Reader Implementation

```go
type Reader struct {
    access         sync.Mutex
    reader         io.ReadSeeker
    bufferedReader *bufio.Reader
    metadataIndex  int64           // byte offset where data section starts
    domainIndex    map[string]int  // code -> byte offset in data section
    domainLength   map[string]int  // code -> number of items
}
```

The reader operates in two phases:
1. **`readMetadata()`**: Reads the entire index on open, building maps from code to offset/length
2. **`Read(code)`**: Seeks to the code's offset in the data section and reads items on demand

```go
func (r *Reader) Read(code string) ([]Item, error) {
    index, exists := r.domainIndex[code]
    if !exists {
        return nil, E.New("code ", code, " not exists!")
    }
    _, err := r.reader.Seek(r.metadataIndex+int64(index), io.SeekStart)
    // ... read items
}
```

Each item in the data section is stored as:
```
[uint8: item_type]
[uvarint: value_length] [bytes: value_string]
```

### Writer Implementation

The writer builds the data section in memory first to calculate offsets:

```go
func Write(writer varbin.Writer, domains map[string][]Item) error {
    // 1. Sort codes alphabetically
    // 2. Write all items to a buffer, recording byte offsets per code
    // 3. Write version byte (0)
    // 4. Write entry count
    // 5. For each code: write code string, byte offset, item count
    // 6. Write the buffered item data
}
```

### Compiling to Rules

GeoSite items are compiled into sing-box rule options:

```go
func Compile(code []Item) option.DefaultRule {
    // Maps each ItemType to the corresponding rule field:
    //   RuleTypeDomain        -> rule.Domain
    //   RuleTypeDomainSuffix  -> rule.DomainSuffix
    //   RuleTypeDomainKeyword -> rule.DomainKeyword
    //   RuleTypeDomainRegex   -> rule.DomainRegex
}
```

Multiple compiled rules can be merged with `Merge()`, which concatenates all domain lists.

### Configuration

```json
{
  "route": {
    "geosite": {
      "path": "geosite.db",
      "download_url": "https://github.com/SagerNet/sing-geosite/releases/latest/download/geosite.db",
      "download_detour": "proxy"
    }
  }
}
```

## How They Are Used in Rules

In routing rules, GeoIP and GeoSite references are used like:

```json
{
  "route": {
    "rules": [
      {
        "geoip": ["cn", "private"],
        "outbound": "direct"
      },
      {
        "geosite": ["category-ads-all"],
        "outbound": "block"
      }
    ]
  }
}
```

The router loads the database on startup, reads the requested codes, and compiles them into in-memory rule matchers. GeoIP codes produce IP CIDR rules; GeoSite codes produce domain/keyword/regex rules.

## Migration to Rule Sets

GeoIP and GeoSite are considered legacy. The recommended migration path is to use SRS rule sets, which:
- Support more rule types (ports, processes, network conditions)
- Have better update mechanisms (HTTP with ETag, file watching)
- Allow inline definitions without external files
- Use a more compact binary format with zlib compression

## Reimplementation Notes

1. **GeoIP**: Depends on `github.com/oschwald/maxminddb-golang` for MMDB parsing. The MMDB format is well-documented and has implementations in many languages. The only sing-box-specific aspect is the `sing-geoip` database type check
2. **GeoSite**: Uses a custom binary format with uvarint encoding. The format is straightforward to implement: read the index, seek to the right offset, read items
3. **Thread safety**: The GeoSite reader uses a mutex because it shares a seekable reader and buffered reader across calls. A reimplementation could use per-call readers if the data is small enough to cache in memory
4. **Byte offset tracking**: The `readCounter` wrapper tracks how many bytes the metadata section consumed, accounting for buffered reader lookahead via `reader.Buffered()`
