# ملف الذاكرة المؤقتة

يوفر ملف الذاكرة المؤقتة تخزيناً دائماً لحالات وقت التشغيل المختلفة باستخدام قاعدة بيانات bbolt (شجرة B+ مدمجة). يحفظ تعيينات FakeIP، واختيارات المنفذ الصادر المحددة، ووضع Clash، ومحتويات مجموعات القواعد البعيدة، وذاكرة استجابات DNS المرفوضة المؤقتة (RDRC).

**المصدر**: `experimental/cachefile/`

## الهندسة

```go
type CacheFile struct {
    ctx               context.Context
    path              string
    cacheID           []byte           // بادئة مساحة اسم اختيارية
    storeFakeIP       bool
    storeRDRC         bool
    rdrcTimeout       time.Duration    // الافتراضي: 7 أيام
    DB                *bbolt.DB

    // مخازن الكتابة غير المتزامنة
    saveMetadataTimer *time.Timer
    saveFakeIPAccess  sync.RWMutex
    saveDomain        map[netip.Addr]string
    saveAddress4      map[string]netip.Addr
    saveAddress6      map[string]netip.Addr
    saveRDRCAccess    sync.RWMutex
    saveRDRC          map[saveRDRCCacheKey]bool
}
```

## هيكل الدلاء

تستخدم قاعدة البيانات عدة دلاء على المستوى الأعلى:

| اسم الدلو | المفتاح | الوصف |
|-------------|---------|-------------|
| `selected` | وسم المجموعة | المنفذ الصادر المحدد لمجموعات Selector |
| `group_expand` | وسم المجموعة | حالة التوسيع/الطي في واجهة المستخدم |
| `clash_mode` | معرف الذاكرة المؤقتة | وضع Clash API الحالي |
| `rule_set` | وسم مجموعة القواعد | محتوى مجموعة القواعد البعيدة المخزن مؤقتاً |
| `rdrc2` | اسم النقل (دلو فرعي) | ذاكرة استجابات DNS المرفوضة المؤقتة |
| `fakeip_address` | بايتات IP | تعيين عنوان FakeIP إلى نطاق |
| `fakeip_domain4` | نص النطاق | تعيين نطاق FakeIP إلى IPv4 |
| `fakeip_domain6` | نص النطاق | تعيين نطاق FakeIP إلى IPv6 |
| `fakeip_metadata` | مفتاح ثابت | حالة مخصص FakeIP |

### فضاء أسماء معرف الذاكرة المؤقتة

عند تهيئة `cache_id`، تُدمج معظم الدلاء تحت دلو أعلى مستوى مسبوق بمعرف الذاكرة المؤقتة (بايت `0x00` + بايتات معرف الذاكرة المؤقتة). هذا يسمح لعدة نسخ من sing-box بمشاركة نفس ملف قاعدة البيانات:

```go
func (c *CacheFile) bucket(t *bbolt.Tx, key []byte) *bbolt.Bucket {
    if c.cacheID == nil {
        return t.Bucket(key)
    }
    bucket := t.Bucket(c.cacheID)  // دلو مساحة الاسم
    if bucket == nil {
        return nil
    }
    return bucket.Bucket(key)  // الدلو الفعلي داخل مساحة الاسم
}
```

## البدء والاسترداد

```go
func (c *CacheFile) Start(stage adapter.StartStage) error {
    // يعمل فقط في StartStateInitialize
    // 1. فتح bbolt بمهلة ثانية واحدة، إعادة المحاولة حتى 10 مرات
    // 2. عند التلف (ErrInvalid, ErrChecksum, ErrVersionMismatch):
    //    حذف الملف وإعادة المحاولة
    // 3. تنظيف الدلاء غير المعروفة (جمع القمامة)
    // 4. تعيين ملكية الملف عبر chown المنصة
}
```

قاعدة البيانات لديها آلية إصلاح ذاتي -- إذا اكتشفت تلفاً أثناء الوصول، تحذف الملف وتعيد إنشاءه:

