# 实现清单

重新实现 sing-box 的综合清单，按阶段组织。每个阶段都建立在前一阶段之上。

## 阶段 1：基础

### 配置系统
- [ ] 带上下文感知类型注册表的 JSON 解析器
- [ ] 包含所有顶级字段的根 `Options` 结构体
- [ ] `Listable[T]` 类型（接受单个值或数组）
- [ ] `Duration` 类型（Go 时长字符串解析）
- [ ] `NetworkList` 类型（单个字符串或 "tcp"/"udp" 数组）
- [ ] `DomainStrategy` 枚举（as_is、prefer_ipv4、prefer_ipv6、ipv4_only、ipv6_only）
- [ ] `NetworkStrategy` 枚举
- [ ] `InterfaceType` 枚举（wifi、cellular、ethernet、other）
- [ ] `DNSQueryType` 类型（字符串名称或 uint16）
- [ ] `UDPTimeoutCompat`（数字作为秒数或时长字符串）
- [ ] `ServerOptions`（server + server_port）
- [ ] `ListenOptions`（监听地址、端口、socket 选项）
- [ ] `DialerOptions`（detour、绑定、超时、路由标记、网络策略）
- [ ] `DomainResolveOptions`（简写字符串或完整对象）
- [ ] 通过类型注册表实现多态的入站/出站/端点/服务/DNS 解析
- [ ] 用于条件协议包含的构建标签/功能标志系统
- [ ] 入站和出站/端点的重复标签验证

### 日志
- [ ] 日志级别：trace、debug、info、warn、error、fatal、panic
- [ ] 上下文感知的日志记录器（逐连接 context）
- [ ] 可观察的日志工厂（用于 Clash API 日志流）
- [ ] 文件输出支持
- [ ] 时间戳选项
- [ ] 彩色输出选项

### 服务生命周期
- [ ] 启动阶段：Initialize、Start、PostStart、Started
- [ ] 带依赖解析的有序服务启动
- [ ] 通过 `Close()` 传播的优雅关闭
- [ ] 基于 context 的服务注册表（`service.FromContext[T]`）

## 阶段 2：核心管线

### Adapter Interface
- [ ] `adapter.Inbound` interface
- [ ] `adapter.Outbound` interface（含 `N.Dialer`）
- [ ] `adapter.Endpoint` interface（双向：入站 + 出站）
- [ ] `adapter.Router` interface
- [ ] `adapter.InboundContext` 元数据结构体
- [ ] `adapter.ConnectionRouterEx` 用于连接路由
- [ ] `adapter.OutboundManager`（标签查找、默认出站）
- [ ] `adapter.InboundManager`
- [ ] `adapter.EndpointManager`
- [ ] `adapter.NetworkManager`

### 网络原语
- [ ] `N.Dialer` interface（DialContext、ListenPacket）
- [ ] `N.ExtendedConn`（缓冲读/写扩展）
- [ ] `N.PacketConn`（含 `ReadPacket`/`WritePacket` 用于零拷贝）
- [ ] `bufio` 工具（复制、管道、计数连接）
- [ ] `M.Socksaddr` 类型（统一的 addr:port，支持 FQDN）
- [ ] 通过 context 传播连接元数据

### 监听器
- [ ] 带可配置 socket 选项的 TCP 监听器
- [ ] 带包连接处理的 UDP 监听器
- [ ] Keep-alive 配置
- [ ] TCP Fast Open 支持
- [ ] Multipath TCP 支持
- [ ] 路由标记（`SO_MARK`）支持
- [ ] 网络命名空间（`setns`）支持
- [ ] 绑定到接口支持

### 拨号器
- [ ] 带 socket 选项的默认拨号器
- [ ] Detour 拨号器（通过另一个出站链接）
- [ ] 接口绑定
- [ ] 地址绑定（inet4/inet6）
- [ ] 路由标记传播
- [ ] 连接超时
- [ ] 域名解析集成
- [ ] 网络策略（偏好特定接口类型）
- [ ] 回退拨号器（尝试多个网络）

### 路由器
- [ ] 路由规则匹配管线
- [ ] 默认规则类型（域名、IP、端口、进程、网络等）
- [ ] 逻辑规则（AND、OR 带取反）
- [ ] 规则动作（route、reject、hijack-dns、sniff、resolve）
- [ ] 最终出站（默认路由）
- [ ] 规则集集成
- [ ] DNS 规则管线（与路由规则分离）
- [ ] 带元数据增强的连接路由

### 协议嗅探
- [ ] 协议嗅探框架
- [ ] HTTP 嗅探（方法 + host 头）
- [ ] TLS 嗅探（ClientHello 中的 SNI）
- [ ] QUIC 嗅探（QUIC ClientHello 中的 SNI）
- [ ] DNS 嗅探（查询域名）
- [ ] SSH 嗅探
- [ ] RDP 嗅探
- [ ] BitTorrent 嗅探
- [ ] DTLS 嗅探
- [ ] 嗅探超时处理
- [ ] 覆盖目的地选项

