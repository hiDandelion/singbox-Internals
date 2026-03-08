# Транспорты Hosts и локальный DNS

Исходный код: `dns/transport/hosts/hosts.go`, `dns/transport/hosts/hosts_file.go`, `dns/transport/local/local.go`, `dns/transport/dhcp/dhcp.go`

## Транспорт Hosts

Транспорт hosts разрешает домены по записям файла hosts и предопределённым отображениям.

### Структура

```go
type Transport struct {
    dns.TransportAdapter
    files      []*File
    predefined map[string][]netip.Addr
}
```

### Приоритет поиска

1. **Предопределённые записи** проверяются первыми (отображения из конфигурации)
2. **Файлы hosts** проверяются по порядку

```go
func (t *Transport) Exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    question := message.Question[0]
    domain := mDNS.CanonicalName(question.Name)
    if question.Qtype == mDNS.TypeA || question.Qtype == mDNS.TypeAAAA {
        if addresses, ok := t.predefined[domain]; ok {
            return dns.FixedResponse(message.Id, question, addresses, C.DefaultDNSTTL), nil
        }
        for _, file := range t.files {
            addresses := file.Lookup(domain)
            if len(addresses) > 0 {
                return dns.FixedResponse(message.Id, question, addresses, C.DefaultDNSTTL), nil
            }
        }
    }
    return &mDNS.Msg{
        MsgHdr: mDNS.MsgHdr{Id: message.Id, Rcode: mDNS.RcodeNameError, Response: true},
        Question: []mDNS.Question{question},
    }, nil
}
```

Обрабатываются только запросы A и AAAA. Неразрешимые домены возвращают NXDOMAIN. Запросы не-адресных типов также возвращают NXDOMAIN.

### Создание

```go
func NewTransport(ctx context.Context, logger log.ContextLogger, tag string,
    options option.HostsDNSServerOptions) (adapter.DNSTransport, error) {
    if len(options.Path) == 0 {
        files = append(files, NewFile(DefaultPath))  // /etc/hosts
    } else {
        for _, path := range options.Path {
            files = append(files, NewFile(filemanager.BasePath(ctx, os.ExpandEnv(path))))
        }
    }
    if options.Predefined != nil {
        for _, entry := range options.Predefined.Entries() {
            predefined[mDNS.CanonicalName(entry.Key)] = entry.Value
        }
    }
}
```

Доменные имена каноникализируются (приводятся к нижнему регистру, FQDN с завершающей точкой) через `mDNS.CanonicalName`.

### Разбор файла hosts

Структура `File` обеспечивает отложенный разбор с кэшированием:

```go
type File struct {
    path    string
    access  sync.Mutex
    modTime time.Time
    modSize int64
    entries map[string][]netip.Addr
    lastCheck time.Time
}
```

**Инвалидация кэша**: Файл повторно разбирается только когда:
- С момента последней проверки прошло более 5 секунд, И
- Время модификации или размер файла изменились

```go
func (f *File) Lookup(domain string) []netip.Addr {
    f.access.Lock()
    defer f.access.Unlock()
    if time.Since(f.lastCheck) > 5*time.Second {
        stat, err := os.Stat(f.path)
        if stat.ModTime() != f.modTime || stat.Size() != f.modSize {
            f.entries = parseHostsFile(f.path)
            f.modTime = stat.ModTime()
            f.modSize = stat.Size()
        }
        f.lastCheck = time.Now()
    }
    return f.entries[domain]
}
```

**Правила разбора**:
- Строки, начинающиеся с `#`, являются комментариями
- Каждая строка: `<IP> <имя_хоста1> [имя_хоста2] ...`
- Имена хостов каноникализируются (приведение к нижнему регистру + завершающая точка)
- Поддерживаются адреса как IPv4, так и IPv6
- Несколько записей для одного имени хоста накапливаются

### Путь по умолчанию

