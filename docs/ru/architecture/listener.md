# Система прослушивания (Listener)

Система Listener предоставляет общие реализации TCP- и UDP-слушателей, используемые всеми входящими протоколами.

**Исходный код**: `common/listener/`

## TCP-слушатель

```go
type Listener struct {
    ctx          context.Context
    logger       logger.ContextLogger
    network      []string
    listenAddr   netip.AddrPort
    tcpListener  *net.TCPListener
    handler      adapter.ConnectionHandlerEx
    threadUnsafe bool
    // TLS, proxy protocol, etc.
}
```

### Возможности

- **Адрес прослушивания**: Привязка к конкретному адресу IPv4/IPv6 и порту
- **Опции TCP**: `SO_REUSEADDR`, `TCP_FASTOPEN`, `TCP_DEFER_ACCEPT`
- **Proxy Protocol**: Поддержка HAProxy proxy protocol v1/v2
- **Потокобезопасность**: Опциональный однопоточный режим для протоколов, которым это необходимо

### Цикл приёма соединений

```go
func (l *Listener) loopTCPIn() {
    for {
        conn, err := l.tcpListener.AcceptTCP()
        if err != nil {
            return
        }
        // Apply proxy protocol if configured
        // Wrap with TLS if configured
        go l.handler.NewConnectionEx(ctx, conn, metadata, onClose)
    }
}
```

## UDP-слушатель

```go
type UDPListener struct {
    ctx        context.Context
    logger     logger.ContextLogger
    listenAddr netip.AddrPort
    udpConn    *net.UDPConn
    handler    adapter.PacketHandlerEx
    // OOB handler for TProxy
}
```

### Возможности

- **OOB-данные**: Для TProxy внеполосные данные содержат исходный адрес назначения
- **Обработчик пакетов**: Передаёт отдельные пакеты с адресом источника

### Цикл чтения

```go
func (l *UDPListener) loopUDPIn() {
    buffer := buf.NewPacket()
    for {
        n, addr, err := l.udpConn.ReadFromUDPAddrPort(buffer.FreeBytes())
        if err != nil {
            return
        }
        buffer.Truncate(n)
        l.handler.NewPacketEx(buffer, M.SocksaddrFromNetIP(addr))
        buffer = buf.NewPacket()
    }
}
```

## Общие опции прослушивания

```go
type ListenOptions struct {
    Listen         ListenAddress
    ListenPort     uint16
    ListenFields   ListenFields
    TCPFastOpen    bool
    TCPMultiPath   bool
    UDPFragment    *bool
    UDPTimeout     Duration
    ProxyProtocol  bool
    ProxyProtocolAcceptNoHeader bool
    Detour         string
    InboundOptions
}

type InboundOptions struct {
    SniffEnabled              bool
    SniffOverrideDestination  bool
    SniffTimeout              Duration
    DomainStrategy            DomainStrategy
}
```

## Поддержка Proxy Protocol

Когда установлен `proxy_protocol: true`, слушатель оборачивает соединения парсингом proxy protocol:

```go
import proxyproto "github.com/pires/go-proxyproto"

listener = &proxyproto.Listener{
    Listener: tcpListener,
    Policy: func(upstream net.Addr) (proxyproto.Policy, error) {
        if acceptNoHeader {
            return proxyproto.USE, nil
        }
        return proxyproto.REQUIRE, nil
    },
}
```

Это извлекает исходный адрес клиента, находящегося за балансировщиками нагрузки/обратными прокси.
