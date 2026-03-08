# Фрагментация TLS ClientHello

Исходный код: `common/tlsfragment/index.go`, `common/tlsfragment/conn.go`, `common/tlsfragment/wait_linux.go`, `common/tlsfragment/wait_darwin.go`, `common/tlsfragment/wait_windows.go`, `common/tlsfragment/wait_stub.go`

## Обзор

TLS fragment разделяет сообщение TLS ClientHello по границам меток домена SNI (Server Name Indication). Эта техника используется для обхода DPI (Deep Packet Inspection), который считывает SNI для определения целевого домена. Разделяя SNI на несколько TCP-сегментов или TLS-записей, простые системы DPI не могут собрать и сопоставить домен.

## Два режима фрагментации

### Режим splitPacket

Разделяет ClientHello на несколько TCP-сегментов по границам меток домена SNI. Каждый сегмент отправляется как отдельный TCP-пакет с включённым `TCP_NODELAY`, и отправитель ожидает подтверждения ACK каждого сегмента перед отправкой следующего.

### Режим splitRecord

Оборачивает каждый фрагмент как отдельную TLS-запись, добавляя заголовок уровня TLS-записи (тип содержимого + версия) с новым полем длины. Это создаёт несколько валидных TLS-записей из одного ClientHello.

Оба режима можно комбинировать: `splitRecord` создаёт отдельные TLS-записи, а `splitPacket` отправляет каждую запись как индивидуальный TCP-сегмент с ожиданием ACK.

## Извлечение SNI

Функция `IndexTLSServerName` разбирает необработанный TLS ClientHello для определения местоположения расширения SNI:

```go
func IndexTLSServerName(payload []byte) *MyServerName {
    if len(payload) < recordLayerHeaderLen || payload[0] != contentType {
        return nil  // Not a TLS handshake
    }
    segmentLen := binary.BigEndian.Uint16(payload[3:5])
    serverName := indexTLSServerNameFromHandshake(payload[recordLayerHeaderLen:])
    serverName.Index += recordLayerHeaderLen
    return serverName
}
```

Парсер проходит через:
1. Заголовок уровня TLS-записи (5 байт)
2. Заголовок рукопожатия (6 байт) -- проверка типа рукопожатия 1 (ClientHello)
3. Случайные данные (32 байта)
4. Идентификатор сессии (переменная длина)
5. Наборы шифров (переменная длина)
6. Методы сжатия (переменная длина)
7. Расширения -- поиск расширения SNI (тип 0x0000)

Возвращает `MyServerName` с байтовым смещением, длиной и строковым значением SNI.

## Соединение с фрагментацией

```go
type Conn struct {
    net.Conn
    tcpConn            *net.TCPConn
    ctx                context.Context
    firstPacketWritten bool
    splitPacket        bool
    splitRecord        bool
    fallbackDelay      time.Duration
}
```

`Conn` перехватывает только первый вызов `Write` (ClientHello). Последующие записи проходят напрямую.

### Алгоритм разделения

```go
func (c *Conn) Write(b []byte) (n int, err error) {
    if !c.firstPacketWritten {
        defer func() { c.firstPacketWritten = true }()
        serverName := IndexTLSServerName(b)
        if serverName != nil {
            // 1. Enable TCP_NODELAY for splitPacket mode
            // 2. Parse domain labels, skip public suffix
            splits := strings.Split(serverName.ServerName, ".")
            if publicSuffix := publicsuffix.List.PublicSuffix(serverName.ServerName); publicSuffix != "" {
                splits = splits[:len(splits)-strings.Count(serverName.ServerName, ".")]
            }
            // 3. Random split point within each label
            for i, split := range splits {
                splitAt := rand.Intn(len(split))
                splitIndexes = append(splitIndexes, currentIndex+splitAt)
            }
            // 4. Send fragments
            for i := 0; i <= len(splitIndexes); i++ {
                // Extract payload slice
                if c.splitRecord {
                    // Re-wrap with TLS record header
                    buffer.Write(b[:3])              // Content type + version
                    binary.Write(&buffer, binary.BigEndian, payloadLen)
                    buffer.Write(payload)
                }
                if c.splitPacket {
                    writeAndWaitAck(c.ctx, c.tcpConn, payload, c.fallbackDelay)
                }
            }
            // 5. Restore TCP_NODELAY to false
            return len(b), nil
        }
    }
    return c.Conn.Write(b)
}
```

