# مجموعات القواعد

توفر مجموعات القواعد مجموعات قابلة لإعادة الاستخدام من قواعد التوجيه التي يمكن تحميلها من تعريفات مضمنة أو ملفات محلية أو عناوين URL بعيدة. وهي البديل الحديث لقواعد بيانات GeoIP/GeoSite القديمة.

**المصدر**: `common/srs/`، `route/rule/rule_set.go`، `route/rule/rule_set_local.go`، `route/rule/rule_set_remote.go`، `option/rule_set.go`

## تنسيق SRS الثنائي

تنسيق SRS (مجموعة قواعد Sing-box) هو تمثيل ثنائي مضغوط لمجموعات القواعد، مصمم للتحميل الفعال وتقليل حجم الملف مقارنة بملفات JSON المصدرية.

### هيكل الملف

```
+--------+--------+------------------------------+
| Magic  | Version| zlib-compressed rule data    |
| 3 bytes| 1 byte |                              |
+--------+--------+------------------------------+
```

```go
var MagicBytes = [3]byte{0x53, 0x52, 0x53} // ASCII "SRS"
```

### سجل الإصدارات

| الإصدار | الثابت | الميزات الجديدة |
|---------|----------|-------------|
| 1 | `RuleSetVersion1` | التنسيق الأولي |
| 2 | `RuleSetVersion2` | قواعد نطاقات AdGuard |
| 3 | `RuleSetVersion3` | `network_type`، `network_is_expensive`، `network_is_constrained` |
| 4 | `RuleSetVersion4` | `network_interface_address`، `default_interface_address` |

### عملية القراءة

```go
func Read(reader io.Reader, recover bool) (PlainRuleSetCompat, error) {
    // 1. قراءة والتحقق من ترويسة السحر المكونة من 3 بايت "SRS"
    // 2. قراءة رقم الإصدار بحجم 1 بايت (big-endian uint8)
    // 3. فتح قارئ فك ضغط zlib
    // 4. قراءة uvarint لعدد القواعد
    // 5. قراءة كل قاعدة بالتسلسل
}
```

علم `recover` يتحكم فيما إذا كانت الهياكل المحسّنة للتنسيق الثنائي (مثل مطابقات النطاقات ومجموعات IP) يتم توسيعها مرة أخرى إلى أشكالها القابلة للقراءة البشرية (قوائم نصية). يُستخدم هذا عند تحويل `.srs` مرة أخرى إلى JSON.

### تخطيط البيانات المضغوطة

بعد الترويسة المكونة من 4 بايت، جميع البيانات اللاحقة مضغوطة بـ zlib (أفضل مستوى ضغط). داخل التدفق المفكوك:

```
[uvarint: rule_count]
[rule_0]
[rule_1]
...
[rule_N]
```

### ترميز القواعد

كل قاعدة تبدأ ببايت نوع `uint8`:

| بايت النوع | المعنى |
|-----------|---------|
| `0` | قاعدة افتراضية (شروط مسطحة) |
| `1` | قاعدة منطقية (AND/OR من قواعد فرعية) |

#### عناصر القاعدة الافتراضية

القاعدة الافتراضية هي تسلسل من العناصر المنوعة المنتهية بـ `0xFF`:

```
[uint8: 0x00 (default rule)]
[uint8: item_type] [item_data...]
[uint8: item_type] [item_data...]
...
[uint8: 0xFF (final)]
[bool: invert]
```

ثوابت أنواع العناصر:

```go
const (
    ruleItemQueryType              uint8 = 0   // []uint16 (big-endian)
    ruleItemNetwork                uint8 = 1   // []string
    ruleItemDomain                 uint8 = 2   // domain.Matcher binary
    ruleItemDomainKeyword          uint8 = 3   // []string
    ruleItemDomainRegex            uint8 = 4   // []string
    ruleItemSourceIPCIDR           uint8 = 5   // IPSet binary
    ruleItemIPCIDR                 uint8 = 6   // IPSet binary
    ruleItemSourcePort             uint8 = 7   // []uint16 (big-endian)
    ruleItemSourcePortRange        uint8 = 8   // []string
    ruleItemPort                   uint8 = 9   // []uint16 (big-endian)
    ruleItemPortRange              uint8 = 10  // []string
    ruleItemProcessName            uint8 = 11  // []string
    ruleItemProcessPath            uint8 = 12  // []string
    ruleItemPackageName            uint8 = 13  // []string
    ruleItemWIFISSID               uint8 = 14  // []string
    ruleItemWIFIBSSID              uint8 = 15  // []string
    ruleItemAdGuardDomain          uint8 = 16  // AdGuardMatcher binary (v2+)
    ruleItemProcessPathRegex       uint8 = 17  // []string
    ruleItemNetworkType            uint8 = 18  // []uint8 (v3+)
    ruleItemNetworkIsExpensive     uint8 = 19  // no data (v3+)
    ruleItemNetworkIsConstrained   uint8 = 20  // no data (v3+)
    ruleItemNetworkInterfaceAddress uint8 = 21 // TypedMap (v4+)
    ruleItemDefaultInterfaceAddress uint8 = 22 // []Prefix (v4+)
    ruleItemFinal                  uint8 = 0xFF
)
```

