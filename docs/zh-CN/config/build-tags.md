# 构建标签与条件编译

sing-box 使用 Go 构建标签来控制哪些协议、传输层和功能被编译到二进制文件中。这允许生成仅包含所需功能的最小化构建。

**源码**：`include/`

## 架构

`include/` 目录包含一个定义默认协议注册的 `registry.go` 文件，以及成对的可选功能文件：一个带有功能标签，一个带有其否定。

### 注册表入口点

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

此函数创建填充了所有类型注册表的 context，随后在配置解析期间使用。注册表决定了入站、出站、端点、DNS 服务器和服务的哪些 `type` 值是有效的。

## 始终包含的协议

这些协议在 `registry.go` 中无条件注册：

### 入站

| 类型 | 包 | 描述 |
|------|-----|------|
| `tun` | `protocol/tun` | TUN 接口 |
| `redirect` | `protocol/redirect` | TCP 重定向（Linux） |
| `tproxy` | `protocol/redirect` | 透明代理（Linux） |
| `direct` | `protocol/direct` | 直连入站 |
| `socks` | `protocol/socks` | SOCKS4/5 代理 |
| `http` | `protocol/http` | HTTP 代理 |
| `mixed` | `protocol/mixed` | HTTP + SOCKS5 混合代理 |
| `shadowsocks` | `protocol/shadowsocks` | Shadowsocks |
| `vmess` | `protocol/vmess` | VMess |
| `trojan` | `protocol/trojan` | Trojan |
| `naive` | `protocol/naive` | NaiveProxy |
| `shadowtls` | `protocol/shadowtls` | ShadowTLS |
| `vless` | `protocol/vless` | VLESS |
| `anytls` | `protocol/anytls` | AnyTLS |

### 出站

| 类型 | 包 | 描述 |
|------|-----|------|
| `direct` | `protocol/direct` | 直连出站 |
| `block` | `protocol/block` | 阻止（拒绝） |
| `selector` | `protocol/group` | 手动选择组 |
| `urltest` | `protocol/group` | 自动 URL 测试组 |
| `socks` | `protocol/socks` | SOCKS5 客户端 |
| `http` | `protocol/http` | HTTP CONNECT 客户端 |
| `shadowsocks` | `protocol/shadowsocks` | Shadowsocks 客户端 |
| `vmess` | `protocol/vmess` | VMess 客户端 |
| `trojan` | `protocol/trojan` | Trojan 客户端 |
| `tor` | `protocol/tor` | Tor 客户端 |
| `ssh` | `protocol/ssh` | SSH 客户端 |
| `shadowtls` | `protocol/shadowtls` | ShadowTLS 客户端 |
| `vless` | `protocol/vless` | VLESS 客户端 |
| `anytls` | `protocol/anytls` | AnyTLS 客户端 |

### DNS 传输层

| 类型 | 包 | 描述 |
|------|-----|------|
| `tcp` | `dns/transport` | DNS over TCP |
| `udp` | `dns/transport` | DNS over UDP |
| `tls` | `dns/transport` | DNS over TLS（DoT） |
| `https` | `dns/transport` | DNS over HTTPS（DoH） |
| `hosts` | `dns/transport/hosts` | Hosts 文件 |
| `local` | `dns/transport/local` | 系统解析器 |
| `fakeip` | `dns/transport/fakeip` | FakeIP |
| `resolved` | `service/resolved` | Resolved DNS |

## 构建标签控制的功能

### QUIC（`with_quic`）

**文件**：`include/quic.go`、`include/quic_stub.go`

启用基于 QUIC 的协议：

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
    quic.RegisterTransport(registry)      // DNS over QUIC
    quic.RegisterHTTP3Transport(registry) // DNS over HTTP/3
}
```

还启用：
- V2Ray QUIC 传输层（`transport/v2rayquic`）
- NaiveProxy QUIC 支持（`protocol/naive/quic`）

**Stub 行为**（无标签时）：所有 QUIC 类型注册但返回 `C.ErrQUICNotIncluded`：

```go
//go:build !with_quic

func registerQUICInbounds(registry *inbound.Registry) {
    inbound.Register[option.HysteriaInboundOptions](registry, C.TypeHysteria,
        func(...) (adapter.Inbound, error) {
            return nil, C.ErrQUICNotIncluded
        })
    // ... TUIC、Hysteria2 同理
}
```

### WireGuard（`with_wireguard`）

**文件**：`include/wireguard.go`、`include/wireguard_stub.go`

启用 WireGuard 端点：

```go
//go:build with_wireguard