## 阶段 3：传输层

### TLS
- [ ] TLS 客户端（含 SNI、ALPN、证书固定）
- [ ] TLS 服务端（证书、密钥、ACME）
- [ ] UTLS 客户端（Chrome/Firefox/Safari 指纹）
- [ ] Reality 客户端和服务端
- [ ] ECH（加密客户端 Hello）支持
- [ ] kTLS 优化（Linux）

### V2Ray 传输层
- [ ] WebSocket 传输层（客户端 + 服务端）
- [ ] HTTP/2 传输层（客户端 + 服务端）
- [ ] gRPC 传输层（客户端 + 服务端）
- [ ] HTTPUpgrade 传输层（客户端 + 服务端）
- [ ] QUIC 传输层（客户端 + 服务端）[构建标签：with_quic]

### 多路复用（sing-mux）
- [ ] 多路复用客户端（smux、yamux、h2mux 协议）
- [ ] 多路复用服务端
- [ ] 单连接上的流多路复用
- [ ] 填充支持
- [ ] Brutal 拥塞控制选项
- [ ] 最大连接数 / 最小流数 / 最大流数配置

## 阶段 4：协议

### Direct
- [ ] Direct 入站（接受连接并路由）
- [ ] Direct 出站（直接连接到目的地）

### Block
- [ ] Block 出站（拒绝连接）

### SOCKS
- [ ] SOCKS5 入站（含可选认证）
- [ ] SOCKS4/4a 入站
- [ ] SOCKS5 出站（客户端）
- [ ] SOCKS5 UDP ASSOCIATE

### HTTP
- [ ] HTTP 代理入站（CONNECT + 普通 HTTP）
- [ ] HTTP CONNECT 出站（客户端）
- [ ] Basic/Digest 认证

### Mixed
- [ ] Mixed 入站（自动检测 HTTP/SOCKS5）

### Shadowsocks
- [ ] 单用户 Shadowsocks 入站
- [ ] 多用户 Shadowsocks 入站
- [ ] Relay Shadowsocks 入站
- [ ] Shadowsocks 出站
- [ ] AEAD 密码（aes-128-gcm、aes-256-gcm、chacha20-ietf-poly1305）
- [ ] AEAD 2022 密码（2022-blake3-aes-128-gcm、2022-blake3-aes-256-gcm、2022-blake3-chacha20-poly1305）
- [ ] UDP 中继
- [ ] SIP003 插件支持（obfs、v2ray-plugin）
- [ ] UDP-over-TCP（UoT）

### VMess
- [ ] VMess 入站
- [ ] VMess 出站
- [ ] 安全模式：auto、zero、aes-128-gcm、chacha20-poly1305、aes-128-cfb、none
- [ ] alterId 支持（旧版）
- [ ] 全局填充选项
- [ ] 认证长度选项
- [ ] 包编码：packetaddr、xudp

### VLESS
- [ ] VLESS 入站
- [ ] VLESS 出站
- [ ] 基于 UUID 的认证
- [ ] Flow：xtls-rprx-vision
- [ ] 包编码：packetaddr、xudp

### Trojan
- [ ] Trojan 入站
- [ ] Trojan 出站
- [ ] SHA-224 密码哈希（56 字节十六进制密钥）
- [ ] 通过 Trojan 协议的 UDP 中继

### ShadowTLS
- [ ] ShadowTLS 入站（v1、v2、v3）
- [ ] ShadowTLS 出站
- [ ] TLS 握手中继

### Hysteria / Hysteria2 [构建标签：with_quic]
- [ ] Hysteria 入站和出站
- [ ] Hysteria2 入站和出站
- [ ] Brutal 拥塞控制

### TUIC [构建标签：with_quic]
- [ ] TUIC 入站和出站
- [ ] 基于 QUIC 的多路复用

### WireGuard [构建标签：with_wireguard]
- [ ] WireGuard 端点（双向）
- [ ] Noise 协议握手
- [ ] Peer 管理

### 其他
- [ ] NaiveProxy 入站（含构建标签的出站）
- [ ] Tor 出站
- [ ] SSH 出站

### 出站组
- [ ] Selector 组（手动选择并持久化）
- [ ] URLTest 组（按延迟自动选择）
- [ ] URL 测试实现
- [ ] 测试历史存储

## 阶段 5：DNS

### DNS 系统
- [ ] 基于规则的传输层选择的 DNS 路由器
- [ ] 带 TTL 的 DNS 缓存
- [ ] 缓存容量限制
- [ ] 每条规则的独立缓存
- [ ] 客户端子网（EDNS0）
- [ ] 域名策略应用（解析 A/AAAA/两者）