#### ترميز مصفوفة النصوص

```
[uvarint: count]
  [uvarint: string_length] [bytes: string_data]
  ...
```

#### ترميز مصفوفة uint16

```
[uvarint: count]
[uint16 big-endian] [uint16 big-endian] ...
```

#### ترميز مجموعة IP

مجموعات IP تُخزن كنطاقات بدلاً من بادئات CIDR لتحقيق الاختصار:

```
[uint8: version (must be 1)]
[uint64 big-endian: range_count]
  [uvarint: from_addr_length] [bytes: from_addr]
  [uvarint: to_addr_length]   [bytes: to_addr]
  ...
```

يستخدم التطبيق `unsafe.Pointer` لإعادة تفسير البنية الداخلية لـ `netipx.IPSet` مباشرة (والتي تخزن نطاقات IP كأزواج `{from, to}`). عناوين IPv4 تتكون من 4 بايت؛ وعناوين IPv6 من 16 بايت.

#### ترميز بادئة IP

البادئات الفردية (تُستخدم في قواعد عنوان واجهة الشبكة في الإصدار 4+):

```
[uvarint: addr_byte_length]
[bytes: addr_bytes]
[uint8: prefix_bits]
```

#### ترميز القاعدة المنطقية

```
[uint8: 0x01 (logical rule)]
[uint8: mode]  // 0 = AND, 1 = OR
[uvarint: sub_rule_count]
[sub_rule_0]
[sub_rule_1]
...
[bool: invert]
```

## أنواع مجموعات القواعد

### دالة المصنع

```go
func NewRuleSet(ctx, logger, options) (adapter.RuleSet, error) {
    switch options.Type {
    case "inline", "local", "":
        return NewLocalRuleSet(ctx, logger, options)
    case "remote":
        return NewRemoteRuleSet(ctx, logger, options), nil
    }
}
```

### مجموعة القواعد المحلية

`LocalRuleSet` يتعامل مع كل من القواعد المضمنة (المدمجة في JSON التهيئة) ومجموعات القواعد المعتمدة على الملفات.

```go
type LocalRuleSet struct {
    ctx        context.Context
    logger     logger.Logger
    tag        string
    access     sync.RWMutex
    rules      []adapter.HeadlessRule
    metadata   adapter.RuleSetMetadata
    fileFormat string              // "source" (JSON) or "binary" (SRS)
    watcher    *fswatch.Watcher    // file change watcher
    callbacks  list.List[adapter.RuleSetUpdateCallback]
    refs       atomic.Int32        // reference counting
}
```

السلوكيات الرئيسية:
- **وضع المضمن**: تُحلل القواعد من `options.InlineOptions.Rules` عند الإنشاء
- **وضع الملف**: تُحمل القواعد من `options.LocalOptions.Path` ويُنشأ `fswatch.Watcher` لإعادة التحميل التلقائي عند تغيير الملف
- **الكشف التلقائي عن التنسيق**: امتداد الملف `.json` يختار تنسيق المصدر؛ و `.srs` يختار التنسيق الثنائي
- **إعادة التحميل الفوري**: عندما يكتشف المراقب تغييرات، يقوم `reloadFile()` بإعادة قراءة وتحليل الملف، ثم يُخطر جميع عمليات الاستدعاء المسجلة

### مجموعة القواعد البعيدة

`RemoteRuleSet` يقوم بتنزيل مجموعات القواعد من عنوان URL مع تحديث تلقائي دوري.

```go
type RemoteRuleSet struct {
    ctx            context.Context
    cancel         context.CancelFunc
    logger         logger.ContextLogger
    outbound       adapter.OutboundManager
    options        option.RuleSet
    updateInterval time.Duration    // default: 24 hours
    dialer         N.Dialer
    access         sync.RWMutex
    rules          []adapter.HeadlessRule
    metadata       adapter.RuleSetMetadata
    lastUpdated    time.Time
    lastEtag       string           // HTTP ETag for conditional requests
    updateTicker   *time.Ticker
    cacheFile      adapter.CacheFile
    pauseManager   pause.Manager
    callbacks      list.List[adapter.RuleSetUpdateCallback]
    refs           atomic.Int32
}
```

