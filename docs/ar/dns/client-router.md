# عميل DNS والموجه

المصدر: `dns/client.go`، `dns/router.go`، `dns/rcode.go`، `dns/client_truncate.go`، `dns/client_log.go`، `dns/extension_edns0_subnet.go`

## عميل DNS

### البنية

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

وضعان للتخزين المؤقت:
- **ذاكرة تخزين مؤقت مشتركة** (`cache`): مفهرسة بواسطة `dns.Question` (الاسم + نوع الاستعلام + فئة الاستعلام)
- **ذاكرة تخزين مؤقت مستقلة** (`transportCache`): مفهرسة بواسطة `transportCacheKey` (السؤال + وسم وسيلة النقل)، بحيث يكون لكل وسيلة نقل نطاق تخزين مؤقت خاص بها

تستخدم ذاكرة التخزين المؤقت `github.com/sagernet/sing/contrab/freelru` (ذاكرة تخزين مؤقت LRU مجزأة). السعة الافتراضية هي 1024 مدخلاً.

### Exchange

الطريقة الأساسية `Exchange` تتعامل مع دورة حياة الاستعلام الكاملة:

```go
func (c *Client) Exchange(ctx context.Context, transport adapter.DNSTransport,
    message *dns.Msg, options adapter.DNSQueryOptions,
    responseChecker func(responseAddrs []netip.Addr) bool) (*dns.Msg, error)
```

#### الخطوة 1: تصفية الاستراتيجية

تُرجع فوراً نجاحاً فارغاً للاستراتيجيات غير المتطابقة:

```go
if question.Qtype == dns.TypeA && options.Strategy == C.DomainStrategyIPv6Only ||
   question.Qtype == dns.TypeAAAA && options.Strategy == C.DomainStrategyIPv4Only {
    return FixedResponseStatus(message, dns.RcodeSuccess), nil
}
```

#### الخطوة 2: شبكة العميل

```go
clientSubnet := options.ClientSubnet
if !clientSubnet.IsValid() {
    clientSubnet = c.clientSubnet
}
if clientSubnet.IsValid() {
    message = SetClientSubnet(message, clientSubnet)
}
```

#### الخطوة 3: فحص ذاكرة التخزين المؤقت

فقط "الطلبات البسيطة" قابلة للتخزين المؤقت (سؤال واحد، بدون سجلات إضافية باستثناء OPT، بدون شبكة عميل في الخيارات):

```go
isSimpleRequest := len(message.Question) == 1 &&
    len(message.Ns) == 0 &&
    (len(message.Extra) == 0 || len(message.Extra) == 1 &&
        message.Extra[0].Header().Rrtype == dns.TypeOPT &&
        message.Extra[0].Header().Class > 0 &&
        message.Extra[0].Header().Ttl == 0 &&
        len(message.Extra[0].(*dns.OPT).Option) == 0) &&
    !options.ClientSubnet.IsValid()
```

إزالة تكرار ذاكرة التخزين المؤقت تمنع الاستعلامات المتطابقة المتزامنة:

```go
cond, loaded := c.cacheLock.LoadOrStore(question, make(chan struct{}))
if loaded {
    select {
    case <-cond:     // Wait for first query to complete
    case <-ctx.Done(): return nil, ctx.Err()
    }
}
```

#### الخطوة 4: تحميل ذاكرة التخزين المؤقت مع تعديل TTL

```go
func (c *Client) loadResponse(question dns.Question, transport adapter.DNSTransport) (*dns.Msg, int) {
    response, expireAt, loaded = c.cache.GetWithLifetime(question)
    // Calculate remaining TTL
    nowTTL := int(expireAt.Sub(timeNow).Seconds())
    // Adjust record TTLs: subtract elapsed time
    duration := uint32(originTTL - nowTTL)
    for _, record := range recordList {
        record.Header().Ttl = record.Header().Ttl - duration
    }
    return response, nowTTL
}
```

يتم نسخ الاستجابات المخزنة مؤقتاً (`response.Copy()`) لمنع التعديل. يتم تعديل قيم TTL لتعكس الوقت المنقضي منذ التخزين المؤقت.

#### الخطوة 5: فحص RDRC

```go
if c.rdrc != nil {
    rejected := c.rdrc.LoadRDRC(transport.Tag(), question.Name, question.Qtype)
    if rejected {
        return nil, ErrResponseRejectedCached
    }
}
```

#### الخطوة 6: تبادل وسيلة النقل

```go
ctx, cancel := context.WithTimeout(ctx, c.timeout)
response, err := transport.Exchange(ctx, message)
cancel()
```

المهلة الزمنية الافتراضية هي `C.DNSTimeout`.

#### الخطوة 7: التحقق من صحة الاستجابة

إذا تم توفير `responseChecker`، يتم التحقق من صحة عناوين الاستجابة:

```go
if responseChecker != nil {
    var rejected bool
    if response.Rcode != dns.RcodeSuccess && response.Rcode != dns.RcodeNameError {
        rejected = true
    } else if len(response.Answer) == 0 {
        rejected = !responseChecker(nil)
    } else {
        rejected = !responseChecker(MessageToAddresses(response))
    }
    if rejected {
        c.rdrc.SaveRDRCAsync(transport.Tag(), question.Name, question.Qtype, c.logger)
        return response, ErrResponseRejected
    }
}
```

#### الخطوة 8: توحيد TTL

يتم تعيين جميع سجلات الاستجابة إلى أدنى قيمة TTL موجودة. إذا تم تعيين `options.RewriteTTL`، فإن تلك القيمة تتجاوز.

