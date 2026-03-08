# Структура конфигурации

sing-box использует формат конфигурации на основе JSON с чётко определённой корневой структурой. Парсинг конфигурации использует контекстно-зависимый JSON-декодер с реестрами типов для полиморфных типов.

**Исходный код**: `option/options.go`, `option/inbound.go`, `option/outbound.go`, `option/endpoint.go`, `option/dns.go`, `option/route.go`, `option/service.go`, `option/experimental.go`

## Корневая структура опций

```go
type _Options struct {
    RawMessage   json.RawMessage      `json:"-"`
    Schema       string               `json:"$schema,omitempty"`
    Log          *LogOptions          `json:"log,omitempty"`
    DNS          *DNSOptions          `json:"dns,omitempty"`
    NTP          *NTPOptions          `json:"ntp,omitempty"`
    Certificate  *CertificateOptions  `json:"certificate,omitempty"`
    Endpoints    []Endpoint           `json:"endpoints,omitempty"`
    Inbounds     []Inbound            `json:"inbounds,omitempty"`
    Outbounds    []Outbound           `json:"outbounds,omitempty"`
    Route        *RouteOptions        `json:"route,omitempty"`
    Services     []Service            `json:"services,omitempty"`
    Experimental *ExperimentalOptions `json:"experimental,omitempty"`
}

type Options _Options
```

### Пример конфигурации

```json
{
  "$schema": "https://sing-box.sagernet.org/schema.json",
  "log": {
    "level": "info"
  },
  "dns": {
    "servers": [...],
    "rules": [...]
  },
  "inbounds": [
    {"type": "tun", "tag": "tun-in", ...},
    {"type": "mixed", "tag": "mixed-in", ...}
  ],
  "outbounds": [
    {"type": "direct", "tag": "direct"},
    {"type": "vless", "tag": "proxy", ...},
    {"type": "selector", "tag": "select", ...}
  ],
  "endpoints": [
    {"type": "wireguard", "tag": "wg", ...}
  ],
  "route": {
    "rules": [...],
    "rule_set": [...],
    "final": "proxy"
  },
  "services": [
    {"type": "resolved", "tag": "resolved-dns", ...}
  ],
  "experimental": {
    "cache_file": {"enabled": true},
    "clash_api": {"external_controller": "127.0.0.1:9090"}
  }
}
```

## Валидация

Метод `Options.UnmarshalJSONContext` выполняет валидацию:

```go
func (o *Options) UnmarshalJSONContext(ctx context.Context, content []byte) error {
    decoder := json.NewDecoderContext(ctx, bytes.NewReader(content))
    decoder.DisallowUnknownFields()  // строгий парсинг
    err := decoder.Decode((*_Options)(o))
    o.RawMessage = content
    return checkOptions(o)
}
```

Проверки после парсинга:
- **Дублирование тегов входящих**: Два входящих не могут иметь одинаковый тег
- **Дублирование тегов исходящих/эндпоинтов**: Теги исходящих и эндпоинтов разделяют одно пространство имён; дубликаты не допускаются

```go
func checkInbounds(inbounds []Inbound) error {
    seen := make(map[string]bool)
    for i, inbound := range inbounds {
        tag := inbound.Tag
        if tag == "" { tag = F.ToString(i) }
        if seen[tag] { return E.New("duplicate inbound tag: ", tag) }
        seen[tag] = true
    }
    return nil
}
```

## Парсинг типизированных входящих/исходящих/эндпоинтов

Входящие, исходящие, эндпоинты, DNS-серверы и сервисы используют один и тот же паттерн для полиморфного JSON-парсинга: поле `type` определяет, в какую структуру опций парсить оставшиеся поля.

### Паттерн

Каждая типизированная структура имеет одинаковое строение:

```go
type _Inbound struct {
    Type    string `json:"type"`
    Tag     string `json:"tag,omitempty"`
    Options any    `json:"-"`          // специфичные для типа опции, не в JSON напрямую
}
```

### Контекстно-зависимая десериализация

Десериализация использует `context.Context` Go для передачи реестров типов:

```go
func (h *Inbound) UnmarshalJSONContext(ctx context.Context, content []byte) error {
    // 1. Парсинг полей "type" и "tag"
    err := json.UnmarshalContext(ctx, content, (*_Inbound)(h))

    // 2. Получение реестра опций из контекста
    registry := service.FromContext[InboundOptionsRegistry](ctx)

    // 3. Создание типизированной структуры опций для данного типа
    options, loaded := registry.CreateOptions(h.Type)

    // 4. Парсинг оставшихся полей (исключая type/tag) в типизированную структуру
    err = badjson.UnmarshallExcludedContext(ctx, content, (*_Inbound)(h), options)

    // 5. Сохранение распарсенных опций
    h.Options = options
    return nil
}
```

Функция `badjson.UnmarshallExcluded` является ключевой — она парсит JSON-объект, исключая поля, которые уже были распарсены другой структурой. Это позволяет обрабатывать `type` и `tag` отдельно от специфичных для протокола опций.

### Интерфейсы реестров

```go
type InboundOptionsRegistry interface {
    CreateOptions(inboundType string) (any, bool)
}

type OutboundOptionsRegistry interface {
    CreateOptions(outboundType string) (any, bool)
}

type EndpointOptionsRegistry interface {
    CreateOptions(endpointType string) (any, bool)
}

type DNSTransportOptionsRegistry interface {
    CreateOptions(transportType string) (any, bool)
}

type ServiceOptionsRegistry interface {
    CreateOptions(serviceType string) (any, bool)
}
```

