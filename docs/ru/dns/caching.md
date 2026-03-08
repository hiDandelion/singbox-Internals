# Кэширование DNS и обработка ответов

Исходный код: `dns/client.go`, `dns/client_truncate.go`, `dns/client_log.go`, `dns/extension_edns0_subnet.go`, `dns/rcode.go`, `experimental/cachefile/rdrc.go`, `experimental/cachefile/cache.go`, `common/compatible/map.go`

## Архитектура кэша

Клиент DNS использует `freelru` (сегментированный LRU-кэш из `github.com/sagernet/sing/contrab/freelru`) для кэширования ответов. Доступны два взаимоисключающих режима кэширования:

```go
type Client struct {
    timeout            time.Duration
    disableCache       bool
    disableExpire      bool
    independentCache   bool
    clientSubnet       netip.Prefix
    rdrc               adapter.RDRCStore
    initRDRCFunc       func() adapter.RDRCStore
    logger             logger.ContextLogger
    cache              freelru.Cache[dns.Question, *dns.Msg]
    cacheLock          compatible.Map[dns.Question, chan struct{}]
    transportCache     freelru.Cache[transportCacheKey, *dns.Msg]
    transportCacheLock compatible.Map[dns.Question, chan struct{}]
}
```

### Общий кэш (по умолчанию)

Ключ -- `dns.Question` (Name + Qtype + Qclass). Все транспорты разделяют одно пространство имён кэша, то есть кэшированный ответ от транспорта A может обслуживать запрос, который пошёл бы к транспорту B.

### Независимый кэш

Когда `independentCache` равен true, ключ кэша -- `transportCacheKey`:

```go
type transportCacheKey struct {
    dns.Question
    transportTag string
}
```

Каждый транспорт получает собственное пространство имён кэша, предотвращая кросс-транспортные попадания в кэш. Это важно, когда разные транспорты возвращают разные результаты для одного домена (например, отечественный DNS против зарубежного DNS, возвращающих разные IP).

### Инициализация

```go
func NewClient(options ClientOptions) *Client {
    cacheCapacity := options.CacheCapacity
    if cacheCapacity < 1024 {
        cacheCapacity = 1024
    }
    if !client.disableCache {
        if !client.independentCache {
            client.cache = common.Must1(freelru.NewSharded[dns.Question, *dns.Msg](
                cacheCapacity, maphash.NewHasher[dns.Question]().Hash32))
        } else {
            client.transportCache = common.Must1(freelru.NewSharded[transportCacheKey, *dns.Msg](
                cacheCapacity, maphash.NewHasher[transportCacheKey]().Hash32))
        }
    }
}
```

Минимальная ёмкость -- 1024 записи. Конструктор `freelru.NewSharded` создаёт сегментированный LRU-кэш с хэш-функцией, сгенерированной `maphash.NewHasher`. Создаётся только один из двух кэшей (`cache` или `transportCache`), в зависимости от флага `independentCache`.

## Дедупликация кэша

Клиент предотвращает эффект "громового стада" (thundering herd) от одновременных идентичных запросов, используя блокировку на основе каналов через `compatible.Map` (обобщённая обёртка над `sync.Map`):

```go
if c.cache != nil {
    cond, loaded := c.cacheLock.LoadOrStore(question, make(chan struct{}))
    if loaded {
        // Another goroutine is already querying this question
        select {
        case <-cond:           // Wait for the in-flight query to complete
        case <-ctx.Done():     // Or context cancellation
            return nil, ctx.Err()
        }
    } else {
        // This goroutine wins the race; clean up when done
        defer func() {
            c.cacheLock.Delete(question)
            close(cond)  // Signal all waiters
        }()
    }
}
```

Механизм работает следующим образом:

1. `LoadOrStore` атомарно проверяет, существует ли уже канал для данного вопроса
2. Если `loaded` равен true, другая горутина уже выполняет запрос. Текущая горутина блокируется на канале
3. Если `loaded` равен false, текущая горутина продолжает выполнение запроса. По завершении она удаляет запись и закрывает канал, разблокируя всех ожидающих
4. После разблокировки ожидающие переходят к `loadResponse`, который извлекает уже закэшированный результат