للاستجابات السلبية (NXDOMAIN بدون إجابات)، يتم استخدام الحد الأدنى لـ TTL من سجل SOA:

```go
func extractNegativeTTL(response *dns.Msg) (uint32, bool) {
    for _, record := range response.Ns {
        if soa, isSOA := record.(*dns.SOA); isSOA {
            return min(soa.Header().Ttl, soa.Minttl), true
        }
    }
    return 0, false
}
```

#### الخطوة 9: تصفية سجلات HTTPS

لاستعلامات HTTPS مع استراتيجية النطاق، يتم تصفية تلميحات العناوين:

```go
if question.Qtype == dns.TypeHTTPS {
    if options.Strategy == C.DomainStrategyIPv4Only {
        // Remove IPv6 hints
    } else if options.Strategy == C.DomainStrategyIPv6Only {
        // Remove IPv4 hints
    }
}
```

### Lookup

استعلامات A/AAAA متوازية:

```go
func (c *Client) Lookup(ctx context.Context, transport adapter.DNSTransport,
    domain string, options adapter.DNSQueryOptions, responseChecker func([]netip.Addr) bool) ([]netip.Addr, error) {
    if strategy == C.DomainStrategyIPv4Only {
        return c.lookupToExchange(ctx, transport, dnsName, dns.TypeA, options, responseChecker)
    } else if strategy == C.DomainStrategyIPv6Only {
        return c.lookupToExchange(ctx, transport, dnsName, dns.TypeAAAA, options, responseChecker)
    }
    var group task.Group
    group.Append("exchange4", func(ctx context.Context) error { ... })
    group.Append("exchange6", func(ctx context.Context) error { ... })
    err := group.Run(ctx)
    return sortAddresses(response4, response6, strategy), nil
}
```

`sortAddresses` ترتب النتائج حسب الاستراتيجية: PreferIPv6 تضع AAAA أولاً، وكل شيء آخر يضع A أولاً.

## موجه DNS

### مطابقة القواعد

```go
func (r *Router) matchDNS(ctx context.Context, allowFakeIP bool, ruleIndex int,
    isAddressQuery bool, options *adapter.DNSQueryOptions) (adapter.DNSTransport, adapter.DNSRule, int) {
    for ; currentRuleIndex < len(r.rules); currentRuleIndex++ {
        currentRule := r.rules[currentRuleIndex]
        if currentRule.WithAddressLimit() && !isAddressQuery {
            continue  // Skip address-limit rules for non-address queries
        }
        metadata.ResetRuleCache()
        if currentRule.Match(metadata) {
            switch action := currentRule.Action().(type) {
            case *R.RuleActionDNSRoute:
                transport, loaded := r.transport.Transport(action.Server)
                // Apply strategy, cache, TTL, client subnet options
                return transport, currentRule, currentRuleIndex
            case *R.RuleActionDNSRouteOptions:
                // Modify options and continue matching
            case *R.RuleActionReject:
                return nil, currentRule, currentRuleIndex
            case *R.RuleActionPredefined:
                return nil, currentRule, currentRuleIndex
            }
        }
    }
    return r.transport.Default(), nil, -1
}
```

يتم تقييم القواعد ذات حدود العناوين فقط لاستعلامات العناوين (A، AAAA، HTTPS).

### التعيين العكسي

عند التفعيل، يخزن الموجه تعيينات IP إلى نطاق مع انتهاء صلاحية قائم على TTL:

```go
if r.dnsReverseMapping != nil && transport.Type() != C.DNSTypeFakeIP {
    for _, answer := range response.Answer {
        switch record := answer.(type) {
        case *mDNS.A:
            r.dnsReverseMapping.AddWithLifetime(
                M.AddrFromIP(record.A),
                FqdnToDomain(record.Hdr.Name),
                time.Duration(record.Hdr.Ttl)*time.Second)
        case *mDNS.AAAA:
            r.dnsReverseMapping.AddWithLifetime(...)
        }
    }
}
```

يتم استبعاد استجابات FakeIP من التعيين العكسي لأنها تُرجع عناوين اصطناعية.

### إعادة تعيين الشبكة

عند تغيير الشبكة، يمسح الموجه جميع ذاكرات التخزين المؤقت ويعيد تعيين جميع وسائل النقل:

```go
func (r *Router) ResetNetwork() {
    r.ClearCache()
    for _, transport := range r.transport.Transports() {
        transport.Reset()
    }
}
```

## الأنواع المساعدة

### RcodeError

```go
type RcodeError int

var RcodeNameError = RcodeError(dns.RcodeNameError)

func (e RcodeError) Error() string {
    return dns.RcodeToString[int(e)]
}
```

### MessageToAddresses

يستخرج عناوين IP من استجابة DNS، بما في ذلك تلميحات HTTPS SVCB:

```go
func MessageToAddresses(response *dns.Msg) []netip.Addr {
    for _, rawAnswer := range response.Answer {
        switch answer := rawAnswer.(type) {
        case *dns.A:     addresses = append(addresses, M.AddrFromIP(answer.A))
        case *dns.AAAA:  addresses = append(addresses, M.AddrFromIP(answer.AAAA))
        case *dns.HTTPS:
            for _, value := range answer.SVCB.Value {
                if value.Key() == dns.SVCB_IPV4HINT || value.Key() == dns.SVCB_IPV6HINT {
                    addresses = append(addresses, common.Map(strings.Split(value.String(), ","), M.ParseAddr)...)
                }
            }
        }
    }
}
```
