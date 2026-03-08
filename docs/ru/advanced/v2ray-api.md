# V2Ray API

V2Ray API предоставляет основанный на gRPC интерфейс статистики и мониторинга системы, совместимый с протоколом сервиса статистики V2Ray. Он обеспечивает отслеживание трафика для каждого входящего, исходящего и пользователя.

**Исходный код**: `experimental/v2rayapi/`

## Регистрация

Как и Clash API, V2Ray API регистрируется через `init()` с защитой тегом сборки:

```go
// v2rayapi.go (тег сборки with_v2ray_api)
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

## Архитектура сервера

```go
type Server struct {
    logger       log.Logger
    listen       string           // напр., "127.0.0.1:10085"
    tcpListener  net.Listener
    grpcServer   *grpc.Server
    statsService *StatsService
}
```

Сервер создаёт gRPC-сервер с незащищёнными учётными данными (без TLS) и регистрирует `StatsService`:

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

### Переопределение имени сервиса

Имя сервиса в дескрипторе gRPC переопределяется для соответствия соглашению об именовании V2Ray:

```go
func init() {
    StatsService_ServiceDesc.ServiceName = "v2ray.core.app.stats.command.StatsService"
}
```

Это обеспечивает совместимость с клиентскими инструментами V2Ray, которые ожидают это конкретное имя сервиса.

## Сервис статистики

### Конфигурация

```go
type StatsService struct {
    createdAt time.Time
    inbounds  map[string]bool    // отслеживаемые теги входящих
    outbounds map[string]bool    // отслеживаемые теги исходящих
    users     map[string]bool    // отслеживаемые имена пользователей
    access    sync.Mutex
    counters  map[string]*atomic.Int64
}
```

Отслеживаются только входящие, исходящие и пользователи, явно указанные в конфигурации:

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

### Соглашение об именовании счётчиков

Счётчики следуют схеме именования V2Ray с разделителем `>>>`:

```
inbound>>>vmess-in>>>traffic>>>uplink
inbound>>>vmess-in>>>traffic>>>downlink
outbound>>>proxy>>>traffic>>>uplink
outbound>>>proxy>>>traffic>>>downlink
user>>>user1>>>traffic>>>uplink
user>>>user1>>>traffic>>>downlink
```

### Обёртка соединений

Сервис статистики реализует `adapter.ConnectionTracker`, оборачивая маршрутизированные соединения счётчиками байт:

```go
func (s *StatsService) RoutedConnection(ctx, conn, metadata, matchedRule, matchOutbound) net.Conn {
    inbound := metadata.Inbound
    user := metadata.User
    outbound := matchOutbound.Tag()

    // Построение списков счётчиков для соответствующих отслеживаемых сущностей
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
        return conn  // отслеживание не требуется, возврат без обёртки
    }

    return bufio.NewInt64CounterConn(conn, readCounter, writeCounter)
}
```

Та же логика применяется к `RoutedPacketConnection` для UDP-трафика.

## Протокол gRPC

### Определение Proto

```protobuf
syntax = "proto3";
package experimental.v2rayapi;

// Зарегистрирован как "v2ray.core.app.stats.command.StatsService"
service StatsService {
    rpc GetStats(GetStatsRequest) returns (GetStatsResponse) {}
    rpc QueryStats(QueryStatsRequest) returns (QueryStatsResponse) {}
    rpc GetSysStats(SysStatsRequest) returns (SysStatsResponse) {}
}

message GetStatsRequest {
    string name = 1;   // Имя счётчика (напр., "inbound>>>vmess-in>>>traffic>>>uplink")
    bool reset = 2;    // Сброс счётчика после чтения
}

message Stat {
    string name = 1;
    int64 value = 2;
}

message QueryStatsRequest {
    string pattern = 1;           // Устаревший одиночный паттерн
    bool reset = 2;
    repeated string patterns = 3; // Множественные паттерны
    bool regexp = 4;              // Использование регулярных выражений
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

Получает один счётчик по точному имени:

```go
func (s *StatsService) GetStats(ctx, request) (*GetStatsResponse, error) {
    counter, loaded := s.counters[request.Name]
    if !loaded {
        return nil, E.New(request.Name, " not found.")
    }
    var value int64
    if request.Reset_ {
        value = counter.Swap(0)  // атомарное чтение и сброс
    } else {
        value = counter.Load()
    }
    return &GetStatsResponse{Stat: &Stat{Name: request.Name, Value: value}}, nil
}
```

### QueryStats

Запрашивает несколько счётчиков по совпадению паттернов:

```go
func (s *StatsService) QueryStats(ctx, request) (*QueryStatsResponse, error) {
    // Три режима:
    // 1. Без паттернов: возврат всех счётчиков
    // 2. Regexp=true: компиляция паттернов как регулярных выражений, сопоставление имён счётчиков
    // 3. Regexp=false: использование strings.Contains для поиска подстроки

    // Если reset=true, атомарная замена каждого совпавшего счётчика на 0
}
```

### GetSysStats

Возвращает статистику среды выполнения Go:

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

## Жизненный цикл запуска

gRPC-сервер запускается на этапе `PostStart`:

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

## Замечания по реализации

1. gRPC-сервис должен использовать имя `v2ray.core.app.stats.command.StatsService` для совместимости с клиентскими инструментами V2Ray
2. Именование счётчиков следует соглашению `сущность>>>тег>>>traffic>>>направление`, где направление — `uplink` (клиент читает / данные отправлены на вышестоящий сервер) или `downlink` (клиент записывает / данные получены от вышестоящего сервера)
3. Счётчики создаются лениво при первом соединении — они не существуют предварительно при запуске
4. Флаг `reset` как в `GetStats`, так и в `QueryStats` атомарно меняет счётчик на 0 и возвращает старое значение
5. `QueryStats` без паттернов возвращает все счётчики, что может использоваться для мониторинговых панелей
6. Сервис статистики оборачивает только соединения, чьи теги входящих/исходящих/пользователей присутствуют в настроенных списках отслеживания — соединения, не совпадающие ни с одной отслеживаемой сущностью, проходят без накладных расходов
7. Как TCP (`net.Conn`), так и UDP (`N.PacketConn`) соединения отслеживаются с отдельными типами обёрток счётчиков
