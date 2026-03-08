# TLS على مستوى النواة (kTLS)

المصدر: `common/tls/ktls.go`، `common/ktls/ktls.go`، `common/ktls/ktls_linux.go`، `common/ktls/ktls_cipher_suites_linux.go`، `common/ktls/ktls_const.go`، `common/ktls/ktls_write.go`، `common/ktls/ktls_read.go`، `common/ktls/ktls_read_wait.go`، `common/ktls/ktls_close.go`

## نظرة عامة

يُفرِّغ kTLS عمليات تشفير/فك تشفير TLS إلى نواة Linux، مما يُمكِّن عمليات sendfile و splice بدون نسخ. وهو مقيد بقيود البناء: `linux && go1.25 && badlinkname`.

يُدعم فقط TLS 1.3. يتعامل التنفيذ مع كل من تفريغ TX (الإرسال) و RX (الاستقبال).

## طبقة التكامل

يوفر ملف `common/tls/ktls.go` أنواعًا مُغلِّفة تعترض اكتمال مصافحة TLS:

```go
type KTLSClientConfig struct {
    Config
    logger             logger.ContextLogger
    kernelTx, kernelRx bool
}

func (w *KTLSClientConfig) ClientHandshake(ctx context.Context, conn net.Conn) (aTLS.Conn, error) {
    tlsConn, err := aTLS.ClientHandshake(ctx, conn, w.Config)
    if err != nil { return nil, err }
    kConn, err := ktls.NewConn(ctx, w.logger, tlsConn, w.kernelTx, w.kernelRx)
    if err != nil {
        tlsConn.Close()
        return nil, E.Cause(err, "initialize kernel TLS")
    }
    return kConn, nil
}
```

بالمثل لجانب الخادم مع `KTlSServerConfig`.

## تهيئة الاتصال

```go
type Conn struct {
    aTLS.Conn
    ctx             context.Context
    logger          logger.ContextLogger
    conn            net.Conn
    rawConn         *badtls.RawConn
    syscallConn     syscall.Conn
    rawSyscallConn  syscall.RawConn
    readWaitOptions N.ReadWaitOptions
    kernelTx        bool
    kernelRx        bool
    pendingRxSplice bool
}
```

خطوات التهيئة:

1. **تحميل وحدة النواة**: تتأكد `Load()` من تحميل وحدة النواة `tls` عبر `modprobe`
2. **استخراج syscall.Conn**: يجب أن يُنفِّذ `net.Conn` الأساسي واجهة `syscall.Conn` للوصول إلى واصف الملف الخام
3. **استخراج حالة TLS الخام**: يستخدم `badtls.NewRawConn` للوصول إلى الحالة الداخلية لـ TLS (مفاتيح التشفير، المتجهات الأولية، أرقام التسلسل)
4. **التحقق من TLS 1.3**: يُدعم فقط `tls.VersionTLS13`
5. **معالجة السجلات المعلقة**: يستنزف أي رسائل ما بعد المصافحة من مخزن TLS المؤقت
6. **إعداد النواة**: يستدعي `setupKernel` مع حالة التشفير المُستخرجة

## إعداد النواة (Linux)

```go
func (c *Conn) setupKernel(txOffload, rxOffload bool) error {
    // 1. Set TCP_ULP to "tls"
    rawSyscallConn.Control(func(fd uintptr) {
        unix.SetsockoptString(int(fd), unix.SOL_TCP, unix.TCP_ULP, "tls")
    })

    // 2. Extract cipher info and setup TX/RX
    cipherInfo := kernelCipher(c.rawConn)
    if txOffload {
        unix.SetsockoptString(int(fd), SOL_TLS, TLS_TX, cipherInfo.txData)
        c.kernelTx = true
    }
    if rxOffload {
        unix.SetsockoptString(int(fd), SOL_TLS, TLS_RX, cipherInfo.rxData)
        c.kernelRx = true
    }

    // 3. Enable TX zerocopy (optional)
    unix.SetsockoptInt(int(fd), SOL_TLS, TLS_TX_ZEROCOPY_RO, 1)
    // 4. Disable RX padding (optional)
    unix.SetsockoptInt(int(fd), SOL_TLS, TLS_RX_EXPECT_NO_PAD, 1)
}
```

