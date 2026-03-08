# 缓存文件

缓存文件使用 bbolt（嵌入式 B+ 树）数据库为各种运行时状态提供持久化存储。它持久化 FakeIP 映射、选定的出站选择、Clash 模式、远程规则集内容以及被拒绝的 DNS 响应缓存（RDRC）。

**源码**：`experimental/cachefile/`

## 架构

```go
type CacheFile struct {
    ctx               context.Context
    path              string
    cacheID           []byte           // 可选的命名空间前缀
    storeFakeIP       bool
    storeRDRC         bool
    rdrcTimeout       time.Duration    // 默认：7 天
    DB                *bbolt.DB

    // 异步写入缓冲区
    saveMetadataTimer *time.Timer
    saveFakeIPAccess  sync.RWMutex
    saveDomain        map[netip.Addr]string
    saveAddress4      map[string]netip.Addr
    saveAddress6      map[string]netip.Addr
    saveRDRCAccess    sync.RWMutex
    saveRDRC          map[saveRDRCCacheKey]bool
}
```

## Bucket 结构

数据库使用多个顶级 bucket：

| Bucket 名称 | 键 | 描述 |
|-------------|-----|------|
| `selected` | 组标签 | Selector 组的选定出站 |
| `group_expand` | 组标签 | UI 展开/折叠状态 |
| `clash_mode` | 缓存 ID | 当前 Clash API 模式 |
| `rule_set` | 规则集标签 | 缓存的远程规则集内容 |
| `rdrc2` | 传输层名称（子 bucket） | 被拒绝的 DNS 响应缓存 |
| `fakeip_address` | IP 字节 | FakeIP 地址到域名映射 |
| `fakeip_domain4` | 域名字符串 | FakeIP 域名到 IPv4 映射 |
| `fakeip_domain6` | 域名字符串 | FakeIP 域名到 IPv6 映射 |
| `fakeip_metadata` | 固定键 | FakeIP 分配器状态 |

### 缓存 ID 命名空间

配置了 `cache_id` 后，大多数 bucket 嵌套在以缓存 ID 为前缀的顶级 bucket 下（字节 `0x00` + 缓存 ID 字节）。这允许多个 sing-box 实例共享同一个数据库文件：

```go
func (c *CacheFile) bucket(t *bbolt.Tx, key []byte) *bbolt.Bucket {
    if c.cacheID == nil {
        return t.Bucket(key)
    }
    bucket := t.Bucket(c.cacheID)  // 命名空间 bucket
    if bucket == nil {
        return nil
    }
    return bucket.Bucket(key)  // 命名空间内的实际 bucket
}
```

## 启动与恢复

```go
func (c *CacheFile) Start(stage adapter.StartStage) error {
    // 仅在 StartStateInitialize 阶段运行
    // 1. 以 1 秒超时打开 bbolt，最多重试 10 次
    // 2. 损坏时（ErrInvalid、ErrChecksum、ErrVersionMismatch）：
    //    删除文件并重试
    // 3. 清理未知 bucket（垃圾收集）
    // 4. 通过平台 chown 设置文件所有权
}
```

数据库有自修复机制 -- 如果在访问期间检测到损坏，会删除并重新创建文件：

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

所有数据库访问方法（`view`、`batch`、`update`）都用 panic 恢复包装操作，在损坏时触发 `resetDB()`。

## 选定出站缓存

持久化 Selector 出站组的用户选择：

```go
func (c *CacheFile) LoadSelected(group string) string
func (c *CacheFile) StoreSelected(group, selected string) error
```

由 Selector 出站组使用，在重启后记住用户选择了哪个出站。

## Clash 模式缓存

```go
func (c *CacheFile) LoadMode() string
func (c *CacheFile) StoreMode(mode string) error
```

持久化当前的 Clash API 模式（"Rule"、"Global"、"Direct"），使其在重启后保留。

## 规则集缓存

远程规则集与其内容、上次更新时间和 HTTP ETag 一起缓存：

```go
func (c *CacheFile) LoadRuleSet(tag string) *adapter.SavedBinary
func (c *CacheFile) SaveRuleSet(tag string, set *adapter.SavedBinary) error
```

`SavedBinary` 结构体包含：
- `Content []byte` -- 原始规则集数据（JSON 或 SRS 二进制）
- `LastUpdated time.Time` -- 上次成功获取的时间
- `LastEtag string` -- 用于条件请求的 HTTP ETag

