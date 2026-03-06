# Build Tags and Conditional Compilation

sing-box uses Go build tags to control which protocols, transports, and features are compiled into the binary. This allows producing minimal builds that only include needed functionality.

**Source**: `include/`

## Architecture

The `include/` directory contains a `registry.go` file that defines the default protocol registrations, plus pairs of files for optional features: one with the feature tag and one with its negation.

### Registry Entry Point

```go
// include/registry.go
func Context(ctx context.Context) context.Context {
    return box.Context(ctx,
        InboundRegistry(),
        OutboundRegistry(),
        EndpointRegistry(),
        DNSTransportRegistry(),
        ServiceRegistry(),
    )
}
```

This function creates the context with all type registries populated, which is then used during configuration parsing. The registries determine which `type` values are valid for inbounds, outbounds, endpoints, DNS servers, and services.

## Always-Included Protocols

These protocols are registered unconditionally in `registry.go`:

### Inbounds

| Type | Package | Description |
|------|---------|-------------|
| `tun` | `protocol/tun` | TUN interface |
| `redirect` | `protocol/redirect` | TCP redirect (Linux) |
| `tproxy` | `protocol/redirect` | Transparent proxy (Linux) |
| `direct` | `protocol/direct` | Direct inbound |
| `socks` | `protocol/socks` | SOCKS4/5 proxy |
| `http` | `protocol/http` | HTTP proxy |
| `mixed` | `protocol/mixed` | HTTP + SOCKS5 mixed proxy |
| `shadowsocks` | `protocol/shadowsocks` | Shadowsocks |
| `vmess` | `protocol/vmess` | VMess |
| `trojan` | `protocol/trojan` | Trojan |
| `naive` | `protocol/naive` | NaiveProxy |
| `shadowtls` | `protocol/shadowtls` | ShadowTLS |
| `vless` | `protocol/vless` | VLESS |
| `anytls` | `protocol/anytls` | AnyTLS |

### Outbounds

| Type | Package | Description |
|------|---------|-------------|
| `direct` | `protocol/direct` | Direct outbound |
| `block` | `protocol/block` | Block (reject) |
| `selector` | `protocol/group` | Manual selector group |
| `urltest` | `protocol/group` | Auto URL test group |
| `socks` | `protocol/socks` | SOCKS5 client |
| `http` | `protocol/http` | HTTP CONNECT client |
| `shadowsocks` | `protocol/shadowsocks` | Shadowsocks client |
| `vmess` | `protocol/vmess` | VMess client |
| `trojan` | `protocol/trojan` | Trojan client |
| `tor` | `protocol/tor` | Tor client |
| `ssh` | `protocol/ssh` | SSH client |
| `shadowtls` | `protocol/shadowtls` | ShadowTLS client |
| `vless` | `protocol/vless` | VLESS client |
| `anytls` | `protocol/anytls` | AnyTLS client |

### DNS Transports

| Type | Package | Description |
|------|---------|-------------|
| `tcp` | `dns/transport` | DNS over TCP |
| `udp` | `dns/transport` | DNS over UDP |
| `tls` | `dns/transport` | DNS over TLS (DoT) |
| `https` | `dns/transport` | DNS over HTTPS (DoH) |
| `hosts` | `dns/transport/hosts` | Hosts file |
| `local` | `dns/transport/local` | System resolver |
| `fakeip` | `dns/transport/fakeip` | FakeIP |
| `resolved` | `service/resolved` | Resolved DNS |

## Build-Tag-Gated Features

### QUIC (`with_quic`)

**Files**: `include/quic.go`, `include/quic_stub.go`

Enables QUIC-based protocols:

```go
//go:build with_quic

func registerQUICInbounds(registry *inbound.Registry) {
    hysteria.RegisterInbound(registry)
    tuic.RegisterInbound(registry)
    hysteria2.RegisterInbound(registry)
}

func registerQUICOutbounds(registry *outbound.Registry) {
    hysteria.RegisterOutbound(registry)
    tuic.RegisterOutbound(registry)
    hysteria2.RegisterOutbound(registry)
}

func registerQUICTransports(registry *dns.TransportRegistry) {
    quic.RegisterTransport(registry)      // DNS over QUIC
    quic.RegisterHTTP3Transport(registry) // DNS over HTTP/3
}
```

Also enables:
- V2Ray QUIC transport (`transport/v2rayquic`)
- NaiveProxy QUIC support (`protocol/naive/quic`)

**Stub behavior** (without tag): All QUIC types register but return `C.ErrQUICNotIncluded`:

```go
//go:build !with_quic

func registerQUICInbounds(registry *inbound.Registry) {
    inbound.Register[option.HysteriaInboundOptions](registry, C.TypeHysteria,
        func(...) (adapter.Inbound, error) {
            return nil, C.ErrQUICNotIncluded
        })
    // ... same for TUIC, Hysteria2
}
```

### WireGuard (`with_wireguard`)

