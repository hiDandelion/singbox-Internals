# Clash API

Clash API 提供兼容 Clash 仪表板 UI（如 Yacd、Metacubexd）的 RESTful HTTP 接口。它暴露代理管理、连接追踪、流量统计、配置管理、日志流、DNS 缓存操作等功能。

**源码**：`experimental/clashapi/`

## 注册

Clash API 服务器通过 `init()` 函数注册，受 `with_clash_api` 构建标签保护：

```go
// clashapi.go（with_clash_api 构建标签）
func init() {
    experimental.RegisterClashServerConstructor(NewServer)
}

// clashapi_stub.go（!with_clash_api 构建标签）
func init() {
    experimental.RegisterClashServerConstructor(func(...) (adapter.ClashServer, error) {
        return nil, E.New(`clash api is not included in this build, rebuild with -tags with_clash_api`)
    })
}
```

## 服务器架构

```go
type Server struct {
    ctx            context.Context
    router         adapter.Router
    dnsRouter      adapter.DNSRouter
    outbound       adapter.OutboundManager
    endpoint       adapter.EndpointManager
    logger         log.Logger
    httpServer     *http.Server
    trafficManager *trafficontrol.Manager
    urlTestHistory adapter.URLTestHistoryStorage

    mode           string
    modeList       []string
    modeUpdateHook *observable.Subscriber[struct{}]

    externalController       bool
    externalUI               string
    externalUIDownloadURL    string
    externalUIDownloadDetour string
}
```

### HTTP 路由器（chi）

服务器使用 `go-chi/chi` 进行路由，配合 CORS 中间件：

```
GET  /              -> hello（或重定向到 /ui/）
GET  /logs          -> WebSocket/SSE 日志流
GET  /traffic       -> WebSocket/SSE 流量统计
GET  /version       -> {"version": "sing-box X.Y.Z", "premium": true, "meta": true}
     /configs       -> GET、PUT、PATCH 配置
     /proxies       -> GET 列表、GET/PUT 单个代理、GET 延迟测试
     /rules         -> GET 路由规则
     /connections   -> GET 列表、DELETE 关闭所有、DELETE 按 ID 关闭
     /providers/proxies -> 代理提供者（stub）
     /providers/rules   -> 规则提供者（stub）
     /script        -> 脚本（stub）
     /profile       -> 配置文件（stub）
     /cache         -> 缓存操作
     /dns           -> DNS 操作
     /ui/*          -> 外部 UI 的静态文件服务
```

### 认证

通过 `secret` 配置选项进行 Bearer token 认证：

```go
func authentication(serverSecret string) func(next http.Handler) http.Handler {
    // 检查 "Authorization: Bearer <token>" 头
    // WebSocket 连接可以使用 ?token=<token> 查询参数
    // 如果 serverSecret 为空，则允许所有请求
}
```

## 连接追踪

### 流量管理器

```go
type Manager struct {
    uploadTotal   atomic.Int64
    downloadTotal atomic.Int64
    connections   compatible.Map[uuid.UUID, Tracker]

    closedConnectionsAccess sync.Mutex
    closedConnections       list.List[TrackerMetadata]  // 上限 1000
    memory                  uint64

    eventSubscriber *observable.Subscriber[ConnectionEvent]
}
```

管理器追踪：
- **全局上传/下载总量**通过原子计数器
- **活跃连接**存储在以 UUID 为键的并发映射中
- **最近关闭的连接**存储在有上限的列表中（最多 1000 个条目）
- **内存使用**通过 `runtime.ReadMemStats`

### Tracker 包装

当连接被路由时，Clash 服务器用追踪层包装它：

```go
func (s *Server) RoutedConnection(ctx, conn, metadata, matchedRule, matchOutbound) net.Conn {
    return trafficontrol.NewTCPTracker(conn, s.trafficManager, metadata, ...)
}
```

Tracker：
1. 为连接生成一个 UUID v4
2. 解析出站链（跟随组选择找到最终出站）
3. 使用 `bufio.NewCounterConn` 包装连接，双向计数字节
4. 通过 `manager.Join(tracker)` 注册到管理器
5. 关闭时调用 `manager.Leave(tracker)` 并将元数据存入已关闭连接列表

### TrackerMetadata JSON

连接元数据为 API 进行序列化：

```go
func (t TrackerMetadata) MarshalJSON() ([]byte, error) {
    return json.Marshal(map[string]any{
        "id": t.ID,
        "metadata": map[string]any{
            "network":         t.Metadata.Network,
            "type":            inbound,        // "inboundType/inboundTag"
            "sourceIP":        source.Addr,
            "destinationIP":   dest.Addr,
            "sourcePort":      source.Port,
            "destinationPort": dest.Port,
            "host":            domain,
            "dnsMode":         "normal",
            "processPath":     processPath,
        },
        "upload":   t.Upload.Load(),
        "download": t.Download.Load(),
        "start":    t.CreatedAt,
        "chains":   t.Chain,     // 反转的出站链
        "rule":     rule,
        "rulePayload": "",
    })
}
```

