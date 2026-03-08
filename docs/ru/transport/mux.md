# Мультиплексирование соединений (sing-mux)

Исходный код: `common/mux/client.go`, `common/mux/router.go`

## Обзор

sing-box интегрирует `github.com/sagernet/sing-mux` для мультиплексирования соединений, позволяя передавать несколько логических потоков через одно базовое соединение. Поддерживается опциональное управление перегрузкой Brutal для принудительного ограничения полосы пропускания.

## Клиент

Клиент оборачивает `N.Dialer` возможностями мультиплексирования:

```go
type Client = mux.Client

func NewClientWithOptions(dialer N.Dialer, logger logger.Logger, options option.OutboundMultiplexOptions) (*Client, error) {
    if !options.Enabled {
        return nil, nil
    }
    var brutalOptions mux.BrutalOptions
    if options.Brutal != nil && options.Brutal.Enabled {
        brutalOptions = mux.BrutalOptions{
            Enabled:    true,
            SendBPS:    uint64(options.Brutal.UpMbps * C.MbpsToBps),
            ReceiveBPS: uint64(options.Brutal.DownMbps * C.MbpsToBps),
        }
        if brutalOptions.SendBPS < mux.BrutalMinSpeedBPS {
            return nil, E.New("brutal: invalid upload speed")
        }
        if brutalOptions.ReceiveBPS < mux.BrutalMinSpeedBPS {
            return nil, E.New("brutal: invalid download speed")
        }
    }
    return mux.NewClient(mux.Options{
        Dialer:         &clientDialer{dialer},
        Logger:         logger,
        Protocol:       options.Protocol,
        MaxConnections: options.MaxConnections,
        MinStreams:      options.MinStreams,
        MaxStreams:      options.MaxStreams,
        Padding:        options.Padding,
        Brutal:         brutalOptions,
    })
}
```

### Переопределение контекста

Клиентский dialer оборачивает исходный dialer для применения переопределений контекста:

```go
type clientDialer struct {
    N.Dialer
}

func (d *clientDialer) DialContext(ctx context.Context, network string, destination M.Socksaddr) (net.Conn, error) {
    return d.Dialer.DialContext(adapter.OverrideContext(ctx), network, destination)
}
```

### Управление перегрузкой Brutal

Brutal обеспечивает фиксированную полосу пропускания, указывая скорости загрузки и выгрузки в Мбит/с. Скорости преобразуются в байты в секунду с использованием `C.MbpsToBps`. Минимальная скорость (`mux.BrutalMinSpeedBPS`) применяется для предотвращения ошибок конфигурации.

## Сервер (Router)

Серверная сторона использует обёртку `Router`, которая перехватывает соединения с меткой мультиплексирования:

```go
type Router struct {
    router  adapter.ConnectionRouterEx
    service *mux.Service
}

func NewRouterWithOptions(router adapter.ConnectionRouterEx, logger logger.ContextLogger, options option.InboundMultiplexOptions) (adapter.ConnectionRouterEx, error) {
    if !options.Enabled {
        return router, nil
    }
    service, err := mux.NewService(mux.ServiceOptions{
        NewStreamContext: func(ctx context.Context, conn net.Conn) context.Context {
            return log.ContextWithNewID(ctx)
        },
        Logger:    logger,
        HandlerEx: adapter.NewRouteContextHandlerEx(router),
        Padding:   options.Padding,
        Brutal:    brutalOptions,
    })
    return &Router{router, service}, nil
}
```

### Маршрутизация соединений

Router проверяет назначение на соответствие `mux.Destination` для обнаружения мультиплексированных соединений:

```go
func (r *Router) RouteConnectionEx(ctx context.Context, conn net.Conn, metadata adapter.InboundContext, onClose N.CloseHandlerFunc) {
    if metadata.Destination == mux.Destination {
        r.service.NewConnectionEx(adapter.WithContext(ctx, &metadata), conn,
            metadata.Source, metadata.Destination, onClose)
        return
    }
    r.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

`mux.Destination` -- это сигнальный адрес, обозначающий мультиплексированное соединение. Не-мультиплексированные соединения передаются в базовый маршрутизатор без изменений.

Каждый демультиплексированный поток получает новый идентификатор журнала через `NewStreamContext`.

## Конфигурация

### Исходящее соединение (клиент)

```json
{
  "multiplex": {
    "enabled": true,
    "protocol": "smux",
    "max_connections": 4,
    "min_streams": 4,
    "max_streams": 0,
    "padding": false,
    "brutal": {
      "enabled": true,
      "up_mbps": 100,
      "down_mbps": 100
    }
  }
}
```

### Входящее соединение (сервер)

```json
{
  "multiplex": {
    "enabled": true,
    "padding": false,
    "brutal": {
      "enabled": true,
      "up_mbps": 100,
      "down_mbps": 100
    }
  }
}
```

| Поле | Описание |
|-------|-------------|
| `protocol` | Протокол мультиплексирования (h2mux, smux, yamux) |
| `max_connections` | Максимальное количество базовых соединений |
| `min_streams` | Минимальное количество потоков на соединение перед открытием нового |
| `max_streams` | Максимальное количество потоков на соединение (0 = без ограничений) |
| `padding` | Включить заполнение для противодействия анализу трафика |
| `brutal.up_mbps` | Скорость загрузки в Мбит/с для управления перегрузкой Brutal |
| `brutal.down_mbps` | Скорость скачивания в Мбит/с для управления перегрузкой Brutal |
