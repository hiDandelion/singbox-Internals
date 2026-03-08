# GeoIP 和 GeoSite 数据库

sing-box 支持两种旧版地理数据库格式用于基于 IP 和域名的路由：GeoIP（MaxMind MMDB 格式）和 GeoSite（自定义二进制格式）。这些正在被更新的规则集系统取代，但为向后兼容仍然支持。

**源码**：`common/geoip/`、`common/geosite/`、`option/route.go`

## GeoIP（MaxMind MMDB）

### 概述

GeoIP 使用修改版的 MaxMind MMDB 数据库，数据库类型标识符为 `sing-geoip`（不是标准的 MaxMind `GeoLite2-Country`）。这是一个专门构建的数据库，将 IP 地址直接映射到国家代码。

### Reader 实现

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

关键点：
- **数据库类型验证**：仅接受类型为 `sing-geoip` 的数据库，拒绝标准 MaxMind 数据库
- **语言代码**：通过 `database.Metadata.Languages` 返回可用的国家代码列表
- **查找**：将 `netip.Addr` 直接映射到国家代码字符串；未找到时返回 `"unknown"`

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

### MMDB 格式

MMDB 格式是为高效 IP 前缀查找设计的二进制 trie 结构。`maxminddb-golang` 库负责解析。对于 `sing-geoip` 变体：
- 数据区段存储简单的字符串值（国家代码）而非嵌套结构
- 元数据区段使用 `Languages` 存储可用国家代码列表
- 通过 trie 结构同时支持 IPv4 和 IPv6 地址

### 配置

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

## GeoSite（自定义二进制格式）

### 概述

GeoSite 是一种自定义二进制数据库格式，将类别代码（如 `google`、`category-ads-all`）映射到域名规则列表。每条域名规则有一个类型（精确匹配、后缀、关键词、正则）和一个值。

### 文件结构

```
[uint8: version (0)]
[uvarint: entry_count]
  [uvarint: code_length] [bytes: code_string]
  [uvarint: byte_offset]
  [uvarint: item_count]
  ...
[域名项目数据...]
```

文件包含两个区段：
1. **元数据区段**：一个将类别代码映射到字节偏移量和项目计数的索引
2. **数据区段**：实际的域名项目，连续存储

### 项目类型

```go
type ItemType = uint8

const (
    RuleTypeDomain        ItemType = 0  // 精确域名匹配
    RuleTypeDomainSuffix  ItemType = 1  // 域名后缀匹配（如 ".google.com"）
    RuleTypeDomainKeyword ItemType = 2  // 域名包含关键词
    RuleTypeDomainRegex   ItemType = 3  // 正则表达式匹配
)

type Item struct {
    Type  ItemType
    Value string
}
```

### Reader 实现

```go
type Reader struct {
    access         sync.Mutex
    reader         io.ReadSeeker
    bufferedReader *bufio.Reader
    metadataIndex  int64           // 数据区段的起始字节偏移
    domainIndex    map[string]int  // 代码 -> 数据区段中的字节偏移
    domainLength   map[string]int  // 代码 -> 项目数量
}
```

读取器分两个阶段运作：
1. **`readMetadata()`**：打开时读取整个索引，构建从代码到偏移量/长度的映射
2. **`Read(code)`**：定位到数据区段中该代码的偏移位置并按需读取项目

```go
func (r *Reader) Read(code string) ([]Item, error) {
    index, exists := r.domainIndex[code]
    if !exists {
        return nil, E.New("code ", code, " not exists!")
    }
    _, err := r.reader.Seek(r.metadataIndex+int64(index), io.SeekStart)
    // ... 读取项目
}
```

数据区段中每个项目的存储格式为：
```
[uint8: item_type]
[uvarint: value_length] [bytes: value_string]
```

### Writer 实现

Writer 先在内存中构建数据区段以计算偏移量：

```go
func Write(writer varbin.Writer, domains map[string][]Item) error {
    // 1. 按字母顺序排序代码
    // 2. 将所有项目写入缓冲区，记录每个代码的字节偏移
    // 3. 写入版本字节 (0)
    // 4. 写入条目数量
    // 5. 对每个代码：写入代码字符串、字节偏移、项目计数
    // 6. 写入缓冲的项目数据
}
```

### 编译为规则

GeoSite 项目被编译为 sing-box 规则选项：

```go
func Compile(code []Item) option.DefaultRule {
    // 将每个 ItemType 映射到对应的规则字段：
    //   RuleTypeDomain        -> rule.Domain
    //   RuleTypeDomainSuffix  -> rule.DomainSuffix
    //   RuleTypeDomainKeyword -> rule.DomainKeyword
    //   RuleTypeDomainRegex   -> rule.DomainRegex
}
```

多个编译后的规则可以通过 `Merge()` 合并，它连接所有域名列表。

### 配置

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

## 在规则中的使用方式

在路由规则中，GeoIP 和 GeoSite 引用的使用方式如下：

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

路由器在启动时加载数据库，读取请求的代码，并将它们编译为内存中的规则匹配器。GeoIP 代码产生 IP CIDR 规则；GeoSite 代码产生域名/关键词/正则规则。

## 迁移到规则集

GeoIP 和 GeoSite 被视为旧版功能。推荐的迁移路径是使用 SRS 规则集，它：
- 支持更多规则类型（端口、进程、网络条件）
- 有更好的更新机制（带 ETag 的 HTTP、文件监视）
- 允许内联定义，无需外部文件
- 使用带 zlib 压缩的更紧凑二进制格式

## 重新实现注意事项

1. **GeoIP**：依赖 `github.com/oschwald/maxminddb-golang` 进行 MMDB 解析。MMDB 格式文档齐全，多种语言都有实现。唯一的 sing-box 特定方面是 `sing-geoip` 数据库类型检查
2. **GeoSite**：使用带 uvarint 编码的自定义二进制格式。格式实现简单：读取索引，定位到正确偏移，读取项目
3. **线程安全**：GeoSite 读取器使用互斥锁，因为它在多次调用间共享可定位的读取器和缓冲读取器。重新实现可以使用逐次调用的读取器（如果数据足够小可以缓存在内存中）
4. **字节偏移追踪**：`readCounter` 包装器追踪元数据区段消耗了多少字节，通过 `reader.Buffered()` 补偿缓冲读取器的预读