Тот же паттерн используется для `transportCacheLock`, когда активен режим независимого кэша.

## Определение кэшируемости

Не все DNS-сообщения кэшируются. Запрос кэшируется только если это "простой запрос":

```go
isSimpleRequest := len(message.Question) == 1 &&
    len(message.Ns) == 0 &&
    (len(message.Extra) == 0 || len(message.Extra) == 1 &&
        message.Extra[0].Header().Rrtype == dns.TypeOPT &&
        message.Extra[0].Header().Class > 0 &&
        message.Extra[0].Header().Ttl == 0 &&
        len(message.Extra[0].(*dns.OPT).Option) == 0) &&
    !options.ClientSubnet.IsValid()

disableCache := !isSimpleRequest || c.disableCache || options.DisableCache
```

Простой запрос содержит:
- Ровно один вопрос
- Нет авторитетных записей
- Нет дополнительных записей (или ровно одна запись OPT без опций, с положительным размером UDP и нулевым расширенным rcode)
- Нет переопределения подсети клиента для конкретного запроса

Кроме того, ответы с кодами ошибок, отличными от SUCCESS и NXDOMAIN, никогда не кэшируются:

```go
disableCache = disableCache || (response.Rcode != dns.RcodeSuccess && response.Rcode != dns.RcodeNameError)
```

## Сохранение в кэш

```go
func (c *Client) storeCache(transport adapter.DNSTransport, question dns.Question, message *dns.Msg, timeToLive uint32) {
    if timeToLive == 0 {
        return
    }
    if c.disableExpire {
        if !c.independentCache {
            c.cache.Add(question, message)
        } else {
            c.transportCache.Add(transportCacheKey{
                Question:     question,
                transportTag: transport.Tag(),
            }, message)
        }
    } else {
        if !c.independentCache {
            c.cache.AddWithLifetime(question, message, time.Second*time.Duration(timeToLive))
        } else {
            c.transportCache.AddWithLifetime(transportCacheKey{
                Question:     question,
                transportTag: transport.Tag(),
            }, message, time.Second*time.Duration(timeToLive))
        }
    }
}
```

Ключевые особенности поведения:
- Ответы с нулевым TTL никогда не кэшируются
- Когда `disableExpire` равен true, записи добавляются без времени жизни (они сохраняются до вытеснения по LRU)
- Когда `disableExpire` равен false, записи истекают на основе TTL ответа

## Извлечение из кэша и корректировка TTL

При загрузке кэшированного ответа TTL корректируются с учётом прошедшего времени:

```go
func (c *Client) loadResponse(question dns.Question, transport adapter.DNSTransport) (*dns.Msg, int) {
    if c.disableExpire {
        // No expiration: return cached response as-is (copied)
        response, loaded = c.cache.Get(question)
        if !loaded { return nil, 0 }
        return response.Copy(), 0
    }

    // With expiration: get entry with lifetime info
    response, expireAt, loaded = c.cache.GetWithLifetime(question)
    if !loaded { return nil, 0 }

    // Manual expiration check (belt-and-suspenders)
    timeNow := time.Now()
    if timeNow.After(expireAt) {
        c.cache.Remove(question)
        return nil, 0
    }

    // Calculate remaining TTL
    var originTTL int
    for _, recordList := range [][]dns.RR{response.Answer, response.Ns, response.Extra} {
        for _, record := range recordList {
            if originTTL == 0 || record.Header().Ttl > 0 && int(record.Header().Ttl) < originTTL {
                originTTL = int(record.Header().Ttl)
            }
        }
    }
    nowTTL := int(expireAt.Sub(timeNow).Seconds())
    if nowTTL < 0 { nowTTL = 0 }

    response = response.Copy()
    if originTTL > 0 {
        duration := uint32(originTTL - nowTTL)
        for _, recordList := range [][]dns.RR{response.Answer, response.Ns, response.Extra} {
            for _, record := range recordList {
                record.Header().Ttl = record.Header().Ttl - duration
            }
        }
    } else {
        for _, recordList := range [][]dns.RR{response.Answer, response.Ns, response.Extra} {
            for _, record := range recordList {
                record.Header().Ttl = uint32(nowTTL)
            }
        }
    }
    return response, nowTTL
}
```

