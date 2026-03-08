---
layout: home

hero:
  name: sing-box 内部原理
  text: 完整技术分析
  tagline: 深入剖析 sing-box 架构、协议和实现细节，为重新实现提供参考
  actions:
    - theme: brand
      text: 架构
      link: /zh-CN/architecture/overview
    - theme: alt
      text: 代理协议
      link: /zh-CN/protocols/overview
    - theme: alt
      text: 实现检查清单
      link: /zh-CN/implementation/checklist

features:
  - title: 基于上下文的架构
    details: 使用 Go context 进行依赖注入的服务注册模式，配合四阶段生命周期管理和可扩展的适配器接口
  - title: 20+ 种代理协议
    details: VLESS、VMess、Trojan、Shadowsocks、ShadowTLS、Hysteria2、TUIC、AnyTLS、WireGuard、NaiveProxy 等——全部通过 sing-* 库实现
  - title: 模块化传输层
    details: 兼容 V2Ray 的传输方式（WebSocket、gRPC、HTTP、HTTPUpgrade、QUIC）以及 TLS/uTLS/REALITY/kTLS 安全层
  - title: 高级路由
    details: 基于动作的规则系统，支持 sniff/resolve/route/reject/bypass/hijack-dns 动作、规则集和进程匹配
  - title: 全面的 DNS 支持
    details: 多传输方式 DNS，支持规则路由、FakeIP、缓存、EDNS0 客户端子网和平台原生解析器
  - title: 跨平台
    details: 通过 sing-tun 支持 TUN，移动平台绑定 (libbox)，兼容 Clash API，以及系统代理集成
---
