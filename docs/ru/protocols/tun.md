# Входящее соединение TUN (Inbound)

TUN (сетевой TUNнель) — это основной механизм прозрачного проксирования в sing-box. Он создаёт виртуальный сетевой интерфейс, перехватывающий весь системный трафик. sing-box использует библиотеку `sing-tun`, которая поддерживает несколько реализаций сетевого стека, автоматическую маршрутизацию и автоматическое перенаправление через nftables.

**Исходный код**: `protocol/tun/inbound.go`, `sing-tun`

## Архитектура

```go
type Inbound struct {
    tag                         string
    ctx                         context.Context
    router                      adapter.Router
    networkManager              adapter.NetworkManager
    logger                      log.ContextLogger
    tunOptions                  tun.Options
    udpTimeout                  time.Duration
    stack                       string
    tunIf                       tun.Tun
    tunStack                    tun.Stack
    platformInterface           adapter.PlatformInterface
    platformOptions             option.TunPlatformOptions
    autoRedirect                tun.AutoRedirect
    routeRuleSet                []adapter.RuleSet
    routeRuleSetCallback        []*list.Element[adapter.RuleSetUpdateCallback]
    routeExcludeRuleSet         []adapter.RuleSet
    routeExcludeRuleSetCallback []*list.Element[adapter.RuleSetUpdateCallback]
    routeAddressSet             []*netipx.IPSet
    routeExcludeAddressSet      []*netipx.IPSet
}
```

## Выбор MTU

MTU выбирается автоматически в зависимости от платформы:

```go
if tunMTU == 0 {
    if platformInterface != nil && platformInterface.UnderNetworkExtension() {
        // iOS/macOS Network Extension: 4064 (4096 - UTUN_IF_HEADROOM_SIZE)
        tunMTU = 4064
    } else if C.IsAndroid {
        // Android: некоторые устройства сообщают ENOBUFS при 65535
        tunMTU = 9000
    } else {
        tunMTU = 65535
    }
}
```

## GSO (Generic Segmentation Offload)

GSO автоматически включается на Linux при выполнении условий:

```go
enableGSO := C.IsLinux && options.Stack == "gvisor" && platformInterface == nil && tunMTU > 0 && tunMTU < 49152
```

## Варианты сетевого стека

Опция `stack` определяет, как обрабатываются перехваченные пакеты:

```go
tunStack, _ := tun.NewStack(t.stack, tun.StackOptions{
    Context:                t.ctx,
    Tun:                    tunInterface,
    TunOptions:             t.tunOptions,
    UDPTimeout:             t.udpTimeout,
    Handler:                t,
    Logger:                 t.logger,
    ForwarderBindInterface: forwarderBindInterface,
    InterfaceFinder:        t.networkManager.InterfaceFinder(),
    IncludeAllNetworks:     includeAllNetworks,
})
```

### Доступные стеки

| Стек | Описание |
|-------|-------------|
| `gvisor` | Пользовательский TCP/IP-стек Google. Лучшая совместимость, наибольшая нагрузка на CPU. |
| `system` | Использует стек ядра ОС. Меньшая нагрузка на CPU, требует больше настроек на уровне ОС. |
| `mixed` | gVisor для TCP, system для UDP. Сбалансированный подход. |

## Настройка адресов

Адреса IPv4 и IPv6 разделяются из единого списка `Address`:

```go
address := options.Address
inet4Address := common.Filter(address, func(it netip.Prefix) bool {
    return it.Addr().Is4()
})
inet6Address := common.Filter(address, func(it netip.Prefix) bool {
    return it.Addr().Is6()
})
```

Тот же паттерн применяется к адресам маршрутов и адресам исключений маршрутов.

## Опции TUN

Полная структура опций TUN включает:

```go
tun.Options{
    Name:                 options.InterfaceName,
    MTU:                  tunMTU,
    GSO:                  enableGSO,
    Inet4Address:         inet4Address,
    Inet6Address:         inet6Address,
    AutoRoute:            options.AutoRoute,
    StrictRoute:          options.StrictRoute,
    IncludeInterface:     options.IncludeInterface,
    ExcludeInterface:     options.ExcludeInterface,
    IncludeUID:           includeUID,
    ExcludeUID:           excludeUID,
    IncludeAndroidUser:   options.IncludeAndroidUser,
    IncludePackage:       options.IncludePackage,
    ExcludePackage:       options.ExcludePackage,
    IncludeMACAddress:    includeMACAddress,
    ExcludeMACAddress:    excludeMACAddress,
    // ... индексы таблиц маршрутизации, метки и т.д.
}
```

