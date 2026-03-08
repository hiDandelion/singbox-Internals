# Группы исходящих соединений: Selector и URLTest

Группы исходящих соединений управляют коллекциями исходящих соединений. Selector позволяет выбирать вручную, а URLTest автоматически выбирает исходящее соединение с наименьшей задержкой на основе периодических проверок доступности.

**Исходный код**: `protocol/group/selector.go`, `protocol/group/urltest.go`, `common/interrupt/`, `common/urltest/`

## Selector

### Архитектура

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

Selector реализует несколько интерфейсов:

```go
var (
    _ adapter.OutboundGroup             = (*Selector)(nil)
    _ adapter.ConnectionHandlerEx       = (*Selector)(nil)
    _ adapter.PacketConnectionHandlerEx = (*Selector)(nil)
)
```

### Инициализация

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

### Запуск и выбор

При запуске исходящие соединения разрешаются из тегов, и определяется начальный выбор:

```go
func (s *Selector) Start() error {
    // 1. Разрешить теги исходящих соединений в фактические экземпляры
    for _, tag := range s.tags {
        detour, _ := s.outbound.Outbound(tag)
        s.outbounds[tag] = detour
    }

    // 2. Попытаться восстановить кэшированный выбор
    cacheFile := service.FromContext[adapter.CacheFile](s.ctx)
    if cacheFile != nil {
        selected := cacheFile.LoadSelected(s.Tag())
        if detour, loaded := s.outbounds[selected]; loaded {
            s.selected.Store(detour)
            return nil
        }
    }

    // 3. Использовать тег по умолчанию
    if s.defaultTag != "" {
        s.selected.Store(s.outbounds[s.defaultTag])
        return nil
    }

    // 4. Использовать первое исходящее соединение
    s.selected.Store(s.outbounds[s.tags[0]])
    return nil
}
```

### Ручной выбор

```go
func (s *Selector) SelectOutbound(tag string) bool {
    detour, loaded := s.outbounds[tag]
    if !loaded {
        return false
    }
    if s.selected.Swap(detour) == detour {
        return true  // Уже выбран, без изменений
    }
    // Сохранить выбор в кэш
    cacheFile := service.FromContext[adapter.CacheFile](s.ctx)
    if cacheFile != nil {
        cacheFile.StoreSelected(s.Tag(), tag)
    }
    // Прервать существующие соединения
    s.interruptGroup.Interrupt(s.interruptExternalConnections)
    return true
}
```

### Обработка соединений

Selector делегирует работу выбранному исходящему соединению:

```go
func (s *Selector) DialContext(ctx, network, destination) (net.Conn, error) {
    conn, _ := s.selected.Load().DialContext(ctx, network, destination)
    return s.interruptGroup.NewConn(conn, interrupt.IsExternalConnectionFromContext(ctx)), nil
}
```

Для маршрутизации на основе обработчиков (избегая двойной обёртки):

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

### Динамическая сеть

Объявленная сеть Selector'а меняется в зависимости от выбранного исходящего соединения:

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

### Архитектура

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

Основная логика находится в `URLTestGroup`:

```go
type URLTestGroup struct {
    outbounds                    []adapter.Outbound
    link                         string        // URL для тестирования
    interval                     time.Duration // интервал проверки
    tolerance                    uint16        // допуск задержки (мс)
    idleTimeout                  time.Duration // прекратить проверки после бездействия
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

### Значения по умолчанию

```go
if interval == 0 {
    interval = C.DefaultURLTestInterval
}
if tolerance == 0 {
    tolerance = 50   // 50 мс
}
if idleTimeout == 0 {
    idleTimeout = C.DefaultURLTestIdleTimeout
}
if interval > idleTimeout {
    return nil, E.New("interval must be less or equal than idle_timeout")
}
```

### Раздельный выбор TCP/UDP

URLTest поддерживает раздельный выбор для TCP и UDP:

```go
selectedOutboundTCP adapter.Outbound
selectedOutboundUDP adapter.Outbound
```

Это позволяет выбирать разные исходящие соединения для TCP и UDP на основе их соответствующих результатов задержки.

### Алгоритм выбора

```go
func (g *URLTestGroup) Select(network string) (adapter.Outbound, bool) {
    var minDelay uint16
    var minOutbound adapter.Outbound

    // Начать с текущего выбранного исходящего соединения
    if g.selectedOutboundTCP != nil {
        if history := g.history.LoadURLTestHistory(RealTag(g.selectedOutboundTCP)); history != nil {
            minOutbound = g.selectedOutboundTCP
            minDelay = history.Delay
        }
    }

    // Найти лучшее исходящее соединение (должно превосходить текущее на tolerance)
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

Допуск предотвращает частое переключение: новое исходящее соединение должно быть как минимум на `tolerance` мс быстрее текущего.

### Проверки на основе активности

Проверки доступности выполняются только при активном использовании группы. Метод `Touch()` запускает тикер при первом использовании:

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

Цикл проверки останавливается по достижении таймаута бездействия:

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

### URL-тестирование

Тесты выполняются конкурентно с ограничением в 10 одновременных тестов:

```go
func (g *URLTestGroup) urlTest(ctx, force) (map[string]uint16, error) {
    if g.checking.Swap(true) {
        return result, nil  // Уже проверяется
    }
    defer g.checking.Store(false)

    b, _ := batch.New(ctx, batch.WithConcurrencyNum[any](10))
    for _, detour := range g.outbounds {
        realTag := RealTag(detour)
        if checked[realTag] { continue }

        // Пропустить, если недавно тестировалось
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

Для вложенных групп `RealTag` разрешает через слои групп:

```go
func RealTag(detour adapter.Outbound) string {
    if group, isGroup := detour.(adapter.OutboundGroup); isGroup {
        return group.Now()
    }
    return detour.Tag()
}
```

### Проверка обновлений и прерывание

После тестирования выбранное исходящее соединение обновляется, и существующие соединения прерываются при изменении выбора:

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

## Группа прерывания (Interrupt Group)

`interrupt.Group` управляет жизненным циклом соединений при изменениях в группе:

- При смене выбора группы вызывается `Interrupt()`
- Все соединения, обёрнутые `interruptGroup.NewConn()`, закрываются
- `interruptExternalConnections` контролирует, прерываются ли также соединения из внешних источников (не инициированные этим процессом)

Отслеживание внешних соединений:

```go
func (s *URLTest) NewConnectionEx(ctx, conn, metadata, onClose) {
    ctx = interrupt.ContextWithIsExternalConnection(ctx)
    s.connection.NewConnection(ctx, s, conn, metadata, onClose)
}
```

## Обработка ошибок

При сбое выбранного исходящего соединения его история удаляется для принудительной переоценки:

```go
conn, err := outbound.DialContext(ctx, network, destination)
if err == nil {
    return s.group.interruptGroup.NewConn(conn, ...), nil
}
s.logger.ErrorContext(ctx, err)
s.group.history.DeleteURLTestHistory(outbound.Tag())
return nil, err
```

## Примеры конфигурации

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
