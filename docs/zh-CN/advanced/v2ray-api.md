# V2Ray API

V2Ray API 提供基于 gRPC 的统计和系统监控接口，兼容 V2Ray stats 服务协议。它支持按入站、出站和用户的流量追踪。

**源码**：`experimental/v2rayapi/`

## 注册

与 Clash API 类似，V2Ray API 通过 `init()` 注册，并受构建标签保护：

```go
// v2rayapi.go（with_v2ray_api 构建标签）
func init() {
    experimental.RegisterV2RayServerConstructor(NewServer)
}

// v2rayapi_stub.go（!with_v2ray_api）
func init() {
    experimental.RegisterV2RayServerConstructor(func(...) (adapter.V2RayServer, error) {
        return nil, E.New(`v2ray api is not included in this build, rebuild with -tags with_v2ray_api`)
    })
}
```

## 服务器架构

```go
type Server struct {
    logger       log.Logger
    listen       string           // 如 "127.0.0.1:10085"
    tcpListener  net.Listener
    grpcServer   *grpc.Server
    statsService *StatsService
}
```

服务器创建一个使用非安全凭证（无 TLS）的 gRPC 服务器，并注册 `StatsService`：

```go
func NewServer(logger, options) (adapter.V2RayServer, error) {
    grpcServer := grpc.NewServer(grpc.Creds(insecure.NewCredentials()))
    statsService := NewStatsService(options.Stats)
    if statsService != nil {
        RegisterStatsServiceServer(grpcServer, statsService)
    }
    return &Server{grpcServer: grpcServer, statsService: statsService}, nil
}
```

### 服务名称覆盖

gRPC 服务描述符名称被覆盖以匹配 V2Ray 的命名约定：

```go
func init() {
    StatsService_ServiceDesc.ServiceName = "v2ray.core.app.stats.command.StatsService"
}
```

这确保与期望此特定服务名称的 V2Ray 客户端工具的兼容性。

## Stats Service

### 配置

```go
type StatsService struct {
    createdAt time.Time
    inbounds  map[string]bool    // 追踪的入站标签
    outbounds map[string]bool    // 追踪的出站标签
    users     map[string]bool    // 追踪的用户名
    access    sync.Mutex
    counters  map[string]*atomic.Int64
}
```

只有在配置中明确列出的入站、出站和用户才会被追踪：

```json
{
  "experimental": {
    "v2ray_api": {
      "listen": "127.0.0.1:10085",
      "stats": {
        "enabled": true,
        "inbounds": ["vmess-in"],
        "outbounds": ["proxy", "direct"],
        "users": ["user1", "user2"]
      }
    }
  }
}
```

### 计数器命名约定

计数器遵循 V2Ray 的 `>>>` 分隔命名方案：

```
inbound>>>vmess-in>>>traffic>>>uplink
inbound>>>vmess-in>>>traffic>>>downlink
outbound>>>proxy>>>traffic>>>uplink
outbound>>>proxy>>>traffic>>>downlink
user>>>user1>>>traffic>>>uplink
user>>>user1>>>traffic>>>downlink
```

### 连接包装

Stats service 实现 `adapter.ConnectionTracker`，用字节计数器包装被路由的连接：

```go
func (s *StatsService) RoutedConnection(ctx, conn, metadata, matchedRule, matchOutbound) net.Conn {
    inbound := metadata.Inbound
    user := metadata.User
    outbound := matchOutbound.Tag()

    // 为匹配的追踪实体构建计数器列表
    var readCounter, writeCounter []*atomic.Int64

    if inbound != "" && s.inbounds[inbound] {
        readCounter = append(readCounter, s.loadOrCreateCounter("inbound>>>"+inbound+">>>traffic>>>uplink"))
        writeCounter = append(writeCounter, s.loadOrCreateCounter("inbound>>>"+inbound+">>>traffic>>>downlink"))
    }
    if outbound != "" && s.outbounds[outbound] {
        readCounter = append(readCounter, s.loadOrCreateCounter("outbound>>>"+outbound+">>>traffic>>>uplink"))
        writeCounter = append(writeCounter, s.loadOrCreateCounter("outbound>>>"+outbound+">>>traffic>>>downlink"))
    }
    if user != "" && s.users[user] {
        readCounter = append(readCounter, s.loadOrCreateCounter("user>>>"+user+">>>traffic>>>uplink"))
        writeCounter = append(writeCounter, s.loadOrCreateCounter("user>>>"+user+">>>traffic>>>downlink"))
    }

    if !countInbound && !countOutbound && !countUser {
        return conn  // 无需追踪，返回未包装的连接
    }

    return bufio.NewInt64CounterConn(conn, readCounter, writeCounter)
}
```

