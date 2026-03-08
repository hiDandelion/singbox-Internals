# نظام المستمع

يوفر نظام المستمع تنفيذات مشتركة لمستمعات TCP وUDP تستخدمها جميع بروتوكولات الوارد.

**المصدر**: `common/listener/`

## مستمع TCP

```go
type Listener struct {
    ctx          context.Context
    logger       logger.ContextLogger
    network      []string
    listenAddr   netip.AddrPort
    tcpListener  *net.TCPListener
    handler      adapter.ConnectionHandlerEx
    threadUnsafe bool
    // TLS، بروتوكول البروكسي، إلخ.
}
```

### الميزات

- **عنوان الاستماع**: الربط بعنوان IPv4/IPv6 ومنفذ محدد
- **خيارات TCP**: `SO_REUSEADDR`، `TCP_FASTOPEN`، `TCP_DEFER_ACCEPT`
- **بروتوكول البروكسي**: دعم بروتوكول بروكسي HAProxy الإصدار 1/2
- **آمن/غير آمن للخيوط**: وضع goroutine واحد اختياري للبروتوكولات التي تحتاجه

### حلقة القبول

```go
func (l *Listener) loopTCPIn() {
    for {
        conn, err := l.tcpListener.AcceptTCP()
        if err != nil {
            return
        }
        // تطبيق بروتوكول البروكسي إذا كان معداً
        // التغليف بـ TLS إذا كان معداً
        go l.handler.NewConnectionEx(ctx, conn, metadata, onClose)
    }
}
```

## مستمع UDP

```go
type UDPListener struct {
    ctx        context.Context
    logger     logger.ContextLogger
    listenAddr netip.AddrPort
    udpConn    *net.UDPConn
    handler    adapter.PacketHandlerEx
    // معالج OOB لـ TProxy
}
```

### الميزات

- **بيانات OOB**: لـ TProxy، تحمل البيانات خارج النطاق الوجهة الأصلية
- **معالج الحزم**: يمرر الحزم الفردية مع عنوان المصدر

### حلقة القراءة

```go
func (l *UDPListener) loopUDPIn() {
    buffer := buf.NewPacket()
    for {
        n, addr, err := l.udpConn.ReadFromUDPAddrPort(buffer.FreeBytes())
        if err != nil {
            return
        }
        buffer.Truncate(n)
        l.handler.NewPacketEx(buffer, M.SocksaddrFromNetIP(addr))
        buffer = buf.NewPacket()
    }
}
```

## خيارات الاستماع المشتركة

```go
type ListenOptions struct {
    Listen         ListenAddress
    ListenPort     uint16
    ListenFields   ListenFields
    TCPFastOpen    bool
    TCPMultiPath   bool
    UDPFragment    *bool
    UDPTimeout     Duration
    ProxyProtocol  bool
    ProxyProtocolAcceptNoHeader bool
    Detour         string
    InboundOptions
}

type InboundOptions struct {
    SniffEnabled              bool
    SniffOverrideDestination  bool
    SniffTimeout              Duration
    DomainStrategy            DomainStrategy
}
```

## دعم بروتوكول البروكسي

عند تعيين `proxy_protocol: true`، يغلّف المستمع الاتصالات بتحليل بروتوكول البروكسي:

```go
import proxyproto "github.com/pires/go-proxyproto"

listener = &proxyproto.Listener{
    Listener: tcpListener,
    Policy: func(upstream net.Addr) (proxyproto.Policy, error) {
        if acceptNoHeader {
            return proxyproto.USE, nil
        }
        return proxyproto.REQUIRE, nil
    },
}
```

يستخرج هذا عنوان العميل الأصلي من خلف موازنات التحميل/البروكسيات العكسية.
