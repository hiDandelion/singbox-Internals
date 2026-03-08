# Outbound 组：Selector 和 URLTest

Outbound 组管理出站连接的集合。Selector 允许手动选择，而 URLTest 基于定期健康检查自动选择延迟最低的 outbound。

**源码**: `protocol/group/selector.go`, `protocol/group/urltest.go`, `common/interrupt/`, `common/urltest/`

## Selector

### 架构

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

Selector 实现了多个 interface：

```go
var (
    _ adapter.OutboundGroup             = (*Selector)(nil)
    _ adapter.ConnectionHandlerEx       = (*Selector)(nil)
    _ adapter.PacketConnectionHandlerEx = (*Selector)(nil)
)
```

### 初始化

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

### 启动和选择

启动时，outbound 从标签解析为实际实例，并确定初始选择：

```go
func (s *Selector) Start() error {
    // 1. 将 outbound 标签解析为实际的 outbound 实例
    for _, tag := range s.tags {
        detour, _ := s.outbound.Outbound(tag)
        s.outbounds[tag] = detour
    }

    // 2. 尝试恢复缓存的选择
    cacheFile := service.FromContext[adapter.CacheFile](s.ctx)
    if cacheFile != nil {
        selected := cacheFile.LoadSelected(s.Tag())
        if detour, loaded := s.outbounds[selected]; loaded {
            s.selected.Store(detour)
            return nil
        }
    }

    // 3. 回退到默认标签
    if s.defaultTag != "" {
        s.selected.Store(s.outbounds[s.defaultTag])
        return nil
    }

    // 4. 回退到第一个 outbound
    s.selected.Store(s.outbounds[s.tags[0]])
    return nil
}
```

### 手动选择

```go
func (s *Selector) SelectOutbound(tag string) bool {
    detour, loaded := s.outbounds[tag]
    if !loaded {
        return false
    }
    if s.selected.Swap(detour) == detour {
        return true  // 已选中，无变化
    }
    // 将选择持久化到缓存
    cacheFile := service.FromContext[adapter.CacheFile](s.ctx)
    if cacheFile != nil {
        cacheFile.StoreSelected(s.Tag(), tag)
    }
    // 中断现有连接
    s.interruptGroup.Interrupt(s.interruptExternalConnections)
    return true
}
```

### 连接处理

Selector 委托给选中的 outbound：

```go
func (s *Selector) DialContext(ctx, network, destination) (net.Conn, error) {
    conn, _ := s.selected.Load().DialContext(ctx, network, destination)
    return s.interruptGroup.NewConn(conn, interrupt.IsExternalConnectionFromContext(ctx)), nil
}
```

对于基于处理器的路由（避免双重包装）：

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

### 动态网络

Selector 通告的网络随选中的 outbound 变化：

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

### 架构

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

核心逻辑位于 `URLTestGroup`：

```go
type URLTestGroup struct {
    outbounds                    []adapter.Outbound
    link                         string        // 测试 URL
    interval                     time.Duration // 检查间隔
    tolerance                    uint16        // 延迟容差（毫秒）
    idleTimeout                  time.Duration // 空闲后停止检查
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

### 默认值

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

### 分离的 TCP/UDP 选择

URLTest 为 TCP 和 UDP 维护独立的选择：

```go
selectedOutboundTCP adapter.Outbound
selectedOutboundUDP adapter.Outbound
```

这允许根据各自的延迟结果为 TCP 和 UDP 选择不同的 outbound。

### 选择算法

```go
func (g *URLTestGroup) Select(network string) (adapter.Outbound, bool) {
    var minDelay uint16
    var minOutbound adapter.Outbound

    // 从当前选中的 outbound 开始
    if g.selectedOutboundTCP != nil {
        if history := g.history.LoadURLTestHistory(RealTag(g.selectedOutboundTCP)); history != nil {
            minOutbound = g.selectedOutboundTCP
            minDelay = history.Delay
        }
    }

    // 查找更优的 outbound（必须比当前快超过容差值）
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

容差防止频繁切换：新的 outbound 必须比当前的至少快 `tolerance` 毫秒。

### 基于空闲的检查

健康检查仅在组被活跃使用时运行。`Touch()` 方法在首次使用时启动定时器：

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

检查循环在达到空闲超时时停止：

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

### URL 测试

测试以最多 10 个并发测试的限制并发运行：

```go
func (g *URLTestGroup) urlTest(ctx, force) (map[string]uint16, error) {
    if g.checking.Swap(true) {
        return result, nil  // 已在检查中
    }
    defer g.checking.Store(false)

    b, _ := batch.New(ctx, batch.WithConcurrencyNum[any](10))
    for _, detour := range g.outbounds {
        realTag := RealTag(detour)
        if checked[realTag] { continue }

        // 如果最近测试过则跳过
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

对于嵌套组，`RealTag` 会穿透组层级解析：

```go
func RealTag(detour adapter.Outbound) string {
    if group, isGroup := detour.(adapter.OutboundGroup); isGroup {
        return group.Now()
    }
    return detour.Tag()
}
```

### 更新检查和连接中断

测试完成后，更新选中的 outbound，如果选择发生变化则中断现有连接：

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

`interrupt.Group` 管理组变更时的连接生命周期：

- 当组选择变更时，调用 `Interrupt()`
- 所有通过 `interruptGroup.NewConn()` 包装的连接都会被关闭
- `interruptExternalConnections` 控制是否也中断来自外部来源（非本进程发起的）的连接

外部连接跟踪：

```go
func (s *URLTest) NewConnectionEx(ctx, conn, metadata, onClose) {
    ctx = interrupt.ContextWithIsExternalConnection(ctx)
    s.connection.NewConnection(ctx, s, conn, metadata, onClose)
}
```

## 错误处理

当选中的 outbound 失败时，其历史记录被删除以强制重新评估：

```go
conn, err := outbound.DialContext(ctx, network, destination)
if err == nil {
    return s.group.interruptGroup.NewConn(conn, ...), nil
}
s.logger.ErrorContext(ctx, err)
s.group.history.DeleteURLTestHistory(outbound.Tag())
return nil, err
```

## 配置示例

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
