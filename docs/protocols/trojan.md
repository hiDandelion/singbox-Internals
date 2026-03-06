# Trojan Protocol

Trojan is a proxy protocol designed to mimic HTTPS traffic. It uses a password-based authentication scheme with SHA-224 hashing and supports fallback to a real web server for unrecognized traffic.

**Source**: `protocol/trojan/`, `transport/trojan/`

## Wire Format

The Trojan protocol uses a simple, TLS-friendly wire format:

```
+----------+------+---------+----------+------+----------+
| Password | CRLF | Command | Address  | CRLF | Payload  |
| (56 hex) | \r\n | (1 byte)| (variable)|\r\n | (variable)|
+----------+------+---------+----------+------+----------+
```

### Password Derivation

The password is converted to a 56-byte hex-encoded SHA-224 hash:

```go
const KeyLength = 56

func Key(password string) [KeyLength]byte {
    var key [KeyLength]byte
    hash := sha256.New224()                    // SHA-224, NOT SHA-256
    hash.Write([]byte(password))
    hex.Encode(key[:], hash.Sum(nil))          // 28 bytes -> 56 hex chars
    return key
}
```

SHA-224 produces 28 bytes (224 bits), which hex-encodes to exactly 56 characters. This is transmitted as-is (not base64) in the handshake.

### Commands

```go
const (
    CommandTCP = 1     // TCP connect
    CommandUDP = 3     // UDP associate
    CommandMux = 0x7f  // Trojan-Go multiplexing
)
```

### TCP Handshake

```
Client -> Server:
  [56 bytes: hex SHA224(password)]
  [2 bytes: \r\n]
  [1 byte: 0x01 (TCP)]
  [variable: SOCKS address (type + addr + port)]
  [2 bytes: \r\n]
  [payload data...]
```

The implementation uses buffer coalescing for efficiency:

```go
func ClientHandshake(conn net.Conn, key [KeyLength]byte, destination M.Socksaddr, payload []byte) error {
    headerLen := KeyLength + M.SocksaddrSerializer.AddrPortLen(destination) + 5
    header := buf.NewSize(headerLen + len(payload))
    header.Write(key[:])           // 56 bytes password hash
    header.Write(CRLF)            // \r\n
    header.WriteByte(CommandTCP)  // 0x01
    M.SocksaddrSerializer.WriteAddrPort(header, destination)
    header.Write(CRLF)            // \r\n
    header.Write(payload)         // coalesced first payload
    conn.Write(header.Bytes())    // single write syscall
}
```

### UDP Packet Format

After the initial handshake (which uses `CommandUDP`), UDP packets are framed as:

```
+----------+--------+------+----------+
| Address  | Length | CRLF | Payload  |
| (variable)| (2 BE) | \r\n | (Length) |
+----------+--------+------+----------+
```

```go
func WritePacket(conn net.Conn, buffer *buf.Buffer, destination M.Socksaddr) error {
    header := buf.With(buffer.ExtendHeader(...))
    M.SocksaddrSerializer.WriteAddrPort(header, destination)
    binary.Write(header, binary.BigEndian, uint16(bufferLen))
    header.Write(CRLF)
    conn.Write(buffer.Bytes())
}

func ReadPacket(conn net.Conn, buffer *buf.Buffer) (M.Socksaddr, error) {
    destination := M.SocksaddrSerializer.ReadAddrPort(conn)
    var length uint16
    binary.Read(conn, binary.BigEndian, &length)
    rw.SkipN(conn, 2)  // skip CRLF
    buffer.ReadFullFrom(conn, int(length))
    return destination, nil
}
```

### UDP Initial Handshake

The first UDP packet includes both the Trojan header AND the first packet's address/length:

```
[56 bytes key][CRLF][0x03 UDP][dest addr][CRLF][dest addr][length][CRLF][payload]
                                  ^handshake^    ^first packet^
```

Note the destination address appears twice: once in the handshake, once in the packet frame.

## Trojan Service Layer

The `transport/trojan/service.go` implements the server-side protocol handler:

```go
type Service[K comparable] struct {
    users           map[K][56]byte       // user -> key
    keys            map[[56]byte]K       // key -> user (reverse lookup)
    handler         Handler              // TCP + UDP handler
    fallbackHandler N.TCPConnectionHandlerEx
    logger          logger.ContextLogger
}
```

### Server-Side Connection Processing

```go
func (s *Service[K]) NewConnection(ctx, conn, source, onClose) error {
    // 1. Read the 56-byte password key
    var key [KeyLength]byte
    n, err := conn.Read(key[:])
    if n != KeyLength {
        return s.fallback(ctx, conn, source, key[:n], ...)
    }

    // 2. Authenticate
    if user, loaded := s.keys[key]; loaded {
        ctx = auth.ContextWithUser(ctx, user)
    } else {
        return s.fallback(ctx, conn, source, key[:], ...)
    }

    // 3. Skip CRLF, read command
    rw.SkipN(conn, 2)
    binary.Read(conn, binary.BigEndian, &command)

    // 4. Read destination address, skip trailing CRLF
    destination := M.SocksaddrSerializer.ReadAddrPort(conn)
    rw.SkipN(conn, 2)

    // 5. Dispatch based on command
    switch command {
    case CommandTCP:
        s.handler.NewConnectionEx(ctx, conn, source, destination, onClose)
    case CommandUDP:
        s.handler.NewPacketConnectionEx(ctx, &PacketConn{Conn: conn}, ...)
    default:  // CommandMux (0x7f)
        HandleMuxConnection(ctx, conn, source, s.handler, s.logger, onClose)
    }
}
```

