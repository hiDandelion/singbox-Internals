# Менеджер сети

NetworkManager управляет платформенно-специфичной сетевой функциональностью: обнаружение интерфейсов, мониторинг маршрутов, защита сокетов и отслеживание состояния WIFI.

**Исходный код**: `route/network.go`, `adapter/network.go`

## Интерфейс

```go
type NetworkManager interface {
    Lifecycle
    Initialize(ruleSets []RuleSet)
    InterfaceFinder() control.InterfaceFinder
    UpdateInterfaces() error
    DefaultNetworkInterface() *NetworkInterface
    NetworkInterfaces() []NetworkInterface
    AutoDetectInterface() bool
    AutoDetectInterfaceFunc() control.Func
    ProtectFunc() control.Func
    DefaultOptions() NetworkOptions
    RegisterAutoRedirectOutputMark(mark uint32) error
    AutoRedirectOutputMark() uint32
    NetworkMonitor() tun.NetworkUpdateMonitor
    InterfaceMonitor() tun.DefaultInterfaceMonitor
    PackageManager() tun.PackageManager
    NeedWIFIState() bool
    WIFIState() WIFIState
    ResetNetwork()
}
```

## Ключевые возможности

### Автоматическое определение интерфейса

При включении sing-box автоматически привязывает исходящие соединения к сетевому интерфейсу по умолчанию. Это предотвращает петли маршрутизации при активном TUN -- без этого исходящий трафик повторно попадал бы в TUN-устройство.

```go
func (m *NetworkManager) AutoDetectInterfaceFunc() control.Func
```

Возвращает функцию управления сокетом, которая привязывает сокеты к текущему интерфейсу по умолчанию с помощью `SO_BINDTODEVICE` (Linux) или аналогичного механизма.

### Функция защиты (Android)

На Android сокеты должны быть "защищены" для обхода VPN:

```go
func (m *NetworkManager) ProtectFunc() control.Func
```

Вызывает платформенный интерфейс Android для маркировки сокетов через `VpnService.protect()`.

### Мониторинг интерфейсов

`InterfaceMonitor` отслеживает сетевые изменения:

```go
type DefaultInterfaceMonitor interface {
    Start() error
    Close() error
    DefaultInterface() *Interface
    RegisterCallback(callback func()) *list.Element[func()]
    UnregisterCallback(element *list.Element[func()])
}
```

При смене интерфейса по умолчанию (например, WiFi -> сотовая связь) все DNS-кеши очищаются и соединения могут быть сброшены.

### Сетевая стратегия

Для устройств с несколькими интерфейсами сетевая стратегия управляет выбором используемых интерфейсов:

```go
type NetworkOptions struct {
    BindInterface        string
    RoutingMark          uint32
    DomainResolver       string
    DomainResolveOptions DNSQueryOptions
    NetworkStrategy      *C.NetworkStrategy
    NetworkType          []C.InterfaceType
    FallbackNetworkType  []C.InterfaceType
    FallbackDelay        time.Duration
}
```

Стратегии:
- **Default**: Использовать системный интерфейс по умолчанию
- **Prefer cellular**: Сначала пробовать сотовую связь, резервный -- WiFi
- **Prefer WiFi**: Сначала пробовать WiFi, резервный -- сотовая связь
- **Hybrid**: Использовать оба одновременно (multi-path)

### Состояние WIFI

Для правил, сопоставляющих по SSID/BSSID WIFI:

```go
type WIFIState struct {
    SSID  string
    BSSID string
}
```

Получается через платформенно-специфичные API (NetworkManager на Linux, CoreWLAN на macOS, WifiManager на Android).

### Типы сетевых интерфейсов

```go
type InterfaceType uint8

const (
    InterfaceTypeWIFI     InterfaceType = iota
    InterfaceTypeCellular
    InterfaceTypeEthernet
    InterfaceTypeOther
)
```

### Метка маршрутизации

В Linux метка маршрутизации (`SO_MARK`) используется для выбора таблиц маршрутизации. Это необходимо для работы TUN -- исходящие пакеты маркируются, чтобы они обходили правило маршрутизации TUN.