## Опции DNS

Конфигурация DNS имеет двойную структуру для обратной совместимости:

```go
type DNSOptions struct {
    RawDNSOptions        // текущий формат
    LegacyDNSOptions     // устаревший формат (автоматическое обновление)
}

type RawDNSOptions struct {
    Servers        []DNSServerOptions `json:"servers,omitempty"`
    Rules          []DNSRule          `json:"rules,omitempty"`
    Final          string             `json:"final,omitempty"`
    ReverseMapping bool               `json:"reverse_mapping,omitempty"`
    DNSClientOptions
}
```

DNS-серверы используют тот же типизированный паттерн:

```go
type DNSServerOptions struct {
    Type    string `json:"type,omitempty"`
    Tag     string `json:"tag,omitempty"`
    Options any    `json:"-"`
}
```

Устаревший формат DNS-сервера (на основе URL, как `tls://1.1.1.1`) автоматически обновляется до нового типизированного формата во время десериализации.

## Опции маршрутизации

```go
type RouteOptions struct {
    GeoIP                      *GeoIPOptions
    Geosite                    *GeositeOptions
    Rules                      []Rule
    RuleSet                    []RuleSet
    Final                      string
    FindProcess                bool
    FindNeighbor               bool
    AutoDetectInterface        bool
    OverrideAndroidVPN         bool
    DefaultInterface           string
    DefaultMark                FwMark
    DefaultDomainResolver      *DomainResolveOptions
    DefaultNetworkStrategy     *NetworkStrategy
    DefaultNetworkType         badoption.Listable[InterfaceType]
    DefaultFallbackNetworkType badoption.Listable[InterfaceType]
    DefaultFallbackDelay       badoption.Duration
}
```

## Экспериментальные опции

```go
type ExperimentalOptions struct {
    CacheFile *CacheFileOptions `json:"cache_file,omitempty"`
    ClashAPI  *ClashAPIOptions  `json:"clash_api,omitempty"`
    V2RayAPI  *V2RayAPIOptions  `json:"v2ray_api,omitempty"`
    Debug     *DebugOptions     `json:"debug,omitempty"`
}
```

## Опции логирования

```go
type LogOptions struct {
    Disabled     bool   `json:"disabled,omitempty"`
    Level        string `json:"level,omitempty"`
    Output       string `json:"output,omitempty"`
    Timestamp    bool   `json:"timestamp,omitempty"`
    DisableColor bool   `json:"-"`      // внутреннее, не из JSON
}
```

## Общие типы опций

### ListenOptions (входящие)

```go
type ListenOptions struct {
    Listen               *badoption.Addr
    ListenPort           uint16
    BindInterface        string
    RoutingMark          FwMark
    ReuseAddr            bool
    NetNs                string
    DisableTCPKeepAlive  bool
    TCPKeepAlive         badoption.Duration
    TCPKeepAliveInterval badoption.Duration
    TCPFastOpen          bool
    TCPMultiPath         bool
    UDPFragment          *bool
    UDPTimeout           UDPTimeoutCompat
    Detour               string
}
```

### DialerOptions (исходящие)

```go
type DialerOptions struct {
    Detour               string
    BindInterface        string
    Inet4BindAddress     *badoption.Addr
    Inet6BindAddress     *badoption.Addr
    ProtectPath          string
    RoutingMark          FwMark
    NetNs                string
    ConnectTimeout       badoption.Duration
    TCPFastOpen          bool
    TCPMultiPath         bool
    DomainResolver       *DomainResolveOptions
    NetworkStrategy      *NetworkStrategy
    NetworkType          badoption.Listable[InterfaceType]
    FallbackNetworkType  badoption.Listable[InterfaceType]
    FallbackDelay        badoption.Duration
}
```

### ServerOptions (исходящие)

```go
type ServerOptions struct {
    Server     string `json:"server"`
    ServerPort uint16 `json:"server_port"`
}

func (o ServerOptions) Build() M.Socksaddr {
    return M.ParseSocksaddrHostPort(o.Server, o.ServerPort)
}
```

## Замечания по реализации

1. **Контекстно-зависимый JSON-парсинг** является центральным элементом дизайна. `context.Context` несёт реестры типов, внедрённые при запуске, обеспечивая полиморфный парсинг без рефлексии или генерации кода
2. **`badjson.UnmarshallExcluded`** — это пользовательский JSON-парсер, который позволяет двум структурам разделять один JSON-объект, распределяя поля между ними. Так `type`/`tag` отделяются от опций протокола
3. **`DisallowUnknownFields`** включён, делая парсер строгим — опечатки в именах полей вызывают ошибки парсинга
4. **Миграция устаревших форматов** обрабатывается непосредственно во время десериализации (напр., устаревшие URL DNS-серверов, устаревшие поля входящих). Флаг контекста `dontUpgrade` позволяет выполнять сериализацию «туда-обратно» без запуска миграции
5. **Валидация** минимальна на этапе парсинга — проверяется только уникальность тегов. Семантическая валидация (напр., обязательные поля, валидные адреса) происходит при создании сервисов
6. **`RawMessage`** сохраняется в корневом `Options` для обеспечения повторной сериализации или пересылки оригинальной конфигурации
