# Интерфейс платформы

Интерфейс платформы предоставляет уровень абстракции для мобильных платформ (Android/iOS) для интеграции sing-box в нативные приложения через привязки gomobile. Он управляет TUN-устройствами, мониторингом сети, идентификацией процессов и системными операциями.

**Исходный код**: `experimental/libbox/`, `adapter/platform.go`

## Двухуровневая архитектура

Существуют два типа `PlatformInterface`:

1. **`adapter.PlatformInterface`** (внутренний) — интерфейс, используемый внутри ядра sing-box
2. **`libbox.PlatformInterface`** (внешний) — gomobile-совместимый интерфейс, реализуемый хост-приложением

`platformInterfaceWrapper` в libbox выступает мостом между ними:

```go
var _ adapter.PlatformInterface = (*platformInterfaceWrapper)(nil)

type platformInterfaceWrapper struct {
    iif                    PlatformInterface  // gomobile-интерфейс от хост-приложения
    useProcFS              bool
    networkManager         adapter.NetworkManager
    myTunName              string
    defaultInterfaceAccess sync.Mutex
    defaultInterface       *control.Interface
    isExpensive            bool
    isConstrained          bool
}
```

## adapter.PlatformInterface (внутренний)

```go
type PlatformInterface interface {
    Initialize(networkManager NetworkManager) error

    UsePlatformAutoDetectInterfaceControl() bool
    AutoDetectInterfaceControl(fd int) error

    UsePlatformInterface() bool
    OpenInterface(options *tun.Options, platformOptions TunPlatformOptions) (tun.Tun, error)

    UsePlatformDefaultInterfaceMonitor() bool
    CreateDefaultInterfaceMonitor(logger logger.Logger) tun.DefaultInterfaceMonitor

    UsePlatformNetworkInterfaces() bool
    NetworkInterfaces() ([]NetworkInterface, error)

    UnderNetworkExtension() bool
    NetworkExtensionIncludeAllNetworks() bool

    ClearDNSCache()
    RequestPermissionForWIFIState() error
    ReadWIFIState() WIFIState
    SystemCertificates() []string

    UsePlatformConnectionOwnerFinder() bool
    FindConnectionOwner(request *FindConnectionOwnerRequest) (*ConnectionOwner, error)

    UsePlatformWIFIMonitor() bool

    UsePlatformNotification() bool
    SendNotification(notification *Notification) error

    UsePlatformNeighborResolver() bool
    StartNeighborMonitor(listener NeighborUpdateListener) error
    CloseNeighborMonitor(listener NeighborUpdateListener) error
}
```

Каждый метод `UsePlatform*()` возвращает true, чтобы указать, что платформа предоставляет данную возможность, заставляя sing-box использовать реализацию платформы вместо стандартной Go-реализации.

## libbox.PlatformInterface (внешний/gomobile)

```go
type PlatformInterface interface {
    LocalDNSTransport() LocalDNSTransport
    UsePlatformAutoDetectInterfaceControl() bool
    AutoDetectInterfaceControl(fd int32) error
    OpenTun(options TunOptions) (int32, error)          // возвращает файловый дескриптор
    UseProcFS() bool
    FindConnectionOwner(ipProtocol int32, sourceAddress string,
        sourcePort int32, destinationAddress string,
        destinationPort int32) (*ConnectionOwner, error)
    StartDefaultInterfaceMonitor(listener InterfaceUpdateListener) error
    CloseDefaultInterfaceMonitor(listener InterfaceUpdateListener) error
    GetInterfaces() (NetworkInterfaceIterator, error)
    UnderNetworkExtension() bool
    IncludeAllNetworks() bool
    ReadWIFIState() *WIFIState
    SystemCertificates() StringIterator
    ClearDNSCache()
    SendNotification(notification *Notification) error
    StartNeighborMonitor(listener NeighborUpdateListener) error
    CloseNeighborMonitor(listener NeighborUpdateListener) error
    RegisterMyInterface(name string)
}
```

Ключевые отличия от внутреннего интерфейса:
- Используется `int32` вместо `int` (совместимость с gomobile)
- Возвращаются итераторы вместо срезов (gomobile не поддерживает Go-срезы)
- `OpenTun` возвращает необработанный файловый дескриптор вместо объекта `tun.Tun`
- `StringIterator` оборачивает `[]string` для потребления gomobile