## 流量流式传输

`/traffic` 端点通过 WebSocket 或分块 HTTP 流式传输每秒流量增量：

```go
func traffic(ctx, trafficManager) http.HandlerFunc {
    // 每 1 秒：
    // 1. 读取当前总上传/下载量
    // 2. 计算与上次读取的差值
    // 3. 发送 JSON：{"up": delta_up, "down": delta_down}
}
```

## 日志流式传输

`/logs` 端点流式传输带级别过滤的日志条目：

```go
func getLogs(logFactory) http.HandlerFunc {
    // 接受 ?level=info|debug|warn|error
    // 订阅可观察的日志工厂
    // 流式传输 JSON：{"type": "info", "payload": "log message"}
    // 支持 WebSocket 和分块 HTTP
}
```

## 模式切换

sing-box 实现 Clash 风格的模式切换（Rule、Global、Direct 等）：

```go
func (s *Server) SetMode(newMode string) {
    // 1. 验证模式在 modeList 中（不区分大小写）
    // 2. 更新 s.mode
    // 3. 发送模式更新钩子（通知订阅者）
    // 4. 清除 DNS 缓存
    // 5. 持久化到缓存文件
    // 6. 记录变更日志
}
```

模式持久化在 bbolt 缓存文件的 `clash_mode` bucket 中，以缓存 ID 为键。

## 代理管理

### GET /proxies

返回所有出站和端点及其元数据：

```go
func proxyInfo(server, detour) *badjson.JSONObject {
    // type:    Clash 显示名称（如 "Shadowsocks"、"VMess"）
    // name:    出站标签
    // udp:     是否支持 UDP
    // history: URL 测试延迟历史
    // now:     当前选择（对于组）
    // all:     可用成员（对于组）
}
```

始终添加一个合成的 `GLOBAL` 代理组，包含所有非系统出站，默认出站列在最前面。

### PUT /proxies/{name}

更新 `Selector` 组的选定出站：

```go
func updateProxy(w, r) {
    selector, ok := proxy.(*group.Selector)
    selector.SelectOutbound(req.Name)
}
```

### GET /proxies/{name}/delay

执行带可配置超时的 URL 测试：

```go
func getProxyDelay(server) http.HandlerFunc {
    // 读取 ?url=...&timeout=... 查询参数
    // 调用 urltest.URLTest(ctx, url, proxy)
    // 返回 {"delay": ms} 或错误
    // 将结果存入 URL 测试历史
}
```

## Provider Interface

代理提供者（`/providers/proxies`）和规则提供者（`/providers/rules`）是 stub -- 它们返回空结果或 404。这保持了与期望这些端点存在的 Clash 仪表板的 API 兼容性。

## 快照 API

`/connections` 端点返回所有活跃连接的快照：

```go
type Snapshot struct {
    Download    int64
    Upload      int64
    Connections []Tracker
    Memory      uint64    // 来自 runtime.MemStats
}
```

快照端点还支持 WebSocket 用于实时更新，可配置轮询间隔（`?interval=1000`，单位为毫秒）。

## 配置

```json
{
  "experimental": {
    "clash_api": {
      "external_controller": "127.0.0.1:9090",
      "external_ui": "ui",
      "external_ui_download_url": "",
      "external_ui_download_detour": "",
      "secret": "my-secret",
      "default_mode": "Rule",
      "access_control_allow_origin": ["*"],
      "access_control_allow_private_network": false
    }
  }
}
```

## 启动生命周期

服务器分两个阶段启动：

1. **`StartStateStart`**：从缓存文件加载持久化的模式
2. **`StartStateStarted`**：如需下载外部 UI，启动 HTTP 监听器（对 Android `EADDRINUSE` 有重试逻辑）

## 重新实现注意事项

1. API 设计用于兼容 Clash 仪表板（Yacd、Metacubexd）。响应格式必须与这些仪表板期望的完全匹配
2. WebSocket 支持至关重要 -- 流量、日志和连接都使用 WebSocket 进行实时流式传输
3. `"premium": true, "meta": true` 版本响应标志在仪表板中启用额外功能
4. 连接追踪包装每个被路由的连接/包连接，添加逐连接的字节计数器
5. 已关闭连接列表上限为 1000 个条目（FIFO 淘汰）
6. 内存统计来自 `runtime.ReadMemStats`，包括栈、已使用堆和空闲堆
7. DNS 操作和缓存清除通过 `/dns` 和 `/cache` 路由暴露
