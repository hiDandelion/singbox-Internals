# Architecture Overview

sing-box is a universal proxy platform built on top of the `sing` networking library. Unlike Xray-core's monolithic design, sing-box delegates protocol implementations to external `sing-*` libraries and uses Go's context system for dependency injection.

**Source**: `box.go`, `adapter/`, `route/`, `common/`, `protocol/`

## Project Structure

```
sing-box/
├── box.go                    # Box struct, lifecycle (New/PreStart/Start/Close)
├── adapter/                  # Core interfaces (Inbound, Outbound, Router, etc.)
│   ├── inbound/              # Inbound manager & registry
│   ├── outbound/             # Outbound manager & registry
│   ├── endpoint/             # Endpoint manager & registry (WireGuard, Tailscale)
│   └── service/              # Service manager & registry
├── route/                    # Router, connection manager, network manager
│   └── rule/                 # Rule matching and actions
├── dns/                      # DNS client, router, transport manager
│   └── transport/            # DNS transport implementations
├── protocol/                 # All proxy protocol implementations
│   ├── vless/                # VLESS inbound/outbound
│   ├── vmess/                # VMess inbound/outbound
│   ├── trojan/               # Trojan inbound/outbound
│   ├── shadowsocks/          # Shadowsocks (single/multi/relay)
│   ├── hysteria2/            # Hysteria2
│   ├── tuic/                 # TUIC
│   ├── tun/                  # TUN inbound
│   ├── group/                # Selector, URLTest
│   └── ...                   # direct, block, dns, socks, http, etc.
├── transport/                # V2Ray-compatible transports
│   ├── v2raywebsocket/       # WebSocket
│   ├── v2raygrpc/            # gRPC (full)
│   ├── v2raygrpclite/        # gRPC (lite, no dep)
│   ├── v2rayhttp/            # HTTP/2
│   ├── v2rayhttpupgrade/     # HTTP Upgrade
│   ├── v2rayquic/            # QUIC
│   └── wireguard/            # WireGuard device/stack
├── common/                   # Shared utilities
│   ├── dialer/               # Dialer system (default, detour, resolve, TFO)
│   ├── listener/             # TCP/UDP listeners
│   ├── sniff/                # Protocol sniffers
│   ├── tls/                  # TLS, uTLS, REALITY, ECH, kTLS, ACME
│   ├── mux/                  # Multiplex client/router
│   └── ...                   # redir, process, geoip, geosite, etc.
├── option/                   # Configuration types
├── include/                  # Build tag inclusion
├── experimental/             # Clash API, V2Ray API, cache file, libbox
├── log/                      # Logging system
├── constant/                 # Constants and enums
└── service/                  # External service implementations (CCM, OCM, DERP, etc.)
```

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `sagernet/sing` | Core networking library: N.Dialer, buf.Buffer, M.Socksaddr, bufio |
| `sagernet/sing-vmess` | VLESS + VMess protocol implementation |
| `sagernet/sing-shadowsocks` | Shadowsocks AEAD |
| `sagernet/sing-shadowsocks2` | Shadowsocks 2022 |
| `sagernet/sing-shadowtls` | ShadowTLS protocol |
| `sagernet/sing-mux` | Multiplex (smux-based) |
| `sagernet/sing-quic` | QUIC-based protocols (Hysteria2, TUIC) |
| `sagernet/sing-tun` | TUN device + IP stack |
| `sagernet/gvisor` | Userspace TCP/IP stack |
| `sagernet/quic-go` | QUIC implementation |
| `metacubex/utls` | uTLS fingerprinting |
| `sagernet/wireguard-go` | WireGuard implementation |
| `sagernet/tailscale` | Tailscale integration |
| `miekg/dns` | DNS message parsing |
| `anytls/sing-anytls` | AnyTLS protocol |

## High-Level Data Flow

```
┌─────────────────────────────────────────────────────────┐
│                        Box                               │
│                                                          │
│  ┌──────────┐    ┌──────────┐    ┌───────────────┐      │
│  │ Inbound  │───→│  Router  │───→│   Outbound    │      │
│  │ Manager  │    │          │    │   Manager     │      │
│  └──────────┘    │ matchRule│    └───────────────┘      │
│       │          │  sniff   │          │                 │
│       │          │  resolve │          │                 │
│       ▼          └──────────┘          ▼                 │
│  ┌──────────┐         │          ┌───────────────┐      │
│  │ Protocol │    ┌────┴────┐     │   Protocol    │      │
│  │ Inbound  │    │  DNS    │     │   Outbound    │      │
│  │(decode)  │    │ Router  │     │   (encode)    │      │
│  └──────────┘    └─────────┘     └───────────────┘      │
│                       │                │                 │
│                  ┌────┴────┐     ┌─────┴──────┐         │
│                  │  DNS    │     │ Connection │         │
│                  │Transport│     │  Manager   │         │
│                  │ Manager │     │ (copy loop)│         │
│                  └─────────┘     └────────────┘         │
└─────────────────────────────────────────────────────────┘
```

### Connection Flow

1. **Inbound** accepts connection (TCP) or packet (UDP)
2. Inbound decodes protocol header, extracts destination
3. Inbound calls `router.RouteConnectionEx(ctx, conn, metadata, onClose)` or `RoutePacketConnectionEx`
4. **Router** enriches metadata: process info, neighbor info, FakeIP lookup, reverse DNS
5. **Router** iterates rules in order, executing actions:
   - `sniff` — peek at data to detect protocol/domain
   - `resolve` — DNS resolve domain to IPs
   - `route` — select outbound (terminal action)
   - `reject` — drop connection (terminal action)
   - `hijack-dns` — handle as DNS query (terminal action)
   - `bypass` — bypass routing (terminal action)
6. **Router** selects outbound based on matched rule (or default)
7. **Connection trackers** wrap the connection (stats, Clash API)
8. If outbound implements `ConnectionHandlerEx`, it handles directly
9. Otherwise, **ConnectionManager** dials remote and runs bidirectional copy

## Design Principles

1. **Library delegation**: Protocol implementations live in `sing-*` libraries. sing-box is the orchestration layer.

2. **Context-based DI**: All services are registered in context via `service.ContextWith[T]()` and retrieved via `service.FromContext[T]()`. No global singletons.

3. **Direct connections**: Unlike Xray-core's Pipe-based Reader/Writer model, sing-box passes `net.Conn` and `N.PacketConn` directly through the pipeline. This enables zero-copy operations and splice/sendfile.

4. **Action-based routing**: Rules produce actions, not just outbound tags. This allows sniffing and DNS resolution to be part of the rule chain.

5. **4-phase lifecycle**: Components start in phases (Initialize → Start → PostStart → Started) to handle complex dependency ordering without explicit dependency graphs.

6. **Extensible registries**: Inbound, outbound, endpoint, DNS transport, and service types are all registered via type registries, making it easy to add new protocol types.
