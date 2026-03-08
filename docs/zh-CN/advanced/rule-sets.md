# 规则集

规则集提供可复用的路由规则集合，可以从内联定义、本地文件或远程 URL 加载。它们是旧版 GeoIP/GeoSite 数据库的现代替代方案。

**源码**：`common/srs/`、`route/rule/rule_set.go`、`route/rule/rule_set_local.go`、`route/rule/rule_set_remote.go`、`option/rule_set.go`

## SRS 二进制格式

SRS（Sing-box Rule Set）格式是规则集的紧凑二进制表示，旨在实现高效加载并减小文件大小（相比 JSON 源文件）。

### 文件结构

```
+--------+--------+------------------------------+
| Magic  | Version| zlib 压缩的规则数据            |
| 3 字节  | 1 字节 |                              |
+--------+--------+------------------------------+
```

```go
var MagicBytes = [3]byte{0x53, 0x52, 0x53} // ASCII "SRS"
```

### 版本历史

| 版本 | 常量 | 新特性 |
|------|------|--------|
| 1 | `RuleSetVersion1` | 初始格式 |
| 2 | `RuleSetVersion2` | AdGuard 域名规则 |
| 3 | `RuleSetVersion3` | `network_type`、`network_is_expensive`、`network_is_constrained` |
| 4 | `RuleSetVersion4` | `network_interface_address`、`default_interface_address` |

### 读取流程

```go
func Read(reader io.Reader, recover bool) (PlainRuleSetCompat, error) {
    // 1. 读取并验证 3 字节魔数头 "SRS"
    // 2. 读取 1 字节版本号（大端序 uint8）
    // 3. 打开 zlib 解压读取器
    // 4. 读取 uvarint 获取规则数量
    // 5. 顺序读取每条规则
}
```

`recover` 标志控制是否将二进制优化结构（如域名匹配器和 IP 集合）展开回人类可读形式（字符串列表）。这在将 `.srs` 反编译回 JSON 时使用。

### 压缩数据布局

在 4 字节头之后，所有后续数据都经过 zlib 压缩（最佳压缩级别）。解压流内部结构：

```
[uvarint: rule_count]
[rule_0]
[rule_1]
...
[rule_N]
```

### 规则编码

每条规则以一个 `uint8` 规则类型字节开头：

| 类型字节 | 含义 |
|----------|------|
| `0` | 默认规则（扁平条件） |
| `1` | 逻辑规则（子规则的 AND/OR） |

#### 默认规则项

默认规则是由类型化项目组成的序列，以 `0xFF` 结尾：

```
[uint8: 0x00 (默认规则)]
[uint8: item_type] [item_data...]
[uint8: item_type] [item_data...]
...
[uint8: 0xFF (结束)]
[bool: invert]
```

项目类型常量：

```go
const (
    ruleItemQueryType              uint8 = 0   // []uint16（大端序）
    ruleItemNetwork                uint8 = 1   // []string
    ruleItemDomain                 uint8 = 2   // domain.Matcher 二进制
    ruleItemDomainKeyword          uint8 = 3   // []string
    ruleItemDomainRegex            uint8 = 4   // []string
    ruleItemSourceIPCIDR           uint8 = 5   // IPSet 二进制
    ruleItemIPCIDR                 uint8 = 6   // IPSet 二进制
    ruleItemSourcePort             uint8 = 7   // []uint16（大端序）
    ruleItemSourcePortRange        uint8 = 8   // []string
    ruleItemPort                   uint8 = 9   // []uint16（大端序）
    ruleItemPortRange              uint8 = 10  // []string
    ruleItemProcessName            uint8 = 11  // []string
    ruleItemProcessPath            uint8 = 12  // []string
    ruleItemPackageName            uint8 = 13  // []string
    ruleItemWIFISSID               uint8 = 14  // []string
    ruleItemWIFIBSSID              uint8 = 15  // []string
    ruleItemAdGuardDomain          uint8 = 16  // AdGuardMatcher 二进制（v2+）
    ruleItemProcessPathRegex       uint8 = 17  // []string
    ruleItemNetworkType            uint8 = 18  // []uint8（v3+）
    ruleItemNetworkIsExpensive     uint8 = 19  // 无数据（v3+）
    ruleItemNetworkIsConstrained   uint8 = 20  // 无数据（v3+）
    ruleItemNetworkInterfaceAddress uint8 = 21 // TypedMap（v4+）
    ruleItemDefaultInterfaceAddress uint8 = 22 // []Prefix（v4+）
    ruleItemFinal                  uint8 = 0xFF
)
```

#### 字符串数组编码

```
[uvarint: count]
  [uvarint: string_length] [bytes: string_data]
  ...
```

#### uint16 数组编码

```
[uvarint: count]
[uint16 大端序] [uint16 大端序] ...
```

#### IP 集合编码

IP 集合以范围而非 CIDR 前缀存储，以获得更紧凑的表示：

```
[uint8: version（必须为 1）]
[uint64 大端序: range_count]
  [uvarint: from_addr_length] [bytes: from_addr]
  [uvarint: to_addr_length]   [bytes: to_addr]
  ...
```

实现使用 `unsafe.Pointer` 直接重新解释 `netipx.IPSet` 的内部结构（以 `{from, to}` 对存储 IP 范围）。IPv4 地址为 4 字节；IPv6 地址为 16 字节。

#### IP 前缀编码

