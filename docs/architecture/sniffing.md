# Sniffing

Protocol sniffing detects the application-layer protocol by inspecting the first bytes of a connection. This enables domain-based routing even when the client connects by IP.

**Source**: `common/sniff/`, `route/route.go`

## Sniffing Architecture

Sniffing happens as a rule action, not as a fixed pipeline step:

```json
{
  "route": {
    "rules": [
      {
        "action": "sniff",
        "timeout": "300ms"
      },
      {
        "protocol": "tls",
        "domain_suffix": [".example.com"],
        "action": "route",
        "outbound": "proxy"
      }
    ]
  }
}
```

This means you can sniff conditionally (only for certain inbounds, ports, etc.) and use the results in subsequent rules.

## Stream Sniffers (TCP)

```go
type StreamSniffer = func(ctx context.Context, metadata *adapter.InboundContext, reader io.Reader) error
```

### Available Sniffers

| Sniffer | Protocol | Detection |
|---------|----------|-----------|
| `TLSClientHello` | `tls` | TLS record type 0x16, handshake type 0x01, SNI extension |
| `HTTPHost` | `http` | HTTP method + Host header |
| `StreamDomainNameQuery` | `dns` | DNS query over TCP |
| `BitTorrent` | `bittorrent` | BitTorrent handshake magic |
| `SSH` | `ssh` | "SSH-" prefix |
| `RDP` | `rdp` | RDP TPKT header |

### TLS Sniffing

```go
func TLSClientHello(ctx context.Context, metadata *adapter.InboundContext, reader io.Reader) error {
    // Parse TLS record header
    // Parse ClientHello handshake message
    // Extract SNI from extensions
    // Extract ALPN from extensions
    // Set metadata.Protocol = "tls"
    // Set metadata.Domain = SNI
    // Set metadata.Client (JA3 fingerprint category)
    // Set metadata.SniffContext = &TLSContext{ALPN, ClientHello}
}
```

The TLS sniffer also stores the full ClientHello in `SniffContext` for JA3 fingerprinting and later use by the REALITY server.

### HTTP Sniffing

```go
func HTTPHost(ctx context.Context, metadata *adapter.InboundContext, reader io.Reader) error {
    // Check for HTTP method (GET, POST, etc.)
    // Parse headers to find Host
    // Set metadata.Protocol = "http"
    // Set metadata.Domain = Host header value
}
```

## Packet Sniffers (UDP)

```go
type PacketSniffer = func(ctx context.Context, metadata *adapter.InboundContext, packet []byte) error
```

### Available Sniffers

| Sniffer | Protocol | Detection |
|---------|----------|-----------|
| `QUICClientHello` | `quic` | QUIC Initial packet + TLS ClientHello |
| `DomainNameQuery` | `dns` | DNS query packet |
| `STUNMessage` | `stun` | STUN message magic |
| `UTP` | `bittorrent` | uTP (micro Transport Protocol) |
| `UDPTracker` | `bittorrent` | BitTorrent UDP tracker |
| `DTLSRecord` | `dtls` | DTLS record header |
| `NTP` | `ntp` | NTP packet format |

### QUIC Sniffing

QUIC sniffing is the most complex — it must:
1. Parse the QUIC Initial packet header
2. Decrypt the QUIC header protection
3. Decrypt the QUIC payload (using the Initial secret derived from the connection ID)
4. Find the CRYPTO frame containing the TLS ClientHello
5. Parse the ClientHello for SNI

QUIC ClientHellos can span multiple packets, so the sniffer returns `sniff.ErrNeedMoreData` and the router will read additional packets.

## PeekStream

```go
func PeekStream(
    ctx context.Context,
    metadata *adapter.InboundContext,
    conn net.Conn,
    existingBuffers []*buf.Buffer,
    buffer *buf.Buffer,
    timeout time.Duration,
    sniffers ...StreamSniffer,
) error {
    // If there's cached data, try sniffing it first
    if len(existingBuffers) > 0 {
        reader := io.MultiReader(buffers..., buffer)
        for _, sniffer := range sniffers {
            err := sniffer(ctx, metadata, reader)
            if err == nil { return nil }
        }
    }

    // Read new data with timeout
    conn.SetReadDeadline(time.Now().Add(timeout))
    _, err := buffer.ReadOnceFrom(conn)
    conn.SetReadDeadline(time.Time{})

    // Try each sniffer
    reader := io.MultiReader(buffers..., buffer)
    for _, sniffer := range sniffers {
        err := sniffer(ctx, metadata, reader)
        if err == nil { return nil }
    }
    return ErrClientHelloNotFound
}
```

The sniffed data is buffered and prepended to the connection before forwarding to the outbound (via `bufio.NewCachedConn`).

## PeekPacket

```go
func PeekPacket(
    ctx context.Context,
    metadata *adapter.InboundContext,
    packet []byte,
    sniffers ...PacketSniffer,
) error {
    for _, sniffer := range sniffers {
        err := sniffer(ctx, metadata, packet)
        if err == nil { return nil }
    }
    return ErrClientHelloNotFound
}
```

For packets, there's no need to buffer — the packet is read in full and passed to sniffers.

## Skip Logic

Certain ports are skipped because they use server-first protocols (the server sends data before the client):

```go
func Skip(metadata *adapter.InboundContext) bool {
    // Skip server-first protocols on well-known ports
    switch metadata.Destination.Port {
    case 25, 110, 143, 465, 587, 993, 995: // SMTP, POP3, IMAP
        return true
    }
    return false
}
```

## Sniff Result Flow

After sniffing, the metadata is enriched:

```go
metadata.Protocol = "tls"          // detected protocol
metadata.Domain = "example.com"    // extracted domain
metadata.Client = "chrome"         // TLS client fingerprint
```

If `OverrideDestination` is set in the sniff action, the destination is also updated:

```go
if action.OverrideDestination && M.IsDomainName(metadata.Domain) {
    metadata.Destination = M.Socksaddr{
        Fqdn: metadata.Domain,
        Port: metadata.Destination.Port,
    }
}
```

This allows subsequent rules to match on the sniffed domain, and the outbound will connect to the domain (not the IP).
