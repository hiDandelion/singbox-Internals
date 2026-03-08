# نظرة عامة على نظام DNS الفرعي

المصدر: `dns/`، `dns/transport/`، `dns/transport/fakeip/`، `dns/transport/hosts/`، `dns/transport/local/`، `dns/transport/dhcp/`

## البنية المعمارية

يتكون نظام DNS الفرعي في sing-box من ثلاثة مكونات أساسية:

```
                     +------------------+
                     |   DNS Router     |   مطابقة القواعد، اختيار وسيلة النقل
                     +------------------+
                            |
                     +------------------+
                     |   DNS Client     |   التخزين المؤقت، EDNS0، RDRC، إدارة TTL
                     +------------------+
                            |
              +-------------+-------------+
              |             |             |
        +---------+   +---------+   +---------+
        | UDP     |   | HTTPS   |   | FakeIP  |   ... وسائل نقل أخرى
        +---------+   +---------+   +---------+
```

1. **موجه DNS** (`dns/router.go`): يطابق استعلامات DNS مع القواعد، ويختار وسيلة النقل المناسبة، ويتعامل مع استراتيجية النطاق والتعيين العكسي
2. **عميل DNS** (`dns/client.go`): ينفذ تبادل DNS الفعلي مع التخزين المؤقت (freelru)، وحقن شبكة عميل EDNS0، وذاكرة التخزين المؤقت لرفض استجابة النطاق (RDRC)، وتعديل TTL
3. **وسائل نقل DNS** (`dns/transport/`): تنفيذ الاستعلامات الخاصة بالبروتوكول (UDP، TCP، TLS، HTTPS، QUIC/HTTP3، FakeIP، Hosts، Local، DHCP)

### المكونات المساعدة

- **سجل وسائل النقل** (`dns/transport_registry.go`): تسجيل آمن النوع وعام لأنواع وسائل النقل
- **محول وسيلة النقل** (`dns/transport_adapter.go`): بنية أساسية تحتوي على النوع/الوسم/التبعيات/الاستراتيجية/شبكة العميل
- **وسيلة النقل الأساسية** (`dns/transport/base.go`): آلة حالة (New/Started/Closing/Closed) مع تتبع الاستعلامات قيد التنفيذ
- **الموصل** (`dns/transport/connector.go`): إدارة اتصال عامة من نوع singleflight

## تدفق الاستعلام

### Exchange (رسالة DNS الخام)

1. يستقبل **Router.Exchange** رسالة `*dns.Msg`
2. استخراج البيانات الوصفية: نوع الاستعلام، النطاق، إصدار IP
3. إذا لم يتم تحديد وسيلة نقل صراحة، تتم المطابقة مع قواعد DNS:
   - `RuleActionDNSRoute` -- اختيار وسيلة نقل مع خيارات (الاستراتيجية، التخزين المؤقت، TTL، شبكة العميل)
   - `RuleActionDNSRouteOptions` -- تعديل الخيارات دون اختيار وسيلة نقل
   - `RuleActionReject` -- إرجاع REFUSED أو إسقاط
   - `RuleActionPredefined` -- إرجاع استجابة مُعدة مسبقاً
4. ينفذ **Client.Exchange** الاستعلام الفعلي:
   - التحقق من ذاكرة التخزين المؤقت (مع إزالة التكرار عبر قفل قائم على القنوات)
   - التحقق من RDRC للاستجابات المرفوضة سابقاً
   - تطبيق شبكة عميل EDNS0
   - تنفيذ transport.Exchange مع مهلة زمنية
   - التحقق من صحة الاستجابة (فحص حد العناوين)
   - توحيد قيم TTL
   - التخزين في ذاكرة التخزين المؤقت
5. تخزين التعيين العكسي (IP -> نطاق) إذا كان مفعلاً

### Lookup (تحويل النطاق إلى عناوين)

1. يستقبل **Router.Lookup** سلسلة نصية للنطاق
2. يحدد الاستراتيجية (IPv4Only، IPv6Only، PreferIPv4، PreferIPv6، AsIS)
3. يرسل **Client.Lookup** الاستعلامات:
   - IPv4Only: استعلام A واحد
   - IPv6Only: استعلام AAAA واحد
   - غير ذلك: استعلامات A + AAAA متوازية عبر `task.Group`
4. يتم ترتيب النتائج بناءً على تفضيل الاستراتيجية

### حلقة إعادة محاولة القواعد

عندما يكون للقاعدة حدود عناوين (مثل قيود geoip على عناوين الاستجابة)، يعيد الموجه المحاولة مع القواعد المطابقة التالية إذا تم رفض الاستجابة:

```go
for {
    transport, rule, ruleIndex = r.matchDNS(ctx, true, ruleIndex, isAddressQuery, &dnsOptions)
    responseCheck := addressLimitResponseCheck(rule, metadata)
    response, err = r.client.Exchange(dnsCtx, transport, message, dnsOptions, responseCheck)
    if responseCheck != nil && rejected {
        continue  // Try next matching rule
    }
    break
}
```

## قرارات التصميم الرئيسية

### إزالة التكرار

تستخدم ذاكرة التخزين المؤقت إزالة تكرار قائمة على القنوات لمنع مشكلة القطيع المتدافع (thundering herd):

```go
cond, loaded := c.cacheLock.LoadOrStore(question, make(chan struct{}))
if loaded {
    <-cond  // Wait for the in-flight query to complete
} else {
    defer func() {
        c.cacheLock.Delete(question)
        close(cond)  // Signal waiters
    }()
}
```

### كشف الحلقات

يتم كشف حلقات استعلامات DNS (مثل أن تحتاج وسيلة النقل A إلى حل عنوان خادمها عبر وسيلة النقل A نفسها) عبر السياق:

```go
contextTransport, loaded := transportTagFromContext(ctx)
if loaded && transport.Tag() == contextTransport {
    return nil, E.New("DNS query loopback in transport[", contextTransport, "]")
}
ctx = contextWithTransportTag(ctx, transport.Tag())
```

### RDRC (ذاكرة التخزين المؤقت لرفض استجابة النطاق)

عندما يتم رفض استجابة بواسطة فحص حد العناوين، يتم تخزين مجموعة النطاق/نوع الاستعلام/وسيلة النقل في RDRC لتخطي الاستعلامات المستقبلية ضد نفس وسيلة النقل:

```go
if rejected {
    c.rdrc.SaveRDRCAsync(transport.Tag(), question.Name, question.Qtype, c.logger)
}
// On subsequent queries:
if c.rdrc.LoadRDRC(transport.Tag(), question.Name, question.Qtype) {
    return nil, ErrResponseRejectedCached
}
```

### شبكة عميل EDNS0

يتم تطبيقها قبل التبادل عند التكوين:

```go
clientSubnet := options.ClientSubnet
if !clientSubnet.IsValid() {
    clientSubnet = c.clientSubnet
}
if clientSubnet.IsValid() {
    message = SetClientSubnet(message, clientSubnet)
}
```
