# Протокол ShadowTLS

ShadowTLS — это протокол транспортного уровня, который маскирует прокси-трафик под легитимный TLS-трафик, перехватывая TLS-рукопожатие с реальным сервером. Поддерживает три версии протокола с возрастающей сложностью.

**Исходный код**: `protocol/shadowtls/inbound.go`, `protocol/shadowtls/outbound.go`, `sing-shadowtls`

## Концепция протокола

В отличие от традиционных прокси на основе TLS, которые генерируют собственные сертификаты (обнаруживаемые при проверке сертификатов), ShadowTLS выполняет реальное TLS-рукопожатие с легитимным сервером (например, `www.microsoft.com`), делая рукопожатие неотличимым от обычного HTTPS-трафика для наблюдателей. После рукопожатия канал данных перехватывается для передачи прокси-трафика.

## Версии протокола

### Версия 1

Простейшая версия. Клиент инициирует TLS-рукопожатие через сервер ShadowTLS, который ретранслирует его на реальный TLS-сервер («сервер рукопожатия»). После завершения рукопожатия TLS-соединение перепрофилируется для передачи прокси-данных.

**Ограничение**: Принудительно использует TLS 1.2 для обеспечения предсказуемого поведения рукопожатия.

```go
if options.Version == 1 {
    options.TLS.MinVersion = "1.2"
    options.TLS.MaxVersion = "1.2"
}
```

### Версия 2

Добавляет аутентификацию на основе пароля. Сервер может отличить легитимных клиентов ShadowTLS от зондов. Поддерживает серверы рукопожатия по SNI:

```go
if options.Version > 1 {
    handshakeForServerName = make(map[string]shadowtls.HandshakeConfig)
    for _, entry := range options.HandshakeForServerName.Entries() {
        handshakeForServerName[entry.Key] = shadowtls.HandshakeConfig{
            Server: entry.Value.ServerOptions.Build(),
            Dialer: handshakeDialer,
        }
    }
}
```

### Версия 3

Наиболее продвинутая версия. Вводит привязку канала на основе session ID — клиент и сервер встраивают данные аутентификации в TLS session ID, обеспечивая верификацию без дополнительного обмена данными.

```go
case 3:
    if idConfig, loaded := tlsConfig.(tls.WithSessionIDGenerator); loaded {
        // Использовать хук session ID библиотеки TLS
        tlsHandshakeFunc = func(ctx, conn, sessionIDGenerator) error {
            idConfig.SetSessionIDGenerator(sessionIDGenerator)
            return tls.ClientHandshake(ctx, conn, tlsConfig)
        }
    } else {
        // Фоллбэк на стандартный TLS с ручной инъекцией session ID
        stdTLSConfig := tlsConfig.STDConfig()
        tlsHandshakeFunc = shadowtls.DefaultTLSHandshakeFunc(password, stdTLSConfig)
    }
```

## Архитектура входящих соединений (Inbound)

```go
type Inbound struct {
    inbound.Adapter
    router   adapter.Router
    logger   logger.ContextLogger
    listener *listener.Listener
    service  *shadowtls.Service
}
```

### Конфигурация сервиса

```go
service, _ := shadowtls.NewService(shadowtls.ServiceConfig{
    Version:  options.Version,
    Password: options.Password,
    Users: common.Map(options.Users, func(it option.ShadowTLSUser) shadowtls.User {
        return (shadowtls.User)(it)
    }),
    Handshake: shadowtls.HandshakeConfig{
        Server: options.Handshake.ServerOptions.Build(),
        Dialer: handshakeDialer,
    },
    HandshakeForServerName: handshakeForServerName,  // маршрутизация по SNI
    StrictMode:             options.StrictMode,
    WildcardSNI:            shadowtls.WildcardSNI(options.WildcardSNI),
    Handler:                (*inboundHandler)(inbound),
    Logger:                 logger,
})
```

Ключевые поля:

- **Handshake**: Целевой сервер рукопожатия по умолчанию
- **HandshakeForServerName**: Карта SNI -> сервер рукопожатия для мультидоменной поддержки
- **StrictMode**: Отклонять соединения, не прошедшие аутентификацию (вместо молчаливой пересылки)
- **WildcardSNI**: Принимать любое значение SNI (полезно для сценариев с CDN)

### Wildcard SNI

Опция `WildcardSNI` контролирует обработку SNI:

```go
serverIsDomain := options.Handshake.ServerIsDomain()
if options.WildcardSNI != option.ShadowTLSWildcardSNIOff {
    serverIsDomain = true  // принудительное разрешение домена для wildcard
}
```

### Поток соединения (Inbound)

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    // Сервис ShadowTLS обрабатывает всю ретрансляцию рукопожатия и извлечение данных
    err := h.service.NewConnection(ctx, conn, metadata.Source, metadata.Destination, onClose)
    N.CloseOnHandshakeFailure(conn, onClose, err)
}
```

После того как сервис ShadowTLS извлекает реальный поток данных, он вызывает обработчик входящего соединения:

```go
type inboundHandler Inbound

