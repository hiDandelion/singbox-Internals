# V2Ray API

يوفر V2Ray API واجهة إحصائيات ومراقبة نظام قائمة على gRPC، متوافقة مع بروتوكول خدمة إحصائيات V2Ray. يمكّن من تتبع حركة المرور لكل منفذ وارد، ومنفذ صادر، ولكل مستخدم.

**المصدر**: `experimental/v2rayapi/`

## التسجيل

مثل Clash API، يسجل V2Ray API عبر `init()` مع حماية بعلامة بناء:

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

## هندسة الخادم

```go
type Server struct {
    logger       log.Logger
    listen       string           // مثل "127.0.0.1:10085"
    tcpListener  net.Listener
    grpcServer   *grpc.Server
    statsService *StatsService
}
```

ينشئ الخادم خادم gRPC ببيانات اعتماد غير آمنة (بدون TLS) ويسجل `StatsService`:

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

### تجاوز اسم الخدمة

يتم تجاوز اسم واصف خدمة gRPC ليتطابق مع اصطلاح تسمية V2Ray:

```go
func init() {
    StatsService_ServiceDesc.ServiceName = "v2ray.core.app.stats.command.StatsService"
}
```

هذا يضمن التوافق مع أدوات عميل V2Ray التي تتوقع اسم الخدمة المحدد هذا.

## خدمة الإحصائيات

### التهيئة

```go
type StatsService struct {
    createdAt time.Time
    inbounds  map[string]bool    // وسوم المنافذ الواردة المتتبعة
    outbounds map[string]bool    // وسوم المنافذ الصادرة المتتبعة
    users     map[string]bool    // أسماء المستخدمين المتتبعة
    access    sync.Mutex
    counters  map[string]*atomic.Int64
}
```

يتم تتبع فقط المنافذ الواردة والصادرة والمستخدمين المدرجين صراحة في التهيئة:

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

### اصطلاح تسمية العدادات

تتبع العدادات نمط تسمية V2Ray المفصول بـ `>>>`:

```
inbound>>>vmess-in>>>traffic>>>uplink
inbound>>>vmess-in>>>traffic>>>downlink
outbound>>>proxy>>>traffic>>>uplink
outbound>>>proxy>>>traffic>>>downlink
user>>>user1>>>traffic>>>uplink
user>>>user1>>>traffic>>>downlink
```

### تغليف الاتصال

تنفذ خدمة الإحصائيات `adapter.ConnectionTracker`، وتغلف الاتصالات الموجهة بعدادات بايت:

```go
func (s *StatsService) RoutedConnection(ctx, conn, metadata, matchedRule, matchOutbound) net.Conn {
    inbound := metadata.Inbound
    user := metadata.User
    outbound := matchOutbound.Tag()

    // بناء قوائم العدادات للكيانات المتتبعة المطابقة
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
        return conn  // لا حاجة للتتبع، إرجاع بدون تغليف
    }

    return bufio.NewInt64CounterConn(conn, readCounter, writeCounter)
}
```

نفس المنطق ينطبق على `RoutedPacketConnection` لحركة مرور UDP.

## بروتوكول gRPC

### تعريف Proto

```protobuf
syntax = "proto3";
package experimental.v2rayapi;

// مسجل كـ "v2ray.core.app.stats.command.StatsService"
service StatsService {
    rpc GetStats(GetStatsRequest) returns (GetStatsResponse) {}
    rpc QueryStats(QueryStatsRequest) returns (QueryStatsResponse) {}
    rpc GetSysStats(SysStatsRequest) returns (SysStatsResponse) {}
}

message GetStatsRequest {
    string name = 1;   // اسم العداد (مثل "inbound>>>vmess-in>>>traffic>>>uplink")
    bool reset = 2;    // إعادة تعيين العداد بعد القراءة
}

message Stat {
    string name = 1;
    int64 value = 2;
}

message QueryStatsRequest {
    string pattern = 1;           // نمط واحد مهمل
    bool reset = 2;
    repeated string patterns = 3; // أنماط متعددة
    bool regexp = 4;              // استخدام مطابقة التعبير النمطي
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

يسترجع عداداً واحداً بالاسم الدقيق:

```go
func (s *StatsService) GetStats(ctx, request) (*GetStatsResponse, error) {
    counter, loaded := s.counters[request.Name]
    if !loaded {
        return nil, E.New(request.Name, " not found.")
    }
    var value int64
    if request.Reset_ {
        value = counter.Swap(0)  // قراءة وإعادة تعيين ذرية
    } else {
        value = counter.Load()
    }
    return &GetStatsResponse{Stat: &Stat{Name: request.Name, Value: value}}, nil
}
```

### QueryStats

يستعلم عن عدة عدادات بمطابقة الأنماط:

```go
func (s *StatsService) QueryStats(ctx, request) (*QueryStatsResponse, error) {
    // ثلاثة أوضاع:
    // 1. بدون أنماط: إرجاع جميع العدادات
    // 2. Regexp=true: تجميع الأنماط كتعبيرات نمطية، مطابقة أسماء العدادات
    // 3. Regexp=false: استخدام strings.Contains للمطابقة الجزئية

    // إذا reset=true، مبادلة كل عداد مطابق إلى 0 ذرياً
}
```

### GetSysStats

يُرجع إحصائيات وقت تشغيل Go:

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

## دورة حياة البدء

يبدأ خادم gRPC في مرحلة `PostStart`:

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

## ملاحظات إعادة التنفيذ

1. يجب أن تستخدم خدمة gRPC اسم الخدمة `v2ray.core.app.stats.command.StatsService` للتوافق مع أدوات عميل V2Ray
2. تسمية العدادات تتبع اصطلاح `entity>>>tag>>>traffic>>>direction` حيث الاتجاه هو `uplink` (قراءات العميل / البيانات المرسلة للمنبع) أو `downlink` (كتابات العميل / البيانات المستلمة من المنبع)
3. العدادات تُنشأ بشكل كسول عند أول اتصال -- لا تكون موجودة مسبقاً عند بدء التشغيل
4. علم `reset` في كل من `GetStats` و `QueryStats` يبادل العداد ذرياً إلى 0 ويُرجع القيمة القديمة
5. `QueryStats` بدون أنماط يُرجع جميع العدادات، وهو ما يمكن استخدامه للوحات المراقبة
6. خدمة الإحصائيات تغلف فقط الاتصالات التي تظهر وسوم منافذها الواردة/الصادرة/مستخدميها في قوائم التتبع المهيأة -- الاتصالات التي لا تطابق أي كيان متتبع تمر دون حمل إضافي
7. كل من اتصالات TCP (`net.Conn`) و UDP (`N.PacketConn`) تُتتبع بأنواع أغلفة عدادات منفصلة
