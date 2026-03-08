# Базы данных GeoIP и GeoSite

sing-box поддерживает два устаревших формата географических баз данных для маршрутизации на основе IP и доменов: GeoIP (формат MaxMind MMDB) и GeoSite (пользовательский двоичный формат). Они заменяются более новой системой наборов правил, но остаются поддерживаемыми для обратной совместимости.

**Исходный код**: `common/geoip/`, `common/geosite/`, `option/route.go`

## GeoIP (MaxMind MMDB)

### Обзор

GeoIP использует модифицированную базу данных MaxMind MMDB с идентификатором типа базы данных `sing-geoip` (не стандартный MaxMind `GeoLite2-Country`). Это специально созданная база данных, которая сопоставляет IP-адреса напрямую с кодами стран.

### Реализация ридера

```go
type Reader struct {
    reader *maxminddb.Reader
}

func Open(path string) (*Reader, []string, error) {
    database, err := maxminddb.Open(path)
    if err != nil {
        return nil, nil, err
    }
    if database.Metadata.DatabaseType != "sing-geoip" {
        database.Close()
        return nil, nil, E.New("incorrect database type, expected sing-geoip, got ",
            database.Metadata.DatabaseType)
    }
    return &Reader{database}, database.Metadata.Languages, nil
}
```

Ключевые моменты:
- **Валидация типа базы данных**: Принимает только базы данных с типом `sing-geoip`, отклоняя стандартные базы MaxMind
- **Коды языков**: Возвращает список доступных кодов стран через `database.Metadata.Languages`
- **Поиск**: Сопоставляет `netip.Addr` напрямую со строкой кода страны; возвращает `"unknown"`, если не найдено

```go
func (r *Reader) Lookup(addr netip.Addr) string {
    var code string
    _ = r.reader.Lookup(addr.AsSlice(), &code)
    if code != "" {
        return code
    }
    return "unknown"
}
```

### Формат MMDB

Формат MMDB — это двоичная структура на основе бора (trie), разработанная для эффективного поиска по IP-префиксам. Библиотека `maxminddb-golang` обеспечивает парсинг. Для варианта `sing-geoip`:
- Секция данных хранит простые строковые значения (коды стран), а не вложенные структуры
- Секция метаданных использует `Languages` для хранения списка доступных кодов стран
- IPv4 и IPv6 адреса поддерживаются через структуру бора

### Конфигурация

```json
{
  "route": {
    "geoip": {
      "path": "geoip.db",
      "download_url": "https://github.com/SagerNet/sing-geoip/releases/latest/download/geoip.db",
      "download_detour": "proxy"
    }
  }
}
```

## GeoSite (пользовательский двоичный формат)

### Обзор

GeoSite — это пользовательский двоичный формат базы данных, который сопоставляет коды категорий (такие как `google`, `category-ads-all`) со списками доменных правил. Каждое доменное правило имеет тип (точное, суффикс, ключевое слово, регулярное выражение) и значение.

### Структура файла

```
[uint8: version (0)]
[uvarint: entry_count]
  [uvarint: code_length] [bytes: code_string]
  [uvarint: byte_offset]
  [uvarint: item_count]
  ...
[domain items data...]
```

Файл состоит из двух секций:
1. **Секция метаданных**: Индекс, сопоставляющий коды категорий с байтовыми смещениями и количеством элементов
2. **Секция данных**: Фактические доменные элементы, хранящиеся последовательно

### Типы элементов

```go
type ItemType = uint8

const (
    RuleTypeDomain        ItemType = 0  // Точное совпадение домена
    RuleTypeDomainSuffix  ItemType = 1  // Совпадение по суффиксу домена (напр., ".google.com")
    RuleTypeDomainKeyword ItemType = 2  // Домен содержит ключевое слово
    RuleTypeDomainRegex   ItemType = 3  // Совпадение по регулярному выражению
)

type Item struct {
    Type  ItemType
    Value string
}
```

### Реализация ридера

```go
type Reader struct {
    access         sync.Mutex
    reader         io.ReadSeeker
    bufferedReader *bufio.Reader
    metadataIndex  int64           // байтовое смещение начала секции данных
    domainIndex    map[string]int  // код -> байтовое смещение в секции данных
    domainLength   map[string]int  // код -> количество элементов
}
```

