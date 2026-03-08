# توافق تنسيق السلك

يصف هذا المستند تنسيقات السلك على مستوى البايت لبروتوكولات الوكيل المدعومة من sing-box، مخصص لمعيدي التنفيذ الذين يحتاجون إلى التشغيل البيني مع نسخ sing-box (و Xray-core) الحالية.

## تنسيق سلك VLESS

VLESS منفذ في مكتبة `sing-vmess/vless`. يفوض sing-box جميع معالجة تنسيق السلك لهذه المكتبة.

### ترويسة الطلب

```
+----------+---------+---------+----------+---------+-------------------+
| Version  | UUID    | Addons  | Command  | Dest    | Payload           |
| 1 byte   | 16 bytes| varint+ | 1 byte   | variable| ...               |
+----------+---------+---------+----------+---------+-------------------+
```

| الحقل | الحجم | الوصف |
|-------|------|-------------|
| الإصدار | 1 بايت | إصدار البروتوكول، دائماً `0` |
| UUID | 16 بايت | UUID المستخدم في شكل ثنائي |
| طول الإضافات | 1 بايت | طول إضافات protobuf المرمزة (0 إذا لا شيء) |
| الإضافات | متغير | إضافات Protobuf (تحتوي حقل Flow لـ XTLS) |
| الأمر | 1 بايت | `0x01` = TCP، `0x02` = UDP، `0x03` = MUX |
| الوجهة | متغير | تنسيق عنوان SOCKS5 (انظر أدناه) |

### ترويسة الاستجابة

```
+----------+---------+
| Version  | Addons  |
| 1 byte   | varint+ |
+----------+---------+
```

| الحقل | الحجم | الوصف |
|-------|------|-------------|
| الإصدار | 1 بايت | دائماً `0` |
| طول الإضافات | 1 بايت | طول إضافات protobuf (عادة `0`) |

بعد ترويسة الاستجابة، تتدفق البيانات ثنائياً كتدفق TCP خام.

### تنسيق عنوان SOCKS5

يُستخدم في حقل الوجهة:

```
Type 0x01 (IPv4):  [1 byte type] [4 bytes addr] [2 bytes port big-endian]
Type 0x03 (FQDN):  [1 byte type] [1 byte len] [N bytes domain] [2 bytes port big-endian]
Type 0x04 (IPv6):  [1 byte type] [16 bytes addr] [2 bytes port big-endian]
```

### ترميز الحزم

يدعم VLESS ثلاثة أوضاع لترميز حزم UDP:

#### 1. عادي (بدون ترميز)

كل حزمة UDP تُرسل كاتصال VLESS منفصل بالأمر `0x02`. غير فعال لكنه بسيط.

#### 2. PacketAddr

يستخدم FQDN السحري `sp.packet-addr.v2fly.arpa` كوجهة VLESS. كل حزمة UDP داخل الاتصال مؤطرة كـ:

```
[SOCKS5 addr] [2 bytes payload length big-endian] [payload]
```

#### 3. XUDP (الافتراضي)

يستخدم ترميز XUDP بأسلوب VMess داخل اتصال VLESS بالأمر `0x03` (MUX). كل حزمة مؤطرة بإدارة جلسات مشابهة لـ VMess XUDP.

### Flow: xtls-rprx-vision

عند تهيئة `flow: "xtls-rprx-vision"`، يستخدم VLESS إعادة توجيه TLS المباشرة. العميل:
1. يقرأ سجلات TLS من الاتصال الداخلي
2. يحشو السجلات القصيرة لإخفاء أنماط أطوال السجلات
3. ينتقل إلى النسخ الخام بعد اكتمال مصافحة TLS

هذا يتطلب وعياً على مستوى TLS في طبقة الوكيل.

## تنسيق سلك VMess

VMess منفذ في مكتبة `sing-vmess`.

### اشتقاق المفتاح

```
Request Key:  MD5(UUID bytes)
Request IV:   MD5(timestamp + UUID bytes)
```

الطابع الزمني هو وقت Unix الحالي بالثواني، مرمز كـ int64 بترتيب big-endian، مع نافذة تسامح 30 ثانية للمصادقة.

### ترويسة الطلب (AlterId = 0، AEAD)

تنسيق AEAD الحديث (بدون alterId / alterId = 0):

