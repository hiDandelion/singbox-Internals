# Listener System

The listener system provides shared TCP and UDP listener implementations used by all inbound protocols.

**Source**: `common/listener/`

## TCP Listener

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

### Features

- **Listen address**: Bind to specific IPv4/IPv6 address and port
- **TCP options**: `SO_REUSEADDR`, `TCP_FASTOPEN`, `TCP_DEFER_ACCEPT`
- **Proxy Protocol**: HAProxy proxy protocol v1/v2 support
- **Thread-safe/unsafe**: Optional single-goroutine mode for protocols that need it

### Accept Loop

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

## UDP Listener

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

### Features

- **OOB data**: For TProxy, out-of-band data carries the original destination
- **Packet handler**: Passes individual packets with source address

### Read Loop

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

## Shared Listen Options

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

## Proxy Protocol Support

When `proxy_protocol: true` is set, the listener wraps connections with proxy protocol parsing:

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

This extracts the original client address from behind load balancers/reverse proxies.
