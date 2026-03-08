# Клиент и маршрутизатор DNS

Исходный код: `dns/client.go`, `dns/router.go`, `dns/rcode.go`, `dns/client_truncate.go`, `dns/client_log.go`, `dns/extension_edns0_subnet.go`

## Клиент DNS

### Структура

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

Два режима кэширования:
- **Общий кэш** (`cache`): Ключ -- `dns.Question` (Name + Qtype + Qclass)
- **Независимый кэш** (`transportCache`): Ключ -- `transportCacheKey` (Question + тег транспорта), так что каждый транспорт имеет собственное пространство имён кэша

Кэш использует `github.com/sagernet/sing/contrab/freelru` (сегментированный LRU-кэш). Ёмкость по умолчанию -- 1024 записи.

### Exchange

Основной метод `Exchange` обрабатывает полный жизненный цикл запроса:

```go
func (c *Client) Exchange(ctx context.Context, transport adapter.DNSTransport,
    message *dns.Msg, options adapter.DNSQueryOptions,
    responseChecker func(responseAddrs []netip.Addr) bool) (*dns.Msg, error)
```

#### Шаг 1: Фильтрация по стратегии

Немедленно возвращает пустой успешный ответ при несоответствии стратегий:

```go
if question.Qtype == dns.TypeA && options.Strategy == C.DomainStrategyIPv6Only ||
   question.Qtype == dns.TypeAAAA && options.Strategy == C.DomainStrategyIPv4Only {
    return FixedResponseStatus(message, dns.RcodeSuccess), nil
}
```

#### Шаг 2: Подсеть клиента

```go
clientSubnet := options.ClientSubnet
if !clientSubnet.IsValid() {
    clientSubnet = c.clientSubnet
}
if clientSubnet.IsValid() {
    message = SetClientSubnet(message, clientSubnet)
}
```

#### Шаг 3: Проверка кэша

Кэшируются только "простые запросы" (один вопрос, нет дополнительных записей кроме OPT, нет подсети клиента в параметрах):

```go
isSimpleRequest := len(message.Question) == 1 &&
    len(message.Ns) == 0 &&
    (len(message.Extra) == 0 || len(message.Extra) == 1 &&
        message.Extra[0].Header().Rrtype == dns.TypeOPT &&
        message.Extra[0].Header().Class > 0 &&
        message.Extra[0].Header().Ttl == 0 &&
        len(message.Extra[0].(*dns.OPT).Option) == 0) &&
    !options.ClientSubnet.IsValid()
```

Дедупликация кэша предотвращает одновременные идентичные запросы:

```go
cond, loaded := c.cacheLock.LoadOrStore(question, make(chan struct{}))
if loaded {
    select {
    case <-cond:     // Wait for first query to complete
    case <-ctx.Done(): return nil, ctx.Err()
    }
}
```

#### Шаг 4: Загрузка из кэша с корректировкой TTL

```go
func (c *Client) loadResponse(question dns.Question, transport adapter.DNSTransport) (*dns.Msg, int) {
    response, expireAt, loaded = c.cache.GetWithLifetime(question)
    // Calculate remaining TTL
    nowTTL := int(expireAt.Sub(timeNow).Seconds())
    // Adjust record TTLs: subtract elapsed time
    duration := uint32(originTTL - nowTTL)
    for _, record := range recordList {
        record.Header().Ttl = record.Header().Ttl - duration
    }
    return response, nowTTL
}
```

Кэшированные ответы копируются (`response.Copy()`) для предотвращения мутации. TTL корректируются с учётом времени, прошедшего с момента кэширования.

#### Шаг 5: Проверка RDRC

```go
if c.rdrc != nil {
    rejected := c.rdrc.LoadRDRC(transport.Tag(), question.Name, question.Qtype)
    if rejected {
        return nil, ErrResponseRejectedCached
    }
}
```

#### Шаг 6: Обмен через транспорт

```go
ctx, cancel := context.WithTimeout(ctx, c.timeout)
response, err := transport.Exchange(ctx, message)
cancel()
```

Таймаут по умолчанию -- `C.DNSTimeout`.

#### Шаг 7: Валидация ответа

Если предоставлен `responseChecker`, адреса ответа проверяются:

```go
if responseChecker != nil {
    var rejected bool
    if response.Rcode != dns.RcodeSuccess && response.Rcode != dns.RcodeNameError {
        rejected = true
    } else if len(response.Answer) == 0 {
        rejected = !responseChecker(nil)
    } else {
        rejected = !responseChecker(MessageToAddresses(response))
    }
    if rejected {
        c.rdrc.SaveRDRCAsync(transport.Tag(), question.Name, question.Qtype, c.logger)
        return response, ErrResponseRejected
    }
}
```

#### Шаг 8: Нормализация TTL

Все записи в ответе получают минимальное найденное значение TTL. Если установлен `options.RewriteTTL`, это значение используется вместо него.

Для отрицательных ответов (NXDOMAIN без ответов) используется минимальный TTL из записи SOA:

