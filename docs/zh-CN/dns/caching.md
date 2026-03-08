# DNS 缓存与响应处理

源码：`dns/client.go`、`dns/client_truncate.go`、`dns/client_log.go`、`dns/extension_edns0_subnet.go`、`dns/rcode.go`、`experimental/cachefile/rdrc.go`、`experimental/cachefile/cache.go`、`common/compatible/map.go`

## 缓存架构

DNS 客户端使用 `freelru`（来自 `github.com/sagernet/sing/contrab/freelru` 的分片 LRU 缓存）进行响应缓存。提供两种互斥的缓存模式：

```go
type Client struct {
    timeout            time.Duration
    disableCache       bool
    disableExpire      bool
    independentCache   bool
    clientSubnet       netip.Prefix
    rdrc               adapter.RDRCStore
    initRDRCFunc       func() adapter.RDRCStore
    logger             logger.ContextLogger
    cache              freelru.Cache[dns.Question, *dns.Msg]
    cacheLock          compatible.Map[dns.Question, chan struct{}]
    transportCache     freelru.Cache[transportCacheKey, *dns.Msg]
    transportCacheLock compatible.Map[dns.Question, chan struct{}]
}
```

### 共享缓存（默认）

以 `dns.Question`（Name + Qtype + Qclass）为键。所有传输层共享相同的缓存命名空间，这意味着传输层 A 的缓存响应可以服务于原本要发给传输层 B 的查询。

### 独立缓存

当 `independentCache` 为 true 时，缓存以 `transportCacheKey` 为键：

```go
type transportCacheKey struct {
    dns.Question
    transportTag string
}
```

每个传输层拥有自己的缓存命名空间，防止跨传输层的缓存命中。当不同传输层对同一域名返回不同结果时（例如国内 DNS 与国外 DNS 返回不同的 IP），这一点很重要。

### 初始化

```go
func NewClient(options ClientOptions) *Client {
    cacheCapacity := options.CacheCapacity
    if cacheCapacity < 1024 {
        cacheCapacity = 1024
    }
    if !client.disableCache {
        if !client.independentCache {
            client.cache = common.Must1(freelru.NewSharded[dns.Question, *dns.Msg](
                cacheCapacity, maphash.NewHasher[dns.Question]().Hash32))
        } else {
            client.transportCache = common.Must1(freelru.NewSharded[transportCacheKey, *dns.Msg](
                cacheCapacity, maphash.NewHasher[transportCacheKey]().Hash32))
        }
    }
}
```

最小容量为 1024 个条目。`freelru.NewSharded` 构造函数创建一个分片 LRU 缓存，哈希函数由 `maphash.NewHasher` 生成。根据 `independentCache` 标志，只会创建两个缓存（`cache` 或 `transportCache`）中的一个。

## 缓存去重

客户端使用基于 channel 的锁机制（通过 `compatible.Map`，一个 `sync.Map` 的泛型包装器）防止并发相同查询导致的惊群效应：

```go
if c.cache != nil {
    cond, loaded := c.cacheLock.LoadOrStore(question, make(chan struct{}))
    if loaded {
        // 另一个 goroutine 正在查询此问题
        select {
        case <-cond:           // 等待正在进行的查询完成
        case <-ctx.Done():     // 或 context 取消
            return nil, ctx.Err()
        }
    } else {
        // 此 goroutine 赢得竞争；完成时清理
        defer func() {
            c.cacheLock.Delete(question)
            close(cond)  // 通知所有等待者
        }()
    }
}
```

机制工作方式如下：

1. `LoadOrStore` 原子地检查此问题是否已存在 channel
2. 如果 `loaded` 为 true，表示另一个 goroutine 正在执行查询。当前 goroutine 阻塞在 channel 上
3. 如果 `loaded` 为 false，当前 goroutine 继续执行查询。完成后删除条目并关闭 channel，解除所有等待者的阻塞
4. 等待者被解除阻塞后，进入 `loadResponse` 获取现已缓存的结果

当独立缓存模式激活时，`transportCacheLock` 使用相同的模式。

## 可缓存性判定

不是所有 DNS 消息都会被缓存。请求只有在是"简单请求"时才可缓存：

