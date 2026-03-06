# Protocol Overview

sing-box supports 20+ proxy protocols, all following a consistent adapter pattern. Protocol implementations are thin wrappers that delegate to `sing-*` libraries for the actual wire format handling.

**Source**: `protocol/`, `include/`

## Registration Pattern

Every protocol registers itself via the include system:

```go
// include/inbound.go
func InboundRegistry() *inbound.Registry {
    registry := inbound.NewRegistry()
    tun.RegisterInbound(registry)
    vless.RegisterInbound(registry)
    vmess.RegisterInbound(registry)
    trojan.RegisterInbound(registry)
    // ...
    return registry
}
```

Each protocol provides a registration function:

```go
// protocol/vless/inbound.go
func RegisterInbound(registry adapter.InboundRegistry) {
    inbound.Register[option.VLESSInboundOptions](registry, C.TypeVLESS, NewInbound)
}
```

The generic `Register` function maps: `(type string, options type) → factory function`.

## Inbound Pattern

All inbounds follow this structure:

```go
type Inbound struct {
    myInboundAdapter  // embedded adapter with Tag(), Type()
    ctx      context.Context
    router   adapter.ConnectionRouterEx
    logger   log.ContextLogger
    listener *listener.Listener    // TCP listener
    service  *someprotocol.Service // protocol service
}

func NewInbound(ctx, router, logger, tag string, options) (adapter.Inbound, error) {
    // 1. Create protocol service (from sing-* library)
    // 2. Create listener
    // 3. Wire service → router for connection handling
}

func (h *Inbound) Start(stage adapter.StartStage) error {
    // Start listener
}

func (h *Inbound) Close() error {
    // Close listener + service
}

// Called by listener for each new connection
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    // Protocol-specific decoding happens here
    // Then: h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## Outbound Pattern

All outbounds implement `N.Dialer`:

```go
type Outbound struct {
    myOutboundAdapter  // embedded adapter with Tag(), Type(), Network()
    ctx       context.Context
    dialer    N.Dialer           // underlying dialer (may be detour)
    transport *v2ray.Transport   // optional V2Ray transport
    // protocol-specific options
}

func NewOutbound(ctx, router, logger, tag string, options) (adapter.Outbound, error) {
    // 1. Create underlying dialer (default or detour)
    // 2. Create V2Ray transport if configured
    // 3. Configure protocol options
}

func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    // 1. Dial transport connection
    // 2. Perform protocol handshake
    // 3. Return wrapped connection
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    // For UDP-capable protocols
}
```

## Protocol Categories

### Proxy Protocols (Client/Server)
| Protocol | Inbound | Outbound | Library |
|----------|---------|----------|---------|
| VLESS | Yes | Yes | `sing-vmess` |
| VMess | Yes | Yes | `sing-vmess` |
| Trojan | Yes | Yes | `transport/trojan` (built-in) |
| Shadowsocks | Yes | Yes | `sing-shadowsocks` / `sing-shadowsocks2` |
| ShadowTLS | Yes | Yes | `sing-shadowtls` |
| Hysteria2 | Yes | Yes | `sing-quic` |
| TUIC | Yes | Yes | `sing-quic` |
| AnyTLS | Yes | Yes | `sing-anytls` |
| NaiveProxy | Yes | Yes | Built-in |
| WireGuard | Endpoint | Endpoint | `wireguard-go` |
| Tailscale | Endpoint | Endpoint | `tailscale` |

### Local Proxy Protocols
| Protocol | Inbound | Outbound |
|----------|---------|----------|
| SOCKS4/5 | Yes | Yes |
| HTTP | Yes | Yes |
| Mixed (SOCKS+HTTP) | Yes | - |
| Redirect | Yes | - |
| TProxy | Yes | - |
| TUN | Yes | - |

### Utility Protocols
| Protocol | Purpose |
|----------|---------|
| Direct | Direct outbound connection |
| Block | Drop all connections |
| DNS | Forward to DNS router |
| Selector | Manual outbound selection |
| URLTest | Auto-select based on latency |
| SSH | SSH tunnel |
| Tor | Tor network |

## V2Ray Transport Integration

Many protocols support V2Ray-compatible transports:

```go
// Create transport from options
transport, err := v2ray.NewServerTransport(ctx, logger, common.PtrValueOrDefault(options.Transport), tlsConfig, handler)

// Or for client side
transport, err := v2ray.NewClientTransport(ctx, dialer, serverAddr, common.PtrValueOrDefault(options.Transport), tlsConfig)
```

Supported transports: WebSocket, gRPC, HTTP/2, HTTPUpgrade, QUIC.

## Multiplex Integration

Outbounds can wrap with multiplex:

```go
if options.Multiplex != nil && options.Multiplex.Enabled {
    outbound.multiplexDialer, err = mux.NewClientWithOptions(ctx, outbound, muxOptions)
}
```

## Handler Chain

```
Inbound Listener → Protocol Decode → Router → Rule Match → Outbound Select
    ↓                                                          ↓
TCP/UDP accept                                          Protocol Encode
    ↓                                                          ↓
Protocol Service                                        Transport Dial
    ↓                                                          ↓
Extract destination                                     Remote Connection
    ↓                                                          ↓
Route to outbound ─────────────────────────────→ ConnectionManager.Copy
```

## Key Differences from Xray-core

| Aspect | Xray-core | sing-box |
|--------|----------|----------|
| Wire format | Built-in encoding | `sing-*` library |
| Inbound model | `proxy.Inbound.Process()` returns Link | `adapter.Inbound` → router callback |
| Outbound model | `proxy.Outbound.Process()` with Link | `N.Dialer` interface (DialContext/ListenPacket) |
| Data flow | Pipe Reader/Writer | Direct net.Conn/PacketConn |
| Mux | Built-in mux + XUDP | `sing-mux` library |
| Vision/XTLS | Built-in in proxy.go | Not supported (different approach) |
