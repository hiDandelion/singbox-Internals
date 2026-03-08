# Пользовательские типы опций

sing-box определяет несколько пользовательских типов в пакете `option` для парсинга конфигурации. Эти типы обеспечивают преобразование между читаемыми JSON-значениями и внутренними Go-представлениями.

**Исходный код**: `option/types.go`, `option/inbound.go`, `option/outbound.go`, `option/udp_over_tcp.go`

## NetworkList

Принимает либо одну строку сети, либо массив, внутренне хранится как строка, разделённая символом новой строки:

```go
type NetworkList string

func (v *NetworkList) UnmarshalJSON(content []byte) error {
    // Принимает: "tcp" или ["tcp", "udp"]
    // Допустимые значения: "tcp", "udp"
    // Хранится как "tcp\nudp"
}

func (v NetworkList) Build() []string {
    // Возвращает ["tcp", "udp"] если пусто (по умолчанию: оба)
    return strings.Split(string(v), "\n")
}
```

**Примеры JSON**:
```json
"tcp"
["tcp", "udp"]
```

## DomainStrategy

Сопоставление между строковыми именами стратегий и внутренними константами:

```go
type DomainStrategy C.DomainStrategy

// Сопоставление:
//   ""              -> DomainStrategyAsIS
//   "as_is"         -> DomainStrategyAsIS
//   "prefer_ipv4"   -> DomainStrategyPreferIPv4
//   "prefer_ipv6"   -> DomainStrategyPreferIPv6
//   "ipv4_only"     -> DomainStrategyIPv4Only
//   "ipv6_only"     -> DomainStrategyIPv6Only
```

**Примеры JSON**:
```json
""
"prefer_ipv4"
"ipv6_only"
```

## DNSQueryType

Обрабатывает типы DNS-запросов как числовые значения или стандартные строковые имена (через библиотеку `miekg/dns`):

```go
type DNSQueryType uint16

func (t *DNSQueryType) UnmarshalJSON(bytes []byte) error {
    // Принимает: 28 или "AAAA"
    // Использует mDNS.StringToType и mDNS.TypeToString для преобразования
}

func (t DNSQueryType) MarshalJSON() ([]byte, error) {
    // Выводит строковое имя, если известно, иначе числовое значение
}
```

**Примеры JSON**:
```json
"A"
"AAAA"
28
```

## NetworkStrategy

Сопоставление строковых имён сетевых стратегий с внутренними константами:

```go
type NetworkStrategy C.NetworkStrategy

func (n *NetworkStrategy) UnmarshalJSON(content []byte) error {
    // Использует словарь C.StringToNetworkStrategy
}
```

## InterfaceType

Представляет типы сетевых интерфейсов (WIFI, Cellular, Ethernet, Other):

```go
type InterfaceType C.InterfaceType

func (t InterfaceType) Build() C.InterfaceType {
    return C.InterfaceType(t)
}

func (t *InterfaceType) UnmarshalJSON(content []byte) error {
    // Использует словарь C.StringToInterfaceType
}
```

**Примеры JSON**:
```json
"wifi"
"cellular"
"ethernet"
```

## UDPTimeoutCompat

Обрабатывает обратно совместимые значения таймаута UDP — принимает либо необработанное число (секунды), либо строку продолжительности:

```go
type UDPTimeoutCompat badoption.Duration

func (c *UDPTimeoutCompat) UnmarshalJSON(data []byte) error {
    // Первая попытка: парсинг как целое число (секунды)
    var valueNumber int64
    err := json.Unmarshal(data, &valueNumber)
    if err == nil {
        *c = UDPTimeoutCompat(time.Second * time.Duration(valueNumber))
        return nil
    }
    // Запасной вариант: парсинг как строка продолжительности (напр., "5m")
    return json.Unmarshal(data, (*badoption.Duration)(c))
}
```

**Примеры JSON**:
```json
300
"5m"
"30s"
```

## DomainResolveOptions

Поддерживает сокращённую форму (только имя сервера) или полный объект:

