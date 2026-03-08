# Box 生命周期

`Box` 是拥有所有管理器和服务的顶层容器。其生命周期遵循多阶段启动模式，以处理复杂的依赖排序。

**源码**: `box.go`, `adapter/lifecycle.go`

## Box 结构体

```go
type Box struct {
    createdAt       time.Time
    logFactory      log.Factory
    logger          log.ContextLogger
    network         *route.NetworkManager
    endpoint        *endpoint.Manager
    inbound         *inbound.Manager
    outbound        *outbound.Manager
    service         *boxService.Manager
    dnsTransport    *dns.TransportManager
    dnsRouter       *dns.Router
    connection      *route.ConnectionManager
    router          *route.Router
    internalService []adapter.LifecycleService  // cache-file, clash-api, v2ray-api, ntp
    done            chan struct{}
}
```

## 创建 (`New`)

`New()` 函数构建整个对象图：

```go
func New(options Options) (*Box, error) {
    ctx := options.Context
    ctx = service.ContextWithDefaultRegistry(ctx)

    // 1. 从 context 中获取注册表
    endpointRegistry := service.FromContext[adapter.EndpointRegistry](ctx)
    inboundRegistry := service.FromContext[adapter.InboundRegistry](ctx)
    outboundRegistry := service.FromContext[adapter.OutboundRegistry](ctx)
    dnsTransportRegistry := service.FromContext[adapter.DNSTransportRegistry](ctx)
    serviceRegistry := service.FromContext[adapter.ServiceRegistry](ctx)

    // 2. 创建管理器
    endpointManager := endpoint.NewManager(...)
    inboundManager := inbound.NewManager(...)
    outboundManager := outbound.NewManager(...)
    dnsTransportManager := dns.NewTransportManager(...)
    serviceManager := boxService.NewManager(...)

    // 3. 在 context 中注册管理器
    service.MustRegister[adapter.EndpointManager](ctx, endpointManager)
    service.MustRegister[adapter.InboundManager](ctx, inboundManager)
    // ... 等等

    // 4. 创建路由器和 DNS 路由器
    dnsRouter := dns.NewRouter(ctx, logFactory, dnsOptions)
    networkManager := route.NewNetworkManager(ctx, ...)
    connectionManager := route.NewConnectionManager(...)
    router := route.NewRouter(ctx, ...)

    // 5. 初始化路由器规则
    router.Initialize(routeOptions.Rules, routeOptions.RuleSet)
    dnsRouter.Initialize(dnsOptions.Rules)

    // 6. 通过注册表创建所有已配置的组件
    for _, transportOptions := range dnsOptions.Servers {
        dnsTransportManager.Create(ctx, ..., transportOptions.Type, transportOptions.Options)
    }
    for _, endpointOptions := range options.Endpoints {
        endpointManager.Create(ctx, ..., endpointOptions.Type, endpointOptions.Options)
    }
    for _, inboundOptions := range options.Inbounds {
        inboundManager.Create(ctx, ..., inboundOptions.Type, inboundOptions.Options)
    }
    for _, outboundOptions := range options.Outbounds {
        outboundManager.Create(ctx, ..., outboundOptions.Type, outboundOptions.Options)
    }

    // 7. 设置默认出站和 DNS 传输
    outboundManager.Initialize(func() { return direct.NewOutbound(...) })
    dnsTransportManager.Initialize(func() { return local.NewTransport(...) })

    // 8. 创建内部服务 (cache-file, clash-api, v2ray-api, ntp)
    // ...
}
```

## 启动阶段

生命周期接口使用 `StartStage` 枚举：

```go
type StartStage uint8

const (
    StartStateInitialize StartStage = iota  // 阶段 0: 内部初始化
    StartStateStart                          // 阶段 1: 开始服务
    StartStatePostStart                      // 阶段 2: 启动后钩子
    StartStateStarted                        // 阶段 3: 清理
)

type Lifecycle interface {
    Start(stage StartStage) error
    Close() error
}
```

### 阶段执行顺序

```
PreStart():
  阶段 0 (Initialize): internal-services → network → dnsTransport → dnsRouter →
                        connection → router → outbound → inbound → endpoint → service
  阶段 1 (Start):      outbound → dnsTransport → dnsRouter → network →
                        connection → router

Start() (从 PreStart 继续):
  阶段 1 (Start):      internal-services → inbound → endpoint → service
  阶段 2 (PostStart):  outbound → network → dnsTransport → dnsRouter →
                        connection → router → inbound → endpoint → service →
                        internal-services
  阶段 3 (Started):    network → dnsTransport → dnsRouter → connection →
                        router → outbound → inbound → endpoint → service →
                        internal-services
```

### 为什么需要多个阶段？

- **Initialize**: 创建内部状态，解决管理器之间的依赖关系
- **Start**: 开始监听/连接。出站先启动（DNS 传输和入站需要依赖出站）
- **PostStart**: 需要其他服务已在运行的任务（例如引用规则集的规则）
- **Started**: 清理临时数据，触发 GC

## 关闭

```go
func (s *Box) Close() error {
    close(s.done)  // 发出关闭信号

    // 按依赖关系的逆序关闭:
    // service → endpoint → inbound → outbound → router →
    // connection → dns-router → dns-transport → network

    // 然后关闭内部服务 (cache-file, clash-api 等)
    // 然后关闭日志器
}
```

## PreStart 与 Start

sing-box 支持两种启动模式：

- `Box.Start()` -- 完整启动，内部依次调用 `preStart()` 然后 `start()`
- `Box.PreStart()` -- 部分启动，用于移动平台，入站稍后启动

PreStart 初始化所有组件并启动出站/DNS/路由器，但不启动入站/Endpoint/服务。这允许平台层在流量流入之前配置 TUN。

## 任务监控器

每个阶段使用 `taskmonitor.New()` 来记录慢操作：

```go
monitor := taskmonitor.New(s.logger, C.StartTimeout)
monitor.Start("start logger")
err := s.logFactory.Start()
monitor.Finish()
```

如果某个任务超过 `C.StartTimeout`（60 秒），会记录一条包含任务名称的警告日志。
