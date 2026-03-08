# 传输层概述

源码：`transport/v2ray/`、`common/tls/`、`common/mux/`、`common/uot/`、`common/tlsfragment/`

## 架构

sing-box 的传输层位于代理协议层和原始网络之间，提供可插拔的流传输方式（WebSocket、gRPC、HTTP、QUIC、HTTP Upgrade）、TLS 变体（stdlib、uTLS、Reality、ECH、kTLS）、连接多路复用（sing-mux）、UDP-over-TCP 隧道以及 TLS 指纹分片。

### 组件图

```
Proxy Protocol (VMess, Trojan, etc.)
    |
    v
+--------------------+
| V2Ray Transport    |  <-- WebSocket, gRPC, HTTP, QUIC, HTTPUpgrade
+--------------------+
    |
    v
+--------------------+
| TLS Layer          |  <-- STD, uTLS, Reality, ECH, kTLS
+--------------------+
    |
    v
+--------------------+
| Multiplexing       |  <-- sing-mux, UoT
+--------------------+
    |
    v
+--------------------+
| TLS Fragment       |  <-- ClientHello splitting
+--------------------+
    |
    v
  Raw TCP/UDP
```

### 关键接口

传输层围绕两个适配器接口组织：

```go
// Server-side transport
type V2RayServerTransport interface {
    Network() []string
    Serve(listener net.Listener) error
    ServePacket(listener net.PacketConn) error
    Close() error
}

// Client-side transport
type V2RayClientTransport interface {
    DialContext(ctx context.Context) (net.Conn, error)
    Close() error
}
```

每种传输实现（WebSocket、gRPC、HTTP、QUIC、HTTP Upgrade）都提供满足这些接口的服务端和客户端类型。

### 传输选择

传输类型通过配置中的字符串常量进行选择：

```json
{
  "transport": {
    "type": "ws",          // "http", "grpc", "quic", "httpupgrade"
    "path": "/path",
    "headers": {}
  }
}
```

`v2ray/transport.go` 中的工厂函数通过 `NewServerTransport` 和 `NewClientTransport` 中的 type-switch 根据此类型字符串进行分发。

### 构建标签依赖

并非所有传输方式都始终可用：

| 传输方式 | 所需构建标签 | 备注 |
|-----------|-------------------|-------|
| WebSocket | 无 | 始终可用 |
| HTTP | 无 | 始终可用 |
| HTTP Upgrade | 无 | 始终可用 |
| gRPC（完整版） | `with_grpc` | 使用 `google.golang.org/grpc` |
| gRPC（精简版） | 无 | 原始 HTTP/2，始终可用作后备方案 |
| QUIC | `with_quic` | 使用 `github.com/sagernet/quic-go` |
| uTLS | `with_utls` | Reality 所需 |
| ACME | `with_acme` | 使用 certmagic |
| kTLS | Linux + go1.25 + `badlinkname` | 内核 TLS 卸载 |
| ECH | go1.24+ | Go 标准库 ECH 支持 |

### 连接流程

**客户端**（出站）：

1. 协议层调用 `transport.DialContext(ctx)` 获取 `net.Conn`
2. 传输层通过提供的 `N.Dialer` 拨号建立底层 TCP/UDP 连接
3. 如果已配置，则执行 TLS handshake（通过 `tls.NewDialer` 包装）
4. 应用传输层特定的帧处理（WebSocket 升级、HTTP/2 流等）
5. 返回结果连接供协议层使用

**服务端**（入站）：

1. 入站监听器接受原始连接
2. `transport.Serve(listener)` 启动传输服务器（HTTP 服务器、gRPC 服务器等）
3. 传输层验证传入请求（路径、头部、升级协议）
4. 验证成功后，调用 `handler.NewConnectionEx()` 并传入解包后的连接
5. handler 将连接路由到代理协议解码器

### 线程安全模式

传输层中出现了多种常见模式：

- **原子指针 + 互斥锁实现连接缓存**：用于 gRPC 客户端、QUIC 客户端和 WebSocket early data。快速路径读取原子指针；慢速路径获取互斥锁以建立连接。
- **延迟连接与 channel 信号通知**：`EarlyWebsocketConn`、`GunConn`（精简版）和 `HTTP2Conn` 将连接建立延迟到首次写入，使用 channel 向并发读取者发送完成信号。
- **`HTTP2ConnWrapper` 实现线程安全写入**：HTTP/2 流需要同步写入；该包装器使用互斥锁加 `closed` 标志来防止关闭后写入。
- **`DupContext` 实现 context 分离**：HTTP handler 的 context 与请求生命周期绑定；`DupContext` 提取日志 ID 并创建新的后台 context 供长期连接使用。

### 错误处理

传输层错误通过多个包装器进行规范化：

- `wrapWsError`：将 WebSocket 关闭帧（正常关闭、无状态）转换为 `io.EOF`
- `baderror.WrapGRPC`：规范化 gRPC 流错误
- `baderror.WrapH2`：规范化 HTTP/2 流错误
- `qtls.WrapError`：规范化 QUIC 错误

所有传输连接对截止时间相关操作（`SetDeadline`、`SetReadDeadline`、`SetWriteDeadline`）返回 `os.ErrInvalid`，并将 `NeedAdditionalReadDeadline() bool` 设置为 `true`，提示调用方在外部管理读取超时。
