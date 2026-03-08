# Файл кэша

Файл кэша обеспечивает постоянное хранение различного состояния времени выполнения с использованием базы данных bbolt (встроенное B+-дерево). Он сохраняет сопоставления FakeIP, выбранные исходящие, режим Clash, содержимое удалённых наборов правил и кэш отклонённых DNS-ответов (RDRC).

**Исходный код**: `experimental/cachefile/`

## Архитектура

```go
type CacheFile struct {
    ctx               context.Context
    path              string
    cacheID           []byte           // необязательный префикс пространства имён
    storeFakeIP       bool
    storeRDRC         bool
    rdrcTimeout       time.Duration    // по умолчанию: 7 дней
    DB                *bbolt.DB

    // Буферы асинхронной записи
    saveMetadataTimer *time.Timer
    saveFakeIPAccess  sync.RWMutex
    saveDomain        map[netip.Addr]string
    saveAddress4      map[string]netip.Addr
    saveAddress6      map[string]netip.Addr
    saveRDRCAccess    sync.RWMutex
    saveRDRC          map[saveRDRCCacheKey]bool
}
```

## Структура бакетов

База данных использует несколько бакетов верхнего уровня:

| Имя бакета | Ключ | Описание |
|------------|------|----------|
| `selected` | тег группы | Выбранный исходящий для групп Selector |
| `group_expand` | тег группы | Состояние развёрнуто/свёрнуто в UI |
| `clash_mode` | cache ID | Текущий режим Clash API |
| `rule_set` | тег набора правил | Кэшированное содержимое удалённого набора правил |
| `rdrc2` | имя транспорта (подбакет) | Кэш отклонённых DNS-ответов |
| `fakeip_address` | байты IP | Сопоставление адреса FakeIP с доменом |
| `fakeip_domain4` | строка домена | Сопоставление домена FakeIP с IPv4 |
| `fakeip_domain6` | строка домена | Сопоставление домена FakeIP с IPv6 |
| `fakeip_metadata` | фиксированный ключ | Состояние аллокатора FakeIP |

### Пространство имён Cache ID

Когда настроен `cache_id`, большинство бакетов вкладываются в бакет верхнего уровня с префиксом cache ID (байт `0x00` + байты cache ID). Это позволяет нескольким экземплярам sing-box совместно использовать один файл базы данных:

```go
func (c *CacheFile) bucket(t *bbolt.Tx, key []byte) *bbolt.Bucket {
    if c.cacheID == nil {
        return t.Bucket(key)
    }
    bucket := t.Bucket(c.cacheID)  // бакет пространства имён
    if bucket == nil {
        return nil
    }
    return bucket.Bucket(key)  // фактический бакет внутри пространства имён
}
```

## Запуск и восстановление

```go
func (c *CacheFile) Start(stage adapter.StartStage) error {
    // Выполняется только на этапе StartStateInitialize
    // 1. Открытие bbolt с таймаутом 1 секунда, до 10 попыток
    // 2. При повреждении (ErrInvalid, ErrChecksum, ErrVersionMismatch):
    //    удаление файла и повторная попытка
    // 3. Очистка неизвестных бакетов (сборка мусора)
    // 4. Установка владельца файла через platform chown
}
```

База данных имеет механизм самовосстановления — при обнаружении повреждения во время доступа она удаляет и пересоздаёт файл:

```go
func (c *CacheFile) resetDB() {
    c.DB.Close()
    os.Remove(c.path)
    db, err := bbolt.Open(c.path, 0o666, ...)
    if err == nil {
        c.DB = db
    }
}
```

Все методы доступа к базе данных (`view`, `batch`, `update`) оборачивают операции с перехватом паник, который запускает `resetDB()` при повреждении.

## Кэш выбранного исходящего

Сохраняет выбор пользователя для групп исходящих Selector:

```go
func (c *CacheFile) LoadSelected(group string) string
func (c *CacheFile) StoreSelected(group, selected string) error
```

Используется группой исходящих Selector для запоминания выбранного пользователем исходящего между перезапусками.

## Кэш режима Clash

```go
func (c *CacheFile) LoadMode() string
func (c *CacheFile) StoreMode(mode string) error
```

Сохраняет текущий режим Clash API ("Rule", "Global", "Direct"), чтобы он пережил перезапуски.

## Кэш наборов правил

Удалённые наборы правил кэшируются с их содержимым, временем последнего обновления и HTTP ETag:

```go
func (c *CacheFile) LoadRuleSet(tag string) *adapter.SavedBinary
func (c *CacheFile) SaveRuleSet(tag string, set *adapter.SavedBinary) error
```

Структура `SavedBinary` содержит:
- `Content []byte` — необработанные данные набора правил (JSON или двоичный SRS)
- `LastUpdated time.Time` — когда последний раз данные были успешно получены
- `LastEtag string` — HTTP ETag для условных запросов

## Кэш FakeIP

FakeIP поддерживает двунаправленные сопоставления между фиктивными IP-адресами и доменными именами.

