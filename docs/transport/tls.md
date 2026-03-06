# TLS Architecture

Source: `common/tls/config.go`, `common/tls/client.go`, `common/tls/server.go`, `common/tls/std_client.go`, `common/tls/std_server.go`, `common/tls/utls_client.go`, `common/tls/reality_client.go`, `common/tls/reality_server.go`, `common/tls/ech.go`, `common/tls/ech_shared.go`, `common/tls/acme.go`, `common/tls/mkcert.go`

## Type System

The TLS layer uses type aliases from `github.com/sagernet/sing/common/tls`:

```go
type (
    Config                 = aTLS.Config
    ConfigCompat           = aTLS.ConfigCompat
    ServerConfig           = aTLS.ServerConfig
    ServerConfigCompat     = aTLS.ServerConfigCompat
    WithSessionIDGenerator = aTLS.WithSessionIDGenerator
    Conn                   = aTLS.Conn

    STDConfig       = tls.Config
    STDConn         = tls.Conn
    ConnectionState = tls.ConnectionState
    CurveID         = tls.CurveID
)
```

The `Config` interface provides methods like `ServerName()`, `SetServerName()`, `NextProtos()`, `SetNextProtos()`, `Client(conn) (Conn, error)`, `Clone() Config`, and `STDConfig() (*STDConfig, error)`.

## Client Dispatch

```go
func NewClientWithOptions(options ClientOptions) (Config, error) {
    if options.Options.Reality != nil && options.Options.Reality.Enabled {
        return NewRealityClient(...)
    } else if options.Options.UTLS != nil && options.Options.UTLS.Enabled {
        return NewUTLSClient(...)
    }
    return NewSTDClient(...)
}
```

Three implementations, selected by priority: Reality > uTLS > stdlib.

### TLS Dialer with ECH Retry

```go
func (d *defaultDialer) dialContext(ctx context.Context, destination M.Socksaddr, echRetry bool) (Conn, error) {
    conn, err := d.dialer.DialContext(ctx, N.NetworkTCP, destination)
    tlsConn, err := aTLS.ClientHandshake(ctx, conn, d.config)
    if err != nil {
        conn.Close()
        var echErr *tls.ECHRejectionError
        if echRetry && errors.As(err, &echErr) && len(echErr.RetryConfigList) > 0 {
            if echConfig, isECH := d.config.(ECHCapableConfig); isECH {
                echConfig.SetECHConfigList(echErr.RetryConfigList)
                return d.dialContext(ctx, destination, false)  // Retry once
            }
        }
        return nil, err
    }
    return tlsConn, nil
}
```

If ECH is rejected and the server provides retry configs, the dialer automatically retries once with the updated config.

## STDClient (Go stdlib)

Comprehensive TLS configuration:

```go
func NewSTDClient(ctx context.Context, logger logger.ContextLogger,
    serverAddress string, options option.OutboundTLSOptions) (Config, error) {
    var tlsConfig tls.Config
    tlsConfig.Time = ntp.TimeFuncFromContext(ctx)   // NTP time source
    tlsConfig.RootCAs = adapter.RootPoolFromContext(ctx)  // Custom root CA pool
    // ServerName, InsecureSkipVerify, DisableSNI handling
    // Certificate pinning via SHA256 public key hash
    // ALPN, MinVersion, MaxVersion, CipherSuites, CurvePreferences
    // Custom CA certificate, client certificate authentication
    // TLS Fragment and Record Fragment options
    // ECH configuration (go1.24+)
    // kTLS wrapping (Linux only)
}
```

### Certificate Pinning

```go
func verifyPublicKeySHA256(knownHashValues [][]byte, rawCerts [][]byte, timeFunc func() time.Time) error {
    leafCertificate, _ := x509.ParseCertificate(rawCerts[0])
    pubKeyBytes, _ := x509.MarshalPKIXPublicKey(leafCertificate.PublicKey)
    hashValue := sha256.Sum256(pubKeyBytes)
    for _, value := range knownHashValues {
        if bytes.Equal(value, hashValue[:]) {
            return nil
        }
    }
    return E.New("unrecognized remote public key: ", base64.StdEncoding.EncodeToString(hashValue[:]))
}
```

### DisableSNI with Verification

When SNI is disabled but verification is still needed, a custom `VerifyConnection` callback performs manual certificate verification:

```go
if options.DisableSNI {
    tlsConfig.InsecureSkipVerify = true
    tlsConfig.VerifyConnection = func(state tls.ConnectionState) error {
        verifyOptions := x509.VerifyOptions{
            DNSName:       serverName,
            Intermediates: x509.NewCertPool(),
        }
        // Verify against the original server name
    }
}
```

## UTLSClient (uTLS Fingerprinting)

Build tag: `with_utls`. Uses `github.com/metacubex/utls`.

### Fingerprint Mapping

```go
func uTLSClientHelloID(name string) (utls.ClientHelloID, error) {
    switch name {
    case "chrome", "":   return utls.HelloChrome_Auto, nil
    case "firefox":      return utls.HelloFirefox_Auto, nil
    case "edge":         return utls.HelloEdge_Auto, nil
    case "safari":       return utls.HelloSafari_Auto, nil
    case "360":          return utls.Hello360_Auto, nil
    case "qq":           return utls.HelloQQ_Auto, nil
    case "ios":          return utls.HelloIOS_Auto, nil
    case "android":      return utls.HelloAndroid_11_OkHttp, nil
    case "random":       return randomFingerprint, nil
    case "randomized":   return randomizedFingerprint, nil
    }
}
```

The `random` fingerprint picks one of Chrome/Firefox/Edge/Safari/iOS at init time. The `randomized` fingerprint uses weighted random parameters with TLS 1.3 forced and P256 key share disabled.

### ALPN Manipulation

uTLS overrides ALPN after building the handshake state:

```go
func (c *utlsALPNWrapper) HandshakeContext(ctx context.Context) error {
    if len(c.nextProtocols) > 0 {
        c.BuildHandshakeState()
        for _, extension := range c.Extensions {
            if alpnExtension, isALPN := extension.(*utls.ALPNExtension); isALPN {
                alpnExtension.AlpnProtocols = c.nextProtocols
                c.BuildHandshakeState()
                break
            }
        }
    }
    return c.UConn.HandshakeContext(ctx)
}
```

When `SetNextProtos(["h2"])` is called on uTLS, it auto-appends `"http/1.1"` to maintain compatibility:

```go
func (c *UTLSClientConfig) SetNextProtos(nextProto []string) {
    if len(nextProto) == 1 && nextProto[0] == http2.NextProtoTLS {
        nextProto = append(nextProto, "http/1.1")
    }
    c.config.NextProtos = nextProto
}
```

## RealityClient

Build tag: `with_utls`. Reality provides server authentication without a traditional certificate chain.

### Handshake Protocol

1. Build uTLS handshake state
2. Filter out X25519MLKEM768 curves (not supported by Reality)
3. Generate 32-byte session ID with embedded metadata:
   - Bytes 0-7: Current Unix timestamp (big-endian)
   - Byte 0: `1` (version)
   - Byte 1: `8` (header length)
   - Byte 2: `1` (auth method)
   - Bytes 4-7: Current Unix timestamp (uint32)
   - Bytes 8-15: Short ID
4. Perform ECDH key exchange (X25519) with server's public key
5. Derive auth key via HKDF-SHA256
6. Seal session ID with AES-GCM using auth key
7. Copy sealed session ID into ClientHello raw bytes
8. Perform TLS handshake
9. Verify server via HMAC-SHA512 of ed25519 public key

```go
publicKey, _ := ecdh.X25519().NewPublicKey(e.publicKey)
authKey, _ := ecdheKey.ECDH(publicKey)
hkdf.New(sha256.New, authKey, hello.Random[:20], []byte("REALITY")).Read(authKey)
aesBlock, _ := aes.NewCipher(authKey)
aesGcmCipher, _ := cipher.NewGCM(aesBlock)
aesGcmCipher.Seal(hello.SessionId[:0], hello.Random[20:], hello.SessionId[:16], hello.Raw)
```

### Verification Failure Fallback

If server verification fails, the client performs a fake HTTP/2 browsing session to avoid detection:

```go
func realityClientFallback(ctx context.Context, uConn net.Conn, serverName string, fingerprint utls.ClientHelloID) {
    client := &http.Client{
        Transport: &http2.Transport{
            DialTLSContext: func(...) (net.Conn, error) { return uConn, nil },
        },
    }
    request, _ := http.NewRequest("GET", "https://"+serverName, nil)
    request.Header.Set("User-Agent", fingerprint.Client)
    request.AddCookie(&http.Cookie{Name: "padding", Value: strings.Repeat("0", rand.Intn(32)+30)})
    response, _ := client.Do(request)
    io.Copy(io.Discard, response.Body)
}
```

