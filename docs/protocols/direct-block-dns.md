# Direct, Block, and DNS Outbounds

These three outbound types serve fundamental routing functions: `direct` connects to the destination without a proxy, `block` rejects all connections, and `dns` intercepts DNS traffic for internal resolution.

**Source**: `protocol/direct/outbound.go`, `protocol/direct/inbound.go`, `protocol/direct/loopback_detect.go`, `protocol/block/outbound.go`, `protocol/dns/outbound.go`, `protocol/dns/handle.go`

## Direct Outbound

### Architecture

```go
type Outbound struct {
    outbound.Adapter
    ctx            context.Context
    logger         logger.ContextLogger
    dialer         dialer.ParallelInterfaceDialer
    domainStrategy C.DomainStrategy
    fallbackDelay  time.Duration
    isEmpty        bool
}
```

The direct outbound implements multiple dialer interfaces:

```go
var (
    _ N.ParallelDialer             = (*Outbound)(nil)
    _ dialer.ParallelNetworkDialer = (*Outbound)(nil)
    _ dialer.DirectDialer          = (*Outbound)(nil)
    _ adapter.DirectRouteOutbound  = (*Outbound)(nil)
)
```

### Network Support

Direct supports TCP, UDP, and ICMP (for ping/traceroute):

```go
outbound.NewAdapterWithDialerOptions(C.TypeDirect, tag,
    []string{N.NetworkTCP, N.NetworkUDP, N.NetworkICMP}, options.DialerOptions)
```

### Detour Restriction

Direct outbound cannot use a detour (it would be circular):

```go
if options.Detour != "" {
    return nil, E.New("`detour` is not supported in direct context")
}
```

### IsEmpty Detection

The direct outbound tracks whether it has non-default configuration. This is used by the router to optimize routing decisions:

```go
outbound.isEmpty = reflect.DeepEqual(options.DialerOptions, option.DialerOptions{UDPFragmentDefault: true})
```

### Connection Establishment

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    ctx, metadata := adapter.ExtendContext(ctx)
    metadata.Outbound = h.Tag()
    metadata.Destination = destination
    return h.dialer.DialContext(ctx, network, destination)
}
```

### Parallel Dialing

Direct outbound supports Happy Eyeballs (parallel IPv4/IPv6) connection attempts:

```go
func (h *Outbound) DialParallel(ctx, network, destination, destinationAddresses) (net.Conn, error) {
    return dialer.DialParallelNetwork(ctx, h.dialer, network, destination,
        destinationAddresses, destinationAddresses[0].Is6(), nil, nil, nil, h.fallbackDelay)
}
```

### ICMP / Direct Route

Direct outbound supports ICMP connections for ping/traceroute via the `DirectRouteOutbound` interface:

```go
func (h *Outbound) NewDirectRouteConnection(metadata, routeContext, timeout) (tun.DirectRouteDestination, error) {
    destination, _ := ping.ConnectDestination(ctx, h.logger,
        common.MustCast[*dialer.DefaultDialer](h.dialer).DialerForICMPDestination(metadata.Destination.Addr).Control,
        metadata.Destination.Addr, routeContext, timeout)
    return destination, nil
}
```

### Network Strategy Dialing

The outbound supports advanced network strategy options for multi-path connections:

```go
func (h *Outbound) DialParallelNetwork(ctx, network, destination, destinationAddresses,
    networkStrategy, networkType, fallbackNetworkType, fallbackDelay) (net.Conn, error) {
    return dialer.DialParallelNetwork(ctx, h.dialer, network, destination,
        destinationAddresses, destinationAddresses[0].Is6(),
        networkStrategy, networkType, fallbackNetworkType, fallbackDelay)
}
```

## Direct Inbound

The direct inbound accepts raw TCP/UDP connections and routes them with an optional destination override:

```go
type Inbound struct {
    inbound.Adapter
    overrideOption      int    // 0=none, 1=address+port, 2=address, 3=port
    overrideDestination M.Socksaddr
}
```

### Override Options

```go
if options.OverrideAddress != "" && options.OverridePort != 0 {
    inbound.overrideOption = 1  // Replace both address and port
} else if options.OverrideAddress != "" {
    inbound.overrideOption = 2  // Replace address only
} else if options.OverridePort != 0 {
    inbound.overrideOption = 3  // Replace port only
}
```

## Loopback Detection

The `loopBackDetector` prevents routing loops by tracking connections:

```go
type loopBackDetector struct {
    networkManager   adapter.NetworkManager
    connMap          map[netip.AddrPort]netip.AddrPort    // TCP
    packetConnMap    map[uint16]uint16                     // UDP (port-based)
}
```

It wraps outgoing connections and checks incoming connections against the map:

```go
func (l *loopBackDetector) CheckConn(source, local netip.AddrPort) bool {
    destination, loaded := l.connMap[source]
    return loaded && destination != local
}
```

Note: Loopback detection is currently commented out in the source code but the infrastructure remains.

## Block Outbound

The simplest outbound -- it rejects all connections with `EPERM`:

```go
type Outbound struct {
    outbound.Adapter
    logger logger.ContextLogger
}

