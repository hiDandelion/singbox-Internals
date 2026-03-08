# وكلاء Redirect وTProxy الشفافة

Redirect وTProxy هما آليتا وكيل شفاف خاصتان بـ Linux. يعترض Redirect اتصالات TCP عبر `iptables REDIRECT`، بينما يعترض TProxy كلاً من TCP وUDP عبر `iptables TPROXY`. كلاهما يستخرج عنوان الوجهة الأصلي من بنى بيانات النواة.

**المصدر**: `protocol/redirect/redirect.go`، `protocol/redirect/tproxy.go`، `common/redir/`

## وارد Redirect

### البنية

```go
type Redirect struct {
    inbound.Adapter
    router   adapter.Router
    logger   log.ContextLogger
    listener *listener.Listener
}
```

### TCP فقط

يدعم Redirect TCP فقط (تقوم النواة بإعادة توجيه اتصالات TCP إلى المستمع المحلي):

```go
redirect.listener = listener.New(listener.Options{
    Network:           []string{N.NetworkTCP},
    ConnectionHandler: redirect,
})
```

### استخراج الوجهة الأصلية

العملية الرئيسية هي استرجاع الوجهة الأصلية من المقبس المعاد توجيهه باستخدام `SO_ORIGINAL_DST`:

```go
func (h *Redirect) NewConnectionEx(ctx, conn, metadata, onClose) {
    destination, err := redir.GetOriginalDestination(conn)
    if err != nil {
        conn.Close()
        h.logger.ErrorContext(ctx, "get redirect destination: ", err)
        return
    }
    metadata.Inbound = h.Tag()
    metadata.InboundType = h.Type()
    metadata.Destination = M.SocksaddrFromNetIP(destination)
    h.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

تستدعي دالة `redir.GetOriginalDestination` الأمر `getsockopt(fd, SOL_IP, SO_ORIGINAL_DST)` (أو `IP6T_SO_ORIGINAL_DST` لـ IPv6) لاسترجاع عنوان الوجهة الأصلي الذي أعاد iptables كتابته.

### قاعدة iptables المطلوبة

```bash
iptables -t nat -A PREROUTING -p tcp --dport 1:65535 -j REDIRECT --to-ports <listen_port>
```

## وارد TProxy

### البنية

```go
type TProxy struct {
    inbound.Adapter
    ctx      context.Context
    router   adapter.Router
    logger   log.ContextLogger
    listener *listener.Listener
    udpNat   *udpnat.Service
}
```

### دعم TCP + UDP

يدعم TProxy كلاً من TCP وUDP:

```go
tproxy.listener = listener.New(listener.Options{
    Network:           options.Network.Build(),
    ConnectionHandler: tproxy,
    OOBPacketHandler:  tproxy,   // UDP مع بيانات OOB
    TProxy:            true,
})
```

تخبر علامة `TProxy: true` المستمع بتعيين خيار المقبس `IP_TRANSPARENT`.

### معالجة TCP

بالنسبة لـ TCP، الوجهة الأصلية هي العنوان المحلي للمقبس (يحافظ TProxy عليه):

```go
func (t *TProxy) NewConnectionEx(ctx, conn, metadata, onClose) {
    metadata.Inbound = t.Tag()
    metadata.InboundType = t.Type()
    metadata.Destination = M.SocksaddrFromNet(conn.LocalAddr()).Unwrap()
    t.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### معالجة UDP مع OOB

تصل حزم UDP مع بيانات خارج النطاق (OOB) تحتوي على الوجهة الأصلية. تعالج واجهة `OOBPacketHandler` هذه البيانات:

```go
func (t *TProxy) NewPacketEx(buffer *buf.Buffer, oob []byte, source M.Socksaddr) {
    destination, err := redir.GetOriginalDestinationFromOOB(oob)
    if err != nil {
        t.logger.Warn("get tproxy destination: ", err)
        return
    }
    t.udpNat.NewPacket([][]byte{buffer.Bytes()}, source, M.SocksaddrFromNetIP(destination), nil)
}
```

تحلل دالة `redir.GetOriginalDestinationFromOOB` رسالة `IP_RECVORIGDSTADDR` المساعدة من بيانات OOB لاستخراج الوجهة الأصلية.

### NAT لـ UDP

يستخدم TProxy خدمة `udpnat.Service` لتتبع جلسات UDP:

```go
tproxy.udpNat = udpnat.New(tproxy, tproxy.preparePacketConnection, udpTimeout, false)
```

عند إنشاء جلسة UDP جديدة، يتم إنشاء كاتب حزم يمكنه إرسال الاستجابات:

```go
func (t *TProxy) preparePacketConnection(source, destination, userData) (bool, context.Context, N.PacketWriter, N.CloseHandlerFunc) {
    writer := &tproxyPacketWriter{
        listener:    t.listener,
        source:      source.AddrPort(),
        destination: destination,
    }
    return true, ctx, writer, func(it error) {
        common.Close(common.PtrOrNil(writer.conn))
    }
}
```

### كتابة استجابة UDP في TProxy

يجب أن يرسل كاتب حزم TProxy استجابات UDP بعنوان مصدر مزور (الوجهة الأصلية). يتطلب هذا `IP_TRANSPARENT` و`SO_REUSEADDR`:

```go
func (w *tproxyPacketWriter) WritePacket(buffer *buf.Buffer, destination M.Socksaddr) error {
    // إعادة استخدام الاتصال المخزن مؤقتاً إذا تطابقت الوجهة
    if w.destination == destination && w.conn != nil {
        _, err := w.conn.WriteToUDPAddrPort(buffer.Bytes(), w.source)
        return err
    }

    // إنشاء مقبس جديد مرتبط بالوجهة (المصدر المزور)
    var listenConfig net.ListenConfig
    listenConfig.Control = control.Append(listenConfig.Control, control.ReuseAddr())
    listenConfig.Control = control.Append(listenConfig.Control, redir.TProxyWriteBack())
    packetConn, _ := w.listener.ListenPacket(listenConfig, w.ctx, "udp", destination.String())
    udpConn := packetConn.(*net.UDPConn)
    udpConn.WriteToUDPAddrPort(buffer.Bytes(), w.source)
}
```

تعين دالة التحكم `redir.TProxyWriteBack()` الخيار `IP_TRANSPARENT` على مقبس الاستجابة، مما يسمح له بالارتباط بعنوان غير محلي (الوجهة الأصلية) بحيث تبدو الاستجابة قادمة من المصدر الصحيح.

### قواعد iptables المطلوبة

```bash
# TCP
iptables -t mangle -A PREROUTING -p tcp --dport 1:65535 -j TPROXY \
    --on-port <listen_port> --tproxy-mark 0x1/0x1

# UDP
iptables -t mangle -A PREROUTING -p udp --dport 1:65535 -j TPROXY \
    --on-port <listen_port> --tproxy-mark 0x1/0x1

# توجيه الحزم المعلمة إلى الاسترجاع
ip rule add fwmark 0x1/0x1 lookup 100
ip route add local default dev lo table 100
```

## أمثلة على التكوين

### Redirect

```json
{
  "type": "redirect",
  "tag": "redirect-in",
  "listen": "::",
  "listen_port": 12345
}
```

### TProxy

```json
{
  "type": "tproxy",
  "tag": "tproxy-in",
  "listen": "::",
  "listen_port": 12345,
  "network": ["tcp", "udp"],
  "udp_timeout": "5m"
}
```

## قيود المنصة

كل من Redirect وTProxy **خاصان بـ Linux فقط**. تحتوي حزمة `redir` على تنفيذات خاصة بالمنصة:

- `redir.GetOriginalDestination(conn)` -- يستخدم `getsockopt(SO_ORIGINAL_DST)`، Linux فقط
- `redir.GetOriginalDestinationFromOOB(oob)` -- يحلل بيانات `IP_RECVORIGDSTADDR` المساعدة، Linux فقط
- `redir.TProxyWriteBack()` -- يعين `IP_TRANSPARENT`، Linux فقط

على المنصات غير Linux، هذه البروتوكولات غير متاحة. استخدم وارد TUN بدلاً من ذلك للوكيل الشفاف.