Логика корректировки TTL:
1. Найти минимальный TTL по всем записям (`originTTL`) -- это был TTL при сохранении записи
2. Вычислить `nowTTL` как оставшиеся секунды до истечения
3. Вычислить `duration = originTTL - nowTTL` (время, прошедшее с момента кэширования)
4. Вычесть `duration` из TTL каждой записи, чтобы клиенты видели убывающие TTL со временем
5. Если `originTTL` равен 0 (все записи имели нулевой TTL), установить все TTL в оставшееся время жизни

Ответы всегда копируются через `.Copy()` перед возвратом, чтобы предотвратить мутацию закэшированных записей вызывающим кодом.

## Нормализация TTL

Перед кэшированием все TTL записей в ответе нормализуются до единого значения:

```go
var timeToLive uint32
if len(response.Answer) == 0 {
    // Negative response: use SOA minimum TTL
    if soaTTL, hasSOA := extractNegativeTTL(response); hasSOA {
        timeToLive = soaTTL
    }
}
if timeToLive == 0 {
    // Find minimum TTL across all sections
    for _, recordList := range [][]dns.RR{response.Answer, response.Ns, response.Extra} {
        for _, record := range recordList {
            if timeToLive == 0 || record.Header().Ttl > 0 && record.Header().Ttl < timeToLive {
                timeToLive = record.Header().Ttl
            }
        }
    }
}
if options.RewriteTTL != nil {
    timeToLive = *options.RewriteTTL
}
// Apply uniform TTL to all records
for _, recordList := range [][]dns.RR{response.Answer, response.Ns, response.Extra} {
    for _, record := range recordList {
        record.Header().Ttl = timeToLive
    }
}
```

### Извлечение отрицательного TTL

Для ответов NXDOMAIN без записей ответов TTL извлекается из записи SOA в секции авторитетных записей:

```go
func extractNegativeTTL(response *dns.Msg) (uint32, bool) {
    for _, record := range response.Ns {
        if soa, isSOA := record.(*dns.SOA); isSOA {
            soaTTL := soa.Header().Ttl
            soaMinimum := soa.Minttl
            if soaTTL < soaMinimum {
                return soaTTL, true
            }
            return soaMinimum, true
        }
    }
    return 0, false
}
```

Функция возвращает `min(soa.Header().Ttl, soa.Minttl)`, следуя рекомендациям RFC 2308 по отрицательному кэшированию.

## Быстрый путь кэша для Lookup

Метод `Lookup` (домен в адреса) имеет быстрый путь, который проверяет кэш перед построением полного DNS-сообщения:

```go
func (c *Client) lookupToExchange(ctx context.Context, transport adapter.DNSTransport,
    name string, qType uint16, options adapter.DNSQueryOptions,
    responseChecker func(responseAddrs []netip.Addr) bool) ([]netip.Addr, error) {
    question := dns.Question{Name: name, Qtype: qType, Qclass: dns.ClassINET}
    disableCache := c.disableCache || options.DisableCache
    if !disableCache {
        cachedAddresses, err := c.questionCache(question, transport)
        if err != ErrNotCached {
            return cachedAddresses, err
        }
    }
    // ... proceed with full Exchange
}

func (c *Client) questionCache(question dns.Question, transport adapter.DNSTransport) ([]netip.Addr, error) {
    response, _ := c.loadResponse(question, transport)
    if response == nil {
        return nil, ErrNotCached
    }
    if response.Rcode != dns.RcodeSuccess {
        return nil, RcodeError(response.Rcode)
    }
    return MessageToAddresses(response), nil
}
```