```go
isSimpleRequest := len(message.Question) == 1 &&
    len(message.Ns) == 0 &&
    (len(message.Extra) == 0 || len(message.Extra) == 1 &&
        message.Extra[0].Header().Rrtype == dns.TypeOPT &&
        message.Extra[0].Header().Class > 0 &&
        message.Extra[0].Header().Ttl == 0 &&
        len(message.Extra[0].(*dns.OPT).Option) == 0) &&
    !options.ClientSubnet.IsValid()

disableCache := !isSimpleRequest || c.disableCache || options.DisableCache
```

简单请求的条件是：
- 恰好一个问题
- 无权威记录
- 无额外记录（或恰好一个无选项、正 UDP 大小、零扩展 rcode 的 OPT 记录）
- 无逐查询的客户端子网覆盖

此外，除 SUCCESS 和 NXDOMAIN 之外的错误码响应永远不会被缓存：

```go
disableCache = disableCache || (response.Rcode != dns.RcodeSuccess && response.Rcode != dns.RcodeNameError)
```

## 缓存存储

```go
func (c *Client) storeCache(transport adapter.DNSTransport, question dns.Question, message *dns.Msg, timeToLive uint32) {
    if timeToLive == 0 {
        return
    }
    if c.disableExpire {
        if !c.independentCache {
            c.cache.Add(question, message)
        } else {
            c.transportCache.Add(transportCacheKey{
                Question:     question,
                transportTag: transport.Tag(),
            }, message)
        }
    } else {
        if !c.independentCache {
            c.cache.AddWithLifetime(question, message, time.Second*time.Duration(timeToLive))
        } else {
            c.transportCache.AddWithLifetime(transportCacheKey{
                Question:     question,
                transportTag: transport.Tag(),
            }, message, time.Second*time.Duration(timeToLive))
        }
    }
}
```

关键行为：
- TTL 为零的响应永远不会被缓存
- 当 `disableExpire` 为 true 时，条目不设置生命周期（仅在被 LRU 淘汰时移除）
- 当 `disableExpire` 为 false 时，条目根据响应的 TTL 过期

## 缓存检索与 TTL 调整

加载缓存响应时，TTL 会被调整以反映已经过去的时间：

```go
func (c *Client) loadResponse(question dns.Question, transport adapter.DNSTransport) (*dns.Msg, int) {
    if c.disableExpire {
        // 不过期：原样返回缓存响应（已复制）
        response, loaded = c.cache.Get(question)
        if !loaded { return nil, 0 }
        return response.Copy(), 0
    }

    // 带过期：获取带生命周期信息的条目
    response, expireAt, loaded = c.cache.GetWithLifetime(question)
    if !loaded { return nil, 0 }

    // 手动过期检查（双重保险）
    timeNow := time.Now()
    if timeNow.After(expireAt) {
        c.cache.Remove(question)
        return nil, 0
    }

    // 计算剩余 TTL
    var originTTL int
    for _, recordList := range [][]dns.RR{response.Answer, response.Ns, response.Extra} {
        for _, record := range recordList {
            if originTTL == 0 || record.Header().Ttl > 0 && int(record.Header().Ttl) < originTTL {
                originTTL = int(record.Header().Ttl)
            }
        }
    }
    nowTTL := int(expireAt.Sub(timeNow).Seconds())
    if nowTTL < 0 { nowTTL = 0 }

    response = response.Copy()
    if originTTL > 0 {
        duration := uint32(originTTL - nowTTL)
        for _, recordList := range [][]dns.RR{response.Answer, response.Ns, response.Extra} {
            for _, record := range recordList {
                record.Header().Ttl = record.Header().Ttl - duration
            }
        }
    } else {
        for _, recordList := range [][]dns.RR{response.Answer, response.Ns, response.Extra} {
            for _, record := range recordList {
                record.Header().Ttl = uint32(nowTTL)
            }
        }
    }
    return response, nowTTL
}
```

TTL 调整逻辑：
1. 在所有记录中查找最小 TTL（`originTTL`）-- 这是条目存储时的 TTL
2. 计算 `nowTTL` 为距过期还剩的秒数
3. 计算 `duration = originTTL - nowTTL`（自缓存以来经过的时间）
4. 从每条记录的 TTL 中减去 `duration`，使客户端看到随时间递减的 TTL
5. 如果 `originTTL` 为 0（所有记录的 TTL 都是零），将所有 TTL 设置为剩余生命周期

响应在返回前总是会被 `.Copy()` 复制，以防止调用者修改缓存条目。

## TTL 归一化

在缓存之前，响应中所有记录的 TTL 会被归一化为单一值：

