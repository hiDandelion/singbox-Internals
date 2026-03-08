# التخزين المؤقت ومعالجة الاستجابات في DNS

المصدر: `dns/client.go`، `dns/client_truncate.go`، `dns/client_log.go`، `dns/extension_edns0_subnet.go`، `dns/rcode.go`، `experimental/cachefile/rdrc.go`، `experimental/cachefile/cache.go`، `common/compatible/map.go`

## بنية ذاكرة التخزين المؤقت

يستخدم عميل DNS مكتبة `freelru` (ذاكرة تخزين مؤقت LRU مجزأة من `github.com/sagernet/sing/contrab/freelru`) لتخزين الاستجابات مؤقتاً. يتوفر وضعان حصريان للتخزين المؤقت:

```go
type Client struct {
    timeout            time.Duration
    disableCache       bool
    disableExpire      bool
    independentCache   bool
    clientSubnet       netip.Prefix
    rdrc               adapter.RDRCStore
    initRDRCFunc       func() adapter.RDRCStore
    logger             logger.ContextLogger
    cache              freelru.Cache[dns.Question, *dns.Msg]
    cacheLock          compatible.Map[dns.Question, chan struct{}]
    transportCache     freelru.Cache[transportCacheKey, *dns.Msg]
    transportCacheLock compatible.Map[dns.Question, chan struct{}]
}
```

### ذاكرة التخزين المؤقت المشتركة (الافتراضي)

مفهرسة بواسطة `dns.Question` (الاسم + نوع الاستعلام + فئة الاستعلام). تتشارك جميع وسائل النقل نفس نطاق ذاكرة التخزين المؤقت، مما يعني أن استجابة مخزنة مؤقتاً من وسيلة النقل A يمكن أن تخدم استعلاماً كان سيذهب إلى وسيلة النقل B.

### ذاكرة التخزين المؤقت المستقلة

عندما يكون `independentCache` مضبوطاً على true، تُفهرس ذاكرة التخزين المؤقت بواسطة `transportCacheKey`:

```go
type transportCacheKey struct {
    dns.Question
    transportTag string
}
```

تحصل كل وسيلة نقل على نطاق تخزين مؤقت خاص بها، مما يمنع إصابات ذاكرة التخزين المؤقت عبر وسائل النقل. هذا مهم عندما تُرجع وسائل نقل مختلفة نتائج مختلفة لنفس النطاق (مثل DNS محلي مقابل DNS أجنبي يُرجع عناوين IP مختلفة).

### التهيئة

```go
func NewClient(options ClientOptions) *Client {
    cacheCapacity := options.CacheCapacity
    if cacheCapacity < 1024 {
        cacheCapacity = 1024
    }
    if !client.disableCache {
        if !client.independentCache {
            client.cache = common.Must1(freelru.NewSharded[dns.Question, *dns.Msg](
                cacheCapacity, maphash.NewHasher[dns.Question]().Hash32))
        } else {
            client.transportCache = common.Must1(freelru.NewSharded[transportCacheKey, *dns.Msg](
                cacheCapacity, maphash.NewHasher[transportCacheKey]().Hash32))
        }
    }
}
```

الحد الأدنى للسعة هو 1024 مدخلاً. ينشئ المُنشئ `freelru.NewSharded` ذاكرة تخزين مؤقت LRU مجزأة بدالة تجزئة يولدها `maphash.NewHasher`. يتم إنشاء واحدة فقط من ذاكرتي التخزين المؤقت (`cache` أو `transportCache`)، اعتماداً على علامة `independentCache`.

## إزالة تكرار ذاكرة التخزين المؤقت

يمنع العميل الاستعلامات المتطابقة المتزامنة من التسبب في مشكلة القطيع المتدافع باستخدام قفل قائم على القنوات عبر `compatible.Map` (غلاف عام حول `sync.Map`):

