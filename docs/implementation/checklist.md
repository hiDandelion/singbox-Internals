# Implementation Checklist

A comprehensive checklist for reimplementing sing-box, organized by phase. Each phase builds on the previous ones.

## Phase 1: Foundation

### Configuration System
- [ ] JSON parser with context-aware type registry
- [ ] Root `Options` struct with all top-level fields
- [ ] `Listable[T]` type (accepts single value or array)
- [ ] `Duration` type (Go duration string parsing)
- [ ] `NetworkList` type (single string or array of "tcp"/"udp")
- [ ] `DomainStrategy` enum (as_is, prefer_ipv4, prefer_ipv6, ipv4_only, ipv6_only)
- [ ] `NetworkStrategy` enum
- [ ] `InterfaceType` enum (wifi, cellular, ethernet, other)
- [ ] `DNSQueryType` type (string name or uint16)
- [ ] `UDPTimeoutCompat` (number-as-seconds or duration string)
- [ ] `ServerOptions` (server + server_port)
- [ ] `ListenOptions` (listen address, port, socket options)
- [ ] `DialerOptions` (detour, bind, timeout, routing mark, network strategy)
- [ ] `DomainResolveOptions` (shorthand string or full object)
- [ ] Polymorphic inbound/outbound/endpoint/service/DNS parsing via type registries
- [ ] Build tag / feature flag system for conditional protocol inclusion
- [ ] Duplicate tag validation for inbounds and outbounds/endpoints

### Logging
- [ ] Log levels: trace, debug, info, warn, error, fatal, panic
- [ ] Context-aware logger (per-connection context)
- [ ] Observable log factory (for Clash API log streaming)
- [ ] File output support
- [ ] Timestamp option
- [ ] Color output option

### Service Lifecycle
- [ ] Start stages: Initialize, Start, PostStart, Started
- [ ] Ordered service startup with dependency resolution
- [ ] Graceful shutdown with `Close()` propagation
- [ ] Context-based service registry (`service.FromContext[T]`)

## Phase 2: Core Pipeline

### Adapter Interfaces
- [ ] `adapter.Inbound` interface
- [ ] `adapter.Outbound` interface (with `N.Dialer`)
- [ ] `adapter.Endpoint` interface (bidirectional: inbound + outbound)
- [ ] `adapter.Router` interface
- [ ] `adapter.InboundContext` metadata struct
- [ ] `adapter.ConnectionRouterEx` for connection routing
- [ ] `adapter.OutboundManager` (tag lookup, default outbound)
- [ ] `adapter.InboundManager`
- [ ] `adapter.EndpointManager`
- [ ] `adapter.NetworkManager`

### Network Primitives
- [ ] `N.Dialer` interface (DialContext, ListenPacket)
- [ ] `N.ExtendedConn` (buffered read/write extensions)
- [ ] `N.PacketConn` (with `ReadPacket`/`WritePacket` for zero-copy)
- [ ] `bufio` utilities (copy, pipe, counter connections)
- [ ] `M.Socksaddr` type (unified addr:port with FQDN support)
- [ ] Connection metadata propagation via context

### Listener
- [ ] TCP listener with configurable socket options
- [ ] UDP listener with packet connection handling
- [ ] Keep-alive configuration
- [ ] TCP Fast Open support
- [ ] Multipath TCP support
- [ ] Routing mark (`SO_MARK`) support
- [ ] Network namespace (`setns`) support
- [ ] Bind-to-interface support

### Dialer
- [ ] Default dialer with socket options
- [ ] Detour dialer (chain through another outbound)
- [ ] Interface binding
- [ ] Address binding (inet4/inet6)
- [ ] Routing mark propagation
- [ ] Connect timeout
- [ ] Domain resolution integration
- [ ] Network strategy (prefer specific interface types)
- [ ] Fallback dialer (try multiple networks)

### Router
- [ ] Route rule matching pipeline
- [ ] Default rule types (domain, IP, port, process, network, etc.)
- [ ] Logical rules (AND, OR with invert)
- [ ] Rule actions (route, reject, hijack-dns, sniff, resolve)
- [ ] Final outbound (default route)
- [ ] Rule set integration
- [ ] DNS rule pipeline (separate from route rules)
- [ ] Connection routing with metadata enrichment

### Sniffing
- [ ] Protocol sniffing framework
- [ ] HTTP sniffing (method + host header)
- [ ] TLS sniffing (SNI from ClientHello)
- [ ] QUIC sniffing (SNI from QUIC ClientHello)
- [ ] DNS sniffing (query domain)
- [ ] SSH sniffing
- [ ] RDP sniffing
- [ ] BitTorrent sniffing
- [ ] DTLS sniffing
- [ ] Sniff timeout handling
- [ ] Override destination option

