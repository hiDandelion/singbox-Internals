# Маршрутизатор и правила

Маршрутизатор -- это центральный механизм принятия решений. Он сопоставляет соединения с правилами и выполняет действия. В отличие от Xray-core, где правила просто выбирают тег исходящего, правила sing-box порождают **действия**, которые могут анализировать протокол, разрешать DNS, маршрутизировать, отклонять или перехватывать DNS.

**Исходный код**: `route/router.go`, `route/route.go`, `route/rule/`

## Структура маршрутизатора

```go
type Router struct {
    ctx               context.Context
    logger            log.ContextLogger
    inbound           adapter.InboundManager
    outbound          adapter.OutboundManager
    dns               adapter.DNSRouter
    dnsTransport      adapter.DNSTransportManager
    connection        adapter.ConnectionManager
    network           adapter.NetworkManager
    rules             []adapter.Rule
    ruleSets          []adapter.RuleSet
    ruleSetMap        map[string]adapter.RuleSet
    processSearcher   process.Searcher
    neighborResolver  adapter.NeighborResolver
    trackers          []adapter.ConnectionTracker
}
```

## Поток маршрутизации соединений

### `RouteConnectionEx` (TCP)

```go
func (r *Router) RouteConnectionEx(ctx, conn, metadata, onClose) {
    err := r.routeConnection(ctx, conn, metadata, onClose)
    if err != nil {
        N.CloseOnHandshakeFailure(conn, onClose, err)
    }
}
```

### `routeConnection` (внутренний)

1. **Проверка detour**: Если задан `metadata.InboundDetour`, инжектировать в соответствующий входящий
2. **Проверка Mux/UoT**: Отклонение устаревших глобальных адресов mux/UoT
3. **Сопоставление правил**: Вызов `matchRule()` для поиска совпадающего правила
4. **Диспетчеризация действий**:
   - `RuleActionRoute` -> поиск исходящего, проверка поддержки TCP
   - `RuleActionBypass` -> прямой обход или обход через исходящий
   - `RuleActionReject` -> возврат ошибки
   - `RuleActionHijackDNS` -> обработка как DNS-потока
5. **Исходящий по умолчанию**: Если ни одно правило не совпало, используется исходящий по умолчанию
6. **Трекинг соединений**: Обёртка трекерами (статистика Clash API)
7. **Передача**: Вызов `outbound.NewConnectionEx()` или `connectionManager.NewConnection()`

## Сопоставление правил (`matchRule`)

Основной цикл сопоставления:

```go
func (r *Router) matchRule(ctx, metadata, preMatch, supportBypass, inputConn, inputPacketConn) (
    selectedRule, selectedRuleIndex, buffers, packetBuffers, fatalErr,
) {
    // Step 1: Process discovery
    if r.processSearcher != nil && metadata.ProcessInfo == nil {
        processInfo, _ := process.FindProcessInfo(r.processSearcher, ...)
        metadata.ProcessInfo = processInfo
    }

    // Step 2: Neighbor resolution (MAC address, hostname)
    if r.neighborResolver != nil && metadata.SourceMACAddress == nil {
        mac, _ := r.neighborResolver.LookupMAC(metadata.Source.Addr)
        hostname, _ := r.neighborResolver.LookupHostname(metadata.Source.Addr)
    }

    // Step 3: FakeIP lookup
    if metadata.Destination.Addr.IsValid() && r.dnsTransport.FakeIP() != nil {
        domain, loaded := r.dnsTransport.FakeIP().Store().Lookup(metadata.Destination.Addr)
        if loaded {
            metadata.OriginDestination = metadata.Destination
            metadata.Destination = M.Socksaddr{Fqdn: domain, Port: metadata.Destination.Port}
            metadata.FakeIP = true
        }
    }

    // Step 4: Reverse DNS lookup
    if metadata.Domain == "" {
        domain, loaded := r.dns.LookupReverseMapping(metadata.Destination.Addr)
        if loaded { metadata.Domain = domain }
    }

    // Step 5: Rule iteration
    for currentRuleIndex, currentRule := range r.rules {
        metadata.ResetRuleCache()
        if !currentRule.Match(metadata) {
            continue
        }

        // Apply route options from rule
        // ...

        // Execute action
        switch action := currentRule.Action().(type) {
        case *R.RuleActionSniff:
            // Peek at data, set metadata.Protocol/Domain
        case *R.RuleActionResolve:
            // DNS resolve, set metadata.DestinationAddresses
        case *R.RuleActionRoute:
            selectedRule = currentRule
            break match
        case *R.RuleActionReject:
            selectedRule = currentRule
            break match
        case *R.RuleActionHijackDNS:
            selectedRule = currentRule
            break match
        case *R.RuleActionBypass:
            selectedRule = currentRule
            break match
        }
    }
}
```

## Действия правил

### Route (терминальное)

