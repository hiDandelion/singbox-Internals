# Исходящие соединения Direct, Block и DNS

Эти три типа исходящих соединений выполняют фундаментальные функции маршрутизации: `direct` подключается к назначению без прокси, `block` отклоняет все соединения, а `dns` перехватывает DNS-трафик для внутреннего разрешения.

**Исходный код**: `protocol/direct/outbound.go`, `protocol/direct/inbound.go`, `protocol/direct/loopback_detect.go`, `protocol/block/outbound.go`, `protocol/dns/outbound.go`, `protocol/dns/handle.go`

## Исходящее соединение Direct (Outbound)

### Архитектура

```go
type Outbound struct {
    outbound.Adapter
    ctx            context.Context
    logger         logger.ContextLogger
    dialer         dialer.ParallelInterfaceDialer
    domainStrategy C.DomainStrategy
    fallbackDelay  time.Duration
    isEmpty        bool
}
```

Исходящее соединение direct реализует несколько интерфейсов dialer'а:

```go
var (
    _ N.ParallelDialer             = (*Outbound)(nil)
    _ dialer.ParallelNetworkDialer = (*Outbound)(nil)
    _ dialer.DirectDialer          = (*Outbound)(nil)
    _ adapter.DirectRouteOutbound  = (*Outbound)(nil)
)
```

### Поддержка сетей

Direct поддерживает TCP, UDP и ICMP (для ping/traceroute):

```go
outbound.NewAdapterWithDialerOptions(C.TypeDirect, tag,
    []string{N.NetworkTCP, N.NetworkUDP, N.NetworkICMP}, options.DialerOptions)
```

### Ограничение Detour

Исходящее соединение direct не может использовать detour (это было бы циклическим):

```go
if options.Detour != "" {
    return nil, E.New("`detour` is not supported in direct context")
}
```

### Обнаружение пустой конфигурации (IsEmpty)

Исходящее соединение direct отслеживает, имеет ли оно нестандартную конфигурацию. Это используется маршрутизатором для оптимизации решений маршрутизации:

```go
outbound.isEmpty = reflect.DeepEqual(options.DialerOptions, option.DialerOptions{UDPFragmentDefault: true})
```

### Установка соединения

```go
func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    ctx, metadata := adapter.ExtendContext(ctx)
    metadata.Outbound = h.Tag()
    metadata.Destination = destination
    return h.dialer.DialContext(ctx, network, destination)
}
```

### Параллельное подключение

Исходящее соединение direct поддерживает Happy Eyeballs (параллельные попытки подключения IPv4/IPv6):

```go
func (h *Outbound) DialParallel(ctx, network, destination, destinationAddresses) (net.Conn, error) {
    return dialer.DialParallelNetwork(ctx, h.dialer, network, destination,
        destinationAddresses, destinationAddresses[0].Is6(), nil, nil, nil, h.fallbackDelay)
}
```

### ICMP / Прямой маршрут

Исходящее соединение direct поддерживает ICMP-соединения для ping/traceroute через интерфейс `DirectRouteOutbound`:

```go
func (h *Outbound) NewDirectRouteConnection(metadata, routeContext, timeout) (tun.DirectRouteDestination, error) {
    destination, _ := ping.ConnectDestination(ctx, h.logger,
        common.MustCast[*dialer.DefaultDialer](h.dialer).DialerForICMPDestination(metadata.Destination.Addr).Control,
        metadata.Destination.Addr, routeContext, timeout)
    return destination, nil
}
```

### Подключение с сетевой стратегией

Исходящее соединение поддерживает расширенные опции сетевой стратегии для многопутевых соединений:

```go
func (h *Outbound) DialParallelNetwork(ctx, network, destination, destinationAddresses,
    networkStrategy, networkType, fallbackNetworkType, fallbackDelay) (net.Conn, error) {
    return dialer.DialParallelNetwork(ctx, h.dialer, network, destination,
        destinationAddresses, destinationAddresses[0].Is6(),
        networkStrategy, networkType, fallbackNetworkType, fallbackDelay)
}
```

## Входящее соединение Direct (Inbound)

Входящее соединение direct принимает сырые TCP/UDP-соединения и маршрутизирует их с опциональным переопределением назначения:

```go
type Inbound struct {
    inbound.Adapter
    overrideOption      int    // 0=нет, 1=адрес+порт, 2=адрес, 3=порт
    overrideDestination M.Socksaddr
}
```

### Опции переопределения

```go
if options.OverrideAddress != "" && options.OverridePort != 0 {
    inbound.overrideOption = 1  // Заменить и адрес, и порт
} else if options.OverrideAddress != "" {
    inbound.overrideOption = 2  // Заменить только адрес
} else if options.OverridePort != 0 {
    inbound.overrideOption = 3  // Заменить только порт
}
```

## Обнаружение петель (Loopback)

`loopBackDetector` предотвращает петли маршрутизации, отслеживая соединения:

```go
type loopBackDetector struct {
    networkManager   adapter.NetworkManager
    connMap          map[netip.AddrPort]netip.AddrPort    // TCP
    packetConnMap    map[uint16]uint16                     // UDP (по портам)
}
```

