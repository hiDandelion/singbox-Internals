# Протокол NaiveProxy

NaiveProxy маскирует прокси-трафик под обычный HTTP/2 или HTTP/3 трафик с использованием метода CONNECT. Входящее соединение реализует NaiveProxy-совместимый сервер с поддержкой дополнения (padding), а исходящее использует библиотеку Cronet (сетевой стек Chromium) для имитации настоящего клиента Chrome.

**Исходный код**: `protocol/naive/inbound.go`, `protocol/naive/inbound_conn.go`, `protocol/naive/outbound.go`, `protocol/naive/quic/`

## Архитектура входящих соединений (Inbound)

```go
type Inbound struct {
    inbound.Adapter
    ctx              context.Context
    router           adapter.ConnectionRouterEx
    logger           logger.ContextLogger
    listener         *listener.Listener
    network          []string
    networkIsDefault bool
    authenticator    *auth.Authenticator
    tlsConfig        tls.ServerConfig
    httpServer       *http.Server
    h3Server         io.Closer
}
```

### Двойной транспорт: HTTP/2 + HTTP/3

NaiveProxy поддерживает как HTTP/2 (TCP), так и HTTP/3 (QUIC). По умолчанию используется TCP, с опциональным UDP для HTTP/3:

```go
if common.Contains(inbound.network, N.NetworkUDP) {
    if options.TLS == nil || !options.TLS.Enabled {
        return nil, E.New("TLS is required for QUIC server")
    }
}
```

### HTTP/2-сервер (TCP)

TCP-слушатель обслуживает HTTP/2 через h2c (HTTP/2 cleartext) с опциональным TLS:

```go
n.httpServer = &http.Server{
    Handler: h2c.NewHandler(n, &http2.Server{}),
}

go func() {
    listener := net.Listener(tcpListener)
    if n.tlsConfig != nil {
        // Обеспечить наличие HTTP/2 ALPN
        if !common.Contains(n.tlsConfig.NextProtos(), http2.NextProtoTLS) {
            n.tlsConfig.SetNextProtos(append([]string{http2.NextProtoTLS}, n.tlsConfig.NextProtos()...))
        }
        listener = aTLS.NewListener(tcpListener, n.tlsConfig)
    }
    n.httpServer.Serve(listener)
}()
```

### HTTP/3-сервер (QUIC)

HTTP/3 инициализируется через настраиваемый указатель на функцию:

```go
var ConfigureHTTP3ListenerFunc func(ctx, logger, listener, handler, tlsConfig, options) (io.Closer, error)
```

Он регистрируется внешне в `protocol/naive/quic/inbound_init.go`, который использует библиотеку `sing-quic` с настраиваемым управлением перегрузкой.

### Обработка CONNECT-запросов

Основная логика протокола находится в `ServeHTTP`:

```go
func (n *Inbound) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
    // 1. Отклонить не-CONNECT запросы
    if request.Method != "CONNECT" {
        rejectHTTP(writer, http.StatusBadRequest)
        return
    }

    // 2. Требовать заголовок padding (отличает NaiveProxy от обычного CONNECT)
    if request.Header.Get("Padding") == "" {
        rejectHTTP(writer, http.StatusBadRequest)
        return
    }

    // 3. Аутентификация через заголовок Proxy-Authorization
    userName, password, authOk := sHttp.ParseBasicAuth(request.Header.Get("Proxy-Authorization"))
    if authOk {
        authOk = n.authenticator.Verify(userName, password)
    }
    if !authOk {
        rejectHTTP(writer, http.StatusProxyAuthRequired)
        return
    }

    // 4. Отправить ответ с дополнением
    writer.Header().Set("Padding", generatePaddingHeader())
    writer.WriteHeader(http.StatusOK)
    writer.(http.Flusher).Flush()

    // 5. Извлечь назначение из пользовательского или стандартного заголовка
    hostPort := request.Header.Get("-connect-authority")
    if hostPort == "" {
        hostPort = request.URL.Host
    }

    // 6. Обернуть соединение дополнением для первых 8 фреймов
    // HTTP/1.1: перехватить соединение
    // HTTP/2: использовать request.Body + response writer
}
```