السلوكيات الرئيسية:
- **استمرارية الذاكرة المؤقتة**: عند بدء التشغيل، يحمل المحتوى المخزن مؤقتاً من `adapter.CacheFile` (قاعدة بيانات bbolt). إذا كانت البيانات المخزنة موجودة، يستخدمها فوراً بدلاً من التنزيل
- **دعم ETag**: يستخدم `If-None-Match` / `304 Not Modified` في HTTP لتجنب إعادة تنزيل مجموعات القواعد غير المتغيرة
- **تحويل مسار التنزيل**: يمكن توجيه حركة التنزيل عبر منفذ صادر محدد (مثلاً لاستخدام وكيل لجلب مجموعات القواعد)
- **حلقة التحديث**: بعد `PostStart()`، يشغل `loopUpdate()` في goroutine يتحقق من التحديثات عند كل `updateInterval`
- **إدارة الذاكرة**: بعد التحديث، إذا كان `refs == 0` (لا توجد مراجع قواعد نشطة)، تُعيّن القواعد المحللة إلى `nil` لتحرير الذاكرة، مع استدعاء `runtime.GC()` صراحة

## عدّ المراجع

كل من `LocalRuleSet` و `RemoteRuleSet` ينفذان عدّ المراجع عبر `atomic.Int32`:

```go
func (s *LocalRuleSet) IncRef()  { s.refs.Add(1) }
func (s *LocalRuleSet) DecRef()  {
    if s.refs.Add(-1) < 0 {
        panic("rule-set: negative refs")
    }
}
func (s *LocalRuleSet) Cleanup() {
    if s.refs.Load() == 0 {
        s.rules = nil  // تحرير الذاكرة عند عدم وجود مراجع
    }
}
```

يسمح هذا للموجه بتتبع مجموعات القواعد المستخدمة فعلياً بواسطة قواعد التوجيه وتحرير الذاكرة للمجموعات غير المستخدمة.

## بيانات وصفية لمجموعة القواعد

بعد تحميل القواعد، تُحسب البيانات الوصفية لتحديد أنواع البحث المطلوبة:

```go
type RuleSetMetadata struct {
    ContainsProcessRule bool  // يحتاج باحث العمليات
    ContainsWIFIRule    bool  // يحتاج حالة WIFI
    ContainsIPCIDRRule  bool  // يحتاج عناوين IP المحللة
}
```

تسمح هذه العلامات للموجه بتخطي العمليات المكلفة (مثل البحث عن اسم العملية أو تحليل DNS) عندما لا تتطلبها أي مجموعة قواعد.

## استخراج مجموعة IP

تدعم مجموعات القواعد استخراج جميع عناصر IP CIDR إلى قيم `netipx.IPSet` عبر `ExtractIPSet()`. يُستخدم هذا لتحسينات على مستوى النظام مثل تهيئة جدول توجيه TUN، حيث تحتاج القواعد المعتمدة على IP إلى التطبيق على مستوى مكدس الشبكة بدلاً من كل اتصال على حدة.

## التهيئة

```json
{
  "route": {
    "rule_set": [
      {
        "type": "local",
        "tag": "geoip-cn",
        "format": "binary",
        "path": "geoip-cn.srs"
      },
      {
        "type": "remote",
        "tag": "geosite-category-ads",
        "format": "binary",
        "url": "https://example.com/geosite-category-ads.srs",
        "download_detour": "proxy",
        "update_interval": "24h"
      },
      {
        "tag": "my-rules",
        "rules": [
          {
            "domain_suffix": [".example.com"]
          }
        ]
      }
    ]
  }
}
```

## ملاحظات إعادة التنفيذ

1. تنسيق SRS الثنائي يستخدم `encoding/binary` في Go مع ترتيب بايت big-endian و `binary.ReadUvarint`/`varbin.WriteUvarint` للأعداد الصحيحة متغيرة الطول
2. مطابقة النطاقات تستخدم `sing/common/domain.Matcher` الذي لديه تنسيق تسلسل ثنائي خاص -- هذا تبعية يجب عليك تنفيذها أو استيرادها
3. تنسيق مجموعة IP الثنائي يستخدم `unsafe.Pointer` للتعامل المباشر مع الهيكل الداخلي لـ `netipx.IPSet` -- يجب أن تستخدم إعادة التنفيذ تسلسل نطاقات IP المناسب بدلاً من ذلك
4. ضغط zlib يستخدم مستوى `zlib.BestCompression` للكتابة
5. الكشف التلقائي عن التنسيق يتحقق من امتدادات الملفات: `.json` = مصدر، `.srs` = ثنائي
6. التخزين المؤقت المبني على ETag لمجموعات القواعد البعيدة يجب أن يتعامل مع كل من `200 OK` (محتوى جديد) و `304 Not Modified` (تحديث الطابع الزمني فقط)
