# SSH وTor وTailscale

تخدم هذه البروتوكولات الثلاثة أدواراً متخصصة في الشبكات: يوفر SSH نفق TCP عبر قنوات SSH، ويوفر Tor توجيهاً مجهولاً عبر شبكة Tor، ويوفر Tailscale شبكات mesh قائمة على WireGuard عبر خدمة تنسيق Tailscale.

**المصدر**: `protocol/ssh/outbound.go`، `protocol/tor/outbound.go`، `protocol/tor/proxy.go`، `protocol/tailscale/endpoint.go`

## صادر SSH

يستخدم نفق SSH مكتبة `golang.org/x/crypto/ssh` من Go لإنشاء اتصال SSH وإنشاء أنفاق TCP عبره.

### البنية

```go
type Outbound struct {
    outbound.Adapter
    ctx               context.Context
    logger            logger.ContextLogger
    dialer            N.Dialer
    serverAddr        M.Socksaddr
    user              string
    hostKey           []ssh.PublicKey
    hostKeyAlgorithms []string
    clientVersion     string
    authMethod        []ssh.AuthMethod
    clientAccess      sync.Mutex
    clientConn        net.Conn
    client            *ssh.Client
}
```

### TCP فقط

يدعم نفق SSH بروتوكول TCP فقط:

```go
outbound.NewAdapterWithDialerOptions(C.TypeSSH, tag, []string{N.NetworkTCP}, options.DialerOptions)

func (s *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    return nil, os.ErrInvalid
}
```

### التكوين الافتراضي

```go
if outbound.serverAddr.Port == 0 {
    outbound.serverAddr.Port = 22
}
if outbound.user == "" {
    outbound.user = "root"
}
if outbound.clientVersion == "" {
    outbound.clientVersion = randomVersion()
}
```

### إصدار العميل العشوائي

لتجنب البصمة، يتم إنشاء سلسلة إصدار SSH عشوائية:

```go
func randomVersion() string {
    version := "SSH-2.0-OpenSSH_"
    if rand.Intn(2) == 0 {
        version += "7." + strconv.Itoa(rand.Intn(10))
    } else {
        version += "8." + strconv.Itoa(rand.Intn(9))
    }
    return version
}
```

### طرق المصادقة

يتم دعم طرق مصادقة متعددة:

```go
// مصادقة بكلمة المرور
if options.Password != "" {
    outbound.authMethod = append(outbound.authMethod, ssh.Password(options.Password))
}

// مصادقة بالمفتاح الخاص (مع عبارة مرور اختيارية)
if len(options.PrivateKey) > 0 || options.PrivateKeyPath != "" {
    var signer ssh.Signer
    if options.PrivateKeyPassphrase == "" {
        signer, _ = ssh.ParsePrivateKey(privateKey)
    } else {
        signer, _ = ssh.ParsePrivateKeyWithPassphrase(privateKey, []byte(options.PrivateKeyPassphrase))
    }
    outbound.authMethod = append(outbound.authMethod, ssh.PublicKeys(signer))
}
```

### التحقق من مفتاح المضيف

```go
HostKeyCallback: func(hostname string, remote net.Addr, key ssh.PublicKey) error {
    if len(s.hostKey) == 0 {
        return nil  // قبول جميع المفاتيح
    }
    serverKey := key.Marshal()
    for _, hostKey := range s.hostKey {
        if bytes.Equal(serverKey, hostKey.Marshal()) {
            return nil
        }
    }
    return E.New("host key mismatch")
},
```

### إعادة استخدام الاتصال

يتم مشاركة اتصال عميل SSH عبر أنفاق متعددة:

```go
func (s *Outbound) connect() (*ssh.Client, error) {
    if s.client != nil {
        return s.client, nil  // إعادة استخدام الاتصال الحالي
    }
    s.clientAccess.Lock()
    defer s.clientAccess.Unlock()

    // فحص مزدوج بعد الحصول على القفل
    if s.client != nil {
        return s.client, nil
    }

    conn, _ := s.dialer.DialContext(s.ctx, N.NetworkTCP, s.serverAddr)
    clientConn, chans, reqs, _ := ssh.NewClientConn(conn, s.serverAddr.Addr.String(), config)
    client := ssh.NewClient(clientConn, chans, reqs)

    s.clientConn = conn
    s.client = client

    // مراقبة قطع الاتصال
    go func() {
        client.Wait()
        conn.Close()
        s.clientAccess.Lock()
        s.client = nil
        s.clientConn = nil
        s.clientAccess.Unlock()
    }()

    return client, nil
}
```