```go
func (c *CacheFile) resetDB() {
    c.DB.Close()
    os.Remove(c.path)
    db, err := bbolt.Open(c.path, 0o666, ...)
    if err == nil {
        c.DB = db
    }
}
```

جميع طرق الوصول لقاعدة البيانات (`view`، `batch`، `update`) تغلف العمليات باسترداد panic الذي يطلق `resetDB()` عند التلف.

## ذاكرة المنفذ الصادر المحدد المؤقتة

تحفظ اختيارات المستخدم لمجموعات المنافذ الصادرة من نوع Selector:

```go
func (c *CacheFile) LoadSelected(group string) string
func (c *CacheFile) StoreSelected(group, selected string) error
```

تُستخدم بواسطة مجموعة المنفذ الصادر Selector لتذكر أي منفذ صادر اختاره المستخدم عبر عمليات إعادة التشغيل.

## ذاكرة وضع Clash المؤقتة

```go
func (c *CacheFile) LoadMode() string
func (c *CacheFile) StoreMode(mode string) error
```

تحفظ وضع Clash API الحالي ("Rule"، "Global"، "Direct") ليبقى عبر عمليات إعادة التشغيل.

## ذاكرة مجموعة القواعد المؤقتة

مجموعات القواعد البعيدة تُخزن مؤقتاً مع محتواها ووقت آخر تحديث و ETag HTTP:

```go
func (c *CacheFile) LoadRuleSet(tag string) *adapter.SavedBinary
func (c *CacheFile) SaveRuleSet(tag string, set *adapter.SavedBinary) error
```

هيكل `SavedBinary` يحتوي:
- `Content []byte` -- بيانات مجموعة القواعد الخام (JSON أو SRS ثنائي)
- `LastUpdated time.Time` -- وقت آخر جلب ناجح
- `LastEtag string` -- ETag HTTP للطلبات المشروطة

## ذاكرة FakeIP المؤقتة

يحافظ FakeIP على تعيينات ثنائية الاتجاه بين عناوين IP المزيفة وأسماء النطاقات.

### تخطيط التخزين

ثلاثة دلاء تعمل معاً:
- `fakeip_address`: `بايتات IP -> نص النطاق` (بحث عكسي)
- `fakeip_domain4`: `النطاق -> بايتات IPv4` (بحث أمامي، IPv4)
- `fakeip_domain6`: `النطاق -> بايتات IPv6` (بحث أمامي، IPv6)

### عمليات الكتابة

```go
func (c *CacheFile) FakeIPStore(address netip.Addr, domain string) error {
    // 1. قراءة النطاق القديم لهذا العنوان (إن وجد)
    // 2. تخزين العنوان -> النطاق
    // 3. حذف تعيين النطاق القديم -> العنوان
    // 4. تخزين تعيين النطاق الجديد -> العنوان
}
```

### تحسين الكتابة غير المتزامنة

كتابات FakeIP حرجة الأداء، لذا يُوفر طبقة تخزين مؤقت غير متزامنة:

```go
func (c *CacheFile) FakeIPStoreAsync(address netip.Addr, domain string, logger) {
    // 1. تخزين التعيين في خرائط الذاكرة
    // 2. إطلاق goroutine للحفظ في bbolt
    // 3. عمليات القراءة تتحقق من مخزن الذاكرة أولاً
}
```

المخزن المؤقت في الذاكرة (`saveDomain`، `saveAddress4`، `saveAddress6`) يُفحص بواسطة `FakeIPLoad` و `FakeIPLoadDomain` قبل الرجوع إلى قاعدة البيانات، مما يضمن الاتساق أثناء الكتابة غير المتزامنة.

### حفظ البيانات الوصفية

البيانات الوصفية لمخصص FakeIP (مؤشر التخصيص الحالي) تُحفظ بمؤقت تأخير:

```go
func (c *CacheFile) FakeIPSaveMetadataAsync(metadata *adapter.FakeIPMetadata) {
    // يستخدم time.AfterFunc مع FakeIPMetadataSaveInterval
    // يعيد تعيين المؤقت عند كل استدعاء لتجميع التخصيصات السريعة
}
```