### Фильтрация по UID

Диапазоны UID могут быть указаны как отдельные UID или диапазоны:

```go
includeUID := uidToRange(options.IncludeUID)
if len(options.IncludeUIDRange) > 0 {
    includeUID, _ = parseRange(includeUID, options.IncludeUIDRange)
}
```

Разбор диапазонов поддерживает формат `начало:конец`:

```go
func parseRange(uidRanges []ranges.Range[uint32], rangeList []string) ([]ranges.Range[uint32], error) {
    for _, uidRange := range rangeList {
        subIndex := strings.Index(uidRange, ":")
        start, _ := strconv.ParseUint(uidRange[:subIndex], 0, 32)
        end, _ := strconv.ParseUint(uidRange[subIndex+1:], 0, 32)
        uidRanges = append(uidRanges, ranges.New(uint32(start), uint32(end)))
    }
}
```

### Фильтрация по MAC-адресам

MAC-адреса разбираются для фильтрации на уровне LAN:

```go
for i, macString := range options.IncludeMACAddress {
    mac, _ := net.ParseMAC(macString)
    includeMACAddress = append(includeMACAddress, mac)
}
```

## Автоматическая маршрутизация (Auto-Route)

При включённом `auto_route` sing-box автоматически настраивает таблицы маршрутизации для направления трафика через TUN-интерфейс. Конфигурация включает:

```go
IPRoute2TableIndex:    tableIndex,    // по умолчанию: tun.DefaultIPRoute2TableIndex
IPRoute2RuleIndex:     ruleIndex,     // по умолчанию: tun.DefaultIPRoute2RuleIndex
```

## Автоматическое перенаправление (Auto-Redirect)

Auto-redirect использует nftables для перенаправления трафика без модификации таблицы маршрутизации. Требует `auto_route`:

```go
if options.AutoRedirect {
    if !options.AutoRoute {
        return nil, E.New("`auto_route` is required by `auto_redirect`")
    }
    inbound.autoRedirect, _ = tun.NewAutoRedirect(tun.AutoRedirectOptions{
        TunOptions:             &inbound.tunOptions,
        Context:                ctx,
        Handler:                (*autoRedirectHandler)(inbound),
        Logger:                 logger,
        NetworkMonitor:         networkManager.NetworkMonitor(),
        InterfaceFinder:        networkManager.InterfaceFinder(),
        TableName:              "sing-box",
        DisableNFTables:        dErr == nil && disableNFTables,
        RouteAddressSet:        &inbound.routeAddressSet,
        RouteExcludeAddressSet: &inbound.routeExcludeAddressSet,
    })
}
```

Переменная окружения `DISABLE_NFTABLES` может принудительно включить режим iptables:

```go
disableNFTables, dErr := strconv.ParseBool(os.Getenv("DISABLE_NFTABLES"))
```

### Метки Auto-Redirect

Метки трафика используются для предотвращения петель маршрутизации:

```go
AutoRedirectInputMark:  inputMark,   // по умолчанию: tun.DefaultAutoRedirectInputMark
AutoRedirectOutputMark: outputMark,  // по умолчанию: tun.DefaultAutoRedirectOutputMark
AutoRedirectResetMark:  resetMark,   // по умолчанию: tun.DefaultAutoRedirectResetMark
AutoRedirectNFQueue:    nfQueue,     // по умолчанию: tun.DefaultAutoRedirectNFQueue
```

## Наборы адресов маршрутов

TUN поддерживает динамические наборы адресов маршрутов из наборов правил (rule-set):

```go
for _, routeAddressSet := range options.RouteAddressSet {
    ruleSet, loaded := router.RuleSet(routeAddressSet)
    if !loaded {
        return nil, E.New("rule-set not found: ", routeAddressSet)
    }
    inbound.routeRuleSet = append(inbound.routeRuleSet, ruleSet)
}
```

