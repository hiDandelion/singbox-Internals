# Реестр сервисов

sing-box использует `context.Context` Go в качестве контейнера сервисов для внедрения зависимостей. Это устраняет глобальные синглтоны и делает граф зависимостей явным.

**Исходный код**: `github.com/sagernet/sing/service`, `box.go`, `include/`

## Как это работает

Пакет `sing/service` предоставляет типизированную регистрацию сервисов:

```go
// Register a service in context
func ContextWith[T any](ctx context.Context, service T) context.Context

// Retrieve a service from context
func FromContext[T any](ctx context.Context) T

// Register with panic on duplicate
func MustRegister[T any](ctx context.Context, service T)
```

Сервисы индексируются по **типу интерфейса**, а не по конкретному типу. Это означает:

```go
// Register NetworkManager
service.MustRegister[adapter.NetworkManager](ctx, networkManager)

// Any code with the context can retrieve it
nm := service.FromContext[adapter.NetworkManager](ctx)
```

## Регистрация в Box.New()

Во время `Box.New()` регистрируются все менеджеры:

```go
// Create managers
endpointManager := endpoint.NewManager(...)
inboundManager := inbound.NewManager(...)
outboundManager := outbound.NewManager(...)
dnsTransportManager := dns.NewTransportManager(...)
serviceManager := boxService.NewManager(...)

// Register in context
service.MustRegister[adapter.EndpointManager](ctx, endpointManager)
service.MustRegister[adapter.InboundManager](ctx, inboundManager)
service.MustRegister[adapter.OutboundManager](ctx, outboundManager)
service.MustRegister[adapter.DNSTransportManager](ctx, dnsTransportManager)
service.MustRegister[adapter.ServiceManager](ctx, serviceManager)

// Also register router, network manager, DNS router, connection manager
service.MustRegister[adapter.Router](ctx, router)
service.MustRegister[adapter.NetworkManager](ctx, networkManager)
service.MustRegister[adapter.DNSRouter](ctx, dnsRouter)
service.MustRegister[adapter.ConnectionManager](ctx, connectionManager)
```

## Паттерн реестра

Типы протоколов регистрируются через типизированные реестры:

```go
type InboundRegistry interface {
    option.InboundOptionsRegistry
    Create(ctx, router, logger, tag, inboundType string, options any) (Inbound, error)
}

type OutboundRegistry interface {
    option.OutboundOptionsRegistry
    CreateOutbound(ctx, router, logger, tag, outboundType string, options any) (Outbound, error)
}
```

### Как заполняются реестры

Пакет `include/` использует теги сборки для регистрации типов протоколов:

```go
// include/inbound.go
func InboundRegistry() *inbound.Registry {
    registry := inbound.NewRegistry()
    tun.RegisterInbound(registry)
    socks.RegisterInbound(registry)
    http.RegisterInbound(registry)
    mixed.RegisterInbound(registry)
    direct.RegisterInbound(registry)
    // ... all protocol types
    return registry
}
```

Каждый протокол регистрирует себя самостоятельно:

```go
// protocol/vless/inbound.go
func RegisterInbound(registry adapter.InboundRegistry) {
    inbound.Register[option.VLESSInboundOptions](registry, C.TypeVLESS, NewInbound)
}
```

Обобщённая функция `Register` создаёт отображение: строка типа -> тип опций -> функция-фабрика.

## Инициализация контекста

Функция `box.Context()` подготавливает контекст с реестрами:

```go
func Context(
    ctx context.Context,
    inboundRegistry adapter.InboundRegistry,
    outboundRegistry adapter.OutboundRegistry,
    endpointRegistry adapter.EndpointRegistry,
    dnsTransportRegistry adapter.DNSTransportRegistry,
    serviceRegistry adapter.ServiceRegistry,
) context.Context {
    ctx = service.ContextWith[adapter.InboundRegistry](ctx, inboundRegistry)
    ctx = service.ContextWith[adapter.OutboundRegistry](ctx, outboundRegistry)
    // ... etc.
    return ctx
}
```

Она вызывается перед `Box.New()`, обычно в `cmd/sing-box/main.go`:

```go
ctx = box.Context(ctx,
    include.InboundRegistry(),
    include.OutboundRegistry(),
    include.EndpointRegistry(),
    include.DNSTransportRegistry(),
    include.ServiceRegistry(),
)
instance, err := box.New(box.Options{
    Context: ctx,
    Options: options,
})
```

## Двойная регистрация

Регистрируются как реестр опций, так и реестр адаптеров:

```go
ctx = service.ContextWith[option.InboundOptionsRegistry](ctx, inboundRegistry)
ctx = service.ContextWith[adapter.InboundRegistry](ctx, inboundRegistry)
```

Реестр опций используется при парсинге JSON для определения правильного типа структуры опций. Реестр адаптеров используется в `Box.New()` для создания экземпляров из опций.

## Использование в компонентах

Любой компонент, имеющий доступ к контексту, может получить сервисы:

```go
// In Router constructor
func NewRouter(ctx context.Context, ...) *Router {
    return &Router{
        inbound:  service.FromContext[adapter.InboundManager](ctx),
        outbound: service.FromContext[adapter.OutboundManager](ctx),
        dns:      service.FromContext[adapter.DNSRouter](ctx),
        network:  service.FromContext[adapter.NetworkManager](ctx),
        // ...
    }
}
```

## Сравнение с Xray-core

| Аспект | Xray-core | sing-box |
|--------|----------|----------|
| Паттерн DI | `RequireFeatures` + рефлексия | Типизированный поиск через контекст |
| Регистрация | Глобальный реестр фич на Instance | Реестр сервисов для каждого контекста |
| Разрешение | Ленивое (разрешается при доступности всех зависимостей) | Энергичное (разрешается при создании) |
| Типобезопасность | Приведение типов во время выполнения | Дженерики на этапе компиляции |
| Жизненный цикл | Feature.Start() вызывается Instance | Многофазный Start(stage) |
