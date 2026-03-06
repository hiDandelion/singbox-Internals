# Outbound Groups: Selector and URLTest

Outbound groups manage collections of outbound connections. The Selector allows manual selection, while URLTest automatically selects the lowest-latency outbound based on periodic health checks.

**Source**: `protocol/group/selector.go`, `protocol/group/urltest.go`, `common/interrupt/`, `common/urltest/`

## Selector

### Architecture

```go
type Selector struct {
    outbound.Adapter
    ctx                          context.Context
    outbound                     adapter.OutboundManager
    connection                   adapter.ConnectionManager
    logger                       logger.ContextLogger
    tags                         []string
    defaultTag                   string
    outbounds                    map[string]adapter.Outbound
    selected                     common.TypedValue[adapter.Outbound]
    interruptGroup               *interrupt.Group
    interruptExternalConnections bool
}
```

The Selector implements multiple interfaces:

```go
var (
    _ adapter.OutboundGroup             = (*Selector)(nil)
    _ adapter.ConnectionHandlerEx       = (*Selector)(nil)
    _ adapter.PacketConnectionHandlerEx = (*Selector)(nil)
)
```

### Initialization

```go
func NewSelector(ctx, router, logger, tag, options) (adapter.Outbound, error) {
    outbound := &Selector{
        tags:                         options.Outbounds,
        defaultTag:                   options.Default,
        outbounds:                    make(map[string]adapter.Outbound),
        interruptGroup:               interrupt.NewGroup(),
        interruptExternalConnections: options.InterruptExistConnections,
    }
    if len(outbound.tags) == 0 {
        return nil, E.New("missing tags")
    }
    return outbound, nil
}
```

### Start and Selection

At start, outbounds are resolved from tags, and the initial selection is determined:

```go
func (s *Selector) Start() error {
    // 1. Resolve outbound tags to actual outbound instances
    for _, tag := range s.tags {
        detour, _ := s.outbound.Outbound(tag)
        s.outbounds[tag] = detour
    }

    // 2. Try to restore cached selection
    cacheFile := service.FromContext[adapter.CacheFile](s.ctx)
    if cacheFile != nil {
        selected := cacheFile.LoadSelected(s.Tag())
        if detour, loaded := s.outbounds[selected]; loaded {
            s.selected.Store(detour)
            return nil
        }
    }

    // 3. Fall back to default tag
    if s.defaultTag != "" {
        s.selected.Store(s.outbounds[s.defaultTag])
        return nil
    }

    // 4. Fall back to first outbound
    s.selected.Store(s.outbounds[s.tags[0]])
    return nil
}
```

### Manual Selection

```go
func (s *Selector) SelectOutbound(tag string) bool {
    detour, loaded := s.outbounds[tag]
    if !loaded {
        return false
    }
    if s.selected.Swap(detour) == detour {
        return true  // Already selected, no change
    }
    // Persist selection to cache
    cacheFile := service.FromContext[adapter.CacheFile](s.ctx)
    if cacheFile != nil {
        cacheFile.StoreSelected(s.Tag(), tag)
    }
    // Interrupt existing connections
    s.interruptGroup.Interrupt(s.interruptExternalConnections)
    return true
}
```

### Connection Handling

The Selector delegates to the selected outbound:

```go
func (s *Selector) DialContext(ctx, network, destination) (net.Conn, error) {
    conn, _ := s.selected.Load().DialContext(ctx, network, destination)
    return s.interruptGroup.NewConn(conn, interrupt.IsExternalConnectionFromContext(ctx)), nil
}
```

For handler-based routing (avoiding double-wrap):

```go
func (s *Selector) NewConnectionEx(ctx, conn, metadata, onClose) {
    ctx = interrupt.ContextWithIsExternalConnection(ctx)
    selected := s.selected.Load()
    if outboundHandler, isHandler := selected.(adapter.ConnectionHandlerEx); isHandler {
        outboundHandler.NewConnectionEx(ctx, conn, metadata, onClose)
    } else {
        s.connection.NewConnection(ctx, selected, conn, metadata, onClose)
    }
}
```