```
المصادقة:
  [16 bytes: HMAC-MD5 of timestamp using UUID as key]

الترويسة المشفرة (AES-128-GCM):
  [1 byte: version (1)]
  [16 bytes: request body IV]
  [16 bytes: request body key]
  [1 byte: response authentication V]
  [1 byte: option flags]
    bit 0: chunk stream (مضبوط دائماً)
    bit 1: connection reuse (مهمل)
    bit 2: chunk masking (global_padding)
    bit 3: authenticated length
    bit 4: padding
  [1 byte: padding length P (4 بتات علوية) + security (4 بتات سفلية)]
  [1 byte: reserved (0)]
  [1 byte: command (0x01=TCP, 0x02=UDP)]
  [2 bytes: port big-endian]
  [address: type + addr]
  [P bytes: random padding]
  [4 bytes: FNV1a hash of header]
```

قيم الأمان (4 بتات سفلية):
- `0x00`: قديم (AES-128-CFB)
- `0x03`: AES-128-GCM
- `0x04`: ChaCha20-Poly1305
- `0x05`: بدون (نص عادي)
- `0x06`: صفر (بدون تشفير، وضع الطول المصادق)

### ترويسة الاستجابة

```
[1 byte: response auth V (يجب أن يطابق الطلب)]
[1 byte: option flags]
[1 byte: command (0)]
[1 byte: command length (0)]
```

### تأطير البيانات (تدفق القطع)

كل قطعة بيانات:

```
بدون طول مصادق:
  [2 bytes: length big-endian] [encrypted payload]

مع طول مصادق:
  [2 bytes: encrypted length] [encrypted payload]
  (الطول نفسه مشفر بـ AEAD منفصل)
```

قناع القطعة يقوم بـ XOR للطول مع تجزئة مشتقة من IV، مما يجعل تحليل الطول أصعب.

### ترميز الحزم (XUDP)

VMess يدعم XUDP لـ UDP عبر TCP. XUDP يستخدم تعدد إرسال معتمد على الجلسات حيث يحصل كل "اتصال" UDP على معرف جلسة:

```
[2 bytes: session ID]
[1 byte: status (new/keep/end)]
[1 byte: padding length]
[address: destination]
[2 bytes: payload length]
[payload]
[padding]
```

## تنسيق سلك Trojan

Trojan هو بروتوكول بسيط بمصادقة كلمة مرور. تطبيق sing-box موجود في `transport/trojan/`.

### اشتقاق المفتاح

```go
func Key(password string) [56]byte {
    hash := sha256.New224()  // SHA-224، ينتج 28 بايت
    hash.Write([]byte(password))
    hex.Encode(key[:], hash.Sum(nil))  // 28 بايت -> 56 حرف سداسي عشري
    return key
}
```

المفتاح هو تجزئة SHA-224 المرمزة سداسياً لكلمة المرور، ينتج نص ASCII مكون من 56 بايت.

### طلب TCP

```
[56 bytes: hex key]
[2 bytes: CRLF (\r\n)]
[1 byte: command]
  0x01 = TCP (CommandTCP)
  0x03 = UDP (CommandUDP)
  0x7F = MUX (CommandMux)
[variable: SOCKS5 address (destination)]
[2 bytes: CRLF (\r\n)]
[payload...]
```

```
مثال (TCP إلى example.com:443):
  6162636465666768...  (56 bytes hex key)
  0D 0A              (CRLF)
  01                  (أمر TCP)
  03 0B 65 78 61 6D 70 6C 65 2E 63 6F 6D 01 BB  (SOCKS5: domain "example.com" port 443)
  0D 0A              (CRLF)
  [حمولة TCP تتبع مباشرة]
```

الخادم يستجيب ببيانات خام -- لا توجد ترويسة استجابة.

### تأطير حزم UDP

بعد المصافحة الأولية (مع `CommandUDP`)، كل حزمة UDP مؤطرة كـ:

```
[variable: SOCKS5 address (packet destination)]
[2 bytes: payload length big-endian]
[2 bytes: CRLF (\r\n)]
[payload bytes]
```

لحزمة المصافحة الأولية، تظهر الوجهة مرتين -- مرة في ترويسة المصافحة ومرة في تأطير الحزمة:

```
[56 bytes: key] [CRLF]
[0x03: أمر UDP]
[SOCKS5 addr: وجهة أولية]  <-- وجهة المصافحة
[CRLF]
[SOCKS5 addr: وجهة الحزمة]   <-- وجهة الحزمة الأولى (عادة نفسها)
[2 bytes: payload length]
[CRLF]
[payload]
```

الحزم اللاحقة داخل نفس الاتصال تستخدم فقط تأطير كل حزمة (بدون بادئة المفتاح/الأمر).

## تنسيق سلك Shadowsocks

يستخدم sing-box مكتبة `sing-shadowsocks2`.

### شيفرات AEAD (aes-128-gcm، aes-256-gcm، chacha20-ietf-poly1305)

#### اشتقاق المفتاح

```
Key = HKDF-SHA1(password=password, salt=nil, info="ss-subkey")
  أو
Key = EVP_BytesToKey(password, key_size)  // قديم
```

#### تدفق TCP

```
[salt: key_size bytes random]
[encrypted SOCKS5 address + initial payload]
[encrypted chunks...]
```

كل قطعة مشفرة:
```
[2 bytes encrypted length + 16 bytes AEAD tag]
[payload + 16 bytes AEAD tag]
```

الطول هو uint16 بترتيب big-endian بقيمة قصوى 0x3FFF (16383 بايت).

التشفير يستخدم AEAD مع مفتاح فرعي لكل جلسة مشتق عبر HKDF:
```
Subkey = HKDF-SHA1(key=PSK, salt=salt, info="ss-subkey")
```

القيمة العشوائية (Nonce) تبدأ من 0 وتزداد بمقدار 1 لكل عملية AEAD (كل من الطول والحمولة يستخدمان زيادات قيمة عشوائية منفصلة).

#### حزمة UDP

```
[salt: key_size bytes]
[encrypted: SOCKS5 address + payload + AEAD tag]
```

كل حزمة UDP تستخدم ملحاً عشوائياً جديداً وبالتالي مفتاحاً فرعياً جديداً.

### شيفرات AEAD 2022 (Shadowsocks 2022)

شيفرات 2022 تستخدم تأطيراً مختلفاً مع حماية من إعادة التشغيل وطوابع زمنية.

#### تنسيق المفتاح

بايتات مفتاح خام مرمزة بـ Base64:
- `2022-blake3-aes-128-gcm`: مفتاح 16 بايت
- `2022-blake3-aes-256-gcm`: مفتاح 32 بايت
- `2022-blake3-chacha20-poly1305`: مفتاح 32 بايت

#### ترويسة TCP

```
ملح الطلب: [key_size bytes random]
ترويسة ثابتة (مشفرة):
  [1 byte: type (0=عميل, 1=خادم)]
  [8 bytes: timestamp big-endian (حقبة Unix)]
  [2 bytes: request salt length]
  [N bytes: request salt (لربط الاستجابة)]
ترويسة متغيرة (مشفرة، قيمة عشوائية منفصلة):
  [1 byte: SOCKS5 addr type]
  [variable: SOCKS5 addr]
  [2 bytes: initial payload padding length]
  [N bytes: padding]
  [initial payload]
```

#### متعدد المستخدمين (EIH)

لخوادم متعددة المستخدمين، تُضاف ترويسات الهوية المشفرة:
```
[N * 16 bytes: EIH blocks]
```

كل كتلة هي `AES-ECB(identity_subkey, salt[0:16] XOR PSK_hash[0:16])`.

## تنسيق تعدد الإرسال (sing-mux)

يستخدم sing-box مكتبة `sing-mux` لتعدد إرسال الاتصالات، وتدعم ثلاثة بروتوكولات.

### اختيار البروتوكول

```json
{
  "multiplex": {
    "enabled": true,
    "protocol": "h2mux",  // أو "smux", "yamux"
    "max_connections": 4,
    "min_streams": 4,
    "max_streams": 0,
    "padding": false
  }
}
```

### مصافحة sing-mux

قبل بروتوكول تعدد الإرسال الأساسي، يضيف sing-mux تفاوض إصدار وبروتوكول:

```
[1 byte: version]
[1 byte: protocol]
  0x00 = smux
  0x01 = yamux
  0x02 = h2mux
[padding if enabled]
```

### ترويسة طلب التدفق

كل تدفق جديد داخل تعدد الإرسال يبدأ بـ:

```
[1 byte: network]
  0x00 = TCP
  0x01 = UDP
[SOCKS5 address: destination]
```

