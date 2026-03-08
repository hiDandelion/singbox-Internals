# Протокол WireGuard

WireGuard в sing-box реализован как **Endpoint** (а не пара inbound/outbound), используя библиотеку `wireguard-go` с двумя бэкендами устройств: пользовательская сетевая подсистема gVisor или системный TUN. Endpoint поддерживает как входящий, так и исходящий трафик, обёртку NAT-устройства для ICMP/ping и DNS-разрешение пиров.

**Исходный код**: `protocol/wireguard/endpoint.go`, `transport/wireguard/endpoint.go`, `transport/wireguard/device.go`, `transport/wireguard/device_nat.go`

## Архитектура Endpoint

WireGuard использует паттерн `endpoint.Adapter`, который является комбинированным inbound+outbound:

```go
type Endpoint struct {
    endpoint.Adapter
    ctx            context.Context
    router         adapter.Router
    dnsRouter      adapter.DNSRouter
    logger         logger.ContextLogger
    localAddresses []netip.Prefix
    endpoint       *wireguard.Endpoint
}
```

Он реализует несколько интерфейсов:

```go
var (
    _ adapter.OutboundWithPreferredRoutes = (*Endpoint)(nil)
    _ dialer.PacketDialerWithDestination  = (*Endpoint)(nil)
)
```

### Поддержка сетей

WireGuard поддерживает TCP, UDP и ICMP:

```go
endpoint.NewAdapterWithDialerOptions(C.TypeWireGuard, tag,
    []string{N.NetworkTCP, N.NetworkUDP, N.NetworkICMP}, options.DialerOptions)
```

## Интерфейс устройства

Интерфейс `Device` абстрагирует различные реализации WireGuard-туннеля:

```go
type Device interface {
    wgTun.Device       // Чтение/запись пакетов
    N.Dialer           // DialContext / ListenPacket
    Start() error
    SetDevice(device *device.Device)
    Inet4Address() netip.Addr
    Inet6Address() netip.Addr
}
```

### Фабрика устройств

Фабрика `NewDevice` выбирает реализацию в зависимости от флага `System`:

```go
func NewDevice(options DeviceOptions) (Device, error) {
    if !options.System {
        return newStackDevice(options)        // Пользовательский стек gVisor
    } else if !tun.WithGVisor {
        return newSystemDevice(options)       // Системное TUN-устройство
    } else {
        return newSystemStackDevice(options)  // Системный TUN + стек gVisor
    }
}
```

- **Stack Device** (по умолчанию): Полностью пользовательский сетевой стек через gVisor. Не требует TUN-устройства ядра.
- **System Device**: Создаёт реальный TUN-интерфейс в ОС. Требует повышенных привилегий.
- **System Stack Device**: Системный TUN с gVisor для обработки пакетов.

## Обёртка NAT-устройства

`NatDevice` оборачивает `Device` для обеспечения поддержки ICMP/ping через перезапись адресов источника:

```go
type NatDevice interface {
    Device
    CreateDestination(metadata, routeContext, timeout) (tun.DirectRouteDestination, error)
}

type natDeviceWrapper struct {
    Device
    ctx            context.Context
    logger         logger.ContextLogger
    packetOutbound chan *buf.Buffer
    rewriter       *ping.SourceRewriter
    buffer         [][]byte
}
```

### Создание NAT-устройства

Если базовое устройство не поддерживает NAT нативно, применяется обёртка:

```go
tunDevice, _ := NewDevice(deviceOptions)
natDevice, isNatDevice := tunDevice.(NatDevice)
if !isNatDevice {
    natDevice = NewNATDevice(options.Context, options.Logger, tunDevice)
}
```

### Перехват пакетов

NAT-обёртка перехватывает чтение для инъекции исходящих ICMP-ответов и перехватывает запись для перезаписи адресов источника ICMP:

```go
func (d *natDeviceWrapper) Read(bufs [][]byte, sizes []int, offset int) (n int, err error) {
    select {
    case packet := <-d.packetOutbound:
        defer packet.Release()
        sizes[0] = copy(bufs[0][offset:], packet.Bytes())
        return 1, nil
    default:
    }
    return d.Device.Read(bufs, sizes, offset)
}

func (d *natDeviceWrapper) Write(bufs [][]byte, offset int) (int, error) {
    for _, buffer := range bufs {
        handled, err := d.rewriter.WriteBack(buffer[offset:])
        if handled {
            // ICMP-ответ обработан внутренне
        } else {
            d.buffer = append(d.buffer, buffer)
        }
    }
    // Переслать не-ICMP пакеты на реальное устройство
    d.Device.Write(d.buffer, offset)
}
```

## Endpoint транспортного уровня

`transport/wireguard/endpoint.go` управляет жизненным циклом WireGuard-устройства:

```go
type Endpoint struct {
    options        EndpointOptions
    peers          []peerConfig
    ipcConf        string
    allowedAddress []netip.Prefix
    tunDevice      Device
    natDevice      NatDevice
    device         *device.Device
    allowedIPs     *device.AllowedIPs
}
```

### Конфигурация IPC

Конфигурация WireGuard передаётся в `wireguard-go` через строки IPC-протокола:

```go
privateKeyBytes, _ := base64.StdEncoding.DecodeString(options.PrivateKey)
privateKey := hex.EncodeToString(privateKeyBytes)
ipcConf := "private_key=" + privateKey
if options.ListenPort != 0 {
    ipcConf += "\nlisten_port=" + F.ToString(options.ListenPort)
}
```

Конфигурация пиров генерируется аналогично:

```go
func (c peerConfig) GenerateIpcLines() string {
    ipcLines := "\npublic_key=" + c.publicKeyHex
    if c.endpoint.IsValid() {
        ipcLines += "\nendpoint=" + c.endpoint.String()
    }
    if c.preSharedKeyHex != "" {
        ipcLines += "\npreshared_key=" + c.preSharedKeyHex
    }
    for _, allowedIP := range c.allowedIPs {
        ipcLines += "\nallowed_ip=" + allowedIP.String()
    }
    if c.keepalive > 0 {
        ipcLines += "\npersistent_keepalive_interval=" + F.ToString(c.keepalive)
    }
    return ipcLines
}
```

### Двухфазный запуск

Endpoint имеет двухфазный запуск для обработки DNS-разрешения endpoint'ов пиров:

```go
func (w *Endpoint) Start(stage adapter.StartStage) error {
    switch stage {
    case adapter.StartStateStart:
        return w.endpoint.Start(false)   // Запуск без DNS-разрешения
    case adapter.StartStatePostStart:
        return w.endpoint.Start(true)    // Теперь разрешить домены пиров
    }
}
```

Если пиры имеют FQDN-endpoint'ы, разрешение откладывается до `PostStart`, когда DNS доступен:

```go
ResolvePeer: func(domain string) (netip.Addr, error) {
    endpointAddresses, _ := ep.dnsRouter.Lookup(ctx, domain, outboundDialer.(dialer.ResolveDialer).QueryOptions())
    return endpointAddresses[0], nil
},
```

### Зарезервированные байты

WireGuard поддерживает зарезервированные байты для каждого пира (используются некоторыми реализациями, такими как Cloudflare WARP):

```go
if len(rawPeer.Reserved) > 0 {
    if len(rawPeer.Reserved) != 3 {
        return nil, E.New("invalid reserved value, required 3 bytes")
    }
    copy(peer.reserved[:], rawPeer.Reserved[:])
}
```

### Выбор привязки (Bind)

Endpoint использует различные реализации привязки в зависимости от типа dialer'а:

```go
wgListener, isWgListener := common.Cast[dialer.WireGuardListener](e.options.Dialer)
if isWgListener {
    bind = conn.NewStdNetBind(wgListener.WireGuardControl())
} else {
    // ClientBind для соединений с одним пиром
    bind = NewClientBind(ctx, logger, dialer, isConnect, connectAddr, reserved)
}
```

## Endpoint уровня протокола

`protocol/wireguard/endpoint.go` обрабатывает интеграцию маршрутизации:

### Перезапись локальных адресов

Соединения на собственный адрес WireGuard-endpoint'а перезаписываются на loopback:

```go
func (w *Endpoint) NewConnectionEx(ctx, conn, source, destination, onClose) {
    for _, localPrefix := range w.localAddresses {
        if localPrefix.Contains(destination.Addr) {
            metadata.OriginDestination = destination
            if destination.Addr.Is4() {
                destination.Addr = netip.AddrFrom4([4]uint8{127, 0, 0, 1})
            } else {
                destination.Addr = netip.IPv6Loopback()
            }
            break
        }
    }
}
```

### DNS-разрешение исходящих соединений

Исходящее соединение разрешает FQDN через DNS-маршрутизатор:

```go
func (w *Endpoint) DialContext(ctx, network, destination) (net.Conn, error) {
    if destination.IsFqdn() {
        destinationAddresses, _ := w.dnsRouter.Lookup(ctx, destination.Fqdn, adapter.DNSQueryOptions{})
        return N.DialSerial(ctx, w.endpoint, network, destination, destinationAddresses)
    }
    return w.endpoint.DialContext(ctx, network, destination)
}
```

### Предпочтительные маршруты

Endpoint объявляет, какие адреса он может маршрутизировать, позволяя маршрутизатору выбирать его для соответствующих назначений:

```go
func (w *Endpoint) PreferredAddress(address netip.Addr) bool {
    return w.endpoint.Lookup(address) != nil
}
```

### Интеграция менеджера паузы

Endpoint реагирует на события паузы/пробуждения устройства (например, спящий режим мобильного):

```go
func (e *Endpoint) onPauseUpdated(event int) {
    switch event {
    case pause.EventDevicePaused, pause.EventNetworkPause:
        e.device.Down()
    case pause.EventDeviceWake, pause.EventNetworkWake:
        e.device.Up()
    }
}
```

## Пример конфигурации

```json
{
  "type": "wireguard",
  "tag": "wg-ep",
  "system": false,
  "name": "wg0",
  "mtu": 1420,
  "address": ["10.0.0.2/32", "fd00::2/128"],
  "private_key": "base64-encoded-private-key",
  "peers": [
    {
      "address": "server.example.com",
      "port": 51820,
      "public_key": "base64-encoded-public-key",
      "pre_shared_key": "optional-base64-psk",
      "allowed_ips": ["0.0.0.0/0", "::/0"],
      "persistent_keepalive_interval": 25,
      "reserved": [0, 0, 0]
    }
  ],
  "workers": 2
}
```
