# NaiveProxy Protocol

NaiveProxy disguises proxy traffic as normal HTTP/2 or HTTP/3 traffic using the CONNECT method. The inbound implements a NaiveProxy-compatible server with padding support, while the outbound uses the Cronet (Chromium network stack) library to mimic a real Chrome client.

**Source**: `protocol/naive/inbound.go`, `protocol/naive/inbound_conn.go`, `protocol/naive/outbound.go`, `protocol/naive/quic/`

## Inbound Architecture

```go
type Inbound struct {
    inbound.Adapter
    ctx              context.Context
    router           adapter.ConnectionRouterEx
    logger           logger.ContextLogger
    listener         *listener.Listener
    network          []string
    networkIsDefault bool
    authenticator    *auth.Authenticator
    tlsConfig        tls.ServerConfig
    httpServer       *http.Server
    h3Server         io.Closer
}
```

### Dual Transport: HTTP/2 + HTTP/3

NaiveProxy supports both HTTP/2 (TCP) and HTTP/3 (QUIC). The network defaults to TCP, with optional UDP for HTTP/3:

```go
if common.Contains(inbound.network, N.NetworkUDP) {
    if options.TLS == nil || !options.TLS.Enabled {
        return nil, E.New("TLS is required for QUIC server")
    }
}
```

### HTTP/2 Server (TCP)

The TCP listener serves HTTP/2 via h2c (HTTP/2 cleartext) with optional TLS:

```go
n.httpServer = &http.Server{
    Handler: h2c.NewHandler(n, &http2.Server{}),
}

go func() {
    listener := net.Listener(tcpListener)
    if n.tlsConfig != nil {
        // Ensure HTTP/2 ALPN is present
        if !common.Contains(n.tlsConfig.NextProtos(), http2.NextProtoTLS) {
            n.tlsConfig.SetNextProtos(append([]string{http2.NextProtoTLS}, n.tlsConfig.NextProtos()...))
        }
        listener = aTLS.NewListener(tcpListener, n.tlsConfig)
    }
    n.httpServer.Serve(listener)
}()
```

### HTTP/3 Server (QUIC)

HTTP/3 is initialized via a configurable function pointer:

```go
var ConfigureHTTP3ListenerFunc func(ctx, logger, listener, handler, tlsConfig, options) (io.Closer, error)
```

This is registered externally in `protocol/naive/quic/inbound_init.go`, which uses the `sing-quic` library with configurable congestion control.

### CONNECT Request Processing

The core protocol logic is in `ServeHTTP`:

```go
func (n *Inbound) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
    // 1. Reject non-CONNECT requests
    if request.Method != "CONNECT" {
        rejectHTTP(writer, http.StatusBadRequest)
        return
    }

    // 2. Require padding header (distinguishes NaiveProxy from plain CONNECT)
    if request.Header.Get("Padding") == "" {
        rejectHTTP(writer, http.StatusBadRequest)
        return
    }

    // 3. Authenticate via Proxy-Authorization header
    userName, password, authOk := sHttp.ParseBasicAuth(request.Header.Get("Proxy-Authorization"))
    if authOk {
        authOk = n.authenticator.Verify(userName, password)
    }
    if !authOk {
        rejectHTTP(writer, http.StatusProxyAuthRequired)
        return
    }

    // 4. Send response with padding
    writer.Header().Set("Padding", generatePaddingHeader())
    writer.WriteHeader(http.StatusOK)
    writer.(http.Flusher).Flush()

    // 5. Extract destination from custom or standard headers
    hostPort := request.Header.Get("-connect-authority")
    if hostPort == "" {
        hostPort = request.URL.Host
    }

    // 6. Wrap connection with padding for first 8 frames
    // HTTP/1.1: hijack the connection
    // HTTP/2: use request.Body + response writer
}
```

### Rejection Behavior

On rejection, the connection is RST'd rather than gracefully closed, to mimic real web server behavior:

```go
func rejectHTTP(writer http.ResponseWriter, statusCode int) {
    hijacker, ok := writer.(http.Hijacker)
    if !ok {
        writer.WriteHeader(statusCode)
        return
    }
    conn, _, _ := hijacker.Hijack()
    if tcpConn, isTCP := common.Cast[*net.TCPConn](conn); isTCP {
        tcpConn.SetLinger(0)  // RST instead of FIN
    }
    conn.Close()
}
```

## Padding Protocol

The padding protocol adds random padding to the first 8 read/write operations to resist traffic fingerprinting.

### Constants and Structure

```go
const paddingCount = 8

type paddingConn struct {
    readPadding      int   // frames read with padding so far
    writePadding     int   // frames written with padding so far
    readRemaining    int   // remaining data bytes in current frame
    paddingRemaining int   // remaining padding bytes to skip
}
```

### Padding Header Format