## FakeIP 缓存

FakeIP 维护虚拟 IP 地址和域名之间的双向映射。

### 存储布局

三个 bucket 协同工作：
- `fakeip_address`：`IP 字节 -> 域名字符串`（反向查找）
- `fakeip_domain4`：`域名 -> IPv4 字节`（正向查找，IPv4）
- `fakeip_domain6`：`域名 -> IPv6 字节`（正向查找，IPv6）

### 写操作

```go
func (c *CacheFile) FakeIPStore(address netip.Addr, domain string) error {
    // 1. 读取此地址的旧域名（如果有）
    // 2. 存储 地址 -> 域名
    // 3. 删除旧的 域名 -> 地址 映射
    // 4. 存储新的 域名 -> 地址 映射
}
```

### 异步写入优化

FakeIP 写入对性能要求很高，因此提供了异步缓冲层：

```go
func (c *CacheFile) FakeIPStoreAsync(address netip.Addr, domain string, logger) {
    // 1. 在内存映射中缓冲映射
    // 2. 启动 goroutine 持久化到 bbolt
    // 3. 读操作先检查内存缓冲区
}
```

内存缓冲区（`saveDomain`、`saveAddress4`、`saveAddress6`）在回退到数据库之前被 `FakeIPLoad` 和 `FakeIPLoadDomain` 检查，确保异步写入期间的一致性。

### 元数据持久化

FakeIP 分配器元数据（当前分配指针）使用防抖定时器保存：

```go
func (c *CacheFile) FakeIPSaveMetadataAsync(metadata *adapter.FakeIPMetadata) {
    // 使用 time.AfterFunc 配合 FakeIPMetadataSaveInterval
    // 每次调用时重置定时器以批量处理快速分配
}
```

## RDRC（被拒绝的 DNS 响应缓存）

RDRC 缓存被拒绝的 DNS 响应（例如空响应或被阻止的响应），避免对已知被阻止的域名重复查找。

### 存储键

```go
type saveRDRCCacheKey struct {
    TransportName string
    QuestionName  string
    QType         uint16
}
```

在数据库中，键为 `[uint16 大端序: qtype][域名字符串]`，嵌套在以 DNS 传输层命名的子 bucket 下。

### 过期处理

每个 RDRC 条目存储一个过期时间戳：

```go
func (c *CacheFile) LoadRDRC(transportName, qName string, qType uint16) (rejected bool) {
    // 1. 先检查内存异步缓冲区
    // 2. 从数据库读取
    // 3. 解析过期时间戳（uint64 大端序 Unix 秒）
    // 4. 如果过期，删除条目并返回 false
    // 5. 如果有效，返回 true（域名被拒绝）
}

func (c *CacheFile) SaveRDRC(transportName, qName string, qType uint16) error {
    // 存储，过期时间 = 当前时间 + rdrcTimeout（默认 7 天）
    // 键：[2 字节 qtype][域名字节]
    // 值：[8 字节过期 Unix 时间戳 大端序]
}
```

### 异步 RDRC 写入

与 FakeIP 类似，RDRC 写入在内存中缓冲以支持即时回读：

```go
func (c *CacheFile) SaveRDRCAsync(transportName, qName string, qType uint16, logger) {
    // 在 saveRDRC 映射中缓冲
    // 在 goroutine 中异步持久化
}
```

## 配置

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

## 重新实现注意事项

1. **bbolt** 是纯 Go 的嵌入式 B+ 树数据库（boltdb 的 fork）。任何支持 bucket/命名空间的嵌入式键值存储都可以作为替代（如 SQLite、LevelDB）
2. **损坏恢复**至关重要 -- 缓存文件可能因崩溃或断电而损坏。删除后重建的策略简单但有效
3. **异步写入缓冲**对 FakeIP 和 RDRC 的性能很重要。这些操作发生在每个 DNS 查询上，不能阻塞热路径
4. **缓存 ID 命名空间**允许多个实例共享一个数据库文件而不冲突
5. **FakeIP 双向映射**必须保持一致 -- 更新地址映射时，必须先删除旧的域名映射
6. **RDRC 超时**控制被拒绝的 DNS 响应的缓存时长。默认 7 天对于不经常变化的广告过滤规则集来说是合适的
7. `group_expand` bucket 存储单个字节（`0` 或 `1`）用于 Clash 仪表板中的 UI 状态 -- 这纯粹是外观持久化
