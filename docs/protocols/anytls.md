# AnyTLS Protocol

AnyTLS is a TLS-based proxy protocol featuring session multiplexing, configurable padding schemes, and idle session management. sing-box integrates the external `sing-anytls` library from the `anytls` project.

**Source**: `protocol/anytls/inbound.go`, `protocol/anytls/outbound.go`, `sing-anytls`

## Architecture Overview

```go
// Inbound
type Inbound struct {
    inbound.Adapter
    tlsConfig tls.ServerConfig
    router    adapter.ConnectionRouterEx
    logger    logger.ContextLogger
    listener  *listener.Listener
    service   *anytls.Service
}

// Outbound
type Outbound struct {
    outbound.Adapter
    dialer    tls.Dialer
    server    M.Socksaddr
    tlsConfig tls.Config
    client    *anytls.Client
    uotClient *uot.Client
    logger    log.ContextLogger
}
```

## Inbound Implementation

### TLS Handling

Unlike protocols like Hysteria2 which require TLS, AnyTLS makes TLS optional on the inbound -- the TLS handshake is handled explicitly before passing to the service:

```go
if options.TLS != nil && options.TLS.Enabled {
    tlsConfig, err := tls.NewServer(ctx, logger, common.PtrValueOrDefault(options.TLS))
    inbound.tlsConfig = tlsConfig
}
```

When TLS is configured, each connection undergoes a TLS handshake before protocol processing:

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    if h.tlsConfig != nil {
        tlsConn, err := tls.ServerHandshake(ctx, conn, h.tlsConfig)
        if err != nil {
            N.CloseOnHandshakeFailure(conn, onClose, err)
            return
        }
        conn = tlsConn
    }
    err := h.service.NewConnection(ctx, conn, metadata.Source, onClose)
}
```

### Padding Scheme

AnyTLS uses a configurable padding scheme to obfuscate traffic patterns. The scheme is defined as a multi-line string:

```go
paddingScheme := padding.DefaultPaddingScheme
if len(options.PaddingScheme) > 0 {
    paddingScheme = []byte(strings.Join(options.PaddingScheme, "\n"))
}

service, _ := anytls.NewService(anytls.ServiceConfig{
    Users:         common.Map(options.Users, func(it option.AnyTLSUser) anytls.User {
        return (anytls.User)(it)
    }),
    PaddingScheme: paddingScheme,
    Handler:       (*inboundHandler)(inbound),
    Logger:        logger,
})
```

### TCP-Only Listener

AnyTLS only supports TCP connections:

```go
inbound.listener = listener.New(listener.Options{
    Network:           []string{N.NetworkTCP},
    ConnectionHandler: inbound,
})
```

### Inbound Handler Pattern

AnyTLS uses the type-cast handler pattern (same as ShadowTLS). The `Inbound` type handles raw connections, while an `inboundHandler` type alias handles decoded connections:

```go
type inboundHandler Inbound

func (h *inboundHandler) NewConnectionEx(ctx, conn, source, destination, onClose) {
    metadata.Destination = destination.Unwrap()
    if userName, _ := auth.UserFromContext[string](ctx); userName != "" {
        metadata.User = userName
    }
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## Outbound Implementation

### TLS Requirement

The outbound requires TLS:

```go
if options.TLS == nil || !options.TLS.Enabled {
    return nil, C.ErrTLSRequired
}
```

### TCP Fast Open Incompatibility

AnyTLS is explicitly incompatible with TCP Fast Open. TFO creates lazy connections that defer establishment until the first write, but AnyTLS needs the remote address during handshake:

```go
if options.DialerOptions.TCPFastOpen {
    return nil, E.New("tcp_fast_open is not supported with anytls outbound")
}
```

### Session Pooling

The client maintains a pool of idle TLS sessions for connection reuse. Session management is configurable:

```go
client, _ := anytls.NewClient(ctx, anytls.ClientConfig{
    Password:                 options.Password,
    IdleSessionCheckInterval: options.IdleSessionCheckInterval.Build(),
    IdleSessionTimeout:       options.IdleSessionTimeout.Build(),
    MinIdleSession:           options.MinIdleSession,
    DialOut:                  outbound.dialOut,
    Logger:                   logger,
})
```

Key session parameters:
- **IdleSessionCheckInterval**: How often to check for idle sessions
- **IdleSessionTimeout**: How long before an idle session is closed
- **MinIdleSession**: Minimum number of idle sessions to maintain in the pool

### Dial Out Function

The `DialOut` callback creates new TLS connections for the session pool:

```go
func (h *Outbound) dialOut(ctx context.Context) (net.Conn, error) {
    return h.dialer.DialTLSContext(ctx, h.server)
}
```

### TCP Connections via CreateProxy

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    switch N.NetworkName(network) {
    case N.NetworkTCP:
        return h.client.CreateProxy(ctx, destination)
    case N.NetworkUDP:
        return h.uotClient.DialContext(ctx, network, destination)
    }
}
```

### UDP via UoT

UDP is supported through UDP-over-TCP using the `uot` package. The UoT client wraps the AnyTLS client's `CreateProxy` method:

```go
outbound.uotClient = &uot.Client{
    Dialer:  (anytlsDialer)(client.CreateProxy),
    Version: uot.Version,
}
```

The `anytlsDialer` adapter converts the `CreateProxy` function signature to the `N.Dialer` interface:

```go
type anytlsDialer func(ctx context.Context, destination M.Socksaddr) (net.Conn, error)

func (d anytlsDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    return d(ctx, destination)
}

func (d anytlsDialer) ListenPacket(ctx, destination) (net.PacketConn, error) {
    return nil, os.ErrInvalid
}
```

### UoT Router (Inbound)

The inbound wraps its router with UoT support:

```go
inbound.router = uot.NewRouter(router, logger)
```

## Configuration Examples

### Inbound

```json
{
  "type": "anytls",
  "tag": "anytls-in",
  "listen": "::",
  "listen_port": 443,
  "users": [
    { "name": "user1", "password": "user-password" }
  ],
  "padding_scheme": [
    "0:100",
    "200:500"
  ],
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  }
}
```

### Outbound

```json
{
  "type": "anytls",
  "tag": "anytls-out",
  "server": "example.com",
  "server_port": 443,
  "password": "user-password",
  "idle_session_check_interval": "30s",
  "idle_session_timeout": "30s",
  "min_idle_session": 1,
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```