```go
if c.cache != nil {
    cond, loaded := c.cacheLock.LoadOrStore(question, make(chan struct{}))
    if loaded {
        // Another goroutine is already querying this question
        select {
        case <-cond:           // Wait for the in-flight query to complete
        case <-ctx.Done():     // Or context cancellation
            return nil, ctx.Err()
        }
    } else {
        // This goroutine wins the race; clean up when done
        defer func() {
            c.cacheLock.Delete(question)
            close(cond)  // Signal all waiters
        }()
    }
}
```

تعمل الآلية كما يلي:

1. يتحقق `LoadOrStore` ذرياً مما إذا كانت قناة موجودة بالفعل لهذا السؤال
2. إذا كان `loaded` صحيحاً، فإن goroutine أخرى تنفذ الاستعلام بالفعل. تنتظر goroutine الحالية على القناة
3. إذا كان `loaded` خاطئاً، تتابع goroutine الحالية تنفيذ الاستعلام. عند الانتهاء، تحذف المدخل وتغلق القناة، مما يفتح الحجب عن جميع المنتظرين
4. بعد فتح الحجب، يمرر المنتظرون إلى `loadResponse` التي تسترجع النتيجة المخزنة مؤقتاً الآن

يُستخدم نفس النمط لـ `transportCacheLock` عندما يكون وضع ذاكرة التخزين المؤقت المستقلة نشطاً.

## تحديد قابلية التخزين المؤقت

لا يتم تخزين جميع رسائل DNS مؤقتاً. يكون الطلب قابلاً للتخزين المؤقت فقط إذا كان "طلباً بسيطاً":

```go
isSimpleRequest := len(message.Question) == 1 &&
    len(message.Ns) == 0 &&
    (len(message.Extra) == 0 || len(message.Extra) == 1 &&
        message.Extra[0].Header().Rrtype == dns.TypeOPT &&
        message.Extra[0].Header().Class > 0 &&
        message.Extra[0].Header().Ttl == 0 &&
        len(message.Extra[0].(*dns.OPT).Option) == 0) &&
    !options.ClientSubnet.IsValid()

disableCache := !isSimpleRequest || c.disableCache || options.DisableCache
```

الطلب البسيط يحتوي على:
- سؤال واحد بالضبط
- بدون سجلات سلطة
- بدون سجلات إضافية (أو سجل OPT واحد بالضبط بدون خيارات، وحجم UDP موجب، ورمز rcode ممتد صفري)
- بدون تجاوز شبكة العميل لكل استعلام

بالإضافة إلى ذلك، لا يتم تخزين الاستجابات ذات رموز الخطأ بخلاف SUCCESS و NXDOMAIN مطلقاً:

```go
disableCache = disableCache || (response.Rcode != dns.RcodeSuccess && response.Rcode != dns.RcodeNameError)
```

## تخزين ذاكرة التخزين المؤقت

```go
func (c *Client) storeCache(transport adapter.DNSTransport, question dns.Question, message *dns.Msg, timeToLive uint32) {
    if timeToLive == 0 {
        return
    }
    if c.disableExpire {
        if !c.independentCache {
            c.cache.Add(question, message)
        } else {
            c.transportCache.Add(transportCacheKey{
                Question:     question,
                transportTag: transport.Tag(),
            }, message)
        }
    } else {
        if !c.independentCache {
            c.cache.AddWithLifetime(question, message, time.Second*time.Duration(timeToLive))
        } else {
            c.transportCache.AddWithLifetime(transportCacheKey{
                Question:     question,
                transportTag: transport.Tag(),
            }, message, time.Second*time.Duration(timeToLive))
        }
    }
}
```

السلوكيات الرئيسية:
- لا يتم تخزين الاستجابات ذات TTL صفري مطلقاً
- عندما يكون `disableExpire` مضبوطاً على true، تُضاف المدخلات بدون عمر افتراضي (تبقى حتى يتم إخلاؤها بواسطة LRU)
- عندما يكون `disableExpire` مضبوطاً على false، تنتهي صلاحية المدخلات بناءً على TTL الخاص بالاستجابة

## استرجاع ذاكرة التخزين المؤقت وتعديل TTL

