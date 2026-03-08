# Протокол TUIC

TUIC — это прокси-протокол на основе QUIC, отличающийся аутентификацией по UUID, настраиваемым управлением перегрузкой и двумя различными режимами ретрансляции UDP. sing-box делегирует реализацию протокола библиотеке `sing-quic/tuic`.

**Исходный код**: `protocol/tuic/inbound.go`, `protocol/tuic/outbound.go`, `sing-quic/tuic`

## Обзор архитектуры

```go
// Входящее соединение (Inbound)
type Inbound struct {
    inbound.Adapter
    router       adapter.ConnectionRouterEx
    logger       log.ContextLogger
    listener     *listener.Listener
    tlsConfig    tls.ServerConfig
    server       *tuic.Service[int]
    userNameList []string
}

// Исходящее соединение (Outbound)
type Outbound struct {
    outbound.Adapter
    logger    logger.ContextLogger
    client    *tuic.Client
    udpStream bool
}
```

## Требование TLS

Как и Hysteria2, TUIC требует TLS с обеих сторон:

```go
if options.TLS == nil || !options.TLS.Enabled {
    return nil, C.ErrTLSRequired
}
```

## Аутентификация на основе UUID

Пользователи аутентифицируются по паре UUID + пароль. UUID разбирается из строкового формата:

```go
var userUUIDList [][16]byte
for index, user := range options.Users {
    userUUID, err := uuid.FromString(user.UUID)
    if err != nil {
        return nil, E.Cause(err, "invalid uuid for user ", index)
    }
    userUUIDList = append(userUUIDList, userUUID)
    userPasswordList = append(userPasswordList, user.Password)
}
service.UpdateUsers(userList, userUUIDList, userPasswordList)
```

Исходящее соединение аналогично использует один UUID + пароль:

```go
userUUID, err := uuid.FromString(options.UUID)
client, _ := tuic.NewClient(tuic.ClientOptions{
    UUID:     userUUID,
    Password: options.Password,
    // ...
})
```

## Управление перегрузкой

TUIC поддерживает настраиваемые алгоритмы управления перегрузкой:

```go
service, _ := tuic.NewService[int](tuic.ServiceOptions{
    CongestionControl: options.CongestionControl,
    // ...
})
```

Поле `CongestionControl` принимает названия алгоритмов (например, "bbr", "cubic"). Это применяется как к входящим, так и к исходящим соединениям.

## Рукопожатие Zero-RTT

TUIC поддерживает QUIC-рукопожатие 0-RTT для снижения задержки:

```go
tuic.ServiceOptions{
    ZeroRTTHandshake: options.ZeroRTTHandshake,
    // ...
}
```

## Таймаут аутентификации и Heartbeat

```go
tuic.ServiceOptions{
    AuthTimeout: time.Duration(options.AuthTimeout),
    Heartbeat:   time.Duration(options.Heartbeat),
    // ...
}
```

- **AuthTimeout**: Ограничение времени для завершения аутентификации клиентом после QUIC-рукопожатия
- **Heartbeat**: Интервал keep-alive для поддержания QUIC-соединения

## Режимы ретрансляции UDP

TUIC имеет два режима ретрансляции UDP, настраиваемых только на стороне исходящего соединения:

### Нативный режим (по умолчанию)

Каждый UDP-пакет отправляется как отдельная QUIC-датаграмма. Это наиболее эффективный режим, но требует поддержки QUIC-датаграмм:

```go
case "native":
    // tuicUDPStream остаётся false
```

### Режим QUIC Stream

UDP-пакеты сериализуются через QUIC-поток. Этот режим работает, когда QUIC-датаграммы недоступны:

```go
case "quic":
    tuicUDPStream = true
```

### Режим UDP-over-Stream

Третий вариант (`udp_over_stream`) использует кодирование UoT (UDP-over-TCP). Он взаимоисключающий с `udp_relay_mode`:

```go
if options.UDPOverStream && options.UDPRelayMode != "" {
    return nil, E.New("udp_over_stream is conflict with udp_relay_mode")
}
```

При активном `udp_over_stream` UDP-соединения туннелируются через TCP-подобный поток с использованием пакета `uot`:

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    case N.NetworkUDP:
        if h.udpStream {
            streamConn, _ := h.client.DialConn(ctx, uot.RequestDestination(uot.Version))
            return uot.NewLazyConn(streamConn, uot.Request{
                IsConnect:   true,
                Destination: destination,
            }), nil
        }
}
```

## UoT-маршрутизатор (Inbound)

Входящее соединение оборачивает свой маршрутизатор поддержкой UoT для обработки соединений UDP-over-TCP:

```go
inbound.router = uot.NewRouter(router, logger)
```

## Модель слушателя

Как и Hysteria2, TUIC слушает на UDP:

```go
func (h *Inbound) Start(stage adapter.StartStage) error {
    h.tlsConfig.Start()
    packetConn, _ := h.listener.ListenUDP()
    return h.server.Start(packetConn)
}
```

## Обработка соединений

Стандартная маршрутизация TCP/UDP-соединений sing-box с извлечением пользователя из контекста:

```go
func (h *Inbound) NewConnectionEx(ctx, conn, source, destination, onClose) {
    userID, _ := auth.UserFromContext[int](ctx)
    if userName := h.userNameList[userID]; userName != "" {
        metadata.User = userName
    }
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## Исходящие соединения

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    switch N.NetworkName(network) {
    case N.NetworkTCP:
        return h.client.DialConn(ctx, destination)
    case N.NetworkUDP:
        if h.udpStream {
            // путь UoT
        } else {
            conn, _ := h.ListenPacket(ctx, destination)
            return bufio.NewBindPacketConn(conn, destination), nil
        }
    }
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    if h.udpStream {
        streamConn, _ := h.client.DialConn(ctx, uot.RequestDestination(uot.Version))
        return uot.NewLazyConn(streamConn, uot.Request{
            IsConnect:   false,
            Destination: destination,
        }), nil
    }
    return h.client.ListenPacket(ctx)
}
```

## Обновление интерфейса

Как и Hysteria2, TUIC закрывает QUIC-соединение при смене сети:

```go
func (h *Outbound) InterfaceUpdated() {
    _ = h.client.CloseWithError(E.New("network changed"))
}
```

## Примеры конфигурации

### Входящее соединение (Inbound)

```json
{
  "type": "tuic",
  "tag": "tuic-in",
  "listen": "::",
  "listen_port": 443,
  "users": [
    {
      "name": "user1",
      "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
      "password": "user-password"
    }
  ],
  "congestion_control": "bbr",
  "zero_rtt_handshake": true,
  "auth_timeout": "3s",
  "heartbeat": "10s",
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  }
}
```

### Исходящее соединение (Outbound) — нативный UDP

```json
{
  "type": "tuic",
  "tag": "tuic-out",
  "server": "example.com",
  "server_port": 443,
  "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
  "password": "user-password",
  "congestion_control": "bbr",
  "udp_relay_mode": "native",
  "zero_rtt_handshake": true,
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```

### Исходящее соединение (Outbound) — UDP over Stream

```json
{
  "type": "tuic",
  "tag": "tuic-uot",
  "server": "example.com",
  "server_port": 443,
  "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
  "password": "user-password",
  "udp_over_stream": true,
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```