## Phase 3: Transport Layer

### TLS
- [ ] TLS client (with SNI, ALPN, certificate pinning)
- [ ] TLS server (certificate, key, ACME)
- [ ] UTLS client (Chrome/Firefox/Safari fingerprints)
- [ ] Reality client and server
- [ ] ECH (Encrypted Client Hello) support
- [ ] kTLS optimization (Linux)

### V2Ray Transports
- [ ] WebSocket transport (client + server)
- [ ] HTTP/2 transport (client + server)
- [ ] gRPC transport (client + server)
- [ ] HTTPUpgrade transport (client + server)
- [ ] QUIC transport (client + server) [build tag: with_quic]

### Multiplex (sing-mux)
- [ ] Multiplex client (smux, yamux, h2mux protocols)
- [ ] Multiplex server
- [ ] Stream multiplexing over single connection
- [ ] Padding support
- [ ] Brutal congestion control option
- [ ] Max connections / min streams / max streams configuration

## Phase 4: Protocols

### Direct
- [ ] Direct inbound (accept connections and route)
- [ ] Direct outbound (connect directly to destination)

### Block
- [ ] Block outbound (reject connections)

### SOCKS
- [ ] SOCKS5 inbound (with optional auth)
- [ ] SOCKS4/4a inbound
- [ ] SOCKS5 outbound (client)
- [ ] SOCKS5 UDP ASSOCIATE

### HTTP
- [ ] HTTP proxy inbound (CONNECT + plain HTTP)
- [ ] HTTP CONNECT outbound (client)
- [ ] Basic/digest authentication

### Mixed
- [ ] Mixed inbound (auto-detect HTTP/SOCKS5)

### Shadowsocks
- [ ] Single-user Shadowsocks inbound
- [ ] Multi-user Shadowsocks inbound
- [ ] Relay Shadowsocks inbound
- [ ] Shadowsocks outbound
- [ ] AEAD ciphers (aes-128-gcm, aes-256-gcm, chacha20-ietf-poly1305)
- [ ] AEAD 2022 ciphers (2022-blake3-aes-128-gcm, 2022-blake3-aes-256-gcm, 2022-blake3-chacha20-poly1305)
- [ ] UDP relay
- [ ] SIP003 plugin support (obfs, v2ray-plugin)
- [ ] UDP-over-TCP (UoT)

### VMess
- [ ] VMess inbound
- [ ] VMess outbound
- [ ] Security modes: auto, zero, aes-128-gcm, chacha20-poly1305, aes-128-cfb, none
- [ ] alterId support (legacy)
- [ ] Global padding option
- [ ] Authenticated length option
- [ ] Packet encoding: packetaddr, xudp

### VLESS
- [ ] VLESS inbound
- [ ] VLESS outbound
- [ ] UUID-based authentication
- [ ] Flow: xtls-rprx-vision
- [ ] Packet encoding: packetaddr, xudp

### Trojan
- [ ] Trojan inbound
- [ ] Trojan outbound
- [ ] SHA-224 password hashing (56-byte hex key)
- [ ] UDP relay via Trojan protocol

### ShadowTLS
- [ ] ShadowTLS inbound (v1, v2, v3)
- [ ] ShadowTLS outbound
- [ ] TLS handshake relay

### Hysteria / Hysteria2 [build tag: with_quic]
- [ ] Hysteria inbound and outbound
- [ ] Hysteria2 inbound and outbound
- [ ] Brutal congestion control

### TUIC [build tag: with_quic]
- [ ] TUIC inbound and outbound
- [ ] QUIC-based multiplexing

### WireGuard [build tag: with_wireguard]
- [ ] WireGuard endpoint (bidirectional)
- [ ] Noise protocol handshake
- [ ] Peer management

### Other
- [ ] NaiveProxy inbound (and outbound with build tag)
- [ ] Tor outbound
- [ ] SSH outbound

### Outbound Groups
- [ ] Selector group (manual selection with persistence)
- [ ] URLTest group (automatic selection by latency)
- [ ] URL test implementation
- [ ] Test history storage

## Phase 5: DNS

### DNS System
- [ ] DNS router with rule-based transport selection
- [ ] DNS cache with TTL
- [ ] Cache capacity limit
- [ ] Independent cache per rule
- [ ] Client subnet (EDNS0)
- [ ] Domain strategy application (resolve A/AAAA/both)

