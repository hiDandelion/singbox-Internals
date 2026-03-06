# SSH, Tor, and Tailscale

These three protocols serve specialized networking roles: SSH provides TCP tunneling over SSH channels, Tor provides anonymous routing through the Tor network, and Tailscale provides WireGuard-based mesh networking via the Tailscale coordination service.

**Source**: `protocol/ssh/outbound.go`, `protocol/tor/outbound.go`, `protocol/tor/proxy.go`, `protocol/tailscale/endpoint.go`

## SSH Outbound

SSH tunneling uses Go's `golang.org/x/crypto/ssh` library to establish an SSH connection and create TCP tunnels through it.

### Architecture

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

### TCP-Only

SSH tunneling only supports TCP:

```go
outbound.NewAdapterWithDialerOptions(C.TypeSSH, tag, []string{N.NetworkTCP}, options.DialerOptions)

func (s *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    return nil, os.ErrInvalid
}
```

### Default Configuration

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

### Random Client Version

To avoid fingerprinting, a random SSH version string is generated:

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

### Authentication Methods

Multiple auth methods are supported:

```go
// Password authentication
if options.Password != "" {
    outbound.authMethod = append(outbound.authMethod, ssh.Password(options.Password))
}

// Private key authentication (with optional passphrase)
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

### Host Key Verification

```go
HostKeyCallback: func(hostname string, remote net.Addr, key ssh.PublicKey) error {
    if len(s.hostKey) == 0 {
        return nil  // Accept all keys
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

### Connection Reuse

The SSH client connection is shared across multiple tunnels:

```go
func (s *Outbound) connect() (*ssh.Client, error) {
    if s.client != nil {
        return s.client, nil  // Reuse existing connection
    }
    s.clientAccess.Lock()
    defer s.clientAccess.Unlock()

    // Double-check after acquiring lock
    if s.client != nil {
        return s.client, nil
    }

    conn, _ := s.dialer.DialContext(s.ctx, N.NetworkTCP, s.serverAddr)
    clientConn, chans, reqs, _ := ssh.NewClientConn(conn, s.serverAddr.Addr.String(), config)
    client := ssh.NewClient(clientConn, chans, reqs)

    s.clientConn = conn
    s.client = client

    // Monitor for disconnection
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

### Dialing Through SSH

```go
func (s *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    client, _ := s.connect()
    conn, _ := client.Dial(network, destination.String())
    return &chanConnWrapper{Conn: conn}, nil
}
```

The `chanConnWrapper` wraps `ssh.Channel` connections, disabling deadline operations (which SSH channels don't support).

### Interface Update

When the network interface changes, the SSH connection is closed so it can reconnect:

```go
func (s *Outbound) InterfaceUpdated() {
    common.Close(s.clientConn)
}
```

## Tor Outbound

Tor integration uses the `cretz/bine` library to manage an embedded Tor process and route connections through the Tor network.

### Architecture

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

### TCP-Only

```go
outbound.NewAdapterWithDialerOptions(C.TypeTor, tag, []string{N.NetworkTCP}, options.DialerOptions)
```

### Tor Configuration

```go
var startConf tor.StartConf
startConf.DataDir = os.ExpandEnv(options.DataDirectory)
startConf.TempDataDirBase = os.TempDir()
startConf.ExtraArgs = options.ExtraArgs

// Auto-detect GeoIP files in data directory
if geoIPPath := filepath.Join(dataDirAbs, "geoip"); rw.IsFile(geoIPPath) {
    options.ExtraArgs = append(options.ExtraArgs, "--GeoIPFile", geoIPPath)
}
```

### Proxy Listener (Upstream Bridge)

The key innovation is the `ProxyListener`: a local SOCKS5 proxy that bridges sing-box's dialer system to Tor. Tor is configured to use this local proxy as its upstream:

```go
proxy := NewProxyListener(ctx, logger, outboundDialer)
```

The proxy listener:
1. Listens on a random local port with random credentials
2. Accepts SOCKS5 connections from the Tor process
3. Routes them through the sing-box dialer (which handles detours, interfaces, etc.)

```go
type ProxyListener struct {
    ctx           context.Context
    logger        log.ContextLogger
    dialer        N.Dialer
    tcpListener   *net.TCPListener
    username      string         // random 64-byte hex
    password      string         // random 64-byte hex
    authenticator *auth.Authenticator
}
```

### Start Sequence

```go
func (t *Outbound) start() error {
    // 1. Start the Tor process
    torInstance, _ := tor.Start(t.ctx, t.startConf)

    // 2. Set up event logging
    torInstance.Control.AddEventListener(t.events, torLogEvents...)
    go t.recvLoop()

    // 3. Start the local proxy bridge
    t.proxy.Start()

    // 4. Configure Tor to use the local proxy
    confOptions := []*control.KeyVal{
        control.NewKeyVal("Socks5Proxy", "127.0.0.1:" + F.ToString(t.proxy.Port())),
        control.NewKeyVal("Socks5ProxyUsername", t.proxy.Username()),
        control.NewKeyVal("Socks5ProxyPassword", t.proxy.Password()),
    }
    torInstance.Control.ResetConf(confOptions...)

    // 5. Apply custom Tor options
    for key, value := range t.options {
        torInstance.Control.SetConf(control.NewKeyVal(key, value))
    }

    // 6. Enable the Tor network
    torInstance.EnableNetwork(t.ctx, true)

    // 7. Get the Tor SOCKS5 address
    info, _ := torInstance.Control.GetInfo("net/listeners/socks")
    t.socksClient = socks.NewClient(N.SystemDialer, M.ParseSocksaddr(info[0].Val), socks.Version5, "", "")
}
```

### Dialing Through Tor

```go
func (t *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    return t.socksClient.DialContext(ctx, network, destination)
}
```

## Tailscale Endpoint

Tailscale is implemented as a full **Endpoint** (like WireGuard), providing both inbound and outbound functionality. It uses `tsnet.Server` to run an embedded Tailscale node.

### Architecture

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
    stack             *stack.Stack          // gVisor network stack
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

### Network Support

Tailscale supports TCP, UDP, and ICMP:

```go
endpoint.NewAdapter(C.TypeTailscale, tag, []string{N.NetworkTCP, N.NetworkUDP, N.NetworkICMP}, nil)
```

### tsnet.Server Configuration

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

### Netstack Handlers

Tailscale uses gVisor's network stack. Inbound TCP/UDP connections are registered via netstack flow handlers:

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

### ICMP Forwarding

Tailscale sets up ICMP forwarding via gVisor's network stack:

```go
icmpForwarder := tun.NewICMPForwarder(t.ctx, ipStack, t, t.udpTimeout)
ipStack.SetTransportProtocolHandler(icmp.ProtocolNumber4, icmpForwarder.HandlePacket)
ipStack.SetTransportProtocolHandler(icmp.ProtocolNumber6, icmpForwarder.HandlePacket)
```

### Authentication and State Watching

The endpoint watches for authentication requirements and sends notifications on mobile platforms:

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

### Exit Node Support

After the Tailscale node is running, the exit node is configured:

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

### Outbound Dialing via gVisor

Outbound connections go through gVisor's TCP/IP stack directly:

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

### Preferred Routes

Tailscale advertises preferred domains and addresses based on the WireGuard configuration:

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

### Reconfiguration Hook

When the WireGuard configuration changes, route domains and prefixes are updated:

```go
func (t *Endpoint) onReconfig(cfg *wgcfg.Config, routerCfg *router.Config, dnsCfg *tsDNS.Config) {
    // Update route domains from DNS config
    routeDomains := make(map[string]bool)
    for fqdn := range dnsCfg.Routes {
        routeDomains[fqdn.WithoutTrailingDot()] = true
    }
    t.routeDomains.Store(routeDomains)

    // Update route prefixes from peer AllowedIPs
    var builder netipx.IPSetBuilder
    for _, peer := range cfg.Peers {
        for _, allowedIP := range peer.AllowedIPs {
            builder.AddPrefix(allowedIP)
        }
    }
    t.routePrefixes.Store(common.Must1(builder.IPSet()))
}
```

### System Interface Mode

Tailscale can optionally create a real TUN interface:

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

## Configuration Examples

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
