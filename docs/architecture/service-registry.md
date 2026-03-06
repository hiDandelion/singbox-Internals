# Service Registry

sing-box uses Go's `context.Context` as a service container for dependency injection. This eliminates global singletons and makes the dependency graph explicit.

**Source**: `github.com/sagernet/sing/service`, `box.go`, `include/`

## How It Works

The `sing/service` package provides typed service registration:

```go
// Register a service in context
func ContextWith[T any](ctx context.Context, service T) context.Context

// Retrieve a service from context
func FromContext[T any](ctx context.Context) T

// Register with panic on duplicate
func MustRegister[T any](ctx context.Context, service T)
```

Services are keyed by their **interface type**, not concrete type. This means:

```go
// Register NetworkManager
service.MustRegister[adapter.NetworkManager](ctx, networkManager)

// Any code with the context can retrieve it
nm := service.FromContext[adapter.NetworkManager](ctx)
```

## Registration in Box.New()

During `Box.New()`, all managers are registered:

```go
// Create managers
endpointManager := endpoint.NewManager(...)
inboundManager := inbound.NewManager(...)
outboundManager := outbound.NewManager(...)
dnsTransportManager := dns.NewTransportManager(...)
serviceManager := boxService.NewManager(...)

// Register in context
service.MustRegister[adapter.EndpointManager](ctx, endpointManager)
service.MustRegister[adapter.InboundManager](ctx, inboundManager)
service.MustRegister[adapter.OutboundManager](ctx, outboundManager)
service.MustRegister[adapter.DNSTransportManager](ctx, dnsTransportManager)
service.MustRegister[adapter.ServiceManager](ctx, serviceManager)

// Also register router, network manager, DNS router, connection manager
service.MustRegister[adapter.Router](ctx, router)
service.MustRegister[adapter.NetworkManager](ctx, networkManager)
service.MustRegister[adapter.DNSRouter](ctx, dnsRouter)
service.MustRegister[adapter.ConnectionManager](ctx, connectionManager)
```

## Registry Pattern

Protocol types are registered via typed registries:

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

### How Registries Are Populated

The `include/` package uses build tags to register protocol types:

```go
// include/inbound.go
func InboundRegistry() *inbound.Registry {
    registry := inbound.NewRegistry()
    tun.RegisterInbound(registry)
    socks.RegisterInbound(registry)
    http.RegisterInbound(registry)
    mixed.RegisterInbound(registry)
    direct.RegisterInbound(registry)
    // ... all protocol types
    return registry
}
```

Each protocol registers itself:

```go
// protocol/vless/inbound.go
func RegisterInbound(registry adapter.InboundRegistry) {
    inbound.Register[option.VLESSInboundOptions](registry, C.TypeVLESS, NewInbound)
}
```

The generic `Register` function maps: type string → options type → factory function.

## Context Initialization

The `box.Context()` function prepares the context with registries:

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
    // ... etc.
    return ctx
}
```

This is called before `Box.New()`, typically in `cmd/sing-box/main.go`:

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

## Dual Registration

Both the options registry and the adapter registry are registered:

```go
ctx = service.ContextWith[option.InboundOptionsRegistry](ctx, inboundRegistry)
ctx = service.ContextWith[adapter.InboundRegistry](ctx, inboundRegistry)
```

The options registry is used during JSON parsing to determine the correct options struct type. The adapter registry is used during `Box.New()` to create instances from options.

## Usage in Components

Any component with access to the context can retrieve services:

```go
// In Router constructor
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

## Comparison with Xray-core

| Aspect | Xray-core | sing-box |
|--------|----------|----------|
| DI pattern | `RequireFeatures` + reflection | Context-based typed lookup |
| Registration | Global feature registry on Instance | Per-context service registry |
| Resolution | Lazy (resolved when all deps available) | Eager (resolved at creation time) |
| Type safety | Runtime type assertion | Compile-time generics |
| Lifecycle | Feature.Start() called by Instance | Multi-phase Start(stage) |
