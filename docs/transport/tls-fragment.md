# TLS ClientHello Fragmentation

Source: `common/tlsfragment/index.go`, `common/tlsfragment/conn.go`, `common/tlsfragment/wait_linux.go`, `common/tlsfragment/wait_darwin.go`, `common/tlsfragment/wait_windows.go`, `common/tlsfragment/wait_stub.go`

## Overview

TLS fragment splits the TLS ClientHello message at SNI (Server Name Indication) domain label boundaries. This technique is used to circumvent DPI (Deep Packet Inspection) that reads the SNI to identify the target domain. By splitting the SNI across multiple TCP segments or TLS records, simple DPI systems fail to reassemble and match the domain.

## Two Fragmentation Modes

### splitPacket Mode

Splits the ClientHello into multiple TCP segments at SNI domain label boundaries. Each segment is sent as a separate TCP packet with `TCP_NODELAY` enabled, and the sender waits for the ACK of each segment before sending the next.

### splitRecord Mode

Re-wraps each fragment as a separate TLS record by prepending the original TLS record layer header (content type + version) with a new length field. This creates multiple valid TLS records from a single ClientHello.

Both modes can be combined: `splitRecord` creates separate TLS records, and `splitPacket` sends each record as an individual TCP segment with ACK waiting.

## SNI Extraction

The `IndexTLSServerName` function parses a raw TLS ClientHello to locate the SNI extension:

```go
func IndexTLSServerName(payload []byte) *MyServerName {
    if len(payload) < recordLayerHeaderLen || payload[0] != contentType {
        return nil  // Not a TLS handshake
    }
    segmentLen := binary.BigEndian.Uint16(payload[3:5])
    serverName := indexTLSServerNameFromHandshake(payload[recordLayerHeaderLen:])
    serverName.Index += recordLayerHeaderLen
    return serverName
}
```

The parser walks through:
1. TLS record layer header (5 bytes)
2. Handshake header (6 bytes) -- validates handshake type 1 (ClientHello)
3. Random data (32 bytes)
4. Session ID (variable length)
5. Cipher suites (variable length)
6. Compression methods (variable length)
7. Extensions -- scans for SNI extension (type 0x0000)

Returns `MyServerName` with the byte offset, length, and string value of the SNI.

## Fragment Connection

```go
type Conn struct {
    net.Conn
    tcpConn            *net.TCPConn
    ctx                context.Context
    firstPacketWritten bool
    splitPacket        bool
    splitRecord        bool
    fallbackDelay      time.Duration
}
```

The `Conn` intercepts only the first `Write` call (the ClientHello). Subsequent writes pass through directly.

### Split Algorithm

```go
func (c *Conn) Write(b []byte) (n int, err error) {
    if !c.firstPacketWritten {
        defer func() { c.firstPacketWritten = true }()
        serverName := IndexTLSServerName(b)
        if serverName != nil {
            // 1. Enable TCP_NODELAY for splitPacket mode
            // 2. Parse domain labels, skip public suffix
            splits := strings.Split(serverName.ServerName, ".")
            if publicSuffix := publicsuffix.List.PublicSuffix(serverName.ServerName); publicSuffix != "" {
                splits = splits[:len(splits)-strings.Count(serverName.ServerName, ".")]
            }
            // 3. Random split point within each label
            for i, split := range splits {
                splitAt := rand.Intn(len(split))
                splitIndexes = append(splitIndexes, currentIndex+splitAt)
            }
            // 4. Send fragments
            for i := 0; i <= len(splitIndexes); i++ {
                // Extract payload slice
                if c.splitRecord {
                    // Re-wrap with TLS record header
                    buffer.Write(b[:3])              // Content type + version
                    binary.Write(&buffer, binary.BigEndian, payloadLen)
                    buffer.Write(payload)
                }
                if c.splitPacket {
                    writeAndWaitAck(c.ctx, c.tcpConn, payload, c.fallbackDelay)
                }
            }
            // 5. Restore TCP_NODELAY to false
            return len(b), nil
        }
    }
    return c.Conn.Write(b)
}
```

### Public Suffix Handling

Domain labels belonging to the public suffix (e.g., `.co.uk`, `.com.cn`) are excluded from splitting using `golang.org/x/net/publicsuffix`. This ensures splits only occur within the meaningful parts of the domain name.

### Leading Wildcard Handling

If a domain starts with `...` (e.g., `...subdomain.example.com`), the leading `...` label is skipped and the index is adjusted forward.

## Platform-Specific ACK Waiting

The `writeAndWaitAck` function ensures each TCP segment is acknowledged before sending the next. This is implemented differently per platform:

### Linux (`wait_linux.go`)

Uses `TCP_INFO` socket option to check the `Unacked` field:

```go
func waitAck(ctx context.Context, conn *net.TCPConn, fallbackDelay time.Duration) error {
    rawConn.Control(func(fd uintptr) {
        for {
            var info unix.TCPInfo
            infoBytes, _ := unix.GetsockoptTCPInfo(int(fd), unix.SOL_TCP, unix.TCP_INFO)
            if infoBytes.Unacked == 0 {
                return  // All segments acknowledged
            }
            time.Sleep(time.Millisecond)
        }
    })
}
```

### Darwin (`wait_darwin.go`)

Uses `SO_NWRITE` socket option to check unsent bytes:

```go
func waitAck(ctx context.Context, conn *net.TCPConn, fallbackDelay time.Duration) error {
    rawConn.Control(func(fd uintptr) {
        for {
            nwrite, _ := unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_NWRITE)
            if nwrite == 0 {
                return  // All data sent and acknowledged
            }
            time.Sleep(time.Millisecond)
        }
    })
}
```

### Windows (`wait_windows.go`)

Uses `winiphlpapi.WriteAndWaitAck` (a custom Windows API wrapper).

### Fallback (`wait_stub.go`)

On unsupported platforms, falls back to `time.Sleep(fallbackDelay)`:

```go
func writeAndWaitAck(ctx context.Context, conn *net.TCPConn, b []byte, fallbackDelay time.Duration) error {
    _, err := conn.Write(b)
    if err != nil { return err }
    time.Sleep(fallbackDelay)
    return nil
}
```

The default fallback delay is `C.TLSFragmentFallbackDelay`.

## Connection Replaceability

```go
func (c *Conn) ReaderReplaceable() bool {
    return true  // Reader can always be replaced (no read interception)
}

func (c *Conn) WriterReplaceable() bool {
    return c.firstPacketWritten  // Writer replaceable after first write
}
```

After the first packet is written, the `Conn` becomes transparent and its writer can be optimized away by the buffer pipeline.

## Configuration

TLS fragment is configured as part of the TLS options:

```json
{
  "tls": {
    "enabled": true,
    "fragment": true,
    "record_fragment": true,
    "fragment_fallback_delay": "20ms"
  }
}
```

| Field | Description |
|-------|-------------|
| `fragment` | Enable TCP packet splitting (`splitPacket` mode) |
| `record_fragment` | Enable TLS record splitting (`splitRecord` mode) |
| `fragment_fallback_delay` | Fallback delay on platforms without ACK detection |
