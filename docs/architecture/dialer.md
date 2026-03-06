# Dialer System

The dialer system is the outbound connection factory. It wraps Go's `net.Dialer` with protocol-specific features: domain resolution, detour routing, TCP Fast Open, interface binding, and parallel connections.

**Source**: `common/dialer/`

## Dialer Creation

```go
func New(ctx context.Context, options option.DialerOptions, isDomain bool) (N.Dialer, error)
```

This factory function builds a dialer chain based on the options:

```
DefaultDialer → [ResolveDialer] → [DetourDialer]
     ↓
  BindInterface / RoutingMark / ProtectFunc
  TCP Fast Open
  Connect timeout
  Domain resolution (if isDomain)
```

## DefaultDialer

The base dialer wraps `net.Dialer` with platform-specific socket options:

```go
type DefaultDialer struct {
    dialer4           tcpDialer    // IPv4 dialer
    dialer6           tcpDialer    // IPv6 dialer
    udpDialer4        net.Dialer
    udpDialer6        net.Dialer
    udpAddr4          string
    udpAddr6          string
    isWireGuardListener bool
    networkManager    adapter.NetworkManager
    networkStrategy   *C.NetworkStrategy
}
```

Features:
- **Dual-stack**: Separate dialers for IPv4 and IPv6
- **Socket options**: `SO_MARK`, `SO_BINDTODEVICE`, `IP_TRANSPARENT`
- **TCP Fast Open**: Via `tfo-go` library
- **Connect timeout**: `C.TCPConnectTimeout` (15s default)

### Parallel Interface Dialer

For mobile devices with multiple network interfaces:

```go
type ParallelInterfaceDialer interface {
    DialParallelInterface(ctx, network, destination, strategy, networkType, fallbackType, fallbackDelay) (net.Conn, error)
    ListenSerialInterfacePacket(ctx, destination, strategy, networkType, fallbackType, fallbackDelay) (net.PacketConn, error)
}
```

Tries different network interfaces based on the strategy (e.g., prefer WiFi, fallback to cellular after delay).

### Parallel Network Dialer

Happy Eyeballs-style parallel dialing for dual-stack:

```go
type ParallelNetworkDialer interface {
    DialParallelNetwork(ctx, network, destination, destinationAddresses, strategy, networkType, fallbackType, fallbackDelay) (net.Conn, error)
}
```

## DetourDialer

Routes traffic through another outbound:

```go
type DetourDialer struct {
    outboundManager adapter.OutboundManager
    detour          string  // outbound tag to use
}

func (d *DetourDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    outbound, _ := d.outboundManager.Outbound(d.detour)
    return outbound.DialContext(ctx, network, destination)
}
```

Used when an outbound specifies `detour` to chain through another outbound (e.g., VLESS → direct).

## ResolveDialer

Wraps a dialer to resolve domains before dialing:

```go
type ResolveDialer struct {
    dialer    N.Dialer
    dnsRouter adapter.DNSRouter
    strategy  C.DomainStrategy
    server    string
}

func (d *ResolveDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    if destination.IsFqdn() {
        addresses, err := d.dnsRouter.Lookup(ctx, destination.Fqdn, options)
        // Use resolved addresses with parallel dialing
        return N.DialSerial(ctx, d.dialer, network, destination, addresses)
    }
    return d.dialer.DialContext(ctx, network, destination)
}
```

## WireGuard Dialer

Special dialer for WireGuard that uses the WireGuard endpoint's network:

```go
type WireGuardDialer struct {
    dialer N.Dialer
}
```

## Serial/Parallel Dialing

```go
// Try addresses one by one
func DialSerial(ctx, dialer, network, destination, addresses) (net.Conn, error)

// Try with network strategy (interface selection)
func DialSerialNetwork(ctx, dialer, network, destination, addresses,
    strategy, networkType, fallbackType, fallbackDelay) (net.Conn, error)

// Listen for packets with address selection
func ListenSerialNetworkPacket(ctx, dialer, destination, addresses,
    strategy, networkType, fallbackType, fallbackDelay) (net.PacketConn, netip.Addr, error)
```

## Dialer Options

```go
type DialerOptions struct {
    Detour              string
    BindInterface       string
    Inet4BindAddress    *ListenAddress
    Inet6BindAddress    *ListenAddress
    ProtectPath         string
    RoutingMark         uint32
    ReuseAddr           bool
    ConnectTimeout      Duration
    TCPFastOpen         bool
    TCPMultiPath        bool
    UDPFragment         *bool
    UDPFragmentDefault  bool
    DomainResolver      *DomainResolveOptions
    NetworkStrategy     *NetworkStrategy
    NetworkType         Listable[InterfaceType]
    FallbackNetworkType Listable[InterfaceType]
    FallbackDelay       Duration
    IsWireGuardListener bool
}
```