لتدفقات UDP، كل حزمة مؤطرة إضافياً ببادئة طول.

### الحشو

عند تفعيل `padding: true`، يُضاف حشو بطول عشوائي إلى المصافحة وكل تدفق لمقاومة تحليل حركة المرور:

```
[2 bytes: padding length big-endian]
[N bytes: random padding]
```

### وضع Brutal

Brutal هو وضع تحكم في الازدحام مخصص يفرض معدل إرسال ثابت:

```json
{
  "brutal": {
    "enabled": true,
    "up_mbps": 100,
    "down_mbps": 100
  }
}
```

يتجاوز هذا التحكم في ازدحام TCP بعرض نطاق ثابت، مفيد للشبكات ذات فقدان الحزم حيث يتراجع TCP العادي بشكل مفرط.

## UDP عبر TCP (UoT)

يُستخدم بواسطة Shadowsocks عندما لا يدعم الخادم ترحيل UDP الأصلي:

```json
{
  "udp_over_tcp": true
}
```

### تنسيق إطار UoT v2

كل حزمة UDP مؤطرة عبر تدفق TCP كـ:

```
[2 bytes: total frame length big-endian (يشمل العنوان)]
[SOCKS5 address: packet destination]
[payload]
```

يتم التفاوض على إصدار UoT عبر حزمة `sing/common/uot`. الإصدار 2 (الافتراضي الحالي) يستخدم التنسيق أعلاه.

## تسلسل عنوان SOCKS5

يُستخدم هذا التنسيق في جميع البروتوكولات لترميز عناوين الوجهة. يتبع تنسيق عنوان SOCKS5:

```
IPv4:   [0x01] [4 bytes: address]  [2 bytes: port big-endian]
Domain: [0x03] [1 byte: length] [N bytes: domain] [2 bytes: port big-endian]
IPv6:   [0x04] [16 bytes: address] [2 bytes: port big-endian]
```

يستخدم sing-box `M.SocksaddrSerializer` من مكتبة `sing` التي تنفذ هذا التنسيق بالضبط.

## ملاحظات التشغيل البيني

### مع Xray-core

- **VMess**: توافق كامل. استخدم `security: "auto"` أو شيفرة صريحة. اضبط `alterId: 0` لوضع AEAD (مطلوب لـ Xray الحديث)
- **VLESS**: توافق كامل. ترميز حزم XUDP هو الافتراضي ويطابق سلوك Xray
- **Trojan**: توافق كامل. تجزئة كلمة المرور (SHA-224 سداسي عشري) متطابقة
- **Shadowsocks**: توافق كامل لشيفرات AEAD و 2022

### مع Clash.Meta

- **VMess**: متوافق. Clash.Meta يستخدم نفس مكتبة `sing-vmess`
- **Trojan**: متوافق
- **Shadowsocks**: متوافق

### الأخطاء الشائعة

1. **طابع VMess الزمني**: تستخدم المصادقة الطابع الزمني الحالي لـ Unix بالثواني. انحراف الساعة أكثر من 120 ثانية سيسبب فشل المصادقة. استخدم NTP
2. **UUID في VLESS**: يجب أن يكون بالضبط 16 بايت في الشكل الثنائي. حلله من تنسيق نص UUID القياسي (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
3. **مفتاح Trojan**: يُستخدم SHA-224 (وليس SHA-256). المخرج مرمز سداسياً لإنتاج 56 بايت ASCII بالضبط
4. **قيمة Shadowsocks العشوائية**: تبدأ من 0 وتزداد تسلسلياً. القيمة العشوائية عادة 12 بايت (96 بت) مع العداد في البايتات الأولى (little-endian لمعظم التطبيقات)
5. **طوابع Shadowsocks 2022 الزمنية**: يجب أن تكون ضمن 30 ثانية من وقت الخادم. استخدم NTP
6. **بايت نوع عنوان SOCKS5**: يجب أن يكون `0x01` (IPv4)، `0x03` (نطاق)، أو `0x04` (IPv6). النوع `0x00` غير صالح
7. **ترميز المنفذ**: دائماً uint16 بترتيب big-endian في جميع البروتوكولات
8. **متطلب TLS**: يجب دائماً استخدام VLESS و Trojan مع TLS في الإنتاج. بدون TLS، يُرسل المفتاح/UUID كنص عادي