### DNS 传输层
- [ ] UDP DNS 传输层
- [ ] TCP DNS 传输层
- [ ] TLS DNS 传输层（DoT）
- [ ] HTTPS DNS 传输层（DoH）
- [ ] QUIC DNS 传输层（DoQ）[构建标签：with_quic]
- [ ] HTTP/3 DNS 传输层 [构建标签：with_quic]
- [ ] 本地系统 DNS 传输层
- [ ] Hosts 文件 DNS 传输层
- [ ] FakeIP DNS 传输层
- [ ] DHCP DNS 传输层 [构建标签：with_dhcp]

### FakeIP
- [ ] FakeIP 地址池（IPv4 + IPv6）
- [ ] 地址分配和回收
- [ ] 双向映射（地址 <-> 域名）
- [ ] 缓存文件持久化
- [ ] 元数据持久化（分配指针）

### DNS 规则
- [ ] DNS 规则匹配（域名、来源、查询类型等）
- [ ] DNS 规则动作（route、reject、预定义响应）
- [ ] 被拒绝的 DNS 响应缓存（RDRC）

## 阶段 6：高级功能

### 规则集
- [ ] SRS 二进制格式读取器
- [ ] SRS 二进制格式写入器
- [ ] JSON 源格式读取器
- [ ] 带文件监视的本地规则集
- [ ] 带 HTTP 获取和 ETag 缓存的远程规则集
- [ ] 内联规则集
- [ ] 规则集引用计数和内存管理
- [ ] 规则集元数据（包含进程/WIFI/IPCIDR 标志）
- [ ] 用于 TUN 路由的 IP 集合提取

### GeoIP / GeoSite（旧版）
- [ ] MaxMind MMDB 读取器（sing-geoip 类型）
- [ ] GeoSite 二进制格式读取器
- [ ] GeoSite 到规则编译
- [ ] 首次使用时自动下载

### 进程搜索器
- [ ] Linux：netlink socket 诊断 + procfs 搜索
- [ ] macOS：sysctl PCB 列表解析
- [ ] Windows：IP Helper API（GetExtendedTcpTable）
- [ ] Android：netlink + 包管理器 UID 映射
- [ ] 平台 interface 委派

### TUN
- [ ] TUN 设备创建和配置
- [ ] 自动路由（路由表管理）
- [ ] 通过 TUN 的 DNS 劫持
- [ ] IPv4 和 IPv6 支持
- [ ] MTU 配置
- [ ] 平台 TUN（Android VpnService、iOS NetworkExtension）

### Clash API [构建标签：with_clash_api]
- [ ] 使用 chi 路由器的 HTTP REST 服务器
- [ ] Bearer token 认证
- [ ] WebSocket 支持
- [ ] 流量统计流式传输
- [ ] 带级别过滤的日志流式传输
- [ ] 连接追踪和列表
- [ ] 代理列表和延迟测试
- [ ] Selector 更新 API
- [ ] 带持久化的模式切换
- [ ] 外部 UI 静态文件服务
- [ ] CORS 配置

### V2Ray API [构建标签：with_v2ray_api]
- [ ] gRPC 服务器
- [ ] Stats 服务（GetStats、QueryStats、GetSysStats）
- [ ] 按入站/出站/用户的流量计数器
- [ ] 计数器命名约定（entity>>>tag>>>traffic>>>direction）
- [ ] 模式匹配（子串和正则）

### 缓存文件
- [ ] bbolt（或等效的）数据库
- [ ] 选定出站持久化
- [ ] Clash 模式持久化
- [ ] 远程规则集缓存
- [ ] FakeIP 持久化（双向映射）
- [ ] 带过期的 RDRC 持久化
- [ ] 缓存 ID 命名空间
- [ ] 损坏恢复（删除并重建）
- [ ] 异步写入缓冲

### 平台 Interface
- [ ] gomobile 兼容的 interface 定义
- [ ] TUN 设备管理桥接
- [ ] 默认接口监控
- [ ] 网络接口枚举
- [ ] 连接所有者查找桥接
- [ ] WIFI 状态读取
- [ ] 系统证书访问
- [ ] 通知发送
- [ ] 邻居监控
- [ ] 按需规则（iOS）
- [ ] Network Extension 生命周期（iOS）
- [ ] 命令服务器（IPC）

## 阶段 7：测试与兼容性

### 线格式兼容性
- [ ] VLESS 协议线格式测试
- [ ] VMess 协议线格式测试
- [ ] Trojan 协议线格式测试
- [ ] Shadowsocks 线格式测试（所有密码变体）
- [ ] 多路复用（sing-mux）线格式测试
- [ ] 与官方 sing-box 的集成测试

### 配置兼容性
- [ ] 解析官方 sing-box 示例配置
- [ ] 往返序列化测试
- [ ] 旧版格式迁移测试
- [ ] 未知字段拒绝测试

### 互操作性
- [ ] 与 sing-box 服务器测试
- [ ] 与 Xray-core 服务器测试
- [ ] 与 Clash.Meta 测试
- [ ] SRS 规则集格式兼容性
- [ ] GeoIP 数据库兼容性
- [ ] GeoSite 数据库兼容性
