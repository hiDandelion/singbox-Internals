# SSH, Tor и Tailscale

Эти три протокола выполняют специализированные сетевые роли: SSH обеспечивает TCP-туннелирование через SSH-каналы, Tor обеспечивает анонимную маршрутизацию через сеть Tor, а Tailscale обеспечивает mesh-сеть на основе WireGuard через координационный сервис Tailscale.

**Исходный код**: `protocol/ssh/outbound.go`, `protocol/tor/outbound.go`, `protocol/tor/proxy.go`, `protocol/tailscale/endpoint.go`

## Исходящее соединение SSH (Outbound)

SSH-туннелирование использует библиотеку Go `golang.org/x/crypto/ssh` для установки SSH-соединения и создания TCP-туннелей через него.

### Архитектура

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

### Только TCP

SSH-туннелирование поддерживает только TCP:

```go
outbound.NewAdapterWithDialerOptions(C.TypeSSH, tag, []string{N.NetworkTCP}, options.DialerOptions)

func (s *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    return nil, os.ErrInvalid
}
```

### Конфигурация по умолчанию

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

### Случайная версия клиента

Для предотвращения снятия отпечатков генерируется случайная строка версии SSH:

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

### Методы аутентификации

Поддерживается несколько методов аутентификации:

```go
// Аутентификация по паролю
if options.Password != "" {
    outbound.authMethod = append(outbound.authMethod, ssh.Password(options.Password))
}

// Аутентификация по закрытому ключу (с опциональной парольной фразой)
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

### Проверка ключа хоста

```go
HostKeyCallback: func(hostname string, remote net.Addr, key ssh.PublicKey) error {
    if len(s.hostKey) == 0 {
        return nil  // Принимать все ключи
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

### Повторное использование соединения

SSH-клиентское соединение разделяется между несколькими туннелями:

```go
func (s *Outbound) connect() (*ssh.Client, error) {
    if s.client != nil {
        return s.client, nil  // Использовать существующее соединение
    }
    s.clientAccess.Lock()
    defer s.clientAccess.Unlock()

    // Повторная проверка после захвата блокировки
    if s.client != nil {
        return s.client, nil
    }

    conn, _ := s.dialer.DialContext(s.ctx, N.NetworkTCP, s.serverAddr)
    clientConn, chans, reqs, _ := ssh.NewClientConn(conn, s.serverAddr.Addr.String(), config)
    client := ssh.NewClient(clientConn, chans, reqs)

    s.clientConn = conn
    s.client = client

    // Мониторинг отключения
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

### Подключение через SSH

```go
func (s *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    client, _ := s.connect()
    conn, _ := client.Dial(network, destination.String())
    return &chanConnWrapper{Conn: conn}, nil
}
```

`chanConnWrapper` оборачивает соединения `ssh.Channel`, отключая операции с дедлайнами (которые SSH-каналы не поддерживают).

### Обновление интерфейса

При смене сетевого интерфейса SSH-соединение закрывается для переподключения:

```go
func (s *Outbound) InterfaceUpdated() {
    common.Close(s.clientConn)
}
```

## Исходящее соединение Tor (Outbound)

Интеграция Tor использует библиотеку `cretz/bine` для управления встроенным процессом Tor и маршрутизации соединений через сеть Tor.

### Архитектура

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

### Только TCP

```go
outbound.NewAdapterWithDialerOptions(C.TypeTor, tag, []string{N.NetworkTCP}, options.DialerOptions)
```

### Конфигурация Tor

```go
var startConf tor.StartConf
startConf.DataDir = os.ExpandEnv(options.DataDirectory)
startConf.TempDataDirBase = os.TempDir()
startConf.ExtraArgs = options.ExtraArgs

// Автоматическое обнаружение файлов GeoIP в каталоге данных
if geoIPPath := filepath.Join(dataDirAbs, "geoip"); rw.IsFile(geoIPPath) {
    options.ExtraArgs = append(options.ExtraArgs, "--GeoIPFile", geoIPPath)
}
```

### Прокси-слушатель (мост для вышестоящего соединения)

Ключевая инновация — `ProxyListener`: локальный SOCKS5-прокси, который связывает систему dialer'ов sing-box с Tor. Tor настраивается на использование этого локального прокси как вышестоящего:

```go
proxy := NewProxyListener(ctx, logger, outboundDialer)
```

Прокси-слушатель:
1. Слушает на случайном локальном порту со случайными учётными данными
2. Принимает SOCKS5-соединения от процесса Tor
3. Маршрутизирует их через dialer sing-box (который обрабатывает detour'ы, интерфейсы и т.д.)

```go
type ProxyListener struct {
    ctx           context.Context
    logger        log.ContextLogger
    dialer        N.Dialer
    tcpListener   *net.TCPListener
    username      string         // случайный 64-байтовый hex
    password      string         // случайный 64-байтовый hex
    authenticator *auth.Authenticator
}
```

### Последовательность запуска

```go
func (t *Outbound) start() error {
    // 1. Запустить процесс Tor
    torInstance, _ := tor.Start(t.ctx, t.startConf)

    // 2. Настроить логирование событий
    torInstance.Control.AddEventListener(t.events, torLogEvents...)
    go t.recvLoop()

    // 3. Запустить локальный мост прокси
    t.proxy.Start()

    // 4. Настроить Tor на использование локального прокси
    confOptions := []*control.KeyVal{
        control.NewKeyVal("Socks5Proxy", "127.0.0.1:" + F.ToString(t.proxy.Port())),
        control.NewKeyVal("Socks5ProxyUsername", t.proxy.Username()),
        control.NewKeyVal("Socks5ProxyPassword", t.proxy.Password()),
    }
    torInstance.Control.ResetConf(confOptions...)

    // 5. Применить пользовательские опции Tor
    for key, value := range t.options {
        torInstance.Control.SetConf(control.NewKeyVal(key, value))
    }

    // 6. Включить сеть Tor
    torInstance.EnableNetwork(t.ctx, true)

    // 7. Получить адрес SOCKS5 Tor
    info, _ := torInstance.Control.GetInfo("net/listeners/socks")
    t.socksClient = socks.NewClient(N.SystemDialer, M.ParseSocksaddr(info[0].Val), socks.Version5, "", "")
}
```

### Подключение через Tor

```go
func (t *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    return t.socksClient.DialContext(ctx, network, destination)
}
```

## Endpoint Tailscale

Tailscale реализован как полный **Endpoint** (как и WireGuard), обеспечивая функциональность как входящих, так и исходящих соединений. Он использует `tsnet.Server` для запуска встроенного узла Tailscale.

### Архитектура

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
    stack             *stack.Stack          // сетевой стек gVisor
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

### Поддержка сетей

Tailscale поддерживает TCP, UDP и ICMP:

```go
endpoint.NewAdapter(C.TypeTailscale, tag, []string{N.NetworkTCP, N.NetworkUDP, N.NetworkICMP}, nil)
```

### Конфигурация tsnet.Server

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

### Обработчики Netstack

Tailscale использует сетевой стек gVisor. Входящие TCP/UDP-соединения регистрируются через обработчики потоков netstack:

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

### Пересылка ICMP

Tailscale настраивает пересылку ICMP через сетевой стек gVisor:

```go
icmpForwarder := tun.NewICMPForwarder(t.ctx, ipStack, t, t.udpTimeout)
ipStack.SetTransportProtocolHandler(icmp.ProtocolNumber4, icmpForwarder.HandlePacket)
ipStack.SetTransportProtocolHandler(icmp.ProtocolNumber6, icmpForwarder.HandlePacket)
```

### Аутентификация и отслеживание состояния

Endpoint отслеживает требования аутентификации и отправляет уведомления на мобильных платформах:

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

### Поддержка Exit Node

После запуска узла Tailscale настраивается exit node:

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

### Исходящие подключения через gVisor

Исходящие соединения проходят непосредственно через TCP/IP-стек gVisor:

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

### Предпочтительные маршруты

Tailscale объявляет предпочтительные домены и адреса на основе конфигурации WireGuard:

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

### Хук реконфигурации

При изменении конфигурации WireGuard обновляются маршрутные домены и префиксы:

```go
func (t *Endpoint) onReconfig(cfg *wgcfg.Config, routerCfg *router.Config, dnsCfg *tsDNS.Config) {
    // Обновить маршрутные домены из конфигурации DNS
    routeDomains := make(map[string]bool)
    for fqdn := range dnsCfg.Routes {
        routeDomains[fqdn.WithoutTrailingDot()] = true
    }
    t.routeDomains.Store(routeDomains)

    // Обновить маршрутные префиксы из AllowedIPs пиров
    var builder netipx.IPSetBuilder
    for _, peer := range cfg.Peers {
        for _, allowedIP := range peer.AllowedIPs {
            builder.AddPrefix(allowedIP)
        }
    }
    t.routePrefixes.Store(common.Must1(builder.IPSet()))
}
```

### Режим системного интерфейса

Tailscale может опционально создавать реальный TUN-интерфейс:

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

## Примеры конфигурации

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