func registerWireGuardEndpoint(registry *endpoint.Registry) {
    wireguard.RegisterEndpoint(registry)
}
```

**Stub 行为**：返回一个引导用户使用该标签重新构建的错误消息。

### Clash API（`with_clash_api`）

**文件**：`include/clashapi.go`、`include/clashapi_stub.go`

Clash API 使用副作用导入模式：

```go
//go:build with_clash_api

import _ "github.com/sagernet/sing-box/experimental/clashapi"
```

`clashapi` 包的 `init()` 函数通过 `experimental.RegisterClashServerConstructor(NewServer)` 注册构造函数。

**Stub 行为**：注册一个返回错误的构造函数。

### V2Ray API（`with_v2ray_api`）

**文件**：`include/v2rayapi.go`、`include/v2rayapi_stub.go`

与 Clash API 相同的模式 -- 副作用导入触发 `init()` 注册。

### DHCP DNS（`with_dhcp`）

**文件**：`include/dhcp.go`、`include/dhcp_stub.go`

启用基于 DHCP 的 DNS 服务器发现。

### NaiveProxy 出站（`with_naive`）

**文件**：`include/naive_outbound.go`、`include/naive_outbound_stub.go`

启用 NaiveProxy 作为出站（客户端）协议。

### Tailscale（`with_tailscale`）

**文件**：`include/tailscale.go`、`include/tailscale_stub.go`

启用 Tailscale 端点和 DNS 传输层。

### CCM/OCM

**文件**：`include/ccm.go`、`include/ccm_stub.go`、`include/ocm.go`、`include/ocm_stub.go`

云配置管理服务。

## 注册表模式

注册模式使用 Go 泛型将类型字符串与选项结构体关联：

```go
// 泛型注册函数
func Register[Options any](registry *Registry, typeName string,
    constructor func(ctx, router, logger, tag string, options Options) (adapter.Inbound, error)) {
    registry.register(typeName, func() any { return new(Options) }, constructor)
}
```

这允许注册表：
1. 通过类型名称创建零值选项结构体（用于 JSON 解析）
2. 使用解析后的选项调用构造函数（用于实例创建）

### 注册流程

```
include/registry.go
  -> InboundRegistry()
       -> tun.RegisterInbound(registry)
            -> inbound.Register[option.TunInboundOptions](registry, "tun", tun.NewInbound)
                 -> 注册表存储 {"tun": {createOptions: () => new(TunInboundOptions), constructor: NewInbound}}

配置解析：
  JSON {"type": "tun", ...}
    -> registry.CreateOptions("tun")  => *TunInboundOptions
    -> json.Unmarshal(content, options)
    -> tun.NewInbound(ctx, router, logger, tag, *options)
```

## 已移除协议的 Stub

一些协议注册为返回描述性错误的 stub：

```go
func registerStubForRemovedInbounds(registry *inbound.Registry) {
    inbound.Register[option.ShadowsocksInboundOptions](registry, C.TypeShadowsocksR,
        func(...) (adapter.Inbound, error) {
            return nil, E.New("ShadowsocksR is deprecated and removed in sing-box 1.6.0")
        })
}

func registerStubForRemovedOutbounds(registry *outbound.Registry) {
    // ShadowsocksR：在 1.6.0 中移除
    // WireGuard 出站：在 1.11.0 中迁移到端点，在 1.13.0 中移除
}
```

## 平台特定文件

一些 include 文件是平台特定的：

| 文件 | 平台 | 用途 |
|------|------|------|
| `tz_android.go` | Android | 时区处理 |
| `tz_ios.go` | iOS | 时区处理 |
| `oom_killer.go` | （标签控制） | OOM killer 服务 |
| `ccm_stub_darwin.go` | Darwin | macOS 的 CCM stub |

## 使用标签构建

```bash
# 最小构建（仅核心协议）
go build ./cmd/sing-box

# 包含所有可选功能的完整构建
go build -tags "with_quic,with_wireguard,with_clash_api,with_v2ray_api,with_dhcp" ./cmd/sing-box

# 特定功能集
go build -tags "with_quic,with_clash_api" ./cmd/sing-box
```

## 重新实现注意事项

1. **功能标志**：在重新实现中，构建标签对应编译时功能标志。Rust 使用 Cargo features；Swift/C++ 使用预处理器定义。关键原则是未使用的协议不应增加二进制大小
2. **Stub 模式**：当功能被禁用时，sing-box 仍然注册类型名称，以便配置解析产生有用的错误消息而非"未知类型"
3. **副作用导入**：`_ "package"` 模式触发 `init()` 函数。重新实现中应使用显式注册调用
4. **注册表泛型**：`Register[Options any]` 模式将 JSON schema 和构造函数绑定在一起。重新实现需要等效的类型安全多态构造机制
5. **默认注册**：核心协议（socks、http、shadowsocks、vmess、trojan、vless、direct、block、selector、urltest）应始终可用，无需功能标志