```go
var timeToLive uint32
if len(response.Answer) == 0 {
    // 否定响应：使用 SOA 最小 TTL
    if soaTTL, hasSOA := extractNegativeTTL(response); hasSOA {
        timeToLive = soaTTL
    }
}
if timeToLive == 0 {
    // 在所有区段中查找最小 TTL
    for _, recordList := range [][]dns.RR{response.Answer, response.Ns, response.Extra} {
        for _, record := range recordList {
            if timeToLive == 0 || record.Header().Ttl > 0 && record.Header().Ttl < timeToLive {
                timeToLive = record.Header().Ttl
            }
        }
    }
}
if options.RewriteTTL != nil {
    timeToLive = *options.RewriteTTL
}
// 对所有记录应用统一的 TTL
for _, recordList := range [][]dns.RR{response.Answer, response.Ns, response.Extra} {
    for _, record := range recordList {
        record.Header().Ttl = timeToLive
    }
}
```

### 否定 TTL 提取

对于无应答记录的 NXDOMAIN 响应，TTL 从权威区段的 SOA 记录中提取：

```go
func extractNegativeTTL(response *dns.Msg) (uint32, bool) {
    for _, record := range response.Ns {
        if soa, isSOA := record.(*dns.SOA); isSOA {
            soaTTL := soa.Header().Ttl
            soaMinimum := soa.Minttl
            if soaTTL < soaMinimum {
                return soaTTL, true
            }
            return soaMinimum, true
        }
    }
    return 0, false
}
```

该函数返回 `min(soa.Header().Ttl, soa.Minttl)`，遵循 RFC 2308 关于否定缓存的指导。

## Lookup 缓存快速路径

`Lookup` 方法（域名到地址）有一个快速路径，在构造完整 DNS 消息之前先检查缓存：

```go
func (c *Client) lookupToExchange(ctx context.Context, transport adapter.DNSTransport,
    name string, qType uint16, options adapter.DNSQueryOptions,
    responseChecker func(responseAddrs []netip.Addr) bool) ([]netip.Addr, error) {
    question := dns.Question{Name: name, Qtype: qType, Qclass: dns.ClassINET}
    disableCache := c.disableCache || options.DisableCache
    if !disableCache {
        cachedAddresses, err := c.questionCache(question, transport)
        if err != ErrNotCached {
            return cachedAddresses, err
        }
    }
    // ... 继续执行完整的 Exchange
}

func (c *Client) questionCache(question dns.Question, transport adapter.DNSTransport) ([]netip.Addr, error) {
    response, _ := c.loadResponse(question, transport)
    if response == nil {
        return nil, ErrNotCached
    }
    if response.Rcode != dns.RcodeSuccess {
        return nil, RcodeError(response.Rcode)
    }
    return MessageToAddresses(response), nil
}
```

这绕过了去重机制，直接检查缓存。如果存在缓存的 NXDOMAIN 响应，它会返回相应的 `RcodeError` 而无需发出网络请求。

## RDRC（响应域名拒绝缓存）

RDRC 缓存被地址限制规则拒绝的域名/查询类型/传输层组合。这避免了反复查询已知会返回不可接受地址的传输层。

### Interface

```go
type RDRCStore interface {
    LoadRDRC(transportName string, qName string, qType uint16) (rejected bool)
    SaveRDRC(transportName string, qName string, qType uint16) error
    SaveRDRCAsync(transportName string, qName string, qType uint16, logger logger.Logger)
}
```

### 初始化

RDRC 存储在客户端启动时从缓存文件延迟初始化：

```go
func (c *Client) Start() {
    if c.initRDRCFunc != nil {
        c.rdrc = c.initRDRCFunc()
    }
}
```

在路由器中，初始化函数检查缓存文件是否支持 RDRC：

```go
RDRC: func() adapter.RDRCStore {
    cacheFile := service.FromContext[adapter.CacheFile](ctx)
    if cacheFile == nil {
        return nil
    }
    if !cacheFile.StoreRDRC() {
        return nil
    }
    return cacheFile
},
```

### 存储后端（bbolt）

RDRC 使用 bbolt（BoltDB 的 fork）持久化，存储在名为 `"rdrc2"` 的 bucket 中：

```go
var bucketRDRC = []byte("rdrc2")
```

#### 键格式

键为 `[2 字节查询类型（大端序）][查询名称字节]`，存储在以传输层标签命名的子 bucket 下：

```go
key := buf.Get(2 + len(qName))
binary.BigEndian.PutUint16(key, qType)
copy(key[2:], qName)
```

