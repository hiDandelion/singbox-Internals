# TLS 架构

源码：`common/tls/config.go`、`common/tls/client.go`、`common/tls/server.go`、`common/tls/std_client.go`、`common/tls/std_server.go`、`common/tls/utls_client.go`、`common/tls/reality_client.go`、`common/tls/reality_server.go`、`common/tls/ech.go`、`common/tls/ech_shared.go`、`common/tls/acme.go`、`common/tls/mkcert.go`

## 类型系统

TLS 层使用来自 `github.com/sagernet/sing/common/tls` 的类型别名：

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

`Config` interface 提供了 `ServerName()`、`SetServerName()`、`NextProtos()`、`SetNextProtos()`、`Client(conn) (Conn, error)`、`Clone() Config` 和 `STDConfig() (*STDConfig, error)` 等方法。

## 客户端分发

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

三种实现，按优先级选择：Reality > uTLS > 标准库。

### 带 ECH 重试的 TLS 拨号器

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

如果 ECH 被拒绝且服务器提供了重试配置，拨号器会自动使用更新后的配置重试一次。

## STDClient（Go 标准库）

全面的 TLS 配置：

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

### 证书锁定

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

### 禁用 SNI 并保留验证

当禁用 SNI 但仍需要验证时，自定义的 `VerifyConnection` 回调执行手动证书验证：

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

## UTLSClient（uTLS 指纹伪装）

构建标签：`with_utls`。使用 `github.com/metacubex/utls`。

### 指纹映射

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

`random` 指纹在初始化时从 Chrome/Firefox/Edge/Safari/iOS 中随机选择一个。`randomized` 指纹使用带权重的随机参数，强制 TLS 1.3 并禁用 P256 密钥共享。

### ALPN 操作

uTLS 在构建 handshake 状态后覆盖 ALPN：

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

当对 uTLS 调用 `SetNextProtos(["h2"])` 时，会自动追加 `"http/1.1"` 以保持兼容性：

```go
func (c *UTLSClientConfig) SetNextProtos(nextProto []string) {
    if len(nextProto) == 1 && nextProto[0] == http2.NextProtoTLS {
        nextProto = append(nextProto, "http/1.1")
    }
    c.config.NextProtos = nextProto
}
```

## RealityClient

构建标签：`with_utls`。Reality 提供无需传统证书链的服务器身份验证。

### Handshake 协议

1. 构建 uTLS handshake 状态
2. 过滤掉 X25519MLKEM768 曲线（Reality 不支持）
3. 生成 32 字节 session ID，嵌入元数据：
   - 字节 0-7：当前 Unix 时间戳（大端序）
   - 字节 0：`1`（版本）
   - 字节 1：`8`（头部长度）
   - 字节 2：`1`（认证方法）
   - 字节 4-7：当前 Unix 时间戳（uint32）
   - 字节 8-15：短 ID
4. 使用服务器公钥执行 ECDH 密钥交换（X25519）
5. 通过 HKDF-SHA256 派生认证密钥
6. 使用 AES-GCM 和认证密钥密封 session ID
7. 将密封后的 session ID 复制到 ClientHello 原始字节中
8. 执行 TLS handshake
9. 通过 ed25519 公钥的 HMAC-SHA512 验证服务器

```go
publicKey, _ := ecdh.X25519().NewPublicKey(e.publicKey)
authKey, _ := ecdheKey.ECDH(publicKey)
hkdf.New(sha256.New, authKey, hello.Random[:20], []byte("REALITY")).Read(authKey)
aesBlock, _ := aes.NewCipher(authKey)
aesGcmCipher, _ := cipher.NewGCM(aesBlock)
aesGcmCipher.Seal(hello.SessionId[:0], hello.Random[20:], hello.SessionId[:16], hello.Raw)
```

### 验证失败后备

如果服务器验证失败，客户端会执行伪造的 HTTP/2 浏览会话以避免检测：

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

委托给 `utls.RealityServer`，配置包括：
- 私钥（32 字节，base64-raw-URL 编码）
- 短 ID（每个最多 8 字节，十六进制编码）
- 时间戳验证的最大时间差
- 用于转发到真实服务器的 handshake 拨号器

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

## ECH（Encrypted Client Hello）

构建约束：`go1.24+`。

### 客户端

两种模式：
1. **静态配置**：直接提供 PEM 编码的 ECH 配置
2. **动态配置**：通过 DNS HTTPS 记录获取，带 TTL 缓存

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

### 服务端

ECH 密钥为 PEM 编码，使用 `cryptobyte` 解析：

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

ECH 密钥支持通过 fswatch 热重载。

## STDServer

### 证书重载

使用 `github.com/sagernet/fswatch` 进行文件系统监控：

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

当文件变更时，配置通过 `Clone()` + `sync.RWMutex` 原子替换：

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

### ACME 集成

构建标签：`with_acme`。使用 `github.com/caddyserver/certmagic`。

提供商：
- `letsencrypt`（默认）：`certmagic.LetsEncryptProductionCA`
- `zerossl`：`certmagic.ZeroSSLProductionCA`
- 自定义 URL：任何 `https://` 前缀

DNS-01 挑战提供商：
- `alidns`：阿里云 DNS
- `cloudflare`：Cloudflare DNS
- `acmedns`：ACME-DNS

### 不安全的自签名证书

当 `insecure: true` 且没有证书时，按 SNI 生成临时证书：

```go
tlsConfig.GetCertificate = func(info *tls.ClientHelloInfo) (*tls.Certificate, error) {
    return GenerateKeyPair(nil, nil, timeFunc, info.ServerName)
}
```