```go
func extractNegativeTTL(response *dns.Msg) (uint32, bool) {
    for _, record := range response.Ns {
        if soa, isSOA := record.(*dns.SOA); isSOA {
            return min(soa.Header().Ttl, soa.Minttl), true
        }
    }
    return 0, false
}
```

#### Шаг 9: Фильтрация записей HTTPS

Для HTTPS-запросов со стратегией домена адресные подсказки фильтруются:

```go
if question.Qtype == dns.TypeHTTPS {
    if options.Strategy == C.DomainStrategyIPv4Only {
        // Remove IPv6 hints
    } else if options.Strategy == C.DomainStrategyIPv6Only {
        // Remove IPv4 hints
    }
}
```

### Lookup

Параллельные запросы A/AAAA:

```go
func (c *Client) Lookup(ctx context.Context, transport adapter.DNSTransport,
    domain string, options adapter.DNSQueryOptions, responseChecker func([]netip.Addr) bool) ([]netip.Addr, error) {
    if strategy == C.DomainStrategyIPv4Only {
        return c.lookupToExchange(ctx, transport, dnsName, dns.TypeA, options, responseChecker)
    } else if strategy == C.DomainStrategyIPv6Only {
        return c.lookupToExchange(ctx, transport, dnsName, dns.TypeAAAA, options, responseChecker)
    }
    var group task.Group
    group.Append("exchange4", func(ctx context.Context) error { ... })
    group.Append("exchange6", func(ctx context.Context) error { ... })
    err := group.Run(ctx)
    return sortAddresses(response4, response6, strategy), nil
}
```

`sortAddresses` упорядочивает результаты по стратегии: PreferIPv6 ставит AAAA первыми, во всех остальных случаях первыми идут A.

## Маршрутизатор DNS

### Сопоставление правил

```go
func (r *Router) matchDNS(ctx context.Context, allowFakeIP bool, ruleIndex int,
    isAddressQuery bool, options *adapter.DNSQueryOptions) (adapter.DNSTransport, adapter.DNSRule, int) {
    for ; currentRuleIndex < len(r.rules); currentRuleIndex++ {
        currentRule := r.rules[currentRuleIndex]
        if currentRule.WithAddressLimit() && !isAddressQuery {
            continue  // Skip address-limit rules for non-address queries
        }
        metadata.ResetRuleCache()
        if currentRule.Match(metadata) {
            switch action := currentRule.Action().(type) {
            case *R.RuleActionDNSRoute:
                transport, loaded := r.transport.Transport(action.Server)
                // Apply strategy, cache, TTL, client subnet options
                return transport, currentRule, currentRuleIndex
            case *R.RuleActionDNSRouteOptions:
                // Modify options and continue matching
            case *R.RuleActionReject:
                return nil, currentRule, currentRuleIndex
            case *R.RuleActionPredefined:
                return nil, currentRule, currentRuleIndex
            }
        }
    }
    return r.transport.Default(), nil, -1
}
```

Правила с ограничениями адресов оцениваются только для адресных запросов (A, AAAA, HTTPS).

### Обратное отображение

При включении маршрутизатор сохраняет отображения IP-в-домен с истечением срока действия на основе TTL:

```go
if r.dnsReverseMapping != nil && transport.Type() != C.DNSTypeFakeIP {
    for _, answer := range response.Answer {
        switch record := answer.(type) {
        case *mDNS.A:
            r.dnsReverseMapping.AddWithLifetime(
                M.AddrFromIP(record.A),
                FqdnToDomain(record.Hdr.Name),
                time.Duration(record.Hdr.Ttl)*time.Second)
        case *mDNS.AAAA:
            r.dnsReverseMapping.AddWithLifetime(...)
        }
    }
}
```

Ответы FakeIP исключаются из обратного отображения, поскольку они возвращают синтетические адреса.

### Сброс сети

При изменении сети маршрутизатор очищает все кэши и сбрасывает все транспорты:

```go
func (r *Router) ResetNetwork() {
    r.ClearCache()
    for _, transport := range r.transport.Transports() {
        transport.Reset()
    }
}
```

## Вспомогательные типы

### RcodeError

```go
type RcodeError int

var RcodeNameError = RcodeError(dns.RcodeNameError)

func (e RcodeError) Error() string {
    return dns.RcodeToString[int(e)]
}
```

### MessageToAddresses

Извлекает IP-адреса из DNS-ответа, включая подсказки HTTPS SVCB:

```go
func MessageToAddresses(response *dns.Msg) []netip.Addr {
    for _, rawAnswer := range response.Answer {
        switch answer := rawAnswer.(type) {
        case *dns.A:     addresses = append(addresses, M.AddrFromIP(answer.A))
        case *dns.AAAA:  addresses = append(addresses, M.AddrFromIP(answer.AAAA))
        case *dns.HTTPS:
            for _, value := range answer.SVCB.Value {
                if value.Key() == dns.SVCB_IPV4HINT || value.Key() == dns.SVCB_IPV6HINT {
                    addresses = append(addresses, common.Map(strings.Split(value.String(), ","), M.ParseAddr)...)
                }
            }
        }
    }
}
```