### الاتصال عبر SSH

```go
func (s *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    client, _ := s.connect()
    conn, _ := client.Dial(network, destination.String())
    return &chanConnWrapper{Conn: conn}, nil
}
```

يغلف `chanConnWrapper` اتصالات `ssh.Channel`، ويعطل عمليات المواعيد النهائية (التي لا تدعمها قنوات SSH).

### تحديث الواجهة

عند تغيير واجهة الشبكة، يتم إغلاق اتصال SSH ليتمكن من إعادة الاتصال:

```go
func (s *Outbound) InterfaceUpdated() {
    common.Close(s.clientConn)
}
```

## صادر Tor

يستخدم تكامل Tor مكتبة `cretz/bine` لإدارة عملية Tor مضمنة وتوجيه الاتصالات عبر شبكة Tor.

### البنية

```go
type Outbound struct {
    outbound.Adapter
    ctx         context.Context
    logger      logger.ContextLogger
    proxy       *ProxyListener
    startConf   *tor.StartConf
    options     map[string]string
    events      chan control.Event
    instance    *tor.Tor
    socksClient *socks.Client
}
```

### TCP فقط

```go
outbound.NewAdapterWithDialerOptions(C.TypeTor, tag, []string{N.NetworkTCP}, options.DialerOptions)
```

### تكوين Tor

```go
var startConf tor.StartConf
startConf.DataDir = os.ExpandEnv(options.DataDirectory)
startConf.TempDataDirBase = os.TempDir()
startConf.ExtraArgs = options.ExtraArgs

// الكشف التلقائي عن ملفات GeoIP في مجلد البيانات
if geoIPPath := filepath.Join(dataDirAbs, "geoip"); rw.IsFile(geoIPPath) {
    options.ExtraArgs = append(options.ExtraArgs, "--GeoIPFile", geoIPPath)
}
```

### مستمع الوكيل (جسر العلوي)

الابتكار الرئيسي هو `ProxyListener`: وكيل SOCKS5 محلي يربط نظام متصل sing-box بـ Tor. يتم تكوين Tor لاستخدام هذا الوكيل المحلي كعلوي:

```go
proxy := NewProxyListener(ctx, logger, outboundDialer)
```

مستمع الوكيل:
1. يستمع على منفذ محلي عشوائي مع بيانات اعتماد عشوائية
2. يقبل اتصالات SOCKS5 من عملية Tor
3. يوجهها عبر متصل sing-box (الذي يعالج التحويلات والواجهات، إلخ)

```go
type ProxyListener struct {
    ctx           context.Context
    logger        log.ContextLogger
    dialer        N.Dialer
    tcpListener   *net.TCPListener
    username      string         // 64 بايت ست عشري عشوائي
    password      string         // 64 بايت ست عشري عشوائي
    authenticator *auth.Authenticator
}
```

### تسلسل البدء

```go
func (t *Outbound) start() error {
    // 1. بدء عملية Tor
    torInstance, _ := tor.Start(t.ctx, t.startConf)

    // 2. إعداد تسجيل الأحداث
    torInstance.Control.AddEventListener(t.events, torLogEvents...)
    go t.recvLoop()

    // 3. بدء جسر الوكيل المحلي
    t.proxy.Start()

    // 4. تكوين Tor لاستخدام الوكيل المحلي
    confOptions := []*control.KeyVal{
        control.NewKeyVal("Socks5Proxy", "127.0.0.1:" + F.ToString(t.proxy.Port())),
        control.NewKeyVal("Socks5ProxyUsername", t.proxy.Username()),
        control.NewKeyVal("Socks5ProxyPassword", t.proxy.Password()),
    }
    torInstance.Control.ResetConf(confOptions...)

    // 5. تطبيق خيارات Tor المخصصة
    for key, value := range t.options {
        torInstance.Control.SetConf(control.NewKeyVal(key, value))
    }

    // 6. تفعيل شبكة Tor
    torInstance.EnableNetwork(t.ctx, true)

    // 7. الحصول على عنوان SOCKS5 لـ Tor
    info, _ := torInstance.Control.GetInfo("net/listeners/socks")
    t.socksClient = socks.NewClient(N.SystemDialer, M.ParseSocksaddr(info[0].Val), socks.Version5, "", "")
}
```

### الاتصال عبر Tor

```go
func (t *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    return t.socksClient.DialContext(ctx, network, destination)
}
```

