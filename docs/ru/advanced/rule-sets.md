# Наборы правил

Наборы правил предоставляют переиспользуемые коллекции правил маршрутизации, которые могут загружаться из встроенных определений, локальных файлов или удалённых URL. Они являются современной заменой устаревших баз данных GeoIP/GeoSite.

**Исходный код**: `common/srs/`, `route/rule/rule_set.go`, `route/rule/rule_set_local.go`, `route/rule/rule_set_remote.go`, `option/rule_set.go`

## Двоичный формат SRS

Формат SRS (Sing-box Rule Set) — это компактное двоичное представление наборов правил, разработанное для эффективной загрузки и уменьшения размера файла по сравнению с исходными JSON-файлами.

### Структура файла

```
+--------+--------+------------------------------+
| Magic  | Version| zlib-compressed rule data    |
| 3 bytes| 1 byte |                              |
+--------+--------+------------------------------+
```

```go
var MagicBytes = [3]byte{0x53, 0x52, 0x53} // ASCII "SRS"
```

### История версий

| Версия | Константа | Новые возможности |
|--------|-----------|-------------------|
| 1 | `RuleSetVersion1` | Начальный формат |
| 2 | `RuleSetVersion2` | Правила доменов AdGuard |
| 3 | `RuleSetVersion3` | `network_type`, `network_is_expensive`, `network_is_constrained` |
| 4 | `RuleSetVersion4` | `network_interface_address`, `default_interface_address` |

### Процесс чтения

```go
func Read(reader io.Reader, recover bool) (PlainRuleSetCompat, error) {
    // 1. Чтение и проверка 3-байтового магического заголовка "SRS"
    // 2. Чтение 1-байтового номера версии (big-endian uint8)
    // 3. Открытие ридера декомпрессии zlib
    // 4. Чтение uvarint для количества правил
    // 5. Последовательное чтение каждого правила
}
```

Флаг `recover` определяет, будут ли оптимизированные для двоичного формата структуры (такие как матчеры доменов и IP-наборы) развёрнуты обратно в читаемую форму (списки строк). Это используется при декомпиляции `.srs` обратно в JSON.

### Макет сжатых данных

После 4-байтового заголовка все последующие данные сжаты zlib (наилучший уровень сжатия). Внутри распакованного потока:

```
[uvarint: rule_count]
[rule_0]
[rule_1]
...
[rule_N]
```

### Кодирование правил

Каждое правило начинается с байта типа `uint8`:

| Байт типа | Значение |
|-----------|----------|
| `0` | Обычное правило (плоские условия) |
| `1` | Логическое правило (AND/OR подправил) |

#### Элементы обычного правила

Обычное правило — это последовательность типизированных элементов, завершающаяся `0xFF`:

```
[uint8: 0x00 (default rule)]
[uint8: item_type] [item_data...]
[uint8: item_type] [item_data...]
...
[uint8: 0xFF (final)]
[bool: invert]
```

Константы типов элементов:

```go
const (
    ruleItemQueryType              uint8 = 0   // []uint16 (big-endian)
    ruleItemNetwork                uint8 = 1   // []string
    ruleItemDomain                 uint8 = 2   // domain.Matcher binary
    ruleItemDomainKeyword          uint8 = 3   // []string
    ruleItemDomainRegex            uint8 = 4   // []string
    ruleItemSourceIPCIDR           uint8 = 5   // IPSet binary
    ruleItemIPCIDR                 uint8 = 6   // IPSet binary
    ruleItemSourcePort             uint8 = 7   // []uint16 (big-endian)
    ruleItemSourcePortRange        uint8 = 8   // []string
    ruleItemPort                   uint8 = 9   // []uint16 (big-endian)
    ruleItemPortRange              uint8 = 10  // []string
    ruleItemProcessName            uint8 = 11  // []string
    ruleItemProcessPath            uint8 = 12  // []string
    ruleItemPackageName            uint8 = 13  // []string
    ruleItemWIFISSID               uint8 = 14  // []string
    ruleItemWIFIBSSID              uint8 = 15  // []string
    ruleItemAdGuardDomain          uint8 = 16  // AdGuardMatcher binary (v2+)
    ruleItemProcessPathRegex       uint8 = 17  // []string
    ruleItemNetworkType            uint8 = 18  // []uint8 (v3+)
    ruleItemNetworkIsExpensive     uint8 = 19  // no data (v3+)
    ruleItemNetworkIsConstrained   uint8 = 20  // no data (v3+)
    ruleItemNetworkInterfaceAddress uint8 = 21 // TypedMap (v4+)
    ruleItemDefaultInterfaceAddress uint8 = 22 // []Prefix (v4+)
    ruleItemFinal                  uint8 = 0xFF
)
```

