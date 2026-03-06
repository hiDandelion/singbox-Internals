# WireGuard Protocol

WireGuard in sing-box is implemented as an **Endpoint** (not an inbound/outbound pair), using the `wireguard-go` library with two device backends: gVisor userspace networking or system TUN. The endpoint supports both inbound and outbound traffic, NAT device wrapping for ICMP/ping, and peer DNS resolution.

**Source**: `protocol/wireguard/endpoint.go`, `transport/wireguard/endpoint.go`, `transport/wireguard/device.go`, `transport/wireguard/device_nat.go`

## Endpoint Architecture

WireGuard uses the `endpoint.Adapter` pattern, which is a combined inbound+outbound:

```go
type Endpoint struct {
    endpoint.Adapter
    ctx            context.Context
    router         adapter.Router
    dnsRouter      adapter.DNSRouter
    logger         logger.ContextLogger
    localAddresses []netip.Prefix
    endpoint       *wireguard.Endpoint
}
```

It implements multiple interfaces:

```go
var (
    _ adapter.OutboundWithPreferredRoutes = (*Endpoint)(nil)
    _ dialer.PacketDialerWithDestination  = (*Endpoint)(nil)
)
```

### Network Support

WireGuard supports TCP, UDP, and ICMP:

```go
endpoint.NewAdapterWithDialerOptions(C.TypeWireGuard, tag,
    []string{N.NetworkTCP, N.NetworkUDP, N.NetworkICMP}, options.DialerOptions)
```

## Device Interface

The `Device` interface abstracts over different WireGuard tunnel implementations:

```go
type Device interface {
    wgTun.Device       // Read/Write packets
    N.Dialer           // DialContext / ListenPacket
    Start() error
    SetDevice(device *device.Device)
    Inet4Address() netip.Addr
    Inet6Address() netip.Addr
}
```

### Device Factory

The `NewDevice` factory selects the implementation based on the `System` flag:

```go
func NewDevice(options DeviceOptions) (Device, error) {
    if !options.System {
        return newStackDevice(options)        // gVisor userspace stack
    } else if !tun.WithGVisor {
        return newSystemDevice(options)       // System TUN device
    } else {
        return newSystemStackDevice(options)  // System TUN + gVisor stack
    }
}
```

- **Stack Device** (default): Pure userspace networking via gVisor. No kernel TUN device needed.
- **System Device**: Creates a real TUN interface on the OS. Requires elevated privileges.
- **System Stack Device**: System TUN with gVisor for packet processing.

## NAT Device Wrapper

The `NatDevice` wraps a `Device` to provide ICMP/ping support via source address rewriting:

```go
type NatDevice interface {
    Device
    CreateDestination(metadata, routeContext, timeout) (tun.DirectRouteDestination, error)
}

type natDeviceWrapper struct {
    Device
    ctx            context.Context
    logger         logger.ContextLogger
    packetOutbound chan *buf.Buffer
    rewriter       *ping.SourceRewriter
    buffer         [][]byte
}
```

### NAT Device Creation

If the underlying device does not natively support NAT, the wrapper is applied:

```go
tunDevice, _ := NewDevice(deviceOptions)
natDevice, isNatDevice := tunDevice.(NatDevice)
if !isNatDevice {
    natDevice = NewNATDevice(options.Context, options.Logger, tunDevice)
}
```

### Packet Interception

The NAT wrapper intercepts reads to inject outbound ICMP responses and intercepts writes to rewrite ICMP source addresses:

```go
func (d *natDeviceWrapper) Read(bufs [][]byte, sizes []int, offset int) (n int, err error) {
    select {
    case packet := <-d.packetOutbound:
        defer packet.Release()
        sizes[0] = copy(bufs[0][offset:], packet.Bytes())
        return 1, nil
    default:
    }
    return d.Device.Read(bufs, sizes, offset)
}

func (d *natDeviceWrapper) Write(bufs [][]byte, offset int) (int, error) {
    for _, buffer := range bufs {
        handled, err := d.rewriter.WriteBack(buffer[offset:])
        if handled {
            // ICMP response handled internally
        } else {
            d.buffer = append(d.buffer, buffer)
        }
    }
    // Forward non-ICMP packets to the real device
    d.Device.Write(d.buffer, offset)
}
```

## Transport-Level Endpoint

The `transport/wireguard/endpoint.go` manages the WireGuard device lifecycle:

```go
type Endpoint struct {
    options        EndpointOptions
    peers          []peerConfig
    ipcConf        string
    allowedAddress []netip.Prefix
    tunDevice      Device
    natDevice      NatDevice
    device         *device.Device
    allowedIPs     *device.AllowedIPs
}
```

### IPC Configuration

WireGuard configuration is passed to `wireguard-go` via IPC protocol strings:

```go
privateKeyBytes, _ := base64.StdEncoding.DecodeString(options.PrivateKey)
privateKey := hex.EncodeToString(privateKeyBytes)
ipcConf := "private_key=" + privateKey
if options.ListenPort != 0 {
    ipcConf += "\nlisten_port=" + F.ToString(options.ListenPort)
}
```

