# Hosts and Local DNS Transports

Source: `dns/transport/hosts/hosts.go`, `dns/transport/hosts/hosts_file.go`, `dns/transport/local/local.go`, `dns/transport/dhcp/dhcp.go`

## Hosts Transport

The hosts transport resolves domains against hosts file entries and predefined mappings.

### Structure

```go
type Transport struct {
    dns.TransportAdapter
    files      []*File
    predefined map[string][]netip.Addr
}
```

### Lookup Priority

1. **Predefined entries** are checked first (in-config mappings)
2. **Hosts files** are checked in order

```go
func (t *Transport) Exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    question := message.Question[0]
    domain := mDNS.CanonicalName(question.Name)
    if question.Qtype == mDNS.TypeA || question.Qtype == mDNS.TypeAAAA {
        if addresses, ok := t.predefined[domain]; ok {
            return dns.FixedResponse(message.Id, question, addresses, C.DefaultDNSTTL), nil
        }
        for _, file := range t.files {
            addresses := file.Lookup(domain)
            if len(addresses) > 0 {
                return dns.FixedResponse(message.Id, question, addresses, C.DefaultDNSTTL), nil
            }
        }
    }
    return &mDNS.Msg{
        MsgHdr: mDNS.MsgHdr{Id: message.Id, Rcode: mDNS.RcodeNameError, Response: true},
        Question: []mDNS.Question{question},
    }, nil
}
```

Only A and AAAA queries are handled. Unresolvable domains return NXDOMAIN. Non-address queries also return NXDOMAIN.

### Construction

```go
func NewTransport(ctx context.Context, logger log.ContextLogger, tag string,
    options option.HostsDNSServerOptions) (adapter.DNSTransport, error) {
    if len(options.Path) == 0 {
        files = append(files, NewFile(DefaultPath))  // /etc/hosts
    } else {
        for _, path := range options.Path {
            files = append(files, NewFile(filemanager.BasePath(ctx, os.ExpandEnv(path))))
        }
    }
    if options.Predefined != nil {
        for _, entry := range options.Predefined.Entries() {
            predefined[mDNS.CanonicalName(entry.Key)] = entry.Value
        }
    }
}
```

Domain names are canonicalized (lowercased, FQDN with trailing dot) via `mDNS.CanonicalName`.

### Hosts File Parsing

The `File` struct provides lazy parsing with caching:

```go
type File struct {
    path    string
    access  sync.Mutex
    modTime time.Time
    modSize int64
    entries map[string][]netip.Addr
    lastCheck time.Time
}
```

**Cache invalidation**: The file is re-parsed only when:
- More than 5 seconds have elapsed since the last check, AND
- The file's modification time or size has changed

```go
func (f *File) Lookup(domain string) []netip.Addr {
    f.access.Lock()
    defer f.access.Unlock()
    if time.Since(f.lastCheck) > 5*time.Second {
        stat, err := os.Stat(f.path)
        if stat.ModTime() != f.modTime || stat.Size() != f.modSize {
            f.entries = parseHostsFile(f.path)
            f.modTime = stat.ModTime()
            f.modSize = stat.Size()
        }
        f.lastCheck = time.Now()
    }
    return f.entries[domain]
}
```

**Parsing rules**:
- Lines starting with `#` are comments
- Each line: `<IP> <hostname1> [hostname2] ...`
- Hostnames are canonicalized (lowercased + trailing dot)
- IPv4 and IPv6 addresses are both supported
- Multiple entries for the same hostname are accumulated

### Default Path

```go
// Linux/macOS
var DefaultPath = "/etc/hosts"

// Windows
var DefaultPath = `C:\Windows\System32\drivers\etc\hosts`
```

## Local DNS Transport

The local transport resolves DNS queries using the system resolver.

### Structure (non-Darwin)

```go
type Transport struct {
    dns.TransportAdapter
    ctx      context.Context
    logger   logger.ContextLogger
    hosts    *hosts.File
    dialer   N.Dialer
    preferGo bool
    resolved ResolvedResolver
}
```

### Resolution Priority

1. **systemd-resolved** (Linux only): If the system uses resolved, queries are sent via D-Bus
2. **Local hosts file**: Checked before network resolution
3. **System resolver**: Falls back to Go's `net.Resolver`

```go
func (t *Transport) Exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    // 1. Try systemd-resolved
    if t.resolved != nil {
        resolverObject := t.resolved.Object()
        if resolverObject != nil {
            return t.resolved.Exchange(resolverObject, ctx, message)
        }
    }
    // 2. Try local hosts file
    if question.Qtype == mDNS.TypeA || question.Qtype == mDNS.TypeAAAA {
        addresses := t.hosts.Lookup(dns.FqdnToDomain(question.Name))
        if len(addresses) > 0 {
            return dns.FixedResponse(message.Id, question, addresses, C.DefaultDNSTTL), nil
        }
    }
    // 3. System resolver
    return t.exchange(ctx, message, question.Name)
}
```

### systemd-resolved Detection

```go
func (t *Transport) Start(stage adapter.StartStage) error {
    switch stage {
    case adapter.StartStateInitialize:
        if !t.preferGo {
            if isSystemdResolvedManaged() {
                resolvedResolver, err := NewResolvedResolver(t.ctx, t.logger)
                if err == nil {
                    err = resolvedResolver.Start()
                    if err == nil {
                        t.resolved = resolvedResolver
                    }
                }
            }
        }
    }
}
```

If `preferGo` is true, the Go resolver is used directly, bypassing systemd-resolved.

### Darwin (macOS) Variant

On macOS, the local transport uses DHCP-discovered DNS servers or the system resolver with special handling for `.local` domains (mDNS).

## DHCP Transport

The DHCP transport discovers DNS servers dynamically via DHCPv4:

### Discovery

The transport sends DHCPv4 Discover/Request on the specified network interface and extracts DNS server addresses from the DHCP Offer/Ack.

### Interface Monitoring

DNS servers are cached per-interface and refreshed when:
- The interface state changes (link up/down)
- The interface address changes
- The cache expires

### Server Caching

```go
type Transport struct {
    dns.TransportAdapter
    ctx           context.Context
    logger        logger.ContextLogger
    interfaceName string
    autoInterface bool
    // ...
    transportAccess sync.Mutex
    transports      []adapter.DNSTransport
    lastUpdate      time.Time
}
```

The DHCP transport creates child transports (typically UDP) for each discovered DNS server and delegates queries to them.

## Configuration

### Hosts

```json
{
  "dns": {
    "servers": [
      {
        "tag": "hosts",
        "type": "hosts",
        "path": ["/etc/hosts", "/custom/hosts"],
        "predefined": {
          "myserver.local": ["192.168.1.100"]
        }
      }
    ]
  }
}
```

### Local

```json
{
  "dns": {
    "servers": [
      {
        "tag": "local",
        "type": "local",
        "prefer_go": false
      }
    ]
  }
}
```

### DHCP

```json
{
  "dns": {
    "servers": [
      {
        "tag": "dhcp",
        "type": "dhcp",
        "interface": "eth0"
      }
    ]
  }
}
```