## نقطة نهاية Tailscale

يُنفذ Tailscale **كنقطة نهاية (Endpoint)** كاملة (مثل WireGuard)، توفر وظائف الوارد والصادر. يستخدم `tsnet.Server` لتشغيل عقدة Tailscale مضمنة.

### البنية

```go
type Endpoint struct {
    endpoint.Adapter
    ctx               context.Context
    router            adapter.Router
    logger            logger.ContextLogger
    dnsRouter         adapter.DNSRouter
    network           adapter.NetworkManager
    platformInterface adapter.PlatformInterface
    server            *tsnet.Server
    stack             *stack.Stack          // مكدس شبكة gVisor
    icmpForwarder     *tun.ICMPForwarder
    filter            *atomic.Pointer[filter.Filter]

    acceptRoutes               bool
    exitNode                   string
    exitNodeAllowLANAccess     bool
    advertiseRoutes            []netip.Prefix
    advertiseExitNode          bool
    advertiseTags              []string
    relayServerPort            *uint16

    udpTimeout time.Duration
}
```

### دعم الشبكة

يدعم Tailscale بروتوكولات TCP وUDP وICMP:

```go
endpoint.NewAdapter(C.TypeTailscale, tag, []string{N.NetworkTCP, N.NetworkUDP, N.NetworkICMP}, nil)
```

### تكوين tsnet.Server

```go
server := &tsnet.Server{
    Dir:           stateDirectory,
    Hostname:      hostname,
    Ephemeral:     options.Ephemeral,
    AuthKey:       options.AuthKey,
    ControlURL:    options.ControlURL,
    AdvertiseTags: options.AdvertiseTags,
    Dialer:        &endpointDialer{Dialer: outboundDialer, logger: logger},
    LookupHook: func(ctx, host) ([]netip.Addr, error) {
        return dnsRouter.Lookup(ctx, host, outboundDialer.(dialer.ResolveDialer).QueryOptions())
    },
    HTTPClient: &http.Client{
        Transport: &http.Transport{
            DialContext: func(ctx, network, address) (net.Conn, error) {
                return outboundDialer.DialContext(ctx, network, M.ParseSocksaddr(address))
            },
            TLSClientConfig: &tls.Config{
                RootCAs: adapter.RootPoolFromContext(ctx),
                Time:    ntp.TimeFuncFromContext(ctx),
            },
        },
    },
}
```

### معالجات Netstack

يستخدم Tailscale مكدس شبكة gVisor. يتم تسجيل اتصالات TCP/UDP الواردة عبر معالجات تدفق netstack:

```go
func (t *Endpoint) registerNetstackHandlers() {
    netstack := t.server.ExportNetstack()

    netstack.GetTCPHandlerForFlow = func(src, dst netip.AddrPort) (handler func(net.Conn), intercept bool) {
        return func(conn net.Conn) {
            t.NewConnectionEx(ctx, conn, source, destination, nil)
        }, true
    }

    netstack.GetUDPHandlerForFlow = func(src, dst netip.AddrPort) (handler func(nettype.ConnPacketConn), intercept bool) {
        return func(conn nettype.ConnPacketConn) {
            t.NewPacketConnectionEx(ctx, bufio.NewPacketConn(conn), source, destination, nil)
        }, true
    }
}
```

### تحويل ICMP

يعد Tailscale تحويل ICMP عبر مكدس شبكة gVisor:

```go
icmpForwarder := tun.NewICMPForwarder(t.ctx, ipStack, t, t.udpTimeout)
ipStack.SetTransportProtocolHandler(icmp.ProtocolNumber4, icmpForwarder.HandlePacket)
ipStack.SetTransportProtocolHandler(icmp.ProtocolNumber6, icmpForwarder.HandlePacket)
```

### المصادقة ومراقبة الحالة

تراقب نقطة النهاية متطلبات المصادقة وترسل إشعارات على المنصات المحمولة:

```go
func (t *Endpoint) watchState() {
    localBackend.WatchNotifications(t.ctx, ipn.NotifyInitialState, nil, func(roNotify *ipn.Notify) (keepGoing bool) {
        authURL := localBackend.StatusWithoutPeers().AuthURL
        if authURL != "" {
            t.logger.Info("Waiting for authentication: ", authURL)
            if t.platformInterface != nil {
                t.platformInterface.SendNotification(&adapter.Notification{
                    Title:   "Tailscale Authentication",
                    OpenURL: authURL,
                })
            }
        }
        return true
    })
}
```

