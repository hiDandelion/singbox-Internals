# مدير الاتصالات

يتعامل مدير الاتصالات مع النقل الفعلي للبيانات بين الاتصالات الواردة والصادرة. يتصل بالخادم البعيد، ويُعدّ النسخ ثنائي الاتجاه، ويدير دورة حياة الاتصال.

**المصدر**: `route/conn.go`

## الهيكل

```go
type ConnectionManager struct {
    logger      logger.ContextLogger
    access      sync.Mutex
    connections list.List[io.Closer]  // الاتصالات النشطة المتتبعة
}
```

## تدفق اتصال TCP (`NewConnection`)

```go
func (m *ConnectionManager) NewConnection(ctx, this N.Dialer, conn net.Conn, metadata, onClose) {
    // 1. الاتصال بالخادم البعيد
    if len(metadata.DestinationAddresses) > 0 || metadata.Destination.IsIP() {
        remoteConn, err = dialer.DialSerialNetwork(ctx, this, "tcp",
            metadata.Destination, metadata.DestinationAddresses,
            metadata.NetworkStrategy, metadata.NetworkType,
            metadata.FallbackNetworkType, metadata.FallbackDelay)
    } else {
        remoteConn, err = this.DialContext(ctx, "tcp", metadata.Destination)
    }

    // 2. الإبلاغ عن نجاح المصافحة (للبروتوكولات التي تحتاجها)
    N.ReportConnHandshakeSuccess(conn, remoteConn)

    // 3. تطبيق تجزئة TLS إذا طُلب
    if metadata.TLSFragment || metadata.TLSRecordFragment {
        remoteConn = tf.NewConn(remoteConn, ctx, ...)
    }

    // 4. بدء المصافحة (إرسال البيانات المبكرة)
    m.kickWriteHandshake(ctx, conn, remoteConn, false, &done, onClose)
    m.kickWriteHandshake(ctx, remoteConn, conn, true, &done, onClose)

    // 5. النسخ ثنائي الاتجاه
    go m.connectionCopy(ctx, conn, remoteConn, false, &done, onClose)
    go m.connectionCopy(ctx, remoteConn, conn, true, &done, onClose)
}
```

### بدء المصافحة

بعض البروتوكولات (مثل بروتوكولات البروكسي ذات المصافحة المؤجلة) تحتاج أن تُكتب البيانات الأولى قبل أن يكتمل إنشاء الاتصال. `kickWriteHandshake` يتعامل مع هذا:

```go
func (m *ConnectionManager) kickWriteHandshake(ctx, source, destination, direction, done, onClose) bool {
    if !N.NeedHandshakeForWrite(destination) {
        return false  // لا حاجة لمصافحة
    }

    // محاولة قراءة البيانات المخزنة مؤقتاً من المصدر
    if cachedReader, ok := sourceReader.(N.CachedReader); ok {
        cachedBuffer = cachedReader.ReadCached()
    }

    if cachedBuffer != nil {
        // كتابة البيانات المخزنة لتفعيل المصافحة
        _, err = destinationWriter.Write(cachedBuffer.Bytes())
    } else {
        // كتابة فارغة لتفعيل المصافحة
        destination.SetWriteDeadline(time.Now().Add(C.ReadPayloadTimeout))
        _, err = destinationWriter.Write(nil)
    }
    // ...
}
```

هذا يسمح بإرسال البيانات المبكرة (مثل TLS ClientHello) مع مصافحة بروتوكول البروكسي، مما يقلل الجولات.

### النسخ ثنائي الاتجاه

```go
func (m *ConnectionManager) connectionCopy(ctx, source, destination, direction, done, onClose) {
    _, err := bufio.CopyWithIncreateBuffer(destination, source,
        bufio.DefaultIncreaseBufferAfter, bufio.DefaultBatchSize)

    if err != nil {
        common.Close(source, destination)
    } else if duplexDst, isDuplex := destination.(N.WriteCloser); isDuplex {
        duplexDst.CloseWrite()  // نصف إغلاق للإيقاف الرشيق
    } else {
        destination.Close()
    }

    // done هو ذري — أول goroutine ينتهي يعيّنه
    if done.Swap(true) {
        // الـ goroutine الثاني: استدعاء onClose وإغلاق الاثنين
        if onClose != nil { onClose(err) }
        common.Close(source, destination)
    }
}
```

