# UDP-over-TCP（UoT）

源码：`common/uot/router.go`

## 概述

UoT（UDP-over-TCP）通过 TCP 连接隧道传输 UDP 流量。它拦截目标为魔术哨兵地址的连接，并使用 `github.com/sagernet/sing/common/uot` 将其转换为基于数据包的连接。

## 魔术地址

两个哨兵地址用于标识 UoT 连接：

- `uot.MagicAddress` —— 当前 UoT 协议，带请求头
- `uot.LegacyMagicAddress` —— 旧版 UoT，无请求头

## Router

`Router` 包装现有的 `ConnectionRouterEx`，按目标 FQDN 拦截连接：

```go
type Router struct {
    router adapter.ConnectionRouterEx
    logger logger.ContextLogger
}

func NewRouter(router adapter.ConnectionRouterEx, logger logger.ContextLogger) *Router {
    return &Router{router, logger}
}
```

### 连接处理（Ex 变体）

```go
func (r *Router) RouteConnectionEx(ctx context.Context, conn net.Conn,
    metadata adapter.InboundContext, onClose N.CloseHandlerFunc) {
    switch metadata.Destination.Fqdn {
    case uot.MagicAddress:
        request, err := uot.ReadRequest(conn)
        if err != nil {
            N.CloseOnHandshakeFailure(conn, onClose, err)
            return
        }
        if request.IsConnect {
            r.logger.InfoContext(ctx, "inbound UoT connect connection to ", request.Destination)
        } else {
            r.logger.InfoContext(ctx, "inbound UoT connection to ", request.Destination)
        }
        metadata.Domain = metadata.Destination.Fqdn
        metadata.Destination = request.Destination
        r.router.RoutePacketConnectionEx(ctx, uot.NewConn(conn, *request), metadata, onClose)
        return

    case uot.LegacyMagicAddress:
        r.logger.InfoContext(ctx, "inbound legacy UoT connection")
        metadata.Domain = metadata.Destination.Fqdn
        metadata.Destination = M.Socksaddr{Addr: netip.IPv4Unspecified()}
        r.RoutePacketConnectionEx(ctx, uot.NewConn(conn, uot.Request{}), metadata, onClose)
        return
    }
    r.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### UoT 请求头

对于当前协议（`uot.MagicAddress`），从连接中读取请求头：

- **Destination**：实际的 UDP 目标地址
- **IsConnect**：布尔标志，指示 connect 模式还是普通模式

在 connect 模式下，连接表现为到单一目标的已连接 UDP 套接字。在普通模式下，每个数据包携带自己的目标地址。

### 旧版协议

旧版协议（`uot.LegacyMagicAddress`）没有请求头。目标设置为 `0.0.0.0`（IPv4 未指定），使用空的 `Request{}`。

### 透传

不匹配任何魔术地址的连接直接透传到底层路由器：

```go
r.router.RouteConnectionEx(ctx, conn, metadata, onClose)
```

### 数据包连接转换

`uot.NewConn(conn, request)` 将 TCP 连接包装为 `N.PacketConn`。UoT 协议在 TCP 流中对单个 UDP 数据包进行帧处理，包括：
- 数据包长度帧
- 每数据包目标寻址（非 connect 模式）
- 双向数据包流

生成的数据包连接随后通过 `RoutePacketConnectionEx` 路由，进行标准 UDP 处理。
