# نقل QUIC

المصدر: `transport/v2rayquic/client.go`، `transport/v2rayquic/server.go`، `transport/v2rayquic/stream.go`، `transport/v2rayquic/init.go`

## نظرة عامة

يوفر نقل QUIC تعدد التدفقات عبر اتصال QUIC واحد. يتطلب علامة البناء `with_quic` ويستخدم `github.com/sagernet/quic-go`. بروتوكول TLS إلزامي -- يتطلب QUIC الإصدار TLS 1.3.

## التسجيل

يستخدم نقل QUIC نمط التسجيل وقت التهيئة لأنه يعتمد على حزمة مقيدة بعلامة بناء:

```go
//go:build with_quic

package v2rayquic

func init() {
    v2ray.RegisterQUICConstructor(NewServer, NewClient)
}
```

## العميل

### التخزين المؤقت للاتصال

يحتفظ العميل باتصال QUIC واحد، وينشئ تدفقات جديدة لكل طلب اتصال:

```go
type Client struct {
    ctx        context.Context
    dialer     N.Dialer
    serverAddr M.Socksaddr
    tlsConfig  tls.Config
    quicConfig *quic.Config
    connAccess sync.Mutex
    conn       common.TypedValue[*quic.Conn]
    rawConn    net.Conn
}
```

تستخدم دالة `offer` القفل المزدوج التحقق لإعادة استخدام أو إنشاء اتصال QUIC:

```go
func (c *Client) offer() (*quic.Conn, error) {
    conn := c.conn.Load()
    if conn != nil && !common.Done(conn.Context()) {
        return conn, nil
    }
    c.connAccess.Lock()
    defer c.connAccess.Unlock()
    conn = c.conn.Load()
    if conn != nil && !common.Done(conn.Context()) {
        return conn, nil
    }
    return c.offerNew()
}
```

### إنشاء الاتصال

```go
func (c *Client) offerNew() (*quic.Conn, error) {
    udpConn, err := c.dialer.DialContext(c.ctx, "udp", c.serverAddr)
    packetConn := bufio.NewUnbindPacketConn(udpConn)
    quicConn, err := qtls.Dial(c.ctx, packetConn, udpConn.RemoteAddr(), c.tlsConfig, c.quicConfig)
    c.conn.Store(quicConn)
    c.rawConn = udpConn
    return quicConn, nil
}
```

ينشئ طالب الاتصال اتصال UDP، ثم يغلفه كـ `PacketConn` لمكتبة QUIC. الدالة `qtls.Dial` هي غلاف sing-box حول `quic.Dial` يكيف واجهة إعدادات TLS.

### الاتصال

كل استدعاء لـ `DialContext` يفتح تدفق QUIC جديدًا على الاتصال المُخزَّن مؤقتًا:

```go
func (c *Client) DialContext(ctx context.Context) (net.Conn, error) {
    conn, err := c.offer()
    stream, err := conn.OpenStream()
    return &StreamWrapper{Conn: conn, Stream: stream}, nil
}
```

### إعدادات QUIC

```go
quicConfig := &quic.Config{
    DisablePathMTUDiscovery: !C.IsLinux && !C.IsWindows,
}
if len(tlsConfig.NextProtos()) == 0 {
    tlsConfig.SetNextProtos([]string{http3.NextProtoH3})
}
```

يُعطَّل اكتشاف MTU للمسار على المنصات غير Linux/Windows. ALPN الافتراضي هو `h3` (معرف بروتوكول HTTP/3).

## الخادم

### حلقة القبول

يستخدم الخادم حلقة قبول ذات مستويين -- واحدة لاتصالات QUIC، وواحدة للتدفقات داخل كل اتصال:

```go
func (s *Server) ServePacket(listener net.PacketConn) error {
    quicListener, err := qtls.Listen(listener, s.tlsConfig, s.quicConfig)
    s.quicListener = quicListener
    go s.acceptLoop()
    return nil
}

func (s *Server) acceptLoop() {
    for {
        conn, err := s.quicListener.Accept(s.ctx)
        if err != nil { return }
        go func() {
            hErr := s.streamAcceptLoop(conn)
            if hErr != nil && !E.IsClosedOrCanceled(hErr) {
                s.logger.ErrorContext(conn.Context(), hErr)
            }
        }()
    }
}

func (s *Server) streamAcceptLoop(conn *quic.Conn) error {
    for {
        stream, err := conn.AcceptStream(s.ctx)
        if err != nil { return qtls.WrapError(err) }
        go s.handler.NewConnectionEx(conn.Context(),
            &StreamWrapper{Conn: conn, Stream: stream},
            M.SocksaddrFromNet(conn.RemoteAddr()), M.Socksaddr{}, nil)
    }
}
```

كل اتصال QUIC مقبول يُنشئ goroutine تقبل التدفقات. كل تدفق يُنشئ goroutine للمعالج.

### الشبكة

على عكس وسائل النقل الأخرى، يعمل QUIC على UDP:

```go
func (s *Server) Network() []string {
    return []string{N.NetworkUDP}
}

func (s *Server) Serve(listener net.Listener) error {
    return os.ErrInvalid  // TCP not supported
}
```

## StreamWrapper

يُكيِّف تدفق QUIC ليكون `net.Conn`:

```go
type StreamWrapper struct {
    Conn *quic.Conn
    *quic.Stream
}

func (s *StreamWrapper) Read(p []byte) (n int, err error) {
    n, err = s.Stream.Read(p)
    return n, qtls.WrapError(err)
}

func (s *StreamWrapper) Write(p []byte) (n int, err error) {
    n, err = s.Stream.Write(p)
    return n, qtls.WrapError(err)
}

func (s *StreamWrapper) LocalAddr() net.Addr {
    return s.Conn.LocalAddr()
}

func (s *StreamWrapper) RemoteAddr() net.Addr {
    return s.Conn.RemoteAddr()
}

func (s *StreamWrapper) Close() error {
    s.CancelRead(0)
    s.Stream.Close()
    return nil
}
```

يوفر الغلاف `LocalAddr`/`RemoteAddr` من اتصال QUIC (لأن التدفقات لا تملك عناوين مستقلة) ويغلف أخطاء QUIC عبر `qtls.WrapError`. يُلغي الإغلاق جانب القراءة ويُغلق جانب الكتابة.

## الإعدادات

```json
{
  "transport": {
    "type": "quic"
  }
}
```

لا يحتوي نقل QUIC على خيارات إضافية بخلاف النوع. TLS مطلوب دائمًا ويجب تعيينه بشكل منفصل على الوارد/الصادر.