عند تحميل استجابة مخزنة مؤقتاً، يتم تعديل قيم TTL لتعكس الوقت المنقضي:

```go
func (c *Client) loadResponse(question dns.Question, transport adapter.DNSTransport) (*dns.Msg, int) {
    if c.disableExpire {
        // No expiration: return cached response as-is (copied)
        response, loaded = c.cache.Get(question)
        if !loaded { return nil, 0 }
        return response.Copy(), 0
    }

    // With expiration: get entry with lifetime info
    response, expireAt, loaded = c.cache.GetWithLifetime(question)
    if !loaded { return nil, 0 }

    // Manual expiration check (belt-and-suspenders)
    timeNow := time.Now()
    if timeNow.After(expireAt) {
        c.cache.Remove(question)
        return nil, 0
    }

    // Calculate remaining TTL
    var originTTL int
    for _, recordList := range [][]dns.RR{response.Answer, response.Ns, response.Extra} {
        for _, record := range recordList {
            if originTTL == 0 || record.Header().Ttl > 0 && int(record.Header().Ttl) < originTTL {
                originTTL = int(record.Header().Ttl)
            }
        }
    }
    nowTTL := int(expireAt.Sub(timeNow).Seconds())
    if nowTTL < 0 { nowTTL = 0 }

    response = response.Copy()
    if originTTL > 0 {
        duration := uint32(originTTL - nowTTL)
        for _, recordList := range [][]dns.RR{response.Answer, response.Ns, response.Extra} {
            for _, record := range recordList {
                record.Header().Ttl = record.Header().Ttl - duration
            }
        }
    } else {
        for _, recordList := range [][]dns.RR{response.Answer, response.Ns, response.Extra} {
            for _, record := range recordList {
                record.Header().Ttl = uint32(nowTTL)
            }
        }
    }
    return response, nowTTL
}
```

منطق تعديل TTL:
1. إيجاد أدنى TTL عبر جميع السجلات (`originTTL`) -- هذا هو TTL عند تخزين المدخل
2. حساب `nowTTL` كالثواني المتبقية حتى انتهاء الصلاحية
3. حساب `duration = originTTL - nowTTL` (الوقت المنقضي منذ التخزين المؤقت)
4. طرح `duration` من TTL كل سجل، بحيث يرى العملاء قيم TTL متناقصة بمرور الوقت
5. إذا كان `originTTL` يساوي 0 (جميع السجلات كان لها TTL صفري)، يتم تعيين جميع قيم TTL إلى العمر المتبقي

يتم دائماً نسخ الاستجابات بواسطة `.Copy()` قبل الإرجاع لمنع المستدعين من تعديل المدخلات المخزنة مؤقتاً.

## توحيد TTL

قبل التخزين المؤقت، يتم توحيد جميع قيم TTL للسجلات في الاستجابة إلى قيمة واحدة:

```go
var timeToLive uint32
if len(response.Answer) == 0 {
    // Negative response: use SOA minimum TTL
    if soaTTL, hasSOA := extractNegativeTTL(response); hasSOA {
        timeToLive = soaTTL
    }
}
if timeToLive == 0 {
    // Find minimum TTL across all sections
    for _, recordList := range [][]dns.RR{response.Answer, response.Ns, response.Extra} {
        for _, record := range recordList {
            if timeToLive == 0 || record.Header().Ttl > 0 && record.Header().Ttl < timeToLive {
                timeToLive = record.Header().Ttl
            }
        }
    }
}
if options.RewriteTTL != nil {
    timeToLive = *options.RewriteTTL
}
// Apply uniform TTL to all records
for _, recordList := range [][]dns.RR{response.Answer, response.Ns, response.Extra} {
    for _, record := range recordList {
        record.Header().Ttl = timeToLive
    }
}
```

### استخراج TTL السلبي

للاستجابات NXDOMAIN بدون سجلات إجابة، يُشتق TTL من سجل SOA في قسم السلطة:

```go
func extractNegativeTTL(response *dns.Msg) (uint32, bool) {
    for _, record := range response.Ns {
        if soa, isSOA := record.(*dns.SOA); isSOA {
            soaTTL := soa.Header().Ttl
            soaMinimum := soa.Minttl
            if soaTTL < soaMinimum {
                return soaTTL, true
            }
            return soaMinimum, true
        }
    }
    return 0, false
}
```

تُرجع الدالة `min(soa.Header().Ttl, soa.Minttl)`، اتباعاً لإرشادات RFC 2308 بشأن التخزين المؤقت السلبي.

## المسار السريع لذاكرة التخزين المؤقت في Lookup

تحتوي طريقة `Lookup` (النطاق إلى عناوين) على مسار سريع يتحقق من ذاكرة التخزين المؤقت قبل بناء رسالة DNS كاملة:

```go
func (c *Client) lookupToExchange(ctx context.Context, transport adapter.DNSTransport,
    name string, qType uint16, options adapter.DNSQueryOptions,
    responseChecker func(responseAddrs []netip.Addr) bool) ([]netip.Addr, error) {
    question := dns.Question{Name: name, Qtype: qType, Qclass: dns.ClassINET}
    disableCache := c.disableCache || options.DisableCache
    if !disableCache {
        cachedAddresses, err := c.questionCache(question, transport)
        if err != ErrNotCached {
            return cachedAddresses, err
        }
    }
    // ... proceed with full Exchange
}

func (c *Client) questionCache(question dns.Question, transport adapter.DNSTransport) ([]netip.Addr, error) {
    response, _ := c.loadResponse(question, transport)
    if response == nil {
        return nil, ErrNotCached
    }
    if response.Rcode != dns.RcodeSuccess {
        return nil, RcodeError(response.Rcode)
    }
    return MessageToAddresses(response), nil
}
```

هذا يتجاوز آلية إزالة التكرار ويتحقق مباشرة من ذاكرة التخزين المؤقت. إذا كانت استجابة NXDOMAIN مخزنة مؤقتاً موجودة، فإنها تُرجع خطأ `RcodeError` المناسب دون إجراء طلب عبر الشبكة.

## RDRC (ذاكرة التخزين المؤقت لرفض استجابة النطاق)

تخزن RDRC مؤقتاً مجموعات النطاق/نوع الاستعلام/وسيلة النقل التي تم رفضها بواسطة قواعد حد العناوين. هذا يمنع الاستعلام المتكرر لوسيلة نقل معروف أنها تُرجع عناوين غير مقبولة.

### الواجهة

```go
type RDRCStore interface {
    LoadRDRC(transportName string, qName string, qType uint16) (rejected bool)
    SaveRDRC(transportName string, qName string, qType uint16) error
    SaveRDRCAsync(transportName string, qName string, qType uint16, logger logger.Logger)
}
```

### التهيئة

يتم تهيئة مخزن RDRC بشكل كسول من ملف ذاكرة التخزين المؤقت عند بدء تشغيل العميل:

```go
func (c *Client) Start() {
    if c.initRDRCFunc != nil {
        c.rdrc = c.initRDRCFunc()
    }
}
```

في الموجه، تتحقق دالة التهيئة مما إذا كان ملف ذاكرة التخزين المؤقت يدعم RDRC:

```go
RDRC: func() adapter.RDRCStore {
    cacheFile := service.FromContext[adapter.CacheFile](ctx)
    if cacheFile == nil {
        return nil
    }
    if !cacheFile.StoreRDRC() {
        return nil
    }
    return cacheFile
},
```

### واجهة التخزين الخلفية (bbolt)

يتم حفظ RDRC باستخدام bbolt (فرع من BoltDB) في حاوية باسم `"rdrc2"`:

```go
var bucketRDRC = []byte("rdrc2")
```

#### تنسيق المفتاح

المفاتيح هي `[نوع الاستعلام 2 بايت (big-endian)][بايتات اسم الاستعلام]`، مخزنة تحت حاوية فرعية مسماة بوسم وسيلة النقل:

```go
key := buf.Get(2 + len(qName))
binary.BigEndian.PutUint16(key, qType)
copy(key[2:], qName)
```

#### تنسيق القيمة

القيم هي طوابع زمنية Unix من 8 بايتات (big-endian) تمثل وقت انتهاء الصلاحية:

```go
expiresAt := buf.Get(8)
binary.BigEndian.PutUint64(expiresAt, uint64(time.Now().Add(c.rdrcTimeout).Unix()))
return bucket.Put(key, expiresAt)
```

### المهلة الافتراضية

تنتهي صلاحية مدخلات RDRC بعد 7 أيام افتراضياً:

```go
if options.StoreRDRC {
    if options.RDRCTimeout > 0 {
        rdrcTimeout = time.Duration(options.RDRCTimeout)
    } else {
        rdrcTimeout = 7 * 24 * time.Hour
    }
}
```

### الحفظ غير المتزامن مع ذاكرة تخزين مؤقت في الذاكرة

لتجنب حجب مسار الاستعلام أثناء الكتابة على القرص، يتم حفظ مدخلات RDRC بشكل غير متزامن مع ذاكرة تخزين مؤقت للكتابة المسبقة في الذاكرة:

```go
type CacheFile struct {
    // ...
    saveRDRCAccess sync.RWMutex
    saveRDRC       map[saveRDRCCacheKey]bool
}

func (c *CacheFile) SaveRDRCAsync(transportName string, qName string, qType uint16, logger logger.Logger) {
    saveKey := saveRDRCCacheKey{transportName, qName, qType}
    c.saveRDRCAccess.Lock()
    c.saveRDRC[saveKey] = true        // Immediately visible to reads
    c.saveRDRCAccess.Unlock()
    go func() {
        err := c.SaveRDRC(transportName, qName, qType)    // Persist to bbolt
        if err != nil {
            logger.Warn("save RDRC: ", err)
        }
        c.saveRDRCAccess.Lock()
        delete(c.saveRDRC, saveKey)   // Remove from write-ahead cache
        c.saveRDRCAccess.Unlock()
    }()
}
```

عند التحميل، يتم فحص ذاكرة التخزين المؤقت في الذاكرة أولاً قبل القراءة من bbolt:

```go
func (c *CacheFile) LoadRDRC(transportName string, qName string, qType uint16) (rejected bool) {
    c.saveRDRCAccess.RLock()
    rejected, cached := c.saveRDRC[saveRDRCCacheKey{transportName, qName, qType}]
    c.saveRDRCAccess.RUnlock()
    if cached {
        return
    }
    // Fall through to bbolt read...
}
```

### انتهاء الصلاحية

عند التحميل من bbolt، يتم كشف المدخلات منتهية الصلاحية وتنظيفها بشكل كسول:

```go
content := bucket.Get(key)
expiresAt := time.Unix(int64(binary.BigEndian.Uint64(content)), 0)
if time.Now().After(expiresAt) {
    deleteCache = true   // Mark for deletion
    return nil           // Not rejected
}
rejected = true
```

يتم الحذف في معاملة `Update` منفصلة لتجنب الاحتفاظ بقفل معاملة القراءة أثناء الكتابة.

### التكامل مع Exchange

يتم فحص RDRC بعد إزالة تكرار ذاكرة التخزين المؤقت ولكن قبل تبادل وسيلة النقل:

```go
if !disableCache && responseChecker != nil && c.rdrc != nil {
    rejected := c.rdrc.LoadRDRC(transport.Tag(), question.Name, question.Qtype)
    if rejected {
        return nil, ErrResponseRejectedCached
    }
}
```

ويتم الحفظ عند رفض الاستجابة بواسطة مدقق حد العناوين:

```go
if rejected {
    if !disableCache && c.rdrc != nil {
        c.rdrc.SaveRDRCAsync(transport.Tag(), question.Name, question.Qtype, c.logger)
    }
    return response, ErrResponseRejected
}
```

