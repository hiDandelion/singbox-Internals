# Hysteria2 Protocol

Hysteria2 is a QUIC-based proxy protocol featuring bandwidth negotiation via the Brutal congestion control algorithm, Salamander obfuscation, and HTTP/3 masquerading. sing-box delegates the protocol implementation to `sing-quic/hysteria2`.

**Source**: `protocol/hysteria2/inbound.go`, `protocol/hysteria2/outbound.go`, `sing-quic/hysteria2`

## Architecture Overview

Both inbound and outbound are thin wrappers around the `sing-quic/hysteria2` library:

```go
// Inbound
type Inbound struct {
    inbound.Adapter
    router       adapter.Router
    logger       log.ContextLogger
    listener     *listener.Listener
    tlsConfig    tls.ServerConfig
    service      *hysteria2.Service[int]
    userNameList []string
}

// Outbound
type Outbound struct {
    outbound.Adapter
    logger logger.ContextLogger
    client *hysteria2.Client
}
```

## TLS Requirement

Hysteria2 unconditionally requires TLS on both sides:

```go
if options.TLS == nil || !options.TLS.Enabled {
    return nil, C.ErrTLSRequired
}
```

## Salamander Obfuscation

Salamander is the only supported obfuscation type. It wraps QUIC packets in a layer of obfuscation to prevent deep packet inspection from identifying them as QUIC:

```go
var salamanderPassword string
if options.Obfs != nil {
    if options.Obfs.Password == "" {
        return nil, E.New("missing obfs password")
    }
    switch options.Obfs.Type {
    case hysteria2.ObfsTypeSalamander:
        salamanderPassword = options.Obfs.Password
    default:
        return nil, E.New("unknown obfs type: ", options.Obfs.Type)
    }
}
```

When Salamander is enabled, the password must match between client and server.

## Bandwidth Negotiation (Brutal CC)

Hysteria2's core feature is its Brutal congestion control algorithm, which requires the client to declare its bandwidth. The server can also set bandwidth limits:

```go
service, err := hysteria2.NewService[int](hysteria2.ServiceOptions{
    Context:               ctx,
    Logger:                logger,
    BrutalDebug:           options.BrutalDebug,
    SendBPS:               uint64(options.UpMbps * hysteria.MbpsToBps),
    ReceiveBPS:            uint64(options.DownMbps * hysteria.MbpsToBps),
    SalamanderPassword:    salamanderPassword,
    TLSConfig:             tlsConfig,
    IgnoreClientBandwidth: options.IgnoreClientBandwidth,
    UDPTimeout:            udpTimeout,
    Handler:               inbound,
    MasqueradeHandler:     masqueradeHandler,
})
```

Key bandwidth fields:

- **SendBPS / ReceiveBPS**: Server's send and receive bandwidth in bits per second, converted from Mbps using `hysteria.MbpsToBps`
- **IgnoreClientBandwidth**: When true, the server ignores client-declared bandwidth and uses its own settings
- **BrutalDebug**: Enables debug logging for congestion control

The outbound similarly declares its bandwidth:

```go
client, err := hysteria2.NewClient(hysteria2.ClientOptions{
    SendBPS:    uint64(options.UpMbps * hysteria.MbpsToBps),
    ReceiveBPS: uint64(options.DownMbps * hysteria.MbpsToBps),
    // ...
})
```

## Masquerade

When non-Hysteria2 traffic arrives (e.g., a web browser), the inbound can serve a masquerade response. Three masquerade types are supported:

### File Server
```go
case C.Hysterai2MasqueradeTypeFile:
    masqueradeHandler = http.FileServer(http.Dir(options.Masquerade.FileOptions.Directory))
```

### Reverse Proxy
```go
case C.Hysterai2MasqueradeTypeProxy:
    masqueradeURL, _ := url.Parse(options.Masquerade.ProxyOptions.URL)
    masqueradeHandler = &httputil.ReverseProxy{
        Rewrite: func(r *httputil.ProxyRequest) {
            r.SetURL(masqueradeURL)
            if !options.Masquerade.ProxyOptions.RewriteHost {
                r.Out.Host = r.In.Host
            }
        },
    }
```

