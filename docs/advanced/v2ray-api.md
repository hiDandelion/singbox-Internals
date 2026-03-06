# V2Ray API

The V2Ray API provides a gRPC-based statistics and system monitoring interface, compatible with the V2Ray stats service protocol. It enables per-inbound, per-outbound, and per-user traffic tracking.

**Source**: `experimental/v2rayapi/`

## Registration

Like the Clash API, the V2Ray API registers via `init()` with a build tag guard:

```go
// v2rayapi.go (with_v2ray_api build tag)
func init() {
    experimental.RegisterV2RayServerConstructor(NewServer)
}

// v2rayapi_stub.go (!with_v2ray_api)
func init() {
    experimental.RegisterV2RayServerConstructor(func(...) (adapter.V2RayServer, error) {
        return nil, E.New(`v2ray api is not included in this build, rebuild with -tags with_v2ray_api`)
    })
}
```

## Server Architecture

```go
type Server struct {
    logger       log.Logger
    listen       string           // e.g., "127.0.0.1:10085"
    tcpListener  net.Listener
    grpcServer   *grpc.Server
    statsService *StatsService
}
```

The server creates a gRPC server with insecure credentials (no TLS) and registers the `StatsService`:

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

### Service Name Override

The gRPC service descriptor name is overridden to match V2Ray's naming convention:

```go
func init() {
    StatsService_ServiceDesc.ServiceName = "v2ray.core.app.stats.command.StatsService"
}
```

This ensures compatibility with V2Ray client tools that expect this specific service name.

## Stats Service

### Configuration

```go
type StatsService struct {
    createdAt time.Time
    inbounds  map[string]bool    // tracked inbound tags
    outbounds map[string]bool    // tracked outbound tags
    users     map[string]bool    // tracked user names
    access    sync.Mutex
    counters  map[string]*atomic.Int64
}
```

Only inbounds, outbounds, and users explicitly listed in the configuration are tracked:

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

### Counter Naming Convention

Counters follow V2Ray's `>>>` delimited naming scheme:

```
inbound>>>vmess-in>>>traffic>>>uplink
inbound>>>vmess-in>>>traffic>>>downlink
outbound>>>proxy>>>traffic>>>uplink
outbound>>>proxy>>>traffic>>>downlink
user>>>user1>>>traffic>>>uplink
user>>>user1>>>traffic>>>downlink
```

### Connection Wrapping

The stats service implements `adapter.ConnectionTracker`, wrapping routed connections with byte counters:

```go
func (s *StatsService) RoutedConnection(ctx, conn, metadata, matchedRule, matchOutbound) net.Conn {
    inbound := metadata.Inbound
    user := metadata.User
    outbound := matchOutbound.Tag()

    // Build counter lists for matching tracked entities
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
        return conn  // no tracking needed, return unwrapped
    }

    return bufio.NewInt64CounterConn(conn, readCounter, writeCounter)
}
```

The same logic applies to `RoutedPacketConnection` for UDP traffic.

## gRPC Protocol

### Proto Definition

```protobuf
syntax = "proto3";
package experimental.v2rayapi;

// Registered as "v2ray.core.app.stats.command.StatsService"
service StatsService {
    rpc GetStats(GetStatsRequest) returns (GetStatsResponse) {}
    rpc QueryStats(QueryStatsRequest) returns (QueryStatsResponse) {}
    rpc GetSysStats(SysStatsRequest) returns (SysStatsResponse) {}
}

message GetStatsRequest {
    string name = 1;   // Counter name (e.g., "inbound>>>vmess-in>>>traffic>>>uplink")
    bool reset = 2;    // Reset counter after reading
}

message Stat {
    string name = 1;
    int64 value = 2;
}

message QueryStatsRequest {
    string pattern = 1;           // Deprecated single pattern
    bool reset = 2;
    repeated string patterns = 3; // Multiple patterns
    bool regexp = 4;              // Use regex matching
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

Retrieves a single counter by exact name:

```go
func (s *StatsService) GetStats(ctx, request) (*GetStatsResponse, error) {
    counter, loaded := s.counters[request.Name]
    if !loaded {
        return nil, E.New(request.Name, " not found.")
    }
    var value int64
    if request.Reset_ {
        value = counter.Swap(0)  // atomic read-and-reset
    } else {
        value = counter.Load()
    }
    return &GetStatsResponse{Stat: &Stat{Name: request.Name, Value: value}}, nil
}
```

### QueryStats

Queries multiple counters by pattern matching:

```go
func (s *StatsService) QueryStats(ctx, request) (*QueryStatsResponse, error) {
    // Three modes:
    // 1. No patterns: return all counters
    // 2. Regexp=true: compile patterns as regex, match counter names
    // 3. Regexp=false: use strings.Contains for substring matching

    // If reset=true, atomically swap each matched counter to 0
}
```

### GetSysStats

Returns Go runtime statistics:

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

## Start Lifecycle

The gRPC server starts in the `PostStart` stage:

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

## Reimplementation Notes

1. The gRPC service must use the service name `v2ray.core.app.stats.command.StatsService` for compatibility with V2Ray client tools
2. Counter naming follows the `entity>>>tag>>>traffic>>>direction` convention where direction is `uplink` (client reads / data sent to upstream) or `downlink` (client writes / data received from upstream)
3. Counters are lazily created on first connection -- they do not pre-exist at startup
4. The `reset` flag on both `GetStats` and `QueryStats` atomically swaps the counter to 0 and returns the old value
5. `QueryStats` with no patterns returns all counters, which can be used for monitoring dashboards
6. The stats service only wraps connections whose inbound/outbound/user tags appear in the configured tracking lists -- connections not matching any tracked entity pass through without overhead
7. Both TCP (`net.Conn`) and UDP (`N.PacketConn`) connections are tracked with separate counter wrapper types
