# Поиск процессов

Поиск процессов определяет, какой локальный процесс владеет сетевым соединением, позволяя использовать правила маршрутизации на основе процессов (`process_name`, `process_path`, `package_name`).

**Исходный код**: `common/process/`

## Интерфейс

```go
type Searcher interface {
    FindProcessInfo(ctx context.Context, network string, source netip.AddrPort,
        destination netip.AddrPort) (*adapter.ConnectionOwner, error)
}

type Config struct {
    Logger         log.ContextLogger
    PackageManager tun.PackageManager  // только Android
}

type ConnectionOwner struct {
    ProcessID          uint32
    UserId             int32
    UserName           string
    ProcessPath        string
    AndroidPackageName string
}
```

После того как поисковик возвращает `ConnectionOwner`, фреймворк дополняет его, выполняя поиск имени Unix-пользователя по UID:

```go
func FindProcessInfo(searcher Searcher, ctx, network, source, destination) (*ConnectionOwner, error) {
    info, err := searcher.FindProcessInfo(ctx, network, source, destination)
    if info.UserId != -1 {
        osUser, _ := user.LookupId(F.ToString(info.UserId))
        if osUser != nil {
            info.UserName = osUser.Username
        }
    }
    return info, nil
}
```

## Реализация для Linux

**Файл**: `searcher_linux.go`, `searcher_linux_shared.go`
**Ограничение сборки**: `linux && !android`

### Архитектура

Поисковик для Linux использует двухэтапный процесс:

1. **Диагностика сокета Netlink** — нахождение inode сокета и UID для данного соединения
2. **Поиск в procfs** — сканирование `/proc` для нахождения процесса, владеющего этим inode сокета

### Этап 1: Диагностика сокета Netlink

```go
func resolveSocketByNetlink(network string, source, destination netip.AddrPort) (inode, uid uint32, err error)
```

Отправляет сообщение `SOCK_DIAG_BY_FAMILY` через netlink ядру:

```go
const sizeOfSocketDiagRequest = syscall.SizeofNlMsghdr + 8 + 48

// Структура запроса (72 байта):
// [0:4]   nlmsg_len    (native endian)
// [4:6]   nlmsg_type   = socketDiagByFamily (20)
// [6:8]   nlmsg_flags  = NLM_F_REQUEST | NLM_F_DUMP
// [8:12]  nlmsg_seq    = 0
// [12:16] nlmsg_pid    = 0
// [16]    sdiag_family = AF_INET или AF_INET6
// [17]    sdiag_protocol = IPPROTO_TCP или IPPROTO_UDP
// [18:20] pad          = 0
// [20:24] idiag_states = 0xFFFFFFFF (все состояния)
// [24:26] source_port  (big-endian)
// [26:28] dest_port    = 0
// [28:44] source_addr  (16 байт, с дополнением)
// [44:60] dest_addr    = IPv6 zero
// [60:64] idiag_if     = 0
// [64:72] idiag_cookie = 0xFFFFFFFFFFFFFFFF
```

Ответ содержит UID по смещению `[64:68]` и inode по смещению `[68:72]` (оба в native endian).

### Этап 2: Поиск в procfs

```go
func resolveProcessNameByProcSearch(inode, uid uint32) (string, error)
```

Сканирует `/proc/[pid]/fd/` в поисках символической ссылки, совпадающей с `socket:[inode]`:

1. Перечислить все записи `/proc/`, являющиеся числовыми (PID)
2. Фильтровать по совпадению UID (из `stat.Uid`)
3. Для каждого PID перечислить `/proc/[pid]/fd/`
4. Прочитать ссылку каждой записи fd, сравнить с `socket:[inode]`
5. При нахождении прочитать ссылку `/proc/[pid]/exe` для получения пути процесса

## Реализация для Darwin (macOS)

**Файл**: `searcher_darwin.go`

### Архитектура

macOS использует `sysctl` для чтения списка PCB (Protocol Control Block) ядра, затем сопоставляет по исходному порту и IP-адресу.

```go
func findProcessName(network string, ip netip.Addr, port int) (string, error) {
    var spath string
    switch network {
    case "tcp": spath = "net.inet.tcp.pcblist_n"
    case "udp": spath = "net.inet.udp.pcblist_n"
    }
    value, err := unix.SysctlRaw(spath)
    // ...
}
```

### Парсинг списка PCB

sysctl возвращает упакованный массив структур `xinpcb_n` + `xsocket_n`. Ключевые смещения:

```
// Размеры структур зависят от версии macOS:
//   darwin >= 22 (Ventura+): 408 байт на элемент
//   darwin < 22:             384 байта на элемент
// TCP добавляет 208 байт для xtcpcb_n

// Внутри каждого элемента (смещения от начала элемента):
//   inp + 18:20  = исходный порт (big-endian uint16)
//   inp + 44     = inp_vflag (0x1 = IPv4, 0x2 = IPv6)
//   inp + 64:80  = IPv6-адрес (или IPv4 в последних 4 байтах)
//   so  + 68:72  = so_last_pid (native-endian uint32)
```

После нахождения соответствующего PID вызывается системный вызов `proc_info` для получения пути процесса:

