# Shadowsocks Protocol

Shadowsocks is an encrypted proxy protocol. sing-box implements three inbound modes (single-user, multi-user, relay) and one outbound, using two distinct library backends: `sing-shadowsocks` for inbound and `sing-shadowsocks2` for outbound.

**Source**: `protocol/shadowsocks/inbound.go`, `inbound_multi.go`, `inbound_relay.go`, `outbound.go`

## Architecture Overview

The Shadowsocks inbound uses a factory pattern -- a single `NewInbound` function dispatches to one of three implementations based on configuration:

```go
func NewInbound(ctx, router, logger, tag, options) (adapter.Inbound, error) {
    if len(options.Users) > 0 && len(options.Destinations) > 0 {
        return nil, E.New("users and destinations must not be combined")
    }
    if len(options.Users) > 0 || options.Managed {
        return newMultiInbound(...)    // Multi-user mode
    } else if len(options.Destinations) > 0 {
        return newRelayInbound(...)    // Relay mode
    } else {
        return newInbound(...)         // Single-user mode
    }
}
```

## Library Split: sing-shadowsocks vs sing-shadowsocks2

| Library | Usage | Ciphers |
|---------|-------|---------|
| `sing-shadowsocks` | Inbound (server) | `shadowaead` (legacy AEAD), `shadowaead_2022` (SIP022) |
| `sing-shadowsocks2` | Outbound (client) | Unified interface for all methods |

The outbound imports `sing-shadowsocks2` which provides a unified `shadowsocks.Method` interface:

```go
import "github.com/sagernet/sing-shadowsocks2"

method, _ := shadowsocks.CreateMethod(ctx, options.Method, shadowsocks.MethodOptions{
    Password: options.Password,
})
```

## Single-User Inbound

```go
type Inbound struct {
    inbound.Adapter
    ctx      context.Context
    router   adapter.ConnectionRouterEx
    logger   logger.ContextLogger
    listener *listener.Listener
    service  shadowsocks.Service         // from sing-shadowsocks
}
```

### Cipher Selection

The method string determines which implementation is used:

```go
switch {
case options.Method == shadowsocks.MethodNone:
    // No encryption (plain proxy)
    service = shadowsocks.NewNoneService(udpTimeout, handler)

case common.Contains(shadowaead.List, options.Method):
    // Legacy AEAD ciphers: aes-128-gcm, aes-256-gcm, chacha20-ietf-poly1305
    service = shadowaead.NewService(method, nil, password, udpTimeout, handler)

case common.Contains(shadowaead_2022.List, options.Method):
    // Shadowsocks 2022 ciphers: 2022-blake3-aes-128-gcm, etc.
    service = shadowaead_2022.NewServiceWithPassword(method, password, udpTimeout, handler, timeFunc)
}
```

### AEAD Ciphers (Legacy)

The `shadowaead` package supports the original AEAD methods:
- `aes-128-gcm`
- `aes-256-gcm`
- `chacha20-ietf-poly1305`

Key derivation uses the EVP_BytesToKey function (OpenSSL-compatible).

### Shadowsocks 2022 (SIP022)

The `shadowaead_2022` package implements the modern Shadowsocks 2022 protocol:
- `2022-blake3-aes-128-gcm`
- `2022-blake3-aes-256-gcm`
- `2022-blake3-chacha20-poly1305`

Key features:
- BLAKE3-based key derivation
- Built-in replay protection
- Time-based authentication (requires NTP sync)

### Dual-Stack Listener

The single-user inbound listens on both TCP and UDP:

```go
inbound.listener = listener.New(listener.Options{
    Network:                  options.Network.Build(),   // ["tcp", "udp"]
    ConnectionHandler:        inbound,                   // TCP
    PacketHandler:            inbound,                   // UDP
    ThreadUnsafePacketWriter: true,
})
```

TCP connections go through `NewConnectionEx`:
```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    err := h.service.NewConnection(ctx, conn, adapter.UpstreamMetadata(metadata))
    N.CloseOnHandshakeFailure(conn, onClose, err)
}
```

UDP packets go through `NewPacketEx`:
```go
func (h *Inbound) NewPacketEx(buffer *buf.Buffer, source M.Socksaddr) {
    h.service.NewPacket(h.ctx, &stubPacketConn{h.listener.PacketWriter()}, buffer, M.Metadata{Source: source})
}
```

## Multi-User Inbound

```go
type MultiInbound struct {
    inbound.Adapter
    ctx      context.Context
    router   adapter.ConnectionRouterEx
    logger   logger.ContextLogger
    listener *listener.Listener
    service  shadowsocks.MultiService[int]   // multi-user service
    users    []option.ShadowsocksUser
    tracker  adapter.SSMTracker              // optional traffic tracking
}
```

### Multi-User Service Creation

```go
if common.Contains(shadowaead_2022.List, options.Method) {
    // SIP022 multi-user: server password + per-user passwords (iPSK)
    service = shadowaead_2022.NewMultiServiceWithPassword[int](
        method, options.Password, udpTimeout, handler, timeFunc)
} else if common.Contains(shadowaead.List, options.Method) {
    // Legacy AEAD multi-user
    service = shadowaead.NewMultiService[int](method, udpTimeout, handler)
}
```

