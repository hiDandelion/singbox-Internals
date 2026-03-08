# Анализ протоколов (Sniffing)

Анализ протоколов определяет протокол прикладного уровня путём проверки первых байтов соединения. Это позволяет выполнять маршрутизацию на основе доменов, даже когда клиент подключается по IP-адресу.

**Исходный код**: `common/sniff/`, `route/route.go`

## Архитектура анализа

Анализ происходит как действие правила, а не как фиксированный этап конвейера:

```json
{
  "route": {
    "rules": [
      {
        "action": "sniff",
        "timeout": "300ms"
      },
      {
        "protocol": "tls",
        "domain_suffix": [".example.com"],
        "action": "route",
        "outbound": "proxy"
      }
    ]
  }
}
```

Это означает, что анализ можно выполнять условно (только для определённых входящих, портов и т.д.) и использовать результаты в последующих правилах.

## Потоковые анализаторы (TCP)

```go
type StreamSniffer = func(ctx context.Context, metadata *adapter.InboundContext, reader io.Reader) error
```

### Доступные анализаторы

| Анализатор | Протокол | Метод обнаружения |
|------------|----------|-------------------|
| `TLSClientHello` | `tls` | Тип записи TLS 0x16, тип рукопожатия 0x01, расширение SNI |
| `HTTPHost` | `http` | HTTP-метод + заголовок Host |
| `StreamDomainNameQuery` | `dns` | DNS-запрос через TCP |
| `BitTorrent` | `bittorrent` | Магическое число рукопожатия BitTorrent |
| `SSH` | `ssh` | Префикс "SSH-" |
| `RDP` | `rdp` | Заголовок RDP TPKT |

### Анализ TLS

```go
func TLSClientHello(ctx context.Context, metadata *adapter.InboundContext, reader io.Reader) error {
    // Parse TLS record header
    // Parse ClientHello handshake message
    // Extract SNI from extensions
    // Extract ALPN from extensions
    // Set metadata.Protocol = "tls"
    // Set metadata.Domain = SNI
    // Set metadata.Client (JA3 fingerprint category)
    // Set metadata.SniffContext = &TLSContext{ALPN, ClientHello}
}
```

Анализатор TLS также сохраняет полный ClientHello в `SniffContext` для определения отпечатка JA3 и последующего использования сервером REALITY.

### Анализ HTTP

```go
func HTTPHost(ctx context.Context, metadata *adapter.InboundContext, reader io.Reader) error {
    // Check for HTTP method (GET, POST, etc.)
    // Parse headers to find Host
    // Set metadata.Protocol = "http"
    // Set metadata.Domain = Host header value
}
```

## Пакетные анализаторы (UDP)

```go
type PacketSniffer = func(ctx context.Context, metadata *adapter.InboundContext, packet []byte) error
```

### Доступные анализаторы

| Анализатор | Протокол | Метод обнаружения |
|------------|----------|-------------------|
| `QUICClientHello` | `quic` | Начальный пакет QUIC + TLS ClientHello |
| `DomainNameQuery` | `dns` | Пакет DNS-запроса |
| `STUNMessage` | `stun` | Магическое число сообщения STUN |
| `UTP` | `bittorrent` | uTP (micro Transport Protocol) |
| `UDPTracker` | `bittorrent` | UDP-трекер BitTorrent |
| `DTLSRecord` | `dtls` | Заголовок записи DTLS |
| `NTP` | `ntp` | Формат пакета NTP |

### Анализ QUIC

Анализ QUIC является наиболее сложным -- он должен:
1. Разобрать заголовок начального пакета QUIC
2. Расшифровать защиту заголовка QUIC
3. Расшифровать полезную нагрузку QUIC (используя начальный секрет, производный от идентификатора соединения)
4. Найти фрейм CRYPTO, содержащий TLS ClientHello
5. Разобрать ClientHello для извлечения SNI

ClientHello QUIC может охватывать несколько пакетов, поэтому анализатор возвращает `sniff.ErrNeedMoreData`, и маршрутизатор считывает дополнительные пакеты.

## PeekStream

```go
func PeekStream(
    ctx context.Context,
    metadata *adapter.InboundContext,
    conn net.Conn,
    existingBuffers []*buf.Buffer,
    buffer *buf.Buffer,
    timeout time.Duration,
    sniffers ...StreamSniffer,
) error {
    // If there's cached data, try sniffing it first
    if len(existingBuffers) > 0 {
        reader := io.MultiReader(buffers..., buffer)
        for _, sniffer := range sniffers {
            err := sniffer(ctx, metadata, reader)
            if err == nil { return nil }
        }
    }

    // Read new data with timeout
    conn.SetReadDeadline(time.Now().Add(timeout))
    _, err := buffer.ReadOnceFrom(conn)
    conn.SetReadDeadline(time.Time{})

    // Try each sniffer
    reader := io.MultiReader(buffers..., buffer)
    for _, sniffer := range sniffers {
        err := sniffer(ctx, metadata, reader)
        if err == nil { return nil }
    }
    return ErrClientHelloNotFound
}
```

Проанализированные данные буферизуются и добавляются в начало соединения перед передачей исходящему (через `bufio.NewCachedConn`).

## PeekPacket

```go
func PeekPacket(
    ctx context.Context,
    metadata *adapter.InboundContext,
    packet []byte,
    sniffers ...PacketSniffer,
) error {
    for _, sniffer := range sniffers {
        err := sniffer(ctx, metadata, packet)
        if err == nil { return nil }
    }
    return ErrClientHelloNotFound
}
```

Для пакетов буферизация не нужна -- пакет считывается целиком и передаётся анализаторам.

## Логика пропуска

Определённые порты пропускаются, поскольку они используют протоколы с инициативой сервера (сервер отправляет данные первым):

```go
func Skip(metadata *adapter.InboundContext) bool {
    // Skip server-first protocols on well-known ports
    switch metadata.Destination.Port {
    case 25, 110, 143, 465, 587, 993, 995: // SMTP, POP3, IMAP
        return true
    }
    return false
}
```

## Поток результатов анализа

После анализа метаданные обогащаются:

```go
metadata.Protocol = "tls"          // detected protocol
metadata.Domain = "example.com"    // extracted domain
metadata.Client = "chrome"         // TLS client fingerprint
```

Если в действии sniff установлен `OverrideDestination`, адрес назначения также обновляется:

```go
if action.OverrideDestination && M.IsDomainName(metadata.Domain) {
    metadata.Destination = M.Socksaddr{
        Fqdn: metadata.Domain,
        Port: metadata.Destination.Port,
    }
}
```

Это позволяет последующим правилам сопоставлять по обнаруженному домену, а исходящий будет подключаться к домену (а не к IP-адресу).