#### 值格式

值为 8 字节 Unix 时间戳（大端序），表示过期时间：

```go
expiresAt := buf.Get(8)
binary.BigEndian.PutUint64(expiresAt, uint64(time.Now().Add(c.rdrcTimeout).Unix()))
return bucket.Put(key, expiresAt)
```

### 默认超时

RDRC 条目默认在 7 天后过期：

```go
if options.StoreRDRC {
    if options.RDRCTimeout > 0 {
        rdrcTimeout = time.Duration(options.RDRCTimeout)
    } else {
        rdrcTimeout = 7 * 24 * time.Hour
    }
}
```

### 带内存缓存的异步保存

为避免磁盘写入阻塞查询路径，RDRC 条目通过内存预写缓存异步保存：

```go
type CacheFile struct {
    // ...
    saveRDRCAccess sync.RWMutex
    saveRDRC       map[saveRDRCCacheKey]bool
}

func (c *CacheFile) SaveRDRCAsync(transportName string, qName string, qType uint16, logger logger.Logger) {
    saveKey := saveRDRCCacheKey{transportName, qName, qType}
    c.saveRDRCAccess.Lock()
    c.saveRDRC[saveKey] = true        // 立即对读取可见
    c.saveRDRCAccess.Unlock()
    go func() {
        err := c.SaveRDRC(transportName, qName, qType)    // 持久化到 bbolt
        if err != nil {
            logger.Warn("save RDRC: ", err)
        }
        c.saveRDRCAccess.Lock()
        delete(c.saveRDRC, saveKey)   // 从预写缓存中移除
        c.saveRDRCAccess.Unlock()
    }()
}
```

加载时，先检查内存缓存再读取 bbolt：

```go
func (c *CacheFile) LoadRDRC(transportName string, qName string, qType uint16) (rejected bool) {
    c.saveRDRCAccess.RLock()
    rejected, cached := c.saveRDRC[saveRDRCCacheKey{transportName, qName, qType}]
    c.saveRDRCAccess.RUnlock()
    if cached {
        return
    }
    // 回退到 bbolt 读取...
}
```

### 过期处理

从 bbolt 加载时，过期条目会被检测到并延迟清理：

```go
content := bucket.Get(key)
expiresAt := time.Unix(int64(binary.BigEndian.Uint64(content)), 0)
if time.Now().After(expiresAt) {
    deleteCache = true   // 标记为删除
    return nil           // 未被拒绝
}
rejected = true
```

删除操作在单独的 `Update` 事务中进行，以避免在写入期间持有读事务锁。

### 与 Exchange 的集成

RDRC 在缓存去重之后、传输层交换之前进行检查：

```go
if !disableCache && responseChecker != nil && c.rdrc != nil {
    rejected := c.rdrc.LoadRDRC(transport.Tag(), question.Name, question.Qtype)
    if rejected {
        return nil, ErrResponseRejectedCached
    }
}
```

在响应被地址限制检查器拒绝时进行保存：

```go
if rejected {
    if !disableCache && c.rdrc != nil {
        c.rdrc.SaveRDRCAsync(transport.Tag(), question.Name, question.Qtype, c.logger)
    }
    return response, ErrResponseRejected
}
```

路由器的重试循环使用 `ErrResponseRejected` 和 `ErrResponseRejectedCached` 来跳到下一个匹配的规则。

## EDNS0 客户端子网

客户端在交换之前将 EDNS0 客户端子网（ECS）选项注入到 DNS 消息中：

```go
clientSubnet := options.ClientSubnet
if !clientSubnet.IsValid() {
    clientSubnet = c.clientSubnet      // 回退到全局设置
}
if clientSubnet.IsValid() {
    message = SetClientSubnet(message, clientSubnet)
}
```

### 实现

