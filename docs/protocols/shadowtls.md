# ShadowTLS Protocol

ShadowTLS is a transport-layer protocol that disguises proxy traffic as legitimate TLS traffic by hijacking the TLS handshake with a real server. It supports three protocol versions with increasing sophistication.

**Source**: `protocol/shadowtls/inbound.go`, `protocol/shadowtls/outbound.go`, `sing-shadowtls`

## Protocol Concept

Unlike traditional TLS-based proxies that generate their own certificates (detectable via certificate checks), ShadowTLS performs a real TLS handshake with a legitimate server (e.g., `www.microsoft.com`), making the handshake indistinguishable from normal HTTPS traffic to observers. After the handshake, the data channel is hijacked to carry proxy traffic.

## Protocol Versions

### Version 1

The simplest version. The client initiates a TLS handshake through the ShadowTLS server, which relays it to a real TLS server (the "handshake server"). After the handshake completes, the TLS connection is repurposed for proxy data.

**Limitation**: Forces TLS 1.2 to ensure predictable handshake behavior.

```go
if options.Version == 1 {
    options.TLS.MinVersion = "1.2"
    options.TLS.MaxVersion = "1.2"
}
```

### Version 2

Adds password-based authentication. The server can distinguish legitimate ShadowTLS clients from probes. Supports per-SNI handshake servers:

```go
if options.Version > 1 {
    handshakeForServerName = make(map[string]shadowtls.HandshakeConfig)
    for _, entry := range options.HandshakeForServerName.Entries() {
        handshakeForServerName[entry.Key] = shadowtls.HandshakeConfig{
            Server: entry.Value.ServerOptions.Build(),
            Dialer: handshakeDialer,
        }
    }
}
```

### Version 3

The most advanced version. Introduces session ID-based channel binding -- the client and server embed authentication data within the TLS session ID, enabling verification without an additional round trip.

```go
case 3:
    if idConfig, loaded := tlsConfig.(tls.WithSessionIDGenerator); loaded {
        // Use the TLS library's session ID hook
        tlsHandshakeFunc = func(ctx, conn, sessionIDGenerator) error {
            idConfig.SetSessionIDGenerator(sessionIDGenerator)
            return tls.ClientHandshake(ctx, conn, tlsConfig)
        }
    } else {
        // Fallback to standard TLS with manual session ID injection
        stdTLSConfig := tlsConfig.STDConfig()
        tlsHandshakeFunc = shadowtls.DefaultTLSHandshakeFunc(password, stdTLSConfig)
    }
```

## Inbound Architecture

```go
type Inbound struct {
    inbound.Adapter
    router   adapter.Router
    logger   logger.ContextLogger
    listener *listener.Listener
    service  *shadowtls.Service
}
```

### Service Configuration

```go
service, _ := shadowtls.NewService(shadowtls.ServiceConfig{
    Version:  options.Version,
    Password: options.Password,
    Users: common.Map(options.Users, func(it option.ShadowTLSUser) shadowtls.User {
        return (shadowtls.User)(it)
    }),
    Handshake: shadowtls.HandshakeConfig{
        Server: options.Handshake.ServerOptions.Build(),
        Dialer: handshakeDialer,
    },
    HandshakeForServerName: handshakeForServerName,  // per-SNI routing
    StrictMode:             options.StrictMode,
    WildcardSNI:            shadowtls.WildcardSNI(options.WildcardSNI),
    Handler:                (*inboundHandler)(inbound),
    Logger:                 logger,
})
```

Key fields:

- **Handshake**: The default handshake target server
- **HandshakeForServerName**: Map of SNI -> handshake server for multi-domain support
- **StrictMode**: Reject connections that fail authentication (vs. silently forwarding)
- **WildcardSNI**: Accept any SNI value (useful for CDN scenarios)

### Wildcard SNI

The `WildcardSNI` option controls how SNI is handled:

```go
serverIsDomain := options.Handshake.ServerIsDomain()
if options.WildcardSNI != option.ShadowTLSWildcardSNIOff {
    serverIsDomain = true  // force domain resolution for wildcard
}
```

### Connection Flow (Inbound)

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    // ShadowTLS service handles the entire handshake relay and data extraction
    err := h.service.NewConnection(ctx, conn, metadata.Source, metadata.Destination, onClose)
    N.CloseOnHandshakeFailure(conn, onClose, err)
}
```

After the ShadowTLS service extracts the real data stream, it calls the inbound handler:

```go
type inboundHandler Inbound