Он оборачивает исходящие соединения и проверяет входящие соединения по карте:

```go
func (l *loopBackDetector) CheckConn(source, local netip.AddrPort) bool {
    destination, loaded := l.connMap[source]
    return loaded && destination != local
}
```

Примечание: Обнаружение петель в настоящее время закомментировано в исходном коде, но инфраструктура сохранена.

## Исходящее соединение Block (Outbound)

Простейшее исходящее соединение — оно отклоняет все соединения с `EPERM`:

```go
type Outbound struct {
    outbound.Adapter
    logger logger.ContextLogger
}

func New(ctx, router, logger, tag, _ option.StubOptions) (adapter.Outbound, error) {
    return &Outbound{
        Adapter: outbound.NewAdapter(C.TypeBlock, tag, []string{N.NetworkTCP, N.NetworkUDP}, nil),
        logger:  logger,
    }, nil
}

func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    h.logger.InfoContext(ctx, "blocked connection to ", destination)
    return nil, syscall.EPERM
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    h.logger.InfoContext(ctx, "blocked packet connection to ", destination)
    return nil, syscall.EPERM
}
```

Ключевые детали:
- Использует `option.StubOptions` (пустую структуру), так как конфигурация не нужна
- Возвращает `syscall.EPERM` (не обобщённую ошибку), что может быть обнаружено вызывающими
- Поддерживает как TCP, так и UDP (оба блокируются)

## Исходящее соединение DNS (Outbound)

Исходящее соединение DNS перехватывает соединения, несущие DNS-трафик, и разрешает их через внутренний DNS-маршрутизатор.

### Архитектура

```go
type Outbound struct {
    outbound.Adapter
    router adapter.DNSRouter
    logger logger.ContextLogger
}
```

### Обычный Dial не поддерживается

Исходящее соединение DNS не поддерживает обычные `DialContext` или `ListenPacket`:

```go
func (d *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    return nil, os.ErrInvalid
}
```

Вместо этого оно реализует `NewConnectionEx` и `NewPacketConnectionEx` для прямой обработки DNS-сообщений.

### Потоковый DNS (TCP)

TCP DNS-соединения обрабатываются в цикле, читая DNS-сообщения с префиксом длины:

```go
func (d *Outbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    metadata.Destination = M.Socksaddr{}
    for {
        conn.SetReadDeadline(time.Now().Add(C.DNSTimeout))
        err := HandleStreamDNSRequest(ctx, d.router, conn, metadata)
        if err != nil {
            conn.Close()
            return
        }
    }
}
```

### Формат данных потокового DNS

DNS по TCP использует 2-байтовый префикс длины:

```go
func HandleStreamDNSRequest(ctx, router, conn, metadata) error {
    // 1. Прочитать 2-байтовый префикс длины
    var queryLength uint16
    binary.Read(conn, binary.BigEndian, &queryLength)

    // 2. Прочитать DNS-сообщение
    buffer := buf.NewSize(int(queryLength))
    buffer.ReadFullFrom(conn, int(queryLength))

    // 3. Распаковать и маршрутизировать
    var message mDNS.Msg
    message.Unpack(buffer.Bytes())

    // 4. Обменяться через DNS-маршрутизатор (асинхронно)
    go func() {
        response, _ := router.Exchange(ctx, &message, adapter.DNSQueryOptions{})
        // Записать ответ с префиксом длины
        binary.BigEndian.PutUint16(responseBuffer.ExtendHeader(2), uint16(len(n)))
        conn.Write(responseBuffer.Bytes())
    }()
}
```

### Пакетный DNS (UDP)

UDP DNS-пакеты обрабатываются конкурентно с таймаутом бездействия:

```go
func (d *Outbound) NewPacketConnectionEx(ctx, conn, metadata, onClose) {
    NewDNSPacketConnection(ctx, d.router, conn, nil, metadata)
}
```

Обработчик пакетов:
1. Читает DNS-пакеты из соединения
2. Распаковывает каждый пакет как DNS-сообщение
3. Обменивается через DNS-маршрутизатор в отдельной горутине
4. Записывает ответ обратно с поддержкой усечения DNS
5. Использует canceler с `C.DNSTimeout` для обнаружения бездействия

```go
go func() {
    response, _ := router.Exchange(ctx, &message, adapter.DNSQueryOptions{})
    responseBuffer, _ := dns.TruncateDNSMessage(&message, response, 1024)
    conn.WritePacket(responseBuffer, destination)
}()
```

## Примеры конфигурации

### Direct

```json
{
  "type": "direct",
  "tag": "direct-out"
}
```

### Direct со стратегией домена

```json
{
  "type": "direct",
  "tag": "direct-out",
  "domain_strategy": "prefer_ipv4"
}
```

### Block

```json
{
  "type": "block",
  "tag": "block-out"
}
```

### DNS

```json
{
  "type": "dns",
  "tag": "dns-out"
}
```

### Входящее соединение Direct (Inbound) — с переопределением

```json
{
  "type": "direct",
  "tag": "direct-in",
  "listen": "::",
  "listen_port": 5353,
  "override_address": "8.8.8.8",
  "override_port": 53
}
```