### Dynamic Network

The Selector's advertised network changes based on the selected outbound:

```go
func (s *Selector) Network() []string {
    selected := s.selected.Load()
    if selected == nil {
        return []string{N.NetworkTCP, N.NetworkUDP}
    }
    return selected.Network()
}
```

## URLTest

### Architecture

```go
type URLTest struct {
    outbound.Adapter
    ctx                          context.Context
    router                       adapter.Router
    outbound                     adapter.OutboundManager
    connection                   adapter.ConnectionManager
    logger                       log.ContextLogger
    tags                         []string
    link                         string
    interval                     time.Duration
    tolerance                    uint16
    idleTimeout                  time.Duration
    group                        *URLTestGroup
    interruptExternalConnections bool
}
```

### URLTestGroup

The core logic lives in `URLTestGroup`:

```go
type URLTestGroup struct {
    outbounds                    []adapter.Outbound
    link                         string        // URL to test
    interval                     time.Duration // check interval
    tolerance                    uint16        // delay tolerance (ms)
    idleTimeout                  time.Duration // stop checking after idle
    history                      adapter.URLTestHistoryStorage
    checking                     atomic.Bool
    selectedOutboundTCP          adapter.Outbound
    selectedOutboundUDP          adapter.Outbound
    interruptGroup               *interrupt.Group
    interruptExternalConnections bool
    ticker                       *time.Ticker
    lastActive                   common.TypedValue[time.Time]
}
```

### Default Values

```go
if interval == 0 {
    interval = C.DefaultURLTestInterval
}
if tolerance == 0 {
    tolerance = 50   // 50ms
}
if idleTimeout == 0 {
    idleTimeout = C.DefaultURLTestIdleTimeout
}
if interval > idleTimeout {
    return nil, E.New("interval must be less or equal than idle_timeout")
}
```

### Separate TCP/UDP Selection

URLTest maintains separate selections for TCP and UDP:

```go
selectedOutboundTCP adapter.Outbound
selectedOutboundUDP adapter.Outbound
```

This allows selecting different outbounds for TCP and UDP based on their respective latency results.

### Selection Algorithm

```go
func (g *URLTestGroup) Select(network string) (adapter.Outbound, bool) {
    var minDelay uint16
    var minOutbound adapter.Outbound

    // Start with the currently selected outbound
    if g.selectedOutboundTCP != nil {
        if history := g.history.LoadURLTestHistory(RealTag(g.selectedOutboundTCP)); history != nil {
            minOutbound = g.selectedOutboundTCP
            minDelay = history.Delay
        }
    }

    // Find better outbound (must beat current by tolerance)
    for _, detour := range g.outbounds {
        if !common.Contains(detour.Network(), network) {
            continue
        }
        history := g.history.LoadURLTestHistory(RealTag(detour))
        if history == nil {
            continue
        }
        if minDelay == 0 || minDelay > history.Delay+g.tolerance {
            minDelay = history.Delay
            minOutbound = detour
        }
    }
    return minOutbound, minOutbound != nil
}
```

The tolerance prevents frequent switching: a new outbound must be at least `tolerance` ms faster than the current one.

### Idle-Based Checking

Health checks only run when the group is actively used. The `Touch()` method starts the ticker on first use:

```go
func (g *URLTestGroup) Touch() {
    g.access.Lock()
    defer g.access.Unlock()
    if g.ticker != nil {
        g.lastActive.Store(time.Now())
        return
    }
    g.ticker = time.NewTicker(g.interval)
    go g.loopCheck()
}
```

The check loop stops when idle timeout is reached:

