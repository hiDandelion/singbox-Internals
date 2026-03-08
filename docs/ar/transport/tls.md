# بنية TLS

المصدر: `common/tls/config.go`، `common/tls/client.go`، `common/tls/server.go`، `common/tls/std_client.go`، `common/tls/std_server.go`، `common/tls/utls_client.go`، `common/tls/reality_client.go`، `common/tls/reality_server.go`، `common/tls/ech.go`، `common/tls/ech_shared.go`، `common/tls/acme.go`، `common/tls/mkcert.go`

## نظام الأنواع

تستخدم طبقة TLS أسماء أنواع مستعارة من `github.com/sagernet/sing/common/tls`:

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

توفر واجهة `Config` دوالًا مثل `ServerName()`، `SetServerName()`، `NextProtos()`، `SetNextProtos()`، `Client(conn) (Conn, error)`، `Clone() Config`، و `STDConfig() (*STDConfig, error)`.

## توزيع العميل

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

ثلاثة تنفيذات، مُرتبة حسب الأولوية: Reality > uTLS > المكتبة القياسية.

### طالب اتصال TLS مع إعادة محاولة ECH

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

إذا رُفض ECH وقدم الخادم إعدادات إعادة المحاولة، يعيد طالب الاتصال المحاولة تلقائيًا مرة واحدة مع الإعدادات المُحدَّثة.

## STDClient (المكتبة القياسية لـ Go)

إعدادات TLS شاملة:

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

### تثبيت الشهادات

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

### تعطيل SNI مع التحقق

عندما يُعطَّل SNI لكن لا يزال التحقق مطلوبًا، يُنفذ استدعاء `VerifyConnection` المخصص التحقق اليدوي من الشهادة:

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

## UTLSClient (بصمة uTLS)

علامة البناء: `with_utls`. يستخدم `github.com/metacubex/utls`.

### تعيين البصمات

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

بصمة `random` تختار واحدة من Chrome/Firefox/Edge/Safari/iOS وقت التهيئة. بصمة `randomized` تستخدم معاملات عشوائية مرجحة مع فرض TLS 1.3 وتعطيل مشاركة مفتاح P256.

### التلاعب بـ ALPN

يتجاوز uTLS إعدادات ALPN بعد بناء حالة المصافحة:

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

عندما يُستدعى `SetNextProtos(["h2"])` على uTLS، يُضاف `"http/1.1"` تلقائيًا للحفاظ على التوافق:

```go
func (c *UTLSClientConfig) SetNextProtos(nextProto []string) {
    if len(nextProto) == 1 && nextProto[0] == http2.NextProtoTLS {
        nextProto = append(nextProto, "http/1.1")
    }
    c.config.NextProtos = nextProto
}
```

## RealityClient

علامة البناء: `with_utls`. يوفر Reality مصادقة الخادم بدون سلسلة شهادات تقليدية.

### بروتوكول المصافحة

1. بناء حالة مصافحة uTLS
2. تصفية منحنيات X25519MLKEM768 (غير مدعومة من Reality)
3. توليد معرف جلسة بطول 32 بايت مع بيانات وصفية مُضمَّنة:
   - البايتات 0-7: الطابع الزمني الحالي بصيغة Unix (ترتيب كبير)
   - البايت 0: `1` (الإصدار)
   - البايت 1: `8` (طول الترويسة)
   - البايت 2: `1` (طريقة المصادقة)
   - البايتات 4-7: الطابع الزمني الحالي بصيغة Unix (uint32)
   - البايتات 8-15: المعرف القصير
4. تنفيذ تبادل مفاتيح ECDH (X25519) مع المفتاح العام للخادم
5. اشتقاق مفتاح المصادقة عبر HKDF-SHA256
6. ختم معرف الجلسة بـ AES-GCM باستخدام مفتاح المصادقة
7. نسخ معرف الجلسة المختوم إلى بايتات ClientHello الخام
8. تنفيذ مصافحة TLS
9. التحقق من الخادم عبر HMAC-SHA512 للمفتاح العام ed25519

```go
publicKey, _ := ecdh.X25519().NewPublicKey(e.publicKey)
authKey, _ := ecdheKey.ECDH(publicKey)
hkdf.New(sha256.New, authKey, hello.Random[:20], []byte("REALITY")).Read(authKey)
aesBlock, _ := aes.NewCipher(authKey)
aesGcmCipher, _ := cipher.NewGCM(aesBlock)
aesGcmCipher.Seal(hello.SessionId[:0], hello.Random[20:], hello.SessionId[:16], hello.Raw)
```

### الرجوع عند فشل التحقق

إذا فشل التحقق من الخادم، يُجري العميل جلسة تصفح HTTP/2 مزيفة لتجنب الكشف:

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

يُفوِّض إلى `utls.RealityServer` مع إعدادات تتضمن:
- المفتاح الخاص (32 بايت، مرمز بـ base64-raw-URL)
- المعرفات القصيرة (حتى 8 بايتات لكل منها، مرمزة بالست عشري)
- أقصى فرق زمني للتحقق من الطابع الزمني
- طالب اتصال المصافحة لإعادة التوجيه إلى الخادم الحقيقي

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

## ECH (تشفير Client Hello)

قيد البناء: `go1.24+`.

### العميل

وضعان:
1. **إعدادات ثابتة**: إعدادات ECH مُقدَّمة مباشرة بصيغة PEM
2. **إعدادات ديناميكية**: تُجلب عبر سجلات DNS HTTPS مع تخزين مؤقت قائم على TTL

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

### الخادم

مفاتيح ECH مرمزة بصيغة PEM وتُحلَّل باستخدام `cryptobyte`:

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

تدعم مفاتيح ECH إعادة التحميل الساخن عبر fswatch.

## STDServer

### إعادة تحميل الشهادات

يستخدم `github.com/sagernet/fswatch` لمراقبة نظام الملفات:

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

عندما تتغير الملفات، تُستبدل الإعدادات ذريًا باستخدام `Clone()` + `sync.RWMutex`:

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

### تكامل ACME

علامة البناء: `with_acme`. يستخدم `github.com/caddyserver/certmagic`.

مزودو الخدمة:
- `letsencrypt` (افتراضي): `certmagic.LetsEncryptProductionCA`
- `zerossl`: `certmagic.ZeroSSLProductionCA`
- عنوان URL مخصص: أي بادئة `https://`

مزودو تحدي DNS-01:
- `alidns`: خدمة DNS من Alibaba Cloud
- `cloudflare`: Cloudflare DNS
- `acmedns`: ACME-DNS

### شهادات ذاتية التوقيع غير آمنة

عندما يكون `insecure: true` بدون شهادات، تُولَّد شهادات مؤقتة لكل SNI:

```go
tlsConfig.GetCertificate = func(info *tls.ClientHelloInfo) (*tls.Certificate, error) {
    return GenerateKeyPair(nil, nil, timeFunc, info.ServerName)
}
```
