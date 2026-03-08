# Протокол Hysteria2

Hysteria2 — это прокси-протокол на основе QUIC, отличающийся согласованием пропускной способности через алгоритм управления перегрузкой Brutal, обфускацией Salamander и маскировкой под HTTP/3. sing-box делегирует реализацию протокола библиотеке `sing-quic/hysteria2`.

**Исходный код**: `protocol/hysteria2/inbound.go`, `protocol/hysteria2/outbound.go`, `sing-quic/hysteria2`

## Обзор архитектуры

И входящее, и исходящее соединения — это тонкие обёртки вокруг библиотеки `sing-quic/hysteria2`:

```go
// Входящее соединение (Inbound)
type Inbound struct {
    inbound.Adapter
    router       adapter.Router
    logger       log.ContextLogger
    listener     *listener.Listener
    tlsConfig    tls.ServerConfig
    service      *hysteria2.Service[int]
    userNameList []string
}

// Исходящее соединение (Outbound)
type Outbound struct {
    outbound.Adapter
    logger logger.ContextLogger
    client *hysteria2.Client
}
```

## Требование TLS

Hysteria2 безусловно требует TLS с обеих сторон:

```go
if options.TLS == nil || !options.TLS.Enabled {
    return nil, C.ErrTLSRequired
}
```

## Обфускация Salamander

Salamander — единственный поддерживаемый тип обфускации. Он оборачивает QUIC-пакеты в слой обфускации, чтобы предотвратить их идентификацию как QUIC при глубокой инспекции пакетов:

```go
var salamanderPassword string
if options.Obfs != nil {
    if options.Obfs.Password == "" {
        return nil, E.New("missing obfs password")
    }
    switch options.Obfs.Type {
    case hysteria2.ObfsTypeSalamander:
        salamanderPassword = options.Obfs.Password
    default:
        return nil, E.New("unknown obfs type: ", options.Obfs.Type)
    }
}
```

При включённом Salamander пароль должен совпадать между клиентом и сервером.

## Согласование пропускной способности (Brutal CC)

Ключевая особенность Hysteria2 — алгоритм управления перегрузкой Brutal, требующий от клиента объявления пропускной способности. Сервер также может устанавливать ограничения:

```go
service, err := hysteria2.NewService[int](hysteria2.ServiceOptions{
    Context:               ctx,
    Logger:                logger,
    BrutalDebug:           options.BrutalDebug,
    SendBPS:               uint64(options.UpMbps * hysteria.MbpsToBps),
    ReceiveBPS:            uint64(options.DownMbps * hysteria.MbpsToBps),
    SalamanderPassword:    salamanderPassword,
    TLSConfig:             tlsConfig,
    IgnoreClientBandwidth: options.IgnoreClientBandwidth,
    UDPTimeout:            udpTimeout,
    Handler:               inbound,
    MasqueradeHandler:     masqueradeHandler,
})
```

Ключевые поля пропускной способности:

- **SendBPS / ReceiveBPS**: Пропускная способность сервера на отправку и приём в битах в секунду, конвертированная из Мбит/с через `hysteria.MbpsToBps`
- **IgnoreClientBandwidth**: При значении true сервер игнорирует объявленную клиентом пропускную способность и использует свои настройки
- **BrutalDebug**: Включает отладочное логирование управления перегрузкой

Исходящее соединение аналогично объявляет свою пропускную способность:

```go
client, err := hysteria2.NewClient(hysteria2.ClientOptions{
    SendBPS:    uint64(options.UpMbps * hysteria.MbpsToBps),
    ReceiveBPS: uint64(options.DownMbps * hysteria.MbpsToBps),
    // ...
})
```

## Маскировка

Когда приходит не-Hysteria2 трафик (например, от веб-браузера), входящее соединение может отдавать маскировочный ответ. Поддерживаются три типа маскировки:

### Файловый сервер
```go
case C.Hysterai2MasqueradeTypeFile:
    masqueradeHandler = http.FileServer(http.Dir(options.Masquerade.FileOptions.Directory))
```

### Обратный прокси
```go
case C.Hysterai2MasqueradeTypeProxy:
    masqueradeURL, _ := url.Parse(options.Masquerade.ProxyOptions.URL)
    masqueradeHandler = &httputil.ReverseProxy{
        Rewrite: func(r *httputil.ProxyRequest) {
            r.SetURL(masqueradeURL)
            if !options.Masquerade.ProxyOptions.RewriteHost {
                r.Out.Host = r.In.Host
            }
        },
    }
```