## RealityServer

Delegates to `utls.RealityServer` with configuration including:
- Private key (32 bytes, base64-raw-URL encoded)
- Short IDs (up to 8 bytes each, hex encoded)
- Max time difference for timestamp validation
- Handshake dialer for forwarding to real server

```go
tlsConfig.SessionTicketsDisabled = true
tlsConfig.ServerNames = map[string]bool{options.ServerName: true}
tlsConfig.PrivateKey = privateKey
tlsConfig.MaxTimeDiff = time.Duration(options.Reality.MaxTimeDifference)
tlsConfig.ShortIds = make(map[[8]byte]bool)
tlsConfig.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
    return handshakeDialer.DialContext(ctx, network, M.ParseSocksaddr(addr))
}
```

## ECH (Encrypted Client Hello)

Build constraint: `go1.24+`.

### Client

Two modes:
1. **Static config**: PEM-encoded ECH config provided directly
2. **Dynamic config**: Fetched via DNS HTTPS records with TTL-based caching

```go
func (s *ECHClientConfig) fetchAndHandshake(ctx context.Context, conn net.Conn) (aTLS.Conn, error) {
    s.access.Lock()
    defer s.access.Unlock()
    if len(s.ECHConfigList()) == 0 || time.Since(s.lastUpdate) > s.lastTTL {
        // Query DNS HTTPS record for ECH config
        message := &mDNS.Msg{Question: []mDNS.Question{{
            Name: mDNS.Fqdn(queryServerName), Qtype: mDNS.TypeHTTPS,
        }}}
        response, _ := s.dnsRouter.Exchange(ctx, message, adapter.DNSQueryOptions{})
        // Extract "ech" key from HTTPS record SVCB values
        // Base64 decode and set ECH config list
    }
    return s.Client(conn)
}
```

### Server

ECH keys are PEM-encoded and parsed using `cryptobyte`:

```go
func UnmarshalECHKeys(raw []byte) ([]tls.EncryptedClientHelloKey, error) {
    rawString := cryptobyte.String(raw)
    for !rawString.Empty() {
        var key tls.EncryptedClientHelloKey
        rawString.ReadUint16LengthPrefixed((*cryptobyte.String)(&key.PrivateKey))
        rawString.ReadUint16LengthPrefixed((*cryptobyte.String)(&key.Config))
        keys = append(keys, key)
    }
    return keys, nil
}
```

ECH keys support hot-reload via fswatch.

## STDServer

### Certificate Reload

Uses `github.com/sagernet/fswatch` for filesystem monitoring:

```go
func (c *STDServerConfig) startWatcher() error {
    watcher, err := fswatch.NewWatcher(fswatch.Options{
        Path: watchPath,  // certificate, key, client certs, ECH keys
        Callback: func(path string) {
            c.certificateUpdated(path)
        },
    })
    watcher.Start()
}
```

When files change, the config is atomically replaced using `Clone()` + `sync.RWMutex`:

```go
func (c *STDServerConfig) certificateUpdated(path string) error {
    keyPair, _ := tls.X509KeyPair(c.certificate, c.key)
    c.access.Lock()
    config := c.config.Clone()
    config.Certificates = []tls.Certificate{keyPair}
    c.config = config
    c.access.Unlock()
}
```

### ACME Integration

Build tag: `with_acme`. Uses `github.com/caddyserver/certmagic`.

Providers:
- `letsencrypt` (default): `certmagic.LetsEncryptProductionCA`
- `zerossl`: `certmagic.ZeroSSLProductionCA`
- Custom URL: Any `https://` prefix

DNS-01 challenge providers:
- `alidns`: Alibaba Cloud DNS
- `cloudflare`: Cloudflare DNS
- `acmedns`: ACME-DNS

### Insecure Self-Signed

When `insecure: true` without certificates, generates ephemeral certificates per-SNI:

```go
tlsConfig.GetCertificate = func(info *tls.ClientHelloInfo) (*tls.Certificate, error) {
    return GenerateKeyPair(nil, nil, timeFunc, info.ServerName)
}
```
