# Протокол Trojan

Trojan — это прокси-протокол, разработанный для маскировки под HTTPS-трафик. Он использует схему аутентификации на основе паролей с хешированием SHA-224 и поддерживает фоллбэк на реальный веб-сервер для нераспознанного трафика.

**Исходный код**: `protocol/trojan/`, `transport/trojan/`

## Формат данных

Протокол Trojan использует простой, совместимый с TLS формат данных:

```
+----------+------+---------+----------+------+----------+
| Password | CRLF | Command | Address  | CRLF | Payload  |
| (56 hex) | \r\n | (1 byte)| (variable)|\r\n | (variable)|
+----------+------+---------+----------+------+----------+
```

### Получение пароля

Пароль преобразуется в 56-байтовый hex-кодированный хеш SHA-224:

```go
const KeyLength = 56

func Key(password string) [KeyLength]byte {
    var key [KeyLength]byte
    hash := sha256.New224()                    // SHA-224, НЕ SHA-256
    hash.Write([]byte(password))
    hex.Encode(key[:], hash.Sum(nil))          // 28 байт -> 56 hex-символов
    return key
}
```

SHA-224 производит 28 байт (224 бита), которые hex-кодируются ровно в 56 символов. Они передаются как есть (не в base64) при рукопожатии.

### Команды

```go
const (
    CommandTCP = 1     // TCP-подключение
    CommandUDP = 3     // UDP-ассоциация
    CommandMux = 0x7f  // Мультиплексирование Trojan-Go
)
```

### TCP-рукопожатие

```
Client -> Server:
  [56 bytes: hex SHA224(password)]
  [2 bytes: \r\n]
  [1 byte: 0x01 (TCP)]
  [variable: SOCKS address (type + addr + port)]
  [2 bytes: \r\n]
  [payload data...]
```

Реализация использует объединение буферов для эффективности:

```go
func ClientHandshake(conn net.Conn, key [KeyLength]byte, destination M.Socksaddr, payload []byte) error {
    headerLen := KeyLength + M.SocksaddrSerializer.AddrPortLen(destination) + 5
    header := buf.NewSize(headerLen + len(payload))
    header.Write(key[:])           // 56 байт хеша пароля
    header.Write(CRLF)            // \r\n
    header.WriteByte(CommandTCP)  // 0x01
    M.SocksaddrSerializer.WriteAddrPort(header, destination)
    header.Write(CRLF)            // \r\n
    header.Write(payload)         // объединённая первая полезная нагрузка
    conn.Write(header.Bytes())    // один системный вызов записи
}
```

### Формат UDP-пакетов

После начального рукопожатия (которое использует `CommandUDP`), UDP-пакеты фреймируются следующим образом:

```
+----------+--------+------+----------+
| Address  | Length | CRLF | Payload  |
| (variable)| (2 BE) | \r\n | (Length) |
+----------+--------+------+----------+
```

```go
func WritePacket(conn net.Conn, buffer *buf.Buffer, destination M.Socksaddr) error {
    header := buf.With(buffer.ExtendHeader(...))
    M.SocksaddrSerializer.WriteAddrPort(header, destination)
    binary.Write(header, binary.BigEndian, uint16(bufferLen))
    header.Write(CRLF)
    conn.Write(buffer.Bytes())
}

func ReadPacket(conn net.Conn, buffer *buf.Buffer) (M.Socksaddr, error) {
    destination := M.SocksaddrSerializer.ReadAddrPort(conn)
    var length uint16
    binary.Read(conn, binary.BigEndian, &length)
    rw.SkipN(conn, 2)  // пропустить CRLF
    buffer.ReadFullFrom(conn, int(length))
    return destination, nil
}
```

### Начальное UDP-рукопожатие

Первый UDP-пакет включает и заголовок Trojan, И адрес/длину первого пакета:

```
[56 bytes key][CRLF][0x03 UDP][dest addr][CRLF][dest addr][length][CRLF][payload]
                                  ^рукопожатие^    ^первый пакет^
```

