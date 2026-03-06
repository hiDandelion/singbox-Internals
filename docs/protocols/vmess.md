# VMess Protocol

VMess is the V2Ray-native proxy protocol featuring UUID-based authentication with AEAD encryption. sing-box delegates the VMess wire format entirely to the `sing-vmess` library.

**Source**: `protocol/vmess/inbound.go`, `protocol/vmess/outbound.go`, `sing-vmess`

## sing-vmess Integration

sing-box does not implement the VMess wire format itself. Instead, it uses the `github.com/sagernet/sing-vmess` library which provides:

- `vmess.Service[int]` -- server-side VMess protocol handler, generic over user key type
- `vmess.Client` -- client-side VMess protocol handler
- `vmess.ServiceOption` / `vmess.ClientOption` -- functional options for configuration
- `packetaddr` -- packet address encoding for UDP-over-TCP

This is a major difference from **Xray-core**, which implements VMess directly in its codebase. sing-box's approach provides a cleaner separation of concerns.

## Inbound Architecture

```go
type Inbound struct {
    inbound.Adapter
    ctx       context.Context
    router    adapter.ConnectionRouterEx
    logger    logger.ContextLogger
    listener  *listener.Listener
    service   *vmess.Service[int]       // sing-vmess service, keyed by user index
    users     []option.VMessUser
    tlsConfig tls.ServerConfig
    transport adapter.V2RayServerTransport
}
```

### Construction Flow

```go
func NewInbound(ctx, router, logger, tag, options) (adapter.Inbound, error) {
    // 1. Wrap router with UoT (UDP-over-TCP) support
    inbound.router = uot.NewRouter(router, logger)

    // 2. Wrap router with mux (multiplex) support
    inbound.router = mux.NewRouterWithOptions(inbound.router, logger, options.Multiplex)

    // 3. Configure VMess service options
    //    - NTP time function (VMess is time-sensitive)
    //    - Disable header protection when V2Ray transport is used
    serviceOptions = append(serviceOptions, vmess.ServiceWithTimeFunc(timeFunc))
    if options.Transport != nil {
        serviceOptions = append(serviceOptions, vmess.ServiceWithDisableHeaderProtection())
    }

    // 4. Create service and register users (index -> UUID + alterId)
    service := vmess.NewService[int](handler, serviceOptions...)
    service.UpdateUsers(indices, uuids, alterIds)

    // 5. Optional TLS
    // 6. Optional V2Ray transport (WebSocket, gRPC, HTTP, QUIC)
    // 7. TCP listener
}
```

### Key Design: Disable Header Protection with Transport

When a V2Ray transport (WebSocket, gRPC, etc.) is configured, `vmess.ServiceWithDisableHeaderProtection()` is passed. This is because the transport layer already provides its own framing, making VMess's header protection redundant and potentially problematic.

### Connection Handling

```go
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    // 1. TLS handshake (only if TLS configured AND no transport)
    //    When transport is used, TLS is handled by the transport layer
    if h.tlsConfig != nil && h.transport == nil {
        conn = tls.ServerHandshake(ctx, conn, h.tlsConfig)
    }

    // 2. Delegate to sing-vmess service
    //    VMess decryption, authentication, command parsing all happen here
    h.service.NewConnection(ctx, conn, metadata.Source, onClose)
}
```

After the service decodes the VMess request, it calls back into the inbound's handlers:

