# UDP-over-TCP (UoT)

Исходный код: `common/uot/router.go`

## Обзор

UoT (UDP-over-TCP) туннелирует UDP-трафик через TCP-соединения. Он перехватывает соединения, направленные на специальные сигнальные адреса, и преобразует их в пакетные соединения с использованием `github.com/sagernet/sing/common/uot`.

## Сигнальные адреса

Два сигнальных адреса обозначают UoT-соединения:

- `uot.MagicAddress` -- Текущий протокол UoT с заголовком запроса
- `uot.LegacyMagicAddress` -- Устаревший UoT без заголовка запроса

## Router

`Router` оборачивает существующий `ConnectionRouterEx` и перехватывает соединения по FQDN назначения:

```go
type Router struct {
    router adapter.ConnectionRouterEx
    logger logger.ContextLogger
}

func NewRouter(router adapter.ConnectionRouterEx, logger logger.ContextLogger) *Router {
    return &Router{router, logger}
}
```

### Обработка соединений (вариант Ex)

```go
func (r *Router) RouteConnectionEx(ctx context.Context, conn net.Conn,
    metadata adapter.InboundContext, onClose N.CloseHandlerFunc) {
    switch metadata.Destination.Fqdn {
    case uot.MagicAddress:
        request, err := uot.ReadRequest(conn)
        if err != nil {
            N.CloseOnHandshakeFailure(conn, onClose, err)
            return
        }
        if request.IsConnect {
            r.logger.InfoContext(ctx, "inbound UoT connect connection to ", request.Destination)
        } else {
            r.logger.InfoContext(ctx, "inbound UoT connection to ", request.Destination)
        }
        metadata.Domain = metadata.Destination.Fqdn
        metadata.Destination = request.Destination
        r.router.RoutePacketConnectionEx(ctx, uot.NewConn(conn, *request), metadata, onClose)
        return

    case uot.LegacyMagicAddress:
        r.logger.InfoContext(ctx, "inbound legacy UoT connection")
        metadata.Domain = metadata.Destination.Fqdn
        metadata.Destination = M.Socksaddr{Addr: netip.IPv4Unspecified()}
        r.RoutePacketConnectionEx(ctx, uot.NewConn(conn, uot.Request{}), metadata, onClose)
        return
    }
    r.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### Заголовок запроса UoT

Для текущего протокола (`uot.MagicAddress`) из соединения считывается заголовок запроса:

- **Destination**: Фактический адрес назначения UDP
- **IsConnect**: Логический флаг, указывающий на режим подключения (connect) или обычный режим

В режиме подключения соединение ведёт себя как подключённый UDP-сокет к одному назначению. В обычном режиме каждый пакет содержит собственный адрес назначения.

### Устаревший протокол

Устаревший протокол (`uot.LegacyMagicAddress`) не имеет заголовка запроса. Назначение устанавливается в `0.0.0.0` (неопределённый IPv4), и используется пустой `Request{}`.

### Сквозная передача

Соединения, не совпадающие ни с одним сигнальным адресом, передаются в базовый маршрутизатор без изменений:

```go
r.router.RouteConnectionEx(ctx, conn, metadata, onClose)
```

### Преобразование в пакетное соединение

`uot.NewConn(conn, request)` оборачивает TCP-соединение как `N.PacketConn`. Протокол UoT кадрирует отдельные UDP-пакеты внутри TCP-потока, обрабатывая:
- Кадрирование длины пакета
- Адресацию назначения для каждого пакета (в обычном режиме)
- Двунаправленную потоковую передачу пакетов

Результирующее пакетное соединение затем маршрутизируется через `RoutePacketConnectionEx` для стандартной обработки UDP.