### دعم عقدة الخروج

بعد تشغيل عقدة Tailscale، يتم تكوين عقدة الخروج:

```go
if t.exitNode != "" {
    status, _ := t.server.LocalClient().Status(t.ctx)
    perfs := &ipn.MaskedPrefs{
        Prefs: ipn.Prefs{
            ExitNodeAllowLANAccess: t.exitNodeAllowLANAccess,
        },
        ExitNodeIPSet:             true,
        ExitNodeAllowLANAccessSet: true,
    }
    perfs.SetExitNodeIP(t.exitNode, status)
    localBackend.EditPrefs(perfs)
}
```

### الاتصال الصادر عبر gVisor

تمر الاتصالات الصادرة عبر مكدس TCP/IP الخاص بـ gVisor مباشرة:

```go
func (t *Endpoint) DialContext(ctx, network, destination) (net.Conn, error) {
    addr4, addr6 := t.server.TailscaleIPs()
    remoteAddr := tcpip.FullAddress{NIC: 1, Port: destination.Port, Addr: addressFromAddr(destination.Addr)}

    switch N.NetworkName(network) {
    case N.NetworkTCP:
        return gonet.DialTCPWithBind(ctx, t.stack, localAddr, remoteAddr, networkProtocol)
    case N.NetworkUDP:
        return gonet.DialUDP(t.stack, &localAddr, &remoteAddr, networkProtocol)
    }
}
```

### المسارات المفضلة

يعلن Tailscale عن النطاقات والعناوين المفضلة بناءً على تكوين WireGuard:

```go
func (t *Endpoint) PreferredDomain(domain string) bool {
    routeDomains := t.routeDomains.Load()
    return routeDomains[strings.ToLower(domain)]
}

func (t *Endpoint) PreferredAddress(address netip.Addr) bool {
    routePrefixes := t.routePrefixes.Load()
    return routePrefixes.Contains(address)
}
```

### خطاف إعادة التكوين

عند تغيير تكوين WireGuard، يتم تحديث نطاقات المسار والبادئات:

```go
func (t *Endpoint) onReconfig(cfg *wgcfg.Config, routerCfg *router.Config, dnsCfg *tsDNS.Config) {
    // تحديث نطاقات المسار من تكوين DNS
    routeDomains := make(map[string]bool)
    for fqdn := range dnsCfg.Routes {
        routeDomains[fqdn.WithoutTrailingDot()] = true
    }
    t.routeDomains.Store(routeDomains)

    // تحديث بادئات المسار من AllowedIPs للأقران
    var builder netipx.IPSetBuilder
    for _, peer := range cfg.Peers {
        for _, allowedIP := range peer.AllowedIPs {
            builder.AddPrefix(allowedIP)
        }
    }
    t.routePrefixes.Store(common.Must1(builder.IPSet()))
}
```

### وضع واجهة النظام

يمكن لـ Tailscale اختيارياً إنشاء واجهة TUN حقيقية:

```go
if t.systemInterface {
    tunOptions := tun.Options{
        Name: tunName,
        MTU:  mtu,
        GSO:  true,
    }
    systemTun, _ := tun.New(tunOptions)
    systemTun.Start()
    t.server.TunDevice = newTunDeviceAdapter(systemTun, int(mtu), t.logger)
}
```

## أمثلة على التكوين

### SSH

```json
{
  "type": "ssh",
  "tag": "ssh-out",
  "server": "example.com",
  "server_port": 22,
  "user": "admin",
  "private_key_path": "/path/to/id_ed25519",
  "host_key_algorithms": ["ssh-ed25519"],
  "host_key": ["ssh-ed25519 AAAA..."]
}
```

### Tor

```json
{
  "type": "tor",
  "tag": "tor-out",
  "executable_path": "/usr/bin/tor",
  "data_directory": "/var/lib/sing-box/tor",
  "options": {
    "ExitNodes": "{us}",
    "StrictNodes": "1"
  }
}
```

### Tailscale

```json
{
  "type": "tailscale",
  "tag": "ts-ep",
  "auth_key": "tskey-auth-xxxxx",
  "hostname": "sing-box-node",
  "state_directory": "/var/lib/sing-box/tailscale",
  "accept_routes": true,
  "exit_node": "100.64.0.1",
  "exit_node_allow_lan_access": true,
  "advertise_routes": ["10.0.0.0/24"],
  "advertise_exit_node": false,
  "udp_timeout": "5m"
}
```