func New(ctx, router, logger, tag, _ option.StubOptions) (adapter.Outbound, error) {
    return &Outbound{
        Adapter: outbound.NewAdapter(C.TypeBlock, tag, []string{N.NetworkTCP, N.NetworkUDP}, nil),
        logger:  logger,
    }, nil
}

func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    h.logger.InfoContext(ctx, "blocked connection to ", destination)
    return nil, syscall.EPERM
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    h.logger.InfoContext(ctx, "blocked packet connection to ", destination)
    return nil, syscall.EPERM
}
```

Key details:
- Uses `option.StubOptions` (empty struct) since no configuration is needed
- Returns `syscall.EPERM` (not a generic error), which can be detected by callers
- Supports both TCP and UDP (both are blocked)

## DNS Outbound

The DNS outbound intercepts connections that carry DNS traffic and resolves them using the internal DNS router.

### Architecture

```go
type Outbound struct {
    outbound.Adapter
    router adapter.DNSRouter
    logger logger.ContextLogger
}
```

### Regular Dial is Unsupported

The DNS outbound does not support regular `DialContext` or `ListenPacket`:

```go
func (d *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    return nil, os.ErrInvalid
}
```

Instead, it implements `NewConnectionEx` and `NewPacketConnectionEx` to process DNS messages directly.

### Stream DNS (TCP)

TCP DNS connections are processed in a loop, reading length-prefixed DNS messages:

```go
func (d *Outbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    metadata.Destination = M.Socksaddr{}
    for {
        conn.SetReadDeadline(time.Now().Add(C.DNSTimeout))
        err := HandleStreamDNSRequest(ctx, d.router, conn, metadata)
        if err != nil {
            conn.Close()
            return
        }
    }
}
```

### Stream DNS Wire Format

DNS over TCP uses a 2-byte length prefix:

```go
func HandleStreamDNSRequest(ctx, router, conn, metadata) error {
    // 1. Read 2-byte length prefix
    var queryLength uint16
    binary.Read(conn, binary.BigEndian, &queryLength)

    // 2. Read the DNS message
    buffer := buf.NewSize(int(queryLength))
    buffer.ReadFullFrom(conn, int(queryLength))

    // 3. Unpack and route
    var message mDNS.Msg
    message.Unpack(buffer.Bytes())

    // 4. Exchange via DNS router (async)
    go func() {
        response, _ := router.Exchange(ctx, &message, adapter.DNSQueryOptions{})
        // Write length-prefixed response
        binary.BigEndian.PutUint16(responseBuffer.ExtendHeader(2), uint16(len(n)))
        conn.Write(responseBuffer.Bytes())
    }()
}
```

### Packet DNS (UDP)

UDP DNS packets are processed concurrently with an idle timeout:

```go
func (d *Outbound) NewPacketConnectionEx(ctx, conn, metadata, onClose) {
    NewDNSPacketConnection(ctx, d.router, conn, nil, metadata)
}
```

The packet handler:
1. Reads DNS packets from the connection
2. Unpacks each packet as a DNS message
3. Exchanges via the DNS router in a goroutine
4. Writes the response back with DNS truncation support
5. Uses a canceler with `C.DNSTimeout` for idle detection

```go
go func() {
    response, _ := router.Exchange(ctx, &message, adapter.DNSQueryOptions{})
    responseBuffer, _ := dns.TruncateDNSMessage(&message, response, 1024)
    conn.WritePacket(responseBuffer, destination)
}()
```

## Configuration Examples

### Direct

```json
{
  "type": "direct",
  "tag": "direct-out"
}
```

### Direct with Domain Strategy

```json
{
  "type": "direct",
  "tag": "direct-out",
  "domain_strategy": "prefer_ipv4"
}
```

### Block

```json
{
  "type": "block",
  "tag": "block-out"
}
```

### DNS

```json
{
  "type": "dns",
  "tag": "dns-out"
}
```

### Direct Inbound (with override)

```json
{
  "type": "direct",
  "tag": "direct-in",
  "listen": "::",
  "listen_port": 5353,
  "override_address": "8.8.8.8",
  "override_port": 53
}
```
