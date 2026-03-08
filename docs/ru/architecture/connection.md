# Менеджер соединений

ConnectionManager обрабатывает фактическую передачу данных между входящими и исходящими соединениями. Он устанавливает соединение с удалённым узлом, настраивает двунаправленное копирование и управляет жизненным циклом соединения.

**Исходный код**: `route/conn.go`

## Структура

```go
type ConnectionManager struct {
    logger      logger.ContextLogger
    access      sync.Mutex
    connections list.List[io.Closer]  // tracked active connections
}
```

## Поток TCP-соединения (`NewConnection`)

```go
func (m *ConnectionManager) NewConnection(ctx, this N.Dialer, conn net.Conn, metadata, onClose) {
    // 1. Dial remote
    if len(metadata.DestinationAddresses) > 0 || metadata.Destination.IsIP() {
        remoteConn, err = dialer.DialSerialNetwork(ctx, this, "tcp",
            metadata.Destination, metadata.DestinationAddresses,
            metadata.NetworkStrategy, metadata.NetworkType,
            metadata.FallbackNetworkType, metadata.FallbackDelay)
    } else {
        remoteConn, err = this.DialContext(ctx, "tcp", metadata.Destination)
    }

    // 2. Report handshake success (for protocols that need it)
    N.ReportConnHandshakeSuccess(conn, remoteConn)

    // 3. Apply TLS fragmentation if requested
    if metadata.TLSFragment || metadata.TLSRecordFragment {
        remoteConn = tf.NewConn(remoteConn, ctx, ...)
    }

    // 4. Kick handshake (send early data)
    m.kickWriteHandshake(ctx, conn, remoteConn, false, &done, onClose)
    m.kickWriteHandshake(ctx, remoteConn, conn, true, &done, onClose)

    // 5. Bidirectional copy
    go m.connectionCopy(ctx, conn, remoteConn, false, &done, onClose)
    go m.connectionCopy(ctx, remoteConn, conn, true, &done, onClose)
}
```

### Инициирование рукопожатия

Некоторые протоколы (например, прокси-протоколы с отложенным рукопожатием) требуют записи первых данных до полного установления соединения. `kickWriteHandshake` обрабатывает это:

```go
func (m *ConnectionManager) kickWriteHandshake(ctx, source, destination, direction, done, onClose) bool {
    if !N.NeedHandshakeForWrite(destination) {
        return false  // no handshake needed
    }

    // Try to read cached data from source
    if cachedReader, ok := sourceReader.(N.CachedReader); ok {
        cachedBuffer = cachedReader.ReadCached()
    }

    if cachedBuffer != nil {
        // Write cached data to trigger handshake
        _, err = destinationWriter.Write(cachedBuffer.Bytes())
    } else {
        // Write empty to trigger handshake
        destination.SetWriteDeadline(time.Now().Add(C.ReadPayloadTimeout))
        _, err = destinationWriter.Write(nil)
    }
    // ...
}
```

Это позволяет отправлять ранние данные (например, TLS ClientHello) вместе с рукопожатием прокси-протокола, уменьшая количество циклов обмена.

### Двунаправленное копирование

```go
func (m *ConnectionManager) connectionCopy(ctx, source, destination, direction, done, onClose) {
    _, err := bufio.CopyWithIncreateBuffer(destination, source,
        bufio.DefaultIncreaseBufferAfter, bufio.DefaultBatchSize)

    if err != nil {
        common.Close(source, destination)
    } else if duplexDst, isDuplex := destination.(N.WriteCloser); isDuplex {
        duplexDst.CloseWrite()  // half-close for graceful shutdown
    } else {
        destination.Close()
    }

    // done is atomic — first goroutine to finish sets it
    if done.Swap(true) {
        // Second goroutine: call onClose and close both
        if onClose != nil { onClose(err) }
        common.Close(source, destination)
    }
}
```

Ключевые особенности поведения:
- Используется `bufio.CopyWithIncreateBuffer` для адаптивного размера буфера
- Поддерживается полузакрытие (FIN) через `N.WriteCloser`
- `atomic.Bool` гарантирует, что `onClose` вызывается ровно один раз
- Отдельное логирование направлений загрузки и выгрузки

## Поток UDP-соединения (`NewPacketConnection`)

```go
func (m *ConnectionManager) NewPacketConnection(ctx, this, conn, metadata, onClose) {
    if metadata.UDPConnect {
        // Connected UDP: dial to specific destination
        remoteConn, err = this.DialContext(ctx, "udp", metadata.Destination)
        remotePacketConn = bufio.NewUnbindPacketConn(remoteConn)
    } else {
        // Unconnected UDP: listen for packets
        remotePacketConn, destinationAddress, err = this.ListenPacket(ctx, metadata.Destination)
    }

    // NAT handling: translate addresses if resolved IP differs from domain
    if destinationAddress.IsValid() {
        remotePacketConn = bufio.NewNATPacketConn(remotePacketConn, destination, originDestination)
    }

    // UDP timeout (protocol-aware)
    if udpTimeout > 0 {
        ctx, conn = canceler.NewPacketConn(ctx, conn, udpTimeout)
    }

    // Bidirectional packet copy
    go m.packetConnectionCopy(ctx, conn, destination, false, &done, onClose)
    go m.packetConnectionCopy(ctx, destination, conn, true, &done, onClose)
}
```

### Тайм-аут UDP

Тайм-аут UDP определяется в порядке приоритета:
1. `metadata.UDPTimeout` (установлен действием правила)
2. `C.ProtocolTimeouts[protocol]` (специфичный для протокола, например DNS = 10 сек)
3. Тайм-аут по умолчанию

### NAT PacketConn

Когда DNS разрешает домен в IP-адрес, удалённый сокет использует IP. Но клиент ожидает ответы от исходного домена. `bufio.NewNATPacketConn` транслирует адреса:

```
Client → conn.ReadPacket() → {dest: example.com:443}
         ↓ NAT translate
Remote → remoteConn.WritePacket() → {dest: 1.2.3.4:443}
         ↓ response
Remote → remoteConn.ReadPacket() → {from: 1.2.3.4:443}
         ↓ NAT translate back
Client → conn.WritePacket() → {from: example.com:443}
```

## Отслеживание соединений

ConnectionManager отслеживает все активные соединения для мониторинга и очистки:

```go
func (m *ConnectionManager) TrackConn(conn net.Conn) net.Conn {
    element := m.connections.PushBack(conn)
    return &trackedConn{Conn: conn, manager: m, element: element}
}

// trackedConn removes itself from the list on Close()
func (c *trackedConn) Close() error {
    c.manager.connections.Remove(c.element)
    return c.Conn.Close()
}
```

`CloseAll()` вызывается при завершении работы для закрытия всех активных соединений.

## Последовательное подключение

Когда доступно несколько адресов назначения (из DNS-разрешения), `dialer.DialSerialNetwork` пробует их по порядку:

```go
// Tries each address, respecting network strategy (prefer cellular, etc.)
func DialSerialNetwork(ctx, dialer, network, destination, addresses,
    strategy, networkType, fallbackType, fallbackDelay) (net.Conn, error)
```

Это интегрируется с системой сетевых стратегий для устройств с несколькими интерфейсами (мобильные).
