# 自定义选项类型

sing-box 在 `option` 包中定义了多个自定义类型用于配置解析。这些类型处理人类可读的 JSON 值与内部 Go 表示之间的转换。

**源码**：`option/types.go`、`option/inbound.go`、`option/outbound.go`、`option/udp_over_tcp.go`

## NetworkList

接受单个网络字符串或数组，内部以换行符分隔的字符串存储：

```go
type NetworkList string

func (v *NetworkList) UnmarshalJSON(content []byte) error {
    // 接受："tcp" 或 ["tcp", "udp"]
    // 有效值："tcp"、"udp"
    // 存储为 "tcp\nudp"
}

func (v NetworkList) Build() []string {
    // 如果为空则返回 ["tcp", "udp"]（默认：两者都有）
    return strings.Split(string(v), "\n")
}
```

**JSON 示例**：
```json
"tcp"
["tcp", "udp"]
```

## DomainStrategy

在策略字符串名称和内部常量之间映射：

```go
type DomainStrategy C.DomainStrategy

// 映射：
//   ""              -> DomainStrategyAsIS
//   "as_is"         -> DomainStrategyAsIS
//   "prefer_ipv4"   -> DomainStrategyPreferIPv4
//   "prefer_ipv6"   -> DomainStrategyPreferIPv6
//   "ipv4_only"     -> DomainStrategyIPv4Only
//   "ipv6_only"     -> DomainStrategyIPv6Only
```

**JSON 示例**：
```json
""
"prefer_ipv4"
"ipv6_only"
```

## DNSQueryType

以数值或标准字符串名称处理 DNS 查询类型（通过 `miekg/dns` 库）：

```go
type DNSQueryType uint16

func (t *DNSQueryType) UnmarshalJSON(bytes []byte) error {
    // 接受：28 或 "AAAA"
    // 使用 mDNS.StringToType 和 mDNS.TypeToString 进行转换
}

func (t DNSQueryType) MarshalJSON() ([]byte, error) {
    // 如果已知则输出字符串名称，否则输出数值
}
```

**JSON 示例**：
```json
"A"
"AAAA"
28
```

## NetworkStrategy

将网络策略字符串名称映射到内部常量：

```go
type NetworkStrategy C.NetworkStrategy

func (n *NetworkStrategy) UnmarshalJSON(content []byte) error {
    // 使用 C.StringToNetworkStrategy 查找映射
}
```

## InterfaceType

表示网络接口类型（WIFI、Cellular、Ethernet、Other）：

```go
type InterfaceType C.InterfaceType

func (t InterfaceType) Build() C.InterfaceType {
    return C.InterfaceType(t)
}

func (t *InterfaceType) UnmarshalJSON(content []byte) error {
    // 使用 C.StringToInterfaceType 查找映射
}
```

**JSON 示例**：
```json
"wifi"
"cellular"
"ethernet"
```

## UDPTimeoutCompat

处理向后兼容的 UDP 超时值 -- 接受原始数字（秒）或时长字符串：

```go
type UDPTimeoutCompat badoption.Duration

func (c *UDPTimeoutCompat) UnmarshalJSON(data []byte) error {
    // 首先尝试：解析为整数（秒）
    var valueNumber int64
    err := json.Unmarshal(data, &valueNumber)
    if err == nil {
        *c = UDPTimeoutCompat(time.Second * time.Duration(valueNumber))
        return nil
    }
    // 回退：解析为时长字符串（如 "5m"）
    return json.Unmarshal(data, (*badoption.Duration)(c))
}
```

**JSON 示例**：
```json
300
"5m"
"30s"
```

## DomainResolveOptions

支持简写（仅服务器名称）或完整对象：

```go
type DomainResolveOptions struct {
    Server       string
    Strategy     DomainStrategy
    DisableCache bool
    RewriteTTL   *uint32
    ClientSubnet *badoption.Prefixable
}

func (o *DomainResolveOptions) UnmarshalJSON(bytes []byte) error {
    // 尝试字符串："dns-server-tag"
    // 回退到完整对象
}

func (o DomainResolveOptions) MarshalJSON() ([]byte, error) {
    // 如果仅设置了 Server，序列化为字符串
    // 否则序列化为对象
}
```

**JSON 示例**：
```json
"my-dns-server"

{
  "server": "my-dns-server",
  "strategy": "ipv4_only",
  "disable_cache": true,
  "rewrite_ttl": 300,
  "client_subnet": "1.2.3.0/24"
}
```

## UDPOverTCPOptions

支持简写布尔值或完整对象：

```go
type UDPOverTCPOptions struct {
    Enabled bool  `json:"enabled,omitempty"`
    Version uint8 `json:"version,omitempty"`
}

func (o *UDPOverTCPOptions) UnmarshalJSON(bytes []byte) error {
    // 尝试 bool：true/false
    // 回退到完整对象
}

func (o UDPOverTCPOptions) MarshalJSON() ([]byte, error) {
    // 如果版本是默认值（0 或当前版本），序列化为 bool
    // 否则序列化为对象
}
```

**JSON 示例**：
```json
true

{
  "enabled": true,
  "version": 2
}
```

## Listable[T]（来自 badoption）

不在 `option/types.go` 中定义，但在整个代码中广泛使用。`badoption.Listable[T]` 接受单个值或数组：

```go
type Listable[T any] []T

func (l *Listable[T]) UnmarshalJSON(content []byte) error {
    // 先尝试数组，然后单个值
}
```

**JSON 示例**：
```json
"value"
["value1", "value2"]

443
[443, 8443]
```

## Duration（来自 badoption）

`badoption.Duration` 包装 `time.Duration`，支持 JSON 字符串解析：

```go
type Duration time.Duration

func (d *Duration) UnmarshalJSON(bytes []byte) error {
    // 解析 Go 时长字符串："5s"、"1m30s"、"24h"
}
```

**JSON 示例**：
```json
"30s"
"5m"
"24h"
"1h30m"
```

## Addr（来自 badoption）

`badoption.Addr` 包装 `netip.Addr`，支持 JSON 字符串解析：

**JSON 示例**：
```json
"127.0.0.1"
"::1"
"0.0.0.0"
```

## Prefix（来自 badoption）

`badoption.Prefix` 包装 `netip.Prefix`，用于 CIDR 表示法：

**JSON 示例**：
```json
"198.18.0.0/15"
"fc00::/7"
```

## Prefixable（来自 badoption）

`badoption.Prefixable` 扩展前缀解析，接受裸地址（视为 /32 或 /128）：

**JSON 示例**：
```json
"192.168.1.0/24"
"192.168.1.1"
```

## FwMark

`FwMark` 用于 Linux 路由标记（`SO_MARK`）。它在 option 包的其他位置定义，接受整数值：

**JSON 示例**：
```json
255
```

## 重新实现注意事项

1. **简写模式**：许多类型同时支持简单形式（字符串/布尔值）和完整对象形式。反序列化应先尝试简单形式，然后回退到复杂形式
2. **Listable[T]**：这是使用最频繁的自定义类型。配置中几乎所有数组字段都接受单个值和数组
3. **时长解析**：使用 Go 的 `time.ParseDuration` 格式，支持：`ns`、`us`/`\u00b5s`、`ms`、`s`、`m`、`h`
4. **DNS 查询类型**：`miekg/dns` 库的 `StringToType` 映射提供 `"AAAA"` 等名称和 `28` 等数值之间的规范映射
5. **NetworkList**：内部以换行符分隔的存储是实现细节 -- 重新实现可以使用简单的字符串切片
6. **UDPTimeoutCompat**：双重数字/字符串解析是为了向后兼容使用普通秒数的旧配置
