# Connection Manager

The ConnectionManager handles the actual data transfer between inbound and outbound connections. It dials the remote, sets up bidirectional copy, and manages connection lifecycle.

**Source**: `route/conn.go`

## Structure

```go
type ConnectionManager struct {
    logger      logger.ContextLogger
    access      sync.Mutex
    connections list.List[io.Closer]  // tracked active connections
}
```

## TCP Connection Flow (`NewConnection`)

```go
func (m *ConnectionManager) NewConnection(ctx, this N.Dialer, conn net.Conn, metadata, onClose) {
    // 1. Dial remote
    if len(metadata.DestinationAddresses) > 0 || metadata.Destination.IsIP() {
        remoteConn, err = dialer.DialSerialNetwork(ctx, this, "tcp",
            metadata.Destination, metadata.DestinationAddresses,
            metadata.NetworkStrategy, metadata.NetworkType,
            metadata.FallbackNetworkType, metadata.FallbackDelay)
    } else {
        remoteConn, err = this.DialContext(ctx, "tcp", metadata.Destination)
    }

    // 2. Report handshake success (for protocols that need it)
    N.ReportConnHandshakeSuccess(conn, remoteConn)

    // 3. Apply TLS fragmentation if requested
    if metadata.TLSFragment || metadata.TLSRecordFragment {
        remoteConn = tf.NewConn(remoteConn, ctx, ...)
    }

    // 4. Kick handshake (send early data)
    m.kickWriteHandshake(ctx, conn, remoteConn, false, &done, onClose)
    m.kickWriteHandshake(ctx, remoteConn, conn, true, &done, onClose)

    // 5. Bidirectional copy
    go m.connectionCopy(ctx, conn, remoteConn, false, &done, onClose)
    go m.connectionCopy(ctx, remoteConn, conn, true, &done, onClose)
}
```

### Handshake Kick

Some protocols (e.g., proxy protocols with delayed handshake) need the first data to be written before the connection is fully established. `kickWriteHandshake` handles this:

```go
func (m *ConnectionManager) kickWriteHandshake(ctx, source, destination, direction, done, onClose) bool {
    if !N.NeedHandshakeForWrite(destination) {
        return false  // no handshake needed
    }

    // Try to read cached data from source
    if cachedReader, ok := sourceReader.(N.CachedReader); ok {
        cachedBuffer = cachedReader.ReadCached()
    }

    if cachedBuffer != nil {
        // Write cached data to trigger handshake
        _, err = destinationWriter.Write(cachedBuffer.Bytes())
    } else {
        // Write empty to trigger handshake
        destination.SetWriteDeadline(time.Now().Add(C.ReadPayloadTimeout))
        _, err = destinationWriter.Write(nil)
    }
    // ...
}
```

This allows early data (like TLS ClientHello) to be sent with the proxy protocol handshake, reducing round trips.

### Bidirectional Copy

```go
func (m *ConnectionManager) connectionCopy(ctx, source, destination, direction, done, onClose) {
    _, err := bufio.CopyWithIncreateBuffer(destination, source,
        bufio.DefaultIncreaseBufferAfter, bufio.DefaultBatchSize)

    if err != nil {
        common.Close(source, destination)
    } else if duplexDst, isDuplex := destination.(N.WriteCloser); isDuplex {
        duplexDst.CloseWrite()  // half-close for graceful shutdown
    } else {
        destination.Close()
    }

    // done is atomic — first goroutine to finish sets it
    if done.Swap(true) {
        // Second goroutine: call onClose and close both
        if onClose != nil { onClose(err) }
        common.Close(source, destination)
    }
}
```

Key behaviors:
- Uses `bufio.CopyWithIncreateBuffer` for adaptive buffer sizing
- Supports half-close (FIN) via `N.WriteCloser`
- `atomic.Bool` ensures `onClose` is called exactly once
- Logs upload/download direction separately

## UDP Connection Flow (`NewPacketConnection`)

```go
func (m *ConnectionManager) NewPacketConnection(ctx, this, conn, metadata, onClose) {
    if metadata.UDPConnect {
        // Connected UDP: dial to specific destination
        remoteConn, err = this.DialContext(ctx, "udp", metadata.Destination)
        remotePacketConn = bufio.NewUnbindPacketConn(remoteConn)
    } else {
        // Unconnected UDP: listen for packets
        remotePacketConn, destinationAddress, err = this.ListenPacket(ctx, metadata.Destination)
    }

    // NAT handling: translate addresses if resolved IP differs from domain
    if destinationAddress.IsValid() {
        remotePacketConn = bufio.NewNATPacketConn(remotePacketConn, destination, originDestination)
    }

    // UDP timeout (protocol-aware)
    if udpTimeout > 0 {
        ctx, conn = canceler.NewPacketConn(ctx, conn, udpTimeout)
    }

    // Bidirectional packet copy
    go m.packetConnectionCopy(ctx, conn, destination, false, &done, onClose)
    go m.packetConnectionCopy(ctx, destination, conn, true, &done, onClose)
}
```

### UDP Timeout

The UDP timeout is determined in priority order:
1. `metadata.UDPTimeout` (set by rule action)
2. `C.ProtocolTimeouts[protocol]` (protocol-specific, e.g., DNS = 10s)
3. Default timeout

### NAT PacketConn

When DNS resolves a domain to an IP, the remote socket uses the IP. But the client expects responses from the original domain. `bufio.NewNATPacketConn` translates addresses:

```
Client → conn.ReadPacket() → {dest: example.com:443}
         ↓ NAT translate
Remote → remoteConn.WritePacket() → {dest: 1.2.3.4:443}
         ↓ response
Remote → remoteConn.ReadPacket() → {from: 1.2.3.4:443}
         ↓ NAT translate back
Client → conn.WritePacket() → {from: example.com:443}
```

## Connection Tracking

The ConnectionManager tracks all active connections for monitoring and cleanup:

```go
func (m *ConnectionManager) TrackConn(conn net.Conn) net.Conn {
    element := m.connections.PushBack(conn)
    return &trackedConn{Conn: conn, manager: m, element: element}
}

// trackedConn removes itself from the list on Close()
func (c *trackedConn) Close() error {
    c.manager.connections.Remove(c.element)
    return c.Conn.Close()
}
```

`CloseAll()` is called during shutdown to terminate all active connections.

## Serial Dialing

When multiple destination addresses are available (from DNS resolution), `dialer.DialSerialNetwork` tries them in order:

```go
// Tries each address, respecting network strategy (prefer cellular, etc.)
func DialSerialNetwork(ctx, dialer, network, destination, addresses,
    strategy, networkType, fallbackType, fallbackDelay) (net.Conn, error)
```

This integrates with the network strategy system for multi-interface devices (mobile).
