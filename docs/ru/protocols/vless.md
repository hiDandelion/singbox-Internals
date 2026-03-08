# Протокол VLESS

VLESS — это легковесный прокси-протокол с аутентификацией на основе UUID. sing-box делегирует формат данных VLESS библиотеке `sing-vmess/vless`.

**Исходный код**: `protocol/vless/`, `sing-vmess/vless/`

## Архитектура входящих соединений (Inbound)

```go
type Inbound struct {
    inbound.Adapter
    ctx       context.Context
    router    adapter.ConnectionRouterEx
    logger    logger.ContextLogger
    listener  *listener.Listener
    users     []option.VLESSUser
    service   *vless.Service[int]     // VLESS-сервис sing-vmess
    tlsConfig tls.ServerConfig
    transport adapter.V2RayServerTransport
}
```

### Конструирование

```go
func NewInbound(ctx, router, logger, tag, options) (adapter.Inbound, error) {
    // 1. Создание обёртки UoT-маршрутизатора (обработка UDP-over-TCP)
    inbound.router = uot.NewRouter(router, logger)

    // 2. Создание обёртки mux-маршрутизатора (обработка мультиплексирования)
    inbound.router = mux.NewRouterWithOptions(inbound.router, logger, options.Multiplex)

    // 3. Создание VLESS-сервиса со списком пользователей
    service := vless.NewService[int](logger, adapter.NewUpstreamContextHandlerEx(
        inbound.newConnectionEx,        // обработчик TCP
        inbound.newPacketConnectionEx,   // обработчик UDP
    ))
    service.UpdateUsers(indices, uuids, flows)

    // 4. Конфигурация TLS (опционально)
    inbound.tlsConfig = tls.NewServerWithOptions(...)
    // kTLS совместим только когда: нет транспорта, нет mux, нет flow (Vision)

    // 5. V2Ray-транспорт (опционально: WS, gRPC, HTTP и т.д.)
    inbound.transport = v2ray.NewServerTransport(ctx, ..., inbound.tlsConfig, handler)

    // 6. TCP-слушатель
    inbound.listener = listener.New(...)
}
```

### Поток соединения

```
TCP Connection → [TLS Handshake] → VLESS Service.NewConnection()
                                          ↓
                                   Decode VLESS header
                                   Authenticate UUID
                                   Extract destination
                                          ↓
                                   newConnectionEx() / newPacketConnectionEx()
                                          ↓
                                   Set metadata (Inbound, User)
                                          ↓
                                   router.RouteConnectionEx()
```

При настроенном V2Ray-транспорте:
```
TCP Connection → Transport.Serve() → Transport Handler → [TLS already handled] → VLESS Service
```

### Совместимость с kTLS

kTLS (kernel TLS) включается при следующих условиях:
- Отсутствие V2Ray-транспорта (сырой TCP + TLS)
- Отсутствие мультиплексирования
- Отсутствие Vision flow (у всех пользователей пустое поле flow)

Это позволяет ядру обрабатывать TLS-шифрование для повышения производительности.

## Архитектура исходящих соединений (Outbound)

```go
type Outbound struct {
    outbound.Adapter
    logger          logger.ContextLogger
    dialer          N.Dialer
    client          *vless.Client        // VLESS-клиент sing-vmess
    serverAddr      M.Socksaddr
    multiplexDialer *mux.Client
    tlsConfig       tls.Config
    tlsDialer       tls.Dialer
    transport       adapter.V2RayClientTransport
    packetAddr      bool     // использовать кодирование packetaddr
    xudp            bool     // использовать кодирование XUDP (по умолчанию)
}
```

### Поток установки соединения

```go
func (h *vlessDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    // 1. Установить транспортное соединение
    if h.transport != nil {
        conn = h.transport.DialContext(ctx)
    } else if h.tlsDialer != nil {
        conn = h.tlsDialer.DialTLSContext(ctx, h.serverAddr)
    } else {
        conn = h.dialer.DialContext(ctx, "tcp", h.serverAddr)
    }

    // 2. Рукопожатие протокола
    switch network {
    case "tcp":
        return h.client.DialEarlyConn(conn, destination)
    case "udp":
        if h.xudp {
            return h.client.DialEarlyXUDPPacketConn(conn, destination)
        } else if h.packetAddr {
            packetConn = h.client.DialEarlyPacketConn(conn, packetaddr.SeqPacketMagicAddress)
            return packetaddr.NewConn(packetConn, destination)
        } else {
            return h.client.DialEarlyPacketConn(conn, destination)
        }
    }
}
```

### Ранние данные (Early Data)

`DialEarlyConn` откладывает рукопожатие VLESS до первой записи. Заголовок VLESS отправляется вместе с первым пакетом данных, сокращая количество раундов обмена.

### Мультиплексирование

При включённом мультиплексировании:

```go
outbound.multiplexDialer = mux.NewClientWithOptions((*vlessDialer)(outbound), logger, options.Multiplex)
```

Mux-клиент оборачивает VLESS-dialer. Несколько логических соединений используют одно VLESS-соединение.

## Кодирование UDP-пакетов

VLESS поддерживает три режима кодирования UDP:

### XUDP (по умолчанию)

Адресация пакетов — каждый UDP-пакет несёт собственный адрес назначения. Обеспечивает Full-Cone NAT.

```go
h.client.DialEarlyXUDPPacketConn(conn, destination)
```

### PacketAddr

Аналогично XUDP, но использует другой формат данных (`packetaddr.SeqPacketMagicAddress`).

### Legacy

Простое кодирование VLESS-пакетов — все пакеты идут к одному назначению.

```go
h.client.DialEarlyPacketConn(conn, destination)
```

## Конфигурация

```json
{
  "inbounds": [{
    "type": "vless",
    "listen": ":443",
    "users": [
      { "uuid": "...", "name": "user1", "flow": "" }
    ],
    "tls": { ... },
    "transport": { "type": "ws", "path": "/vless" },
    "multiplex": { "enabled": true }
  }],
  "outbounds": [{
    "type": "vless",
    "server": "example.com",
    "server_port": 443,
    "uuid": "...",
    "flow": "",
    "packet_encoding": "xudp",
    "tls": { ... },
    "transport": { "type": "ws", "path": "/vless" },
    "multiplex": { "enabled": true }
  }]
}
```

## Ключевые отличия от Xray-core VLESS

| Аспект | Xray-core | sing-box |
|--------|----------|----------|
| Vision/XTLS | Полная поддержка (unsafe.Pointer) | Не поддерживается |
| Формат данных | Встроенное кодирование | Библиотека `sing-vmess/vless` |
| Fallback | Встроенный (name→ALPN→path) | Не поддерживается (используйте отдельный слушатель) |
| XUDP | Встроенный с GlobalID | `sing-vmess` XUDP |
| Мультиплексирование | Встроенные mux-фреймы | `sing-mux` (на основе smux) |
| Поток данных | Pipe Reader/Writer | Прямая передача через net.Conn |
| Предварительное соединение | Пул соединений | Не встроен |

## Формат данных (из sing-vmess)

### Заголовок запроса
```
[1B Version=0x00]
[16B UUID]
[1B Addons length (N)]
[NB Addons protobuf]
[1B Command: 0x01=TCP, 0x02=UDP, 0x03=Mux]
[Address: Port(2B) + Type(1B) + Addr(var)]
```

### Заголовок ответа
```
[1B Version=0x00]
[1B Addons length]
[NB Addons]
```

Формат данных совместим с VLESS в Xray-core.