Ридер работает в два этапа:
1. **`readMetadata()`**: Читает весь индекс при открытии, строя словари из кода в смещение/длину
2. **`Read(code)`**: Выполняет поиск по смещению кода в секции данных и читает элементы по запросу

```go
func (r *Reader) Read(code string) ([]Item, error) {
    index, exists := r.domainIndex[code]
    if !exists {
        return nil, E.New("code ", code, " not exists!")
    }
    _, err := r.reader.Seek(r.metadataIndex+int64(index), io.SeekStart)
    // ... чтение элементов
}
```

Каждый элемент в секции данных хранится как:
```
[uint8: item_type]
[uvarint: value_length] [bytes: value_string]
```

### Реализация записи

Писатель сначала строит секцию данных в памяти для вычисления смещений:

```go
func Write(writer varbin.Writer, domains map[string][]Item) error {
    // 1. Сортировка кодов по алфавиту
    // 2. Запись всех элементов в буфер с фиксацией байтовых смещений для каждого кода
    // 3. Запись байта версии (0)
    // 4. Запись количества записей
    // 5. Для каждого кода: запись строки кода, байтового смещения, количества элементов
    // 6. Запись буферизированных данных элементов
}
```

### Компиляция в правила

Элементы GeoSite компилируются в опции правил sing-box:

```go
func Compile(code []Item) option.DefaultRule {
    // Сопоставляет каждый ItemType с соответствующим полем правила:
    //   RuleTypeDomain        -> rule.Domain
    //   RuleTypeDomainSuffix  -> rule.DomainSuffix
    //   RuleTypeDomainKeyword -> rule.DomainKeyword
    //   RuleTypeDomainRegex   -> rule.DomainRegex
}
```

Несколько скомпилированных правил можно объединить с помощью `Merge()`, который конкатенирует все списки доменов.

### Конфигурация

```json
{
  "route": {
    "geosite": {
      "path": "geosite.db",
      "download_url": "https://github.com/SagerNet/sing-geosite/releases/latest/download/geosite.db",
      "download_detour": "proxy"
    }
  }
}
```

## Использование в правилах

В правилах маршрутизации ссылки на GeoIP и GeoSite используются следующим образом:

```json
{
  "route": {
    "rules": [
      {
        "geoip": ["cn", "private"],
        "outbound": "direct"
      },
      {
        "geosite": ["category-ads-all"],
        "outbound": "block"
      }
    ]
  }
}
```

Маршрутизатор загружает базу данных при запуске, читает запрошенные коды и компилирует их в матчеры правил в памяти. Коды GeoIP создают правила IP CIDR; коды GeoSite создают правила домен/ключевое слово/регулярное выражение.

## Миграция на наборы правил

GeoIP и GeoSite считаются устаревшими. Рекомендуемый путь миграции — использование наборов правил SRS, которые:
- Поддерживают больше типов правил (порты, процессы, сетевые условия)
- Имеют лучшие механизмы обновления (HTTP с ETag, наблюдение за файлами)
- Позволяют встроенные определения без внешних файлов
- Используют более компактный двоичный формат со сжатием zlib

## Замечания по реализации

1. **GeoIP**: Зависит от `github.com/oschwald/maxminddb-golang` для парсинга MMDB. Формат MMDB хорошо документирован и имеет реализации на многих языках. Единственная специфичная для sing-box особенность — проверка типа базы данных `sing-geoip`
2. **GeoSite**: Использует пользовательский двоичный формат с кодированием uvarint. Формат прост для реализации: прочитать индекс, перейти к нужному смещению, прочитать элементы
3. **Потокобезопасность**: Ридер GeoSite использует мьютекс, поскольку он разделяет seekable-ридер и буферизированный ридер между вызовами. Реимплементация может использовать отдельные ридеры для каждого вызова, если данные достаточно малы для кэширования в памяти
4. **Отслеживание байтовых смещений**: Обёртка `readCounter` отслеживает, сколько байт потребила секция метаданных, учитывая опережающее чтение буферизированного ридера через `reader.Buffered()`