### مجموعات التشفير المدعومة

يُترجم مُعيِّن تشفير النواة معرفات مجموعات تشفير TLS إلى هياكل تشفير خاصة بالنواة:

| مجموعة تشفير TLS | تشفير النواة | حجم المفتاح |
|------------------|---------------|----------|
| `TLS_AES_128_GCM_SHA256` | `TLS_CIPHER_AES_GCM_128` | 16 بايت |
| `TLS_AES_256_GCM_SHA384` | `TLS_CIPHER_AES_GCM_256` | 32 بايت |
| `TLS_CHACHA20_POLY1305_SHA256` | `TLS_CIPHER_CHACHA20_POLY1305` | 32 بايت |
| `TLS_AES_128_CCM_SHA256` | `TLS_CIPHER_AES_CCM_128` | 16 بايت |

يحتوي كل هيكل تشفير على: إصدار TLS، نوع التشفير، المتجه الأولي (IV)، المفتاح، الملح، ورقم تسلسل السجل، مُستخرجة من الحالة الداخلية لاتصال TLS.

### اكتشاف إصدار النواة

يعتمد توفر الميزات على إصدار النواة:

| الميزة | الحد الأدنى للنواة |
|---------|---------------|
| kTLS أساسي (TX) | 4.13 |
| kTLS RX | 4.17 |
| AES-256-GCM | 5.1 |
| ChaCha20-Poly1305 | 5.11 |
| TX بدون نسخ | 5.19 |
| RX بدون حشو | 6.0 |
| تحديث المفتاح | 6.14 |

## دعم Splice

يوفر kTLS الدالتين `SyscallConnForRead` و `SyscallConnForWrite` لتمكين splice على مستوى النواة:

```go
func (c *Conn) SyscallConnForRead() syscall.RawConn {
    if !c.kernelRx { return nil }
    if !*c.rawConn.IsClient {
        c.logger.WarnContext(c.ctx, "ktls: RX splice is unavailable on the server side")
        return nil
    }
    return c.rawSyscallConn
}

func (c *Conn) SyscallConnForWrite() syscall.RawConn {
    if !c.kernelTx { return nil }
    return c.rawSyscallConn
}
```

splice للاستقبال (RX) متاح فقط على جانب العميل بسبب قيد معروف في النواة.

## معالجة الأخطاء

السجلات غير التطبيقية أثناء splice للاستقبال تُرجع `EINVAL`:

```go
func (c *Conn) HandleSyscallReadError(inputErr error) ([]byte, error) {
    if errors.Is(inputErr, unix.EINVAL) {
        c.pendingRxSplice = true
        err := c.readRecord()  // Read and process the non-app record
        // Return any buffered application data
    } else if errors.Is(inputErr, unix.EBADMSG) {
        return nil, c.rawConn.In.SetErrorLocked(c.sendAlert(alertBadRecordMAC))
    }
}
```

## مسار الكتابة

يستخدم مسار كتابة TX للنواة `sendmsg` مع رسائل تحكم للإشارة إلى نوع سجل TLS:

```go
func (c *Conn) writeKernelRecord(b []byte, recordType byte) (int, error) {
    // Uses cmsg with SOL_TLS/TLS_SET_RECORD_TYPE
    // Splits writes at MSS boundaries for optimal performance
}
```

## الإغلاق

يُرسل الإغلاق تنبيه close_notify لـ TLS عبر النواة:

```go
func (c *Conn) Close() error {
    if c.kernelTx {
        c.writeKernelRecord([]byte{alertCloseNotify}, recordTypeAlert)
    }
    return c.conn.Close()
}
```

## اعتبارات الأداء

يُحذِّر مطورو sing-box صراحة بشأن أداء kTLS:

- kTLS TX مفيد فقط في سيناريوهات `sendfile`/`splice` (خدمة الملفات، الوكالة بين اتصالات kTLS)
- kTLS RX "سيُقلل الأداء بالتأكيد" وفقًا لتحذيرات الشفرة المصدرية
- يتجنب تنفيذ TLS في النواة تبديل السياق للتشفير لكنه يُضيف عبئًا لتأطير السجلات
- kTLS أكثر فائدة لسيناريوهات الإنتاجية العالية والحمل المنخفض على المعالج
