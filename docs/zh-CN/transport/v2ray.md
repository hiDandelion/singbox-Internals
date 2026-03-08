# V2Ray 传输工厂

源码：`transport/v2ray/transport.go`、`transport/v2ray/quic.go`、`transport/v2ray/grpc.go`、`transport/v2ray/grpc_lite.go`

## 工厂模式

V2Ray 传输工厂使用泛型类型别名和 type-switch 分发器来创建服务端和客户端传输。这是所有 V2Ray 传输创建的唯一入口点。

### 泛型构造函数类型

```go
type (
    ServerConstructor[O any] func(
        ctx context.Context,
        logger logger.ContextLogger,
        options O,
        tlsConfig tls.ServerConfig,
        handler adapter.V2RayServerTransportHandler,
    ) (adapter.V2RayServerTransport, error)

    ClientConstructor[O any] func(
        ctx context.Context,
        dialer N.Dialer,
        serverAddr M.Socksaddr,
        options O,
        tlsConfig tls.Config,
    ) (adapter.V2RayClientTransport, error)
)
```

这些泛型类型对选项 struct `O` 进行参数化，允许每种传输定义自己的配置类型，同时共享相同的构造函数签名。

### 服务端传输分发

```go
func NewServerTransport(ctx context.Context, logger logger.ContextLogger,
    options option.V2RayTransportOptions, tlsConfig tls.ServerConfig,
    handler adapter.V2RayServerTransportHandler) (adapter.V2RayServerTransport, error) {
    if options.Type == "" {
        return nil, nil
    }
    switch options.Type {
    case C.V2RayTransportTypeHTTP:
        return v2rayhttp.NewServer(ctx, logger, options.HTTPOptions, tlsConfig, handler)
    case C.V2RayTransportTypeWebsocket:
        return v2raywebsocket.NewServer(ctx, logger, options.WebsocketOptions, tlsConfig, handler)
    case C.V2RayTransportTypeQUIC:
        if tlsConfig == nil {
            return nil, C.ErrTLSRequired
        }
        return NewQUICServer(ctx, logger, options.QUICOptions, tlsConfig, handler)
    case C.V2RayTransportTypeGRPC:
        return NewGRPCServer(ctx, logger, options.GRPCOptions, tlsConfig, handler)
    case C.V2RayTransportTypeHTTPUpgrade:
        return v2rayhttpupgrade.NewServer(ctx, logger, options.HTTPUpgradeOptions, tlsConfig, handler)
    default:
        return nil, E.New("unknown transport type: " + options.Type)
    }
}
```

关键行为：
- 空类型返回 `nil, nil`（未配置传输）
- QUIC 要求 TLS —— 如果 `tlsConfig` 为 nil 则返回 `C.ErrTLSRequired`
- HTTP、WebSocket 和 HTTP Upgrade 直接导入并调用
- gRPC 和 QUIC 通过处理构建标签切换的中间函数进行分发

### 客户端传输分发

`NewClientTransport` 遵循相同的模式。客户端变体接收 `N.Dialer` 和 `M.Socksaddr` 而非 handler：

```go
func NewClientTransport(ctx context.Context, dialer N.Dialer, serverAddr M.Socksaddr,
    options option.V2RayTransportOptions, tlsConfig tls.Config) (adapter.V2RayClientTransport, error)
```

注意 TLS 配置是 `tls.Config`（客户端接口）而非 `tls.ServerConfig`（服务端接口）。

## QUIC 注册模式

QUIC 传输需要 `with_quic` 构建标签。由于核心 `v2ray` 包无法直接导入 `v2rayquic`（该包可能未被编译），因此使用注册模式：

```go
// quic.go
var (
    quicServerConstructor ServerConstructor[option.V2RayQUICOptions]
    quicClientConstructor ClientConstructor[option.V2RayQUICOptions]
)

func RegisterQUICConstructor(
    server ServerConstructor[option.V2RayQUICOptions],
    client ClientConstructor[option.V2RayQUICOptions],
) {
    quicServerConstructor = server
    quicClientConstructor = client
}

func NewQUICServer(...) (adapter.V2RayServerTransport, error) {
    if quicServerConstructor == nil {
        return nil, os.ErrInvalid
    }
    return quicServerConstructor(ctx, logger, options, tlsConfig, handler)
}
```

`v2rayquic` 包通过 `init()` 进行自注册：

```go
// v2rayquic/init.go
//go:build with_quic

func init() {
    v2ray.RegisterQUICConstructor(NewServer, NewClient)
}
```

如果编译时未使用 `with_quic`，构造函数保持为 nil，`NewQUICServer`/`NewQUICClient` 返回 `os.ErrInvalid`。

## gRPC 构建标签切换

gRPC 有两个由构建标签控制的实现：

**带 `with_grpc`（grpc.go）**：

```go
//go:build with_grpc

func NewGRPCServer(...) (adapter.V2RayServerTransport, error) {
    if options.ForceLite {
        return v2raygrpclite.NewServer(ctx, logger, options, tlsConfig, handler)
    }
    return v2raygrpc.NewServer(ctx, logger, options, tlsConfig, handler)
}
```

当完整 gRPC 库可用时，用户仍可通过 `options.ForceLite` 强制使用精简版实现。

**不带 `with_grpc`（grpc_lite.go）**：

```go
//go:build !with_grpc

func NewGRPCServer(...) (adapter.V2RayServerTransport, error) {
    return v2raygrpclite.NewServer(ctx, logger, options, tlsConfig, handler)
}
```

不带构建标签时，无论 `ForceLite` 设置如何，始终使用精简版实现。

## 配置

```json
{
  "transport": {
    "type": "ws",
    "path": "/path",
    "headers": {
      "Host": "example.com"
    },
    "max_early_data": 2048,
    "early_data_header_name": "Sec-WebSocket-Protocol"
  }
}
```

`V2RayTransportOptions` struct 包含一个 `Type` 字符串和每种传输类型的子选项 struct（`HTTPOptions`、`WebsocketOptions`、`QUICOptions`、`GRPCOptions`、`HTTPUpgradeOptions`）。只使用与所选类型匹配的子选项。