The Padding HTTP header uses a random string of 30-62 characters from the set `!#$()+<>?@[]^`{}~`:

```go
func generatePaddingHeader() string {
    paddingLen := rand.Intn(32) + 30
    padding := make([]byte, paddingLen)
    bits := rand.Uint64()
    for i := 0; i < 16; i++ {
        padding[i] = "!#$()+<>?@[]^`{}"[bits&15]
        bits >>= 4
    }
    for i := 16; i < paddingLen; i++ {
        padding[i] = '~'
    }
    return string(padding)
}
```

### Wire Format (Padded Frame)

Each of the first 8 frames is encoded as:

```
+---------------+----------+------+---------+
| Data Length   | Pad Size | Data | Padding |
| (2 bytes BE) | (1 byte) | (var)| (var)   |
+---------------+----------+------+---------+
```

```go
func (p *paddingConn) writeWithPadding(writer io.Writer, data []byte) (n int, err error) {
    if p.writePadding < paddingCount {
        paddingSize := rand.Intn(256)
        buffer := buf.NewSize(3 + len(data) + paddingSize)
        header := buffer.Extend(3)
        binary.BigEndian.PutUint16(header, uint16(len(data)))
        header[2] = byte(paddingSize)
        buffer.Write(data)
        buffer.Extend(paddingSize)  // random padding bytes
        _, err = writer.Write(buffer.Bytes())
        p.writePadding++
        return
    }
    // After 8 frames, write directly
    return writer.Write(data)
}
```

### Reading Padded Frames

```go
func (p *paddingConn) readWithPadding(reader io.Reader, buffer []byte) (n int, err error) {
    // If we have remaining data from the current frame, read it
    if p.readRemaining > 0 { /* read remaining */ }

    // Skip any remaining padding from the previous frame
    if p.paddingRemaining > 0 {
        rw.SkipN(reader, p.paddingRemaining)
    }

    // Read next padded frame header (3 bytes)
    if p.readPadding < paddingCount {
        io.ReadFull(reader, paddingHeader[:3])
        originalDataSize := binary.BigEndian.Uint16(paddingHeader[:2])
        paddingSize := int(paddingHeader[2])
        n, _ = reader.Read(buffer[:originalDataSize])
        p.readPadding++
        p.readRemaining = originalDataSize - n
        p.paddingRemaining = paddingSize
        return
    }

    // After 8 frames, read directly
    return reader.Read(buffer)
}
```

### Connection Replaceability

After the padding phase (8 frames), the padding wrapper becomes transparent:

```go
func (p *paddingConn) readerReplaceable() bool {
    return p.readPadding == paddingCount
}

func (p *paddingConn) writerReplaceable() bool {
    return p.writePadding == paddingCount
}
```

### Two Connection Types

- **`naiveConn`**: For HTTP/1.1 hijacked connections (wraps `net.Conn`)
- **`naiveH2Conn`**: For HTTP/2 streams (wraps `io.Reader` + `io.Writer` + `http.Flusher`); must flush after each write

## Outbound Architecture (Cronet)

The outbound uses the Cronet library (Chromium's network stack) to make connections indistinguishable from real Chrome:

```go
//go:build with_naive_outbound

type Outbound struct {
    outbound.Adapter
    ctx       context.Context
    logger    logger.ContextLogger
    client    *cronet.NaiveClient
    uotClient *uot.Client
}
```

### Build Tag

The outbound requires the `with_naive_outbound` build tag.

### TLS Restrictions

Many TLS options are unsupported because Cronet manages its own TLS:

```go
if options.TLS.DisableSNI { return nil, E.New("not supported") }
if options.TLS.Insecure { return nil, E.New("not supported") }
if len(options.TLS.ALPN) > 0 { return nil, E.New("not supported") }
if options.TLS.UTLS != nil { return nil, E.New("not supported") }
if options.TLS.Reality != nil { return nil, E.New("not supported") }
// ... and many more
```

### Client Configuration

```go
client, _ := cronet.NewNaiveClient(cronet.NaiveClientOptions{
    ServerAddress:           serverAddress,
    ServerName:              serverName,
    Username:                options.Username,
    Password:                options.Password,
    InsecureConcurrency:     options.InsecureConcurrency,
    ExtraHeaders:            extraHeaders,
    TrustedRootCertificates: trustedRootCertificates,
    Dialer:                  outboundDialer,
    DNSResolver:             dnsResolver,
    ECHEnabled:              echEnabled,
    QUIC:                    options.QUIC,
    QUICCongestionControl:   quicCongestionControl,
})
```

### QUIC Congestion Control (Outbound)

The outbound supports multiple QUIC congestion control algorithms:

```go
switch options.QUICCongestionControl {
case "bbr":   quicCongestionControl = cronet.QUICCongestionControlBBR
case "bbr2":  quicCongestionControl = cronet.QUICCongestionControlBBRv2
case "cubic": quicCongestionControl = cronet.QUICCongestionControlCubic
case "reno":  quicCongestionControl = cronet.QUICCongestionControlReno
}
```

### ECH Support

The outbound supports Encrypted Client Hello:

```go
if options.TLS.ECH != nil && options.TLS.ECH.Enabled {
    echEnabled = true
    echConfigList = block.Bytes  // PEM-decoded "ECH CONFIGS"
}
```

### DNS Integration

The outbound uses the sing-box DNS router for name resolution within Cronet:

```go
dnsResolver = func(dnsContext context.Context, request *mDNS.Msg) *mDNS.Msg {
    response, _ := dnsRouter.Exchange(dnsContext, request, outboundDialer.(dialer.ResolveDialer).QueryOptions())
    return response
}
```

### UDP Support via UoT

UDP is only available through UDP-over-TCP:

```go
if uotOptions.Enabled {
    outbound.uotClient = &uot.Client{
        Dialer:  &naiveDialer{client},
        Version: uotOptions.Version,
    }
}
```

## Configuration Examples

### Inbound

```json
{
  "type": "naive",
  "tag": "naive-in",
  "listen": "::",
  "listen_port": 443,
  "users": [
    { "username": "user1", "password": "pass1" }
  ],
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  }
}
```

### Outbound

```json
{
  "type": "naive",
  "tag": "naive-out",
  "server": "example.com",
  "server_port": 443,
  "username": "user1",
  "password": "pass1",
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  },
  "udp_over_tcp": {
    "enabled": true,
    "version": 2
  }
}
```