```go
// Linux/macOS
var DefaultPath = "/etc/hosts"

// Windows
var DefaultPath = `C:\Windows\System32\drivers\etc\hosts`
```

## Локальный транспорт DNS

Локальный транспорт разрешает DNS-запросы через системный резолвер.

### Структура (не-Darwin)

```go
type Transport struct {
    dns.TransportAdapter
    ctx      context.Context
    logger   logger.ContextLogger
    hosts    *hosts.File
    dialer   N.Dialer
    preferGo bool
    resolved ResolvedResolver
}
```

### Приоритет разрешения

1. **systemd-resolved** (только Linux): Если система использует resolved, запросы отправляются через D-Bus
2. **Локальный файл hosts**: Проверяется перед сетевым разрешением
3. **Системный резолвер**: Откат к `net.Resolver` Go

```go
func (t *Transport) Exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    // 1. Try systemd-resolved
    if t.resolved != nil {
        resolverObject := t.resolved.Object()
        if resolverObject != nil {
            return t.resolved.Exchange(resolverObject, ctx, message)
        }
    }
    // 2. Try local hosts file
    if question.Qtype == mDNS.TypeA || question.Qtype == mDNS.TypeAAAA {
        addresses := t.hosts.Lookup(dns.FqdnToDomain(question.Name))
        if len(addresses) > 0 {
            return dns.FixedResponse(message.Id, question, addresses, C.DefaultDNSTTL), nil
        }
    }
    // 3. System resolver
    return t.exchange(ctx, message, question.Name)
}
```

### Обнаружение systemd-resolved

```go
func (t *Transport) Start(stage adapter.StartStage) error {
    switch stage {
    case adapter.StartStateInitialize:
        if !t.preferGo {
            if isSystemdResolvedManaged() {
                resolvedResolver, err := NewResolvedResolver(t.ctx, t.logger)
                if err == nil {
                    err = resolvedResolver.Start()
                    if err == nil {
                        t.resolved = resolvedResolver
                    }
                }
            }
        }
    }
}
```

Если `preferGo` установлен в true, используется резолвер Go напрямую, минуя systemd-resolved.

### Вариант для Darwin (macOS)

На macOS локальный транспорт использует DNS-серверы, обнаруженные через DHCP, или системный резолвер со специальной обработкой доменов `.local` (mDNS).

## Транспорт DHCP

Транспорт DHCP динамически обнаруживает DNS-серверы через DHCPv4:

### Обнаружение

Транспорт отправляет DHCPv4 Discover/Request на указанном сетевом интерфейсе и извлекает адреса DNS-серверов из DHCP Offer/Ack.

### Мониторинг интерфейса

DNS-серверы кэшируются по интерфейсам и обновляются когда:
- Состояние интерфейса меняется (соединение установлено/разорвано)
- Адрес интерфейса меняется
- Истекает срок действия кэша

### Кэширование серверов

```go
type Transport struct {
    dns.TransportAdapter
    ctx           context.Context
    logger        logger.ContextLogger
    interfaceName string
    autoInterface bool
    // ...
    transportAccess sync.Mutex
    transports      []adapter.DNSTransport
    lastUpdate      time.Time
}
```

Транспорт DHCP создаёт дочерние транспорты (обычно UDP) для каждого обнаруженного DNS-сервера и делегирует им запросы.

## Конфигурация

### Hosts

```json
{
  "dns": {
    "servers": [
      {
        "tag": "hosts",
        "type": "hosts",
        "path": ["/etc/hosts", "/custom/hosts"],
        "predefined": {
          "myserver.local": ["192.168.1.100"]
        }
      }
    ]
  }
}
```

### Локальный

```json
{
  "dns": {
    "servers": [
      {
        "tag": "local",
        "type": "local",
        "prefer_go": false
      }
    ]
  }
}
```

### DHCP

```json
{
  "dns": {
    "servers": [
      {
        "tag": "dhcp",
        "type": "dhcp",
        "interface": "eth0"
      }
    ]
  }
}
```
