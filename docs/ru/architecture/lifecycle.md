# Жизненный цикл Box

`Box` -- это контейнер верхнего уровня, владеющий всеми менеджерами и сервисами. Его жизненный цикл следует многофазному шаблону запуска для управления сложным порядком зависимостей.

**Исходный код**: `box.go`, `adapter/lifecycle.go`

## Структура Box

```go
type Box struct {
    createdAt       time.Time
    logFactory      log.Factory
    logger          log.ContextLogger
    network         *route.NetworkManager
    endpoint        *endpoint.Manager
    inbound         *inbound.Manager
    outbound        *outbound.Manager
    service         *boxService.Manager
    dnsTransport    *dns.TransportManager
    dnsRouter       *dns.Router
    connection      *route.ConnectionManager
    router          *route.Router
    internalService []adapter.LifecycleService  // cache-file, clash-api, v2ray-api, ntp
    done            chan struct{}
}
```

## Создание (`New`)

Функция `New()` строит полный граф объектов:

```go
func New(options Options) (*Box, error) {
    ctx := options.Context
    ctx = service.ContextWithDefaultRegistry(ctx)

    // 1. Retrieve registries from context
    endpointRegistry := service.FromContext[adapter.EndpointRegistry](ctx)
    inboundRegistry := service.FromContext[adapter.InboundRegistry](ctx)
    outboundRegistry := service.FromContext[adapter.OutboundRegistry](ctx)
    dnsTransportRegistry := service.FromContext[adapter.DNSTransportRegistry](ctx)
    serviceRegistry := service.FromContext[adapter.ServiceRegistry](ctx)

    // 2. Create managers
    endpointManager := endpoint.NewManager(...)
    inboundManager := inbound.NewManager(...)
    outboundManager := outbound.NewManager(...)
    dnsTransportManager := dns.NewTransportManager(...)
    serviceManager := boxService.NewManager(...)

    // 3. Register managers in context
    service.MustRegister[adapter.EndpointManager](ctx, endpointManager)
    service.MustRegister[adapter.InboundManager](ctx, inboundManager)
    // ... etc.

    // 4. Create router and DNS router
    dnsRouter := dns.NewRouter(ctx, logFactory, dnsOptions)
    networkManager := route.NewNetworkManager(ctx, ...)
    connectionManager := route.NewConnectionManager(...)
    router := route.NewRouter(ctx, ...)

    // 5. Initialize router rules
    router.Initialize(routeOptions.Rules, routeOptions.RuleSet)
    dnsRouter.Initialize(dnsOptions.Rules)

    // 6. Create all configured components via registries
    for _, transportOptions := range dnsOptions.Servers {
        dnsTransportManager.Create(ctx, ..., transportOptions.Type, transportOptions.Options)
    }
    for _, endpointOptions := range options.Endpoints {
        endpointManager.Create(ctx, ..., endpointOptions.Type, endpointOptions.Options)
    }
    for _, inboundOptions := range options.Inbounds {
        inboundManager.Create(ctx, ..., inboundOptions.Type, inboundOptions.Options)
    }
    for _, outboundOptions := range options.Outbounds {
        outboundManager.Create(ctx, ..., outboundOptions.Type, outboundOptions.Options)
    }

    // 7. Set default outbound and DNS transport
    outboundManager.Initialize(func() { return direct.NewOutbound(...) })
    dnsTransportManager.Initialize(func() { return local.NewTransport(...) })

    // 8. Create internal services (cache-file, clash-api, v2ray-api, ntp)
    // ...
}
```

## Фазы запуска

Интерфейс жизненного цикла использует перечисление `StartStage`:

```go
type StartStage uint8

const (
    StartStateInitialize StartStage = iota  // Phase 0: internal setup
    StartStateStart                          // Phase 1: start serving
    StartStatePostStart                      // Phase 2: post-start hooks
    StartStateStarted                        // Phase 3: cleanup
)

type Lifecycle interface {
    Start(stage StartStage) error
    Close() error
}
```

### Порядок выполнения фаз

```
PreStart():
  Phase 0 (Initialize): internal-services → network → dnsTransport → dnsRouter →
                         connection → router → outbound → inbound → endpoint → service
  Phase 1 (Start):      outbound → dnsTransport → dnsRouter → network →
                         connection → router

Start() (continues from PreStart):
  Phase 1 (Start):      internal-services → inbound → endpoint → service
  Phase 2 (PostStart):  outbound → network → dnsTransport → dnsRouter →
                         connection → router → inbound → endpoint → service →
                         internal-services
  Phase 3 (Started):    network → dnsTransport → dnsRouter → connection →
                         router → outbound → inbound → endpoint → service →
                         internal-services
```

### Зачем нужно несколько фаз?

- **Initialize**: Создание внутреннего состояния, разрешение зависимостей между менеджерами
- **Start**: Начало прослушивания/подключения. Исходящие запускаются первыми (они нужны DNS-транспортам и входящим)
- **PostStart**: Задачи, требующие работающих сервисов (например, правила, ссылающиеся на наборы правил)
- **Started**: Очистка временных данных, запуск сборки мусора

## Завершение работы

```go
func (s *Box) Close() error {
    close(s.done)  // signal shutdown

    // Close in reverse dependency order:
    // service → endpoint → inbound → outbound → router →
    // connection → dns-router → dns-transport → network

    // Then internal services (cache-file, clash-api, etc.)
    // Then logger
}
```

## PreStart и Start

sing-box поддерживает два режима запуска:

- `Box.Start()` -- полный запуск, внутри вызывает `preStart()`, затем `start()`
- `Box.PreStart()` -- частичный запуск для мобильных платформ, где входящие должны запускаться позже

PreStart инициализирует всё и запускает исходящие/DNS/маршрутизатор, но НЕ запускает входящие/конечные точки/сервисы. Это позволяет платформенному слою настроить TUN до начала передачи трафика.

## Монитор задач

Каждая фаза использует `taskmonitor.New()` для логирования медленных операций:

```go
monitor := taskmonitor.New(s.logger, C.StartTimeout)
monitor.Start("start logger")
err := s.logFactory.Start()
monitor.Finish()
```

Если задача превышает `C.StartTimeout` (60 секунд), выводится предупреждение с именем задачи.