## Управление TUN-устройством

### Открытие TUN

Обёртка платформы конвертирует между типами TUN libbox и внутренними:

```go
func (w *platformInterfaceWrapper) OpenInterface(options *tun.Options, platformOptions) (tun.Tun, error) {
    // 1. Построение диапазонов автомаршрутизации
    routeRanges, _ := options.BuildAutoRouteRanges(true)

    // 2. Вызов платформы для открытия TUN (возвращает fd)
    tunFd, _ := w.iif.OpenTun(&tunOptions{options, routeRanges, platformOptions})

    // 3. Получение имени туннеля по fd
    options.Name, _ = getTunnelName(tunFd)

    // 4. Регистрация в мониторе интерфейсов
    options.InterfaceMonitor.RegisterMyInterface(options.Name)

    // 5. Дублирование fd (платформа может закрыть оригинал)
    dupFd, _ := dup(int(tunFd))
    options.FileDescriptor = dupFd

    // 6. Создание tun.Tun из опций
    return tun.New(*options)
}
```

Функция `getTunnelName` зависит от платформы:
- **Darwin**: считывает имя интерфейса из fd через `ioctl`
- **Linux**: считывает из символической ссылки `/proc/self/fd/<fd>` и извлекает имя tun
- **Другие**: возвращает имя-заполнитель

## Монитор интерфейса по умолчанию

Платформенный монитор интерфейса по умолчанию оборачивает обратные вызовы изменения сети хост-приложения:

```go
type platformDefaultInterfaceMonitor struct {
    *platformInterfaceWrapper
    logger      logger.Logger
    callbacks   list.List[tun.DefaultInterfaceUpdateCallback]
    myInterface string
}
```

### Поток обновления

Когда хост-приложение обнаруживает изменение сети:

```go
func (m *platformDefaultInterfaceMonitor) UpdateDefaultInterface(
    interfaceName string, interfaceIndex32 int32,
    isExpensive bool, isConstrained bool) {

    // 1. Обновление флагов дороговизны/ограниченности
    // 2. Указание менеджеру сети обновить интерфейсы
    // 3. Поиск нового интерфейса по индексу
    // 4. Обновление сохранённого интерфейса по умолчанию
    // 5. Уведомление всех зарегистрированных обратных вызовов (если интерфейс изменился)
}
```

Если `interfaceIndex32 == -1`, устройство не имеет сетевого подключения (все обратные вызовы получают `nil`).

На Android обновление может быть диспетчеризировано в новую горутину через `sFixAndroidStack` для обхода ошибки среды выполнения Go с размерами стеков потоков Android.

## Перечисление сетевых интерфейсов

```go
func (w *platformInterfaceWrapper) NetworkInterfaces() ([]adapter.NetworkInterface, error) {
    interfaceIterator, _ := w.iif.GetInterfaces()
    var interfaces []adapter.NetworkInterface
    for _, netInterface := range iteratorToArray(interfaceIterator) {
        // Пропуск нашего собственного TUN-интерфейса
        if netInterface.Name == w.myTunName {
            continue
        }
        interfaces = append(interfaces, adapter.NetworkInterface{
            Interface: control.Interface{
                Index:     int(netInterface.Index),
                MTU:       int(netInterface.MTU),
                Name:      netInterface.Name,
                Addresses: common.Map(iteratorToArray(netInterface.Addresses), netip.MustParsePrefix),
                Flags:     linkFlags(uint32(netInterface.Flags)),
            },
            Type:        C.InterfaceType(netInterface.Type),
            DNSServers:  iteratorToArray(netInterface.DNSServer),
            Expensive:   netInterface.Metered || isDefault && w.isExpensive,
            Constrained: isDefault && w.isConstrained,
        })
    }
    // Дедупликация по имени
    return common.UniqBy(interfaces, func(it) string { return it.Name }), nil
}
```

