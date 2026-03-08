# 服务注册表

sing-box 使用 Go 的 `context.Context` 作为服务容器进行依赖注入。这消除了全局单例，使依赖图更加明确。

**源码**: `github.com/sagernet/sing/service`, `box.go`, `include/`

## 工作原理

`sing/service` 包提供了类型化的服务注册：

```go
// 在 context 中注册服务
func ContextWith[T any](ctx context.Context, service T) context.Context

// 从 context 中获取服务
func FromContext[T any](ctx context.Context) T

// 注册时若重复则 panic
func MustRegister[T any](ctx context.Context, service T)
```

服务以其**接口类型**而非具体类型作为键。这意味着：

```go
// 注册 NetworkManager
service.MustRegister[adapter.NetworkManager](ctx, networkManager)

// 任何持有 context 的代码都可以获取它
nm := service.FromContext[adapter.NetworkManager](ctx)
```

## 在 Box.New() 中注册

在 `Box.New()` 期间，所有管理器都会被注册：

```go
// 创建管理器
endpointManager := endpoint.NewManager(...)
inboundManager := inbound.NewManager(...)
outboundManager := outbound.NewManager(...)
dnsTransportManager := dns.NewTransportManager(...)
serviceManager := boxService.NewManager(...)

// 在 context 中注册
service.MustRegister[adapter.EndpointManager](ctx, endpointManager)
service.MustRegister[adapter.InboundManager](ctx, inboundManager)
service.MustRegister[adapter.OutboundManager](ctx, outboundManager)
service.MustRegister[adapter.DNSTransportManager](ctx, dnsTransportManager)
service.MustRegister[adapter.ServiceManager](ctx, serviceManager)

// 同样注册路由器、网络管理器、DNS 路由器、连接管理器
service.MustRegister[adapter.Router](ctx, router)
service.MustRegister[adapter.NetworkManager](ctx, networkManager)
service.MustRegister[adapter.DNSRouter](ctx, dnsRouter)
service.MustRegister[adapter.ConnectionManager](ctx, connectionManager)
```

## 注册表模式

协议类型通过类型化注册表进行注册：

```go
type InboundRegistry interface {
    option.InboundOptionsRegistry
    Create(ctx, router, logger, tag, inboundType string, options any) (Inbound, error)
}

type OutboundRegistry interface {
    option.OutboundOptionsRegistry
    CreateOutbound(ctx, router, logger, tag, outboundType string, options any) (Outbound, error)
}
```

### 注册表如何填充

`include/` 包使用构建标签来注册协议类型：

```go
// include/inbound.go
func InboundRegistry() *inbound.Registry {
    registry := inbound.NewRegistry()
    tun.RegisterInbound(registry)
    socks.RegisterInbound(registry)
    http.RegisterInbound(registry)
    mixed.RegisterInbound(registry)
    direct.RegisterInbound(registry)
    // ... 所有协议类型
    return registry
}
```

每个协议自行注册：

```go
// protocol/vless/inbound.go
func RegisterInbound(registry adapter.InboundRegistry) {
    inbound.Register[option.VLESSInboundOptions](registry, C.TypeVLESS, NewInbound)
}
```

泛型 `Register` 函数建立映射：类型字符串 -> 选项类型 -> 工厂函数。

## Context 初始化

`box.Context()` 函数使用注册表准备 context：

```go
func Context(
    ctx context.Context,
    inboundRegistry adapter.InboundRegistry,
    outboundRegistry adapter.OutboundRegistry,
    endpointRegistry adapter.EndpointRegistry,
    dnsTransportRegistry adapter.DNSTransportRegistry,
    serviceRegistry adapter.ServiceRegistry,
) context.Context {
    ctx = service.ContextWith[adapter.InboundRegistry](ctx, inboundRegistry)
    ctx = service.ContextWith[adapter.OutboundRegistry](ctx, outboundRegistry)
    // ... 等等
    return ctx
}
```

这在 `Box.New()` 之前调用，通常在 `cmd/sing-box/main.go` 中：

```go
ctx = box.Context(ctx,
    include.InboundRegistry(),
    include.OutboundRegistry(),
    include.EndpointRegistry(),
    include.DNSTransportRegistry(),
    include.ServiceRegistry(),
)
instance, err := box.New(box.Options{
    Context: ctx,
    Options: options,
})
```

## 双重注册

选项注册表和适配器注册表都会被注册：

```go
ctx = service.ContextWith[option.InboundOptionsRegistry](ctx, inboundRegistry)
ctx = service.ContextWith[adapter.InboundRegistry](ctx, inboundRegistry)
```

选项注册表在 JSON 解析期间用于确定正确的选项结构体类型。适配器注册表在 `Box.New()` 期间用于从选项创建实例。

## 在组件中使用

任何拥有 context 的组件都可以获取服务：

```go
// 在 Router 构造函数中
func NewRouter(ctx context.Context, ...) *Router {
    return &Router{
        inbound:  service.FromContext[adapter.InboundManager](ctx),
        outbound: service.FromContext[adapter.OutboundManager](ctx),
        dns:      service.FromContext[adapter.DNSRouter](ctx),
        network:  service.FromContext[adapter.NetworkManager](ctx),
        // ...
    }
}
```

## 与 Xray-core 的对比

| 方面 | Xray-core | sing-box |
|--------|----------|----------|
| 依赖注入模式 | `RequireFeatures` + 反射 | 基于 context 的类型化查找 |
| 注册方式 | Instance 上的全局 feature 注册表 | 每个 context 独立的服务注册表 |
| 解析方式 | 延迟解析（所有依赖就绪时） | 即时解析（创建时立即解析） |
| 类型安全 | 运行时类型断言 | 编译时泛型 |
| 生命周期 | Feature.Start() 由 Instance 调用 | 多阶段 Start(stage) |