### Обработка публичных суффиксов

Метки домена, принадлежащие публичному суффиксу (например, `.co.uk`, `.com.cn`), исключаются из разделения с использованием `golang.org/x/net/publicsuffix`. Это гарантирует, что разделение происходит только в значимых частях доменного имени.

### Обработка начального подстановочного символа

Если домен начинается с `...` (например, `...subdomain.example.com`), ведущая метка `...` пропускается и индекс сдвигается вперёд.

## Платформо-зависимое ожидание ACK

Функция `writeAndWaitAck` гарантирует, что каждый TCP-сегмент подтверждён перед отправкой следующего. Реализация различается для каждой платформы:

### Linux (`wait_linux.go`)

Использует опцию сокета `TCP_INFO` для проверки поля `Unacked`:

```go
func waitAck(ctx context.Context, conn *net.TCPConn, fallbackDelay time.Duration) error {
    rawConn.Control(func(fd uintptr) {
        for {
            var info unix.TCPInfo
            infoBytes, _ := unix.GetsockoptTCPInfo(int(fd), unix.SOL_TCP, unix.TCP_INFO)
            if infoBytes.Unacked == 0 {
                return  // All segments acknowledged
            }
            time.Sleep(time.Millisecond)
        }
    })
}
```

### Darwin (`wait_darwin.go`)

Использует опцию сокета `SO_NWRITE` для проверки неотправленных байтов:

```go
func waitAck(ctx context.Context, conn *net.TCPConn, fallbackDelay time.Duration) error {
    rawConn.Control(func(fd uintptr) {
        for {
            nwrite, _ := unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_NWRITE)
            if nwrite == 0 {
                return  // All data sent and acknowledged
            }
            time.Sleep(time.Millisecond)
        }
    })
}
```

### Windows (`wait_windows.go`)

Использует `winiphlpapi.WriteAndWaitAck` (пользовательскую обёртку Windows API).

### Запасной вариант (`wait_stub.go`)

На неподдерживаемых платформах используется запасной вариант `time.Sleep(fallbackDelay)`:

```go
func writeAndWaitAck(ctx context.Context, conn *net.TCPConn, b []byte, fallbackDelay time.Duration) error {
    _, err := conn.Write(b)
    if err != nil { return err }
    time.Sleep(fallbackDelay)
    return nil
}
```

Задержка по умолчанию -- `C.TLSFragmentFallbackDelay`.

## Заменяемость соединения

```go
func (c *Conn) ReaderReplaceable() bool {
    return true  // Reader can always be replaced (no read interception)
}

func (c *Conn) WriterReplaceable() bool {
    return c.firstPacketWritten  // Writer replaceable after first write
}
```

После записи первого пакета `Conn` становится прозрачным, и его writer может быть оптимизирован конвейером буферов.

## Конфигурация

Фрагментация TLS настраивается как часть параметров TLS:

```json
{
  "tls": {
    "enabled": true,
    "fragment": true,
    "record_fragment": true,
    "fragment_fallback_delay": "20ms"
  }
}
```

| Поле | Описание |
|-------|-------------|
| `fragment` | Включить разделение TCP-пакетов (режим `splitPacket`) |
| `record_fragment` | Включить разделение TLS-записей (режим `splitRecord`) |
| `fragment_fallback_delay` | Запасная задержка на платформах без определения ACK |