func (h *inboundHandler) NewConnectionEx(ctx, conn, source, destination, onClose) {
    metadata.Inbound = h.Tag()
    metadata.InboundType = h.Type()
    metadata.Source = source
    metadata.Destination = destination
    if userName, _ := auth.UserFromContext[string](ctx); userName != "" {
        metadata.User = userName
    }
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## Архитектура исходящих соединений (Outbound)

```go
type Outbound struct {
    outbound.Adapter
    client *shadowtls.Client
}
```

Исходящее соединение ShadowTLS работает только по TCP и служит **обёрткой транспорта** — обычно используется в цепочке с другим протоколом (например, Shadowsocks):

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    switch network {
    case "tcp":
        return h.client.DialContext(ctx)   // возвращает «чистое» соединение
    default:
        return nil, os.ErrInvalid          // UDP не поддерживается
    }
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    return nil, os.ErrInvalid              // UDP не поддерживается
}
```

### Требование TLS

Исходящее соединение ShadowTLS **требует** включения TLS:

```go
if options.TLS == nil || !options.TLS.Enabled {
    return nil, C.ErrTLSRequired
}
```

### Конфигурация клиента

```go
client, _ := shadowtls.NewClient(shadowtls.ClientConfig{
    Version:      options.Version,
    Password:     options.Password,
    Server:       options.ServerOptions.Build(),
    Dialer:       outboundDialer,
    TLSHandshake: tlsHandshakeFunc,   // рукопожатие, зависящее от версии
    Logger:       logger,
})
```

### TLS-рукопожатие в зависимости от версии

```go
var tlsHandshakeFunc shadowtls.TLSHandshakeFunc

switch options.Version {
case 1, 2:
    // Простой: просто выполнить TLS-рукопожатие
    tlsHandshakeFunc = func(ctx, conn, _ TLSSessionIDGeneratorFunc) error {
        return common.Error(tls.ClientHandshake(ctx, conn, tlsConfig))
    }

case 3:
    // Сложный: инъекция генератора session ID для привязки канала
    tlsHandshakeFunc = func(ctx, conn, sessionIDGenerator) error {
        idConfig.SetSessionIDGenerator(sessionIDGenerator)
        return common.Error(tls.ClientHandshake(ctx, conn, tlsConfig))
    }
}
```

## Как работает ShadowTLS (подробно)

```
Клиент                  Сервер ShadowTLS          Реальный TLS-сервер
  |                          |                          |
  |--- TLS ClientHello ---->|--- TLS ClientHello ----->|
  |                          |                          |
  |<-- TLS ServerHello -----|<-- TLS ServerHello ------|
  |<-- Certificate ---------|<-- Certificate ----------|
  |<-- ServerHelloDone -----|<-- ServerHelloDone ------|
  |                          |                          |
  |--- ClientKeyExchange -->|--- ClientKeyExchange --->|
  |--- ChangeCipherSpec --->|--- ChangeCipherSpec ---->|
  |--- Finished ----------->|--- Finished ------------>|
  |                          |                          |
  |<-- ChangeCipherSpec ----|<-- ChangeCipherSpec -----|
  |<-- Finished ------------|<-- Finished -------------|
  |                          |                          |
  |  [TLS-рукопожатие завершено - наблюдатель видит    |
  |   валидный сертификат]                              |
  |                          |                          |
  |=== Прокси-данные =======>|  [данные НЕ отправляются |
  |<=== Прокси-данные ========|   реальному TLS-серверу] |
```

После рукопожатия сервер ShadowTLS:
1. Отключается от реального TLS-сервера
2. Извлекает поток прокси-данных от клиента
3. Перенаправляет его в настроенный внутренний обработчик

## Типичный паттерн использования

ShadowTLS используется как **detour** для другого протокола:

```json
{
  "outbounds": [
    {
      "type": "shadowsocks",
      "tag": "ss-out",
      "detour": "shadowtls-out",
      "method": "2022-blake3-aes-256-gcm",
      "password": "ss-password"
    },
    {
      "type": "shadowtls",
      "tag": "shadowtls-out",
      "server": "my-server.com",
      "server_port": 443,
      "version": 3,
      "password": "shadowtls-password",
      "tls": {
        "enabled": true,
        "server_name": "www.microsoft.com"
      }
    }
  ]
}
```

Соединение Shadowsocks туннелируется через обёртку ShadowTLS, которая выполняет рукопожатие с реальным сертификатом `www.microsoft.com`.

## Пример конфигурации (Inbound)

```json
{
  "type": "shadowtls",
  "tag": "shadowtls-in",
  "listen": "::",
  "listen_port": 443,
  "version": 3,
  "users": [
    { "name": "user1", "password": "user-password" }
  ],
  "handshake": {
    "server": "www.microsoft.com",
    "server_port": 443
  },
  "handshake_for_server_name": {
    "www.google.com": {
      "server": "www.google.com",
      "server_port": 443
    }
  },
  "strict_mode": true
}
```
