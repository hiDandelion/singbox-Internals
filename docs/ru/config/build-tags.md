# Теги сборки и условная компиляция

sing-box использует теги сборки Go для управления тем, какие протоколы, транспорты и функции компилируются в двоичный файл. Это позволяет создавать минимальные сборки, включающие только необходимую функциональность.

**Исходный код**: `include/`

## Архитектура

Каталог `include/` содержит файл `registry.go`, определяющий регистрации протоколов по умолчанию, а также пары файлов для необязательных функций: один с тегом функции и один с его отрицанием.

### Точка входа реестра

```go
// include/registry.go
func Context(ctx context.Context) context.Context {
    return box.Context(ctx,
        InboundRegistry(),
        OutboundRegistry(),
        EndpointRegistry(),
        DNSTransportRegistry(),
        ServiceRegistry(),
    )
}
```

Эта функция создаёт контекст со всеми заполненными реестрами типов, который затем используется при парсинге конфигурации. Реестры определяют, какие значения `type` допустимы для входящих, исходящих, эндпоинтов, DNS-серверов и сервисов.

## Всегда включённые протоколы

Эти протоколы регистрируются безусловно в `registry.go`:

### Входящие

| Тип | Пакет | Описание |
|-----|-------|----------|
| `tun` | `protocol/tun` | TUN-интерфейс |
| `redirect` | `protocol/redirect` | TCP-перенаправление (Linux) |
| `tproxy` | `protocol/redirect` | Прозрачный прокси (Linux) |
| `direct` | `protocol/direct` | Прямой входящий |
| `socks` | `protocol/socks` | Прокси SOCKS4/5 |
| `http` | `protocol/http` | HTTP-прокси |
| `mixed` | `protocol/mixed` | Смешанный прокси HTTP + SOCKS5 |
| `shadowsocks` | `protocol/shadowsocks` | Shadowsocks |
| `vmess` | `protocol/vmess` | VMess |
| `trojan` | `protocol/trojan` | Trojan |
| `naive` | `protocol/naive` | NaiveProxy |
| `shadowtls` | `protocol/shadowtls` | ShadowTLS |
| `vless` | `protocol/vless` | VLESS |
| `anytls` | `protocol/anytls` | AnyTLS |

### Исходящие

| Тип | Пакет | Описание |
|-----|-------|----------|
| `direct` | `protocol/direct` | Прямой исходящий |
| `block` | `protocol/block` | Блокировка (отклонение) |
| `selector` | `protocol/group` | Группа ручного выбора |
| `urltest` | `protocol/group` | Группа автоматического URL-теста |
| `socks` | `protocol/socks` | Клиент SOCKS5 |
| `http` | `protocol/http` | Клиент HTTP CONNECT |
| `shadowsocks` | `protocol/shadowsocks` | Клиент Shadowsocks |
| `vmess` | `protocol/vmess` | Клиент VMess |
| `trojan` | `protocol/trojan` | Клиент Trojan |
| `tor` | `protocol/tor` | Клиент Tor |
| `ssh` | `protocol/ssh` | Клиент SSH |
| `shadowtls` | `protocol/shadowtls` | Клиент ShadowTLS |
| `vless` | `protocol/vless` | Клиент VLESS |
| `anytls` | `protocol/anytls` | Клиент AnyTLS |

### DNS-транспорты

| Тип | Пакет | Описание |
|-----|-------|----------|
| `tcp` | `dns/transport` | DNS через TCP |
| `udp` | `dns/transport` | DNS через UDP |
| `tls` | `dns/transport` | DNS через TLS (DoT) |
| `https` | `dns/transport` | DNS через HTTPS (DoH) |
| `hosts` | `dns/transport/hosts` | Файл hosts |
| `local` | `dns/transport/local` | Системный резолвер |
| `fakeip` | `dns/transport/fakeip` | FakeIP |
| `resolved` | `service/resolved` | Resolved DNS |

## Функции, защищённые тегами сборки

### QUIC (`with_quic`)

**Файлы**: `include/quic.go`, `include/quic_stub.go`

Включает протоколы на основе QUIC:

```go
//go:build with_quic

func registerQUICInbounds(registry *inbound.Registry) {
    hysteria.RegisterInbound(registry)
    tuic.RegisterInbound(registry)
    hysteria2.RegisterInbound(registry)
}

func registerQUICOutbounds(registry *outbound.Registry) {
    hysteria.RegisterOutbound(registry)
    tuic.RegisterOutbound(registry)
    hysteria2.RegisterOutbound(registry)
}

func registerQUICTransports(registry *dns.TransportRegistry) {
    quic.RegisterTransport(registry)      // DNS через QUIC
    quic.RegisterHTTP3Transport(registry) // DNS через HTTP/3
}
```

Также включает:
- V2Ray QUIC-транспорт (`transport/v2rayquic`)
- Поддержку QUIC для NaiveProxy (`protocol/naive/quic`)

**Поведение заглушки** (без тега): Все типы QUIC регистрируются, но возвращают `C.ErrQUICNotIncluded`:

```go
//go:build !with_quic

func registerQUICInbounds(registry *inbound.Registry) {
    inbound.Register[option.HysteriaInboundOptions](registry, C.TypeHysteria,
        func(...) (adapter.Inbound, error) {
            return nil, C.ErrQUICNotIncluded
        })
    // ... то же для TUIC, Hysteria2
}
```

### WireGuard (`with_wireguard`)

**Файлы**: `include/wireguard.go`, `include/wireguard_stub.go`

Включает эндпоинт WireGuard:

```go
//go:build with_wireguard

func registerWireGuardEndpoint(registry *endpoint.Registry) {
    wireguard.RegisterEndpoint(registry)
}
```

**Поведение заглушки**: Возвращает сообщение об ошибке, направляющее пользователей пересобрать с тегом.

### Clash API (`with_clash_api`)

**Файлы**: `include/clashapi.go`, `include/clashapi_stub.go`

Clash API использует паттерн импорта побочных эффектов:

```go
//go:build with_clash_api

import _ "github.com/sagernet/sing-box/experimental/clashapi"
```

Функция `init()` пакета `clashapi` регистрирует конструктор через `experimental.RegisterClashServerConstructor(NewServer)`.

**Поведение заглушки**: Регистрирует конструктор, возвращающий ошибку.

### V2Ray API (`with_v2ray_api`)

**Файлы**: `include/v2rayapi.go`, `include/v2rayapi_stub.go`

Тот же паттерн, что и у Clash API — импорт побочных эффектов, запускающий регистрацию через `init()`.

### DHCP DNS (`with_dhcp`)

**Файлы**: `include/dhcp.go`, `include/dhcp_stub.go`

Включает обнаружение DNS-серверов через DHCP.

### Исходящий NaiveProxy (`with_naive`)

**Файлы**: `include/naive_outbound.go`, `include/naive_outbound_stub.go`

Включает NaiveProxy как исходящий (клиентский) протокол.

### Tailscale (`with_tailscale`)

**Файлы**: `include/tailscale.go`, `include/tailscale_stub.go`

Включает эндпоинт и DNS-транспорт Tailscale.

### CCM/OCM

**Файлы**: `include/ccm.go`, `include/ccm_stub.go`, `include/ocm.go`, `include/ocm_stub.go`

Сервисы управления облачной конфигурацией.

## Паттерн реестра

Паттерн регистрации использует дженерики Go для связывания строки типа со структурой опций:

```go
// Обобщённая функция регистрации
func Register[Options any](registry *Registry, typeName string,
    constructor func(ctx, router, logger, tag string, options Options) (adapter.Inbound, error)) {
    registry.register(typeName, func() any { return new(Options) }, constructor)
}
```

Это позволяет реестру:
1. Создавать нулевую структуру опций по имени типа (для JSON-парсинга)
2. Вызывать конструктор с распарсенными опциями (для создания экземпляра)

### Поток регистрации

```
include/registry.go
  -> InboundRegistry()
       -> tun.RegisterInbound(registry)
            -> inbound.Register[option.TunInboundOptions](registry, "tun", tun.NewInbound)
                 -> registry хранит {"tun": {createOptions: () => new(TunInboundOptions), constructor: NewInbound}}

Парсинг конфигурации:
  JSON {"type": "tun", ...}
    -> registry.CreateOptions("tun")  => *TunInboundOptions
    -> json.Unmarshal(content, options)
    -> tun.NewInbound(ctx, router, logger, tag, *options)
```

## Заглушки удалённых протоколов

Некоторые протоколы зарегистрированы как заглушки, возвращающие описательные ошибки:

```go
func registerStubForRemovedInbounds(registry *inbound.Registry) {
    inbound.Register[option.ShadowsocksInboundOptions](registry, C.TypeShadowsocksR,
        func(...) (adapter.Inbound, error) {
            return nil, E.New("ShadowsocksR is deprecated and removed in sing-box 1.6.0")
        })
}

func registerStubForRemovedOutbounds(registry *outbound.Registry) {
    // ShadowsocksR: удалён в 1.6.0
    // Исходящий WireGuard: мигрирован в эндпоинт в 1.11.0, удалён в 1.13.0
}
```

## Платформозависимые файлы

Некоторые файлы include зависят от платформы:

| Файл | Платформа | Назначение |
|------|-----------|------------|
| `tz_android.go` | Android | Обработка часовых поясов |
| `tz_ios.go` | iOS | Обработка часовых поясов |
| `oom_killer.go` | (с тегом) | Сервис OOM killer |
| `ccm_stub_darwin.go` | Darwin | Заглушка CCM для macOS |

## Сборка с тегами

```bash
# Минимальная сборка (только основные протоколы)
go build ./cmd/sing-box

# Полная сборка со всеми необязательными функциями
go build -tags "with_quic,with_wireguard,with_clash_api,with_v2ray_api,with_dhcp" ./cmd/sing-box

# Определённый набор функций
go build -tags "with_quic,with_clash_api" ./cmd/sing-box
```

## Замечания по реализации

1. **Флаги функций**: В реимплементации теги сборки транслируются в флаги компиляции. Rust использует features Cargo; Swift/C++ используют директивы препроцессора. Ключевой принцип — неиспользуемые протоколы не должны увеличивать размер двоичного файла
2. **Паттерн заглушек**: Когда функция отключена, sing-box всё равно регистрирует имя типа, чтобы парсинг конфигурации выдавал полезное сообщение об ошибке вместо «неизвестный тип»
3. **Импорт побочных эффектов**: Паттерн `_ "package"` запускает функции `init()`. В реимплементации используйте явные вызовы регистрации
4. **Дженерики реестра**: Паттерн `Register[Options any]` связывает JSON-схему и конструктор. Реимплементации нужен эквивалентный механизм для типобезопасного полиморфного создания
5. **Регистрации по умолчанию**: Основные протоколы (socks, http, shadowsocks, vmess, trojan, vless, direct, block, selector, urltest) должны быть всегда доступны без флагов функций
