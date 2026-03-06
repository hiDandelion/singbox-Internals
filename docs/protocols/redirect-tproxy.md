# Redirect and TProxy Transparent Proxies

Redirect and TProxy are Linux-specific transparent proxy mechanisms. Redirect intercepts TCP connections via `iptables REDIRECT`, while TProxy intercepts both TCP and UDP via `iptables TPROXY`. Both extract the original destination address from kernel data structures.

**Source**: `protocol/redirect/redirect.go`, `protocol/redirect/tproxy.go`, `common/redir/`

## Redirect Inbound

### Architecture

```go
type Redirect struct {
    inbound.Adapter
    router   adapter.Router
    logger   log.ContextLogger
    listener *listener.Listener
}
```

### TCP-Only

Redirect only supports TCP (the kernel redirects TCP connections to the local listener):

```go
redirect.listener = listener.New(listener.Options{
    Network:           []string{N.NetworkTCP},
    ConnectionHandler: redirect,
})
```

### Original Destination Extraction

The key operation is retrieving the original destination from the redirected socket using `SO_ORIGINAL_DST`:

```go
func (h *Redirect) NewConnectionEx(ctx, conn, metadata, onClose) {
    destination, err := redir.GetOriginalDestination(conn)
    if err != nil {
        conn.Close()
        h.logger.ErrorContext(ctx, "get redirect destination: ", err)
        return
    }
    metadata.Inbound = h.Tag()
    metadata.InboundType = h.Type()
    metadata.Destination = M.SocksaddrFromNetIP(destination)
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

The `redir.GetOriginalDestination` function calls `getsockopt(fd, SOL_IP, SO_ORIGINAL_DST)` (or `IP6T_SO_ORIGINAL_DST` for IPv6) to retrieve the original destination address that was rewritten by iptables.

### Required iptables Rule

```bash
iptables -t nat -A PREROUTING -p tcp --dport 1:65535 -j REDIRECT --to-ports <listen_port>
```

## TProxy Inbound

### Architecture

```go
type TProxy struct {
    inbound.Adapter
    ctx      context.Context
    router   adapter.Router
    logger   log.ContextLogger
    listener *listener.Listener
    udpNat   *udpnat.Service
}
```

### TCP + UDP Support

TProxy supports both TCP and UDP:

```go
tproxy.listener = listener.New(listener.Options{
    Network:           options.Network.Build(),
    ConnectionHandler: tproxy,
    OOBPacketHandler:  tproxy,   // UDP with OOB data
    TProxy:            true,
})
```

The `TProxy: true` flag tells the listener to set the `IP_TRANSPARENT` socket option.

### TCP Handling

For TCP, the original destination is the socket's local address (TProxy preserves it):

```go
func (t *TProxy) NewConnectionEx(ctx, conn, metadata, onClose) {
    metadata.Inbound = t.Tag()
    metadata.InboundType = t.Type()
    metadata.Destination = M.SocksaddrFromNet(conn.LocalAddr()).Unwrap()
    t.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### UDP Handling with OOB

UDP packets arrive with out-of-band (OOB) data containing the original destination. The `OOBPacketHandler` interface processes these:

```go
func (t *TProxy) NewPacketEx(buffer *buf.Buffer, oob []byte, source M.Socksaddr) {
    destination, err := redir.GetOriginalDestinationFromOOB(oob)
    if err != nil {
        t.logger.Warn("get tproxy destination: ", err)
        return
    }
    t.udpNat.NewPacket([][]byte{buffer.Bytes()}, source, M.SocksaddrFromNetIP(destination), nil)
}
```

The `redir.GetOriginalDestinationFromOOB` function parses the `IP_RECVORIGDSTADDR` ancillary message from the OOB data to extract the original destination.

### UDP NAT

TProxy uses `udpnat.Service` for UDP session tracking:

```go
tproxy.udpNat = udpnat.New(tproxy, tproxy.preparePacketConnection, udpTimeout, false)
```

When a new UDP session is established, a packet writer is created that can send responses back:

```go
func (t *TProxy) preparePacketConnection(source, destination, userData) (bool, context.Context, N.PacketWriter, N.CloseHandlerFunc) {
    writer := &tproxyPacketWriter{
        listener:    t.listener,
        source:      source.AddrPort(),
        destination: destination,
    }
    return true, ctx, writer, func(it error) {
        common.Close(common.PtrOrNil(writer.conn))
    }
}
```

### TProxy UDP Write-Back

The TProxy packet writer must send UDP responses with a spoofed source address (the original destination). This requires `IP_TRANSPARENT` and `SO_REUSEADDR`:

```go
func (w *tproxyPacketWriter) WritePacket(buffer *buf.Buffer, destination M.Socksaddr) error {
    // Reuse cached connection if destination matches
    if w.destination == destination && w.conn != nil {
        _, err := w.conn.WriteToUDPAddrPort(buffer.Bytes(), w.source)
        return err
    }

    // Create a new socket bound to the destination (spoofed source)
    var listenConfig net.ListenConfig
    listenConfig.Control = control.Append(listenConfig.Control, control.ReuseAddr())
    listenConfig.Control = control.Append(listenConfig.Control, redir.TProxyWriteBack())
    packetConn, _ := w.listener.ListenPacket(listenConfig, w.ctx, "udp", destination.String())
    udpConn := packetConn.(*net.UDPConn)
    udpConn.WriteToUDPAddrPort(buffer.Bytes(), w.source)
}
```

The `redir.TProxyWriteBack()` control function sets `IP_TRANSPARENT` on the response socket, allowing it to bind to a non-local address (the original destination) so the response appears to come from the correct source.

### Required iptables Rules

```bash
# TCP
iptables -t mangle -A PREROUTING -p tcp --dport 1:65535 -j TPROXY \
    --on-port <listen_port> --tproxy-mark 0x1/0x1

# UDP
iptables -t mangle -A PREROUTING -p udp --dport 1:65535 -j TPROXY \
    --on-port <listen_port> --tproxy-mark 0x1/0x1

# Route marked packets to loopback
ip rule add fwmark 0x1/0x1 lookup 100
ip route add local default dev lo table 100
```

## Configuration Examples

### Redirect

```json
{
  "type": "redirect",
  "tag": "redirect-in",
  "listen": "::",
  "listen_port": 12345
}
```

### TProxy

```json
{
  "type": "tproxy",
  "tag": "tproxy-in",
  "listen": "::",
  "listen_port": 12345,
  "network": ["tcp", "udp"],
  "udp_timeout": "5m"
}
```

## Platform Limitations

Both redirect and TProxy are **Linux-only**. The `redir` package contains platform-specific implementations:

- `redir.GetOriginalDestination(conn)` -- uses `getsockopt(SO_ORIGINAL_DST)`, Linux-only
- `redir.GetOriginalDestinationFromOOB(oob)` -- parses `IP_RECVORIGDSTADDR` ancillary data, Linux-only
- `redir.TProxyWriteBack()` -- sets `IP_TRANSPARENT`, Linux-only

On non-Linux platforms, these protocols are not available. Use TUN inbound instead for transparent proxying.