Типы интерфейсов:
```go
const (
    InterfaceTypeWIFI     = int32(C.InterfaceTypeWIFI)
    InterfaceTypeCellular = int32(C.InterfaceTypeCellular)
    InterfaceTypeEthernet = int32(C.InterfaceTypeEthernet)
    InterfaceTypeOther    = int32(C.InterfaceTypeOther)
)
```

## Владелец соединения процесса

Обёртка платформы поддерживает два режима поиска владельцев соединений:

```go
func (w *platformInterfaceWrapper) FindConnectionOwner(request) (*ConnectionOwner, error) {
    if w.useProcFS {
        // Режим 1: Прямое сканирование procfs (Android с root/VPN)
        uid := procfs.ResolveSocketByProcSearch(network, source, destination)
        return &ConnectionOwner{UserId: uid}, nil
    }
    // Режим 2: Делегирование платформе (использует ConnectivityManager Android)
    result, _ := w.iif.FindConnectionOwner(...)
    return &ConnectionOwner{
        UserId:             result.UserId,
        ProcessPath:        result.ProcessPath,
        AndroidPackageName: result.AndroidPackageName,
    }, nil
}
```

## Настройка и инициализация

Функция `Setup()` настраивает глобальные пути и опции для мобильных платформ:

```go
type SetupOptions struct {
    BasePath                string   // каталог данных приложения
    WorkingPath             string   // рабочий каталог для файлов конфигурации
    TempPath                string   // временные файлы
    FixAndroidStack         bool     // обходной путь для ошибки среды выполнения Go
    CommandServerListenPort int32    // порт локального командного сервера
    CommandServerSecret     string   // секрет аутентификации
    LogMaxLines             int      // размер буфера логов
    Debug                   bool     // включение отладочных функций
}
```

## Статус системного прокси

```go
type SystemProxyStatus struct {
    Available bool
    Enabled   bool
}
```

Этот тип представляет, доступна ли настройка системного прокси на платформе и включена ли она в данный момент.

## Сетевое расширение iOS

Два важных флага для iOS Network Extension (NEPacketTunnelProvider):

- **`UnderNetworkExtension()`**: Возвращает true при работе внутри процесса iOS Network Extension, который имеет другие ограничения по памяти и возможностям
- **`NetworkExtensionIncludeAllNetworks()`**: Возвращает true, когда активно право `includeAllNetworks`, которое направляет весь трафик устройства (включая системные процессы) через туннель

## Уведомления

```go
type Notification struct {
    Identifier string
    TypeName   string
    TypeID     int32
    Title      string
    Subtitle   string
    Body       string
    OpenURL    string
}
```

Уведомления используются для системных оповещений (напр., ошибки обновления набора правил, предупреждения об истечении срока действия сертификата).

## Правила по запросу (iOS)

```go
type OnDemandRule interface {
    Target() int32
    DNSSearchDomainMatch() StringIterator
    DNSServerAddressMatch() StringIterator
    InterfaceTypeMatch() int32
    SSIDMatch() StringIterator
    ProbeURL() string
}
```

Эти правила управляют тем, когда VPN-туннель должен быть активирован на iOS, на основе сетевых условий (SSID, тип интерфейса, конфигурация DNS).

## Замечания по реализации

1. **Ограничения gomobile**: Интерфейс libbox использует `int32` вместо `int`, итераторы вместо срезов и указательные типы вместо типов-значений. Всё это — ограничения gomobile
2. **Дублирование файлового дескриптора**: TUN fd необходимо продублировать через `dup()`, потому что платформа может закрыть оригинальный fd после его возврата
3. **Фильтрация интерфейсов**: Сам TUN-интерфейс должен быть исключён из списка сетевых интерфейсов для предотвращения петель маршрутизации
4. **Исправление стека Android**: Флаг `sFixAndroidStack` диспетчеризирует обновления интерфейсов в новые горутины для обхода Go issue #68760, связанного с размерами стеков потоков Android
5. **Двунаправленная коммуникация**: Интерфейс платформы двунаправленный — хост-приложение вызывает sing-box (через `BoxService`), и sing-box вызывает обратно хост-приложение (через `PlatformInterface`)
6. **Командный сервер**: Отдельный локальный TCP-сервер (здесь не показан) обеспечивает IPC между UI хост-приложения и сервисом sing-box, работающим в фоне
