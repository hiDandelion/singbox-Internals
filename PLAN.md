# sing-box Internals — Analysis Plan

## Purpose
Complete technical analysis of sing-box to enable reimplementation in another framework. Covers every code path, wire format, and architectural decision.

## Codebase Overview
- **Language**: Go 1.24
- **Module**: `github.com/sagernet/sing-box`
- **Architecture**: Context-based service registry + registry pattern for extensible protocols/transports
- **Key dependency**: `github.com/sagernet/sing` — the core networking library providing N.Dialer, buf.Buffer, M.Socksaddr, etc.

## Analysis Sections

### 1. Architecture (10 pages)
- **Overview**: Project structure, dependency graph, design philosophy (sing library vs sing-box)
- **Box Lifecycle**: Multi-phase startup (Initialize → Start → PostStart → Started), graceful shutdown
- **Adapter Interfaces**: Inbound, Outbound, Endpoint, Router, ConnectionManager, NetworkManager, DNSRouter
- **Service Registry**: Context-based DI via `service.ContextWith[T]` / `service.FromContext[T]`
- **Router & Rules**: Rule matching loop, actions (route/reject/sniff/resolve/hijack-dns/bypass), rule sets
- **Connection Manager**: TCP/UDP connection lifecycle, bidirectional copy, handshake kick
- **Network Manager**: Interface monitoring, auto-detect, WIFI state, platform abstraction
- **Dialer System**: Default dialer, detour dialer, resolve dialer, parallel interface/network, TFO
- **Listener System**: TCP/UDP listener with shared options
- **Sniffing**: Stream + packet sniffers, protocol detection (TLS, HTTP, QUIC, DNS, BitTorrent, SSH, RDP, STUN, DTLS, NTP)

### 2. Proxy Protocols (17 pages)
- **Overview**: Registry pattern, inbound/outbound adapter pattern
- **VLESS**: sing-vmess integration, inbound/outbound flow
- **VMess**: sing-vmess AEAD, inbound/outbound
- **Trojan**: Wire format, transport/trojan service layer, mux support
- **Shadowsocks**: Single/multi-user/relay, sing-shadowsocks/sing-shadowsocks2
- **ShadowTLS**: sing-shadowtls integration
- **Hysteria2**: QUIC-based, sing-quic integration
- **TUIC**: QUIC-based, sing-quic
- **AnyTLS**: sing-anytls
- **NaiveProxy**: HTTP/2 CONNECT, HTTP/3, padding
- **WireGuard**: Endpoint pattern, system/gVisor stack, NAT
- **SOCKS/HTTP/Mixed**: Standard proxy protocols
- **Direct/Block/DNS**: Utility outbounds
- **Redirect/TProxy**: Transparent proxy (Linux)
- **TUN**: sing-tun integration, stack options (gVisor, system, mixed)
- **Outbound Groups**: Selector, URLTest with health checking
- **SSH/Tor/Tailscale**: Special endpoint/outbound types

### 3. Transport Layer (11 pages)
- **Overview**: V2Ray transport abstraction, client/server interfaces
- **V2Ray Transports**: Registry and shared patterns
- **WebSocket**: coder/websocket, gobwas/ws
- **gRPC**: Full gRPC and lite gRPC
- **HTTP / HTTPUpgrade**: HTTP/2 transport, HTTP/1.1 Upgrade
- **QUIC**: QUIC-based transport
- **TLS/uTLS/REALITY**: Standard TLS, fingerprinting, REALITY
- **kTLS**: Kernel TLS (Linux)
- **Multiplex (smux)**: sagernet/smux, sing-mux
- **UDP over TCP**: UoT protocol
- **TLS Fragmentation**: ClientHello fragmentation

### 4. DNS System (6 pages)
- **Overview**: Architecture, query flow
- **Client & Router**: DNS client caching, DNS router rule matching
- **Transport Types**: UDP, TCP, TLS, HTTPS, QUIC, local, DHCP
- **FakeIP**: IP pool allocation, store interface, cache persistence
- **Hosts & Local**: Hosts file, platform-specific local resolver
- **Caching & EDNS0**: Response caching, EDNS0 client subnet

### 5. Advanced Features (7 pages)
- **Rule Sets (SRS)**: Binary format, local/remote, reference counting
- **GeoIP / GeoSite**: MaxMind DB, rule format
- **Process Matching**: Platform-specific process searcher
- **Clash API**: RESTful API, connection tracking, mode switching
- **V2Ray API**: gRPC stats service
- **Cache File**: bbolt-based persistence, FakeIP, selected outbound
- **Platform / libbox**: Mobile bindings, PlatformInterface

### 6. Configuration (3 pages)
- **Config Structure**: Root Options, typed inbound/outbound/endpoint/service/dns
- **Option Types**: Listable, DNSAddress, duration, network strategy
- **Build Tags**: include/ system, conditional compilation

### 7. Implementation (2 pages)
- **Checklist**: Phase-by-phase implementation order
- **Compatibility Notes**: Wire format specifics for interop

## Key Differences from Xray-core

| Aspect | Xray-core | sing-box |
|--------|----------|----------|
| Architecture | Feature registry + Instance | Context-based service registry + Box |
| Data path | Pipe-based (Reader/Writer) | Direct connection (net.Conn/N.PacketConn) |
| Buffer | Custom pooled 8KB | sing/common/buf (also pooled) |
| Routing | Sequential rules → outbound tag | Sequential rules → actions (route/sniff/resolve/reject/hijack-dns/bypass) |
| Protocol impl | Built-in | Delegated to sing-* libraries |
| Mux | Built-in mux + XUDP | sing-mux library |
| TUN | Built-in gVisor stack | sing-tun library |
| Config | Protobuf-based internally | JSON with typed options |
| Lifecycle | Simple Start/Close | 4-phase startup (Initialize/Start/PostStart/Started) |
| DNS | Integrated in dispatcher | Separate DNSRouter + DNSTransportManager |
