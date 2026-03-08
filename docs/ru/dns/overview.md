# Обзор подсистемы DNS

Исходный код: `dns/`, `dns/transport/`, `dns/transport/fakeip/`, `dns/transport/hosts/`, `dns/transport/local/`, `dns/transport/dhcp/`

## Архитектура

Подсистема DNS sing-box состоит из трёх основных компонентов:

```
                     +------------------+
                     |   DNS Router     |   Сопоставление правил, выбор транспорта
                     +------------------+
                            |
                     +------------------+
                     |   DNS Client     |   Кэширование, EDNS0, RDRC, управление TTL
                     +------------------+
                            |
              +-------------+-------------+
              |             |             |
        +---------+   +---------+   +---------+
        | UDP     |   | HTTPS   |   | FakeIP  |   ... другие транспорты
        +---------+   +---------+   +---------+
```

1. **Маршрутизатор DNS** (`dns/router.go`): Сопоставляет DNS-запросы с правилами, выбирает соответствующий транспорт, обрабатывает стратегию домена и обратное отображение
2. **Клиент DNS** (`dns/client.go`): Выполняет фактический обмен DNS с кэшированием (freelru), внедрением подсети клиента EDNS0, кэшем отклонённых доменов ответов (RDRC) и корректировкой TTL
3. **Транспорты DNS** (`dns/transport/`): Выполнение запросов по конкретным протоколам (UDP, TCP, TLS, HTTPS, QUIC/HTTP3, FakeIP, Hosts, Local, DHCP)

### Вспомогательные компоненты

- **Реестр транспортов** (`dns/transport_registry.go`): Типобезопасная регистрация типов транспортов на основе обобщений (generics)
- **Адаптер транспорта** (`dns/transport_adapter.go`): Базовая структура с типом/тегом/зависимостями/стратегией/подсетью клиента
- **Базовый транспорт** (`dns/transport/base.go`): Конечный автомат (New/Started/Closing/Closed) с отслеживанием активных запросов
- **Коннектор** (`dns/transport/connector.go`): Обобщённое управление соединениями с защитой от дублирования (singleflight)

## Поток обработки запросов

### Exchange (необработанное DNS-сообщение)

1. **Router.Exchange** получает `*dns.Msg`
2. Извлечение метаданных: тип запроса, домен, версия IP
3. Если транспорт не указан явно, выполняется сопоставление с правилами DNS:
   - `RuleActionDNSRoute` -- выбор транспорта с параметрами (стратегия, кэш, TTL, подсеть клиента)
   - `RuleActionDNSRouteOptions` -- изменение параметров без выбора транспорта
   - `RuleActionReject` -- возврат REFUSED или сброс
   - `RuleActionPredefined` -- возврат предварительно настроенного ответа
4. **Client.Exchange** выполняет фактический запрос:
   - Проверка кэша (с дедупликацией через блокировку на основе каналов)
   - Проверка RDRC на ранее отклонённые ответы
   - Применение подсети клиента EDNS0
   - Выполнение transport.Exchange с таймаутом
   - Валидация ответа (проверка ограничения адресов)
   - Нормализация TTL
   - Сохранение в кэш
5. Сохранение обратного отображения (IP -> домен), если включено

### Lookup (домен в адреса)

1. **Router.Lookup** получает строку домена
2. Определяет стратегию (IPv4Only, IPv6Only, PreferIPv4, PreferIPv6, AsIS)
3. **Client.Lookup** распределяет:
   - IPv4Only: один запрос A
   - IPv6Only: один запрос AAAA
   - В остальных случаях: параллельные запросы A + AAAA через `task.Group`
4. Результаты сортируются в соответствии с предпочтением стратегии

### Цикл повторных попыток по правилам

Когда правило имеет ограничения адресов (например, ограничения geoip для адресов ответа), маршрутизатор повторяет попытку с последующими подходящими правилами, если ответ отклонён:

```go
for {
    transport, rule, ruleIndex = r.matchDNS(ctx, true, ruleIndex, isAddressQuery, &dnsOptions)
    responseCheck := addressLimitResponseCheck(rule, metadata)
    response, err = r.client.Exchange(dnsCtx, transport, message, dnsOptions, responseCheck)
    if responseCheck != nil && rejected {
        continue  // Try next matching rule
    }
    break
}
```

## Ключевые проектные решения

### Дедупликация

Кэш использует дедупликацию на основе каналов для предотвращения эффекта "громового стада" (thundering herd):

```go
cond, loaded := c.cacheLock.LoadOrStore(question, make(chan struct{}))
if loaded {
    <-cond  // Wait for the in-flight query to complete
} else {
    defer func() {
        c.cacheLock.Delete(question)
        close(cond)  // Signal waiters
    }()
}
```

### Обнаружение петель

Петли DNS-запросов (например, транспорт A должен разрешить адрес своего сервера через транспорт A) обнаруживаются через контекст:

```go
contextTransport, loaded := transportTagFromContext(ctx)
if loaded && transport.Tag() == contextTransport {
    return nil, E.New("DNS query loopback in transport[", contextTransport, "]")
}
ctx = contextWithTransportTag(ctx, transport.Tag())
```

### RDRC (кэш отклонённых доменов ответов)

Когда ответ отклоняется проверкой ограничения адресов, комбинация домен/тип запроса/транспорт кэшируется в RDRC, чтобы пропустить будущие запросы к тому же транспорту:

```go
if rejected {
    c.rdrc.SaveRDRCAsync(transport.Tag(), question.Name, question.Qtype, c.logger)
}
// On subsequent queries:
if c.rdrc.LoadRDRC(transport.Tag(), question.Name, question.Qtype) {
    return nil, ErrResponseRejectedCached
}
```

### Подсеть клиента EDNS0

Применяется перед обменом, если настроено:

```go
clientSubnet := options.ClientSubnet
if !clientSubnet.IsValid() {
    clientSubnet = c.clientSubnet
}
if clientSubnet.IsValid() {
    message = SetClientSubnet(message, clientSubnet)
}
```
