# Hosts 和 Local DNS 传输层

源码：`dns/transport/hosts/hosts.go`、`dns/transport/hosts/hosts_file.go`、`dns/transport/local/local.go`、`dns/transport/dhcp/dhcp.go`

## Hosts Transport

Hosts 传输层根据 hosts 文件条目和预定义映射解析域名。

### 结构

```go
type Transport struct {
    dns.TransportAdapter
    files      []*File
    predefined map[string][]netip.Addr
}
```

### 查找优先级

1. **预定义条目**优先检查（配置中的内联映射）
2. **Hosts 文件**按顺序检查

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

仅处理 A 和 AAAA 查询。无法解析的域名返回 NXDOMAIN。非地址查询同样返回 NXDOMAIN。

### 构造

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

域名通过 `mDNS.CanonicalName` 进行规范化（转小写，FQDN 格式带尾部点号）。

### Hosts 文件解析

`File` 结构体提供带缓存的延迟解析：

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

**缓存失效**：仅在以下条件同时满足时重新解析文件：
- 距上次检查已过去 5 秒以上，且
- 文件的修改时间或大小已变化

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

**解析规则**：
- 以 `#` 开头的行为注释
- 每行格式：`<IP> <主机名1> [主机名2] ...`
- 主机名经过规范化处理（转小写 + 尾部点号）
- 同时支持 IPv4 和 IPv6 地址
- 同一主机名的多个条目会被累加

### 默认路径

```go
// Linux/macOS
var DefaultPath = "/etc/hosts"

// Windows
var DefaultPath = `C:\Windows\System32\drivers\etc\hosts`
```

## Local DNS Transport

Local 传输层使用系统解析器解析 DNS 查询。

### 结构（非 Darwin）

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

### 解析优先级

1. **systemd-resolved**（仅 Linux）：如果系统使用 resolved，查询通过 D-Bus 发送
2. **本地 hosts 文件**：在网络解析之前检查
3. **系统解析器**：回退到 Go 的 `net.Resolver`

```go
func (t *Transport) Exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    // 1. 尝试 systemd-resolved
    if t.resolved != nil {
        resolverObject := t.resolved.Object()
        if resolverObject != nil {
            return t.resolved.Exchange(resolverObject, ctx, message)
        }
    }
    // 2. 尝试本地 hosts 文件
    if question.Qtype == mDNS.TypeA || question.Qtype == mDNS.TypeAAAA {
        addresses := t.hosts.Lookup(dns.FqdnToDomain(question.Name))
        if len(addresses) > 0 {
            return dns.FixedResponse(message.Id, question, addresses, C.DefaultDNSTTL), nil
        }
    }
    // 3. 系统解析器
    return t.exchange(ctx, message, question.Name)
}
```

### systemd-resolved 检测

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

如果 `preferGo` 为 true，则直接使用 Go 解析器，绕过 systemd-resolved。

### Darwin（macOS）变体

在 macOS 上，Local 传输层使用 DHCP 发现的 DNS 服务器或系统解析器，并对 `.local` 域名（mDNS）进行特殊处理。

## DHCP Transport

DHCP 传输层通过 DHCPv4 动态发现 DNS 服务器：

### 发现

传输层在指定的网络接口上发送 DHCPv4 Discover/Request，并从 DHCP Offer/Ack 中提取 DNS 服务器地址。

### 接口监控

DNS 服务器按接口缓存，并在以下情况刷新：
- 接口状态变化（链路 up/down）
- 接口地址变化
- 缓存过期

### 服务器缓存

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

DHCP 传输层为每个发现的 DNS 服务器创建子传输层（通常是 UDP），并将查询委派给它们。

## 配置

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
