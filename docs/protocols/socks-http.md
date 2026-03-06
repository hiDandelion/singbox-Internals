# SOCKS, HTTP, and Mixed Protocols

sing-box implements SOCKS4/5, HTTP CONNECT, and a combined "mixed" listener that auto-detects the protocol. All three share similar patterns: TCP-only listening, optional TLS, username/password authentication, and UoT (UDP-over-TCP) support.

**Source**: `protocol/socks/inbound.go`, `protocol/http/inbound.go`, `protocol/mixed/inbound.go`, `protocol/socks/outbound.go`, `protocol/http/outbound.go`

## SOCKS Inbound

### Architecture

```go
type Inbound struct {
    inbound.Adapter
    router        adapter.ConnectionRouterEx
    logger        logger.ContextLogger
    listener      *listener.Listener
    authenticator *auth.Authenticator
    udpTimeout    time.Duration
}
```

The SOCKS inbound implements `adapter.TCPInjectableInbound`:

```go
var _ adapter.TCPInjectableInbound = (*Inbound)(nil)
```

### Connection Processing

SOCKS connections are delegated to `sing/protocol/socks.HandleConnectionEx`, which handles the full SOCKS4/5 handshake:

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    err := socks.HandleConnectionEx(ctx, conn, std_bufio.NewReader(conn),
        h.authenticator,
        adapter.NewUpstreamHandlerEx(metadata, h.newUserConnection, h.streamUserPacketConnection),
        h.listener,         // UDP associate listener
        h.udpTimeout,
        metadata.Source,
        onClose,
    )
    N.CloseOnHandshakeFailure(conn, onClose, err)
}
```

The handler receives decoded TCP connections and UDP packet connections after the SOCKS handshake:

```go
func (h *Inbound) newUserConnection(ctx, conn, metadata, onClose) {
    metadata.Inbound = h.Tag()
    metadata.InboundType = h.Type()
    user, loaded := auth.UserFromContext[string](ctx)
    if loaded {
        metadata.User = user
    }
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### UoT Support

The router is wrapped with UoT support for handling UDP-over-TCP:

```go
inbound.router = uot.NewRouter(router, logger)
```

### TCP-Only Listener

SOCKS listens only on TCP. UDP associate connections are handled through the SOCKS5 UDP relay mechanism (using the `listener` as the UDP associate target):

```go
inbound.listener = listener.New(listener.Options{
    Network:           []string{N.NetworkTCP},
    ConnectionHandler: inbound,
})
```

## HTTP Inbound

### Architecture

```go
type Inbound struct {
    inbound.Adapter
    router        adapter.ConnectionRouterEx
    logger        log.ContextLogger
    listener      *listener.Listener
    authenticator *auth.Authenticator
    tlsConfig     tls.ServerConfig
}
```

### TLS Support with kTLS

HTTP inbound supports TLS with kTLS compatibility enabled:

```go
if options.TLS != nil {
    tlsConfig, _ := tls.NewServerWithOptions(tls.ServerOptions{
        KTLSCompatible: true,
    })
    inbound.tlsConfig = tlsConfig
}
```

### Connection Processing

TLS handshake is performed first (if configured), then the HTTP CONNECT handler processes the request:

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    if h.tlsConfig != nil {
        tlsConn, _ := tls.ServerHandshake(ctx, conn, h.tlsConfig)
        conn = tlsConn
    }
    err := http.HandleConnectionEx(ctx, conn, std_bufio.NewReader(conn),
        h.authenticator,
        adapter.NewUpstreamHandlerEx(metadata, h.newUserConnection, h.streamUserPacketConnection),
        metadata.Source,
        onClose,
    )
}
```

### System Proxy

HTTP inbound can configure itself as the system proxy:

```go
inbound.listener = listener.New(listener.Options{
    SetSystemProxy:    options.SetSystemProxy,
    SystemProxySOCKS:  false,
})
```

## Mixed Inbound

The mixed inbound combines SOCKS and HTTP on a single port by peeking the first byte of each connection.

### Architecture

```go
type Inbound struct {
    inbound.Adapter
    router        adapter.ConnectionRouterEx
    logger        log.ContextLogger
    listener      *listener.Listener
    authenticator *auth.Authenticator
    tlsConfig     tls.ServerConfig
    udpTimeout    time.Duration
}
```

### Protocol Detection

The core logic peeks the first byte to determine the protocol:

```go
func (h *Inbound) newConnection(ctx, conn, metadata, onClose) error {
    if h.tlsConfig != nil {
        conn = tls.ServerHandshake(ctx, conn, h.tlsConfig)
    }
    reader := std_bufio.NewReader(conn)
    headerBytes, _ := reader.Peek(1)

    switch headerBytes[0] {
    case socks4.Version, socks5.Version:
        // SOCKS4 (0x04) or SOCKS5 (0x05)
        return socks.HandleConnectionEx(ctx, conn, reader, h.authenticator, ...)
    default:
        // Anything else is treated as HTTP
        return http.HandleConnectionEx(ctx, conn, reader, h.authenticator, ...)
    }
}
```

- **SOCKS4**: First byte is `0x04`
- **SOCKS5**: First byte is `0x05`
- **HTTP**: Any other first byte (typically `C` for CONNECT, `G` for GET, etc.)

### System Proxy (Mixed)

When mixed is set as system proxy, it reports the SOCKS port:

```go
inbound.listener = listener.New(listener.Options{
    SetSystemProxy:    options.SetSystemProxy,
    SystemProxySOCKS:  true,  // Advertise SOCKS port in system proxy
})
```

## SOCKS Outbound

The SOCKS outbound connects through an upstream SOCKS5 server. It is implemented in `protocol/socks/outbound.go` and uses the `sing/protocol/socks` library's `Client` type.

## HTTP Outbound

The HTTP outbound connects through an upstream HTTP CONNECT proxy. It supports TLS to the proxy server.

## Common Patterns

### User Authentication

All three inbound types use the same authentication mechanism:

```go
authenticator := auth.NewAuthenticator(options.Users)
```

Users are `auth.User` structs with `Username` and `Password` fields. The authenticator is passed to the protocol handlers.

### User Metadata

After authentication, the username is extracted from context and stored in metadata:

```go
user, loaded := auth.UserFromContext[string](ctx)
if loaded {
    metadata.User = user
}
```

### TCP Injectable

Both SOCKS and Mixed inbound implement `adapter.TCPInjectableInbound`, allowing other components to inject TCP connections into them (used by transparent proxy mechanisms).

## Configuration Examples

### SOCKS Inbound

```json
{
  "type": "socks",
  "tag": "socks-in",
  "listen": "127.0.0.1",
  "listen_port": 1080,
  "users": [
    { "username": "user1", "password": "pass1" }
  ]
}
```

### HTTP Inbound (with TLS)

```json
{
  "type": "http",
  "tag": "http-in",
  "listen": "127.0.0.1",
  "listen_port": 8080,
  "users": [
    { "username": "user1", "password": "pass1" }
  ],
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  },
  "set_system_proxy": true
}
```

### Mixed Inbound

```json
{
  "type": "mixed",
  "tag": "mixed-in",
  "listen": "127.0.0.1",
  "listen_port": 2080,
  "users": [
    { "username": "user1", "password": "pass1" }
  ],
  "set_system_proxy": true
}
```