#### Кодирование массива строк

```
[uvarint: count]
  [uvarint: string_length] [bytes: string_data]
  ...
```

#### Кодирование массива uint16

```
[uvarint: count]
[uint16 big-endian] [uint16 big-endian] ...
```

#### Кодирование IP-набора

IP-наборы хранятся в виде диапазонов, а не CIDR-префиксов, для компактности:

```
[uint8: version (must be 1)]
[uint64 big-endian: range_count]
  [uvarint: from_addr_length] [bytes: from_addr]
  [uvarint: to_addr_length]   [bytes: to_addr]
  ...
```

Реализация использует `unsafe.Pointer` для прямого переинтерпретирования внутренней структуры `netipx.IPSet` (которая хранит IP-диапазоны как пары `{from, to}`). IPv4-адреса занимают 4 байта; IPv6-адреса — 16 байт.

#### Кодирование IP-префикса

Отдельные префиксы (используются в правилах адресов сетевого интерфейса v4+):

```
[uvarint: addr_byte_length]
[bytes: addr_bytes]
[uint8: prefix_bits]
```

#### Кодирование логического правила

```
[uint8: 0x01 (logical rule)]
[uint8: mode]  // 0 = AND, 1 = OR
[uvarint: sub_rule_count]
[sub_rule_0]
[sub_rule_1]
...
[bool: invert]
```

## Типы наборов правил

### Фабричная функция

```go
func NewRuleSet(ctx, logger, options) (adapter.RuleSet, error) {
    switch options.Type {
    case "inline", "local", "":
        return NewLocalRuleSet(ctx, logger, options)
    case "remote":
        return NewRemoteRuleSet(ctx, logger, options), nil
    }
}
```

### Локальный набор правил

`LocalRuleSet` обрабатывает как встроенные правила (встроенные в конфигурационный JSON), так и файловые наборы правил.

```go
type LocalRuleSet struct {
    ctx        context.Context
    logger     logger.Logger
    tag        string
    access     sync.RWMutex
    rules      []adapter.HeadlessRule
    metadata   adapter.RuleSetMetadata
    fileFormat string              // "source" (JSON) или "binary" (SRS)
    watcher    *fswatch.Watcher    // наблюдатель изменений файла
    callbacks  list.List[adapter.RuleSetUpdateCallback]
    refs       atomic.Int32        // подсчёт ссылок
}
```

Ключевые особенности поведения:
- **Встроенный режим**: Правила парсятся из `options.InlineOptions.Rules` во время создания
- **Файловый режим**: Правила загружаются из `options.LocalOptions.Path`, и настраивается `fswatch.Watcher` для автоматической перезагрузки при изменении файла
- **Автоопределение формата**: Расширение файла `.json` выбирает исходный формат; `.srs` выбирает двоичный формат
- **Горячая перезагрузка**: Когда наблюдатель обнаруживает изменения, `reloadFile()` перечитывает и перепарсивает файл, а затем уведомляет все зарегистрированные обратные вызовы

### Удалённый набор правил

`RemoteRuleSet` загружает наборы правил по URL с периодическим автообновлением.

```go
type RemoteRuleSet struct {
    ctx            context.Context
    cancel         context.CancelFunc
    logger         logger.ContextLogger
    outbound       adapter.OutboundManager
    options        option.RuleSet
    updateInterval time.Duration    // по умолчанию: 24 часа
    dialer         N.Dialer
    access         sync.RWMutex
    rules          []adapter.HeadlessRule
    metadata       adapter.RuleSetMetadata
    lastUpdated    time.Time
    lastEtag       string           // HTTP ETag для условных запросов
    updateTicker   *time.Ticker
    cacheFile      adapter.CacheFile
    pauseManager   pause.Manager
    callbacks      list.List[adapter.RuleSetUpdateCallback]
    refs           atomic.Int32
}
```

