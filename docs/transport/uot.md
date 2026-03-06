# UDP-over-TCP (UoT)

Source: `common/uot/router.go`

## Overview

UoT (UDP-over-TCP) tunnels UDP traffic through TCP connections. It intercepts connections destined for magic sentinel addresses and converts them into packet-based connections using `github.com/sagernet/sing/common/uot`.

## Magic Addresses

Two sentinel addresses signal UoT connections:

- `uot.MagicAddress` -- Current UoT protocol with request header
- `uot.LegacyMagicAddress` -- Legacy UoT without request header

## Router

The `Router` wraps an existing `ConnectionRouterEx` and intercepts connections by destination FQDN:

```go
type Router struct {
    router adapter.ConnectionRouterEx
    logger logger.ContextLogger
}

func NewRouter(router adapter.ConnectionRouterEx, logger logger.ContextLogger) *Router {
    return &Router{router, logger}
}
```

### Connection Handling (Ex variant)

```go
func (r *Router) RouteConnectionEx(ctx context.Context, conn net.Conn,
    metadata adapter.InboundContext, onClose N.CloseHandlerFunc) {
    switch metadata.Destination.Fqdn {
    case uot.MagicAddress:
        request, err := uot.ReadRequest(conn)
        if err != nil {
            N.CloseOnHandshakeFailure(conn, onClose, err)
            return
        }
        if request.IsConnect {
            r.logger.InfoContext(ctx, "inbound UoT connect connection to ", request.Destination)
        } else {
            r.logger.InfoContext(ctx, "inbound UoT connection to ", request.Destination)
        }
        metadata.Domain = metadata.Destination.Fqdn
        metadata.Destination = request.Destination
        r.router.RoutePacketConnectionEx(ctx, uot.NewConn(conn, *request), metadata, onClose)
        return

    case uot.LegacyMagicAddress:
        r.logger.InfoContext(ctx, "inbound legacy UoT connection")
        metadata.Domain = metadata.Destination.Fqdn
        metadata.Destination = M.Socksaddr{Addr: netip.IPv4Unspecified()}
        r.RoutePacketConnectionEx(ctx, uot.NewConn(conn, uot.Request{}), metadata, onClose)
        return
    }
    r.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### UoT Request Header

For the current protocol (`uot.MagicAddress`), a request header is read from the connection:

- **Destination**: The actual UDP destination address
- **IsConnect**: Boolean flag indicating connect mode vs regular mode

In connect mode, the connection behaves like a connected UDP socket to a single destination. In regular mode, each packet carries its own destination address.

### Legacy Protocol

The legacy protocol (`uot.LegacyMagicAddress`) has no request header. The destination is set to `0.0.0.0` (IPv4 unspecified), and an empty `Request{}` is used.

### Passthrough

Connections not matching either magic address are passed through to the underlying router unchanged:

```go
r.router.RouteConnectionEx(ctx, conn, metadata, onClose)
```

### Packet Connection Conversion

`uot.NewConn(conn, request)` wraps the TCP connection as a `N.PacketConn`. The UoT protocol frames individual UDP packets within the TCP stream, handling:
- Packet length framing
- Per-packet destination addressing (non-connect mode)
- Bidirectional packet streaming

The resulting packet connection is then routed through `RoutePacketConnectionEx` for standard UDP processing.