При обновлении наборов правил адреса маршрутов обновляются:

```go
func (t *Inbound) updateRouteAddressSet(it adapter.RuleSet) {
    t.routeAddressSet = common.FlatMap(t.routeRuleSet, adapter.RuleSet.ExtractIPSet)
    t.routeExcludeAddressSet = common.FlatMap(t.routeExcludeRuleSet, adapter.RuleSet.ExtractIPSet)
    t.autoRedirect.UpdateRouteAddressSet()
}
```

## Двухфазный запуск

TUN использует двухфазный запуск:

### Фаза 1: `StartStateStart`

1. Построить Android-правила, если применимо
2. Вычислить имя интерфейса
3. Извлечь адреса маршрутов из наборов правил
4. Открыть TUN-интерфейс (платформозависимо или `tun.New()`)
5. Создать сетевой стек

### Фаза 2: `StartStatePostStart`

1. Запустить сетевой стек
2. Запустить TUN-интерфейс
3. Инициализировать auto-redirect (если включён)

```go
func (t *Inbound) Start(stage adapter.StartStage) error {
    switch stage {
    case adapter.StartStateStart:
        // Открыть TUN, создать стек
        if t.platformInterface != nil && t.platformInterface.UsePlatformInterface() {
            tunInterface, _ = t.platformInterface.OpenInterface(&tunOptions, t.platformOptions)
        } else {
            tunInterface, _ = tun.New(tunOptions)
        }
        tunStack, _ := tun.NewStack(t.stack, stackOptions)

    case adapter.StartStatePostStart:
        t.tunStack.Start()
        t.tunIf.Start()
        if t.autoRedirect != nil {
            t.autoRedirect.Start()
        }
    }
}
```

## Обработка соединений

### PrepareConnection

Перед установкой соединений TUN проверяет правила маршрутизации:

```go
func (t *Inbound) PrepareConnection(network, source, destination, routeContext, timeout) (tun.DirectRouteDestination, error) {
    routeDestination, err := t.router.PreMatch(adapter.InboundContext{
        Inbound:     t.tag,
        InboundType: C.TypeTun,
        IPVersion:   ipVersion,
        Network:     network,
        Source:      source,
        Destination: destination,
    }, routeContext, timeout, false)
    // Обработать bypass, reject, ICMP случаи
}
```

### TCP/UDP-соединения

Стандартная маршрутизация через маршрутизатор:

```go
func (t *Inbound) NewConnectionEx(ctx, conn, source, destination, onClose) {
    metadata.Inbound = t.tag
    metadata.InboundType = C.TypeTun
    metadata.Source = source
    metadata.Destination = destination
    t.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### Обработчик Auto-Redirect

Отдельный тип обработчика обрабатывает автоматически перенаправленные соединения:

```go
type autoRedirectHandler Inbound

func (t *autoRedirectHandler) NewConnectionEx(ctx, conn, source, destination, onClose) {
    // Тот же паттерн, но логируется как "redirect connection"
    t.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## Интеграция с платформой

На мобильных платформах (iOS/Android) TUN использует платформенный интерфейс:

```go
if t.platformInterface != nil && t.platformInterface.UsePlatformInterface() {
    tunInterface, _ = t.platformInterface.OpenInterface(&tunOptions, t.platformOptions)
}
```

Платформозависимые опции включают:
- `ForwarderBindInterface`: Привязка форвардера к определённому интерфейсу (мобильные)
- `IncludeAllNetworks`: Опция Network Extension для iOS
- `MultiPendingPackets`: Обходной путь для Darwin с маленьким MTU

## Пример конфигурации

```json
{
  "type": "tun",
  "tag": "tun-in",
  "interface_name": "tun0",
  "address": ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
  "mtu": 9000,
  "auto_route": true,
  "strict_route": true,
  "stack": "mixed",
  "route_address": ["0.0.0.0/0", "::/0"],
  "route_exclude_address": ["192.168.0.0/16"],
  "route_address_set": ["geoip-cn"],
  "auto_redirect": true,
  "include_package": ["com.example.app"],
  "exclude_package": ["com.example.excluded"],
  "udp_timeout": "5m"
}
```