相同逻辑适用于 UDP 流量的 `RoutedPacketConnection`。

## gRPC 协议

### Proto 定义

```protobuf
syntax = "proto3";
package experimental.v2rayapi;

// 注册为 "v2ray.core.app.stats.command.StatsService"
service StatsService {
    rpc GetStats(GetStatsRequest) returns (GetStatsResponse) {}
    rpc QueryStats(QueryStatsRequest) returns (QueryStatsResponse) {}
    rpc GetSysStats(SysStatsRequest) returns (SysStatsResponse) {}
}

message GetStatsRequest {
    string name = 1;   // 计数器名称（如 "inbound>>>vmess-in>>>traffic>>>uplink"）
    bool reset = 2;    // 读取后重置计数器
}

message Stat {
    string name = 1;
    int64 value = 2;
}

message QueryStatsRequest {
    string pattern = 1;           // 已弃用的单一模式
    bool reset = 2;
    repeated string patterns = 3; // 多个模式
    bool regexp = 4;              // 使用正则匹配
}

message SysStatsResponse {
    uint32 NumGoroutine = 1;
    uint32 NumGC = 2;
    uint64 Alloc = 3;
    uint64 TotalAlloc = 4;
    uint64 Sys = 5;
    uint64 Mallocs = 6;
    uint64 Frees = 7;
    uint64 LiveObjects = 8;
    uint64 PauseTotalNs = 9;
    uint32 Uptime = 10;
}
```

### GetStats

通过精确名称获取单个计数器：

```go
func (s *StatsService) GetStats(ctx, request) (*GetStatsResponse, error) {
    counter, loaded := s.counters[request.Name]
    if !loaded {
        return nil, E.New(request.Name, " not found.")
    }
    var value int64
    if request.Reset_ {
        value = counter.Swap(0)  // 原子读取并重置
    } else {
        value = counter.Load()
    }
    return &GetStatsResponse{Stat: &Stat{Name: request.Name, Value: value}}, nil
}
```

### QueryStats

通过模式匹配查询多个计数器：

```go
func (s *StatsService) QueryStats(ctx, request) (*QueryStatsResponse, error) {
    // 三种模式：
    // 1. 无模式：返回所有计数器
    // 2. Regexp=true：将模式编译为正则，匹配计数器名称
    // 3. Regexp=false：使用 strings.Contains 进行子串匹配

    // 如果 reset=true，原子地将每个匹配的计数器交换为 0
}
```

### GetSysStats

返回 Go 运行时统计信息：

```go
func (s *StatsService) GetSysStats(ctx, request) (*SysStatsResponse, error) {
    var rtm runtime.MemStats
    runtime.ReadMemStats(&rtm)
    return &SysStatsResponse{
        Uptime:       uint32(time.Since(s.createdAt).Seconds()),
        NumGoroutine: uint32(runtime.NumGoroutine()),
        Alloc:        rtm.Alloc,
        TotalAlloc:   rtm.TotalAlloc,
        Sys:          rtm.Sys,
        Mallocs:      rtm.Mallocs,
        Frees:        rtm.Frees,
        LiveObjects:  rtm.Mallocs - rtm.Frees,
        NumGC:        rtm.NumGC,
        PauseTotalNs: rtm.PauseTotalNs,
    }, nil
}
```

## 启动生命周期

gRPC 服务器在 `PostStart` 阶段启动：

```go
func (s *Server) Start(stage adapter.StartStage) error {
    if stage != adapter.StartStatePostStart {
        return nil
    }
    listener, _ := net.Listen("tcp", s.listen)
    go s.grpcServer.Serve(listener)
    return nil
}
```

## 重新实现注意事项

1. gRPC 服务必须使用服务名称 `v2ray.core.app.stats.command.StatsService` 以兼容 V2Ray 客户端工具
2. 计数器命名遵循 `entity>>>tag>>>traffic>>>direction` 约定，其中 direction 为 `uplink`（客户端读取 / 发送到上游的数据）或 `downlink`（客户端写入 / 从上游接收的数据）
3. 计数器在首次连接时延迟创建 -- 启动时不预先存在
4. `GetStats` 和 `QueryStats` 的 `reset` 标志原子地将计数器交换为 0 并返回旧值
5. 不带模式的 `QueryStats` 返回所有计数器，可用于监控仪表板
6. Stats service 只包装入站/出站/用户标签出现在配置追踪列表中的连接 -- 不匹配任何追踪实体的连接直接通过，无额外开销
7. TCP（`net.Conn`）和 UDP（`N.PacketConn`）连接使用不同的计数器包装器类型分别追踪