For SIP022, multi-user mode uses **identity PSK (iPSK)**: the server has a main password, and each user has a sub-password that derives a unique identity key.

### User Management

Users can be updated dynamically:

```go
func (h *MultiInbound) UpdateUsers(users []string, uPSKs []string) error {
    err := h.service.UpdateUsersWithPasswords(indices, uPSKs)
    h.users = /* rebuild user list */
    return err
}
```

### Managed Server Support

The `MultiInbound` implements `adapter.ManagedSSMServer` for integration with Shadowsocks Server Management:

```go
var _ adapter.ManagedSSMServer = (*MultiInbound)(nil)

func (h *MultiInbound) SetTracker(tracker adapter.SSMTracker) {
    h.tracker = tracker
}
```

When a tracker is set, connections and packets are wrapped for traffic counting:

```go
if h.tracker != nil {
    conn = h.tracker.TrackConnection(conn, metadata)
}
```

## Relay Inbound

The relay mode is specific to Shadowsocks 2022 and acts as an intermediate relay server:

```go
type RelayInbound struct {
    inbound.Adapter
    service      *shadowaead_2022.RelayService[int]
    destinations []option.ShadowsocksDestination
}
```

Each destination has its own password and target address:

```go
service = shadowaead_2022.NewRelayServiceWithPassword[int](
    method, password, udpTimeout, handler)
service.UpdateUsersWithPasswords(indices, passwords, destinations)
```

The relay receives connections encrypted with the server's key, decrypts to find the destination identifier, then re-encrypts with the destination's key before forwarding.

## Outbound Implementation

The outbound uses `sing-shadowsocks2` for a unified cipher interface:

```go
type Outbound struct {
    outbound.Adapter
    logger          logger.ContextLogger
    dialer          N.Dialer
    method          shadowsocks.Method     // from sing-shadowsocks2
    serverAddr      M.Socksaddr
    plugin          sip003.Plugin          // SIP003 plugin support
    uotClient       *uot.Client            // UDP-over-TCP
    multiplexDialer *mux.Client
}
```

### Connection Establishment

```go
func (h *shadowsocksDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    switch network {
    case "tcp":
        var outConn net.Conn
        if h.plugin != nil {
            outConn = h.plugin.DialContext(ctx)  // SIP003 plugin
        } else {
            outConn = h.dialer.DialContext(ctx, "tcp", h.serverAddr)
        }
        return h.method.DialEarlyConn(outConn, destination)

    case "udp":
        outConn := h.dialer.DialContext(ctx, "udp", h.serverAddr)
        return bufio.NewBindPacketConn(h.method.DialPacketConn(outConn), destination)
    }
}
```

### SIP003 Plugin Support

Shadowsocks outbound supports SIP003 plugins (e.g., simple-obfs, v2ray-plugin):

```go
if options.Plugin != "" {
    outbound.plugin = sip003.CreatePlugin(ctx, options.Plugin, options.PluginOptions, ...)
}
```

### UDP-over-TCP

When native UDP is unavailable, UoT provides UDP transport over a TCP Shadowsocks connection:

```go
uotOptions := options.UDPOverTCP
if uotOptions.Enabled {
    outbound.uotClient = &uot.Client{
        Dialer:  (*shadowsocksDialer)(outbound),
        Version: uotOptions.Version,
    }
}
```

## Replay Protection

The Shadowsocks 2022 protocol includes built-in replay protection via time-based nonces. The NTP time function is passed during service creation:

```go
shadowaead_2022.NewServiceWithPassword(method, password, udpTimeout, handler,
    ntp.TimeFuncFromContext(ctx))  // ensures time-synchronized nonces
```

## Configuration Examples

### Single-User

```json
{
  "type": "shadowsocks",
  "tag": "ss-in",
  "listen": "::",
  "listen_port": 8388,
  "method": "2022-blake3-aes-256-gcm",
  "password": "base64-encoded-32-byte-key"
}
```

### Multi-User (SIP022 iPSK)

```json
{
  "type": "shadowsocks",
  "tag": "ss-multi",
  "listen": "::",
  "listen_port": 8388,
  "method": "2022-blake3-aes-256-gcm",
  "password": "server-main-key-base64",
  "users": [
    { "name": "user1", "password": "user1-key-base64" },
    { "name": "user2", "password": "user2-key-base64" }
  ]
}
```

### Relay

```json
{
  "type": "shadowsocks",
  "tag": "ss-relay",
  "listen": "::",
  "listen_port": 8388,
  "method": "2022-blake3-aes-256-gcm",
  "password": "relay-server-key",
  "destinations": [
    {
      "name": "dest1",
      "password": "dest1-key",
      "server": "dest1.example.com",
      "server_port": 8388
    }
  ]
}
```

### Outbound

```json
{
  "type": "shadowsocks",
  "tag": "ss-out",
  "server": "example.com",
  "server_port": 8388,
  "method": "2022-blake3-aes-256-gcm",
  "password": "base64-key",
  "udp_over_tcp": {
    "enabled": true,
    "version": 2
  },
  "multiplex": {
    "enabled": true,
    "protocol": "h2mux"
  }
}
```
