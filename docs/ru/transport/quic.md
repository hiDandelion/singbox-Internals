# Транспорт QUIC

Исходный код: `transport/v2rayquic/client.go`, `transport/v2rayquic/server.go`, `transport/v2rayquic/stream.go`, `transport/v2rayquic/init.go`

## Обзор

Транспорт QUIC обеспечивает мультиплексирование потоков через одно QUIC-соединение. Требуется тег сборки `with_quic`, используется `github.com/sagernet/quic-go`. TLS обязателен -- QUIC требует TLS 1.3.

## Регистрация

Транспорт QUIC использует паттерн регистрации при инициализации, поскольку зависит от пакета, контролируемого тегом сборки:

```go
//go:build with_quic

package v2rayquic

func init() {
    v2ray.RegisterQUICConstructor(NewServer, NewClient)
}
```

## Клиент

### Кэширование соединений

Клиент поддерживает одно QUIC-соединение, создавая новые потоки для каждого подключения:

```go
type Client struct {
    ctx        context.Context
    dialer     N.Dialer
    serverAddr M.Socksaddr
    tlsConfig  tls.Config
    quicConfig *quic.Config
    connAccess sync.Mutex
    conn       common.TypedValue[*quic.Conn]
    rawConn    net.Conn
}
```

Метод `offer` использует двойную проверку блокировки для повторного использования или установки QUIC-соединения:

```go
func (c *Client) offer() (*quic.Conn, error) {
    conn := c.conn.Load()
    if conn != nil && !common.Done(conn.Context()) {
        return conn, nil
    }
    c.connAccess.Lock()
    defer c.connAccess.Unlock()
    conn = c.conn.Load()
    if conn != nil && !common.Done(conn.Context()) {
        return conn, nil
    }
    return c.offerNew()
}
```

### Установка соединения

```go
func (c *Client) offerNew() (*quic.Conn, error) {
    udpConn, err := c.dialer.DialContext(c.ctx, "udp", c.serverAddr)
    packetConn := bufio.NewUnbindPacketConn(udpConn)
    quicConn, err := qtls.Dial(c.ctx, packetConn, udpConn.RemoteAddr(), c.tlsConfig, c.quicConfig)
    c.conn.Store(quicConn)
    c.rawConn = udpConn
    return quicConn, nil
}
```

Dialer создаёт UDP-соединение, затем оборачивает его как `PacketConn` для библиотеки QUIC. `qtls.Dial` -- это обёртка sing-box вокруг `quic.Dial`, адаптирующая интерфейс TLS-конфигурации.

### Подключение

Каждый вызов `DialContext` открывает новый QUIC-поток на кэшированном соединении:

```go
func (c *Client) DialContext(ctx context.Context) (net.Conn, error) {
    conn, err := c.offer()
    stream, err := conn.OpenStream()
    return &StreamWrapper{Conn: conn, Stream: stream}, nil
}
```

### Конфигурация QUIC

```go
quicConfig := &quic.Config{
    DisablePathMTUDiscovery: !C.IsLinux && !C.IsWindows,
}
if len(tlsConfig.NextProtos()) == 0 {
    tlsConfig.SetNextProtos([]string{http3.NextProtoH3})
}
```

Обнаружение MTU пути отключено на платформах, отличных от Linux/Windows. ALPN по умолчанию -- `h3` (идентификатор протокола HTTP/3).

## Сервер

### Цикл приёма соединений

Сервер использует двухуровневый цикл приёма -- один для QUIC-соединений, другой для потоков внутри каждого соединения:

```go
func (s *Server) ServePacket(listener net.PacketConn) error {
    quicListener, err := qtls.Listen(listener, s.tlsConfig, s.quicConfig)
    s.quicListener = quicListener
    go s.acceptLoop()
    return nil
}

func (s *Server) acceptLoop() {
    for {
        conn, err := s.quicListener.Accept(s.ctx)
        if err != nil { return }
        go func() {
            hErr := s.streamAcceptLoop(conn)
            if hErr != nil && !E.IsClosedOrCanceled(hErr) {
                s.logger.ErrorContext(conn.Context(), hErr)
            }
        }()
    }
}

func (s *Server) streamAcceptLoop(conn *quic.Conn) error {
    for {
        stream, err := conn.AcceptStream(s.ctx)
        if err != nil { return qtls.WrapError(err) }
        go s.handler.NewConnectionEx(conn.Context(),
            &StreamWrapper{Conn: conn, Stream: stream},
            M.SocksaddrFromNet(conn.RemoteAddr()), M.Socksaddr{}, nil)
    }
}
```

Каждое принятое QUIC-соединение порождает горутину для приёма потоков. Каждый поток порождает горутину обработчика.

### Сеть

В отличие от других транспортов, QUIC работает по UDP:

```go
func (s *Server) Network() []string {
    return []string{N.NetworkUDP}
}

func (s *Server) Serve(listener net.Listener) error {
    return os.ErrInvalid  // TCP not supported
}
```

## StreamWrapper

Адаптирует QUIC-поток к `net.Conn`:

```go
type StreamWrapper struct {
    Conn *quic.Conn
    *quic.Stream
}

func (s *StreamWrapper) Read(p []byte) (n int, err error) {
    n, err = s.Stream.Read(p)
    return n, qtls.WrapError(err)
}

func (s *StreamWrapper) Write(p []byte) (n int, err error) {
    n, err = s.Stream.Write(p)
    return n, qtls.WrapError(err)
}

func (s *StreamWrapper) LocalAddr() net.Addr {
    return s.Conn.LocalAddr()
}

func (s *StreamWrapper) RemoteAddr() net.Addr {
    return s.Conn.RemoteAddr()
}

func (s *StreamWrapper) Close() error {
    s.CancelRead(0)
    s.Stream.Close()
    return nil
}
```

Обёртка предоставляет `LocalAddr`/`RemoteAddr` от QUIC-соединения (поскольку потоки не имеют независимых адресов) и оборачивает ошибки QUIC через `qtls.WrapError`. При закрытии отменяется сторона чтения и закрывается сторона записи.

## Конфигурация

```json
{
  "transport": {
    "type": "quic"
  }
}
```

Транспорт QUIC не имеет дополнительных параметров помимо типа. TLS всегда обязателен и должен быть настроен отдельно на входящем/исходящем соединении.
