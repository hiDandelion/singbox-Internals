# FakeIP DNS 传输层

源码：`dns/transport/fakeip/fakeip.go`、`dns/transport/fakeip/store.go`、`dns/transport/fakeip/memory.go`

## 概述

FakeIP 为 DNS 查询从配置的地址范围中分配合成 IP 地址。它不会将域名解析为真实 IP，而是从池中分配一个唯一地址，并维护双向映射（域名 <-> IP）。当连接到 FakeIP 地址时，路由器会解析原始域名并连接到真实目的地。

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

仅支持 A 和 AAAA 查询。其他查询类型（MX、TXT 等）会返回错误。

该传输层实现了 `adapter.FakeIPTransport` interface，提供 `Store()` 方法用于直接访问 FakeIP 存储。

## Store

Store 管理 IP 分配和双向的域名/地址映射：

```go
type Store struct {
    ctx        context.Context
    logger     logger.Logger
    inet4Range netip.Prefix
    inet6Range netip.Prefix
    inet4Last  netip.Addr    // 广播地址（上界）
    inet6Last  netip.Addr
    storage    adapter.FakeIPStorage

    addressAccess sync.Mutex
    inet4Current  netip.Addr  // 最后分配的 IPv4
    inet6Current  netip.Addr  // 最后分配的 IPv6
}
```

### IP 分配

带回绕的顺序分配：

```go
func (s *Store) Create(domain string, isIPv6 bool) (netip.Addr, error) {
    // 检查域名是否已有地址
    if address, loaded := s.storage.FakeIPLoadDomain(domain, isIPv6); loaded {
        return address, nil
    }

    s.addressAccess.Lock()
    defer s.addressAccess.Unlock()

    // 加锁后再次检查
    if address, loaded := s.storage.FakeIPLoadDomain(domain, isIPv6); loaded {
        return address, nil
    }

    var address netip.Addr
    if !isIPv6 {
        nextAddress := s.inet4Current.Next()
        if nextAddress == s.inet4Last || !s.inet4Range.Contains(nextAddress) {
            nextAddress = s.inet4Range.Addr().Next().Next()  // 回绕，跳过网络地址和第一个地址
        }
        s.inet4Current = nextAddress
        address = nextAddress
    } else {
        // IPv6 相同逻辑
    }

    s.storage.FakeIPStore(address, domain)
    s.storage.FakeIPSaveMetadataAsync(&adapter.FakeIPMetadata{...})
    return address, nil
}
```

分配跳过网络地址和第一个主机地址（IPv4 中的 `.0` 和 `.1`），从第三个地址开始。当范围用尽时会回绕，回收之前使用的地址。

### 广播地址计算

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

通过将所有主机位设为 1 来计算广播地址。

### 持久化

Store 在启动时检查缓存文件：

```go
func (s *Store) Start() error {
    cacheFile := service.FromContext[adapter.CacheFile](s.ctx)
    if cacheFile != nil && cacheFile.StoreFakeIP() {
        storage = cacheFile
    }
    if storage == nil {
        storage = NewMemoryStorage()
    }
    // 如果范围匹配则恢复状态
    metadata := storage.FakeIPMetadata()
    if metadata != nil && metadata.Inet4Range == s.inet4Range && metadata.Inet6Range == s.inet6Range {
        s.inet4Current = metadata.Inet4Current
        s.inet6Current = metadata.Inet6Current
    } else {
        // 范围变化时重置
        s.inet4Current = s.inet4Range.Addr().Next()
        s.inet6Current = s.inet6Range.Addr().Next()
        storage.FakeIPReset()
    }
}
```

如果配置的范围发生变化，Store 会被重置。否则，分配从上次保存的位置继续。

关闭时保存元数据：

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

### 查找

```go
func (s *Store) Lookup(address netip.Addr) (string, bool) {
    return s.storage.FakeIPLoad(address)
}

func (s *Store) Contains(address netip.Addr) bool {
    return s.inet4Range.Contains(address) || s.inet6Range.Contains(address)
}
```

## 内存存储

使用双向映射的内存实现：

```go
type MemoryStorage struct {
    addressByDomain4 map[string]netip.Addr
    addressByDomain6 map[string]netip.Addr
    domainByAddress  map[netip.Addr]string
}
```

三个映射维护双向关系：
- `addressByDomain4`：域名 -> IPv4 地址
- `addressByDomain6`：域名 -> IPv6 地址
- `domainByAddress`：地址（v4 或 v6）-> 域名

### 带回收的存储

存储新的地址-域名映射时，会先移除同一地址的已有映射：

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

这处理了地址被回收分配给新域名的情况。

## 配置

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

| 字段 | 描述 |
|------|------|
| `inet4_range` | FakeIP 分配的 IPv4 CIDR 范围 |
| `inet6_range` | FakeIP 分配的 IPv6 CIDR 范围 |

典型范围使用 RFC 5737 文档地址（`198.18.0.0/15`）或 ULA 地址（`fc00::/18`）。
