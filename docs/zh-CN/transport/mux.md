# 连接多路复用（sing-mux）

源码：`common/mux/client.go`、`common/mux/router.go`

## 概述

sing-box 集成了 `github.com/sagernet/sing-mux` 进行连接多路复用，允许在单个底层连接上承载多个逻辑流。它支持可选的 Brutal 拥塞控制以实现带宽强制。

## 客户端

客户端用多路复用能力包装 `N.Dialer`：

```go
type Client = mux.Client

func NewClientWithOptions(dialer N.Dialer, logger logger.Logger, options option.OutboundMultiplexOptions) (*Client, error) {
    if !options.Enabled {
        return nil, nil
    }
    var brutalOptions mux.BrutalOptions
    if options.Brutal != nil && options.Brutal.Enabled {
        brutalOptions = mux.BrutalOptions{
            Enabled:    true,
            SendBPS:    uint64(options.Brutal.UpMbps * C.MbpsToBps),
            ReceiveBPS: uint64(options.Brutal.DownMbps * C.MbpsToBps),
        }
        if brutalOptions.SendBPS < mux.BrutalMinSpeedBPS {
            return nil, E.New("brutal: invalid upload speed")
        }
        if brutalOptions.ReceiveBPS < mux.BrutalMinSpeedBPS {
            return nil, E.New("brutal: invalid download speed")
        }
    }
    return mux.NewClient(mux.Options{
        Dialer:         &clientDialer{dialer},
        Logger:         logger,
        Protocol:       options.Protocol,
        MaxConnections: options.MaxConnections,
        MinStreams:      options.MinStreams,
        MaxStreams:      options.MaxStreams,
        Padding:        options.Padding,
        Brutal:         brutalOptions,
    })
}
```

### Context 覆盖

客户端拨号器包装原始拨号器以应用 context 覆盖：

```go
type clientDialer struct {
    N.Dialer
}

func (d *clientDialer) DialContext(ctx context.Context, network string, destination M.Socksaddr) (net.Conn, error) {
    return d.Dialer.DialContext(adapter.OverrideContext(ctx), network, destination)
}
```

### Brutal 拥塞控制

Brutal 通过指定上传和下载速度（Mbps）来强制固定带宽。速度使用 `C.MbpsToBps` 转换为字节每秒。强制执行最低速度（`mux.BrutalMinSpeedBPS`）以防止配置错误。

## 服务端（Router）

服务端使用 `Router` 包装器拦截带 mux 标记的连接：

```go
type Router struct {
    router  adapter.ConnectionRouterEx
    service *mux.Service
}

func NewRouterWithOptions(router adapter.ConnectionRouterEx, logger logger.ContextLogger, options option.InboundMultiplexOptions) (adapter.ConnectionRouterEx, error) {
    if !options.Enabled {
        return router, nil
    }
    service, err := mux.NewService(mux.ServiceOptions{
        NewStreamContext: func(ctx context.Context, conn net.Conn) context.Context {
            return log.ContextWithNewID(ctx)
        },
        Logger:    logger,
        HandlerEx: adapter.NewRouteContextHandlerEx(router),
        Padding:   options.Padding,
        Brutal:    brutalOptions,
    })
    return &Router{router, service}, nil
}
```

### 连接路由

Router 检查目标地址是否与 `mux.Destination` 匹配以检测多路复用连接：

```go
func (r *Router) RouteConnectionEx(ctx context.Context, conn net.Conn, metadata adapter.InboundContext, onClose N.CloseHandlerFunc) {
    if metadata.Destination == mux.Destination {
        r.service.NewConnectionEx(adapter.WithContext(ctx, &metadata), conn,
            metadata.Source, metadata.Destination, onClose)
        return
    }
    r.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

`mux.Destination` 是一个哨兵地址，用于标识多路复用连接。非 mux 连接直接透传到底层路由器。

每个解复用的流通过 `NewStreamContext` 获得新的日志 ID。

## 配置

### 出站（客户端）

```json
{
  "multiplex": {
    "enabled": true,
    "protocol": "smux",
    "max_connections": 4,
    "min_streams": 4,
    "max_streams": 0,
    "padding": false,
    "brutal": {
      "enabled": true,
      "up_mbps": 100,
      "down_mbps": 100
    }
  }
}
```

### 入站（服务端）

```json
{
  "multiplex": {
    "enabled": true,
    "padding": false,
    "brutal": {
      "enabled": true,
      "up_mbps": 100,
      "down_mbps": 100
    }
  }
}
```

| 字段 | 描述 |
|-------|-------------|
| `protocol` | 多路复用协议（h2mux、smux、yamux） |
| `max_connections` | 最大底层连接数 |
| `min_streams` | 打开新连接前每个连接的最小流数 |
| `max_streams` | 每个连接的最大流数（0 = 无限制） |
| `padding` | 启用填充以抵抗流量分析 |
| `brutal.up_mbps` | Brutal 拥塞控制的上传速度（Mbps） |
| `brutal.down_mbps` | Brutal 拥塞控制的下载速度（Mbps） |
