# Протокол Shadowsocks

Shadowsocks — это зашифрованный прокси-протокол. sing-box реализует три режима входящих соединений (однопользовательский, многопользовательский, relay) и один исходящий, используя два различных библиотечных бэкенда: `sing-shadowsocks` для входящих и `sing-shadowsocks2` для исходящих соединений.

**Исходный код**: `protocol/shadowsocks/inbound.go`, `inbound_multi.go`, `inbound_relay.go`, `outbound.go`

## Обзор архитектуры

Входящее соединение Shadowsocks использует паттерн фабрики — единая функция `NewInbound` диспетчеризует к одной из трёх реализаций в зависимости от конфигурации:

```go
func NewInbound(ctx, router, logger, tag, options) (adapter.Inbound, error) {
    if len(options.Users) > 0 && len(options.Destinations) > 0 {
        return nil, E.New("users and destinations must not be combined")
    }
    if len(options.Users) > 0 || options.Managed {
        return newMultiInbound(...)    // Многопользовательский режим
    } else if len(options.Destinations) > 0 {
        return newRelayInbound(...)    // Режим relay
    } else {
        return newInbound(...)         // Однопользовательский режим
    }
}
```

## Разделение библиотек: sing-shadowsocks vs sing-shadowsocks2

| Библиотека | Использование | Шифры |
|---------|-------|---------|
| `sing-shadowsocks` | Входящие (сервер) | `shadowaead` (legacy AEAD), `shadowaead_2022` (SIP022) |
| `sing-shadowsocks2` | Исходящие (клиент) | Унифицированный интерфейс для всех методов |

Исходящее соединение импортирует `sing-shadowsocks2`, который предоставляет унифицированный интерфейс `shadowsocks.Method`:

```go
import "github.com/sagernet/sing-shadowsocks2"

method, _ := shadowsocks.CreateMethod(ctx, options.Method, shadowsocks.MethodOptions{
    Password: options.Password,
})
```

## Однопользовательское входящее соединение

```go
type Inbound struct {
    inbound.Adapter
    ctx      context.Context
    router   adapter.ConnectionRouterEx
    logger   logger.ContextLogger
    listener *listener.Listener
    service  shadowsocks.Service         // из sing-shadowsocks
}
```

### Выбор шифра

Строка метода определяет, какая реализация используется:

```go
switch {
case options.Method == shadowsocks.MethodNone:
    // Без шифрования (простой прокси)
    service = shadowsocks.NewNoneService(udpTimeout, handler)

case common.Contains(shadowaead.List, options.Method):
    // Legacy AEAD-шифры: aes-128-gcm, aes-256-gcm, chacha20-ietf-poly1305
    service = shadowaead.NewService(method, nil, password, udpTimeout, handler)

case common.Contains(shadowaead_2022.List, options.Method):
    // Шифры Shadowsocks 2022: 2022-blake3-aes-128-gcm и т.д.
    service = shadowaead_2022.NewServiceWithPassword(method, password, udpTimeout, handler, timeFunc)
}
```

### AEAD-шифры (Legacy)

Пакет `shadowaead` поддерживает оригинальные AEAD-методы:
- `aes-128-gcm`
- `aes-256-gcm`
- `chacha20-ietf-poly1305`

Получение ключа использует функцию EVP_BytesToKey (совместимую с OpenSSL).

### Shadowsocks 2022 (SIP022)

Пакет `shadowaead_2022` реализует современный протокол Shadowsocks 2022:
- `2022-blake3-aes-128-gcm`
- `2022-blake3-aes-256-gcm`
- `2022-blake3-chacha20-poly1305`

Ключевые особенности:
- Получение ключа на основе BLAKE3
- Встроенная защита от воспроизведения
- Аутентификация на основе времени (требует синхронизации NTP)

### Двухстековый слушатель

Однопользовательское входящее соединение слушает и TCP, и UDP:

```go
inbound.listener = listener.New(listener.Options{
    Network:                  options.Network.Build(),   // ["tcp", "udp"]
    ConnectionHandler:        inbound,                   // TCP
    PacketHandler:            inbound,                   // UDP
    ThreadUnsafePacketWriter: true,
})
```

TCP-соединения проходят через `NewConnectionEx`:
```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    err := h.service.NewConnection(ctx, conn, adapter.UpstreamMetadata(metadata))
    N.CloseOnHandshakeFailure(conn, onClose, err)
}
```

UDP-пакеты проходят через `NewPacketEx`:
```go
func (h *Inbound) NewPacketEx(buffer *buf.Buffer, source M.Socksaddr) {
    h.service.NewPacket(h.ctx, &stubPacketConn{h.listener.PacketWriter()}, buffer, M.Metadata{Source: source})
}
```

## Многопользовательское входящее соединение

```go
type MultiInbound struct {
    inbound.Adapter
    ctx      context.Context
    router   adapter.ConnectionRouterEx
    logger   logger.ContextLogger
    listener *listener.Listener
    service  shadowsocks.MultiService[int]   // многопользовательский сервис
    users    []option.ShadowsocksUser
    tracker  adapter.SSMTracker              // опциональное отслеживание трафика
}
```

### Создание многопользовательского сервиса

```go
if common.Contains(shadowaead_2022.List, options.Method) {
    // Многопользовательский SIP022: серверный пароль + пользовательские пароли (iPSK)
    service = shadowaead_2022.NewMultiServiceWithPassword[int](
        method, options.Password, udpTimeout, handler, timeFunc)
} else if common.Contains(shadowaead.List, options.Method) {
    // Многопользовательский Legacy AEAD
    service = shadowaead.NewMultiService[int](method, udpTimeout, handler)
}
```