```go
func SetClientSubnet(message *dns.Msg, clientSubnet netip.Prefix) *dns.Msg {
    return setClientSubnet(message, clientSubnet, true)
}

func setClientSubnet(message *dns.Msg, clientSubnet netip.Prefix, clone bool) *dns.Msg {
    var (
        optRecord    *dns.OPT
        subnetOption *dns.EDNS0_SUBNET
    )
    // 查找已有的 OPT 记录和 EDNS0_SUBNET 选项
    for _, record := range message.Extra {
        if optRecord, isOPTRecord = record.(*dns.OPT); isOPTRecord {
            for _, option := range optRecord.Option {
                subnetOption, isEDNS0Subnet = option.(*dns.EDNS0_SUBNET)
                if isEDNS0Subnet { break }
            }
        }
    }
    // 如果未找到则创建 OPT 记录
    if optRecord == nil {
        exMessage := *message
        message = &exMessage
        optRecord = &dns.OPT{Hdr: dns.RR_Header{Name: ".", Rrtype: dns.TypeOPT}}
        message.Extra = append(message.Extra, optRecord)
    } else if clone {
        return setClientSubnet(message.Copy(), clientSubnet, false)
    }
    // 创建或更新子网选项
    if subnetOption == nil {
        subnetOption = new(dns.EDNS0_SUBNET)
        subnetOption.Code = dns.EDNS0SUBNET
        optRecord.Option = append(optRecord.Option, subnetOption)
    }
    if clientSubnet.Addr().Is4() {
        subnetOption.Family = 1
    } else {
        subnetOption.Family = 2
    }
    subnetOption.SourceNetmask = uint8(clientSubnet.Bits())
    subnetOption.Address = clientSubnet.Addr().AsSlice()
    return message
}
```

关键细节：
- 首次调用使用 `clone = true`，如果已存在 OPT 记录则复制消息（避免修改原始消息）
- 如果不存在 OPT 记录，则对消息进行浅复制并附加新的 OPT 记录
- Family 1 = IPv4，Family 2 = IPv6
- 设置了逐查询客户端子网（`options.ClientSubnet.IsValid()`）的消息不会被缓存

### EDNS0 版本降级

收到响应后，客户端处理 EDNS0 版本不匹配：

```go
requestEDNSOpt := message.IsEdns0()
responseEDNSOpt := response.IsEdns0()
if responseEDNSOpt != nil && (requestEDNSOpt == nil || requestEDNSOpt.Version() < responseEDNSOpt.Version()) {
    response.Extra = common.Filter(response.Extra, func(it dns.RR) bool {
        return it.Header().Rrtype != dns.TypeOPT
    })
    if requestEDNSOpt != nil {
        response.SetEdns0(responseEDNSOpt.UDPSize(), responseEDNSOpt.Do())
    }
}
```

如果响应的 EDNS0 版本高于请求（或请求没有 EDNS0），OPT 记录会被剥离并可选地替换为版本兼容的记录。

## DNS 消息截断

对于超过最大消息大小的 UDP DNS 响应，会尊重 EDNS0 进行截断：

```go
func TruncateDNSMessage(request *dns.Msg, response *dns.Msg, headroom int) (*buf.Buffer, error) {
    maxLen := 512
    if edns0Option := request.IsEdns0(); edns0Option != nil {
        if udpSize := int(edns0Option.UDPSize()); udpSize > 512 {
            maxLen = udpSize
        }
    }
    responseLen := response.Len()
    if responseLen > maxLen {
        response = response.Copy()
        response.Truncate(maxLen)
    }
    buffer := buf.NewSize(headroom*2 + 1 + responseLen)
    buffer.Resize(headroom, 0)
    rawMessage, err := response.PackBuffer(buffer.FreeBytes())
    if err != nil {
        buffer.Release()
        return nil, err
    }
    buffer.Truncate(len(rawMessage))
    return buffer, nil
}
```

- 默认最大值为 512 字节（标准 DNS UDP 限制）
- 如果请求包含 EDNS0 OPT 记录且带有更大的 UDP 大小，则使用该大小
- 截断操作在副本上进行，以避免修改缓存的响应
- 缓冲区包含用于协议帧（如 UDP 头）的预留空间

## 缓存清除

```go
func (c *Client) ClearCache() {
    if c.cache != nil {
        c.cache.Purge()
    } else if c.transportCache != nil {
        c.transportCache.Purge()
    }
}
```

在网络变化时由路由器调用：

```go
func (r *Router) ResetNetwork() {
    r.ClearCache()
    for _, transport := range r.transport.Transports() {
        transport.Reset()
    }
}

func (r *Router) ClearCache() {
    r.client.ClearCache()
    if r.platformInterface != nil {
        r.platformInterface.ClearDNSCache()
    }
}
```

如果有可用的平台 interface，这也会清除平台级别的 DNS 缓存（例如 Android/iOS 上的缓存）。

## 策略过滤

在任何缓存或传输层交互之前，与域名策略冲突的查询会立即返回空的成功响应：