Обратите внимание, что адрес назначения появляется дважды: один раз в рукопожатии, один раз во фрейме пакета.

## Сервисный уровень Trojan

`transport/trojan/service.go` реализует серверную обработку протокола:

```go
type Service[K comparable] struct {
    users           map[K][56]byte       // пользователь -> ключ
    keys            map[[56]byte]K       // ключ -> пользователь (обратный поиск)
    handler         Handler              // обработчик TCP + UDP
    fallbackHandler N.TCPConnectionHandlerEx
    logger          logger.ContextLogger
}
```

### Обработка соединений на стороне сервера

```go
func (s *Service[K]) NewConnection(ctx, conn, source, onClose) error {
    // 1. Прочитать 56-байтовый ключ пароля
    var key [KeyLength]byte
    n, err := conn.Read(key[:])
    if n != KeyLength {
        return s.fallback(ctx, conn, source, key[:n], ...)
    }

    // 2. Аутентификация
    if user, loaded := s.keys[key]; loaded {
        ctx = auth.ContextWithUser(ctx, user)
    } else {
        return s.fallback(ctx, conn, source, key[:], ...)
    }

    // 3. Пропустить CRLF, прочитать команду
    rw.SkipN(conn, 2)
    binary.Read(conn, binary.BigEndian, &command)

    // 4. Прочитать адрес назначения, пропустить завершающий CRLF
    destination := M.SocksaddrSerializer.ReadAddrPort(conn)
    rw.SkipN(conn, 2)

    // 5. Диспетчеризация по команде
    switch command {
    case CommandTCP:
        s.handler.NewConnectionEx(ctx, conn, source, destination, onClose)
    case CommandUDP:
        s.handler.NewPacketConnectionEx(ctx, &PacketConn{Conn: conn}, ...)
    default:  // CommandMux (0x7f)
        HandleMuxConnection(ctx, conn, source, s.handler, s.logger, onClose)
    }
}
```

### Механизм фоллбэка

При неудачной аутентификации сервис поддерживает фоллбэк на реальный веб-сервер:

```go
func (s *Service[K]) fallback(ctx, conn, source, header, err, onClose) error {
    if s.fallbackHandler == nil {
        return E.Extend(err, "fallback disabled")
    }
    // Вернуть уже прочитанные байты обратно в соединение
    conn = bufio.NewCachedConn(conn, buf.As(header).ToOwned())
    s.fallbackHandler.NewConnectionEx(ctx, conn, source, M.Socksaddr{}, onClose)
    return nil
}
```

Это критически важно для обхода цензуры: если зонд отправляет не-Trojan данные, они перенаправляются на реальный веб-сервер, делая сервис неотличимым от обычного HTTPS-сайта.

## Поддержка мультиплексирования (Trojan-Go)

Реализация мультиплексирования использует `smux` (Simple Multiplexer) для совместимости с Trojan-Go:

```go
func HandleMuxConnection(ctx, conn, source, handler, logger, onClose) error {
    session, _ := smux.Server(conn, smuxConfig())
    for {
        stream, _ := session.AcceptStream()
        go newMuxConnection(ctx, stream, source, handler, logger)
    }
}
```

Каждый mux-поток содержит собственный байт команды и адрес назначения:

```go
func newMuxConnection0(ctx, conn, source, handler) error {
    reader := bufio.NewReader(conn)
    command, _ := reader.ReadByte()
    destination, _ := M.SocksaddrSerializer.ReadAddrPort(reader)
    switch command {
    case CommandTCP:
        handler.NewConnectionEx(ctx, conn, source, destination, nil)
    case CommandUDP:
        handler.NewPacketConnectionEx(ctx, &PacketConn{Conn: conn}, ...)
    }
}
```

Конфигурация smux отключает keepalive:

```go
func smuxConfig() *smux.Config {
    config := smux.DefaultConfig()
    config.KeepAliveDisabled = true
    return config
}
```