### Fallback Mechanism

When authentication fails, the service supports fallback to a real web server:

```go
func (s *Service[K]) fallback(ctx, conn, source, header, err, onClose) error {
    if s.fallbackHandler == nil {
        return E.Extend(err, "fallback disabled")
    }
    // Prepend already-read bytes back to the connection
    conn = bufio.NewCachedConn(conn, buf.As(header).ToOwned())
    s.fallbackHandler.NewConnectionEx(ctx, conn, source, M.Socksaddr{}, onClose)
    return nil
}
```

This is critical for censorship resistance: if a probe sends non-Trojan data, it gets forwarded to a real web server, making the service indistinguishable from a normal HTTPS site.

## Mux Support (Trojan-Go)

The mux implementation uses `smux` (Simple Multiplexer) for Trojan-Go compatibility:

```go
func HandleMuxConnection(ctx, conn, source, handler, logger, onClose) error {
    session, _ := smux.Server(conn, smuxConfig())
    for {
        stream, _ := session.AcceptStream()
        go newMuxConnection(ctx, stream, source, handler, logger)
    }
}
```

Each mux stream contains its own command byte and destination:

```go
func newMuxConnection0(ctx, conn, source, handler) error {
    reader := bufio.NewReader(conn)
    command, _ := reader.ReadByte()
    destination, _ := M.SocksaddrSerializer.ReadAddrPort(reader)
    switch command {
    case CommandTCP:
        handler.NewConnectionEx(ctx, conn, source, destination, nil)
    case CommandUDP:
        handler.NewPacketConnectionEx(ctx, &PacketConn{Conn: conn}, ...)
    }
}
```

The smux config disables keepalive:

```go
func smuxConfig() *smux.Config {
    config := smux.DefaultConfig()
    config.KeepAliveDisabled = true
    return config
}
```

## Inbound Implementation

```go
type Inbound struct {
    inbound.Adapter
    router                   adapter.ConnectionRouterEx
    logger                   log.ContextLogger
    listener                 *listener.Listener
    service                  *trojan.Service[int]
    users                    []option.TrojanUser
    tlsConfig                tls.ServerConfig
    fallbackAddr             M.Socksaddr
    fallbackAddrTLSNextProto map[string]M.Socksaddr  // ALPN-based fallback
    transport                adapter.V2RayServerTransport
}
```

### ALPN-Based Fallback

Trojan supports per-ALPN fallback destinations, allowing different fallback targets based on the TLS negotiated protocol:

```go
func (h *Inbound) fallbackConnection(ctx, conn, metadata, onClose) {
    if len(h.fallbackAddrTLSNextProto) > 0 {
        if tlsConn, loaded := common.Cast[tls.Conn](conn); loaded {
            negotiatedProtocol := tlsConn.ConnectionState().NegotiatedProtocol
            fallbackAddr = h.fallbackAddrTLSNextProto[negotiatedProtocol]
        }
    }
    if !fallbackAddr.IsValid() {
        fallbackAddr = h.fallbackAddr  // default fallback
    }
    metadata.Destination = fallbackAddr
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### kTLS Compatibility

The inbound enables kTLS (kernel TLS) when conditions are met:

```go
tlsConfig, _ := tls.NewServerWithOptions(tls.ServerOptions{
    KTLSCompatible: transport.Type == "" && !multiplex.Enabled,
    // kTLS only when: no V2Ray transport AND no multiplexing
})
```

## Outbound Implementation

```go
type Outbound struct {
    outbound.Adapter
    key             [56]byte              // pre-computed SHA224 key
    multiplexDialer *mux.Client
    tlsConfig       tls.Config
    tlsDialer       tls.Dialer
    transport       adapter.V2RayClientTransport
}
```

The key is computed once at construction:

```go
outbound.key = trojan.Key(options.Password)
```

### Connection Flow

```go
func (h *trojanDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    // 1. Establish connection: transport > TLS > raw TCP
    var conn net.Conn
    if h.transport != nil {
        conn = h.transport.DialContext(ctx)
    } else if h.tlsDialer != nil {
        conn = h.tlsDialer.DialTLSContext(ctx, h.serverAddr)
    } else {
        conn = h.dialer.DialContext(ctx, "tcp", h.serverAddr)
    }

    // 2. Wrap with Trojan protocol
    switch network {
    case "tcp":
        return trojan.NewClientConn(conn, h.key, destination)
    case "udp":
        return bufio.NewBindPacketConn(
            trojan.NewClientPacketConn(conn, h.key), destination)
    }
}
```

### Early Data (Lazy Write)

`ClientConn` implements `N.EarlyWriter`, meaning the Trojan header is only sent on the first `Write()` call, coalesced with the first payload:

```go
func (c *ClientConn) Write(p []byte) (n int, err error) {
    if c.headerWritten {
        return c.ExtendedConn.Write(p)
    }
    err = ClientHandshake(c.ExtendedConn, c.key, c.destination, p)
    c.headerWritten = true
    n = len(p)
    return
}
```

## Configuration Example

```json
{
  "type": "trojan",
  "tag": "trojan-in",
  "listen": "::",
  "listen_port": 443,
  "users": [
    { "name": "user1", "password": "my-secret-password" }
  ],
  "tls": {
    "enabled": true,
    "server_name": "example.com",
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  },
  "fallback": {
    "server": "127.0.0.1",
    "server_port": 8080
  },
  "fallback_for_alpn": {
    "h2": {
      "server": "127.0.0.1",
      "server_port": 8081
    }
  }
}
```
