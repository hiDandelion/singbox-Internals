# Протокол VMess

VMess — это нативный прокси-протокол V2Ray с аутентификацией на основе UUID и AEAD-шифрованием. sing-box полностью делегирует формат данных VMess библиотеке `sing-vmess`.

**Исходный код**: `protocol/vmess/inbound.go`, `protocol/vmess/outbound.go`, `sing-vmess`

## Интеграция sing-vmess

sing-box не реализует формат данных VMess самостоятельно. Вместо этого используется библиотека `github.com/sagernet/sing-vmess`, которая предоставляет:

- `vmess.Service[int]` -- обработчик протокола VMess на стороне сервера, обобщённый по типу ключа пользователя
- `vmess.Client` -- обработчик протокола VMess на стороне клиента
- `vmess.ServiceOption` / `vmess.ClientOption` -- функциональные опции для конфигурации
- `packetaddr` -- кодирование адресов пакетов для UDP-over-TCP

Это существенное отличие от **Xray-core**, который реализует VMess непосредственно в своей кодовой базе. Подход sing-box обеспечивает более чёткое разделение ответственности.

## Архитектура входящих соединений (Inbound)

```go
type Inbound struct {
    inbound.Adapter
    ctx       context.Context
    router    adapter.ConnectionRouterEx
    logger    logger.ContextLogger
    listener  *listener.Listener
    service   *vmess.Service[int]       // сервис sing-vmess, индексированный по индексу пользователя
    users     []option.VMessUser
    tlsConfig tls.ServerConfig
    transport adapter.V2RayServerTransport
}
```

### Поток конструирования

```go
func NewInbound(ctx, router, logger, tag, options) (adapter.Inbound, error) {
    // 1. Обернуть маршрутизатор поддержкой UoT (UDP-over-TCP)
    inbound.router = uot.NewRouter(router, logger)

    // 2. Обернуть маршрутизатор поддержкой mux (мультиплексирование)
    inbound.router = mux.NewRouterWithOptions(inbound.router, logger, options.Multiplex)

    // 3. Настроить опции VMess-сервиса
    //    - Функция времени NTP (VMess чувствителен к времени)
    //    - Отключить защиту заголовка при использовании V2Ray-транспорта
    serviceOptions = append(serviceOptions, vmess.ServiceWithTimeFunc(timeFunc))
    if options.Transport != nil {
        serviceOptions = append(serviceOptions, vmess.ServiceWithDisableHeaderProtection())
    }

    // 4. Создать сервис и зарегистрировать пользователей (индекс -> UUID + alterId)
    service := vmess.NewService[int](handler, serviceOptions...)
    service.UpdateUsers(indices, uuids, alterIds)

    // 5. Опциональный TLS
    // 6. Опциональный V2Ray-транспорт (WebSocket, gRPC, HTTP, QUIC)
    // 7. TCP-слушатель
}
```

### Ключевое решение: отключение защиты заголовка при транспорте

Когда настроен V2Ray-транспорт (WebSocket, gRPC и т.д.), передаётся `vmess.ServiceWithDisableHeaderProtection()`. Это связано с тем, что транспортный уровень уже обеспечивает собственное фреймирование, делая защиту заголовка VMess избыточной и потенциально проблемной.