## Реализация входящих соединений (Inbound)

```go
type Inbound struct {
    inbound.Adapter
    router                   adapter.ConnectionRouterEx
    logger                   log.ContextLogger
    listener                 *listener.Listener
    service                  *trojan.Service[int]
    users                    []option.TrojanUser
    tlsConfig                tls.ServerConfig
    fallbackAddr             M.Socksaddr
    fallbackAddrTLSNextProto map[string]M.Socksaddr  // ALPN-фоллбэк
    transport                adapter.V2RayServerTransport
}
```

### ALPN-фоллбэк

Trojan поддерживает фоллбэк по ALPN, позволяя задавать разные цели фоллбэка в зависимости от согласованного TLS-протокола:

```go
func (h *Inbound) fallbackConnection(ctx, conn, metadata, onClose) {
    if len(h.fallbackAddrTLSNextProto) > 0 {
        if tlsConn, loaded := common.Cast[tls.Conn](conn); loaded {
            negotiatedProtocol := tlsConn.ConnectionState().NegotiatedProtocol
            fallbackAddr = h.fallbackAddrTLSNextProto[negotiatedProtocol]
        }
    }
    if !fallbackAddr.IsValid() {
        fallbackAddr = h.fallbackAddr  // фоллбэк по умолчанию
    }
    metadata.Destination = fallbackAddr
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### Совместимость с kTLS

Входящее соединение включает kTLS (kernel TLS) при выполнении условий:

```go
tlsConfig, _ := tls.NewServerWithOptions(tls.ServerOptions{
    KTLSCompatible: transport.Type == "" && !multiplex.Enabled,
    // kTLS только когда: нет V2Ray-транспорта И нет мультиплексирования
})
```

## Реализация исходящих соединений (Outbound)

```go
type Outbound struct {
    outbound.Adapter
    key             [56]byte              // предварительно вычисленный ключ SHA224
    multiplexDialer *mux.Client
    tlsConfig       tls.Config
    tlsDialer       tls.Dialer
    transport       adapter.V2RayClientTransport
}
```

Ключ вычисляется один раз при создании:

```go
outbound.key = trojan.Key(options.Password)
```

### Поток соединения

```go
func (h *trojanDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    // 1. Установить соединение: транспорт > TLS > сырой TCP
    var conn net.Conn
    if h.transport != nil {
        conn = h.transport.DialContext(ctx)
    } else if h.tlsDialer != nil {
        conn = h.tlsDialer.DialTLSContext(ctx, h.serverAddr)
    } else {
        conn = h.dialer.DialContext(ctx, "tcp", h.serverAddr)
    }

    // 2. Обернуть протоколом Trojan
    switch network {
    case "tcp":
        return trojan.NewClientConn(conn, h.key, destination)
    case "udp":
        return bufio.NewBindPacketConn(
            trojan.NewClientPacketConn(conn, h.key), destination)
    }
}
```

### Ранние данные (Lazy Write)

`ClientConn` реализует `N.EarlyWriter`, что означает, что заголовок Trojan отправляется только при первом вызове `Write()`, объединённый с первой полезной нагрузкой:

```go
func (c *ClientConn) Write(p []byte) (n int, err error) {
    if c.headerWritten {
        return c.ExtendedConn.Write(p)
    }
    err = ClientHandshake(c.ExtendedConn, c.key, c.destination, p)
    c.headerWritten = true
    n = len(p)
    return
}
```

## Пример конфигурации

```json
{
  "type": "trojan",
  "tag": "trojan-in",
  "listen": "::",
  "listen_port": 443,
  "users": [
    { "name": "user1", "password": "my-secret-password" }
  ],
  "tls": {
    "enabled": true,
    "server_name": "example.com",
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  },
  "fallback": {
    "server": "127.0.0.1",
    "server_port": 8080
  },
  "fallback_for_alpn": {
    "h2": {
      "server": "127.0.0.1",
      "server_port": 8081
    }
  }
}
```