单个前缀（用于 v4+ 网络接口地址规则）：

```
[uvarint: addr_byte_length]
[bytes: addr_bytes]
[uint8: prefix_bits]
```

#### 逻辑规则编码

```
[uint8: 0x01 (逻辑规则)]
[uint8: mode]  // 0 = AND，1 = OR
[uvarint: sub_rule_count]
[sub_rule_0]
[sub_rule_1]
...
[bool: invert]
```

## 规则集类型

### 工厂函数

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

### 本地规则集

`LocalRuleSet` 处理内联规则（嵌入在配置 JSON 中）和基于文件的规则集。

```go
type LocalRuleSet struct {
    ctx        context.Context
    logger     logger.Logger
    tag        string
    access     sync.RWMutex
    rules      []adapter.HeadlessRule
    metadata   adapter.RuleSetMetadata
    fileFormat string              // "source"（JSON）或 "binary"（SRS）
    watcher    *fswatch.Watcher    // 文件变更监视器
    callbacks  list.List[adapter.RuleSetUpdateCallback]
    refs       atomic.Int32        // 引用计数
}
```

关键行为：
- **内联模式**：规则在构造时从 `options.InlineOptions.Rules` 解析
- **文件模式**：规则从 `options.LocalOptions.Path` 加载，并设置 `fswatch.Watcher` 用于文件变更时自动重新加载
- **格式自动检测**：文件扩展名 `.json` 选择源格式；`.srs` 选择二进制格式
- **热重载**：当监视器检测到变更时，`reloadFile()` 重新读取并解析文件，然后通知所有注册的回调

### 远程规则集

`RemoteRuleSet` 从 URL 下载规则集，支持定期自动更新。

```go
type RemoteRuleSet struct {
    ctx            context.Context
    cancel         context.CancelFunc
    logger         logger.ContextLogger
    outbound       adapter.OutboundManager
    options        option.RuleSet
    updateInterval time.Duration    // 默认：24 小时
    dialer         N.Dialer
    access         sync.RWMutex
    rules          []adapter.HeadlessRule
    metadata       adapter.RuleSetMetadata
    lastUpdated    time.Time
    lastEtag       string           // 用于条件请求的 HTTP ETag
    updateTicker   *time.Ticker
    cacheFile      adapter.CacheFile
    pauseManager   pause.Manager
    callbacks      list.List[adapter.RuleSetUpdateCallback]
    refs           atomic.Int32
}
```

关键行为：
- **缓存持久化**：启动时从 `adapter.CacheFile`（bbolt 数据库）加载缓存内容。如果存在缓存数据，则直接使用而不下载
- **ETag 支持**：使用 HTTP `If-None-Match` / `304 Not Modified` 避免重新下载未变更的规则集
- **下载绕行**：可通过指定的出站（例如使用代理获取规则集）路由下载流量
- **更新循环**：在 `PostStart()` 之后，在 goroutine 中运行 `loopUpdate()`，按 `updateInterval` 检查更新
- **内存管理**：更新后，如果 `refs == 0`（无活跃的规则引用），解析后的规则会被设为 `nil` 以释放内存，并显式调用 `runtime.GC()`

## 引用计数

`LocalRuleSet` 和 `RemoteRuleSet` 都通过 `atomic.Int32` 实现引用计数：

```go
func (s *LocalRuleSet) IncRef()  { s.refs.Add(1) }
func (s *LocalRuleSet) DecRef()  {
    if s.refs.Add(-1) < 0 {
        panic("rule-set: negative refs")
    }
}
func (s *LocalRuleSet) Cleanup() {
    if s.refs.Load() == 0 {
        s.rules = nil  // 无引用时释放内存
    }
}
```

这允许路由器追踪哪些规则集正被路由规则活跃使用，并为未使用的规则集释放内存。

## 规则集元数据

加载规则后，会计算元数据以确定需要哪些类型的查找：

```go
type RuleSetMetadata struct {
    ContainsProcessRule bool  // 需要进程搜索器
    ContainsWIFIRule    bool  // 需要 WIFI 状态
    ContainsIPCIDRRule  bool  // 需要已解析的 IP 地址
}
```

这些标志允许路由器在没有规则集需要时跳过昂贵的操作（如进程名查找或 DNS 解析）。

## IP 集合提取

规则集支持通过 `ExtractIPSet()` 将所有 IP CIDR 项目提取为 `netipx.IPSet` 值。这用于系统级优化，如 TUN 路由表配置，其中基于 IP 的规则需要在网络栈层面而非逐连接应用。

## 配置

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

## 重新实现注意事项

1. SRS 二进制格式使用 Go 的 `encoding/binary` 大端序字节序和 `binary.ReadUvarint`/`varbin.WriteUvarint` 用于变长整数
2. 域名匹配使用 `sing/common/domain.Matcher`，它有自己的二进制序列化格式 -- 这是一个需要实现或导入的依赖
3. IP 集合二进制格式使用 `unsafe.Pointer` 直接操作 `netipx.IPSet` 内部 -- 重新实现应使用正确的 IP 范围序列化
4. zlib 压缩使用 `zlib.BestCompression` 压缩级别写入
5. 格式自动检测检查文件扩展名：`.json` = 源格式，`.srs` = 二进制格式
6. 远程规则集的基于 ETag 的缓存必须处理 `200 OK`（新内容）和 `304 Not Modified`（仅更新时间戳）两种情况
