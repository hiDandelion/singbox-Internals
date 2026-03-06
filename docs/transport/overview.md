# Transport Layer Overview

Source: `transport/v2ray/`, `common/tls/`, `common/mux/`, `common/uot/`, `common/tlsfragment/`

## Architecture

sing-box's transport layer sits between the proxy protocol layer and the raw network, providing pluggable stream transports (WebSocket, gRPC, HTTP, QUIC, HTTP Upgrade), TLS variants (stdlib, uTLS, Reality, ECH, kTLS), connection multiplexing (sing-mux), UDP-over-TCP tunneling, and TLS fingerprint fragmentation.

### Component Map

```
Proxy Protocol (VMess, Trojan, etc.)
    |
    v
+--------------------+
| V2Ray Transport    |  <-- WebSocket, gRPC, HTTP, QUIC, HTTPUpgrade
+--------------------+
    |
    v
+--------------------+
| TLS Layer          |  <-- STD, uTLS, Reality, ECH, kTLS
+--------------------+
    |
    v
+--------------------+
| Multiplexing       |  <-- sing-mux, UoT
+--------------------+
    |
    v
+--------------------+
| TLS Fragment       |  <-- ClientHello splitting
+--------------------+
    |
    v
  Raw TCP/UDP
```

### Key Interfaces

The transport layer is organized around two adapter interfaces:

```go
// Server-side transport
type V2RayServerTransport interface {
    Network() []string
    Serve(listener net.Listener) error
    ServePacket(listener net.PacketConn) error
    Close() error
}

// Client-side transport
type V2RayClientTransport interface {
    DialContext(ctx context.Context) (net.Conn, error)
    Close() error
}
```

Every transport implementation (WebSocket, gRPC, HTTP, QUIC, HTTP Upgrade) provides both a server and client type that satisfy these interfaces.

### Transport Selection

Transport type is selected by a string constant in the configuration:

```json
{
  "transport": {
    "type": "ws",          // "http", "grpc", "quic", "httpupgrade"
    "path": "/path",
    "headers": {}
  }
}
```

The `v2ray/transport.go` factory dispatches based on this type string via a type-switch in `NewServerTransport` and `NewClientTransport`.

### Build Tag Dependencies

Not all transports are always available:

| Transport | Build Tag Required | Notes |
|-----------|-------------------|-------|
| WebSocket | none | Always available |
| HTTP | none | Always available |
| HTTP Upgrade | none | Always available |
| gRPC (full) | `with_grpc` | Uses `google.golang.org/grpc` |
| gRPC (lite) | none | Raw HTTP/2, always available as fallback |
| QUIC | `with_quic` | Uses `github.com/sagernet/quic-go` |
| uTLS | `with_utls` | Required for Reality |
| ACME | `with_acme` | Uses certmagic |
| kTLS | Linux + go1.25 + `badlinkname` | Kernel TLS offload |
| ECH | go1.24+ | Go stdlib ECH support |

### Connection Flow

**Client-side** (outbound):

1. Protocol layer calls `transport.DialContext(ctx)` to get a `net.Conn`
2. Transport dials the underlying TCP/UDP connection via the provided `N.Dialer`
3. TLS handshake is performed if configured (wrapped via `tls.NewDialer`)
4. Transport-specific framing is applied (WebSocket upgrade, HTTP/2 stream, etc.)
5. The resulting connection is returned for protocol-layer use

**Server-side** (inbound):

1. Inbound listener accepts raw connections
2. `transport.Serve(listener)` starts the transport server (HTTP server, gRPC server, etc.)
3. Transport validates incoming requests (path, headers, upgrade protocol)
4. On success, it calls `handler.NewConnectionEx()` with the unwrapped connection
5. The handler routes the connection to the proxy protocol decoder

### Thread Safety Patterns

Several recurring patterns appear across the transport layer:

- **Atomic pointer + mutex for connection caching**: Used in gRPC client, QUIC client, and WebSocket early data. Fast-path reads an atomic pointer; slow-path acquires a mutex for connection establishment.
- **Lazy connection with channel signaling**: `EarlyWebsocketConn`, `GunConn` (lite), and `HTTP2Conn` defer connection setup until first write, using a channel to signal completion to concurrent readers.
- **`HTTP2ConnWrapper` for thread-safe writes**: HTTP/2 streams require synchronized writes; the wrapper uses a mutex plus a `closed` flag to prevent writes after close.
- **`DupContext` for context detachment**: HTTP handler contexts are tied to request lifetime; `DupContext` extracts the log ID and creates a new background context for long-lived connections.

### Error Handling

Transport errors are normalized through several wrappers:

- `wrapWsError`: Converts WebSocket close frames (normal closure, no status) to `io.EOF`
- `baderror.WrapGRPC`: Normalizes gRPC stream errors
- `baderror.WrapH2`: Normalizes HTTP/2 stream errors
- `qtls.WrapError`: Normalizes QUIC errors

All transport connections return `os.ErrInvalid` for deadline-related operations (`SetDeadline`, `SetReadDeadline`, `SetWriteDeadline`) and set `NeedAdditionalReadDeadline() bool` to `true`, signaling the caller to manage read timeouts externally.