Ключевые особенности поведения:
- **Постоянное кэширование**: При запуске загружает кэшированное содержимое из `adapter.CacheFile` (база данных bbolt). Если кэшированные данные существуют, использует их немедленно вместо загрузки
- **Поддержка ETag**: Использует HTTP `If-None-Match` / `304 Not Modified` для предотвращения повторной загрузки неизменённых наборов правил
- **Маршрут загрузки**: Может направлять трафик загрузки через указанный исходящий (например, для использования прокси при загрузке наборов правил)
- **Цикл обновления**: После `PostStart()` запускает `loopUpdate()` в горутине, которая проверяет обновления через `updateInterval`
- **Управление памятью**: После обновления, если `refs == 0` (нет активных ссылок на правила), распарсенные правила устанавливаются в `nil` для освобождения памяти, с явным вызовом `runtime.GC()`

## Подсчёт ссылок

И `LocalRuleSet`, и `RemoteRuleSet` реализуют подсчёт ссылок через `atomic.Int32`:

```go
func (s *LocalRuleSet) IncRef()  { s.refs.Add(1) }
func (s *LocalRuleSet) DecRef()  {
    if s.refs.Add(-1) < 0 {
        panic("rule-set: negative refs")
    }
}
func (s *LocalRuleSet) Cleanup() {
    if s.refs.Load() == 0 {
        s.rules = nil  // освобождение памяти при отсутствии ссылок
    }
}
```

Это позволяет маршрутизатору отслеживать, какие наборы правил активно используются правилами маршрутизации, и освобождать память для неиспользуемых.

## Метаданные набора правил

После загрузки правил вычисляются метаданные для определения необходимых типов поиска:

```go
type RuleSetMetadata struct {
    ContainsProcessRule bool  // требуется поиск процессов
    ContainsWIFIRule    bool  // требуется состояние WIFI
    ContainsIPCIDRRule  bool  // требуются разрешённые IP-адреса
}
```

Эти флаги позволяют маршрутизатору пропускать затратные операции (такие как поиск имени процесса или DNS-разрешение), когда ни один набор правил не требует их.

## Извлечение IP-набора

Наборы правил поддерживают извлечение всех элементов IP CIDR в значения `netipx.IPSet` через `ExtractIPSet()`. Это используется для системных оптимизаций, таких как настройка таблицы маршрутизации TUN, где IP-правила должны применяться на уровне сетевого стека, а не для каждого соединения.

## Конфигурация

```json
{
  "route": {
    "rule_set": [
      {
        "type": "local",
        "tag": "geoip-cn",
        "format": "binary",
        "path": "geoip-cn.srs"
      },
      {
        "type": "remote",
        "tag": "geosite-category-ads",
        "format": "binary",
        "url": "https://example.com/geosite-category-ads.srs",
        "download_detour": "proxy",
        "update_interval": "24h"
      },
      {
        "tag": "my-rules",
        "rules": [
          {
            "domain_suffix": [".example.com"]
          }
        ]
      }
    ]
  }
}
```

## Замечания по реализации

1. Двоичный формат SRS использует Go-пакет `encoding/binary` с порядком байтов big-endian и `binary.ReadUvarint`/`varbin.WriteUvarint` для целых чисел переменной длины
2. Сопоставление доменов использует `sing/common/domain.Matcher`, который имеет собственный формат двоичной сериализации — это зависимость, которую необходимо реализовать или импортировать
3. Двоичный формат IP-набора использует `unsafe.Pointer` для прямого манипулирования внутренними структурами `netipx.IPSet` — в реимплементации следует использовать корректную сериализацию IP-диапазонов
4. Сжатие zlib использует уровень `zlib.BestCompression` при записи
5. Автоопределение формата проверяет расширения файлов: `.json` = исходный, `.srs` = двоичный
6. Кэширование на основе ETag для удалённых наборов правил должно обрабатывать как `200 OK` (новое содержимое), так и `304 Not Modified` (обновление только метки времени)