```go
if question.Qtype == dns.TypeA && options.Strategy == C.DomainStrategyIPv6Only ||
   question.Qtype == dns.TypeAAAA && options.Strategy == C.DomainStrategyIPv4Only {
    return FixedResponseStatus(message, dns.RcodeSuccess), nil
}
```

这避免了不匹配查询类型产生不必要的缓存条目和网络往返。

## HTTPS 记录过滤

对于 HTTPS（SVCB 类型 65）查询，地址提示根据域名策略进行过滤：

```go
if question.Qtype == dns.TypeHTTPS {
    if options.Strategy == C.DomainStrategyIPv4Only || options.Strategy == C.DomainStrategyIPv6Only {
        for _, rr := range response.Answer {
            https, isHTTPS := rr.(*dns.HTTPS)
            if !isHTTPS { continue }
            content := https.SVCB
            content.Value = common.Filter(content.Value, func(it dns.SVCBKeyValue) bool {
                if options.Strategy == C.DomainStrategyIPv4Only {
                    return it.Key() != dns.SVCB_IPV6HINT
                } else {
                    return it.Key() != dns.SVCB_IPV4HINT
                }
            })
            https.SVCB = content
        }
    }
}
```

IPv4-only 策略移除 IPv6 提示；IPv6-only 策略移除 IPv4 提示。此过滤在传输层交换之后但缓存之前进行，因此缓存的 HTTPS 响应已经过过滤。

## 循环检测

DNS 查询循环通过在 context 中标记当前传输层来检测：

```go
contextTransport, loaded := transportTagFromContext(ctx)
if loaded && transport.Tag() == contextTransport {
    return nil, E.New("DNS query loopback in transport[", contextTransport, "]")
}
ctx = contextWithTransportTag(ctx, transport.Tag())
```

这防止了传输层需要解析其服务器主机名时的无限递归（例如 `dns.example.com` 的 DoH 传输层试图通过自身解析 `dns.example.com`）。

## 日志

三个日志函数为 DNS 事件提供结构化输出：

```go
func logCachedResponse(logger, ctx, response, ttl)    // "cached example.com NOERROR 42"
func logExchangedResponse(logger, ctx, response, ttl)  // "exchanged example.com NOERROR 300"
func logRejectedResponse(logger, ctx, response)         // "rejected A example.com 1.2.3.4"
```

每个函数在 DEBUG 级别记录域名，在 INFO 级别记录各条记录。`FormatQuestion` 辅助函数通过去除分号、合并空白和修剪来规范化 miekg/dns 记录字符串。

## 错误类型

```go
type RcodeError int

const (
    RcodeSuccess     RcodeError = mDNS.RcodeSuccess
    RcodeFormatError RcodeError = mDNS.RcodeFormatError
    RcodeNameError   RcodeError = mDNS.RcodeNameError
    RcodeRefused     RcodeError = mDNS.RcodeRefused
)

func (e RcodeError) Error() string {
    return mDNS.RcodeToString[int(e)]
}
```

哨兵错误：
- `ErrNoRawSupport` -- 传输层不支持原始 DNS 消息
- `ErrNotCached` -- 缓存未命中（由 `questionCache` 内部使用）
- `ErrResponseRejected` -- 响应未通过地址限制检查
- `ErrResponseRejectedCached` -- 扩展自 `ErrResponseRejected`，表示拒绝来自 RDRC

## 配置

```json
{
  "dns": {
    "client_options": {
      "disable_cache": false,
      "disable_expire": false,
      "independent_cache": false,
      "cache_capacity": 1024,
      "client_subnet": "1.2.3.0/24"
    }
  },
  "experimental": {
    "cache_file": {
      "enabled": true,
      "path": "cache.db",
      "store_rdrc": true,
      "rdrc_timeout": "168h"
    }
  }
}
```

| 字段 | 默认值 | 描述 |
|------|--------|------|
| `disable_cache` | `false` | 禁用所有 DNS 响应缓存 |
| `disable_expire` | `false` | 缓存条目永不过期（仅在 LRU 淘汰时移除） |
| `independent_cache` | `false` | 每个传输层使用独立的缓存命名空间 |
| `cache_capacity` | `1024` | 最大缓存条目数（最小 1024） |
| `client_subnet` | 无 | 默认的 EDNS0 客户端子网前缀 |
| `store_rdrc` | `false` | 启用 RDRC 持久化到缓存文件 |
| `rdrc_timeout` | `168h`（7 天） | RDRC 条目过期时长 |