### Макет хранения

Три бакета работают совместно:
- `fakeip_address`: `байты IP -> строка домена` (обратный поиск)
- `fakeip_domain4`: `домен -> байты IPv4` (прямой поиск, IPv4)
- `fakeip_domain6`: `домен -> байты IPv6` (прямой поиск, IPv6)

### Операции записи

```go
func (c *CacheFile) FakeIPStore(address netip.Addr, domain string) error {
    // 1. Чтение старого домена для этого адреса (если есть)
    // 2. Сохранение адрес -> домен
    // 3. Удаление старого сопоставления домен -> адрес
    // 4. Сохранение нового сопоставления домен -> адрес
}
```

### Оптимизация асинхронной записи

Записи FakeIP критичны по производительности, поэтому предоставляется слой асинхронной буферизации:

```go
func (c *CacheFile) FakeIPStoreAsync(address netip.Addr, domain string, logger) {
    // 1. Буферизация сопоставления в словарях в памяти
    // 2. Запуск горутины для сохранения в bbolt
    // 3. Операции чтения сначала проверяют буфер в памяти
}
```

Буфер в памяти (`saveDomain`, `saveAddress4`, `saveAddress6`) проверяется `FakeIPLoad` и `FakeIPLoadDomain` перед обращением к базе данных, обеспечивая согласованность во время асинхронных записей.

### Сохранение метаданных

Метаданные аллокатора FakeIP (текущий указатель выделения) сохраняются с таймером антидребезга:

```go
func (c *CacheFile) FakeIPSaveMetadataAsync(metadata *adapter.FakeIPMetadata) {
    // Использует time.AfterFunc с FakeIPMetadataSaveInterval
    // Сбрасывает таймер при каждом вызове для группировки быстрых выделений
}
```

## RDRC (кэш отклонённых DNS-ответов)

RDRC кэширует DNS-ответы, которые были отклонены (напр., пустые или заблокированные ответы), избегая повторных запросов для доменов, которые известны как заблокированные.

### Ключ хранения

```go
type saveRDRCCacheKey struct {
    TransportName string
    QuestionName  string
    QType         uint16
}
```

В базе данных ключом является `[uint16 big-endian: qtype][строка домена]`, вложенный в подбакет с именем DNS-транспорта.

### Истечение срока действия

Каждая запись RDRC хранит метку времени истечения:

```go
func (c *CacheFile) LoadRDRC(transportName, qName string, qType uint16) (rejected bool) {
    // 1. Сначала проверка асинхронного буфера в памяти
    // 2. Чтение из базы данных
    // 3. Парсинг метки времени истечения (uint64 big-endian Unix-секунды)
    // 4. Если истекло, удаление записи и возврат false
    // 5. Если действительно, возврат true (домен отклонён)
}

func (c *CacheFile) SaveRDRC(transportName, qName string, qType uint16) error {
    // Сохранение с истечением = сейчас + rdrcTimeout (по умолчанию 7 дней)
    // Ключ: [2 байта qtype][байты домена]
    // Значение: [8 байт метка времени истечения unix big-endian]
}
```

### Асинхронные записи RDRC

Как и FakeIP, записи RDRC буферизуются в памяти для немедленного обратного чтения:

```go
func (c *CacheFile) SaveRDRCAsync(transportName, qName string, qType uint16, logger) {
    // Буферизация в словаре saveRDRC
    // Асинхронное сохранение в горутине
}
```

## Конфигурация

```json
{
  "experimental": {
    "cache_file": {
      "enabled": true,
      "path": "cache.db",
      "cache_id": "my-instance",
      "store_fakeip": true,
      "store_rdrc": true,
      "rdrc_timeout": "168h"
    }
  }
}
```

## Замечания по реализации

1. **bbolt** — это чисто Go-шная встроенная база данных на основе B+-дерева (форк boltdb). Любое встроенное хранилище ключ-значение с поддержкой бакетов/пространств имён подойдёт в качестве замены (напр., SQLite, LevelDB)
2. **Восстановление после повреждения** критически важно — файл кэша может быть повреждён из-за аварий или отключения питания. Стратегия удаления и пересоздания проста, но эффективна
3. **Асинхронная буферизация записи** важна для производительности FakeIP и RDRC. Эти операции происходят при каждом DNS-запросе и не должны блокировать горячий путь
4. **Пространство имён Cache ID** позволяет нескольким экземплярам совместно использовать один файл базы данных без конфликтов
5. **Двунаправленное сопоставление FakeIP** должно поддерживаться согласованным — при обновлении сопоставления адреса старое сопоставление домена должно быть сначала удалено
6. **Таймаут RDRC** контролирует, как долго кэшируются отклонённые DNS-ответы. Значение по умолчанию в 7 дней подходит для наборов правил блокировки рекламы, которые не меняются часто
7. Бакет `group_expand` хранит один байт (`0` или `1`) для состояния UI в панелях управления Clash — это чисто косметическое сохранение