```go
type RuleActionRoute struct {
    Outbound string
    RuleActionRouteOptions
}

type RuleActionRouteOptions struct {
    OverrideAddress         M.Socksaddr
    OverridePort            uint16
    NetworkStrategy         *C.NetworkStrategy
    NetworkType             []C.InterfaceType
    FallbackNetworkType     []C.InterfaceType
    FallbackDelay           time.Duration
    UDPDisableDomainUnmapping bool
    UDPConnect              bool
    UDPTimeout              time.Duration
    TLSFragment             bool
    TLSRecordFragment       bool
}
```

### Sniff (нетерминальное)

```go
type RuleActionSniff struct {
    StreamSniffers []sniff.StreamSniffer
    PacketSniffers []sniff.PacketSniffer
    SnifferNames   []string
    Timeout        time.Duration
    OverrideDestination bool
}
```

Анализ протоколов считывает начальные данные соединения для определения протокола и домена. Для TCP используется `sniff.PeekStream()`. Для UDP -- `sniff.PeekPacket()`.

### Resolve (нетерминальное)

```go
type RuleActionResolve struct {
    Server       string
    Strategy     C.DomainStrategy
    DisableCache bool
    RewriteTTL   *uint32
    ClientSubnet netip.Prefix
}
```

DNS-разрешение домена назначения и сохранение IP-адресов в `metadata.DestinationAddresses`.

### Reject (терминальное)

```go
type RuleActionReject struct {
    Method string  // "default", "drop", "reply"
}
```

### HijackDNS (терминальное)

Перехватывает соединение и обрабатывает его как DNS-запрос, перенаправляя к DNS-маршрутизатору.

### Bypass (терминальное)

```go
type RuleActionBypass struct {
    Outbound string
    RuleActionRouteOptions
}
```

## Интерфейс правила

```go
type Rule interface {
    HeadlessRule
    SimpleLifecycle
    Type() string
    Action() RuleAction
}

type HeadlessRule interface {
    Match(metadata *InboundContext) bool
    String() string
}
```

### Типы правил

- **DefaultRule**: Стандартное правило с условиями + действие
- **LogicalRule**: AND/OR-композиция подправил

### Элементы условий

Каждое условие проверяет один аспект метаданных:

| Условие | Поле | Сопоставление |
|---------|------|---------------|
| `domain` | Домен назначения | Полное, суффикс, ключевое слово, регулярное выражение |
| `ip_cidr` | IP назначения | Диапазон CIDR |
| `source_ip_cidr` | IP источника | Диапазон CIDR |
| `port` | Порт назначения | Точное значение или диапазон |
| `source_port` | Порт источника | Точное значение или диапазон |
| `protocol` | Определённый протокол | Точное совпадение |
| `network` | TCP/UDP | Точное совпадение |
| `inbound` | Тег входящего | Точное совпадение |
| `outbound` | Текущий исходящий | Точное совпадение |
| `package_name` | Пакет Android | Точное совпадение |
| `process_name` | Имя процесса | Точное совпадение |
| `process_path` | Путь процесса | Точное значение или регулярное выражение |
| `user` / `user_id` | Пользователь ОС | Точное совпадение |
| `clash_mode` | Режим Clash API | Точное совпадение |
| `wifi_ssid` / `wifi_bssid` | Состояние WIFI | Точное совпадение |
| `network_type` | Тип интерфейса | wifi/cellular/ethernet/other |
| `network_is_expensive` | Тарифицируемая сеть | Булево |
| `network_is_constrained` | Ограниченная сеть | Булево |
| `ip_is_private` | Частный IP | Булево |
| `ip_accept_any` | IP разрешён | Булево |
| `source_mac_address` | MAC-адрес источника | Точное совпадение |
| `source_hostname` | Имя хоста источника | Сопоставление домена |
| `query_type` | Тип DNS-запроса | A/AAAA/и т.д. |
| `rule_set` | Совпадение набора правил | Делегированное |
| `auth_user` | Пользователь прокси-авторизации | Точное совпадение |
| `client` | TLS-клиент (JA3) | Точное совпадение |

## Наборы правил

Наборы правил -- это коллекции правил, загружаемые из локальных файлов или удалённых URL:

```go
type RuleSet interface {
    Name() string
    StartContext(ctx, startContext) error
    PostStart() error
    Metadata() RuleSetMetadata
    ExtractIPSet() []*netipx.IPSet
    IncRef() / DecRef()  // reference counting
    HeadlessRule         // can be used as a condition
}
```

### Локальные наборы правил

Загружаются из бинарных файлов `.srs` (формат набора правил sing-box).

### Удалённые наборы правил

Скачиваются по URL, кешируются и автоматически обновляются. Несколько наборов правил скачиваются параллельно (максимум 5 одновременно).

## DNS-маршрутизация

DNS-запросы маршрутизируются отдельно через `dns.Router`:

```go
type DNSRule interface {
    Rule
    WithAddressLimit() bool
    MatchAddressLimit(metadata *InboundContext) bool
}
```

DNS-правила обладают дополнительной возможностью сопоставления по адресам ответа (для фильтрации нежелательных DNS-ответов).
