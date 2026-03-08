# 配置结构

sing-box 使用基于 JSON 的配置格式，具有定义良好的根结构。配置解析利用上下文感知的 JSON 解码器和多态类型的类型注册表。

**源码**：`option/options.go`、`option/inbound.go`、`option/outbound.go`、`option/endpoint.go`、`option/dns.go`、`option/route.go`、`option/service.go`、`option/experimental.go`

## 根选项结构体

```go
type _Options struct {
    RawMessage   json.RawMessage      `json:"-"`
    Schema       string               `json:"$schema,omitempty"`
    Log          *LogOptions          `json:"log,omitempty"`
    DNS          *DNSOptions          `json:"dns,omitempty"`
    NTP          *NTPOptions          `json:"ntp,omitempty"`
    Certificate  *CertificateOptions  `json:"certificate,omitempty"`
    Endpoints    []Endpoint           `json:"endpoints,omitempty"`
    Inbounds     []Inbound            `json:"inbounds,omitempty"`
    Outbounds    []Outbound           `json:"outbounds,omitempty"`
    Route        *RouteOptions        `json:"route,omitempty"`
    Services     []Service            `json:"services,omitempty"`
    Experimental *ExperimentalOptions `json:"experimental,omitempty"`
}

type Options _Options
```

### 配置示例

```json
{
  "$schema": "https://sing-box.sagernet.org/schema.json",
  "log": {
    "level": "info"
  },
  "dns": {
    "servers": [...],
    "rules": [...]
  },
  "inbounds": [
    {"type": "tun", "tag": "tun-in", ...},
    {"type": "mixed", "tag": "mixed-in", ...}
  ],
  "outbounds": [
    {"type": "direct", "tag": "direct"},
    {"type": "vless", "tag": "proxy", ...},
    {"type": "selector", "tag": "select", ...}
  ],
  "endpoints": [
    {"type": "wireguard", "tag": "wg", ...}
  ],
  "route": {
    "rules": [...],
    "rule_set": [...],
    "final": "proxy"
  },
  "services": [
    {"type": "resolved", "tag": "resolved-dns", ...}
  ],
  "experimental": {
    "cache_file": {"enabled": true},
    "clash_api": {"external_controller": "127.0.0.1:9090"}
  }
}
```

## 验证

`Options.UnmarshalJSONContext` 方法执行验证：

```go
func (o *Options) UnmarshalJSONContext(ctx context.Context, content []byte) error {
    decoder := json.NewDecoderContext(ctx, bytes.NewReader(content))
    decoder.DisallowUnknownFields()  // 严格解析
    err := decoder.Decode((*_Options)(o))
    o.RawMessage = content
    return checkOptions(o)
}
```

解析后验证检查：
- **重复入站标签**：两个入站不能共享相同的标签
- **重复出站/端点标签**：出站和端点标签共享命名空间；不允许重复

```go
func checkInbounds(inbounds []Inbound) error {
    seen := make(map[string]bool)
    for i, inbound := range inbounds {
        tag := inbound.Tag
        if tag == "" { tag = F.ToString(i) }
        if seen[tag] { return E.New("duplicate inbound tag: ", tag) }
        seen[tag] = true
    }
    return nil
}
```

## 类型化的入站/出站/端点解析

入站、出站、端点、DNS 服务器和服务都使用相同的多态 JSON 解析模式：一个 `type` 字段选择将剩余字段解析到哪个选项结构体。

### 模式

每个类型化结构体有相同的结构：

```go
type _Inbound struct {
    Type    string `json:"type"`
    Tag     string `json:"tag,omitempty"`
    Options any    `json:"-"`          // 类型特定选项，不直接在 JSON 中
}
```

### 上下文感知的反序列化

反序列化使用 Go 的 `context.Context` 携带类型注册表：

```go
func (h *Inbound) UnmarshalJSONContext(ctx context.Context, content []byte) error {
    // 1. 解析 "type" 和 "tag" 字段
    err := json.UnmarshalContext(ctx, content, (*_Inbound)(h))

    // 2. 从 context 中查找选项注册表
    registry := service.FromContext[InboundOptionsRegistry](ctx)

    // 3. 为此类型创建类型化选项结构体
    options, loaded := registry.CreateOptions(h.Type)

    // 4. 将剩余字段（排除 type/tag）解析到类型化结构体中
    err = badjson.UnmarshallExcludedContext(ctx, content, (*_Inbound)(h), options)

    // 5. 存储解析后的选项
    h.Options = options
    return nil
}
```

`badjson.UnmarshallExcluded` 函数是关键 -- 它解析 JSON 对象同时排除已被另一个结构体解析的字段。这允许 `type` 和 `tag` 与协议特定选项分开处理。

### 注册表 Interface

```go
type InboundOptionsRegistry interface {
    CreateOptions(inboundType string) (any, bool)
}

type OutboundOptionsRegistry interface {
    CreateOptions(outboundType string) (any, bool)
}

type EndpointOptionsRegistry interface {
    CreateOptions(endpointType string) (any, bool)
}

type DNSTransportOptionsRegistry interface {
    CreateOptions(transportType string) (any, bool)
}

type ServiceOptionsRegistry interface {
    CreateOptions(serviceType string) (any, bool)
}
```