Peer configuration is generated similarly:

```go
func (c peerConfig) GenerateIpcLines() string {
    ipcLines := "\npublic_key=" + c.publicKeyHex
    if c.endpoint.IsValid() {
        ipcLines += "\nendpoint=" + c.endpoint.String()
    }
    if c.preSharedKeyHex != "" {
        ipcLines += "\npreshared_key=" + c.preSharedKeyHex
    }
    for _, allowedIP := range c.allowedIPs {
        ipcLines += "\nallowed_ip=" + allowedIP.String()
    }
    if c.keepalive > 0 {
        ipcLines += "\npersistent_keepalive_interval=" + F.ToString(c.keepalive)
    }
    return ipcLines
}
```

### Two-Phase Start

The endpoint has a two-phase start to handle DNS resolution of peer endpoints:

```go
func (w *Endpoint) Start(stage adapter.StartStage) error {
    switch stage {
    case adapter.StartStateStart:
        return w.endpoint.Start(false)   // Start without DNS resolution
    case adapter.StartStatePostStart:
        return w.endpoint.Start(true)    // Resolve peer domains now
    }
}
```

If peers have FQDN endpoints, resolution is deferred to `PostStart` when DNS is available:

```go
ResolvePeer: func(domain string) (netip.Addr, error) {
    endpointAddresses, _ := ep.dnsRouter.Lookup(ctx, domain, outboundDialer.(dialer.ResolveDialer).QueryOptions())
    return endpointAddresses[0], nil
},
```

### Reserved Bytes

WireGuard supports per-peer reserved bytes (used by some implementations like Cloudflare WARP):

```go
if len(rawPeer.Reserved) > 0 {
    if len(rawPeer.Reserved) != 3 {
        return nil, E.New("invalid reserved value, required 3 bytes")
    }
    copy(peer.reserved[:], rawPeer.Reserved[:])
}
```

### Bind Selection

The endpoint uses different bind implementations based on the dialer type:

```go
wgListener, isWgListener := common.Cast[dialer.WireGuardListener](e.options.Dialer)
if isWgListener {
    bind = conn.NewStdNetBind(wgListener.WireGuardControl())
} else {
    // ClientBind for single-peer connections
    bind = NewClientBind(ctx, logger, dialer, isConnect, connectAddr, reserved)
}
```

## Protocol-Level Endpoint

The `protocol/wireguard/endpoint.go` handles routing integration:

### Local Address Rewriting

Connections to the WireGuard endpoint's own address are rewritten to loopback:

```go
func (w *Endpoint) NewConnectionEx(ctx, conn, source, destination, onClose) {
    for _, localPrefix := range w.localAddresses {
        if localPrefix.Contains(destination.Addr) {
            metadata.OriginDestination = destination
            if destination.Addr.Is4() {
                destination.Addr = netip.AddrFrom4([4]uint8{127, 0, 0, 1})
            } else {
                destination.Addr = netip.IPv6Loopback()
            }
            break
        }
    }
}
```

### Outbound DNS Resolution

The outbound resolves FQDNs using the DNS router:

```go
func (w *Endpoint) DialContext(ctx, network, destination) (net.Conn, error) {
    if destination.IsFqdn() {
        destinationAddresses, _ := w.dnsRouter.Lookup(ctx, destination.Fqdn, adapter.DNSQueryOptions{})
        return N.DialSerial(ctx, w.endpoint, network, destination, destinationAddresses)
    }
    return w.endpoint.DialContext(ctx, network, destination)
}
```

### Preferred Routes

The endpoint advertises which addresses it can route, enabling the router to select it for matching destinations:

```go
func (w *Endpoint) PreferredAddress(address netip.Addr) bool {
    return w.endpoint.Lookup(address) != nil
}
```

### Pause Manager Integration

The endpoint responds to device pause/wake events (e.g., mobile sleep):

```go
func (e *Endpoint) onPauseUpdated(event int) {
    switch event {
    case pause.EventDevicePaused, pause.EventNetworkPause:
        e.device.Down()
    case pause.EventDeviceWake, pause.EventNetworkWake:
        e.device.Up()
    }
}
```

## Configuration Example

```json
{
  "type": "wireguard",
  "tag": "wg-ep",
  "system": false,
  "name": "wg0",
  "mtu": 1420,
  "address": ["10.0.0.2/32", "fd00::2/128"],
  "private_key": "base64-encoded-private-key",
  "peers": [
    {
      "address": "server.example.com",
      "port": 51820,
      "public_key": "base64-encoded-public-key",
      "pre_shared_key": "optional-base64-psk",
      "allowed_ips": ["0.0.0.0/0", "::/0"],
      "persistent_keepalive_interval": 25,
      "reserved": [0, 0, 0]
    }
  ],
  "workers": 2
}
```
