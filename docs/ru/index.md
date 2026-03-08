---
layout: home

hero:
  name: sing-box изнутри
  text: Полный технический анализ
  tagline: Глубокое погружение в архитектуру, протоколы и детали реализации sing-box для воссоздания с нуля
  actions:
    - theme: brand
      text: Архитектура
      link: /ru/architecture/overview
    - theme: alt
      text: Протоколы
      link: /ru/protocols/overview
    - theme: alt
      text: Чек-лист реализации
      link: /ru/implementation/checklist

features:
  - title: Архитектура на основе контекста
    details: Паттерн реестра сервисов с использованием Go context для внедрения зависимостей, четырёхфазное управление жизненным циклом и расширяемые интерфейсы адаптеров
  - title: 20+ прокси-протоколов
    details: VLESS, VMess, Trojan, Shadowsocks, ShadowTLS, Hysteria2, TUIC, AnyTLS, WireGuard, NaiveProxy и другие — все через библиотеки sing-*
  - title: Модульный транспортный уровень
    details: V2Ray-совместимые транспорты (WebSocket, gRPC, HTTP, HTTPUpgrade, QUIC) и уровни безопасности TLS/uTLS/REALITY/kTLS
  - title: Продвинутая маршрутизация
    details: Система правил на основе действий с поддержкой sniff/resolve/route/reject/bypass/hijack-dns, наборов правил и сопоставления по процессам
  - title: Полноценная поддержка DNS
    details: DNS с множеством транспортов, маршрутизацией по правилам, FakeIP, кэшированием, EDNS0 Client Subnet и нативными резолверами платформы
  - title: Кроссплатформенность
    details: Поддержка TUN через sing-tun, привязки для мобильных платформ (libbox), совместимость с Clash API и интеграция с системным прокси
---