**Files**: `include/wireguard.go`, `include/wireguard_stub.go`

Enables the WireGuard endpoint:

```go
//go:build with_wireguard

func registerWireGuardEndpoint(registry *endpoint.Registry) {
    wireguard.RegisterEndpoint(registry)
}
```

**Stub behavior**: Returns an error message directing users to rebuild with the tag.

### Clash API (`with_clash_api`)

**Files**: `include/clashapi.go`, `include/clashapi_stub.go`

The Clash API uses a side-effect import pattern:

```go
//go:build with_clash_api

import _ "github.com/sagernet/sing-box/experimental/clashapi"
```

The `clashapi` package's `init()` function registers the constructor via `experimental.RegisterClashServerConstructor(NewServer)`.

**Stub behavior**: Registers a constructor that returns an error.

### V2Ray API (`with_v2ray_api`)

**Files**: `include/v2rayapi.go`, `include/v2rayapi_stub.go`

Same pattern as Clash API -- side-effect import that triggers `init()` registration.

### DHCP DNS (`with_dhcp`)

**Files**: `include/dhcp.go`, `include/dhcp_stub.go`

Enables DHCP-based DNS server discovery.

### NaiveProxy Outbound (`with_naive`)

**Files**: `include/naive_outbound.go`, `include/naive_outbound_stub.go`

Enables NaiveProxy as an outbound (client) protocol.

### Tailscale (`with_tailscale`)

**Files**: `include/tailscale.go`, `include/tailscale_stub.go`

Enables Tailscale endpoint and DNS transport.

### CCM/OCM

**Files**: `include/ccm.go`, `include/ccm_stub.go`, `include/ocm.go`, `include/ocm_stub.go`

Cloud configuration management services.

## The Registry Pattern

The registration pattern uses Go generics to associate a type string with an options struct:

```go
// Generic registration function
func Register[Options any](registry *Registry, typeName string,
    constructor func(ctx, router, logger, tag string, options Options) (adapter.Inbound, error)) {
    registry.register(typeName, func() any { return new(Options) }, constructor)
}
```

This allows the registry to:
1. Create a zero-value options struct by type name (for JSON parsing)
2. Call the constructor with the parsed options (for instance creation)

### How Registration Flows

```
include/registry.go
  -> InboundRegistry()
       -> tun.RegisterInbound(registry)
            -> inbound.Register[option.TunInboundOptions](registry, "tun", tun.NewInbound)
                 -> registry stores {"tun": {createOptions: () => new(TunInboundOptions), constructor: NewInbound}}

Config parsing:
  JSON {"type": "tun", ...}
    -> registry.CreateOptions("tun")  => *TunInboundOptions
    -> json.Unmarshal(content, options)
    -> tun.NewInbound(ctx, router, logger, tag, *options)
```

## Removed Protocol Stubs

Some protocols are registered as stubs that return descriptive errors:

```go
func registerStubForRemovedInbounds(registry *inbound.Registry) {
    inbound.Register[option.ShadowsocksInboundOptions](registry, C.TypeShadowsocksR,
        func(...) (adapter.Inbound, error) {
            return nil, E.New("ShadowsocksR is deprecated and removed in sing-box 1.6.0")
        })
}

func registerStubForRemovedOutbounds(registry *outbound.Registry) {
    // ShadowsocksR: removed in 1.6.0
    // WireGuard outbound: migrated to endpoint in 1.11.0, removed in 1.13.0
}
```

## Platform-Specific Files

Some include files are platform-specific:

| File | Platform | Purpose |
|------|----------|---------|
| `tz_android.go` | Android | Timezone handling |
| `tz_ios.go` | iOS | Timezone handling |
| `oom_killer.go` | (tag-gated) | OOM killer service |
| `ccm_stub_darwin.go` | Darwin | CCM stub for macOS |

## Building with Tags

```bash
# Minimal build (core protocols only)
go build ./cmd/sing-box

# Full build with all optional features
go build -tags "with_quic,with_wireguard,with_clash_api,with_v2ray_api,with_dhcp" ./cmd/sing-box

# Specific feature set
go build -tags "with_quic,with_clash_api" ./cmd/sing-box
```

## Reimplementation Notes

1. **Feature flags**: In a reimplementation, build tags translate to compile-time feature flags. Rust uses Cargo features; Swift/C++ use preprocessor defines. The key principle is that unused protocols should not increase binary size
2. **Stub pattern**: When a feature is disabled, sing-box still registers the type name so that configuration parsing produces a helpful error message rather than "unknown type"
3. **Side-effect imports**: The `_ "package"` pattern triggers `init()` functions. In a reimplementation, use explicit registration calls instead
4. **Registry generics**: The `Register[Options any]` pattern ties together JSON schema and constructor. A reimplementation needs an equivalent mechanism for type-safe polymorphic construction
5. **Default registrations**: Core protocols (socks, http, shadowsocks, vmess, trojan, vless, direct, block, selector, urltest) should always be available without feature flags
