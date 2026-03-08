# مجموعات الصادرات: Selector وURLTest

تدير مجموعات الصادرات مجموعات من اتصالات الصادرات. يسمح Selector بالاختيار اليدوي، بينما يختار URLTest تلقائياً الصادر ذو أقل زمن استجابة بناءً على فحوصات صحية دورية.

**المصدر**: `protocol/group/selector.go`، `protocol/group/urltest.go`، `common/interrupt/`، `common/urltest/`

## Selector

### البنية

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

ينفذ Selector واجهات متعددة:

```go
var (
    _ adapter.OutboundGroup             = (*Selector)(nil)
    _ adapter.ConnectionHandlerEx       = (*Selector)(nil)
    _ adapter.PacketConnectionHandlerEx = (*Selector)(nil)
)
```

### التهيئة

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

### البدء والاختيار

عند البدء، يتم حل الصادرات من الوسوم، ويتم تحديد الاختيار الأولي:

```go
func (s *Selector) Start() error {
    // 1. حل وسوم الصادرات إلى نسخ صادرات فعلية
    for _, tag := range s.tags {
        detour, _ := s.outbound.Outbound(tag)
        s.outbounds[tag] = detour
    }

    // 2. محاولة استعادة الاختيار المخزن مؤقتاً
    cacheFile := service.FromContext[adapter.CacheFile](s.ctx)
    if cacheFile != nil {
        selected := cacheFile.LoadSelected(s.Tag())
        if detour, loaded := s.outbounds[selected]; loaded {
            s.selected.Store(detour)
            return nil
        }
    }

    // 3. الرجوع إلى الوسم الافتراضي
    if s.defaultTag != "" {
        s.selected.Store(s.outbounds[s.defaultTag])
        return nil
    }

    // 4. الرجوع إلى أول صادر
    s.selected.Store(s.outbounds[s.tags[0]])
    return nil
}
```

### الاختيار اليدوي

```go
func (s *Selector) SelectOutbound(tag string) bool {
    detour, loaded := s.outbounds[tag]
    if !loaded {
        return false
    }
    if s.selected.Swap(detour) == detour {
        return true  // مختار بالفعل، لا تغيير
    }
    // حفظ الاختيار في الذاكرة المؤقتة
    cacheFile := service.FromContext[adapter.CacheFile](s.ctx)
    if cacheFile != nil {
        cacheFile.StoreSelected(s.Tag(), tag)
    }
    // مقاطعة الاتصالات الحالية
    s.interruptGroup.Interrupt(s.interruptExternalConnections)
    return true
}
```

### معالجة الاتصال

يفوض Selector إلى الصادر المختار:

```go
func (s *Selector) DialContext(ctx, network, destination) (net.Conn, error) {
    conn, _ := s.selected.Load().DialContext(ctx, network, destination)
    return s.interruptGroup.NewConn(conn, interrupt.IsExternalConnectionFromContext(ctx)), nil
}
```

للتوجيه القائم على المعالج (تجنب التغليف المزدوج):

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

### الشبكة الديناميكية

تتغير الشبكة المعلنة لـ Selector بناءً على الصادر المختار:

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

### البنية

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

يوجد المنطق الأساسي في `URLTestGroup`:

```go
type URLTestGroup struct {
    outbounds                    []adapter.Outbound
    link                         string        // الرابط للاختبار
    interval                     time.Duration // فترة الفحص
    tolerance                    uint16        // تحمل التأخير (مللي ثانية)
    idleTimeout                  time.Duration // التوقف عن الفحص بعد الخمول
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

### القيم الافتراضية

```go
if interval == 0 {
    interval = C.DefaultURLTestInterval
}
if tolerance == 0 {
    tolerance = 50   // 50 مللي ثانية
}
if idleTimeout == 0 {
    idleTimeout = C.DefaultURLTestIdleTimeout
}
if interval > idleTimeout {
    return nil, E.New("interval must be less or equal than idle_timeout")
}
```

### اختيار منفصل لـ TCP/UDP

يحافظ URLTest على اختيارات منفصلة لـ TCP وUDP:

```go
selectedOutboundTCP adapter.Outbound
selectedOutboundUDP adapter.Outbound
```

هذا يسمح باختيار صادرات مختلفة لـ TCP وUDP بناءً على نتائج زمن الاستجابة الخاصة بكل منهما.

### خوارزمية الاختيار

```go
func (g *URLTestGroup) Select(network string) (adapter.Outbound, bool) {
    var minDelay uint16
    var minOutbound adapter.Outbound

    // البدء بالصادر المختار حالياً
    if g.selectedOutboundTCP != nil {
        if history := g.history.LoadURLTestHistory(RealTag(g.selectedOutboundTCP)); history != nil {
            minOutbound = g.selectedOutboundTCP
            minDelay = history.Delay
        }
    }

    // إيجاد صادر أفضل (يجب أن يتفوق على الحالي بالتحمل)
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

يمنع التحمل التبديل المتكرر: يجب أن يكون الصادر الجديد أسرع بما لا يقل عن `tolerance` مللي ثانية من الحالي.

### الفحص القائم على الخمول

تعمل فحوصات الصحة فقط عندما تكون المجموعة قيد الاستخدام النشط. تبدأ طريقة `Touch()` المؤقت عند أول استخدام:

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

تتوقف حلقة الفحص عند الوصول إلى مهلة الخمول:

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

### اختبار URL

يتم تشغيل الاختبارات بشكل متزامن بحد أقصى 10 اختبارات متزامنة:

```go
func (g *URLTestGroup) urlTest(ctx, force) (map[string]uint16, error) {
    if g.checking.Swap(true) {
        return result, nil  // الفحص جارٍ بالفعل
    }
    defer g.checking.Store(false)

    b, _ := batch.New(ctx, batch.WithConcurrencyNum[any](10))
    for _, detour := range g.outbounds {
        realTag := RealTag(detour)
        if checked[realTag] { continue }

        // تخطي إذا تم اختباره مؤخراً
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

للمجموعات المتداخلة، يحل `RealTag` عبر طبقات المجموعة:

```go
func RealTag(detour adapter.Outbound) string {
    if group, isGroup := detour.(adapter.OutboundGroup); isGroup {
        return group.Now()
    }
    return detour.Tag()
}
```

### فحص التحديث والمقاطعة

بعد الاختبار، يتم تحديث الصادر المختار ومقاطعة الاتصالات الحالية إذا تغير الاختيار:

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

## مجموعة المقاطعة

تدير `interrupt.Group` دورة حياة الاتصال لتغييرات المجموعة:

- عند تغيير اختيار المجموعة، يتم استدعاء `Interrupt()`
- يتم إغلاق جميع الاتصالات المغلفة بـ `interruptGroup.NewConn()`
- يتحكم `interruptExternalConnections` فيما إذا كان يتم مقاطعة الاتصالات من مصادر خارجية (لم تبدأها هذه العملية) أيضاً

تتبع الاتصالات الخارجية:

```go
func (s *URLTest) NewConnectionEx(ctx, conn, metadata, onClose) {
    ctx = interrupt.ContextWithIsExternalConnection(ctx)
    s.connection.NewConnection(ctx, s, conn, metadata, onClose)
}
```

## معالجة الأخطاء

عند فشل صادر مختار، يتم حذف سجله لفرض إعادة التقييم:

```go
conn, err := outbound.DialContext(ctx, network, destination)
if err == nil {
    return s.group.interruptGroup.NewConn(conn, ...), nil
}
s.logger.ErrorContext(ctx, err)
s.group.history.DeleteURLTestHistory(outbound.Tag())
return nil, err
```

## أمثلة على التكوين

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