### Static String
```go
case C.Hysterai2MasqueradeTypeString:
    masqueradeHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if options.Masquerade.StringOptions.StatusCode != 0 {
            w.WriteHeader(options.Masquerade.StringOptions.StatusCode)
        }
        w.Write([]byte(options.Masquerade.StringOptions.Content))
    })
```

## Port Hopping

The outbound supports port hopping -- connecting to multiple server ports to evade per-port throttling:

```go
client, err := hysteria2.NewClient(hysteria2.ClientOptions{
    ServerAddress: options.ServerOptions.Build(),
    ServerPorts:   options.ServerPorts,         // port range list
    HopInterval:   time.Duration(options.HopInterval),  // how often to switch ports
    // ...
})
```

## Listener Model

Unlike TCP-based protocols, Hysteria2 listens on UDP (QUIC). The inbound starts by listening for UDP packets and passing them to the QUIC service:

```go
func (h *Inbound) Start(stage adapter.StartStage) error {
    if stage != adapter.StartStateStart {
        return nil
    }
    h.tlsConfig.Start()
    packetConn, err := h.listener.ListenUDP()
    if err != nil {
        return err
    }
    return h.service.Start(packetConn)
}
```

## User Management

Users are identified by integer index, with a parallel name list for logging:

```go
userList := make([]int, 0, len(options.Users))
userNameList := make([]string, 0, len(options.Users))
userPasswordList := make([]string, 0, len(options.Users))
for index, user := range options.Users {
    userList = append(userList, index)
    userNameList = append(userNameList, user.Name)
    userPasswordList = append(userPasswordList, user.Password)
}
service.UpdateUsers(userList, userPasswordList)
```

Authentication uses the user index stored in context:

```go
userID, _ := auth.UserFromContext[int](ctx)
if userName := h.userNameList[userID]; userName != "" {
    metadata.User = userName
}
```

## Connection Handling

Both TCP and UDP connections follow the standard sing-box pattern:

```go
func (h *Inbound) NewConnectionEx(ctx, conn, source, destination, onClose) {
    // Set metadata fields
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}

func (h *Inbound) NewPacketConnectionEx(ctx, conn, source, destination, onClose) {
    // Set metadata fields
    h.router.RoutePacketConnectionEx(ctx, conn, metadata, onClose)
}
```

## Outbound Connection

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    switch N.NetworkName(network) {
    case N.NetworkTCP:
        return h.client.DialConn(ctx, destination)
    case N.NetworkUDP:
        conn, err := h.ListenPacket(ctx, destination)
        return bufio.NewBindPacketConn(conn, destination), nil
    }
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    return h.client.ListenPacket(ctx)
}
```

## Interface Update

The outbound implements `adapter.InterfaceUpdateListener` to handle network changes by closing the QUIC connection:

```go
func (h *Outbound) InterfaceUpdated() {
    h.client.CloseWithError(E.New("network changed"))
}
```

## Configuration Examples

### Inbound

```json
{
  "type": "hysteria2",
  "tag": "hy2-in",
  "listen": "::",
  "listen_port": 443,
  "up_mbps": 100,
  "down_mbps": 100,
  "obfs": {
    "type": "salamander",
    "password": "obfs-password"
  },
  "users": [
    { "name": "user1", "password": "user-password" }
  ],
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  },
  "masquerade": {
    "type": "proxy",
    "proxy": {
      "url": "https://www.example.com",
      "rewrite_host": true
    }
  }
}
```

### Outbound

```json
{
  "type": "hysteria2",
  "tag": "hy2-out",
  "server": "example.com",
  "server_port": 443,
  "up_mbps": 50,
  "down_mbps": 100,
  "password": "user-password",
  "obfs": {
    "type": "salamander",
    "password": "obfs-password"
  },
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```

### With Port Hopping

```json
{
  "type": "hysteria2",
  "tag": "hy2-hop",
  "server": "example.com",
  "server_ports": "443,8443-8500",
  "hop_interval": "30s",
  "password": "user-password",
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```
