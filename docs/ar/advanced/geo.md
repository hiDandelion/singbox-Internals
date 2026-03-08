# قواعد بيانات GeoIP و GeoSite

يدعم sing-box تنسيقين قديمين لقواعد البيانات الجغرافية للتوجيه المعتمد على IP والنطاق: GeoIP (تنسيق MaxMind MMDB) و GeoSite (تنسيق ثنائي مخصص). يتم استبدال هذه التنسيقات بنظام مجموعات القواعد الأحدث لكنها تبقى مدعومة للتوافق مع الإصدارات السابقة.

**المصدر**: `common/geoip/`، `common/geosite/`، `option/route.go`

## GeoIP (MaxMind MMDB)

### نظرة عامة

يستخدم GeoIP قاعدة بيانات MaxMind MMDB معدّلة بمعرف نوع القاعدة `sing-geoip` (وليس `GeoLite2-Country` القياسي من MaxMind). هذه قاعدة بيانات مبنية خصيصاً تربط عناوين IP مباشرة برموز الدول.

### تطبيق القارئ

```go
type Reader struct {
    reader *maxminddb.Reader
}

func Open(path string) (*Reader, []string, error) {
    database, err := maxminddb.Open(path)
    if err != nil {
        return nil, nil, err
    }
    if database.Metadata.DatabaseType != "sing-geoip" {
        database.Close()
        return nil, nil, E.New("incorrect database type, expected sing-geoip, got ",
            database.Metadata.DatabaseType)
    }
    return &Reader{database}, database.Metadata.Languages, nil
}
```

النقاط الرئيسية:
- **التحقق من نوع القاعدة**: يقبل فقط قواعد البيانات ذات النوع `sing-geoip`، ويرفض قواعد بيانات MaxMind القياسية
- **رموز اللغات**: يُرجع قائمة رموز الدول المتاحة عبر `database.Metadata.Languages`
- **البحث**: يربط `netip.Addr` مباشرة بنص رمز الدولة؛ يُرجع `"unknown"` إذا لم يُعثر عليه

```go
func (r *Reader) Lookup(addr netip.Addr) string {
    var code string
    _ = r.reader.Lookup(addr.AsSlice(), &code)
    if code != "" {
        return code
    }
    return "unknown"
}
```

### تنسيق MMDB

تنسيق MMDB هو بنية شجرة ثنائية (trie) مصممة للبحث الفعال عن بادئات IP. مكتبة `maxminddb-golang` تتولى التحليل. بالنسبة لمتغير `sing-geoip`:
- قسم البيانات يخزن قيم نصية بسيطة (رموز الدول) بدلاً من هياكل متداخلة
- قسم البيانات الوصفية يستخدم `Languages` لتخزين قائمة رموز الدول المتاحة
- عناوين IPv4 و IPv6 مدعومة عبر بنية الشجرة

### التهيئة

```json
{
  "route": {
    "geoip": {
      "path": "geoip.db",
      "download_url": "https://github.com/SagerNet/sing-geoip/releases/latest/download/geoip.db",
      "download_detour": "proxy"
    }
  }
}
```

## GeoSite (تنسيق ثنائي مخصص)

### نظرة عامة

GeoSite هو تنسيق قاعدة بيانات ثنائي مخصص يربط رموز الفئات (مثل `google`، `category-ads-all`) بقوائم قواعد النطاقات. كل قاعدة نطاق لها نوع (مطابقة تامة، لاحقة، كلمة مفتاحية، تعبير نمطي) وقيمة.

### هيكل الملف

```
[uint8: version (0)]
[uvarint: entry_count]
  [uvarint: code_length] [bytes: code_string]
  [uvarint: byte_offset]
  [uvarint: item_count]
  ...
[domain items data...]
```

الملف يتكون من قسمين:
1. **قسم البيانات الوصفية**: فهرس يربط رموز الفئات بإزاحات البايت وعدد العناصر
2. **قسم البيانات**: عناصر النطاقات الفعلية، مخزنة بشكل متسلسل

### أنواع العناصر

```go
type ItemType = uint8

const (
    RuleTypeDomain        ItemType = 0  // مطابقة نطاق تامة
    RuleTypeDomainSuffix  ItemType = 1  // مطابقة لاحقة النطاق (مثل ".google.com")
    RuleTypeDomainKeyword ItemType = 2  // النطاق يحتوي على كلمة مفتاحية
    RuleTypeDomainRegex   ItemType = 3  // مطابقة تعبير نمطي
)

type Item struct {
    Type  ItemType
    Value string
}
```

### تطبيق القارئ

```go
type Reader struct {
    access         sync.Mutex
    reader         io.ReadSeeker
    bufferedReader *bufio.Reader
    metadataIndex  int64           // إزاحة البايت حيث يبدأ قسم البيانات
    domainIndex    map[string]int  // الرمز -> إزاحة البايت في قسم البيانات
    domainLength   map[string]int  // الرمز -> عدد العناصر
}
```

