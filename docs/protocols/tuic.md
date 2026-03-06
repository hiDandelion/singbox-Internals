# TUIC Protocol

TUIC is a QUIC-based proxy protocol featuring UUID authentication, configurable congestion control, and two distinct UDP relay modes. sing-box delegates the protocol implementation to `sing-quic/tuic`.

**Source**: `protocol/tuic/inbound.go`, `protocol/tuic/outbound.go`, `sing-quic/tuic`

## Architecture Overview

```go
// Inbound
type Inbound struct {
    inbound.Adapter
    router       adapter.ConnectionRouterEx
    logger       log.ContextLogger
    listener     *listener.Listener
    tlsConfig    tls.ServerConfig
    server       *tuic.Service[int]
    userNameList []string
}

// Outbound
type Outbound struct {
    outbound.Adapter
    logger    logger.ContextLogger
    client    *tuic.Client
    udpStream bool
}
```

## TLS Requirement

Like Hysteria2, TUIC requires TLS on both sides:

```go
if options.TLS == nil || !options.TLS.Enabled {
    return nil, C.ErrTLSRequired
}
```

## UUID-Based Authentication

Users are authenticated via UUID + password pairs. The UUID is parsed from string format:

```go
var userUUIDList [][16]byte
for index, user := range options.Users {
    userUUID, err := uuid.FromString(user.UUID)
    if err != nil {
        return nil, E.Cause(err, "invalid uuid for user ", index)
    }
    userUUIDList = append(userUUIDList, userUUID)
    userPasswordList = append(userPasswordList, user.Password)
}
service.UpdateUsers(userList, userUUIDList, userPasswordList)
```

The outbound similarly uses a single UUID + password:

```go
userUUID, err := uuid.FromString(options.UUID)
client, _ := tuic.NewClient(tuic.ClientOptions{
    UUID:     userUUID,
    Password: options.Password,
    // ...
})
```

## Congestion Control

TUIC supports configurable congestion control algorithms:

```go
service, _ := tuic.NewService[int](tuic.ServiceOptions{
    CongestionControl: options.CongestionControl,
    // ...
})
```

The `CongestionControl` field accepts algorithm names (e.g., "bbr", "cubic"). This applies to both inbound and outbound.

## Zero-RTT Handshake

TUIC supports 0-RTT QUIC handshake for reduced latency:

```go
tuic.ServiceOptions{
    ZeroRTTHandshake: options.ZeroRTTHandshake,
    // ...
}
```

## Authentication Timeout and Heartbeat

```go
tuic.ServiceOptions{
    AuthTimeout: time.Duration(options.AuthTimeout),
    Heartbeat:   time.Duration(options.Heartbeat),
    // ...
}
```

- **AuthTimeout**: Time limit for client to complete authentication after QUIC handshake
- **Heartbeat**: Keep-alive interval to maintain the QUIC connection

## UDP Relay Modes

TUIC has two UDP relay modes, configured only on the outbound:

### Native Mode (default)

Each UDP packet is sent as an individual QUIC datagram. This is the most efficient mode but requires QUIC datagram support:

```go
case "native":
    // tuicUDPStream remains false
```

### QUIC Stream Mode

UDP packets are serialized over a QUIC stream. This mode works when QUIC datagrams are not available:

```go
case "quic":
    tuicUDPStream = true
```

### UDP-over-Stream Mode

A third option (`udp_over_stream`) uses UoT (UDP-over-TCP) encoding. This is mutually exclusive with `udp_relay_mode`:

```go
if options.UDPOverStream && options.UDPRelayMode != "" {
    return nil, E.New("udp_over_stream is conflict with udp_relay_mode")
}
```

When `udp_over_stream` is active, UDP connections are tunneled through a TCP-like stream using the `uot` package:

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    case N.NetworkUDP:
        if h.udpStream {
            streamConn, _ := h.client.DialConn(ctx, uot.RequestDestination(uot.Version))
            return uot.NewLazyConn(streamConn, uot.Request{
                IsConnect:   true,
                Destination: destination,
            }), nil
        }
}
```

## UoT Router (Inbound)

The inbound wraps its router with UoT support for handling UDP-over-TCP connections:

```go
inbound.router = uot.NewRouter(router, logger)
```

## Listener Model

Like Hysteria2, TUIC listens on UDP:

```go
func (h *Inbound) Start(stage adapter.StartStage) error {
    h.tlsConfig.Start()
    packetConn, _ := h.listener.ListenUDP()
    return h.server.Start(packetConn)
}
```

## Connection Handling

Standard sing-box TCP/UDP connection routing with user extraction from context:

```go
func (h *Inbound) NewConnectionEx(ctx, conn, source, destination, onClose) {
    userID, _ := auth.UserFromContext[int](ctx)
    if userName := h.userNameList[userID]; userName != "" {
        metadata.User = userName
    }
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## Outbound Connections

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    switch N.NetworkName(network) {
    case N.NetworkTCP:
        return h.client.DialConn(ctx, destination)
    case N.NetworkUDP:
        if h.udpStream {
            // UoT path
        } else {
            conn, _ := h.ListenPacket(ctx, destination)
            return bufio.NewBindPacketConn(conn, destination), nil
        }
    }
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    if h.udpStream {
        streamConn, _ := h.client.DialConn(ctx, uot.RequestDestination(uot.Version))
        return uot.NewLazyConn(streamConn, uot.Request{
            IsConnect:   false,
            Destination: destination,
        }), nil
    }
    return h.client.ListenPacket(ctx)
}
```

## Interface Update

Like Hysteria2, TUIC closes the QUIC connection on network changes:

```go
func (h *Outbound) InterfaceUpdated() {
    _ = h.client.CloseWithError(E.New("network changed"))
}
```

## Configuration Examples

### Inbound

```json
{
  "type": "tuic",
  "tag": "tuic-in",
  "listen": "::",
  "listen_port": 443,
  "users": [
    {
      "name": "user1",
      "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
      "password": "user-password"
    }
  ],
  "congestion_control": "bbr",
  "zero_rtt_handshake": true,
  "auth_timeout": "3s",
  "heartbeat": "10s",
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  }
}
```

### Outbound (Native UDP)

```json
{
  "type": "tuic",
  "tag": "tuic-out",
  "server": "example.com",
  "server_port": 443,
  "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
  "password": "user-password",
  "congestion_control": "bbr",
  "udp_relay_mode": "native",
  "zero_rtt_handshake": true,
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```

### Outbound (UDP over Stream)

```json
{
  "type": "tuic",
  "tag": "tuic-uot",
  "server": "example.com",
  "server_port": 443,
  "uuid": "b831381d-6324-4d53-ad4f-8cda48b30811",
  "password": "user-password",
  "udp_over_stream": true,
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  }
}
```