### Обработка соединений

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    // 1. TLS-рукопожатие (только если TLS настроен И нет транспорта)
    //    При использовании транспорта TLS обрабатывается транспортным уровнем
    if h.tlsConfig != nil && h.transport == nil {
        conn = tls.ServerHandshake(ctx, conn, h.tlsConfig)
    }

    // 2. Делегирование сервису sing-vmess
    //    Дешифровка VMess, аутентификация, разбор команд — всё происходит здесь
    h.service.NewConnection(ctx, conn, metadata.Source, onClose)
}
```

После декодирования VMess-запроса сервис вызывает обработчики входящего соединения:

```go
func (h *Inbound) newConnectionEx(ctx, conn, metadata, onClose) {
    // Извлечение индекса пользователя из контекста (установлен sing-vmess)
    userIndex, _ := auth.UserFromContext[int](ctx)
    user := h.users[userIndex].Name
    metadata.User = user
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### Обработка адресов пакетов (packetaddr)

Для UDP-пакетных соединений VMess использует магический FQDN-адрес `packetaddr.SeqPacketMagicAddress` для сигнализации того, что соединение несёт мультиплексированные UDP-пакеты:

```go
func (h *Inbound) newPacketConnectionEx(ctx, conn, metadata, onClose) {
    if metadata.Destination.Fqdn == packetaddr.SeqPacketMagicAddress {
        metadata.Destination = M.Socksaddr{}
        conn = packetaddr.NewConn(bufio.NewNetPacketConn(conn), metadata.Destination)
    }
    h.router.RoutePacketConnectionEx(ctx, conn, metadata, onClose)
}
```

## Архитектура исходящих соединений (Outbound)

```go
type Outbound struct {
    outbound.Adapter
    logger          logger.ContextLogger
    dialer          N.Dialer
    client          *vmess.Client        // клиент sing-vmess
    serverAddr      M.Socksaddr
    multiplexDialer *mux.Client
    tlsConfig       tls.Config
    tlsDialer       tls.Dialer
    transport       adapter.V2RayClientTransport
    packetAddr      bool                 // кодирование packetaddr
    xudp            bool                 // кодирование XUDP
}
```

### Режимы кодирования пакетов

Исходящее соединение VMess поддерживает три режима кодирования пакетов для UDP:

| Режим | Поле | Описание |
|------|-------|-------------|
| (нет) | по умолчанию | Стандартный VMess UDP |
| `packetaddr` | `packetAddr=true` | Использует магический FQDN packetaddr для мультиплексированного UDP |
| `xudp` | `xudp=true` | Протокол XUDP для мультиплексирования UDP |

```go
switch options.PacketEncoding {
case "packetaddr":
    outbound.packetAddr = true
case "xudp":
    outbound.xudp = true
}
```

### Автоматический выбор безопасности

```go
security := options.Security
if security == "" {
    security = "auto"
}
if security == "auto" && outbound.tlsConfig != nil {
    security = "zero"  // Использовать нулевое шифрование при наличии TLS
}
```

Когда TLS уже настроен, VMess автоматически использует «zero»-безопасность для избежания двойного шифрования — оптимизация производительности.

### Опции клиента

```go
var clientOptions []vmess.ClientOption
if options.GlobalPadding {
    clientOptions = append(clientOptions, vmess.ClientWithGlobalPadding())
}
if options.AuthenticatedLength {
    clientOptions = append(clientOptions, vmess.ClientWithAuthenticatedLength())
}
client, _ := vmess.NewClient(options.UUID, security, options.AlterId, clientOptions...)
```

- **GlobalPadding**: Добавляет случайное дополнение ко всем пакетам для устойчивости к анализу трафика
- **AuthenticatedLength**: Включает аутентифицированную длину полезной нагрузки в заголовок (режим AEAD)

### Установка соединения

Тип `vmessDialer` обрабатывает фактическое соединение:

```go
func (h *vmessDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    // 1. Установить базовое соединение
    //    Приоритет: транспорт > TLS > сырой TCP
    if h.transport != nil {
        conn = h.transport.DialContext(ctx)
    } else if h.tlsDialer != nil {
        conn = h.tlsDialer.DialTLSContext(ctx, h.serverAddr)
    } else {
        conn = h.dialer.DialContext(ctx, "tcp", h.serverAddr)
    }

    // 2. Обернуть протоколом VMess (ранние данные / 0-RTT)
    switch network {
    case "tcp":
        return h.client.DialEarlyConn(conn, destination)
    case "udp":
        return h.client.DialEarlyPacketConn(conn, destination)
    }
}
```

Для `ListenPacket` режим кодирования определяет обёртку:

```go
func (h *vmessDialer) ListenPacket(ctx, destination) (net.PacketConn, error) {
    conn := /* установить соединение */
    if h.packetAddr {
        return packetaddr.NewConn(
            h.client.DialEarlyPacketConn(conn, M.Socksaddr{Fqdn: packetaddr.SeqPacketMagicAddress}),
            destination,
        )
    } else if h.xudp {
        return h.client.DialEarlyXUDPPacketConn(conn, destination)
    } else {
        return h.client.DialEarlyPacketConn(conn, destination)
    }
}
```

## Поддержка мультиплексирования

Мультиплексирование поддерживается через пакет `common/mux`. На стороне входящего соединения маршрутизатор оборачивается `mux.NewRouterWithOptions()`. На стороне исходящего соединения `mux.Client` оборачивает VMess-dialer:

```go
outbound.multiplexDialer, _ = mux.NewClientWithOptions((*vmessDialer)(outbound), logger, options.Multiplex)
```

При активном мультиплексировании `DialContext` и `ListenPacket` делегируют работу mux-клиенту вместо создания отдельных VMess-соединений.

## Отличия от Xray-core

| Аспект | sing-box | Xray-core |
|--------|----------|-----------|
| Реализация | Делегирование библиотеке `sing-vmess` | Встроенная реализация |
| AlterId | Поддерживается, но предпочтителен AEAD | Полная поддержка legacy |
| XUDP | Поддерживается через `sing-vmess` | Нативная реализация |
| Защита заголовка | Отключается при наличии транспорта | Всегда активна |
| Автовыбор безопасности | «zero» при наличии TLS | «auto» на основе AlterId |
| Синхронизация времени | Интеграция NTP через контекст | Только системное время |

## Пример конфигурации

```json
{
  "type": "vmess",
  "tag": "vmess-in",
  "listen": "::",
  "listen_port": 10086,
  "users": [
    {
      "name": "user1",
      "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
      "alterId": 0
    }
  ],
  "tls": {
    "enabled": true,
    "server_name": "example.com",
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  },
  "transport": {
    "type": "ws",
    "path": "/vmess"
  },
  "multiplex": {
    "enabled": true
  }
}
```

```json
{
  "type": "vmess",
  "tag": "vmess-out",
  "server": "example.com",
  "server_port": 10086,
  "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
  "security": "auto",
  "alter_id": 0,
  "global_padding": true,
  "authenticated_length": true,
  "packet_encoding": "xudp",
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  },
  "transport": {
    "type": "ws",
    "path": "/vmess"
  }
}
```