### Поведение при отклонении

При отклонении соединение сбрасывается (RST) вместо корректного закрытия, чтобы имитировать поведение реального веб-сервера:

```go
func rejectHTTP(writer http.ResponseWriter, statusCode int) {
    hijacker, ok := writer.(http.Hijacker)
    if !ok {
        writer.WriteHeader(statusCode)
        return
    }
    conn, _, _ := hijacker.Hijack()
    if tcpConn, isTCP := common.Cast[*net.TCPConn](conn); isTCP {
        tcpConn.SetLinger(0)  // RST вместо FIN
    }
    conn.Close()
}
```

## Протокол дополнения (Padding)

Протокол дополнения добавляет случайное дополнение к первым 8 операциям чтения/записи для устойчивости к отпечаткам трафика.

### Константы и структура

```go
const paddingCount = 8

type paddingConn struct {
    readPadding      int   // количество прочитанных фреймов с дополнением
    writePadding     int   // количество записанных фреймов с дополнением
    readRemaining    int   // оставшиеся байты данных в текущем фрейме
    paddingRemaining int   // оставшиеся байты дополнения для пропуска
}
```

### Формат заголовка Padding

HTTP-заголовок Padding использует случайную строку длиной 30-62 символа из набора `!#$()+<>?@[]^`{}~`:

```go
func generatePaddingHeader() string {
    paddingLen := rand.Intn(32) + 30
    padding := make([]byte, paddingLen)
    bits := rand.Uint64()
    for i := 0; i < 16; i++ {
        padding[i] = "!#$()+<>?@[]^`{}"[bits&15]
        bits >>= 4
    }
    for i := 16; i < paddingLen; i++ {
        padding[i] = '~'
    }
    return string(padding)
}
```

### Формат данных (фрейм с дополнением)

Каждый из первых 8 фреймов кодируется как:

```
+---------------+----------+------+---------+
| Data Length   | Pad Size | Data | Padding |
| (2 bytes BE) | (1 byte) | (var)| (var)   |
+---------------+----------+------+---------+
```

```go
func (p *paddingConn) writeWithPadding(writer io.Writer, data []byte) (n int, err error) {
    if p.writePadding < paddingCount {
        paddingSize := rand.Intn(256)
        buffer := buf.NewSize(3 + len(data) + paddingSize)
        header := buffer.Extend(3)
        binary.BigEndian.PutUint16(header, uint16(len(data)))
        header[2] = byte(paddingSize)
        buffer.Write(data)
        buffer.Extend(paddingSize)  // случайные байты дополнения
        _, err = writer.Write(buffer.Bytes())
        p.writePadding++
        return
    }
    // После 8 фреймов — прямая запись
    return writer.Write(data)
}
```

### Чтение фреймов с дополнением

```go
func (p *paddingConn) readWithPadding(reader io.Reader, buffer []byte) (n int, err error) {
    // Если есть оставшиеся данные из текущего фрейма, прочитать их
    if p.readRemaining > 0 { /* прочитать оставшееся */ }

    // Пропустить оставшееся дополнение из предыдущего фрейма
    if p.paddingRemaining > 0 {
        rw.SkipN(reader, p.paddingRemaining)
    }

    // Прочитать заголовок следующего фрейма с дополнением (3 байта)
    if p.readPadding < paddingCount {
        io.ReadFull(reader, paddingHeader[:3])
        originalDataSize := binary.BigEndian.Uint16(paddingHeader[:2])
        paddingSize := int(paddingHeader[2])
        n, _ = reader.Read(buffer[:originalDataSize])
        p.readPadding++
        p.readRemaining = originalDataSize - n
        p.paddingRemaining = paddingSize
        return
    }

    // После 8 фреймов — прямое чтение
    return reader.Read(buffer)
}
```

### Заменяемость соединения

После фазы дополнения (8 фреймов) обёртка дополнения становится прозрачной:

```go
func (p *paddingConn) readerReplaceable() bool {
    return p.readPadding == paddingCount
}