```go
func getExecPathFromPID(pid uint32) (string, error) {
    // SYS_PROC_INFO с PROC_PIDPATHINFO
    buf := make([]byte, 1024)
    syscall.Syscall6(syscall.SYS_PROC_INFO,
        2,              // PROCCALLNUM_PIDINFO
        uintptr(pid),
        0xb,            // PROC_PIDPATHINFO
        0, uintptr(unsafe.Pointer(&buf[0])), 1024)
    return unix.ByteSliceToString(buf), nil
}
```

### Запасной вариант для UDP

Для UDP, если точное совпадение по исходному IP не найдено, реализация использует запасной вариант — запись с неопределённым адресом (0.0.0.0 или ::), поскольку UDP-сокеты могут быть не привязаны к конкретному адресу.

## Реализация для Windows

**Файл**: `searcher_windows.go`

### Архитектура

Windows использует IP Helper API (`GetExtendedTcpTable` / `GetExtendedUdpTable`) через пакет `winiphlpapi`:

```go
func (s *windowsSearcher) FindProcessInfo(ctx, network, source, destination) (*ConnectionOwner, error) {
    pid, err := winiphlpapi.FindPid(network, source)
    path, err := getProcessPath(pid)
    return &ConnectionOwner{ProcessID: pid, ProcessPath: path, UserId: -1}, nil
}
```

Получение пути процесса использует `OpenProcess` + `QueryFullProcessImageName`:

```go
func getProcessPath(pid uint32) (string, error) {
    switch pid {
    case 0: return ":System Idle Process", nil
    case 4: return ":System", nil
    }
    handle, _ := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
    defer windows.CloseHandle(handle)
    buf := make([]uint16, syscall.MAX_LONG_PATH)
    windows.QueryFullProcessImageName(handle, 0, &buf[0], &size)
    return windows.UTF16ToString(buf[:size]), nil
}
```

## Реализация для Android

**Файл**: `searcher_android.go`

### Архитектура

Android повторно использует диагностику сокетов Netlink из Linux для получения UID, затем сопоставляет UID с именем пакета через `tun.PackageManager`:

```go
func (s *androidSearcher) FindProcessInfo(ctx, network, source, destination) (*ConnectionOwner, error) {
    _, uid, err := resolveSocketByNetlink(network, source, destination)
    // Android использует пересопоставление ID пользователей: фактический UID = uid % 100000
    if sharedPackage, loaded := s.packageManager.SharedPackageByID(uid % 100000); loaded {
        return &ConnectionOwner{UserId: int32(uid), AndroidPackageName: sharedPackage}, nil
    }
    if packageName, loaded := s.packageManager.PackageByID(uid % 100000); loaded {
        return &ConnectionOwner{UserId: int32(uid), AndroidPackageName: packageName}, nil
    }
    return &ConnectionOwner{UserId: int32(uid)}, nil
}
```

Многопользовательская система Android использует диапазоны UID: `actual_app_uid = uid % 100000`. `PackageManager` сопоставляет эти UID приложений с именами пакетов.

## Заглушка

**Файл**: `searcher_stub.go`
**Ограничение сборки**: `!linux && !windows && !darwin`

Неподдерживаемые платформы возвращают `os.ErrInvalid`:

```go
func NewSearcher(_ Config) (Searcher, error) {
    return nil, os.ErrInvalid
}
```

## Переопределение через интерфейс платформы

На мобильных платформах (Android/iOS через libbox) поисковик процессов может быть переопределён интерфейсом платформы. `platformInterfaceWrapper` делегирует:
- Сканирование `procfs` (когда `UseProcFS()` возвращает true на Android)
- Нативный метод `FindConnectionOwner()` платформы

## Использование информации о процессе в маршрутизации

Когда `route.find_process` включён, маршрутизатор вызывает поисковик процессов для каждого нового соединения. Результат заполняет `InboundContext.ProcessInfo`, по которому правила маршрутизации могут выполнять сопоставление:

- `process_name` — совпадение с именем исполняемого файла (базовое имя `ProcessPath`)
- `process_path` — совпадение с полным путём исполняемого файла
- `process_path_regex` — совпадение по регулярному выражению с полным путём
- `package_name` — совпадение с именем пакета Android

Метаданные набора правил отслеживают `ContainsProcessRule` для предотвращения затратного поиска процессов, когда ни одно правило не нуждается в нём.

## Замечания по реализации

1. **Linux**: Протокол netlink хорошо документирован. Сообщение `SOCK_DIAG_BY_FAMILY` является стандартным. Сканирование procfs имеет сложность O(процессы * fd) и может быть медленным на системах с большим количеством процессов
2. **macOS**: Формат списка PCB sysctl не задокументирован публично и изменяется между версиями macOS. Определение размера структуры через `kern.osrelease` — хрупкая, но необходимая эвристика
3. **Windows**: Требует загрузки функций `iphlpapi.dll`. Функции `GetExtendedTcpTable`/`GetExtendedUdpTable` хорошо документированы в MSDN
4. **Android**: Сопоставление UID с пакетом требует доступа к менеджеру пакетов Android, обычно через привязку интерфейса платформы
5. **Производительность**: Поиск процесса выполняется для каждого соединения и может быть затратным. Флаг метаданных `ContainsProcessRule` позволяет полностью пропустить его, когда он не нужен
