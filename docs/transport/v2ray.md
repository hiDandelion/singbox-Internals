# V2Ray Transport Factory

Source: `transport/v2ray/transport.go`, `transport/v2ray/quic.go`, `transport/v2ray/grpc.go`, `transport/v2ray/grpc_lite.go`

## Factory Pattern

The V2Ray transport factory uses generic type aliases and a type-switch dispatcher to create server and client transports. This is the single entry point for all V2Ray transport creation.

### Generic Constructor Types

```go
type (
    ServerConstructor[O any] func(
        ctx context.Context,
        logger logger.ContextLogger,
        options O,
        tlsConfig tls.ServerConfig,
        handler adapter.V2RayServerTransportHandler,
    ) (adapter.V2RayServerTransport, error)

    ClientConstructor[O any] func(
        ctx context.Context,
        dialer N.Dialer,
        serverAddr M.Socksaddr,
        options O,
        tlsConfig tls.Config,
    ) (adapter.V2RayClientTransport, error)
)
```

These generic types parameterize the options struct `O`, allowing each transport to define its own configuration type while sharing the same constructor signature.

### Server Transport Dispatch

```go
func NewServerTransport(ctx context.Context, logger logger.ContextLogger,
    options option.V2RayTransportOptions, tlsConfig tls.ServerConfig,
    handler adapter.V2RayServerTransportHandler) (adapter.V2RayServerTransport, error) {
    if options.Type == "" {
        return nil, nil
    }
    switch options.Type {
    case C.V2RayTransportTypeHTTP:
        return v2rayhttp.NewServer(ctx, logger, options.HTTPOptions, tlsConfig, handler)
    case C.V2RayTransportTypeWebsocket:
        return v2raywebsocket.NewServer(ctx, logger, options.WebsocketOptions, tlsConfig, handler)
    case C.V2RayTransportTypeQUIC:
        if tlsConfig == nil {
            return nil, C.ErrTLSRequired
        }
        return NewQUICServer(ctx, logger, options.QUICOptions, tlsConfig, handler)
    case C.V2RayTransportTypeGRPC:
        return NewGRPCServer(ctx, logger, options.GRPCOptions, tlsConfig, handler)
    case C.V2RayTransportTypeHTTPUpgrade:
        return v2rayhttpupgrade.NewServer(ctx, logger, options.HTTPUpgradeOptions, tlsConfig, handler)
    default:
        return nil, E.New("unknown transport type: " + options.Type)
    }
}
```

Key behaviors:
- Empty type returns `nil, nil` (no transport configured)
- QUIC requires TLS -- returns `C.ErrTLSRequired` if `tlsConfig` is nil
- HTTP, WebSocket, and HTTP Upgrade are directly imported and called
- gRPC and QUIC are dispatched through intermediate functions that handle build-tag switching

### Client Transport Dispatch

`NewClientTransport` follows the same pattern. The client variant receives an `N.Dialer` and `M.Socksaddr` instead of a handler:

```go
func NewClientTransport(ctx context.Context, dialer N.Dialer, serverAddr M.Socksaddr,
    options option.V2RayTransportOptions, tlsConfig tls.Config) (adapter.V2RayClientTransport, error)
```

Note the TLS config is `tls.Config` (client interface) vs `tls.ServerConfig` (server interface).

## QUIC Registration Pattern

QUIC transport requires the `with_quic` build tag. Since the core `v2ray` package cannot directly import `v2rayquic` (which may not be compiled), it uses a registration pattern:

```go
// quic.go
var (
    quicServerConstructor ServerConstructor[option.V2RayQUICOptions]
    quicClientConstructor ClientConstructor[option.V2RayQUICOptions]
)

func RegisterQUICConstructor(
    server ServerConstructor[option.V2RayQUICOptions],
    client ClientConstructor[option.V2RayQUICOptions],
) {
    quicServerConstructor = server
    quicClientConstructor = client
}

func NewQUICServer(...) (adapter.V2RayServerTransport, error) {
    if quicServerConstructor == nil {
        return nil, os.ErrInvalid
    }
    return quicServerConstructor(ctx, logger, options, tlsConfig, handler)
}
```

The `v2rayquic` package registers itself via `init()`:

```go
// v2rayquic/init.go
//go:build with_quic

func init() {
    v2ray.RegisterQUICConstructor(NewServer, NewClient)
}
```

If compiled without `with_quic`, the constructors remain nil, and `NewQUICServer`/`NewQUICClient` return `os.ErrInvalid`.

## gRPC Build Tag Switching

gRPC has two implementations controlled by build tags:

**With `with_grpc` (grpc.go)**:

```go
//go:build with_grpc

func NewGRPCServer(...) (adapter.V2RayServerTransport, error) {
    if options.ForceLite {
        return v2raygrpclite.NewServer(ctx, logger, options, tlsConfig, handler)
    }
    return v2raygrpc.NewServer(ctx, logger, options, tlsConfig, handler)
}
```

When the full gRPC library is available, the user can still force the lite implementation via `options.ForceLite`.

**Without `with_grpc` (grpc_lite.go)**:

```go
//go:build !with_grpc

func NewGRPCServer(...) (adapter.V2RayServerTransport, error) {
    return v2raygrpclite.NewServer(ctx, logger, options, tlsConfig, handler)
}
```

Without the build tag, the lite implementation is always used regardless of `ForceLite`.

## Configuration

```json
{
  "transport": {
    "type": "ws",
    "path": "/path",
    "headers": {
      "Host": "example.com"
    },
    "max_early_data": 2048,
    "early_data_header_name": "Sec-WebSocket-Protocol"
  }
}
```

The `V2RayTransportOptions` struct contains a `Type` string and sub-option structs for each transport type (`HTTPOptions`, `WebsocketOptions`, `QUICOptions`, `GRPCOptions`, `HTTPUpgradeOptions`). Only the sub-options matching the selected type are used.
