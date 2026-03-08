# Транспорт FakeIP DNS

Исходный код: `dns/transport/fakeip/fakeip.go`, `dns/transport/fakeip/store.go`, `dns/transport/fakeip/memory.go`

## Обзор

FakeIP назначает синтетические IP-адреса из настроенных диапазонов для DNS-запросов. Вместо разрешения домена в его реальный IP-адрес, FakeIP выделяет уникальный адрес из пула и поддерживает двунаправленное отображение (домен <-> IP). Когда устанавливается соединение с адресом FakeIP, маршрутизатор разрешает исходный домен и подключается к реальному назначению.

## Транспорт

```go
var _ adapter.FakeIPTransport = (*Transport)(nil)

type Transport struct {
    dns.TransportAdapter
    logger logger.ContextLogger
    store  adapter.FakeIPStore
}

func (t *Transport) Exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    question := message.Question[0]
    if question.Qtype != mDNS.TypeA && question.Qtype != mDNS.TypeAAAA {
        return nil, E.New("only IP queries are supported by fakeip")
    }
    address, err := t.store.Create(dns.FqdnToDomain(question.Name), question.Qtype == mDNS.TypeAAAA)
    return dns.FixedResponse(message.Id, question, []netip.Addr{address}, C.DefaultDNSTTL), nil
}

func (t *Transport) Store() adapter.FakeIPStore {
    return t.store
}
```

Поддерживаются только запросы A и AAAA. Другие типы запросов (MX, TXT и т.д.) возвращают ошибку.

Транспорт реализует `adapter.FakeIPTransport`, который предоставляет `Store()` для прямого доступа к хранилищу FakeIP.

## Хранилище

Хранилище управляет выделением IP и двунаправленным отображением домен/адрес:

```go
type Store struct {
    ctx        context.Context
    logger     logger.Logger
    inet4Range netip.Prefix
    inet6Range netip.Prefix
    inet4Last  netip.Addr    // Broadcast address (upper bound)
    inet6Last  netip.Addr
    storage    adapter.FakeIPStorage

    addressAccess sync.Mutex
    inet4Current  netip.Addr  // Last allocated IPv4
    inet6Current  netip.Addr  // Last allocated IPv6
}
```

### Выделение IP

Последовательное выделение с циклическим переходом:

```go
func (s *Store) Create(domain string, isIPv6 bool) (netip.Addr, error) {
    // Check if domain already has an address
    if address, loaded := s.storage.FakeIPLoadDomain(domain, isIPv6); loaded {
        return address, nil
    }

    s.addressAccess.Lock()
    defer s.addressAccess.Unlock()

    // Double-check after lock
    if address, loaded := s.storage.FakeIPLoadDomain(domain, isIPv6); loaded {
        return address, nil
    }

    var address netip.Addr
    if !isIPv6 {
        nextAddress := s.inet4Current.Next()
        if nextAddress == s.inet4Last || !s.inet4Range.Contains(nextAddress) {
            nextAddress = s.inet4Range.Addr().Next().Next()  // Wrap around, skip network+first
        }
        s.inet4Current = nextAddress
        address = nextAddress
    } else {
        // Same logic for IPv6
    }

    s.storage.FakeIPStore(address, domain)
    s.storage.FakeIPSaveMetadataAsync(&adapter.FakeIPMetadata{...})
    return address, nil
}
```

Выделение пропускает сетевой адрес и первый адрес хоста (`.0` и `.1` в терминах IPv4), начиная с третьего адреса. Когда диапазон исчерпан, происходит циклический переход с повторным использованием ранее задействованных адресов.

### Вычисление широковещательного адреса

```go
func broadcastAddress(prefix netip.Prefix) netip.Addr {
    addr := prefix.Addr()
    raw := addr.As16()
    bits := prefix.Bits()
    if addr.Is4() { bits += 96 }
    for i := bits; i < 128; i++ {
        raw[i/8] |= 1 << (7 - i%8)
    }
    if addr.Is4() {
        return netip.AddrFrom4([4]byte(raw[12:]))
    }
    return netip.AddrFrom16(raw)
}
```

Вычисляет широковещательный адрес, устанавливая все биты хоста в 1.

### Сохранение состояния

Хранилище проверяет файл кэша при запуске:

```go
func (s *Store) Start() error {
    cacheFile := service.FromContext[adapter.CacheFile](s.ctx)
    if cacheFile != nil && cacheFile.StoreFakeIP() {
        storage = cacheFile
    }
    if storage == nil {
        storage = NewMemoryStorage()
    }
    // Restore state if ranges match
    metadata := storage.FakeIPMetadata()
    if metadata != nil && metadata.Inet4Range == s.inet4Range && metadata.Inet6Range == s.inet6Range {
        s.inet4Current = metadata.Inet4Current
        s.inet6Current = metadata.Inet6Current
    } else {
        // Reset on range change
        s.inet4Current = s.inet4Range.Addr().Next()
        s.inet6Current = s.inet6Range.Addr().Next()
        storage.FakeIPReset()
    }
}
```

Если настроенные диапазоны изменились, хранилище сбрасывается. В противном случае выделение продолжается с последней сохранённой позиции.

При закрытии метаданные сохраняются:

```go
func (s *Store) Close() error {
    return s.storage.FakeIPSaveMetadata(&adapter.FakeIPMetadata{
        Inet4Range:   s.inet4Range,
        Inet6Range:   s.inet6Range,
        Inet4Current: s.inet4Current,
        Inet6Current: s.inet6Current,
    })
}
```

### Поиск

```go
func (s *Store) Lookup(address netip.Addr) (string, bool) {
    return s.storage.FakeIPLoad(address)
}

func (s *Store) Contains(address netip.Addr) bool {
    return s.inet4Range.Contains(address) || s.inet6Range.Contains(address)
}
```

## Хранилище в памяти

Реализация в памяти с использованием двунаправленных отображений:

```go
type MemoryStorage struct {
    addressByDomain4 map[string]netip.Addr
    addressByDomain6 map[string]netip.Addr
    domainByAddress  map[netip.Addr]string
}
```

Три отображения поддерживают двунаправленную связь:
- `addressByDomain4`: домен -> IPv4-адрес
- `addressByDomain6`: домен -> IPv6-адрес
- `domainByAddress`: адрес (v4 или v6) -> домен

### Сохранение с повторным использованием

При сохранении нового отображения адрес-домен любое существующее отображение для того же адреса сначала удаляется:

```go
func (s *MemoryStorage) FakeIPStore(address netip.Addr, domain string) error {
    if oldDomain, loaded := s.domainByAddress[address]; loaded {
        if address.Is4() {
            delete(s.addressByDomain4, oldDomain)
        } else {
            delete(s.addressByDomain6, oldDomain)
        }
    }
    s.domainByAddress[address] = domain
    if address.Is4() {
        s.addressByDomain4[domain] = address
    } else {
        s.addressByDomain6[domain] = address
    }
    return nil
}
```

Это обрабатывает случай циклического перехода, когда адрес повторно используется для нового домена.

## Конфигурация

```json
{
  "dns": {
    "servers": [
      {
        "tag": "fakeip",
        "type": "fakeip",
        "inet4_range": "198.18.0.0/15",
        "inet6_range": "fc00::/18"
      }
    ]
  }
}
```

| Поле | Описание |
|------|----------|
| `inet4_range` | Диапазон IPv4 CIDR для выделения FakeIP |
| `inet6_range` | Диапазон IPv6 CIDR для выделения FakeIP |

Типичные диапазоны используют документационные адреса RFC 5737 (`198.18.0.0/15`) или адреса ULA (`fc00::/18`).