يعمل القارئ على مرحلتين:
1. **`readMetadata()`**: يقرأ الفهرس بالكامل عند الفتح، وينشئ خرائط من الرمز إلى الإزاحة/الطول
2. **`Read(code)`**: ينتقل إلى إزاحة الرمز في قسم البيانات ويقرأ العناصر عند الطلب

```go
func (r *Reader) Read(code string) ([]Item, error) {
    index, exists := r.domainIndex[code]
    if !exists {
        return nil, E.New("code ", code, " not exists!")
    }
    _, err := r.reader.Seek(r.metadataIndex+int64(index), io.SeekStart)
    // ... قراءة العناصر
}
```

كل عنصر في قسم البيانات مخزن كـ:
```
[uint8: item_type]
[uvarint: value_length] [bytes: value_string]
```

### تطبيق الكاتب

يبني الكاتب قسم البيانات في الذاكرة أولاً لحساب الإزاحات:

```go
func Write(writer varbin.Writer, domains map[string][]Item) error {
    // 1. ترتيب الرموز أبجدياً
    // 2. كتابة جميع العناصر في مخزن مؤقت، مع تسجيل إزاحات البايت لكل رمز
    // 3. كتابة بايت الإصدار (0)
    // 4. كتابة عدد المدخلات
    // 5. لكل رمز: كتابة نص الرمز، إزاحة البايت، عدد العناصر
    // 6. كتابة بيانات العناصر المخزنة مؤقتاً
}
```

### التجميع إلى قواعد

يتم تجميع عناصر GeoSite إلى خيارات قواعد sing-box:

```go
func Compile(code []Item) option.DefaultRule {
    // يربط كل ItemType بحقل القاعدة المقابل:
    //   RuleTypeDomain        -> rule.Domain
    //   RuleTypeDomainSuffix  -> rule.DomainSuffix
    //   RuleTypeDomainKeyword -> rule.DomainKeyword
    //   RuleTypeDomainRegex   -> rule.DomainRegex
}
```

يمكن دمج عدة قواعد مجمّعة باستخدام `Merge()`، الذي يسلسل جميع قوائم النطاقات.

### التهيئة

```json
{
  "route": {
    "geosite": {
      "path": "geosite.db",
      "download_url": "https://github.com/SagerNet/sing-geosite/releases/latest/download/geosite.db",
      "download_detour": "proxy"
    }
  }
}
```

## كيف تُستخدم في القواعد

في قواعد التوجيه، تُستخدم مراجع GeoIP و GeoSite كالتالي:

```json
{
  "route": {
    "rules": [
      {
        "geoip": ["cn", "private"],
        "outbound": "direct"
      },
      {
        "geosite": ["category-ads-all"],
        "outbound": "block"
      }
    ]
  }
}
```

يحمل الموجه قاعدة البيانات عند بدء التشغيل، ويقرأ الرموز المطلوبة، ويجمعها إلى مطابقات قواعد في الذاكرة. رموز GeoIP تنتج قواعد IP CIDR؛ ورموز GeoSite تنتج قواعد نطاق/كلمة مفتاحية/تعبير نمطي.

## الانتقال إلى مجموعات القواعد

تُعتبر GeoIP و GeoSite قديمة. مسار الانتقال الموصى به هو استخدام مجموعات قواعد SRS، والتي:
- تدعم أنواعاً أكثر من القواعد (المنافذ، العمليات، ظروف الشبكة)
- لديها آليات تحديث أفضل (HTTP مع ETag، مراقبة الملفات)
- تسمح بتعريفات مضمنة بدون ملفات خارجية
- تستخدم تنسيقاً ثنائياً أكثر اختصاراً مع ضغط zlib

## ملاحظات إعادة التنفيذ

1. **GeoIP**: يعتمد على `github.com/oschwald/maxminddb-golang` لتحليل MMDB. تنسيق MMDB موثق جيداً ولديه تطبيقات في العديد من اللغات. الجانب الخاص بـ sing-box الوحيد هو فحص نوع قاعدة البيانات `sing-geoip`
2. **GeoSite**: يستخدم تنسيقاً ثنائياً مخصصاً مع ترميز uvarint. التنسيق بسيط التنفيذ: اقرأ الفهرس، انتقل إلى الإزاحة الصحيحة، اقرأ العناصر
3. **أمان الخيوط**: قارئ GeoSite يستخدم mutex لأنه يشارك قارئاً قابلاً للتنقل وقارئاً مخزناً مؤقتاً عبر الاستدعاءات. يمكن لإعادة التنفيذ استخدام قراء لكل استدعاء إذا كانت البيانات صغيرة بما يكفي للتخزين في الذاكرة
4. **تتبع إزاحة البايت**: غلاف `readCounter` يتتبع عدد البايتات التي استهلكها قسم البيانات الوصفية، مع مراعاة القراءة المسبقة للقارئ المخزن مؤقتاً عبر `reader.Buffered()`
