---
layout: home

hero:
  name: sing-box Internals
  text: Complete Technical Analysis
  tagline: Deep dive into sing-box architecture, protocols, and implementation details for reimplementation
  actions:
    - theme: brand
      text: Architecture
      link: /architecture/overview
    - theme: alt
      text: Protocols
      link: /protocols/overview
    - theme: alt
      text: Implementation Checklist
      link: /implementation/checklist

features:
  - title: Context-Based Architecture
    details: Service registry pattern using Go contexts for dependency injection, with 4-phase lifecycle management and extensible adapter interfaces
  - title: 20+ Proxy Protocols
    details: VLESS, VMess, Trojan, Shadowsocks, ShadowTLS, Hysteria2, TUIC, AnyTLS, WireGuard, NaiveProxy, and more — all through sing-* libraries
  - title: Modular Transport
    details: V2Ray-compatible transports (WebSocket, gRPC, HTTP, HTTPUpgrade, QUIC) plus TLS/uTLS/REALITY/kTLS security
  - title: Advanced Routing
    details: Action-based rule system with sniff/resolve/route/reject/bypass/hijack-dns actions, rule sets, and process matching
  - title: Comprehensive DNS
    details: Multi-transport DNS with rule routing, FakeIP, caching, EDNS0 client subnet, and platform-native resolvers
  - title: Cross-Platform
    details: TUN support via sing-tun, mobile platform bindings (libbox), Clash API compatibility, and system proxy integration
---