```go
type DomainResolveOptions struct {
    Server       string
    Strategy     DomainStrategy
    DisableCache bool
    RewriteTTL   *uint32
    ClientSubnet *badoption.Prefixable
}

func (o *DomainResolveOptions) UnmarshalJSON(bytes []byte) error {
    // Попытка строки: "dns-server-tag"
    // Откат к полному объекту
}

func (o DomainResolveOptions) MarshalJSON() ([]byte, error) {
    // Если установлен только Server, сериализация как строка
    // Иначе сериализация как объект
}
```

**Примеры JSON**:
```json
"my-dns-server"

{
  "server": "my-dns-server",
  "strategy": "ipv4_only",
  "disable_cache": true,
  "rewrite_ttl": 300,
  "client_subnet": "1.2.3.0/24"
}
```

## UDPOverTCPOptions

Поддерживает сокращённую булеву форму или полный объект:

```go
type UDPOverTCPOptions struct {
    Enabled bool  `json:"enabled,omitempty"`
    Version uint8 `json:"version,omitempty"`
}

func (o *UDPOverTCPOptions) UnmarshalJSON(bytes []byte) error {
    // Попытка bool: true/false
    // Откат к полному объекту
}

func (o UDPOverTCPOptions) MarshalJSON() ([]byte, error) {
    // Если версия по умолчанию (0 или текущая), сериализация как bool
    // Иначе сериализация как объект
}
```

**Примеры JSON**:
```json
true

{
  "enabled": true,
  "version": 2
}
```

## Listable[T] (из badoption)

Не определён в `option/types.go`, но широко используется повсюду. `badoption.Listable[T]` принимает либо одно значение, либо массив:

```go
type Listable[T any] []T

func (l *Listable[T]) UnmarshalJSON(content []byte) error {
    // Сначала попытка массива, затем одиночное значение
}
```

**Примеры JSON**:
```json
"value"
["value1", "value2"]

443
[443, 8443]
```

## Duration (из badoption)

`badoption.Duration` оборачивает `time.Duration` с парсингом JSON-строк:

```go
type Duration time.Duration

func (d *Duration) UnmarshalJSON(bytes []byte) error {
    // Парсит строки продолжительности Go: "5s", "1m30s", "24h"
}
```

**Примеры JSON**:
```json
"30s"
"5m"
"24h"
"1h30m"
```

## Addr (из badoption)

`badoption.Addr` оборачивает `netip.Addr` с парсингом JSON-строк:

**Примеры JSON**:
```json
"127.0.0.1"
"::1"
"0.0.0.0"
```

## Prefix (из badoption)

`badoption.Prefix` оборачивает `netip.Prefix` для CIDR-нотации:

**Примеры JSON**:
```json
"198.18.0.0/15"
"fc00::/7"
```

## Prefixable (из badoption)

`badoption.Prefixable` расширяет парсинг префиксов для принятия голых адресов (которые трактуются как /32 или /128):

**Примеры JSON**:
```json
"192.168.1.0/24"
"192.168.1.1"
```

## FwMark

`FwMark` используется для меток маршрутизации Linux (`SO_MARK`). Определён в другом месте пакета option и принимает целочисленные значения:

**Пример JSON**:
```json
255
```

## Замечания по реализации

1. **Паттерны сокращённой записи**: Многие типы поддерживают как простую форму (строка/bool), так и полную объектную форму. Десериализация должна сначала пытаться использовать простую форму, затем откатываться к сложной
2. **Listable[T]**: Это наиболее часто используемый пользовательский тип. Практически каждое поле-массив в конфигурации принимает как одиночные значения, так и массивы
3. **Парсинг продолжительности**: Использует формат `time.ParseDuration` Go, который поддерживает: `ns`, `us`/`\u00b5s`, `ms`, `s`, `m`, `h`
4. **Типы DNS-запросов**: Словарь `StringToType` библиотеки `miekg/dns` предоставляет каноническое сопоставление между именами вроде `"AAAA"` и числовыми значениями вроде `28`
5. **NetworkList**: Внутреннее хранение через разделение новой строкой — это деталь реализации; реимплементация может использовать простой срез строк
6. **UDPTimeoutCompat**: Двойной парсинг число/строка обеспечивает обратную совместимость со старыми конфигурациями, использовавшими секунды в виде чисел