Это обходит механизм дедупликации и напрямую проверяет кэш. Если существует кэшированный ответ NXDOMAIN, он возвращает соответствующую `RcodeError` без выполнения сетевого запроса.

## RDRC (кэш отклонённых доменов ответов)

RDRC кэширует комбинации домен/тип запроса/транспорт, которые были отклонены правилами ограничения адресов. Это предотвращает повторные запросы к транспорту, который заведомо возвращает неприемлемые адреса.

### Интерфейс

```go
type RDRCStore interface {
    LoadRDRC(transportName string, qName string, qType uint16) (rejected bool)
    SaveRDRC(transportName string, qName string, qType uint16) error
    SaveRDRCAsync(transportName string, qName string, qType uint16, logger logger.Logger)
}
```

### Инициализация

Хранилище RDRC лениво инициализируется из файла кэша при запуске клиента:

```go
func (c *Client) Start() {
    if c.initRDRCFunc != nil {
        c.rdrc = c.initRDRCFunc()
    }
}
```

В маршрутизаторе функция инициализации проверяет, поддерживает ли файл кэша RDRC:

```go
RDRC: func() adapter.RDRCStore {
    cacheFile := service.FromContext[adapter.CacheFile](ctx)
    if cacheFile == nil {
        return nil
    }
    if !cacheFile.StoreRDRC() {
        return nil
    }
    return cacheFile
},
```

### Бэкенд хранения (bbolt)

RDRC сохраняется с использованием bbolt (форк BoltDB) в бакете с именем `"rdrc2"`:

```go
var bucketRDRC = []byte("rdrc2")
```

#### Формат ключа

Ключи имеют формат `[2 байта qType (big-endian)][байты qName]`, хранятся в суб-бакете, названном по тегу транспорта:

```go
key := buf.Get(2 + len(qName))
binary.BigEndian.PutUint16(key, qType)
copy(key[2:], qName)
```

#### Формат значения

Значения -- это 8-байтовые Unix-временные метки (big-endian), представляющие время истечения:

```go
expiresAt := buf.Get(8)
binary.BigEndian.PutUint64(expiresAt, uint64(time.Now().Add(c.rdrcTimeout).Unix()))
return bucket.Put(key, expiresAt)
```

### Таймаут по умолчанию

Записи RDRC истекают через 7 дней по умолчанию:

```go
if options.StoreRDRC {
    if options.RDRCTimeout > 0 {
        rdrcTimeout = time.Duration(options.RDRCTimeout)
    } else {
        rdrcTimeout = 7 * 24 * time.Hour
    }
}
```

### Асинхронное сохранение с кэшем в памяти

Для предотвращения блокировки пути запроса на дисковых записях записи RDRC сохраняются асинхронно с опережающим кэшем записи в памяти:

```go
type CacheFile struct {
    // ...
    saveRDRCAccess sync.RWMutex
    saveRDRC       map[saveRDRCCacheKey]bool
}

func (c *CacheFile) SaveRDRCAsync(transportName string, qName string, qType uint16, logger logger.Logger) {
    saveKey := saveRDRCCacheKey{transportName, qName, qType}
    c.saveRDRCAccess.Lock()
    c.saveRDRC[saveKey] = true        // Immediately visible to reads
    c.saveRDRCAccess.Unlock()
    go func() {
        err := c.SaveRDRC(transportName, qName, qType)    // Persist to bbolt
        if err != nil {
            logger.Warn("save RDRC: ", err)
        }
        c.saveRDRCAccess.Lock()
        delete(c.saveRDRC, saveKey)   // Remove from write-ahead cache
        c.saveRDRCAccess.Unlock()
    }()
}
```

При загрузке сначала проверяется кэш в памяти, и только затем выполняется чтение из bbolt:

