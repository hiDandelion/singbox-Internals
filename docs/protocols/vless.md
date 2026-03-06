# VLESS Protocol

VLESS is a lightweight proxy protocol using UUID-based authentication. sing-box delegates the VLESS wire format to `sing-vmess/vless` library.

**Source**: `protocol/vless/`, `sing-vmess/vless/`

## Inbound Architecture

```go
type Inbound struct {
    inbound.Adapter
    ctx       context.Context
    router    adapter.ConnectionRouterEx
    logger    logger.ContextLogger
    listener  *listener.Listener
    users     []option.VLESSUser
    service   *vless.Service[int]     // sing-vmess VLESS service
    tlsConfig tls.ServerConfig
    transport adapter.V2RayServerTransport
}
```

### Construction

```go
func NewInbound(ctx, router, logger, tag, options) (adapter.Inbound, error) {
    // 1. Create UoT router wrapper (UDP-over-TCP handling)
    inbound.router = uot.NewRouter(router, logger)

    // 2. Create mux router wrapper (multiplex handling)
    inbound.router = mux.NewRouterWithOptions(inbound.router, logger, options.Multiplex)

    // 3. Create VLESS service with user list
    service := vless.NewService[int](logger, adapter.NewUpstreamContextHandlerEx(
        inbound.newConnectionEx,        // TCP handler
        inbound.newPacketConnectionEx,   // UDP handler
    ))
    service.UpdateUsers(indices, uuids, flows)

    // 4. TLS configuration (optional)
    inbound.tlsConfig = tls.NewServerWithOptions(...)
    // kTLS compatible only when: no transport, no mux, no flow (Vision)

    // 5. V2Ray transport (optional: WS, gRPC, HTTP, etc.)
    inbound.transport = v2ray.NewServerTransport(ctx, ..., inbound.tlsConfig, handler)

    // 6. TCP listener
    inbound.listener = listener.New(...)
}
```

### Connection Flow

```
TCP Connection → [TLS Handshake] → VLESS Service.NewConnection()
                                          ↓
                                   Decode VLESS header
                                   Authenticate UUID
                                   Extract destination
                                          ↓
                                   newConnectionEx() / newPacketConnectionEx()
                                          ↓
                                   Set metadata (Inbound, User)
                                          ↓
                                   router.RouteConnectionEx()
```

When a V2Ray transport is configured:
```
TCP Connection → Transport.Serve() → Transport Handler → [TLS already handled] → VLESS Service
```

### kTLS Compatibility

kTLS (kernel TLS) is enabled when:
- No V2Ray transport (raw TCP + TLS)
- No multiplex
- No Vision flow (all users have empty flow)

This allows the kernel to handle TLS encryption for better performance.

## Outbound Architecture

```go
type Outbound struct {
    outbound.Adapter
    logger          logger.ContextLogger
    dialer          N.Dialer
    client          *vless.Client        // sing-vmess VLESS client
    serverAddr      M.Socksaddr
    multiplexDialer *mux.Client
    tlsConfig       tls.Config
    tlsDialer       tls.Dialer
    transport       adapter.V2RayClientTransport
    packetAddr      bool     // use packetaddr encoding
    xudp            bool     // use XUDP encoding (default)
}
```

### Dial Flow

```go
func (h *vlessDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    // 1. Establish transport connection
    if h.transport != nil {
        conn = h.transport.DialContext(ctx)
    } else if h.tlsDialer != nil {
        conn = h.tlsDialer.DialTLSContext(ctx, h.serverAddr)
    } else {
        conn = h.dialer.DialContext(ctx, "tcp", h.serverAddr)
    }

    // 2. Protocol handshake
    switch network {
    case "tcp":
        return h.client.DialEarlyConn(conn, destination)
    case "udp":
        if h.xudp {
            return h.client.DialEarlyXUDPPacketConn(conn, destination)
        } else if h.packetAddr {
            packetConn = h.client.DialEarlyPacketConn(conn, packetaddr.SeqPacketMagicAddress)
            return packetaddr.NewConn(packetConn, destination)
        } else {
            return h.client.DialEarlyPacketConn(conn, destination)
        }
    }
}
```

### Early Data

`DialEarlyConn` defers the VLESS handshake until the first write. The VLESS header is sent together with the first data packet, reducing round trips.

### Multiplex

When multiplex is enabled:

```go
outbound.multiplexDialer = mux.NewClientWithOptions((*vlessDialer)(outbound), logger, options.Multiplex)
```

The mux client wraps the VLESS dialer. Multiple logical connections share a single VLESS connection.

## UDP Packet Encoding

VLESS supports three UDP encoding modes:

### XUDP (default)

Per-packet addressing — each UDP packet carries its own destination address. Enables Full-Cone NAT.

```go
h.client.DialEarlyXUDPPacketConn(conn, destination)
```

### PacketAddr

Similar to XUDP but uses a different wire format (`packetaddr.SeqPacketMagicAddress`).

### Legacy

Simple VLESS packet encoding — all packets go to the same destination.

```go
h.client.DialEarlyPacketConn(conn, destination)
```

## Configuration

```json
{
  "inbounds": [{
    "type": "vless",
    "listen": ":443",
    "users": [
      { "uuid": "...", "name": "user1", "flow": "" }
    ],
    "tls": { ... },
    "transport": { "type": "ws", "path": "/vless" },
    "multiplex": { "enabled": true }
  }],
  "outbounds": [{
    "type": "vless",
    "server": "example.com",
    "server_port": 443,
    "uuid": "...",
    "flow": "",
    "packet_encoding": "xudp",
    "tls": { ... },
    "transport": { "type": "ws", "path": "/vless" },
    "multiplex": { "enabled": true }
  }]
}
```

## Key Differences from Xray-core VLESS

| Aspect | Xray-core | sing-box |
|--------|----------|----------|
| Vision/XTLS | Full support (unsafe.Pointer) | Not supported |
| Wire format | Built-in encoding | `sing-vmess/vless` library |
| Fallback | Built-in (name→ALPN→path) | Not supported (use separate listener) |
| XUDP | Built-in with GlobalID | `sing-vmess` XUDP |
| Mux | Built-in mux frames | `sing-mux` (smux-based) |
| Data flow | Pipe Reader/Writer | net.Conn passthrough |
| Pre-connect | Connection pool | Not built-in |

## Wire Format (from sing-vmess)

### Request Header
```
[1B Version=0x00]
[16B UUID]
[1B Addons length (N)]
[NB Addons protobuf]
[1B Command: 0x01=TCP, 0x02=UDP, 0x03=Mux]
[Address: Port(2B) + Type(1B) + Addr(var)]
```

### Response Header
```
[1B Version=0x00]
[1B Addons length]
[NB Addons]
```

The wire format is compatible with Xray-core VLESS.
