# Обзор архитектуры

sing-box -- это универсальная прокси-платформа, построенная на базе сетевой библиотеки `sing`. В отличие от монолитной архитектуры Xray-core, sing-box делегирует реализации протоколов внешним библиотекам `sing-*` и использует систему контекстов Go для внедрения зависимостей.

**Исходный код**: `box.go`, `adapter/`, `route/`, `common/`, `protocol/`

## Структура проекта

```
sing-box/
├── box.go                    # Box struct, lifecycle (New/PreStart/Start/Close)
├── adapter/                  # Core interfaces (Inbound, Outbound, Router, etc.)
│   ├── inbound/              # Inbound manager & registry
│   ├── outbound/             # Outbound manager & registry
│   ├── endpoint/             # Endpoint manager & registry (WireGuard, Tailscale)
│   └── service/              # Service manager & registry
├── route/                    # Router, connection manager, network manager
│   └── rule/                 # Rule matching and actions
├── dns/                      # DNS client, router, transport manager
│   └── transport/            # DNS transport implementations
├── protocol/                 # All proxy protocol implementations
│   ├── vless/                # VLESS inbound/outbound
│   ├── vmess/                # VMess inbound/outbound
│   ├── trojan/               # Trojan inbound/outbound
│   ├── shadowsocks/          # Shadowsocks (single/multi/relay)
│   ├── hysteria2/            # Hysteria2
│   ├── tuic/                 # TUIC
│   ├── tun/                  # TUN inbound
│   ├── group/                # Selector, URLTest
│   └── ...                   # direct, block, dns, socks, http, etc.
├── transport/                # V2Ray-compatible transports
│   ├── v2raywebsocket/       # WebSocket
│   ├── v2raygrpc/            # gRPC (full)
│   ├── v2raygrpclite/        # gRPC (lite, no dep)
│   ├── v2rayhttp/            # HTTP/2
│   ├── v2rayhttpupgrade/     # HTTP Upgrade
│   ├── v2rayquic/            # QUIC
│   └── wireguard/            # WireGuard device/stack
├── common/                   # Shared utilities
│   ├── dialer/               # Dialer system (default, detour, resolve, TFO)
│   ├── listener/             # TCP/UDP listeners
│   ├── sniff/                # Protocol sniffers
│   ├── tls/                  # TLS, uTLS, REALITY, ECH, kTLS, ACME
│   ├── mux/                  # Multiplex client/router
│   └── ...                   # redir, process, geoip, geosite, etc.
├── option/                   # Configuration types
├── include/                  # Build tag inclusion
├── experimental/             # Clash API, V2Ray API, cache file, libbox
├── log/                      # Logging system
├── constant/                 # Constants and enums
└── service/                  # External service implementations (CCM, OCM, DERP, etc.)
```

## Ключевые зависимости

| Пакет | Назначение |
|-------|------------|
| `sagernet/sing` | Базовая сетевая библиотека: N.Dialer, buf.Buffer, M.Socksaddr, bufio |
| `sagernet/sing-vmess` | Реализация протоколов VLESS + VMess |
| `sagernet/sing-shadowsocks` | Shadowsocks AEAD |
| `sagernet/sing-shadowsocks2` | Shadowsocks 2022 |
| `sagernet/sing-shadowtls` | Протокол ShadowTLS |
| `sagernet/sing-mux` | Мультиплексирование (на базе smux) |
| `sagernet/sing-quic` | Протоколы на основе QUIC (Hysteria2, TUIC) |
| `sagernet/sing-tun` | TUN-устройство + IP-стек |
| `sagernet/gvisor` | TCP/IP-стек в пользовательском пространстве |
| `sagernet/quic-go` | Реализация QUIC |
| `metacubex/utls` | Имитация TLS-отпечатков (uTLS) |
| `sagernet/wireguard-go` | Реализация WireGuard |
| `sagernet/tailscale` | Интеграция с Tailscale |
| `miekg/dns` | Парсинг DNS-сообщений |
| `anytls/sing-anytls` | Протокол AnyTLS |

