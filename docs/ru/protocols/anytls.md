# Протокол AnyTLS

AnyTLS — это прокси-протокол на основе TLS, отличающийся мультиплексированием сессий, настраиваемыми схемами дополнения (padding) и управлением неактивными сессиями. sing-box интегрирует внешнюю библиотеку `sing-anytls` из проекта `anytls`.

**Исходный код**: `protocol/anytls/inbound.go`, `protocol/anytls/outbound.go`, `sing-anytls`

## Обзор архитектуры

```go
// Входящее соединение (Inbound)
type Inbound struct {
    inbound.Adapter
    tlsConfig tls.ServerConfig
    router    adapter.ConnectionRouterEx
    logger    logger.ContextLogger
    listener  *listener.Listener
    service   *anytls.Service
}

// Исходящее соединение (Outbound)
type Outbound struct {
    outbound.Adapter
    dialer    tls.Dialer
    server    M.Socksaddr
    tlsConfig tls.Config
    client    *anytls.Client
    uotClient *uot.Client
    logger    log.ContextLogger
}
```

## Реализация входящих соединений (Inbound)

### Обработка TLS

В отличие от протоколов вроде Hysteria2, которые требуют TLS, AnyTLS делает TLS опциональным на стороне входящего соединения — TLS-рукопожатие обрабатывается явно перед передачей сервису:

```go
if options.TLS != nil && options.TLS.Enabled {
    tlsConfig, err := tls.NewServer(ctx, logger, common.PtrValueOrDefault(options.TLS))
    inbound.tlsConfig = tlsConfig
}
```

Когда TLS настроен, каждое соединение проходит TLS-рукопожатие перед обработкой протокола:

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    if h.tlsConfig != nil {
        tlsConn, err := tls.ServerHandshake(ctx, conn, h.tlsConfig)
        if err != nil {
            N.CloseOnHandshakeFailure(conn, onClose, err)
            return
        }
        conn = tlsConn
    }
    err := h.service.NewConnection(ctx, conn, metadata.Source, onClose)
}
```

### Схема дополнения (Padding)

AnyTLS использует настраиваемую схему дополнения для обфускации паттернов трафика. Схема определяется как многострочная строка:

```go
paddingScheme := padding.DefaultPaddingScheme
if len(options.PaddingScheme) > 0 {
    paddingScheme = []byte(strings.Join(options.PaddingScheme, "\n"))
}

service, _ := anytls.NewService(anytls.ServiceConfig{
    Users:         common.Map(options.Users, func(it option.AnyTLSUser) anytls.User {
        return (anytls.User)(it)
    }),
    PaddingScheme: paddingScheme,
    Handler:       (*inboundHandler)(inbound),
    Logger:        logger,
})
```

### Слушатель только TCP

AnyTLS поддерживает только TCP-соединения:

```go
inbound.listener = listener.New(listener.Options{
    Network:           []string{N.NetworkTCP},
    ConnectionHandler: inbound,
})
```

### Паттерн обработчика входящих соединений

AnyTLS использует паттерн обработчика с приведением типов (как и ShadowTLS). Тип `Inbound` обрабатывает сырые соединения, а алиас типа `inboundHandler` обрабатывает декодированные соединения:

```go
type inboundHandler Inbound

func (h *inboundHandler) NewConnectionEx(ctx, conn, source, destination, onClose) {
    metadata.Destination = destination.Unwrap()
    if userName, _ := auth.UserFromContext[string](ctx); userName != "" {
        metadata.User = userName
    }
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## Реализация исходящих соединений (Outbound)

### Требование TLS

Исходящее соединение требует TLS:

```go
if options.TLS == nil || !options.TLS.Enabled {
    return nil, C.ErrTLSRequired
}
```

### Несовместимость с TCP Fast Open

AnyTLS явно несовместим с TCP Fast Open. TFO создаёт ленивые соединения, откладывающие установку до первой записи, но AnyTLS требует удалённый адрес во время рукопожатия:

```go
if options.DialerOptions.TCPFastOpen {
    return nil, E.New("tcp_fast_open is not supported with anytls outbound")
}
```

### Пул сессий

Клиент поддерживает пул неактивных TLS-сессий для повторного использования соединений. Управление сессиями настраивается:

```go
client, _ := anytls.NewClient(ctx, anytls.ClientConfig{
    Password:                 options.Password,
    IdleSessionCheckInterval: options.IdleSessionCheckInterval.Build(),
    IdleSessionTimeout:       options.IdleSessionTimeout.Build(),
    MinIdleSession:           options.MinIdleSession,
    DialOut:                  outbound.dialOut,
    Logger:                   logger,
})
```

Ключевые параметры сессий:
- **IdleSessionCheckInterval**: Как часто проверять неактивные сессии
- **IdleSessionTimeout**: Через сколько времени неактивная сессия будет закрыта
- **MinIdleSession**: Минимальное количество неактивных сессий, поддерживаемых в пуле

### Функция Dial Out

Обратный вызов `DialOut` создаёт новые TLS-соединения для пула сессий:

```go
func (h *Outbound) dialOut(ctx context.Context) (net.Conn, error) {
    return h.dialer.DialTLSContext(ctx, h.server)
}
```

### TCP-соединения через CreateProxy

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    switch N.NetworkName(network) {
    case N.NetworkTCP:
        return h.client.CreateProxy(ctx, destination)
    case N.NetworkUDP:
        return h.uotClient.DialContext(ctx, network, destination)
    }
}
```

### UDP через UoT

UDP поддерживается через UDP-over-TCP с использованием пакета `uot`. UoT-клиент оборачивает метод `CreateProxy` клиента AnyTLS:

```go
outbound.uotClient = &uot.Client{
    Dialer:  (anytlsDialer)(client.CreateProxy),
    Version: uot.Version,
}
```

Адаптер `anytlsDialer` преобразует сигнатуру функции `CreateProxy` в интерфейс `N.Dialer`:

```go
type anytlsDialer func(ctx context.Context, destination M.Socksaddr) (net.Conn, error)

func (d anytlsDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    return d(ctx, destination)
}

func (d anytlsDialer) ListenPacket(ctx, destination) (net.PacketConn, error) {
    return nil, os.ErrInvalid
}
```

### UoT-маршрутизатор (Inbound)

Входящее соединение оборачивает свой маршрутизатор поддержкой UoT:

```go
inbound.router = uot.NewRouter(router, logger)
```

## Примеры конфигурации

### Входящее соединение (Inbound)

```json
{
  "type": "anytls",
  "tag": "anytls-in",
  "listen": "::",
  "listen_port": 443,
  "users": [
    { "name": "user1", "password": "user-password" }
  ],
  "padding_scheme": [
    "0:100",
    "200:500"
  ],
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  }
}
```

### Исходящее соединение (Outbound)

```json
{
  "type": "anytls",
  "tag": "anytls-out",
  "server": "example.com",
  "server_port": 443,
  "password": "user-password",
  "idle_session_check_interval": "30s",
  "idle_session_timeout": "30s",
  "min_idle_session": 1,
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```