### DNS Transports
- [ ] UDP DNS transport
- [ ] TCP DNS transport
- [ ] TLS DNS transport (DoT)
- [ ] HTTPS DNS transport (DoH)
- [ ] QUIC DNS transport (DoQ) [build tag: with_quic]
- [ ] HTTP/3 DNS transport [build tag: with_quic]
- [ ] Local system DNS transport
- [ ] Hosts file DNS transport
- [ ] FakeIP DNS transport
- [ ] DHCP DNS transport [build tag: with_dhcp]

### FakeIP
- [ ] FakeIP address pool (IPv4 + IPv6)
- [ ] Address allocation and recycling
- [ ] Bidirectional mapping (address <-> domain)
- [ ] Cache file persistence
- [ ] Metadata persistence (allocation pointer)

### DNS Rules
- [ ] DNS rule matching (domain, source, query type, etc.)
- [ ] DNS rule actions (route, reject, predefined response)
- [ ] Rejected DNS Response Cache (RDRC)

## Phase 6: Advanced Features

### Rule Sets
- [ ] SRS binary format reader
- [ ] SRS binary format writer
- [ ] JSON source format reader
- [ ] Local rule set with file watching
- [ ] Remote rule set with HTTP fetch and ETag caching
- [ ] Inline rule sets
- [ ] Rule set reference counting and memory management
- [ ] Rule set metadata (contains process/WIFI/IPCIDR flags)
- [ ] IP set extraction for TUN routing

### GeoIP / GeoSite (Legacy)
- [ ] MaxMind MMDB reader (sing-geoip type)
- [ ] GeoSite binary format reader
- [ ] GeoSite to rule compilation
- [ ] Auto-download on first use

### Process Searcher
- [ ] Linux: netlink socket diagnosis + procfs search
- [ ] macOS: sysctl PCB list parsing
- [ ] Windows: IP Helper API (GetExtendedTcpTable)
- [ ] Android: netlink + package manager UID mapping
- [ ] Platform interface delegation

### TUN
- [ ] TUN device creation and configuration
- [ ] Auto-route (routing table management)
- [ ] DNS hijacking via TUN
- [ ] IPv4 and IPv6 support
- [ ] MTU configuration
- [ ] Platform TUN (Android VpnService, iOS NetworkExtension)

### Clash API [build tag: with_clash_api]
- [ ] HTTP REST server with chi router
- [ ] Bearer token authentication
- [ ] WebSocket support
- [ ] Traffic statistics streaming
- [ ] Log streaming with level filter
- [ ] Connection tracking and listing
- [ ] Proxy listing and delay testing
- [ ] Selector update API
- [ ] Mode switching with persistence
- [ ] External UI static file serving
- [ ] CORS configuration

### V2Ray API [build tag: with_v2ray_api]
- [ ] gRPC server
- [ ] Stats service (GetStats, QueryStats, GetSysStats)
- [ ] Per-inbound/outbound/user traffic counters
- [ ] Counter naming convention (entity>>>tag>>>traffic>>>direction)
- [ ] Pattern matching (substring and regex)

### Cache File
- [ ] bbolt (or equivalent) database
- [ ] Selected outbound persistence
- [ ] Clash mode persistence
- [ ] Remote rule set caching
- [ ] FakeIP persistence (bidirectional mapping)
- [ ] RDRC persistence with expiration
- [ ] Cache ID namespacing
- [ ] Corruption recovery (delete and recreate)
- [ ] Async write buffering

### Platform Interface
- [ ] gomobile-compatible interface definition
- [ ] TUN device management bridge
- [ ] Default interface monitoring
- [ ] Network interface enumeration
- [ ] Connection owner lookup bridge
- [ ] WIFI state reading
- [ ] System certificate access
- [ ] Notification sending
- [ ] Neighbor monitoring
- [ ] On-demand rules (iOS)
- [ ] Network extension lifecycle (iOS)
- [ ] Command server (IPC)

## Phase 7: Testing and Compatibility

### Wire Format Compatibility
- [ ] VLESS protocol wire format tests
- [ ] VMess protocol wire format tests
- [ ] Trojan protocol wire format tests
- [ ] Shadowsocks wire format tests (all cipher variants)
- [ ] Multiplex (sing-mux) wire format tests
- [ ] Integration tests with official sing-box

### Configuration Compatibility
- [ ] Parse official sing-box example configurations
- [ ] Round-trip serialization tests
- [ ] Legacy format migration tests
- [ ] Unknown field rejection tests

### Interoperability
- [ ] Test against sing-box servers
- [ ] Test against Xray-core servers
- [ ] Test against Clash.Meta
- [ ] SRS rule set format compatibility
- [ ] GeoIP database compatibility
- [ ] GeoSite database compatibility
