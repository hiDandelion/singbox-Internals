# Архитектура TLS

Исходный код: `common/tls/config.go`, `common/tls/client.go`, `common/tls/server.go`, `common/tls/std_client.go`, `common/tls/std_server.go`, `common/tls/utls_client.go`, `common/tls/reality_client.go`, `common/tls/reality_server.go`, `common/tls/ech.go`, `common/tls/ech_shared.go`, `common/tls/acme.go`, `common/tls/mkcert.go`

## Система типов

Уровень TLS использует псевдонимы типов из `github.com/sagernet/sing/common/tls`:

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

Интерфейс `Config` предоставляет методы: `ServerName()`, `SetServerName()`, `NextProtos()`, `SetNextProtos()`, `Client(conn) (Conn, error)`, `Clone() Config` и `STDConfig() (*STDConfig, error)`.

## Диспетчеризация клиента

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

Три реализации, выбираемые по приоритету: Reality > uTLS > stdlib.

### TLS Dialer с повтором ECH

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

Если ECH отклонён и сервер предоставляет конфигурации для повтора, dialer автоматически повторяет попытку один раз с обновлённой конфигурацией.

## STDClient (стандартная библиотека Go)

Полная конфигурация TLS:

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

### Закрепление сертификатов

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

### Отключение SNI с сохранением верификации

Когда SNI отключен, но верификация всё ещё необходима, пользовательский обратный вызов `VerifyConnection` выполняет ручную проверку сертификата:

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

## UTLSClient (подмена отпечатков uTLS)

Тег сборки: `with_utls`. Использует `github.com/metacubex/utls`.

### Сопоставление отпечатков

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

Отпечаток `random` выбирает один из Chrome/Firefox/Edge/Safari/iOS при инициализации. Отпечаток `randomized` использует взвешенные случайные параметры с принудительным TLS 1.3 и отключённым обменом ключами P256.

### Манипуляция ALPN

uTLS переопределяет ALPN после построения состояния рукопожатия:

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

Когда `SetNextProtos(["h2"])` вызывается для uTLS, автоматически добавляется `"http/1.1"` для поддержания совместимости:

```go
func (c *UTLSClientConfig) SetNextProtos(nextProto []string) {
    if len(nextProto) == 1 && nextProto[0] == http2.NextProtoTLS {
        nextProto = append(nextProto, "http/1.1")
    }
    c.config.NextProtos = nextProto
}
```

## RealityClient

Тег сборки: `with_utls`. Reality обеспечивает аутентификацию сервера без традиционной цепочки сертификатов.

### Протокол рукопожатия

1. Построение состояния рукопожатия uTLS
2. Фильтрация кривых X25519MLKEM768 (не поддерживается Reality)
3. Генерация 32-байтного идентификатора сессии со встроенными метаданными:
   - Байты 0-7: Текущая временная метка Unix (big-endian)
   - Байт 0: `1` (версия)
   - Байт 1: `8` (длина заголовка)
   - Байт 2: `1` (метод аутентификации)
   - Байты 4-7: Текущая временная метка Unix (uint32)
   - Байты 8-15: Короткий идентификатор (Short ID)
4. Выполнение обмена ключами ECDH (X25519) с открытым ключом сервера
5. Получение ключа аутентификации через HKDF-SHA256
6. Запечатывание идентификатора сессии с помощью AES-GCM, используя ключ аутентификации
7. Копирование запечатанного идентификатора сессии в необработанные байты ClientHello
8. Выполнение TLS-рукопожатия
9. Верификация сервера через HMAC-SHA512 открытого ключа ed25519

```go
publicKey, _ := ecdh.X25519().NewPublicKey(e.publicKey)
authKey, _ := ecdheKey.ECDH(publicKey)
hkdf.New(sha256.New, authKey, hello.Random[:20], []byte("REALITY")).Read(authKey)
aesBlock, _ := aes.NewCipher(authKey)
aesGcmCipher, _ := cipher.NewGCM(aesBlock)
aesGcmCipher.Seal(hello.SessionId[:0], hello.Random[20:], hello.SessionId[:16], hello.Raw)
```

### Резервное поведение при неудачной верификации

Если верификация сервера не удалась, клиент выполняет фальшивую HTTP/2-сессию просмотра для избежания обнаружения:

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

Делегирует работу `utls.RealityServer` с конфигурацией, включающей:
- Закрытый ключ (32 байта, кодировка base64-raw-URL)
- Короткие идентификаторы (до 8 байт каждый, в шестнадцатеричной кодировке)
- Максимальную разницу во времени для валидации временных меток
- Dialer рукопожатия для перенаправления к реальному серверу

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

Ограничение сборки: `go1.24+`.

### Клиент

Два режима:
1. **Статическая конфигурация**: PEM-кодированная конфигурация ECH, предоставленная непосредственно
2. **Динамическая конфигурация**: Получение через DNS HTTPS-записи с кэшированием на основе TTL

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

### Сервер

Ключи ECH кодируются в формате PEM и разбираются с помощью `cryptobyte`:

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

Ключи ECH поддерживают горячую перезагрузку через fswatch.

## STDServer

### Перезагрузка сертификатов

Использует `github.com/sagernet/fswatch` для мониторинга файловой системы:

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

При изменении файлов конфигурация атомарно заменяется с помощью `Clone()` + `sync.RWMutex`:

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

### Интеграция ACME

Тег сборки: `with_acme`. Использует `github.com/caddyserver/certmagic`.

Провайдеры:
- `letsencrypt` (по умолчанию): `certmagic.LetsEncryptProductionCA`
- `zerossl`: `certmagic.ZeroSSLProductionCA`
- Пользовательский URL: Любой префикс `https://`

Провайдеры DNS-01 challenge:
- `alidns`: Alibaba Cloud DNS
- `cloudflare`: Cloudflare DNS
- `acmedns`: ACME-DNS

### Небезопасный самоподписанный сертификат

Когда `insecure: true` без сертификатов, генерируются эфемерные сертификаты для каждого SNI:

```go
tlsConfig.GetCertificate = func(info *tls.ClientHelloInfo) (*tls.Certificate, error) {
    return GenerateKeyPair(nil, nil, timeFunc, info.ServerName)
}
```
