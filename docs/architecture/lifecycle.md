# Box Lifecycle

The `Box` is the top-level container that owns all managers and services. Its lifecycle follows a multi-phase startup pattern to handle complex dependency ordering.

**Source**: `box.go`, `adapter/lifecycle.go`

## Box Structure

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

## Creation (`New`)

The `New()` function builds the entire object graph:

```go
func New(options Options) (*Box, error) {
    ctx := options.Context
    ctx = service.ContextWithDefaultRegistry(ctx)

    // 1. Retrieve registries from context
    endpointRegistry := service.FromContext[adapter.EndpointRegistry](ctx)
    inboundRegistry := service.FromContext[adapter.InboundRegistry](ctx)
    outboundRegistry := service.FromContext[adapter.OutboundRegistry](ctx)
    dnsTransportRegistry := service.FromContext[adapter.DNSTransportRegistry](ctx)
    serviceRegistry := service.FromContext[adapter.ServiceRegistry](ctx)

    // 2. Create managers
    endpointManager := endpoint.NewManager(...)
    inboundManager := inbound.NewManager(...)
    outboundManager := outbound.NewManager(...)
    dnsTransportManager := dns.NewTransportManager(...)
    serviceManager := boxService.NewManager(...)

    // 3. Register managers in context
    service.MustRegister[adapter.EndpointManager](ctx, endpointManager)
    service.MustRegister[adapter.InboundManager](ctx, inboundManager)
    // ... etc.

    // 4. Create router and DNS router
    dnsRouter := dns.NewRouter(ctx, logFactory, dnsOptions)
    networkManager := route.NewNetworkManager(ctx, ...)
    connectionManager := route.NewConnectionManager(...)
    router := route.NewRouter(ctx, ...)

    // 5. Initialize router rules
    router.Initialize(routeOptions.Rules, routeOptions.RuleSet)
    dnsRouter.Initialize(dnsOptions.Rules)

    // 6. Create all configured components via registries
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

    // 7. Set default outbound and DNS transport
    outboundManager.Initialize(func() { return direct.NewOutbound(...) })
    dnsTransportManager.Initialize(func() { return local.NewTransport(...) })

    // 8. Create internal services (cache-file, clash-api, v2ray-api, ntp)
    // ...
}
```

## Startup Phases

The lifecycle interface uses a `StartStage` enum:

```go
type StartStage uint8

const (
    StartStateInitialize StartStage = iota  // Phase 0: internal setup
    StartStateStart                          // Phase 1: start serving
    StartStatePostStart                      // Phase 2: post-start hooks
    StartStateStarted                        // Phase 3: cleanup
)

type Lifecycle interface {
    Start(stage StartStage) error
    Close() error
}
```

### Phase Execution Order

```
PreStart():
  Phase 0 (Initialize): internal-services → network → dnsTransport → dnsRouter →
                         connection → router → outbound → inbound → endpoint → service
  Phase 1 (Start):      outbound → dnsTransport → dnsRouter → network →
                         connection → router

Start() (continues from PreStart):
  Phase 1 (Start):      internal-services → inbound → endpoint → service
  Phase 2 (PostStart):  outbound → network → dnsTransport → dnsRouter →
                         connection → router → inbound → endpoint → service →
                         internal-services
  Phase 3 (Started):    network → dnsTransport → dnsRouter → connection →
                         router → outbound → inbound → endpoint → service →
                         internal-services
```

### Why Multiple Phases?

- **Initialize**: Create internal state, resolve dependencies between managers
- **Start**: Begin listening/connecting. Outbounds start first (needed by DNS transports and inbounds)
- **PostStart**: Tasks that require other services to be running (e.g., rules that reference rule sets)
- **Started**: Cleanup temporary data, trigger GC

## Shutdown

```go
func (s *Box) Close() error {
    close(s.done)  // signal shutdown

    // Close in reverse dependency order:
    // service → endpoint → inbound → outbound → router →
    // connection → dns-router → dns-transport → network

    // Then internal services (cache-file, clash-api, etc.)
    // Then logger
}
```

## PreStart vs Start

sing-box supports two startup modes:

- `Box.Start()` — full startup, calls `preStart()` then `start()` internally
- `Box.PreStart()` — partial startup for mobile platforms where inbounds should start later

PreStart initializes everything and starts outbounds/DNS/router, but does NOT start inbounds/endpoints/services. This allows the platform layer to configure TUN before traffic flows.

## Task Monitor

Each phase uses a `taskmonitor.New()` to log slow operations:

```go
monitor := taskmonitor.New(s.logger, C.StartTimeout)
monitor.Start("start logger")
err := s.logFactory.Start()
monitor.Finish()
```

If a task exceeds `C.StartTimeout` (60s), it logs a warning with the task name.