### Статическая строка
```go
case C.Hysterai2MasqueradeTypeString:
    masqueradeHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if options.Masquerade.StringOptions.StatusCode != 0 {
            w.WriteHeader(options.Masquerade.StringOptions.StatusCode)
        }
        w.Write([]byte(options.Masquerade.StringOptions.Content))
    })
```

## Переключение портов (Port Hopping)

Исходящее соединение поддерживает переключение портов — подключение к нескольким портам сервера для обхода ограничения скорости на отдельных портах:

```go
client, err := hysteria2.NewClient(hysteria2.ClientOptions{
    ServerAddress: options.ServerOptions.Build(),
    ServerPorts:   options.ServerPorts,         // список диапазонов портов
    HopInterval:   time.Duration(options.HopInterval),  // частота переключения портов
    // ...
})
```

## Модель слушателя

В отличие от протоколов на основе TCP, Hysteria2 слушает на UDP (QUIC). Входящее соединение начинает с прослушивания UDP-пакетов и передачи их QUIC-сервису:

```go
func (h *Inbound) Start(stage adapter.StartStage) error {
    if stage != adapter.StartStateStart {
        return nil
    }
    h.tlsConfig.Start()
    packetConn, err := h.listener.ListenUDP()
    if err != nil {
        return err
    }
    return h.service.Start(packetConn)
}
```

## Управление пользователями

Пользователи идентифицируются по целочисленному индексу, с параллельным списком имён для логирования:

```go
userList := make([]int, 0, len(options.Users))
userNameList := make([]string, 0, len(options.Users))
userPasswordList := make([]string, 0, len(options.Users))
for index, user := range options.Users {
    userList = append(userList, index)
    userNameList = append(userNameList, user.Name)
    userPasswordList = append(userPasswordList, user.Password)
}
service.UpdateUsers(userList, userPasswordList)
```

Аутентификация использует индекс пользователя, сохранённый в контексте:

```go
userID, _ := auth.UserFromContext[int](ctx)
if userName := h.userNameList[userID]; userName != "" {
    metadata.User = userName
}
```

## Обработка соединений

Как TCP, так и UDP-соединения следуют стандартному паттерну sing-box:

```go
func (h *Inbound) NewConnectionEx(ctx, conn, source, destination, onClose) {
    // Установить поля метаданных
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}

func (h *Inbound) NewPacketConnectionEx(ctx, conn, source, destination, onClose) {
    // Установить поля метаданных
    h.router.RoutePacketConnectionEx(ctx, conn, metadata, onClose)
}
```

## Исходящее соединение

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    switch N.NetworkName(network) {
    case N.NetworkTCP:
        return h.client.DialConn(ctx, destination)
    case N.NetworkUDP:
        conn, err := h.ListenPacket(ctx, destination)
        return bufio.NewBindPacketConn(conn, destination), nil
    }
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    return h.client.ListenPacket(ctx)
}
```

## Обновление интерфейса

Исходящее соединение реализует `adapter.InterfaceUpdateListener` для обработки смены сети путём закрытия QUIC-соединения:

```go
func (h *Outbound) InterfaceUpdated() {
    h.client.CloseWithError(E.New("network changed"))
}
```

## Примеры конфигурации

### Входящее соединение (Inbound)

```json
{
  "type": "hysteria2",
  "tag": "hy2-in",
  "listen": "::",
  "listen_port": 443,
  "up_mbps": 100,
  "down_mbps": 100,
  "obfs": {
    "type": "salamander",
    "password": "obfs-password"
  },
  "users": [
    { "name": "user1", "password": "user-password" }
  ],
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  },
  "masquerade": {
    "type": "proxy",
    "proxy": {
      "url": "https://www.example.com",
      "rewrite_host": true
    }
  }
}
```

### Исходящее соединение (Outbound)

```json
{
  "type": "hysteria2",
  "tag": "hy2-out",
  "server": "example.com",
  "server_port": 443,
  "up_mbps": 50,
  "down_mbps": 100,
  "password": "user-password",
  "obfs": {
    "type": "salamander",
    "password": "obfs-password"
  },
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```

### С переключением портов

```json
{
  "type": "hysteria2",
  "tag": "hy2-hop",
  "server": "example.com",
  "server_ports": "443,8443-8500",
  "hop_interval": "30s",
  "password": "user-password",
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```