func (h *inboundHandler) NewConnectionEx(ctx, conn, source, destination, onClose) {
    metadata.Inbound = h.Tag()
    metadata.InboundType = h.Type()
    metadata.Source = source
    metadata.Destination = destination
    if userName, _ := auth.UserFromContext[string](ctx); userName != "" {
        metadata.User = userName
    }
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## Outbound Architecture

```go
type Outbound struct {
    outbound.Adapter
    client *shadowtls.Client
}
```

ShadowTLS outbound is TCP-only and serves as a **transport wrapper** -- it is typically chained with another protocol (e.g., Shadowsocks):

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    switch network {
    case "tcp":
        return h.client.DialContext(ctx)   // returns a "clean" conn
    default:
        return nil, os.ErrInvalid          // UDP not supported
    }
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    return nil, os.ErrInvalid              // UDP not supported
}
```

### TLS Requirement

ShadowTLS outbound **requires** TLS to be enabled:

```go
if options.TLS == nil || !options.TLS.Enabled {
    return nil, C.ErrTLSRequired
}
```

### Client Configuration

```go
client, _ := shadowtls.NewClient(shadowtls.ClientConfig{
    Version:      options.Version,
    Password:     options.Password,
    Server:       options.ServerOptions.Build(),
    Dialer:       outboundDialer,
    TLSHandshake: tlsHandshakeFunc,   // version-specific handshake
    Logger:       logger,
})
```

### Version-Specific TLS Handshake

```go
var tlsHandshakeFunc shadowtls.TLSHandshakeFunc

switch options.Version {
case 1, 2:
    // Simple: just do the TLS handshake
    tlsHandshakeFunc = func(ctx, conn, _ TLSSessionIDGeneratorFunc) error {
        return common.Error(tls.ClientHandshake(ctx, conn, tlsConfig))
    }

case 3:
    // Complex: inject session ID generator for channel binding
    tlsHandshakeFunc = func(ctx, conn, sessionIDGenerator) error {
        idConfig.SetSessionIDGenerator(sessionIDGenerator)
        return common.Error(tls.ClientHandshake(ctx, conn, tlsConfig))
    }
}
```

## How ShadowTLS Works (Detailed)

```
Client                  ShadowTLS Server          Real TLS Server
  |                          |                          |
  |--- TLS ClientHello ---->|--- TLS ClientHello ----->|
  |                          |                          |
  |<-- TLS ServerHello -----|<-- TLS ServerHello ------|
  |<-- Certificate ---------|<-- Certificate ----------|
  |<-- ServerHelloDone -----|<-- ServerHelloDone ------|
  |                          |                          |
  |--- ClientKeyExchange -->|--- ClientKeyExchange --->|
  |--- ChangeCipherSpec --->|--- ChangeCipherSpec ---->|
  |--- Finished ----------->|--- Finished ------------>|
  |                          |                          |
  |<-- ChangeCipherSpec ----|<-- ChangeCipherSpec -----|
  |<-- Finished ------------|<-- Finished -------------|
  |                          |                          |
  |  [TLS handshake done - observer sees valid cert]   |
  |                          |                          |
  |=== Proxy Data =========>|  [data NOT sent to real  |
  |<=== Proxy Data =========|   TLS server anymore]    |
```

After the handshake, the ShadowTLS server:
1. Disconnects from the real TLS server
2. Extracts the proxy data stream from the client
3. Forwards it to the configured inner handler

## Typical Usage Pattern

ShadowTLS is used as a **detour** for another protocol:

```json
{
  "outbounds": [
    {
      "type": "shadowsocks",
      "tag": "ss-out",
      "detour": "shadowtls-out",
      "method": "2022-blake3-aes-256-gcm",
      "password": "ss-password"
    },
    {
      "type": "shadowtls",
      "tag": "shadowtls-out",
      "server": "my-server.com",
      "server_port": 443,
      "version": 3,
      "password": "shadowtls-password",
      "tls": {
        "enabled": true,
        "server_name": "www.microsoft.com"
      }
    }
  ]
}
```

The Shadowsocks connection is tunneled through the ShadowTLS wrapper, which performs the handshake with `www.microsoft.com`'s real certificate.

## Configuration Example (Inbound)

```json
{
  "type": "shadowtls",
  "tag": "shadowtls-in",
  "listen": "::",
  "listen_port": 443,
  "version": 3,
  "users": [
    { "name": "user1", "password": "user-password" }
  ],
  "handshake": {
    "server": "www.microsoft.com",
    "server_port": 443
  },
  "handshake_for_server_name": {
    "www.google.com": {
      "server": "www.google.com",
      "server_port": 443
    }
  },
  "strict_mode": true
}
```
