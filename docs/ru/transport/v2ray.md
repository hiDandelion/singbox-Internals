# Фабрика транспорта V2Ray

Исходный код: `transport/v2ray/transport.go`, `transport/v2ray/quic.go`, `transport/v2ray/grpc.go`, `transport/v2ray/grpc_lite.go`

## Паттерн «Фабрика»

Фабрика транспорта V2Ray использует обобщённые псевдонимы типов и диспетчер на основе type-switch для создания серверных и клиентских транспортов. Это единая точка входа для создания всех транспортов V2Ray.

### Обобщённые типы конструкторов

```go
type (
    ServerConstructor[O any] func(
        ctx context.Context,
        logger logger.ContextLogger,
        options O,
        tlsConfig tls.ServerConfig,
        handler adapter.V2RayServerTransportHandler,
    ) (adapter.V2RayServerTransport, error)

    ClientConstructor[O any] func(
        ctx context.Context,
        dialer N.Dialer,
        serverAddr M.Socksaddr,
        options O,
        tlsConfig tls.Config,
    ) (adapter.V2RayClientTransport, error)
)
```

Эти обобщённые типы параметризуют структуру опций `O`, позволяя каждому транспорту определять собственный тип конфигурации, сохраняя при этом общую сигнатуру конструктора.

### Диспетчеризация серверного транспорта

```go
func NewServerTransport(ctx context.Context, logger logger.ContextLogger,
    options option.V2RayTransportOptions, tlsConfig tls.ServerConfig,
    handler adapter.V2RayServerTransportHandler) (adapter.V2RayServerTransport, error) {
    if options.Type == "" {
        return nil, nil
    }
    switch options.Type {
    case C.V2RayTransportTypeHTTP:
        return v2rayhttp.NewServer(ctx, logger, options.HTTPOptions, tlsConfig, handler)
    case C.V2RayTransportTypeWebsocket:
        return v2raywebsocket.NewServer(ctx, logger, options.WebsocketOptions, tlsConfig, handler)
    case C.V2RayTransportTypeQUIC:
        if tlsConfig == nil {
            return nil, C.ErrTLSRequired
        }
        return NewQUICServer(ctx, logger, options.QUICOptions, tlsConfig, handler)
    case C.V2RayTransportTypeGRPC:
        return NewGRPCServer(ctx, logger, options.GRPCOptions, tlsConfig, handler)
    case C.V2RayTransportTypeHTTPUpgrade:
        return v2rayhttpupgrade.NewServer(ctx, logger, options.HTTPUpgradeOptions, tlsConfig, handler)
    default:
        return nil, E.New("unknown transport type: " + options.Type)
    }
}
```

Ключевые особенности поведения:
- Пустой тип возвращает `nil, nil` (транспорт не настроен)
- QUIC требует TLS -- возвращает `C.ErrTLSRequired`, если `tlsConfig` равен nil
- HTTP, WebSocket и HTTP Upgrade импортируются и вызываются напрямую
- gRPC и QUIC диспетчеризуются через промежуточные функции, обрабатывающие переключение по тегам сборки

### Диспетчеризация клиентского транспорта

`NewClientTransport` следует тому же паттерну. Клиентский вариант получает `N.Dialer` и `M.Socksaddr` вместо обработчика:

```go
func NewClientTransport(ctx context.Context, dialer N.Dialer, serverAddr M.Socksaddr,
    options option.V2RayTransportOptions, tlsConfig tls.Config) (adapter.V2RayClientTransport, error)
```

Обратите внимание, что конфигурация TLS -- это `tls.Config` (клиентский интерфейс) в отличие от `tls.ServerConfig` (серверный интерфейс).

## Паттерн регистрации QUIC

Транспорт QUIC требует тега сборки `with_quic`. Поскольку основной пакет `v2ray` не может напрямую импортировать `v2rayquic` (который может быть не скомпилирован), используется паттерн регистрации:

```go
// quic.go
var (
    quicServerConstructor ServerConstructor[option.V2RayQUICOptions]
    quicClientConstructor ClientConstructor[option.V2RayQUICOptions]
)

func RegisterQUICConstructor(
    server ServerConstructor[option.V2RayQUICOptions],
    client ClientConstructor[option.V2RayQUICOptions],
) {
    quicServerConstructor = server
    quicClientConstructor = client
}

func NewQUICServer(...) (adapter.V2RayServerTransport, error) {
    if quicServerConstructor == nil {
        return nil, os.ErrInvalid
    }
    return quicServerConstructor(ctx, logger, options, tlsConfig, handler)
}
```

Пакет `v2rayquic` регистрирует себя через `init()`:

```go
// v2rayquic/init.go
//go:build with_quic

func init() {
    v2ray.RegisterQUICConstructor(NewServer, NewClient)
}
```

Если скомпилировано без `with_quic`, конструкторы остаются nil, и `NewQUICServer`/`NewQUICClient` возвращают `os.ErrInvalid`.

## Переключение gRPC по тегам сборки

gRPC имеет две реализации, управляемые тегами сборки:

**С `with_grpc` (grpc.go)**:

```go
//go:build with_grpc

func NewGRPCServer(...) (adapter.V2RayServerTransport, error) {
    if options.ForceLite {
        return v2raygrpclite.NewServer(ctx, logger, options, tlsConfig, handler)
    }
    return v2raygrpc.NewServer(ctx, logger, options, tlsConfig, handler)
}
```

Когда полная библиотека gRPC доступна, пользователь всё равно может принудительно использовать облегченную реализацию через `options.ForceLite`.

**Без `with_grpc` (grpc_lite.go)**:

```go
//go:build !with_grpc

func NewGRPCServer(...) (adapter.V2RayServerTransport, error) {
    return v2raygrpclite.NewServer(ctx, logger, options, tlsConfig, handler)
}
```

Без тега сборки облегченная реализация используется всегда, независимо от `ForceLite`.

## Конфигурация

```json
{
  "transport": {
    "type": "ws",
    "path": "/path",
    "headers": {
      "Host": "example.com"
    },
    "max_early_data": 2048,
    "early_data_header_name": "Sec-WebSocket-Protocol"
  }
}
```

Структура `V2RayTransportOptions` содержит строку `Type` и подструктуры опций для каждого типа транспорта (`HTTPOptions`, `WebsocketOptions`, `QUICOptions`, `GRPCOptions`, `HTTPUpgradeOptions`). Используются только подопции, соответствующие выбранному типу.