## DNS 选项

DNS 配置为向后兼容有双重结构：

```go
type DNSOptions struct {
    RawDNSOptions        // 当前格式
    LegacyDNSOptions     // 已弃用格式（自动升级）
}

type RawDNSOptions struct {
    Servers        []DNSServerOptions `json:"servers,omitempty"`
    Rules          []DNSRule          `json:"rules,omitempty"`
    Final          string             `json:"final,omitempty"`
    ReverseMapping bool               `json:"reverse_mapping,omitempty"`
    DNSClientOptions
}
```

DNS 服务器使用相同的类型化模式：

```go
type DNSServerOptions struct {
    Type    string `json:"type,omitempty"`
    Tag     string `json:"tag,omitempty"`
    Options any    `json:"-"`
}
```

旧版 DNS 服务器格式（基于 URL 的如 `tls://1.1.1.1`）在反序列化过程中自动升级为新的类型化格式。

## 路由选项

```go
type RouteOptions struct {
    GeoIP                      *GeoIPOptions
    Geosite                    *GeositeOptions
    Rules                      []Rule
    RuleSet                    []RuleSet
    Final                      string
    FindProcess                bool
    FindNeighbor               bool
    AutoDetectInterface        bool
    OverrideAndroidVPN         bool
    DefaultInterface           string
    DefaultMark                FwMark
    DefaultDomainResolver      *DomainResolveOptions
    DefaultNetworkStrategy     *NetworkStrategy
    DefaultNetworkType         badoption.Listable[InterfaceType]
    DefaultFallbackNetworkType badoption.Listable[InterfaceType]
    DefaultFallbackDelay       badoption.Duration
}
```

## 实验性选项

```go
type ExperimentalOptions struct {
    CacheFile *CacheFileOptions `json:"cache_file,omitempty"`
    ClashAPI  *ClashAPIOptions  `json:"clash_api,omitempty"`
    V2RayAPI  *V2RayAPIOptions  `json:"v2ray_api,omitempty"`
    Debug     *DebugOptions     `json:"debug,omitempty"`
}
```

## 日志选项

```go
type LogOptions struct {
    Disabled     bool   `json:"disabled,omitempty"`
    Level        string `json:"level,omitempty"`
    Output       string `json:"output,omitempty"`
    Timestamp    bool   `json:"timestamp,omitempty"`
    DisableColor bool   `json:"-"`      // 内部使用，不来自 JSON
}
```

## 通用选项类型

### ListenOptions（入站）

```go
type ListenOptions struct {
    Listen               *badoption.Addr
    ListenPort           uint16
    BindInterface        string
    RoutingMark          FwMark
    ReuseAddr            bool
    NetNs                string
    DisableTCPKeepAlive  bool
    TCPKeepAlive         badoption.Duration
    TCPKeepAliveInterval badoption.Duration
    TCPFastOpen          bool
    TCPMultiPath         bool
    UDPFragment          *bool
    UDPTimeout           UDPTimeoutCompat
    Detour               string
}
```

### DialerOptions（出站）

```go
type DialerOptions struct {
    Detour               string
    BindInterface        string
    Inet4BindAddress     *badoption.Addr
    Inet6BindAddress     *badoption.Addr
    ProtectPath          string
    RoutingMark          FwMark
    NetNs                string
    ConnectTimeout       badoption.Duration
    TCPFastOpen          bool
    TCPMultiPath         bool
    DomainResolver       *DomainResolveOptions
    NetworkStrategy      *NetworkStrategy
    NetworkType          badoption.Listable[InterfaceType]
    FallbackNetworkType  badoption.Listable[InterfaceType]
    FallbackDelay        badoption.Duration
}
```

### ServerOptions（出站）

```go
type ServerOptions struct {
    Server     string `json:"server"`
    ServerPort uint16 `json:"server_port"`
}

func (o ServerOptions) Build() M.Socksaddr {
    return M.ParseSocksaddrHostPort(o.Server, o.ServerPort)
}
```

## 重新实现注意事项

1. **上下文感知的 JSON 解析**是设计的核心。`context.Context` 携带启动时注入的类型注册表，使多态解析无需反射或代码生成
2. **`badjson.UnmarshallExcluded`** 是一个自定义 JSON 解析器，允许两个结构体共享同一个 JSON 对象，在它们之间分割字段。这就是 `type`/`tag` 如何与协议选项分离的
3. **`DisallowUnknownFields`** 已启用，使解析器严格 -- 字段名拼写错误会导致解析错误
4. **旧版迁移**在反序列化过程中内联处理（如旧版 DNS 服务器 URL、已弃用的入站字段）。`dontUpgrade` context 标志允许序列化往返而不触发迁移
5. **验证**在解析时是最小的 -- 仅检查标签唯一性。语义验证（如必填字段、有效地址）在服务构造期间进行
6. **`RawMessage`** 存储在根 `Options` 上，以允许重新序列化或转发原始配置
