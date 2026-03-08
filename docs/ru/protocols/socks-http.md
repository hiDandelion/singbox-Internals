# Протоколы SOCKS, HTTP и Mixed

sing-box реализует SOCKS4/5, HTTP CONNECT и комбинированный «mixed» слушатель с автоматическим определением протокола. Все три разделяют схожие паттерны: слушатель только TCP, опциональный TLS, аутентификация по имени пользователя/паролю и поддержка UoT (UDP-over-TCP).

**Исходный код**: `protocol/socks/inbound.go`, `protocol/http/inbound.go`, `protocol/mixed/inbound.go`, `protocol/socks/outbound.go`, `protocol/http/outbound.go`

## Входящее соединение SOCKS (Inbound)

### Архитектура

```go
type Inbound struct {
    inbound.Adapter
    router        adapter.ConnectionRouterEx
    logger        logger.ContextLogger
    listener      *listener.Listener
    authenticator *auth.Authenticator
    udpTimeout    time.Duration
}
```

Входящее соединение SOCKS реализует `adapter.TCPInjectableInbound`:

```go
var _ adapter.TCPInjectableInbound = (*Inbound)(nil)
```

### Обработка соединений

SOCKS-соединения делегируются `sing/protocol/socks.HandleConnectionEx`, который выполняет полное рукопожатие SOCKS4/5:

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    err := socks.HandleConnectionEx(ctx, conn, std_bufio.NewReader(conn),
        h.authenticator,
        adapter.NewUpstreamHandlerEx(metadata, h.newUserConnection, h.streamUserPacketConnection),
        h.listener,         // слушатель для UDP associate
        h.udpTimeout,
        metadata.Source,
        onClose,
    )
    N.CloseOnHandshakeFailure(conn, onClose, err)
}
```

Обработчик получает декодированные TCP-соединения и UDP-пакетные соединения после SOCKS-рукопожатия:

```go
func (h *Inbound) newUserConnection(ctx, conn, metadata, onClose) {
    metadata.Inbound = h.Tag()
    metadata.InboundType = h.Type()
    user, loaded := auth.UserFromContext[string](ctx)
    if loaded {
        metadata.User = user
    }
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### Поддержка UoT

Маршрутизатор оборачивается поддержкой UoT для обработки UDP-over-TCP:

```go
inbound.router = uot.NewRouter(router, logger)
```

### Слушатель только TCP

SOCKS слушает только TCP. UDP associate соединения обрабатываются через механизм UDP relay SOCKS5 (используя `listener` как цель UDP associate):

```go
inbound.listener = listener.New(listener.Options{
    Network:           []string{N.NetworkTCP},
    ConnectionHandler: inbound,
})
```

## Входящее соединение HTTP (Inbound)

### Архитектура

```go
type Inbound struct {
    inbound.Adapter
    router        adapter.ConnectionRouterEx
    logger        log.ContextLogger
    listener      *listener.Listener
    authenticator *auth.Authenticator
    tlsConfig     tls.ServerConfig
}
```

### Поддержка TLS с kTLS

Входящее соединение HTTP поддерживает TLS с включённой совместимостью kTLS:

```go
if options.TLS != nil {
    tlsConfig, _ := tls.NewServerWithOptions(tls.ServerOptions{
        KTLSCompatible: true,
    })
    inbound.tlsConfig = tlsConfig
}
```

### Обработка соединений

Сначала выполняется TLS-рукопожатие (если настроено), затем обработчик HTTP CONNECT обрабатывает запрос:

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    if h.tlsConfig != nil {
        tlsConn, _ := tls.ServerHandshake(ctx, conn, h.tlsConfig)
        conn = tlsConn
    }
    err := http.HandleConnectionEx(ctx, conn, std_bufio.NewReader(conn),
        h.authenticator,
        adapter.NewUpstreamHandlerEx(metadata, h.newUserConnection, h.streamUserPacketConnection),
        metadata.Source,
        onClose,
    )
}
```

### Системный прокси

Входящее соединение HTTP может настроить себя как системный прокси:

```go
inbound.listener = listener.New(listener.Options{
    SetSystemProxy:    options.SetSystemProxy,
    SystemProxySOCKS:  false,
})
```

## Входящее соединение Mixed (Inbound)

Mixed inbound комбинирует SOCKS и HTTP на одном порту, считывая первый байт каждого соединения.

### Архитектура

```go
type Inbound struct {
    inbound.Adapter
    router        adapter.ConnectionRouterEx
    logger        log.ContextLogger
    listener      *listener.Listener
    authenticator *auth.Authenticator
    tlsConfig     tls.ServerConfig
    udpTimeout    time.Duration
}
```

### Определение протокола

Основная логика считывает первый байт для определения протокола:

```go
func (h *Inbound) newConnection(ctx, conn, metadata, onClose) error {
    if h.tlsConfig != nil {
        conn = tls.ServerHandshake(ctx, conn, h.tlsConfig)
    }
    reader := std_bufio.NewReader(conn)
    headerBytes, _ := reader.Peek(1)

    switch headerBytes[0] {
    case socks4.Version, socks5.Version:
        // SOCKS4 (0x04) или SOCKS5 (0x05)
        return socks.HandleConnectionEx(ctx, conn, reader, h.authenticator, ...)
    default:
        // Всё остальное считается HTTP
        return http.HandleConnectionEx(ctx, conn, reader, h.authenticator, ...)
    }
}
```

- **SOCKS4**: Первый байт `0x04`
- **SOCKS5**: Первый байт `0x05`
- **HTTP**: Любой другой первый байт (обычно `C` для CONNECT, `G` для GET и т.д.)

### Системный прокси (Mixed)

Когда mixed установлен как системный прокси, он объявляет SOCKS-порт:

```go
inbound.listener = listener.New(listener.Options{
    SetSystemProxy:    options.SetSystemProxy,
    SystemProxySOCKS:  true,  // Объявить SOCKS-порт в системном прокси
})
```

## Исходящее соединение SOCKS (Outbound)

Исходящее соединение SOCKS подключается через вышестоящий SOCKS5-сервер. Оно реализовано в `protocol/socks/outbound.go` и использует тип `Client` из библиотеки `sing/protocol/socks`.

## Исходящее соединение HTTP (Outbound)

Исходящее соединение HTTP подключается через вышестоящий HTTP CONNECT прокси. Поддерживает TLS к прокси-серверу.

## Общие паттерны

### Аутентификация пользователей

Все три типа входящих соединений используют одинаковый механизм аутентификации:

```go
authenticator := auth.NewAuthenticator(options.Users)
```

Пользователи — это структуры `auth.User` с полями `Username` и `Password`. Аутентификатор передаётся обработчикам протоколов.

### Метаданные пользователя

После аутентификации имя пользователя извлекается из контекста и сохраняется в метаданных:

```go
user, loaded := auth.UserFromContext[string](ctx)
if loaded {
    metadata.User = user
}
```

### TCP Injectable

Оба входящих соединения SOCKS и Mixed реализуют `adapter.TCPInjectableInbound`, позволяя другим компонентам внедрять TCP-соединения в них (используется механизмами прозрачного проксирования).

## Примеры конфигурации

### Входящее соединение SOCKS (Inbound)

```json
{
  "type": "socks",
  "tag": "socks-in",
  "listen": "127.0.0.1",
  "listen_port": 1080,
  "users": [
    { "username": "user1", "password": "pass1" }
  ]
}
```

### Входящее соединение HTTP (Inbound) — с TLS

```json
{
  "type": "http",
  "tag": "http-in",
  "listen": "127.0.0.1",
  "listen_port": 8080,
  "users": [
    { "username": "user1", "password": "pass1" }
  ],
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  },
  "set_system_proxy": true
}
```

### Входящее соединение Mixed (Inbound)

```json
{
  "type": "mixed",
  "tag": "mixed-in",
  "listen": "127.0.0.1",
  "listen_port": 2080,
  "users": [
    { "username": "user1", "password": "pass1" }
  ],
  "set_system_proxy": true
}
```