تستخدم حلقة إعادة المحاولة في الموجه `ErrResponseRejected` و `ErrResponseRejectedCached` للانتقال إلى القاعدة المطابقة التالية.

## شبكة عميل EDNS0

يحقن العميل خيارات شبكة عميل EDNS0 (ECS) في رسائل DNS قبل التبادل:

```go
clientSubnet := options.ClientSubnet
if !clientSubnet.IsValid() {
    clientSubnet = c.clientSubnet      // Fall back to global setting
}
if clientSubnet.IsValid() {
    message = SetClientSubnet(message, clientSubnet)
}
```

### التنفيذ

```go
func SetClientSubnet(message *dns.Msg, clientSubnet netip.Prefix) *dns.Msg {
    return setClientSubnet(message, clientSubnet, true)
}

func setClientSubnet(message *dns.Msg, clientSubnet netip.Prefix, clone bool) *dns.Msg {
    var (
        optRecord    *dns.OPT
        subnetOption *dns.EDNS0_SUBNET
    )
    // Search for existing OPT record and EDNS0_SUBNET option
    for _, record := range message.Extra {
        if optRecord, isOPTRecord = record.(*dns.OPT); isOPTRecord {
            for _, option := range optRecord.Option {
                subnetOption, isEDNS0Subnet = option.(*dns.EDNS0_SUBNET)
                if isEDNS0Subnet { break }
            }
        }
    }
    // Create OPT record if not found
    if optRecord == nil {
        exMessage := *message
        message = &exMessage
        optRecord = &dns.OPT{Hdr: dns.RR_Header{Name: ".", Rrtype: dns.TypeOPT}}
        message.Extra = append(message.Extra, optRecord)
    } else if clone {
        return setClientSubnet(message.Copy(), clientSubnet, false)
    }
    // Create or update subnet option
    if subnetOption == nil {
        subnetOption = new(dns.EDNS0_SUBNET)
        subnetOption.Code = dns.EDNS0SUBNET
        optRecord.Option = append(optRecord.Option, subnetOption)
    }
    if clientSubnet.Addr().Is4() {
        subnetOption.Family = 1
    } else {
        subnetOption.Family = 2
    }
    subnetOption.SourceNetmask = uint8(clientSubnet.Bits())
    subnetOption.Address = clientSubnet.Addr().AsSlice()
    return message
}
```

التفاصيل الرئيسية:
- الاستدعاء الأول يستخدم `clone = true`، والذي ينسخ الرسالة إذا كان سجل OPT موجوداً بالفعل (لتجنب تعديل الأصل)
- إذا لم يكن سجل OPT موجوداً، يتم عمل نسخة سطحية من الرسالة ويُضاف سجل OPT جديد
- Family 1 = IPv4، Family 2 = IPv6
- يتم استبعاد الرسائل التي تم تعيين شبكة العميل لكل استعلام فيها (`options.ClientSubnet.IsValid()`) من التخزين المؤقت

### تخفيض إصدار EDNS0

بعد تلقي استجابة، يتعامل العميل مع عدم تطابق إصدارات EDNS0:

```go
requestEDNSOpt := message.IsEdns0()
responseEDNSOpt := response.IsEdns0()
if responseEDNSOpt != nil && (requestEDNSOpt == nil || requestEDNSOpt.Version() < responseEDNSOpt.Version()) {
    response.Extra = common.Filter(response.Extra, func(it dns.RR) bool {
        return it.Header().Rrtype != dns.TypeOPT
    })
    if requestEDNSOpt != nil {
        response.SetEdns0(responseEDNSOpt.UDPSize(), responseEDNSOpt.Do())
    }
}
```

إذا كان إصدار EDNS0 للاستجابة أعلى من إصدار الطلب (أو لم يكن للطلب EDNS0)، يتم إزالة سجل OPT واستبداله اختيارياً بسجل متوافق مع الإصدار.

## اقتطاع رسائل DNS

لاستجابات DNS عبر UDP التي تتجاوز الحد الأقصى لحجم الرسالة، يتم تطبيق الاقتطاع مع مراعاة EDNS0:

```go
func TruncateDNSMessage(request *dns.Msg, response *dns.Msg, headroom int) (*buf.Buffer, error) {
    maxLen := 512
    if edns0Option := request.IsEdns0(); edns0Option != nil {
        if udpSize := int(edns0Option.UDPSize()); udpSize > 512 {
            maxLen = udpSize
        }
    }
    responseLen := response.Len()
    if responseLen > maxLen {
        response = response.Copy()
        response.Truncate(maxLen)
    }
    buffer := buf.NewSize(headroom*2 + 1 + responseLen)
    buffer.Resize(headroom, 0)
    rawMessage, err := response.PackBuffer(buffer.FreeBytes())
    if err != nil {
        buffer.Release()
        return nil, err
    }
    buffer.Truncate(len(rawMessage))
    return buffer, nil
}
```

- الحد الأقصى الافتراضي هو 512 بايت (حد UDP القياسي لـ DNS)
- إذا كان الطلب يحتوي على سجل EDNS0 OPT بحجم UDP أكبر، يتم استخدام ذلك الحجم
- يتم تنفيذ الاقتطاع على نسخة لتجنب تعديل الاستجابة المخزنة مؤقتاً
- يتضمن المخزن المؤقت مساحة إضافية لإطار البروتوكول (مثل رؤوس UDP)

## مسح ذاكرة التخزين المؤقت

```go
func (c *Client) ClearCache() {
    if c.cache != nil {
        c.cache.Purge()
    } else if c.transportCache != nil {
        c.transportCache.Purge()
    }
}
```

يتم استدعاؤها بواسطة الموجه عند تغيير الشبكة:

```go
func (r *Router) ResetNetwork() {
    r.ClearCache()
    for _, transport := range r.transport.Transports() {
        transport.Reset()
    }
}

func (r *Router) ClearCache() {
    r.client.ClearCache()
    if r.platformInterface != nil {
        r.platformInterface.ClearDNSCache()
    }
}
```

هذا يمسح أيضاً ذاكرة التخزين المؤقت لـ DNS على مستوى المنصة (مثل Android/iOS) إذا كانت واجهة المنصة متاحة.

## تصفية الاستراتيجية

قبل أي تفاعل مع ذاكرة التخزين المؤقت أو وسيلة النقل، يتم الرد فوراً على الاستعلامات التي تتعارض مع استراتيجية النطاق بنجاح فارغ:

```go
if question.Qtype == dns.TypeA && options.Strategy == C.DomainStrategyIPv6Only ||
   question.Qtype == dns.TypeAAAA && options.Strategy == C.DomainStrategyIPv4Only {
    return FixedResponseStatus(message, dns.RcodeSuccess), nil
}
```

هذا يمنع إدخالات ذاكرة التخزين المؤقت غير الضرورية والرحلات ذهاباً وإياباً عبر الشبكة لأنواع الاستعلامات غير المتطابقة.

## تصفية سجلات HTTPS

لاستعلامات HTTPS (نوع SVCB 65)، يتم تصفية تلميحات العناوين بناءً على استراتيجية النطاق:

```go
if question.Qtype == dns.TypeHTTPS {
    if options.Strategy == C.DomainStrategyIPv4Only || options.Strategy == C.DomainStrategyIPv6Only {
        for _, rr := range response.Answer {
            https, isHTTPS := rr.(*dns.HTTPS)
            if !isHTTPS { continue }
            content := https.SVCB
            content.Value = common.Filter(content.Value, func(it dns.SVCBKeyValue) bool {
                if options.Strategy == C.DomainStrategyIPv4Only {
                    return it.Key() != dns.SVCB_IPV6HINT
                } else {
                    return it.Key() != dns.SVCB_IPV4HINT
                }
            })
            https.SVCB = content
        }
    }
}
```

