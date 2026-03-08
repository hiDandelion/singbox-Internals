# 架构概述

sing-box 是一个构建在 `sing` 网络库之上的通用代理平台。与 Xray-core 的单体设计不同，sing-box 将协议实现委托给外部的 `sing-*` 库，并使用 Go 的 context 系统进行依赖注入。

**源码**: `box.go`, `adapter/`, `route/`, `common/`, `protocol/`

## 项目结构

```
sing-box/
├── box.go                    # Box 结构体，生命周期 (New/PreStart/Start/Close)
├── adapter/                  # 核心接口 (Inbound, Outbound, Router 等)
│   ├── inbound/              # Inbound 管理器和注册表
│   ├── outbound/             # Outbound 管理器和注册表
│   ├── endpoint/             # Endpoint 管理器和注册表 (WireGuard, Tailscale)
│   └── service/              # Service 管理器和注册表
├── route/                    # Router, 连接管理器, 网络管理器
│   └── rule/                 # 规则匹配与动作
├── dns/                      # DNS 客户端, 路由器, 传输管理器
│   └── transport/            # DNS 传输实现
├── protocol/                 # 所有代理协议实现
│   ├── vless/                # VLESS 入站/出站
│   ├── vmess/                # VMess 入站/出站
│   ├── trojan/               # Trojan 入站/出站
│   ├── shadowsocks/          # Shadowsocks (单用户/多用户/中继)
│   ├── hysteria2/            # Hysteria2
│   ├── tuic/                 # TUIC
│   ├── tun/                  # TUN 入站
│   ├── group/                # Selector, URLTest
│   └── ...                   # direct, block, dns, socks, http 等
├── transport/                # V2Ray 兼容传输层
│   ├── v2raywebsocket/       # WebSocket
│   ├── v2raygrpc/            # gRPC (完整版)
│   ├── v2raygrpclite/        # gRPC (精简版，无依赖)
│   ├── v2rayhttp/            # HTTP/2
│   ├── v2rayhttpupgrade/     # HTTP Upgrade
│   ├── v2rayquic/            # QUIC
│   └── wireguard/            # WireGuard 设备/协议栈
├── common/                   # 共享工具
│   ├── dialer/               # Dialer 系统 (default, detour, resolve, TFO)
│   ├── listener/             # TCP/UDP 监听器
│   ├── sniff/                # 协议嗅探器
│   ├── tls/                  # TLS, uTLS, REALITY, ECH, kTLS, ACME
│   ├── mux/                  # 多路复用客户端/路由器
│   └── ...                   # redir, process, geoip, geosite 等
├── option/                   # 配置类型
├── include/                  # 构建标签包含
├── experimental/             # Clash API, V2Ray API, 缓存文件, libbox
├── log/                      # 日志系统
├── constant/                 # 常量和枚举
└── service/                  # 外部服务实现 (CCM, OCM, DERP 等)
```

## 关键依赖

| 包 | 用途 |
|---------|---------|
| `sagernet/sing` | 核心网络库: N.Dialer, buf.Buffer, M.Socksaddr, bufio |
| `sagernet/sing-vmess` | VLESS + VMess 协议实现 |
| `sagernet/sing-shadowsocks` | Shadowsocks AEAD |
| `sagernet/sing-shadowsocks2` | Shadowsocks 2022 |
| `sagernet/sing-shadowtls` | ShadowTLS 协议 |
| `sagernet/sing-mux` | 多路复用 (基于 smux) |
| `sagernet/sing-quic` | 基于 QUIC 的协议 (Hysteria2, TUIC) |
| `sagernet/sing-tun` | TUN 设备 + IP 协议栈 |
| `sagernet/gvisor` | 用户空间 TCP/IP 协议栈 |
| `sagernet/quic-go` | QUIC 实现 |
| `metacubex/utls` | uTLS 指纹模拟 |
| `sagernet/wireguard-go` | WireGuard 实现 |
| `sagernet/tailscale` | Tailscale 集成 |
| `miekg/dns` | DNS 消息解析 |
| `anytls/sing-anytls` | AnyTLS 协议 |

## 高层数据流

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

### 连接流程

1. **Inbound** 接受连接 (TCP) 或数据包 (UDP)
2. Inbound 解码协议头部，提取目标地址
3. Inbound 调用 `router.RouteConnectionEx(ctx, conn, metadata, onClose)` 或 `RoutePacketConnectionEx`
4. **Router** 丰富元数据：进程信息、邻居信息、FakeIP 查询、反向 DNS
5. **Router** 按顺序遍历规则，执行动作：
   - `sniff` -- 窥探数据以检测协议/域名
   - `resolve` -- DNS 解析域名为 IP
   - `route` -- 选择出站（终端动作）
   - `reject` -- 丢弃连接（终端动作）
   - `hijack-dns` -- 作为 DNS 查询处理（终端动作）
   - `bypass` -- 绕过路由（终端动作）
6. **Router** 根据匹配的规则选择出站（或使用默认出站）
7. **连接追踪器** 包装连接（统计信息、Clash API）
8. 如果出站实现了 `ConnectionHandlerEx`，则直接处理
9. 否则，**ConnectionManager** 拨号远端并运行双向复制

## 设计原则

1. **库委托**: 协议实现存在于 `sing-*` 库中。sing-box 是编排层。

2. **基于 context 的依赖注入**: 所有服务通过 `service.ContextWith[T]()` 注册到 context 中，并通过 `service.FromContext[T]()` 获取。没有全局单例。

3. **直接连接**: 与 Xray-core 基于 Pipe 的 Reader/Writer 模型不同，sing-box 在管道中直接传递 `net.Conn` 和 `N.PacketConn`。这使得零拷贝操作和 splice/sendfile 成为可能。

4. **基于动作的路由**: 规则产生动作，而不仅仅是出站标签。这允许嗅探和 DNS 解析成为规则链的一部分。

5. **四阶段生命周期**: 组件分阶段启动 (Initialize -> Start -> PostStart -> Started)，以处理复杂的依赖排序而无需显式的依赖图。

6. **可扩展注册表**: Inbound、Outbound、Endpoint、DNS 传输和服务类型都通过类型注册表注册，便于添加新的协议类型。