## Высокоуровневый поток данных

```
┌─────────────────────────────────────────────────────────┐
│                        Box                               │
│                                                          │
│  ┌──────────┐    ┌──────────┐    ┌───────────────┐      │
│  │ Inbound  │───→│  Router  │───→│   Outbound    │      │
│  │ Manager  │    │          │    │   Manager     │      │
│  └──────────┘    │ matchRule│    └───────────────┘      │
│       │          │  sniff   │          │                 │
│       │          │  resolve │          │                 │
│       ▼          └──────────┘          ▼                 │
│  ┌──────────┐         │          ┌───────────────┐      │
│  │ Protocol │    ┌────┴────┐     │   Protocol    │      │
│  │ Inbound  │    │  DNS    │     │   Outbound    │      │
│  │(decode)  │    │ Router  │     │   (encode)    │      │
│  └──────────┘    └─────────┘     └───────────────┘      │
│                       │                │                 │
│                  ┌────┴────┐     ┌─────┴──────┐         │
│                  │  DNS    │     │ Connection │         │
│                  │Transport│     │  Manager   │         │
│                  │ Manager │     │ (copy loop)│         │
│                  └─────────┘     └────────────┘         │
└─────────────────────────────────────────────────────────┘
```

### Поток соединений

1. **Входящий (Inbound)** принимает соединение (TCP) или пакет (UDP)
2. Входящий декодирует заголовок протокола, извлекает адрес назначения
3. Входящий вызывает `router.RouteConnectionEx(ctx, conn, metadata, onClose)` или `RoutePacketConnectionEx`
4. **Маршрутизатор** обогащает метаданные: информация о процессе, соседних узлах, поиск FakeIP, обратный DNS
5. **Маршрутизатор** последовательно перебирает правила, выполняя действия:
   - `sniff` -- анализ данных для определения протокола/домена
   - `resolve` -- DNS-разрешение домена в IP-адреса
   - `route` -- выбор исходящего (терминальное действие)
   - `reject` -- отклонение соединения (терминальное действие)
   - `hijack-dns` -- обработка как DNS-запроса (терминальное действие)
   - `bypass` -- обход маршрутизации (терминальное действие)
6. **Маршрутизатор** выбирает исходящий на основе совпавшего правила (или по умолчанию)
7. **Трекеры соединений** оборачивают соединение (статистика, Clash API)
8. Если исходящий реализует `ConnectionHandlerEx`, он обрабатывает соединение напрямую
9. В противном случае **ConnectionManager** устанавливает соединение с удалённым узлом и запускает двунаправленное копирование

## Принципы проектирования

1. **Делегирование библиотекам**: Реализации протоколов находятся в библиотеках `sing-*`. sing-box является слоем оркестрации.

2. **Внедрение зависимостей через контекст**: Все сервисы регистрируются в контексте через `service.ContextWith[T]()` и извлекаются через `service.FromContext[T]()`. Глобальные синглтоны отсутствуют.

3. **Прямые соединения**: В отличие от модели Reader/Writer на основе Pipe в Xray-core, sing-box передаёт `net.Conn` и `N.PacketConn` напрямую через конвейер. Это позволяет использовать операции с нулевым копированием, splice и sendfile.

4. **Маршрутизация на основе действий**: Правила порождают действия, а не просто теги исходящих. Это позволяет включить анализ протоколов и DNS-разрешение в цепочку правил.

5. **4-фазный жизненный цикл**: Компоненты запускаются поэтапно (Initialize -> Start -> PostStart -> Started) для управления сложным порядком зависимостей без явных графов зависимостей.

6. **Расширяемые реестры**: Типы входящих, исходящих, конечных точек, DNS-транспортов и сервисов регистрируются через типизированные реестры, что упрощает добавление новых типов протоколов.