func (p *paddingConn) writerReplaceable() bool {
    return p.writePadding == paddingCount
}
```

### Два типа соединений

- **`naiveConn`**: Для перехваченных HTTP/1.1 соединений (оборачивает `net.Conn`)
- **`naiveH2Conn`**: Для потоков HTTP/2 (оборачивает `io.Reader` + `io.Writer` + `http.Flusher`); необходим flush после каждой записи

## Архитектура исходящих соединений (Outbound) — Cronet

Исходящее соединение использует библиотеку Cronet (сетевой стек Chromium), чтобы сделать соединения неотличимыми от настоящего Chrome:

```go
//go:build with_naive_outbound

type Outbound struct {
    outbound.Adapter
    ctx       context.Context
    logger    logger.ContextLogger
    client    *cronet.NaiveClient
    uotClient *uot.Client
}
```

### Тег сборки

Исходящее соединение требует тег сборки `with_naive_outbound`.

### Ограничения TLS

Многие опции TLS не поддерживаются, поскольку Cronet управляет своим собственным TLS:

```go
if options.TLS.DisableSNI { return nil, E.New("not supported") }
if options.TLS.Insecure { return nil, E.New("not supported") }
if len(options.TLS.ALPN) > 0 { return nil, E.New("not supported") }
if options.TLS.UTLS != nil { return nil, E.New("not supported") }
if options.TLS.Reality != nil { return nil, E.New("not supported") }
// ... и многие другие
```

### Конфигурация клиента

```go
client, _ := cronet.NewNaiveClient(cronet.NaiveClientOptions{
    ServerAddress:           serverAddress,
    ServerName:              serverName,
    Username:                options.Username,
    Password:                options.Password,
    InsecureConcurrency:     options.InsecureConcurrency,
    ExtraHeaders:            extraHeaders,
    TrustedRootCertificates: trustedRootCertificates,
    Dialer:                  outboundDialer,
    DNSResolver:             dnsResolver,
    ECHEnabled:              echEnabled,
    QUIC:                    options.QUIC,
    QUICCongestionControl:   quicCongestionControl,
})
```

### Управление перегрузкой QUIC (Outbound)

Исходящее соединение поддерживает несколько алгоритмов управления перегрузкой QUIC:

```go
switch options.QUICCongestionControl {
case "bbr":   quicCongestionControl = cronet.QUICCongestionControlBBR
case "bbr2":  quicCongestionControl = cronet.QUICCongestionControlBBRv2
case "cubic": quicCongestionControl = cronet.QUICCongestionControlCubic
case "reno":  quicCongestionControl = cronet.QUICCongestionControlReno
}
```

### Поддержка ECH

Исходящее соединение поддерживает Encrypted Client Hello:

```go
if options.TLS.ECH != nil && options.TLS.ECH.Enabled {
    echEnabled = true
    echConfigList = block.Bytes  // PEM-декодированные "ECH CONFIGS"
}
```

### Интеграция DNS

Исходящее соединение использует DNS-маршрутизатор sing-box для разрешения имён внутри Cronet:

```go
dnsResolver = func(dnsContext context.Context, request *mDNS.Msg) *mDNS.Msg {
    response, _ := dnsRouter.Exchange(dnsContext, request, outboundDialer.(dialer.ResolveDialer).QueryOptions())
    return response
}
```

### Поддержка UDP через UoT

UDP доступен только через UDP-over-TCP:

```go
if uotOptions.Enabled {
    outbound.uotClient = &uot.Client{
        Dialer:  &naiveDialer{client},
        Version: uotOptions.Version,
    }
}
```

## Примеры конфигурации

### Входящее соединение (Inbound)

```json
{
  "type": "naive",
  "tag": "naive-in",
  "listen": "::",
  "listen_port": 443,
  "users": [
    { "username": "user1", "password": "pass1" }
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
  "type": "naive",
  "tag": "naive-out",
  "server": "example.com",
  "server_port": 443,
  "username": "user1",
  "password": "pass1",
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  },
  "udp_over_tcp": {
    "enabled": true,
    "version": 2
  }
}
```