```go
func (c *CacheFile) LoadRDRC(transportName string, qName string, qType uint16) (rejected bool) {
    c.saveRDRCAccess.RLock()
    rejected, cached := c.saveRDRC[saveRDRCCacheKey{transportName, qName, qType}]
    c.saveRDRCAccess.RUnlock()
    if cached {
        return
    }
    // Fall through to bbolt read...
}
```

### Истечение срока действия

При загрузке из bbolt истёкшие записи обнаруживаются и очищаются лениво:

```go
content := bucket.Get(key)
expiresAt := time.Unix(int64(binary.BigEndian.Uint64(content)), 0)
if time.Now().After(expiresAt) {
    deleteCache = true   // Mark for deletion
    return nil           // Not rejected
}
rejected = true
```

Удаление происходит в отдельной транзакции `Update`, чтобы избежать удержания блокировки транзакции чтения во время записи.

### Интеграция с Exchange

RDRC проверяется после дедупликации кэша, но перед обменом через транспорт:

```go
if !disableCache && responseChecker != nil && c.rdrc != nil {
    rejected := c.rdrc.LoadRDRC(transport.Tag(), question.Name, question.Qtype)
    if rejected {
        return nil, ErrResponseRejectedCached
    }
}
```

И сохраняется, когда ответ отклоняется проверкой ограничения адресов:

```go
if rejected {
    if !disableCache && c.rdrc != nil {
        c.rdrc.SaveRDRCAsync(transport.Tag(), question.Name, question.Qtype, c.logger)
    }
    return response, ErrResponseRejected
}
```

Цикл повторных попыток маршрутизатора использует `ErrResponseRejected` и `ErrResponseRejectedCached` для перехода к следующему подходящему правилу.

## Подсеть клиента EDNS0

Клиент внедряет опции подсети клиента EDNS0 (ECS) в DNS-сообщения перед обменом:

```go
clientSubnet := options.ClientSubnet
if !clientSubnet.IsValid() {
    clientSubnet = c.clientSubnet      // Fall back to global setting
}
if clientSubnet.IsValid() {
    message = SetClientSubnet(message, clientSubnet)
}
```

### Реализация

```go
func SetClientSubnet(message *dns.Msg, clientSubnet netip.Prefix) *dns.Msg {
    return setClientSubnet(message, clientSubnet, true)
}

func setClientSubnet(message *dns.Msg, clientSubnet netip.Prefix, clone bool) *dns.Msg {
    var (
        optRecord    *dns.OPT
        subnetOption *dns.EDNS0_SUBNET
    )
    // Search for existing OPT record and EDNS0_SUBNET option
    for _, record := range message.Extra {
        if optRecord, isOPTRecord = record.(*dns.OPT); isOPTRecord {
            for _, option := range optRecord.Option {
                subnetOption, isEDNS0Subnet = option.(*dns.EDNS0_SUBNET)
                if isEDNS0Subnet { break }
            }
        }
    }
    // Create OPT record if not found
    if optRecord == nil {
        exMessage := *message
        message = &exMessage
        optRecord = &dns.OPT{Hdr: dns.RR_Header{Name: ".", Rrtype: dns.TypeOPT}}
        message.Extra = append(message.Extra, optRecord)
    } else if clone {
        return setClientSubnet(message.Copy(), clientSubnet, false)
    }
    // Create or update subnet option
    if subnetOption == nil {
        subnetOption = new(dns.EDNS0_SUBNET)
        subnetOption.Code = dns.EDNS0SUBNET
        optRecord.Option = append(optRecord.Option, subnetOption)
    }
    if clientSubnet.Addr().Is4() {
        subnetOption.Family = 1
    } else {
        subnetOption.Family = 2
    }
    subnetOption.SourceNetmask = uint8(clientSubnet.Bits())
    subnetOption.Address = clientSubnet.Addr().AsSlice()
    return message
}
```

Ключевые детали:
- Первый вызов использует `clone = true`, который копирует сообщение, если запись OPT уже существует (чтобы избежать мутации оригинала)
- Если запись OPT не существует, выполняется поверхностная копия сообщения и добавляется новая запись OPT
- Family 1 = IPv4, Family 2 = IPv6
- Сообщения с установленной подсетью клиента для конкретного запроса (`options.ClientSubnet.IsValid()`) исключаются из кэширования