```go
func (g *URLTestGroup) loopCheck() {
    for {
        select {
        case <-g.close:
            return
        case <-g.ticker.C:
        }
        if time.Since(g.lastActive.Load()) > g.idleTimeout {
            g.ticker.Stop()
            g.ticker = nil
            return
        }
        g.CheckOutbounds(false)
    }
}
```

### URL Testing

Tests are run concurrently with a limit of 10 concurrent tests:

```go
func (g *URLTestGroup) urlTest(ctx, force) (map[string]uint16, error) {
    if g.checking.Swap(true) {
        return result, nil  // Already checking
    }
    defer g.checking.Store(false)

    b, _ := batch.New(ctx, batch.WithConcurrencyNum[any](10))
    for _, detour := range g.outbounds {
        realTag := RealTag(detour)
        if checked[realTag] { continue }

        // Skip if recently tested
        history := g.history.LoadURLTestHistory(realTag)
        if !force && history != nil && time.Since(history.Time) < g.interval {
            continue
        }

        b.Go(realTag, func() (any, error) {
            testCtx, cancel := context.WithTimeout(g.ctx, C.TCPTimeout)
            defer cancel()
            t, err := urltest.URLTest(testCtx, g.link, p)
            if err != nil {
                g.history.DeleteURLTestHistory(realTag)
            } else {
                g.history.StoreURLTestHistory(realTag, &adapter.URLTestHistory{
                    Time: time.Now(), Delay: t,
                })
            }
            return nil, nil
        })
    }
    b.Wait()
    g.performUpdateCheck()
    return result, nil
}
```

### RealTag

For nested groups, `RealTag` resolves through group layers:

```go
func RealTag(detour adapter.Outbound) string {
    if group, isGroup := detour.(adapter.OutboundGroup); isGroup {
        return group.Now()
    }
    return detour.Tag()
}
```

### Update Check and Interruption

After testing, the selected outbound is updated and existing connections are interrupted if the selection changed:

```go
func (g *URLTestGroup) performUpdateCheck() {
    var updated bool
    if outbound, exists := g.Select(N.NetworkTCP); outbound != nil && exists && outbound != g.selectedOutboundTCP {
        updated = true
        g.selectedOutboundTCP = outbound
    }
    if outbound, exists := g.Select(N.NetworkUDP); outbound != nil && exists && outbound != g.selectedOutboundUDP {
        updated = true
        g.selectedOutboundUDP = outbound
    }
    if updated {
        g.interruptGroup.Interrupt(g.interruptExternalConnections)
    }
}
```

## Interrupt Group

The `interrupt.Group` manages connection lifecycle for group changes:

- When a group selection changes, `Interrupt()` is called
- All connections wrapped with `interruptGroup.NewConn()` are closed
- `interruptExternalConnections` controls whether connections from external sources (not initiated by this process) are also interrupted

External connection tracking:

```go
func (s *URLTest) NewConnectionEx(ctx, conn, metadata, onClose) {
    ctx = interrupt.ContextWithIsExternalConnection(ctx)
    s.connection.NewConnection(ctx, s, conn, metadata, onClose)
}
```

## Error Handling

When a selected outbound fails, its history is deleted to force re-evaluation:

```go
conn, err := outbound.DialContext(ctx, network, destination)
if err == nil {
    return s.group.interruptGroup.NewConn(conn, ...), nil
}
s.logger.ErrorContext(ctx, err)
s.group.history.DeleteURLTestHistory(outbound.Tag())
return nil, err
```

## Configuration Examples

### Selector

```json
{
  "type": "selector",
  "tag": "proxy",
  "outbounds": ["server-a", "server-b", "server-c"],
  "default": "server-a",
  "interrupt_exist_connections": true
}
```

### URLTest

```json
{
  "type": "urltest",
  "tag": "auto",
  "outbounds": ["server-a", "server-b", "server-c"],
  "url": "https://www.gstatic.com/generate_204",
  "interval": "3m",
  "tolerance": 50,
  "idle_timeout": "30m",
  "interrupt_exist_connections": true
}
```