## RDRC (ذاكرة استجابات DNS المرفوضة المؤقتة)

تخزن RDRC استجابات DNS التي تم رفضها (مثل الاستجابات الفارغة أو المحجوبة)، لتجنب عمليات البحث المتكررة للنطاقات المعروفة بالحجب.

### مفتاح التخزين

```go
type saveRDRCCacheKey struct {
    TransportName string
    QuestionName  string
    QType         uint16
}
```

في قاعدة البيانات، المفتاح هو `[uint16 big-endian: qtype][نص النطاق]`، متداخل تحت دلو فرعي مسمى بناقل DNS.

### انتهاء الصلاحية

كل مدخل RDRC يخزن طابع زمني لانتهاء الصلاحية:

```go
func (c *CacheFile) LoadRDRC(transportName, qName string, qType uint16) (rejected bool) {
    // 1. التحقق من مخزن الذاكرة المؤقت غير المتزامن أولاً
    // 2. القراءة من قاعدة البيانات
    // 3. تحليل طابع انتهاء الصلاحية (uint64 big-endian ثواني Unix)
    // 4. إذا انتهت الصلاحية، حذف المدخل وإرجاع false
    // 5. إذا صالح، إرجاع true (النطاق مرفوض)
}

func (c *CacheFile) SaveRDRC(transportName, qName string, qType uint16) error {
    // تخزين مع انتهاء صلاحية = الآن + rdrcTimeout (الافتراضي 7 أيام)
    // المفتاح: [2 بايت qtype][بايتات النطاق]
    // القيمة: [8 بايت طابع زمني انتهاء الصلاحية Unix big-endian]
}
```

### كتابات RDRC غير المتزامنة

مثل FakeIP، كتابات RDRC مخزنة مؤقتاً في الذاكرة للقراءة الفورية:

```go
func (c *CacheFile) SaveRDRCAsync(transportName, qName string, qType uint16, logger) {
    // تخزين مؤقت في خريطة saveRDRC
    // الحفظ بشكل غير متزامن في goroutine
}
```

## التهيئة

```json
{
  "experimental": {
    "cache_file": {
      "enabled": true,
      "path": "cache.db",
      "cache_id": "my-instance",
      "store_fakeip": true,
      "store_rdrc": true,
      "rdrc_timeout": "168h"
    }
  }
}
```

## ملاحظات إعادة التنفيذ

1. **bbolt** هي قاعدة بيانات شجرة B+ مدمجة بلغة Go خالصة (فرع من boltdb). أي مخزن مفتاح-قيمة مدمج يدعم الدلاء/مساحات الأسماء يمكن أن يعمل كبديل (مثل SQLite، LevelDB)
2. **استرداد التلف** أمر حيوي -- قد يتلف ملف الذاكرة المؤقتة بسبب الأعطال أو انقطاع التيار. استراتيجية الحذف وإعادة الإنشاء بسيطة لكنها فعالة
3. **التخزين المؤقت للكتابة غير المتزامنة** مهم لأداء FakeIP و RDRC. هذه العمليات تحدث عند كل استعلام DNS ويجب ألا تعرقل المسار الحرج
4. **فضاء أسماء معرف الذاكرة المؤقتة** يسمح لعدة نسخ بمشاركة ملف قاعدة بيانات واحد بدون تعارضات
5. **تعيين FakeIP ثنائي الاتجاه** يجب أن يبقى متسقاً -- عند تحديث تعيين عنوان، يجب حذف تعيين النطاق القديم أولاً
6. **مهلة RDRC** تتحكم في مدة تخزين استجابات DNS المرفوضة مؤقتاً. الافتراضي 7 أيام مناسب لمجموعات قواعد حجب الإعلانات التي لا تتغير بشكل متكرر
7. دلو `group_expand` يخزن بايتاً واحداً (`0` أو `1`) لحالة واجهة المستخدم في لوحات تحكم Clash -- هذا حفظ حالة تجميلي بحت
