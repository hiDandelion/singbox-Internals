# Прозрачные прокси Redirect и TProxy

Redirect и TProxy — это специфичные для Linux механизмы прозрачного проксирования. Redirect перехватывает TCP-соединения через `iptables REDIRECT`, а TProxy перехватывает как TCP, так и UDP через `iptables TPROXY`. Оба извлекают оригинальный адрес назначения из структур данных ядра.

**Исходный код**: `protocol/redirect/redirect.go`, `protocol/redirect/tproxy.go`, `common/redir/`

## Входящее соединение Redirect (Inbound)

### Архитектура

```go
type Redirect struct {
    inbound.Adapter
    router   adapter.Router
    logger   log.ContextLogger
    listener *listener.Listener
}
```

### Только TCP

Redirect поддерживает только TCP (ядро перенаправляет TCP-соединения на локальный слушатель):

```go
redirect.listener = listener.New(listener.Options{
    Network:           []string{N.NetworkTCP},
    ConnectionHandler: redirect,
})
```

### Извлечение оригинального назначения

Ключевая операция — получение оригинального назначения из перенаправленного сокета через `SO_ORIGINAL_DST`:

```go
func (h *Redirect) NewConnectionEx(ctx, conn, metadata, onClose) {
    destination, err := redir.GetOriginalDestination(conn)
    if err != nil {
        conn.Close()
        h.logger.ErrorContext(ctx, "get redirect destination: ", err)
        return
    }
    metadata.Inbound = h.Tag()
    metadata.InboundType = h.Type()
    metadata.Destination = M.SocksaddrFromNetIP(destination)
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

Функция `redir.GetOriginalDestination` вызывает `getsockopt(fd, SOL_IP, SO_ORIGINAL_DST)` (или `IP6T_SO_ORIGINAL_DST` для IPv6) для получения оригинального адреса назначения, который был перезаписан iptables.

### Необходимое правило iptables

```bash
iptables -t nat -A PREROUTING -p tcp --dport 1:65535 -j REDIRECT --to-ports <listen_port>
```

## Входящее соединение TProxy (Inbound)

### Архитектура

```go
type TProxy struct {
    inbound.Adapter
    ctx      context.Context
    router   adapter.Router
    logger   log.ContextLogger
    listener *listener.Listener
    udpNat   *udpnat.Service
}
```

### Поддержка TCP + UDP

TProxy поддерживает как TCP, так и UDP:

```go
tproxy.listener = listener.New(listener.Options{
    Network:           options.Network.Build(),
    ConnectionHandler: tproxy,
    OOBPacketHandler:  tproxy,   // UDP с OOB-данными
    TProxy:            true,
})
```

Флаг `TProxy: true` указывает слушателю установить опцию сокета `IP_TRANSPARENT`.

### Обработка TCP

Для TCP оригинальным назначением является локальный адрес сокета (TProxy сохраняет его):

```go
func (t *TProxy) NewConnectionEx(ctx, conn, metadata, onClose) {
    metadata.Inbound = t.Tag()
    metadata.InboundType = t.Type()
    metadata.Destination = M.SocksaddrFromNet(conn.LocalAddr()).Unwrap()
    t.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### Обработка UDP с OOB

UDP-пакеты приходят с внеполосными (OOB) данными, содержащими оригинальное назначение. Интерфейс `OOBPacketHandler` обрабатывает их:

```go
func (t *TProxy) NewPacketEx(buffer *buf.Buffer, oob []byte, source M.Socksaddr) {
    destination, err := redir.GetOriginalDestinationFromOOB(oob)
    if err != nil {
        t.logger.Warn("get tproxy destination: ", err)
        return
    }
    t.udpNat.NewPacket([][]byte{buffer.Bytes()}, source, M.SocksaddrFromNetIP(destination), nil)
}
```

Функция `redir.GetOriginalDestinationFromOOB` разбирает вспомогательное сообщение `IP_RECVORIGDSTADDR` из OOB-данных для извлечения оригинального назначения.

### UDP NAT

TProxy использует `udpnat.Service` для отслеживания UDP-сессий:

```go
tproxy.udpNat = udpnat.New(tproxy, tproxy.preparePacketConnection, udpTimeout, false)
```

При создании новой UDP-сессии создаётся писатель пакетов, который может отправлять ответы обратно:

```go
func (t *TProxy) preparePacketConnection(source, destination, userData) (bool, context.Context, N.PacketWriter, N.CloseHandlerFunc) {
    writer := &tproxyPacketWriter{
        listener:    t.listener,
        source:      source.AddrPort(),
        destination: destination,
    }
    return true, ctx, writer, func(it error) {
        common.Close(common.PtrOrNil(writer.conn))
    }
}
```

### Обратная отправка UDP через TProxy

Писатель пакетов TProxy должен отправлять UDP-ответы с подменённым адресом источника (оригинальным назначением). Это требует `IP_TRANSPARENT` и `SO_REUSEADDR`:

```go
func (w *tproxyPacketWriter) WritePacket(buffer *buf.Buffer, destination M.Socksaddr) error {
    // Повторно использовать кэшированное соединение, если назначение совпадает
    if w.destination == destination && w.conn != nil {
        _, err := w.conn.WriteToUDPAddrPort(buffer.Bytes(), w.source)
        return err
    }

    // Создать новый сокет, привязанный к назначению (подменённый источник)
    var listenConfig net.ListenConfig
    listenConfig.Control = control.Append(listenConfig.Control, control.ReuseAddr())
    listenConfig.Control = control.Append(listenConfig.Control, redir.TProxyWriteBack())
    packetConn, _ := w.listener.ListenPacket(listenConfig, w.ctx, "udp", destination.String())
    udpConn := packetConn.(*net.UDPConn)
    udpConn.WriteToUDPAddrPort(buffer.Bytes(), w.source)
}
```

Управляющая функция `redir.TProxyWriteBack()` устанавливает `IP_TRANSPARENT` на ответном сокете, позволяя ему привязаться к нелокальному адресу (оригинальному назначению), чтобы ответ казался пришедшим от правильного источника.

### Необходимые правила iptables

```bash
# TCP
iptables -t mangle -A PREROUTING -p tcp --dport 1:65535 -j TPROXY \
    --on-port <listen_port> --tproxy-mark 0x1/0x1

# UDP
iptables -t mangle -A PREROUTING -p udp --dport 1:65535 -j TPROXY \
    --on-port <listen_port> --tproxy-mark 0x1/0x1

# Маршрутизировать помеченные пакеты на loopback
ip rule add fwmark 0x1/0x1 lookup 100
ip route add local default dev lo table 100
```

## Примеры конфигурации

### Redirect

```json
{
  "type": "redirect",
  "tag": "redirect-in",
  "listen": "::",
  "listen_port": 12345
}
```

### TProxy

```json
{
  "type": "tproxy",
  "tag": "tproxy-in",
  "listen": "::",
  "listen_port": 12345,
  "network": ["tcp", "udp"],
  "udp_timeout": "5m"
}
```

## Ограничения платформы

И redirect, и TProxy работают **только в Linux**. Пакет `redir` содержит платформозависимые реализации:

- `redir.GetOriginalDestination(conn)` -- использует `getsockopt(SO_ORIGINAL_DST)`, только Linux
- `redir.GetOriginalDestinationFromOOB(oob)` -- разбирает вспомогательные данные `IP_RECVORIGDSTADDR`, только Linux
- `redir.TProxyWriteBack()` -- устанавливает `IP_TRANSPARENT`, только Linux

На не-Linux платформах эти протоколы недоступны. Используйте входящее соединение TUN для прозрачного проксирования.