استراتيجية IPv4 فقط تزيل تلميحات IPv6؛ واستراتيجية IPv6 فقط تزيل تلميحات IPv4. يتم هذا التصفية بعد تبادل وسيلة النقل ولكن قبل التخزين المؤقت، بحيث تكون استجابات HTTPS المخزنة مؤقتاً مصفاة بالفعل.

## كشف الحلقات

يتم كشف حلقات استعلامات DNS بوسم السياق بوسيلة النقل الحالية:

```go
contextTransport, loaded := transportTagFromContext(ctx)
if loaded && transport.Tag() == contextTransport {
    return nil, E.New("DNS query loopback in transport[", contextTransport, "]")
}
ctx = contextWithTransportTag(ctx, transport.Tag())
```

هذا يمنع التكرار اللانهائي عندما تحتاج وسيلة نقل إلى حل اسم مضيف خادمها (مثل وسيلة نقل DoH لـ `dns.example.com` تحاول حل `dns.example.com` عبر نفسها).

## التسجيل

ثلاث دوال تسجيل توفر مخرجات منظمة لأحداث DNS:

```go
func logCachedResponse(logger, ctx, response, ttl)    // "cached example.com NOERROR 42"
func logExchangedResponse(logger, ctx, response, ttl)  // "exchanged example.com NOERROR 300"
func logRejectedResponse(logger, ctx, response)         // "rejected A example.com 1.2.3.4"
```

كل منها يسجل النطاق على مستوى DEBUG والسجلات الفردية على مستوى INFO. يقوم المساعد `FormatQuestion` بتوحيد سلاسل سجلات miekg/dns عن طريق إزالة الفواصل المنقوطة، وتقليص المسافات البيضاء، والتشذيب.

## أنواع الأخطاء

```go
type RcodeError int

const (
    RcodeSuccess     RcodeError = mDNS.RcodeSuccess
    RcodeFormatError RcodeError = mDNS.RcodeFormatError
    RcodeNameError   RcodeError = mDNS.RcodeNameError
    RcodeRefused     RcodeError = mDNS.RcodeRefused
)

func (e RcodeError) Error() string {
    return mDNS.RcodeToString[int(e)]
}
```

أخطاء الحراسة:
- `ErrNoRawSupport` -- وسيلة النقل لا تدعم رسائل DNS الخام
- `ErrNotCached` -- عدم وجود في ذاكرة التخزين المؤقت (يُستخدم داخلياً بواسطة `questionCache`)
- `ErrResponseRejected` -- فشلت الاستجابة في فحص حد العناوين
- `ErrResponseRejectedCached` -- يمتد `ErrResponseRejected`، يشير إلى أن الرفض تم تقديمه من RDRC

## التكوين

```json
{
  "dns": {
    "client_options": {
      "disable_cache": false,
      "disable_expire": false,
      "independent_cache": false,
      "cache_capacity": 1024,
      "client_subnet": "1.2.3.0/24"
    }
  },
  "experimental": {
    "cache_file": {
      "enabled": true,
      "path": "cache.db",
      "store_rdrc": true,
      "rdrc_timeout": "168h"
    }
  }
}
```

| الحقل | القيمة الافتراضية | الوصف |
|-------|-------------------|-------|
| `disable_cache` | `false` | تعطيل جميع التخزين المؤقت لاستجابات DNS |
| `disable_expire` | `false` | مدخلات ذاكرة التخزين المؤقت لا تنتهي صلاحيتها أبداً (يتم إخلاؤها فقط بواسطة LRU) |
| `independent_cache` | `false` | نطاق ذاكرة تخزين مؤقت منفصل لكل وسيلة نقل |
| `cache_capacity` | `1024` | الحد الأقصى لمدخلات ذاكرة التخزين المؤقت (الحد الأدنى 1024) |
| `client_subnet` | لا شيء | بادئة شبكة عميل EDNS0 الافتراضية |
| `store_rdrc` | `false` | تفعيل استمرارية RDRC في ملف ذاكرة التخزين المؤقت |
| `rdrc_timeout` | `168h` (7 أيام) | مدة انتهاء صلاحية مدخلات RDRC |