Для SIP022 многопользовательский режим использует **identity PSK (iPSK)**: сервер имеет основной пароль, а каждый пользователь — подпароль, из которого получается уникальный ключ идентификации.

### Управление пользователями

Пользователи могут обновляться динамически:

```go
func (h *MultiInbound) UpdateUsers(users []string, uPSKs []string) error {
    err := h.service.UpdateUsersWithPasswords(indices, uPSKs)
    h.users = /* перестроить список пользователей */
    return err
}
```

### Поддержка управляемого сервера

`MultiInbound` реализует `adapter.ManagedSSMServer` для интеграции с управлением серверами Shadowsocks:

```go
var _ adapter.ManagedSSMServer = (*MultiInbound)(nil)

func (h *MultiInbound) SetTracker(tracker adapter.SSMTracker) {
    h.tracker = tracker
}
```

При установленном трекере соединения и пакеты оборачиваются для подсчёта трафика:

```go
if h.tracker != nil {
    conn = h.tracker.TrackConnection(conn, metadata)
}
```

## Входящее соединение в режиме Relay

Режим relay специфичен для Shadowsocks 2022 и действует как промежуточный relay-сервер:

```go
type RelayInbound struct {
    inbound.Adapter
    service      *shadowaead_2022.RelayService[int]
    destinations []option.ShadowsocksDestination
}
```

Каждое назначение имеет собственный пароль и целевой адрес:

```go
service = shadowaead_2022.NewRelayServiceWithPassword[int](
    method, password, udpTimeout, handler)
service.UpdateUsersWithPasswords(indices, passwords, destinations)
```

Relay получает соединения, зашифрованные ключом сервера, расшифровывает для нахождения идентификатора назначения, затем повторно шифрует ключом назначения перед пересылкой.

## Реализация исходящего соединения

Исходящее соединение использует `sing-shadowsocks2` для унифицированного интерфейса шифров:

```go
type Outbound struct {
    outbound.Adapter
    logger          logger.ContextLogger
    dialer          N.Dialer
    method          shadowsocks.Method     // из sing-shadowsocks2
    serverAddr      M.Socksaddr
    plugin          sip003.Plugin          // поддержка плагинов SIP003
    uotClient       *uot.Client            // UDP-over-TCP
    multiplexDialer *mux.Client
}
```

### Установка соединения

```go
func (h *shadowsocksDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    switch network {
    case "tcp":
        var outConn net.Conn
        if h.plugin != nil {
            outConn = h.plugin.DialContext(ctx)  // плагин SIP003
        } else {
            outConn = h.dialer.DialContext(ctx, "tcp", h.serverAddr)
        }
        return h.method.DialEarlyConn(outConn, destination)

    case "udp":
        outConn := h.dialer.DialContext(ctx, "udp", h.serverAddr)
        return bufio.NewBindPacketConn(h.method.DialPacketConn(outConn), destination)
    }
}
```

### Поддержка плагинов SIP003

Исходящее соединение Shadowsocks поддерживает плагины SIP003 (например, simple-obfs, v2ray-plugin):

```go
if options.Plugin != "" {
    outbound.plugin = sip003.CreatePlugin(ctx, options.Plugin, options.PluginOptions, ...)
}
```

### UDP-over-TCP

Когда нативный UDP недоступен, UoT обеспечивает UDP-транспорт через TCP-соединение Shadowsocks:

```go
uotOptions := options.UDPOverTCP
if uotOptions.Enabled {
    outbound.uotClient = &uot.Client{
        Dialer:  (*shadowsocksDialer)(outbound),
        Version: uotOptions.Version,
    }
}
```

## Защита от воспроизведения

Протокол Shadowsocks 2022 включает встроенную защиту от воспроизведения через nonce на основе времени. Функция времени NTP передаётся при создании сервиса:

```go
shadowaead_2022.NewServiceWithPassword(method, password, udpTimeout, handler,
    ntp.TimeFuncFromContext(ctx))  // обеспечивает синхронизированные по времени nonce
```

## Примеры конфигурации

### Однопользовательский

```json
{
  "type": "shadowsocks",
  "tag": "ss-in",
  "listen": "::",
  "listen_port": 8388,
  "method": "2022-blake3-aes-256-gcm",
  "password": "base64-encoded-32-byte-key"
}
```

### Многопользовательский (SIP022 iPSK)

```json
{
  "type": "shadowsocks",
  "tag": "ss-multi",
  "listen": "::",
  "listen_port": 8388,
  "method": "2022-blake3-aes-256-gcm",
  "password": "server-main-key-base64",
  "users": [
    { "name": "user1", "password": "user1-key-base64" },
    { "name": "user2", "password": "user2-key-base64" }
  ]
}
```

### Relay

```json
{
  "type": "shadowsocks",
  "tag": "ss-relay",
  "listen": "::",
  "listen_port": 8388,
  "method": "2022-blake3-aes-256-gcm",
  "password": "relay-server-key",
  "destinations": [
    {
      "name": "dest1",
      "password": "dest1-key",
      "server": "dest1.example.com",
      "server_port": 8388
    }
  ]
}
```

### Исходящее соединение

```json
{
  "type": "shadowsocks",
  "tag": "ss-out",
  "server": "example.com",
  "server_port": 8388,
  "method": "2022-blake3-aes-256-gcm",
  "password": "base64-key",
  "udp_over_tcp": {
    "enabled": true,
    "version": 2
  },
  "multiplex": {
    "enabled": true,
    "protocol": "h2mux"
  }
}
```