السلوكيات الرئيسية:
- يستخدم `bufio.CopyWithIncreateBuffer` لتحجيم المخزن المؤقت التكيفي
- يدعم نصف الإغلاق (FIN) عبر `N.WriteCloser`
- `atomic.Bool` يضمن استدعاء `onClose` مرة واحدة بالضبط
- يسجّل اتجاه الرفع/التنزيل بشكل منفصل

## تدفق اتصال UDP (`NewPacketConnection`)

```go
func (m *ConnectionManager) NewPacketConnection(ctx, this, conn, metadata, onClose) {
    if metadata.UDPConnect {
        // UDP متصل: الاتصال بوجهة محددة
        remoteConn, err = this.DialContext(ctx, "udp", metadata.Destination)
        remotePacketConn = bufio.NewUnbindPacketConn(remoteConn)
    } else {
        // UDP غير متصل: الاستماع للحزم
        remotePacketConn, destinationAddress, err = this.ListenPacket(ctx, metadata.Destination)
    }

    // معالجة NAT: ترجمة العناوين إذا اختلف عنوان IP المحلول عن النطاق
    if destinationAddress.IsValid() {
        remotePacketConn = bufio.NewNATPacketConn(remotePacketConn, destination, originDestination)
    }

    // مهلة UDP (واعية بالبروتوكول)
    if udpTimeout > 0 {
        ctx, conn = canceler.NewPacketConn(ctx, conn, udpTimeout)
    }

    // نسخ حزم ثنائي الاتجاه
    go m.packetConnectionCopy(ctx, conn, destination, false, &done, onClose)
    go m.packetConnectionCopy(ctx, destination, conn, true, &done, onClose)
}
```

### مهلة UDP

تُحدد مهلة UDP بترتيب الأولوية:
1. `metadata.UDPTimeout` (تُعيّن بواسطة إجراء القاعدة)
2. `C.ProtocolTimeouts[protocol]` (خاصة بالبروتوكول، مثل DNS = 10 ثوانٍ)
3. المهلة الافتراضية

### NAT PacketConn

عندما يحل DNS نطاقاً إلى عنوان IP، يستخدم المقبس البعيد عنوان IP. لكن العميل يتوقع استجابات من النطاق الأصلي. `bufio.NewNATPacketConn` يترجم العناوين:

```
العميل ← conn.ReadPacket() ← {dest: example.com:443}
         ↓ ترجمة NAT
البعيد ← remoteConn.WritePacket() ← {dest: 1.2.3.4:443}
         ↓ استجابة
البعيد ← remoteConn.ReadPacket() ← {from: 1.2.3.4:443}
         ↓ ترجمة NAT عكسية
العميل ← conn.WritePacket() ← {from: example.com:443}
```

## تتبع الاتصالات

يتتبع مدير الاتصالات جميع الاتصالات النشطة للمراقبة والتنظيف:

```go
func (m *ConnectionManager) TrackConn(conn net.Conn) net.Conn {
    element := m.connections.PushBack(conn)
    return &trackedConn{Conn: conn, manager: m, element: element}
}

// trackedConn يزيل نفسه من القائمة عند Close()
func (c *trackedConn) Close() error {
    c.manager.connections.Remove(c.element)
    return c.Conn.Close()
}
```

يُستدعى `CloseAll()` أثناء الإيقاف لإنهاء جميع الاتصالات النشطة.

## الاتصال التسلسلي

عندما تتوفر عناوين وجهة متعددة (من حل DNS)، يجربها `dialer.DialSerialNetwork` بالترتيب:

```go
// يجرب كل عنوان، مع احترام استراتيجية الشبكة (تفضيل الخلوي، إلخ.)
func DialSerialNetwork(ctx, dialer, network, destination, addresses,
    strategy, networkType, fallbackType, fallbackDelay) (net.Conn, error)
```

يتكامل هذا مع نظام استراتيجية الشبكة للأجهزة متعددة الواجهات (المحمولة).
