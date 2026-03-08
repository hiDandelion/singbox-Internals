# SSH、Tor 和 Tailscale

这三个协议提供专用的网络功能：SSH 通过 SSH 通道提供 TCP 隧道，Tor 通过 Tor 网络提供匿名路由，Tailscale 通过 Tailscale 协调服务提供基于 WireGuard 的 mesh 网络。

**源码**: `protocol/ssh/outbound.go`, `protocol/tor/outbound.go`, `protocol/tor/proxy.go`, `protocol/tailscale/endpoint.go`

## SSH Outbound

SSH 隧道使用 Go 的 `golang.org/x/crypto/ssh` 库建立 SSH 连接并通过它创建 TCP 隧道。

### 架构

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

### 仅 TCP

SSH 隧道仅支持 TCP：

```go
outbound.NewAdapterWithDialerOptions(C.TypeSSH, tag, []string{N.NetworkTCP}, options.DialerOptions)

func (s *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    return nil, os.ErrInvalid
}
```

### 默认配置

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

### 随机客户端版本

为避免指纹识别，会生成随机的 SSH 版本字符串：

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

### 认证方法

支持多种认证方法：

```go
// 密码认证
if options.Password != "" {
    outbound.authMethod = append(outbound.authMethod, ssh.Password(options.Password))
}

// 私钥认证（带可选密码短语）
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

### 主机密钥验证

```go
HostKeyCallback: func(hostname string, remote net.Addr, key ssh.PublicKey) error {
    if len(s.hostKey) == 0 {
        return nil  // 接受所有密钥
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

### 连接复用

SSH 客户端连接在多个隧道间共享：

```go
func (s *Outbound) connect() (*ssh.Client, error) {
    if s.client != nil {
        return s.client, nil  // 复用现有连接
    }
    s.clientAccess.Lock()
    defer s.clientAccess.Unlock()

    // 获取锁后双重检查
    if s.client != nil {
        return s.client, nil
    }

    conn, _ := s.dialer.DialContext(s.ctx, N.NetworkTCP, s.serverAddr)
    clientConn, chans, reqs, _ := ssh.NewClientConn(conn, s.serverAddr.Addr.String(), config)
    client := ssh.NewClient(clientConn, chans, reqs)

    s.clientConn = conn
    s.client = client

    // 监控断开连接
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

### 通过 SSH 拨号

```go
func (s *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    client, _ := s.connect()
    conn, _ := client.Dial(network, destination.String())
    return &chanConnWrapper{Conn: conn}, nil
}
```

`chanConnWrapper` 包装 `ssh.Channel` 连接，禁用 deadline 操作（SSH channel 不支持）。

### 网络接口更新

当网络接口变化时，SSH 连接被关闭以便重新连接：

```go
func (s *Outbound) InterfaceUpdated() {
    common.Close(s.clientConn)
}
```

## Tor Outbound

Tor 集成使用 `cretz/bine` 库管理嵌入式 Tor 进程，并通过 Tor 网络路由连接。

### 架构

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

### 仅 TCP

```go
outbound.NewAdapterWithDialerOptions(C.TypeTor, tag, []string{N.NetworkTCP}, options.DialerOptions)
```

### Tor 配置

```go
var startConf tor.StartConf
startConf.DataDir = os.ExpandEnv(options.DataDirectory)
startConf.TempDataDirBase = os.TempDir()
startConf.ExtraArgs = options.ExtraArgs

// 在数据目录中自动检测 GeoIP 文件
if geoIPPath := filepath.Join(dataDirAbs, "geoip"); rw.IsFile(geoIPPath) {
    options.ExtraArgs = append(options.ExtraArgs, "--GeoIPFile", geoIPPath)
}
```

### 代理监听器（上游桥接）

关键创新是 `ProxyListener`：一个本地 SOCKS5 代理，用于将 sing-box 的拨号器系统桥接到 Tor。Tor 被配置为使用此本地代理作为上游：

```go
proxy := NewProxyListener(ctx, logger, outboundDialer)
```

该代理监听器：
1. 在随机本地端口上监听，使用随机凭据
2. 接受来自 Tor 进程的 SOCKS5 连接
3. 通过 sing-box 拨号器路由它们（处理 detour、接口等）

```go
type ProxyListener struct {
    ctx           context.Context
    logger        log.ContextLogger
    dialer        N.Dialer
    tcpListener   *net.TCPListener
    username      string         // 随机 64 字节十六进制
    password      string         // 随机 64 字节十六进制
    authenticator *auth.Authenticator
}
```

### 启动序列

```go
func (t *Outbound) start() error {
    // 1. 启动 Tor 进程
    torInstance, _ := tor.Start(t.ctx, t.startConf)

    // 2. 设置事件日志
    torInstance.Control.AddEventListener(t.events, torLogEvents...)
    go t.recvLoop()

    // 3. 启动本地代理桥接
    t.proxy.Start()

    // 4. 配置 Tor 使用本地代理
    confOptions := []*control.KeyVal{
        control.NewKeyVal("Socks5Proxy", "127.0.0.1:" + F.ToString(t.proxy.Port())),
        control.NewKeyVal("Socks5ProxyUsername", t.proxy.Username()),
        control.NewKeyVal("Socks5ProxyPassword", t.proxy.Password()),
    }
    torInstance.Control.ResetConf(confOptions...)

    // 5. 应用自定义 Tor 选项
    for key, value := range t.options {
        torInstance.Control.SetConf(control.NewKeyVal(key, value))
    }

    // 6. 启用 Tor 网络
    torInstance.EnableNetwork(t.ctx, true)

    // 7. 获取 Tor SOCKS5 地址
    info, _ := torInstance.Control.GetInfo("net/listeners/socks")
    t.socksClient = socks.NewClient(N.SystemDialer, M.ParseSocksaddr(info[0].Val), socks.Version5, "", "")
}
```

### 通过 Tor 拨号

```go
func (t *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    return t.socksClient.DialContext(ctx, network, destination)
}
```

## Tailscale Endpoint

Tailscale 以完整的 **Endpoint**（类似 WireGuard）实现，同时提供 inbound 和 outbound 功能。它使用 `tsnet.Server` 运行嵌入式 Tailscale 节点。

### 架构

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
    stack             *stack.Stack          // gVisor 网络栈
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

### 网络支持

Tailscale 支持 TCP、UDP 和 ICMP：

```go
endpoint.NewAdapter(C.TypeTailscale, tag, []string{N.NetworkTCP, N.NetworkUDP, N.NetworkICMP}, nil)
```

### tsnet.Server 配置

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

### Netstack 处理器

Tailscale 使用 gVisor 的网络栈。入站 TCP/UDP 连接通过 netstack 流处理器注册：

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

### ICMP 转发

Tailscale 通过 gVisor 的网络栈设置 ICMP 转发：

```go
icmpForwarder := tun.NewICMPForwarder(t.ctx, ipStack, t, t.udpTimeout)
ipStack.SetTransportProtocolHandler(icmp.ProtocolNumber4, icmpForwarder.HandlePacket)
ipStack.SetTransportProtocolHandler(icmp.ProtocolNumber6, icmpForwarder.HandlePacket)
```

### 认证和状态监视

endpoint 监视认证需求，并在移动平台上发送通知：

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

### Exit Node 支持

Tailscale 节点运行后，配置 exit node：

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

### 通过 gVisor 的出站拨号

出站连接直接通过 gVisor 的 TCP/IP 栈：

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

### 首选路由

Tailscale 根据 WireGuard 配置通告首选域名和地址：

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

### 重配置钩子

当 WireGuard 配置变更时，路由域名和前缀会更新：

```go
func (t *Endpoint) onReconfig(cfg *wgcfg.Config, routerCfg *router.Config, dnsCfg *tsDNS.Config) {
    // 从 DNS 配置更新路由域名
    routeDomains := make(map[string]bool)
    for fqdn := range dnsCfg.Routes {
        routeDomains[fqdn.WithoutTrailingDot()] = true
    }
    t.routeDomains.Store(routeDomains)

    // 从对等节点 AllowedIPs 更新路由前缀
    var builder netipx.IPSetBuilder
    for _, peer := range cfg.Peers {
        for _, allowedIP := range peer.AllowedIPs {
            builder.AddPrefix(allowedIP)
        }
    }
    t.routePrefixes.Store(common.Must1(builder.IPSet()))
}
```

### 系统接口模式

Tailscale 可以选择性地创建真实的 TUN 接口：

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

## 配置示例

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