```go
func (h *Inbound) newConnectionEx(ctx, conn, metadata, onClose) {
    // Extract user index from context (set by sing-vmess)
    userIndex, _ := auth.UserFromContext[int](ctx)
    user := h.users[userIndex].Name
    metadata.User = user
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### Packet Address (packetaddr) Handling

For UDP packet connections, VMess uses a magic FQDN address `packetaddr.SeqPacketMagicAddress` to signal that the connection carries multiplexed UDP packets:

```go
func (h *Inbound) newPacketConnectionEx(ctx, conn, metadata, onClose) {
    if metadata.Destination.Fqdn == packetaddr.SeqPacketMagicAddress {
        metadata.Destination = M.Socksaddr{}
        conn = packetaddr.NewConn(bufio.NewNetPacketConn(conn), metadata.Destination)
    }
    h.router.RoutePacketConnectionEx(ctx, conn, metadata, onClose)
}
```

## Outbound Architecture

```go
type Outbound struct {
    outbound.Adapter
    logger          logger.ContextLogger
    dialer          N.Dialer
    client          *vmess.Client        // sing-vmess client
    serverAddr      M.Socksaddr
    multiplexDialer *mux.Client
    tlsConfig       tls.Config
    tlsDialer       tls.Dialer
    transport       adapter.V2RayClientTransport
    packetAddr      bool                 // packetaddr encoding
    xudp            bool                 // XUDP encoding
}
```

### Packet Encoding Modes

VMess outbound supports three packet encoding modes for UDP:

| Mode | Field | Description |
|------|-------|-------------|
| (none) | default | Standard VMess UDP |
| `packetaddr` | `packetAddr=true` | Uses packetaddr magic FQDN for multiplexed UDP |
| `xudp` | `xudp=true` | XUDP protocol for UDP multiplexing |

```go
switch options.PacketEncoding {
case "packetaddr":
    outbound.packetAddr = true
case "xudp":
    outbound.xudp = true
}
```

### Security Auto-Selection

```go
security := options.Security
if security == "" {
    security = "auto"
}
if security == "auto" && outbound.tlsConfig != nil {
    security = "zero"  // Use zero encryption when TLS is present
}
```

When TLS is already configured, VMess automatically uses "zero" security to avoid double encryption -- a performance optimization.

### Client Options

```go
var clientOptions []vmess.ClientOption
if options.GlobalPadding {
    clientOptions = append(clientOptions, vmess.ClientWithGlobalPadding())
}
if options.AuthenticatedLength {
    clientOptions = append(clientOptions, vmess.ClientWithAuthenticatedLength())
}
client, _ := vmess.NewClient(options.UUID, security, options.AlterId, clientOptions...)
```

- **GlobalPadding**: Adds random padding to all packets for traffic analysis resistance
- **AuthenticatedLength**: Includes authenticated payload length in the header (AEAD mode)

### Connection Establishment

The `vmessDialer` type handles the actual connection:

```go
func (h *vmessDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    // 1. Establish underlying connection
    //    Priority: transport > TLS > raw TCP
    if h.transport != nil {
        conn = h.transport.DialContext(ctx)
    } else if h.tlsDialer != nil {
        conn = h.tlsDialer.DialTLSContext(ctx, h.serverAddr)
    } else {
        conn = h.dialer.DialContext(ctx, "tcp", h.serverAddr)
    }

    // 2. Wrap with VMess protocol (early data / 0-RTT)
    switch network {
    case "tcp":
        return h.client.DialEarlyConn(conn, destination)
    case "udp":
        return h.client.DialEarlyPacketConn(conn, destination)
    }
}
```

For `ListenPacket`, the encoding mode determines the wrapper:

```go
func (h *vmessDialer) ListenPacket(ctx, destination) (net.PacketConn, error) {
    conn := /* establish connection */
    if h.packetAddr {
        return packetaddr.NewConn(
            h.client.DialEarlyPacketConn(conn, M.Socksaddr{Fqdn: packetaddr.SeqPacketMagicAddress}),
            destination,
        )
    } else if h.xudp {
        return h.client.DialEarlyXUDPPacketConn(conn, destination)
    } else {
        return h.client.DialEarlyPacketConn(conn, destination)
    }
}
```

## Mux Support

Multiplexing is supported via the `common/mux` package. On the inbound side, the router is wrapped with `mux.NewRouterWithOptions()`. On the outbound side, a `mux.Client` wraps the VMess dialer:

```go
outbound.multiplexDialer, _ = mux.NewClientWithOptions((*vmessDialer)(outbound), logger, options.Multiplex)
```

When mux is active, `DialContext` and `ListenPacket` delegate to the mux client instead of creating individual VMess connections.

## Differences from Xray-core

| Aspect | sing-box | Xray-core |
|--------|----------|-----------|
| Implementation | Delegates to `sing-vmess` library | Built-in implementation |
| AlterId | Supported but AEAD preferred | Full legacy support |
| XUDP | Supported via `sing-vmess` | Native implementation |
| Header Protection | Disabled when transport present | Always active |
| Security Auto | "zero" when TLS present | "auto" based on AlterId |
| Time Sync | NTP context integration | System time only |

## Configuration Example

```json
{
  "type": "vmess",
  "tag": "vmess-in",
  "listen": "::",
  "listen_port": 10086,
  "users": [
    {
      "name": "user1",
      "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
      "alterId": 0
    }
  ],
  "tls": {
    "enabled": true,
    "server_name": "example.com",
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  },
  "transport": {
    "type": "ws",
    "path": "/vmess"
  },
  "multiplex": {
    "enabled": true
  }
}
```

```json
{
  "type": "vmess",
  "tag": "vmess-out",
  "server": "example.com",
  "server_port": 10086,
  "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
  "security": "auto",
  "alter_id": 0,
  "global_padding": true,
  "authenticated_length": true,
  "packet_encoding": "xudp",
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  },
  "transport": {
    "type": "ws",
    "path": "/vmess"
  }
}
```
