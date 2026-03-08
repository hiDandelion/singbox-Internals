# Система набора (Dialer)

Система Dialer -- это фабрика исходящих соединений. Она оборачивает `net.Dialer` Go протоколо-специфичными функциями: разрешение доменов, маршрутизация через detour, TCP Fast Open, привязка к интерфейсу и параллельные соединения.

**Исходный код**: `common/dialer/`

## Создание Dialer

```go
func New(ctx context.Context, options option.DialerOptions, isDomain bool) (N.Dialer, error)
```

Эта фабричная функция строит цепочку dialer на основе опций:

```
DefaultDialer → [ResolveDialer] → [DetourDialer]
     ↓
  BindInterface / RoutingMark / ProtectFunc
  TCP Fast Open
  Connect timeout
  Domain resolution (if isDomain)
```

## DefaultDialer

Базовый dialer оборачивает `net.Dialer` с платформенно-специфичными опциями сокетов:

```go
type DefaultDialer struct {
    dialer4           tcpDialer    // IPv4 dialer
    dialer6           tcpDialer    // IPv6 dialer
    udpDialer4        net.Dialer
    udpDialer6        net.Dialer
    udpAddr4          string
    udpAddr6          string
    isWireGuardListener bool
    networkManager    adapter.NetworkManager
    networkStrategy   *C.NetworkStrategy
}
```

Возможности:
- **Двойной стек**: Отдельные dialer для IPv4 и IPv6
- **Опции сокетов**: `SO_MARK`, `SO_BINDTODEVICE`, `IP_TRANSPARENT`
- **TCP Fast Open**: Через библиотеку `tfo-go`
- **Тайм-аут подключения**: `C.TCPConnectTimeout` (15 сек по умолчанию)

### Параллельный Dialer интерфейсов

Для мобильных устройств с несколькими сетевыми интерфейсами:

```go
type ParallelInterfaceDialer interface {
    DialParallelInterface(ctx, network, destination, strategy, networkType, fallbackType, fallbackDelay) (net.Conn, error)
    ListenSerialInterfacePacket(ctx, destination, strategy, networkType, fallbackType, fallbackDelay) (net.PacketConn, error)
}
```

Пробует различные сетевые интерфейсы в соответствии со стратегией (например, предпочитать WiFi, резервный -- сотовая связь с задержкой).

### Параллельный Dialer сетей

Параллельное подключение в стиле Happy Eyeballs для двойного стека:

```go
type ParallelNetworkDialer interface {
    DialParallelNetwork(ctx, network, destination, destinationAddresses, strategy, networkType, fallbackType, fallbackDelay) (net.Conn, error)
}
```

## DetourDialer

Маршрутизирует трафик через другой исходящий:

```go
type DetourDialer struct {
    outboundManager adapter.OutboundManager
    detour          string  // outbound tag to use
}

func (d *DetourDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    outbound, _ := d.outboundManager.Outbound(d.detour)
    return outbound.DialContext(ctx, network, destination)
}
```

Используется, когда исходящий указывает `detour` для цепочки через другой исходящий (например, VLESS -> direct).

## ResolveDialer

Оборачивает dialer для разрешения доменов перед подключением:

```go
type ResolveDialer struct {
    dialer    N.Dialer
    dnsRouter adapter.DNSRouter
    strategy  C.DomainStrategy
    server    string
}

func (d *ResolveDialer) DialContext(ctx, network, destination) (net.Conn, error) {
    if destination.IsFqdn() {
        addresses, err := d.dnsRouter.Lookup(ctx, destination.Fqdn, options)
        // Use resolved addresses with parallel dialing
        return N.DialSerial(ctx, d.dialer, network, destination, addresses)
    }
    return d.dialer.DialContext(ctx, network, destination)
}
```

## WireGuard Dialer

Специальный dialer для WireGuard, использующий сеть конечной точки WireGuard:

```go
type WireGuardDialer struct {
    dialer N.Dialer
}
```

## Последовательное/параллельное подключение

```go
// Try addresses one by one
func DialSerial(ctx, dialer, network, destination, addresses) (net.Conn, error)

// Try with network strategy (interface selection)
func DialSerialNetwork(ctx, dialer, network, destination, addresses,
    strategy, networkType, fallbackType, fallbackDelay) (net.Conn, error)

// Listen for packets with address selection
func ListenSerialNetworkPacket(ctx, dialer, destination, addresses,
    strategy, networkType, fallbackType, fallbackDelay) (net.PacketConn, netip.Addr, error)
```

## Опции Dialer

```go
type DialerOptions struct {
    Detour              string
    BindInterface       string
    Inet4BindAddress    *ListenAddress
    Inet6BindAddress    *ListenAddress
    ProtectPath         string
    RoutingMark         uint32
    ReuseAddr           bool
    ConnectTimeout      Duration
    TCPFastOpen         bool
    TCPMultiPath        bool
    UDPFragment         *bool
    UDPFragmentDefault  bool
    DomainResolver      *DomainResolveOptions
    NetworkStrategy     *NetworkStrategy
    NetworkType         Listable[InterfaceType]
    FallbackNetworkType Listable[InterfaceType]
    FallbackDelay       Duration
    IsWireGuardListener bool
}
```
