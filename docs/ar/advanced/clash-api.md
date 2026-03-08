# Clash API

يوفر Clash API واجهة HTTP RESTful متوافقة مع لوحات تحكم Clash (مثل Yacd و Metacubexd). يكشف عن إدارة الوكلاء، تتبع الاتصالات، إحصاءات حركة المرور، التهيئة، بث السجلات، وعمليات ذاكرة DNS المؤقتة.

**المصدر**: `experimental/clashapi/`

## التسجيل

يسجل خادم Clash API نفسه عبر دالة `init()`، محمية بعلامة البناء `with_clash_api`:

```go
// clashapi.go (with_clash_api build tag)
func init() {
    experimental.RegisterClashServerConstructor(NewServer)
}

// clashapi_stub.go (!with_clash_api build tag)
func init() {
    experimental.RegisterClashServerConstructor(func(...) (adapter.ClashServer, error) {
        return nil, E.New(`clash api is not included in this build, rebuild with -tags with_clash_api`)
    })
}
```

## هندسة الخادم

```go
type Server struct {
    ctx            context.Context
    router         adapter.Router
    dnsRouter      adapter.DNSRouter
    outbound       adapter.OutboundManager
    endpoint       adapter.EndpointManager
    logger         log.Logger
    httpServer     *http.Server
    trafficManager *trafficontrol.Manager
    urlTestHistory adapter.URLTestHistoryStorage

    mode           string
    modeList       []string
    modeUpdateHook *observable.Subscriber[struct{}]

    externalController       bool
    externalUI               string
    externalUIDownloadURL    string
    externalUIDownloadDetour string
}
```

### موجه HTTP (chi)

يستخدم الخادم `go-chi/chi` للتوجيه مع وسيط CORS:

```
GET  /              -> hello (أو إعادة توجيه إلى /ui/)
GET  /logs          -> بث السجلات عبر WebSocket/SSE
GET  /traffic       -> إحصاءات حركة المرور عبر WebSocket/SSE
GET  /version       -> {"version": "sing-box X.Y.Z", "premium": true, "meta": true}
     /configs       -> GET, PUT, PATCH التهيئة
     /proxies       -> GET قائمة, GET/PUT وكيل فردي, GET اختبار التأخير
     /rules         -> GET قواعد التوجيه
     /connections   -> GET قائمة, DELETE إغلاق الكل, DELETE إغلاق حسب المعرف
     /providers/proxies -> مزودو الوكلاء (بديل فارغ)
     /providers/rules   -> مزودو القواعد (بديل فارغ)
     /script        -> النص البرمجي (بديل فارغ)
     /profile       -> الملف الشخصي (بديل فارغ)
     /cache         -> عمليات الذاكرة المؤقتة
     /dns           -> عمليات DNS
     /ui/*          -> خادم ملفات ثابتة لواجهة المستخدم الخارجية
```

### المصادقة

مصادقة برمز Bearer عبر خيار التهيئة `secret`:

```go
func authentication(serverSecret string) func(next http.Handler) http.Handler {
    // يتحقق من ترويسة "Authorization: Bearer <token>"
    // اتصالات WebSocket يمكنها استخدام معامل الاستعلام ?token=<token>
    // إذا كان serverSecret فارغاً، يُسمح لجميع الطلبات
}
```

## تتبع الاتصالات

### مدير حركة المرور

```go
type Manager struct {
    uploadTotal   atomic.Int64
    downloadTotal atomic.Int64
    connections   compatible.Map[uuid.UUID, Tracker]

    closedConnectionsAccess sync.Mutex
    closedConnections       list.List[TrackerMetadata]  // بحد أقصى 1000
    memory                  uint64

    eventSubscriber *observable.Subscriber[ConnectionEvent]
}
```

