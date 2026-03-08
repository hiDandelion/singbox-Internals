# أنواع الخيارات المخصصة

يعرّف sing-box عدة أنواع مخصصة في حزمة `option` لتحليل التهيئة. تتعامل هذه الأنواع مع التحويل بين قيم JSON القابلة للقراءة البشرية والتمثيلات الداخلية في Go.

**المصدر**: `option/types.go`، `option/inbound.go`، `option/outbound.go`، `option/udp_over_tcp.go`

## NetworkList

يقبل إما نص شبكة واحد أو مصفوفة، مخزن داخلياً كنص مفصول بأسطر جديدة:

```go
type NetworkList string

func (v *NetworkList) UnmarshalJSON(content []byte) error {
    // يقبل: "tcp" أو ["tcp", "udp"]
    // القيم الصالحة: "tcp", "udp"
    // يُخزن كـ "tcp\nudp"
}

func (v NetworkList) Build() []string {
    // يُرجع ["tcp", "udp"] إذا كان فارغاً (الافتراضي: كلاهما)
    return strings.Split(string(v), "\n")
}
```

**أمثلة JSON**:
```json
"tcp"
["tcp", "udp"]
```

## DomainStrategy

يربط بين أسماء الاستراتيجيات النصية والثوابت الداخلية:

```go
type DomainStrategy C.DomainStrategy

// الربط:
//   ""              -> DomainStrategyAsIS
//   "as_is"         -> DomainStrategyAsIS
//   "prefer_ipv4"   -> DomainStrategyPreferIPv4
//   "prefer_ipv6"   -> DomainStrategyPreferIPv6
//   "ipv4_only"     -> DomainStrategyIPv4Only
//   "ipv6_only"     -> DomainStrategyIPv6Only
```

**أمثلة JSON**:
```json
""
"prefer_ipv4"
"ipv6_only"
```

## DNSQueryType

يتعامل مع أنواع استعلامات DNS كقيم رقمية أو أسماء نصية قياسية (عبر مكتبة `miekg/dns`):

```go
type DNSQueryType uint16

func (t *DNSQueryType) UnmarshalJSON(bytes []byte) error {
    // يقبل: 28 أو "AAAA"
    // يستخدم mDNS.StringToType و mDNS.TypeToString للتحويل
}

func (t DNSQueryType) MarshalJSON() ([]byte, error) {
    // يُخرج اسماً نصياً إذا كان معروفاً، وإلا القيمة الرقمية
}
```

**أمثلة JSON**:
```json
"A"
"AAAA"
28
```

## NetworkStrategy

يربط أسماء استراتيجيات الشبكة النصية بالثوابت الداخلية:

```go
type NetworkStrategy C.NetworkStrategy

func (n *NetworkStrategy) UnmarshalJSON(content []byte) error {
    // يستخدم خريطة بحث C.StringToNetworkStrategy
}
```

## InterfaceType

يمثل أنواع واجهات الشبكة (WIFI، خلوي، إيثرنت، أخرى):

```go
type InterfaceType C.InterfaceType

func (t InterfaceType) Build() C.InterfaceType {
    return C.InterfaceType(t)
}

func (t *InterfaceType) UnmarshalJSON(content []byte) error {
    // يستخدم خريطة بحث C.StringToInterfaceType
}
```

**أمثلة JSON**:
```json
"wifi"
"cellular"
"ethernet"
```

## UDPTimeoutCompat

يتعامل مع قيم مهلة UDP المتوافقة مع الإصدارات السابقة -- يقبل إما رقماً خاماً (ثواني) أو نص مدة:

```go
type UDPTimeoutCompat badoption.Duration

func (c *UDPTimeoutCompat) UnmarshalJSON(data []byte) error {
    // المحاولة الأولى: تحليل كعدد صحيح (ثواني)
    var valueNumber int64
    err := json.Unmarshal(data, &valueNumber)
    if err == nil {
        *c = UDPTimeoutCompat(time.Second * time.Duration(valueNumber))
        return nil
    }
    // الرجوع: تحليل كنص مدة (مثل "5m")
    return json.Unmarshal(data, (*badoption.Duration)(c))
}
```

**أمثلة JSON**:
```json
300
"5m"
"30s"
```

## DomainResolveOptions

يدعم الاختصار (مجرد اسم خادم) أو الكائن الكامل:

```go
type DomainResolveOptions struct {
    Server       string
    Strategy     DomainStrategy
    DisableCache bool
    RewriteTTL   *uint32
    ClientSubnet *badoption.Prefixable
}

func (o *DomainResolveOptions) UnmarshalJSON(bytes []byte) error {
    // محاولة نص: "dns-server-tag"
    // الرجوع إلى الكائن الكامل
}

func (o DomainResolveOptions) MarshalJSON() ([]byte, error) {
    // إذا كان Server فقط مضبوطاً، التسلسل كنص
    // وإلا التسلسل ككائن
}
```

**أمثلة JSON**:
```json
"my-dns-server"

{
  "server": "my-dns-server",
  "strategy": "ipv4_only",
  "disable_cache": true,
  "rewrite_ttl": 300,
  "client_subnet": "1.2.3.0/24"
}
```

## UDPOverTCPOptions

يدعم اختصار القيمة المنطقية أو الكائن الكامل:

```go
type UDPOverTCPOptions struct {
    Enabled bool  `json:"enabled,omitempty"`
    Version uint8 `json:"version,omitempty"`
}

func (o *UDPOverTCPOptions) UnmarshalJSON(bytes []byte) error {
    // محاولة قيمة منطقية: true/false
    // الرجوع إلى الكائن الكامل
}

func (o UDPOverTCPOptions) MarshalJSON() ([]byte, error) {
    // إذا كان الإصدار افتراضي (0 أو الحالي)، التسلسل كقيمة منطقية
    // وإلا التسلسل ككائن
}
```

**أمثلة JSON**:
```json
true

{
  "enabled": true,
  "version": 2
}
```

## Listable[T] (من badoption)

غير معرّف في `option/types.go` لكنه مستخدم بكثرة في جميع الأنحاء. `badoption.Listable[T]` يقبل إما قيمة واحدة أو مصفوفة:

```go
type Listable[T any] []T

func (l *Listable[T]) UnmarshalJSON(content []byte) error {
    // محاولة المصفوفة أولاً، ثم القيمة الواحدة
}
```

**أمثلة JSON**:
```json
"value"
["value1", "value2"]

443
[443, 8443]
```

## Duration (من badoption)

`badoption.Duration` يغلف `time.Duration` مع تحليل نص JSON:

```go
type Duration time.Duration

func (d *Duration) UnmarshalJSON(bytes []byte) error {
    // يحلل نصوص مدة Go: "5s", "1m30s", "24h"
}
```

**أمثلة JSON**:
```json
"30s"
"5m"
"24h"
"1h30m"
```

## Addr (من badoption)

`badoption.Addr` يغلف `netip.Addr` مع تحليل نص JSON:

**أمثلة JSON**:
```json
"127.0.0.1"
"::1"
"0.0.0.0"
```

## Prefix (من badoption)

`badoption.Prefix` يغلف `netip.Prefix` لتدوين CIDR:

**أمثلة JSON**:
```json
"198.18.0.0/15"
"fc00::/7"
```

## Prefixable (من badoption)

`badoption.Prefixable` يوسع تحليل البادئة لقبول العناوين المجردة (التي تُعامل كـ /32 أو /128):

**أمثلة JSON**:
```json
"192.168.1.0/24"
"192.168.1.1"
```

## FwMark

`FwMark` يُستخدم لعلامات توجيه Linux (`SO_MARK`). معرّف في مكان آخر من حزمة option ويقبل قيماً صحيحة:

**مثال JSON**:
```json
255
```

## ملاحظات إعادة التنفيذ

1. **أنماط الاختصار**: العديد من الأنواع تدعم كلاً من الشكل البسيط (نص/قيمة منطقية) والشكل الكامل (كائن). يجب أن يحاول فك التسلسل الشكل البسيط أولاً، ثم يرجع إلى الشكل المعقد
2. **Listable[T]**: هذا هو النوع المخصص الأكثر استخداماً. عملياً كل حقل مصفوفة في التهيئة يقبل كلاً من القيم المفردة والمصفوفات
3. **تحليل المدة**: يستخدم تنسيق `time.ParseDuration` في Go، الذي يدعم: `ns`، `us`/`\u00b5s`، `ms`، `s`، `m`، `h`
4. **أنواع استعلامات DNS**: خريطة `StringToType` في مكتبة `miekg/dns` توفر الربط القياسي بين الأسماء مثل `"AAAA"` والقيم الرقمية مثل `28`
5. **NetworkList**: التخزين الداخلي المفصول بأسطر جديدة هو تفصيل تنفيذ -- يمكن لإعادة التنفيذ استخدام شريحة نصوص بسيطة
6. **UDPTimeoutCompat**: التحليل المزدوج رقم/نص هو للتوافق مع الإصدارات السابقة مع التهيئات القديمة التي استخدمت ثواني عادية
