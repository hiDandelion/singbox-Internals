# Обзор протоколов

sing-box поддерживает более 20 прокси-протоколов, все из которых следуют единому паттерну адаптеров. Реализации протоколов представляют собой тонкие обёртки, делегирующие обработку формата данных библиотекам `sing-*`.

**Исходный код**: `protocol/`, `include/`

## Паттерн регистрации

Каждый протокол регистрирует себя через систему включений:

```go
// include/inbound.go
func InboundRegistry() *inbound.Registry {
    registry := inbound.NewRegistry()
    tun.RegisterInbound(registry)
    vless.RegisterInbound(registry)
    vmess.RegisterInbound(registry)
    trojan.RegisterInbound(registry)
    // ...
    return registry
}
```

Каждый протокол предоставляет функцию регистрации:

```go
// protocol/vless/inbound.go
func RegisterInbound(registry adapter.InboundRegistry) {
    inbound.Register[option.VLESSInboundOptions](registry, C.TypeVLESS, NewInbound)
}
```

Обобщённая функция `Register` устанавливает соответствие: `(строка типа, тип опций) → фабричная функция`.

## Паттерн входящих соединений (Inbound)

Все входящие соединения следуют этой структуре:

```go
type Inbound struct {
    myInboundAdapter  // встроенный адаптер с Tag(), Type()
    ctx      context.Context
    router   adapter.ConnectionRouterEx
    logger   log.ContextLogger
    listener *listener.Listener    // TCP-слушатель
    service  *someprotocol.Service // сервис протокола
}

func NewInbound(ctx, router, logger, tag string, options) (adapter.Inbound, error) {
    // 1. Создать сервис протокола (из библиотеки sing-*)
    // 2. Создать слушатель
    // 3. Связать сервис → маршрутизатор для обработки соединений
}

func (h *Inbound) Start(stage adapter.StartStage) error {
    // Запустить слушатель
}

func (h *Inbound) Close() error {
    // Закрыть слушатель + сервис
}

// Вызывается слушателем для каждого нового соединения
func (h *Inbound) NewConnectionEx(ctx, conn, metadata, onClose) {
    // Здесь происходит декодирование, специфичное для протокола
    // Затем: h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

## Паттерн исходящих соединений (Outbound)

Все исходящие соединения реализуют интерфейс `N.Dialer`:

```go
type Outbound struct {
    myOutboundAdapter  // встроенный адаптер с Tag(), Type(), Network()
    ctx       context.Context
    dialer    N.Dialer           // базовый dialer (может быть detour)
    transport *v2ray.Transport   // опциональный V2Ray-транспорт
    // опции, специфичные для протокола
}

func NewOutbound(ctx, router, logger, tag string, options) (adapter.Outbound, error) {
    // 1. Создать базовый dialer (по умолчанию или detour)
    // 2. Создать V2Ray-транспорт, если настроен
    // 3. Настроить опции протокола
}

func (h *Outbound) DialContext(ctx, network, destination) (net.Conn, error) {
    // 1. Установить транспортное соединение
    // 2. Выполнить рукопожатие протокола
    // 3. Вернуть обёрнутое соединение
}

func (h *Outbound) ListenPacket(ctx, destination) (net.PacketConn, error) {
    // Для протоколов с поддержкой UDP
}
```

## Категории протоколов

### Прокси-протоколы (Клиент/Сервер)
| Протокол | Входящий (Inbound) | Исходящий (Outbound) | Библиотека |
|----------|---------|----------|---------|
| VLESS | Да | Да | `sing-vmess` |
| VMess | Да | Да | `sing-vmess` |
| Trojan | Да | Да | `transport/trojan` (встроенный) |
| Shadowsocks | Да | Да | `sing-shadowsocks` / `sing-shadowsocks2` |
| ShadowTLS | Да | Да | `sing-shadowtls` |
| Hysteria2 | Да | Да | `sing-quic` |
| TUIC | Да | Да | `sing-quic` |
| AnyTLS | Да | Да | `sing-anytls` |
| NaiveProxy | Да | Да | Встроенный |
| WireGuard | Endpoint | Endpoint | `wireguard-go` |
| Tailscale | Endpoint | Endpoint | `tailscale` |

### Локальные прокси-протоколы
| Протокол | Входящий (Inbound) | Исходящий (Outbound) |
|----------|---------|----------|
| SOCKS4/5 | Да | Да |
| HTTP | Да | Да |
| Mixed (SOCKS+HTTP) | Да | - |
| Redirect | Да | - |
| TProxy | Да | - |
| TUN | Да | - |

### Служебные протоколы
| Протокол | Назначение |
|----------|---------|
| Direct | Прямое исходящее соединение |
| Block | Отбрасывание всех соединений |
| DNS | Перенаправление в DNS-маршрутизатор |
| Selector | Ручной выбор исходящего соединения |
| URLTest | Автовыбор на основе задержки |
| SSH | SSH-туннель |
| Tor | Сеть Tor |

## Интеграция V2Ray-транспорта

Многие протоколы поддерживают V2Ray-совместимые транспорты:

```go
// Создание транспорта из опций
transport, err := v2ray.NewServerTransport(ctx, logger, common.PtrValueOrDefault(options.Transport), tlsConfig, handler)

// Или для клиентской стороны
transport, err := v2ray.NewClientTransport(ctx, dialer, serverAddr, common.PtrValueOrDefault(options.Transport), tlsConfig)
```

Поддерживаемые транспорты: WebSocket, gRPC, HTTP/2, HTTPUpgrade, QUIC.

## Интеграция мультиплексирования

Исходящие соединения могут быть обёрнуты мультиплексированием:

```go
if options.Multiplex != nil && options.Multiplex.Enabled {
    outbound.multiplexDialer, err = mux.NewClientWithOptions(ctx, outbound, muxOptions)
}
```

## Цепочка обработки

```
Inbound Listener → Protocol Decode → Router → Rule Match → Outbound Select
    ↓                                                          ↓
TCP/UDP accept                                          Protocol Encode
    ↓                                                          ↓
Protocol Service                                        Transport Dial
    ↓                                                          ↓
Extract destination                                     Remote Connection
    ↓                                                          ↓
Route to outbound ─────────────────────────────→ ConnectionManager.Copy
```

## Ключевые отличия от Xray-core

| Аспект | Xray-core | sing-box |
|--------|----------|----------|
| Формат данных | Встроенное кодирование | Библиотека `sing-*` |
| Модель входящих | `proxy.Inbound.Process()` возвращает Link | `adapter.Inbound` → обратный вызов маршрутизатора |
| Модель исходящих | `proxy.Outbound.Process()` с Link | Интерфейс `N.Dialer` (DialContext/ListenPacket) |
| Поток данных | Pipe Reader/Writer | Прямой net.Conn/PacketConn |
| Мультиплексирование | Встроенный mux + XUDP | Библиотека `sing-mux` |
| Vision/XTLS | Встроен в proxy.go | Не поддерживается (другой подход) |