يتتبع المدير:
- **إجماليات الرفع/التنزيل العامة** عبر عدادات ذرية
- **الاتصالات النشطة** في خريطة متزامنة مفتاحها UUID
- **الاتصالات المغلقة مؤخراً** في قائمة محدودة (بحد أقصى 1000 مدخل)
- **استخدام الذاكرة** عبر `runtime.ReadMemStats`

### تغليف المتتبع

عندما يُوجه اتصال، يغلفه خادم Clash بطبقة تتبع:

```go
func (s *Server) RoutedConnection(ctx, conn, metadata, matchedRule, matchOutbound) net.Conn {
    return trafficontrol.NewTCPTracker(conn, s.trafficManager, metadata, ...)
}
```

المتتبع:
1. يولد UUID v4 للاتصال
2. يحل سلسلة المنفذ الصادر (يتبع اختيارات المجموعة للعثور على المنفذ الصادر النهائي)
3. يغلف الاتصال بـ `bufio.NewCounterConn` لعد البايتات في كلا الاتجاهين
4. يسجل مع المدير عبر `manager.Join(tracker)`
5. عند الإغلاق، يستدعي `manager.Leave(tracker)` ويخزن البيانات الوصفية في قائمة الاتصالات المغلقة

### JSON لبيانات المتتبع الوصفية

يتم تسلسل بيانات الاتصال الوصفية لواجهة API:

```go
func (t TrackerMetadata) MarshalJSON() ([]byte, error) {
    return json.Marshal(map[string]any{
        "id": t.ID,
        "metadata": map[string]any{
            "network":         t.Metadata.Network,
            "type":            inbound,        // "inboundType/inboundTag"
            "sourceIP":        source.Addr,
            "destinationIP":   dest.Addr,
            "sourcePort":      source.Port,
            "destinationPort": dest.Port,
            "host":            domain,
            "dnsMode":         "normal",
            "processPath":     processPath,
        },
        "upload":   t.Upload.Load(),
        "download": t.Download.Load(),
        "start":    t.CreatedAt,
        "chains":   t.Chain,     // سلسلة المنفذ الصادر المعكوسة
        "rule":     rule,
        "rulePayload": "",
    })
}
```

## بث حركة المرور

نقطة النهاية `/traffic` تبث فروقات حركة المرور لكل ثانية عبر WebSocket أو HTTP مجزأ:

```go
func traffic(ctx, trafficManager) http.HandlerFunc {
    // كل ثانية واحدة:
    // 1. قراءة إجمالي الرفع/التنزيل الحالي
    // 2. حساب الفرق من القراءة السابقة
    // 3. إرسال JSON: {"up": delta_up, "down": delta_down}
}
```

## بث السجلات

نقطة النهاية `/logs` تبث مدخلات السجل مع تصفية المستوى:

```go
func getLogs(logFactory) http.HandlerFunc {
    // يقبل ?level=info|debug|warn|error
    // يشترك في مصنع السجل القابل للملاحظة
    // يبث JSON: {"type": "info", "payload": "log message"}
    // يدعم كلاً من WebSocket و HTTP المجزأ
}
```

## تبديل الوضع

ينفذ sing-box تبديل الوضع على غرار Clash (Rule، Global، Direct، إلخ):

```go
func (s *Server) SetMode(newMode string) {
    // 1. التحقق من أن الوضع موجود في modeList (بدون مراعاة حالة الأحرف)
    // 2. تحديث s.mode
    // 3. إطلاق خطاف تحديث الوضع (يُخطر المشتركين)
    // 4. مسح ذاكرة DNS المؤقتة
    // 5. الحفظ في ملف الذاكرة المؤقتة
    // 6. تسجيل التغيير
}
```

الأوضاع تُحفظ في ملف ذاكرة bbolt المؤقتة تحت دلو `clash_mode`، مفتاحه معرف الذاكرة المؤقتة.

## إدارة الوكلاء

### GET /proxies

يُرجع جميع المنافذ الصادرة ونقاط النهاية مع بياناتها الوصفية:

```go
func proxyInfo(server, detour) *badjson.JSONObject {
    // type:    اسم العرض في Clash (مثل "Shadowsocks", "VMess")
    // name:    وسم المنفذ الصادر
    // udp:     ما إذا كان UDP مدعوماً
    // history: سجل تأخير اختبار URL
    // now:     الاختيار الحالي (للمجموعات)
    // all:     الأعضاء المتاحون (للمجموعات)
}
```

مجموعة وكلاء اصطناعية `GLOBAL` تُضاف دائماً، تحتوي على جميع المنافذ الصادرة غير النظامية مع المنفذ الصادر الافتراضي مدرجاً أولاً.

### PUT /proxies/{name}

يحدث المنفذ الصادر المختار لمجموعات `Selector`:

```go
func updateProxy(w, r) {
    selector, ok := proxy.(*group.Selector)
    selector.SelectOutbound(req.Name)
}
```

### GET /proxies/{name}/delay

ينفذ اختبار URL مع مهلة قابلة للتهيئة:

```go
func getProxyDelay(server) http.HandlerFunc {
    // يقرأ معاملات الاستعلام ?url=...&timeout=...
    // يستدعي urltest.URLTest(ctx, url, proxy)
    // يُرجع {"delay": ms} أو خطأ
    // يخزن النتيجة في سجل اختبار URL
}
```

## واجهة المزود

مزودو الوكلاء (`/providers/proxies`) ومزودو القواعد (`/providers/rules`) هم بدائل فارغة -- يُرجعون نتائج فارغة أو 404. هذا يحافظ على توافق API مع لوحات تحكم Clash التي تتوقع وجود نقاط النهاية هذه.

## واجهة اللقطة

نقطة النهاية `/connections` تُرجع لقطة لجميع الاتصالات النشطة:

```go
type Snapshot struct {
    Download    int64
    Upload      int64
    Connections []Tracker
    Memory      uint64    // من runtime.MemStats
}
```

نقطة نهاية اللقطة تدعم أيضاً WebSocket للتحديثات الفورية مع فترة استطلاع قابلة للتهيئة (`?interval=1000` بالمللي ثانية).

## التهيئة

```json
{
  "experimental": {
    "clash_api": {
      "external_controller": "127.0.0.1:9090",
      "external_ui": "ui",
      "external_ui_download_url": "",
      "external_ui_download_detour": "",
      "secret": "my-secret",
      "default_mode": "Rule",
      "access_control_allow_origin": ["*"],
      "access_control_allow_private_network": false
    }
  }
}
```

## دورة حياة البدء

يبدأ الخادم على مرحلتين:

1. **`StartStateStart`**: يحمل الوضع المحفوظ من ملف الذاكرة المؤقتة
2. **`StartStateStarted`**: ينزل واجهة المستخدم الخارجية إذا لزم الأمر، ويبدأ مستمع HTTP (مع منطق إعادة المحاولة لخطأ `EADDRINUSE` على Android)

## ملاحظات إعادة التنفيذ

1. واجهة API مصممة للتوافق مع لوحات تحكم Clash (Yacd، Metacubexd). تنسيق الاستجابة يجب أن يطابق تماماً ما تتوقعه هذه اللوحات
2. دعم WebSocket ضروري -- حركة المرور والسجلات والاتصالات جميعها تستخدم WebSocket للبث الفوري
3. علامات استجابة الإصدار `"premium": true, "meta": true` تمكّن ميزات إضافية في لوحات التحكم
4. تتبع الاتصالات يغلف كل اتصال/اتصال حزم موجه، مضيفاً عدادات بايت لكل اتصال
5. قائمة الاتصالات المغلقة محدودة بـ 1000 مدخل (إزالة FIFO)
6. إحصاءات الذاكرة تأتي من `runtime.ReadMemStats` التي تشمل المكدس، الكومة المستخدمة، والكومة الخاملة
7. عمليات DNS ومسح الذاكرة المؤقتة مكشوفة عبر مسارات `/dns` و `/cache`
