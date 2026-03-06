# Connection Multiplexing (sing-mux)

Source: `common/mux/client.go`, `common/mux/router.go`

## Overview

sing-box integrates `github.com/sagernet/sing-mux` for connection multiplexing, allowing multiple logical streams over a single underlying connection. It supports optional Brutal congestion control for bandwidth enforcement.

## Client

The client wraps an `N.Dialer` with multiplexing capabilities:

```go
type Client = mux.Client

func NewClientWithOptions(dialer N.Dialer, logger logger.Logger, options option.OutboundMultiplexOptions) (*Client, error) {
    if !options.Enabled {
        return nil, nil
    }
    var brutalOptions mux.BrutalOptions
    if options.Brutal != nil && options.Brutal.Enabled {
        brutalOptions = mux.BrutalOptions{
            Enabled:    true,
            SendBPS:    uint64(options.Brutal.UpMbps * C.MbpsToBps),
            ReceiveBPS: uint64(options.Brutal.DownMbps * C.MbpsToBps),
        }
        if brutalOptions.SendBPS < mux.BrutalMinSpeedBPS {
            return nil, E.New("brutal: invalid upload speed")
        }
        if brutalOptions.ReceiveBPS < mux.BrutalMinSpeedBPS {
            return nil, E.New("brutal: invalid download speed")
        }
    }
    return mux.NewClient(mux.Options{
        Dialer:         &clientDialer{dialer},
        Logger:         logger,
        Protocol:       options.Protocol,
        MaxConnections: options.MaxConnections,
        MinStreams:      options.MinStreams,
        MaxStreams:      options.MaxStreams,
        Padding:        options.Padding,
        Brutal:         brutalOptions,
    })
}
```

### Context Override

The client dialer wraps the original dialer to apply context overrides:

```go
type clientDialer struct {
    N.Dialer
}

func (d *clientDialer) DialContext(ctx context.Context, network string, destination M.Socksaddr) (net.Conn, error) {
    return d.Dialer.DialContext(adapter.OverrideContext(ctx), network, destination)
}
```

### Brutal Congestion Control

Brutal enforces fixed bandwidth by specifying upload and download speeds in Mbps. The speeds are converted to bytes per second using `C.MbpsToBps`. A minimum speed (`mux.BrutalMinSpeedBPS`) is enforced to prevent misconfiguration.

## Server (Router)

The server side uses a `Router` wrapper that intercepts mux-tagged connections:

```go
type Router struct {
    router  adapter.ConnectionRouterEx
    service *mux.Service
}

func NewRouterWithOptions(router adapter.ConnectionRouterEx, logger logger.ContextLogger, options option.InboundMultiplexOptions) (adapter.ConnectionRouterEx, error) {
    if !options.Enabled {
        return router, nil
    }
    service, err := mux.NewService(mux.ServiceOptions{
        NewStreamContext: func(ctx context.Context, conn net.Conn) context.Context {
            return log.ContextWithNewID(ctx)
        },
        Logger:    logger,
        HandlerEx: adapter.NewRouteContextHandlerEx(router),
        Padding:   options.Padding,
        Brutal:    brutalOptions,
    })
    return &Router{router, service}, nil
}
```

### Connection Routing

The router checks the destination against `mux.Destination` to detect multiplexed connections:

```go
func (r *Router) RouteConnectionEx(ctx context.Context, conn net.Conn, metadata adapter.InboundContext, onClose N.CloseHandlerFunc) {
    if metadata.Destination == mux.Destination {
        r.service.NewConnectionEx(adapter.WithContext(ctx, &metadata), conn,
            metadata.Source, metadata.Destination, onClose)
        return
    }
    r.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

`mux.Destination` is a sentinel address that signals a multiplexed connection. Non-mux connections pass through to the underlying router unchanged.

Each demultiplexed stream gets a new log ID via `NewStreamContext`.

## Configuration

### Outbound (Client)

```json
{
  "multiplex": {
    "enabled": true,
    "protocol": "smux",
    "max_connections": 4,
    "min_streams": 4,
    "max_streams": 0,
    "padding": false,
    "brutal": {
      "enabled": true,
      "up_mbps": 100,
      "down_mbps": 100
    }
  }
}
```

### Inbound (Server)

```json
{
  "multiplex": {
    "enabled": true,
    "padding": false,
    "brutal": {
      "enabled": true,
      "up_mbps": 100,
      "down_mbps": 100
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `protocol` | Multiplexing protocol (h2mux, smux, yamux) |
| `max_connections` | Maximum underlying connections |
| `min_streams` | Minimum streams per connection before opening a new one |
| `max_streams` | Maximum streams per connection (0 = no limit) |
| `padding` | Enable padding to resist traffic analysis |
| `brutal.up_mbps` | Upload speed in Mbps for Brutal congestion control |
| `brutal.down_mbps` | Download speed in Mbps for Brutal congestion control |