### Понижение версии EDNS0

После получения ответа клиент обрабатывает несоответствия версий EDNS0:

```go
requestEDNSOpt := message.IsEdns0()
responseEDNSOpt := response.IsEdns0()
if responseEDNSOpt != nil && (requestEDNSOpt == nil || requestEDNSOpt.Version() < responseEDNSOpt.Version()) {
    response.Extra = common.Filter(response.Extra, func(it dns.RR) bool {
        return it.Header().Rrtype != dns.TypeOPT
    })
    if requestEDNSOpt != nil {
        response.SetEdns0(responseEDNSOpt.UDPSize(), responseEDNSOpt.Do())
    }
}
```

Если версия EDNS0 ответа выше, чем у запроса (или запрос не содержал EDNS0), запись OPT удаляется и при необходимости заменяется совместимой по версии.

## Усечение DNS-сообщений

Для UDP DNS-ответов, превышающих максимальный размер сообщения, применяется усечение с учётом EDNS0:

```go
func TruncateDNSMessage(request *dns.Msg, response *dns.Msg, headroom int) (*buf.Buffer, error) {
    maxLen := 512
    if edns0Option := request.IsEdns0(); edns0Option != nil {
        if udpSize := int(edns0Option.UDPSize()); udpSize > 512 {
            maxLen = udpSize
        }
    }
    responseLen := response.Len()
    if responseLen > maxLen {
        response = response.Copy()
        response.Truncate(maxLen)
    }
    buffer := buf.NewSize(headroom*2 + 1 + responseLen)
    buffer.Resize(headroom, 0)
    rawMessage, err := response.PackBuffer(buffer.FreeBytes())
    if err != nil {
        buffer.Release()
        return nil, err
    }
    buffer.Truncate(len(rawMessage))
    return buffer, nil
}
```

- Максимум по умолчанию -- 512 байт (стандартное ограничение DNS UDP)
- Если запрос содержит запись EDNS0 OPT с большим размером UDP, используется этот размер
- Усечение выполняется на копии, чтобы избежать мутации кэшированного ответа
- Буфер включает запас для обрамления протокола (например, заголовки UDP)

## Очистка кэша

```go
func (c *Client) ClearCache() {
    if c.cache != nil {
        c.cache.Purge()
    } else if c.transportCache != nil {
        c.transportCache.Purge()
    }
}
```

Вызывается маршрутизатором при изменении сети:

```go
func (r *Router) ResetNetwork() {
    r.ClearCache()
    for _, transport := range r.transport.Transports() {
        transport.Reset()
    }
}

func (r *Router) ClearCache() {
    r.client.ClearCache()
    if r.platformInterface != nil {
        r.platformInterface.ClearDNSCache()
    }
}
```

Это также очищает DNS-кэш на уровне платформы (например, на Android/iOS), если доступен интерфейс платформы.

## Фильтрация по стратегии

Перед любым взаимодействием с кэшем или транспортом запросы, конфликтующие со стратегией домена, немедленно получают пустой успешный ответ:

```go
if question.Qtype == dns.TypeA && options.Strategy == C.DomainStrategyIPv6Only ||
   question.Qtype == dns.TypeAAAA && options.Strategy == C.DomainStrategyIPv4Only {
    return FixedResponseStatus(message, dns.RcodeSuccess), nil
}
```

Это предотвращает ненужные записи в кэше и сетевые обращения для несоответствующих типов запросов.

## Фильтрация записей HTTPS

Для запросов HTTPS (SVCB тип 65) адресные подсказки фильтруются на основе стратегии домена:

```go
if question.Qtype == dns.TypeHTTPS {
    if options.Strategy == C.DomainStrategyIPv4Only || options.Strategy == C.DomainStrategyIPv6Only {
        for _, rr := range response.Answer {
            https, isHTTPS := rr.(*dns.HTTPS)
            if !isHTTPS { continue }
            content := https.SVCB
            content.Value = common.Filter(content.Value, func(it dns.SVCBKeyValue) bool {
                if options.Strategy == C.DomainStrategyIPv4Only {
                    return it.Key() != dns.SVCB_IPV6HINT
                } else {
                    return it.Key() != dns.SVCB_IPV4HINT
                }
            })
            https.SVCB = content
        }
    }
}
```

Стратегия IPv4-only удаляет подсказки IPv6; стратегия IPv6-only удаляет подсказки IPv4. Эта фильтрация происходит после обмена через транспорт, но перед кэшированием, поэтому кэшированные HTTPS-ответы уже отфильтрованы.

## Обнаружение петель

Петли DNS-запросов обнаруживаются путём пометки контекста текущим транспортом:

```go
contextTransport, loaded := transportTagFromContext(ctx)
if loaded && transport.Tag() == contextTransport {
    return nil, E.New("DNS query loopback in transport[", contextTransport, "]")
}
ctx = contextWithTransportTag(ctx, transport.Tag())
```

Это предотвращает бесконечную рекурсию, когда транспорту необходимо разрешить имя хоста своего сервера (например, транспорт DoH для `dns.example.com` пытается разрешить `dns.example.com` через самого себя).

## Логирование

Три функции логирования обеспечивают структурированный вывод для событий DNS:

```go
func logCachedResponse(logger, ctx, response, ttl)    // "cached example.com NOERROR 42"
func logExchangedResponse(logger, ctx, response, ttl)  // "exchanged example.com NOERROR 300"
func logRejectedResponse(logger, ctx, response)         // "rejected A example.com 1.2.3.4"
```

Каждая функция логирует домен на уровне DEBUG и отдельные записи на уровне INFO. Вспомогательная функция `FormatQuestion` нормализует строки записей miekg/dns, удаляя точки с запятой, сворачивая пробелы и обрезая концы строк.

## Типы ошибок

```go
type RcodeError int

const (
    RcodeSuccess     RcodeError = mDNS.RcodeSuccess
    RcodeFormatError RcodeError = mDNS.RcodeFormatError
    RcodeNameError   RcodeError = mDNS.RcodeNameError
    RcodeRefused     RcodeError = mDNS.RcodeRefused
)

func (e RcodeError) Error() string {
    return mDNS.RcodeToString[int(e)]
}
```

Сигнальные ошибки:
- `ErrNoRawSupport` -- транспорт не поддерживает необработанные DNS-сообщения
- `ErrNotCached` -- промах кэша (используется внутренне в `questionCache`)
- `ErrResponseRejected` -- ответ не прошёл проверку ограничения адресов
- `ErrResponseRejectedCached` -- расширяет `ErrResponseRejected`, указывает, что отклонение обслужено из RDRC

## Конфигурация

```json
{
  "dns": {
    "client_options": {
      "disable_cache": false,
      "disable_expire": false,
      "independent_cache": false,
      "cache_capacity": 1024,
      "client_subnet": "1.2.3.0/24"
    }
  },
  "experimental": {
    "cache_file": {
      "enabled": true,
      "path": "cache.db",
      "store_rdrc": true,
      "rdrc_timeout": "168h"
    }
  }
}
```

| Поле | По умолчанию | Описание |
|------|-------------|----------|
| `disable_cache` | `false` | Отключить всё кэширование DNS-ответов |
| `disable_expire` | `false` | Записи кэша никогда не истекают (вытесняются только по LRU) |
| `independent_cache` | `false` | Отдельное пространство имён кэша для каждого транспорта |
| `cache_capacity` | `1024` | Максимальное количество записей кэша (минимум 1024) |
| `client_subnet` | нет | Префикс подсети клиента EDNS0 по умолчанию |
| `store_rdrc` | `false` | Включить сохранение RDRC в файл кэша |
| `rdrc_timeout` | `168h` (7 дней) | Время истечения записей RDRC |
