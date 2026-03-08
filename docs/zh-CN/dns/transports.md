# DNS 传输层

源码：`dns/transport_registry.go`、`dns/transport_adapter.go`、`dns/transport/base.go`、`dns/transport/connector.go`、`dns/transport/udp.go`、`dns/transport/tcp.go`、`dns/transport/tls.go`、`dns/transport/https.go`

## Transport Registry

注册表使用 Go 泛型实现类型安全的传输层注册：

```go
func RegisterTransport[Options any](registry *TransportRegistry, transportType string,
    constructor TransportConstructorFunc[Options]) {
    registry.register(transportType, func() any {
        return new(Options)
    }, func(ctx context.Context, logger log.ContextLogger, tag string, rawOptions any) (adapter.DNSTransport, error) {
        var options *Options
        if rawOptions != nil {
            options = rawOptions.(*Options)
        }
        return constructor(ctx, logger, tag, common.PtrValueOrDefault(options))
    })
}
```

泛型 `Options` 类型在注册时通过 `any` 包装器被擦除，使注册表能够存储异构的构造函数，同时在注册时提供类型安全的构造。

每个传输层自行注册：
```go
func RegisterUDP(registry *dns.TransportRegistry)  { dns.RegisterTransport[option.RemoteDNSServerOptions](...) }
func RegisterTCP(registry *dns.TransportRegistry)  { dns.RegisterTransport[option.RemoteDNSServerOptions](...) }
func RegisterTLS(registry *dns.TransportRegistry)  { dns.RegisterTransport[option.RemoteTLSDNSServerOptions](...) }
func RegisterHTTPS(registry *dns.TransportRegistry) { dns.RegisterTransport[option.RemoteHTTPSDNSServerOptions](...) }
```

## Base Transport

提供状态机和运行中查询追踪以实现优雅关闭：

```go
type TransportState int

const (
    StateNew TransportState = iota
    StateStarted
    StateClosing
    StateClosed
)

type BaseTransport struct {
    dns.TransportAdapter
    Logger logger.ContextLogger
    mutex           sync.Mutex
    state           TransportState
    inFlight        int32
    queriesComplete chan struct{}
    closeCtx        context.Context
    closeCancel     context.CancelFunc
}
```

### 查询生命周期

```go
func (t *BaseTransport) BeginQuery() bool {
    t.mutex.Lock()
    defer t.mutex.Unlock()
    if t.state != StateStarted { return false }
    t.inFlight++
    return true
}

func (t *BaseTransport) EndQuery() {
    t.mutex.Lock()
    if t.inFlight > 0 { t.inFlight-- }
    if t.inFlight == 0 && t.queriesComplete != nil {
        close(t.queriesComplete)
    }
    t.mutex.Unlock()
}
```

### 优雅关闭

```go
func (t *BaseTransport) Shutdown(ctx context.Context) error {
    t.state = StateClosing
    if t.inFlight == 0 {
        t.state = StateClosed
        t.closeCancel()
        return nil
    }
    t.queriesComplete = make(chan struct{})
    t.closeCancel()
    select {
    case <-queriesComplete:  // 等待运行中的查询完成
    case <-ctx.Done():       // 超时
    }
    t.state = StateClosed
    return nil
}
```

## 通用 Connector

提供带递归拨号检测的 singleflight 连接管理：

```go
type Connector[T any] struct {
    dial      func(ctx context.Context) (T, error)
    callbacks ConnectorCallbacks[T]
    access           sync.Mutex
    connection       T
    hasConnection    bool
    connectionCancel context.CancelFunc
    connecting       chan struct{}  // Singleflight 信号
    closeCtx context.Context
}
```

### Singleflight Get

```go
func (c *Connector[T]) Get(ctx context.Context) (T, error) {
    for {
        c.access.Lock()
        // 快速路径：已有连接
        if c.hasConnection && !c.callbacks.IsClosed(c.connection) {
            return c.connection, nil
        }
        // 递归拨号检测
        if isRecursiveConnectorDial(ctx, c) {
            return zero, errRecursiveConnectorDial
        }
        // Singleflight：等待进行中的拨号
        if c.connecting != nil {
            <-c.connecting
            continue  // 拨号完成后重试
        }
        // 发起新的拨号
        c.connecting = make(chan struct{})
        c.access.Unlock()
        connection, cancel, err := c.dialWithCancellation(dialContext)
        // 存储并返回
    }
}
```

递归拨号检测使用 context key 来追踪正在拨号的 connector：

```go
func isRecursiveConnectorDial[T any](ctx context.Context, connector *Connector[T]) bool {
    dialConnector, loaded := ctx.Value(contextKeyConnecting{}).(*Connector[T])
    return loaded && dialConnector == connector
}
```

## UDP Transport

最复杂的传输层，通过单个 UDP 连接实现基于回调的多路复用：

```go
type UDPTransport struct {
    *BaseTransport
    dialer     N.Dialer
    serverAddr M.Socksaddr
    udpSize    atomic.Int32
    connector  *Connector[*Connection]
    callbackAccess sync.RWMutex
    queryId        uint16
    callbacks      map[uint16]*udpCallback
}
```

### 查询 ID 管理

```go
func (t *UDPTransport) nextAvailableQueryId() (uint16, error) {
    start := t.queryId
    for {
        t.queryId++
        if _, exists := t.callbacks[t.queryId]; !exists {
            return t.queryId, nil
        }
        if t.queryId == start {
            return 0, E.New("no available query ID")
        }
    }
}
```

### Exchange 流程

1. 通过 connector 获取或创建 UDP 连接
2. 分配唯一的查询 ID，注册回调
3. 使用分配的 ID 发送 DNS 消息
4. 等待回调信号、连接关闭、传输层关闭或 context 取消
5. 在响应中恢复原始消息 ID

### 接收循环

```go
func (t *UDPTransport) recvLoop(conn *Connection) {
    for {
        buffer := buf.NewSize(int(t.udpSize.Load()))
        _, err := buffer.ReadOnceFrom(conn)
        // 解析 DNS 消息
        // 通过消息 ID 查找回调
        callback.response = &message
        close(callback.done)  // 通知等待中的 Exchange
    }
}
```

### 截断回退

如果 UDP 响应设置了 `Truncated` 标志，传输层会自动通过 TCP 重试：

```go
func (t *UDPTransport) Exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    response, err := t.exchange(ctx, message)
    if response.Truncated {
        t.Logger.InfoContext(ctx, "response truncated, retrying with TCP")
        return t.exchangeTCP(ctx, message)
    }
    return response, nil
}
```

### EDNS0 UDP 大小追踪

传输层追踪来自 EDNS0 OPT 记录的最大 UDP 大小，并在请求更大的大小时重置连接：

```go
if edns0Opt := message.IsEdns0(); edns0Opt != nil {
    udpSize := int32(edns0Opt.UDPSize())
    if t.udpSize.CompareAndSwap(current, udpSize) {
        t.connector.Reset()
    }
}
```

## TCP Transport

简单的逐查询连接模型：

```go
func (t *TCPTransport) Exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    conn, err := t.dialer.DialContext(ctx, N.NetworkTCP, t.serverAddr)
    defer conn.Close()
    WriteMessage(conn, 0, message)
    return ReadMessage(conn)
}
```

### DNS-over-TCP 线格式

```go
func WriteMessage(writer io.Writer, messageId uint16, message *mDNS.Msg) error {
    binary.Write(buffer, binary.BigEndian, uint16(requestLen))
    // 将 DNS 消息打包到缓冲区
    writer.Write(buffer.Bytes())
}

func ReadMessage(reader io.Reader) (*mDNS.Msg, error) {
    var responseLen uint16
    binary.Read(reader, binary.BigEndian, &responseLen)
    // 读取 responseLen 字节并解包
}
```

2 字节大端序长度前缀后跟原始 DNS 消息。

## TLS Transport（DoT）

通过链表实现连接池：

```go
type TLSTransport struct {
    *BaseTransport
    dialer      tls.Dialer
    serverAddr  M.Socksaddr
    connections list.List[*tlsDNSConn]
}

func (t *TLSTransport) Exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    // 先尝试池中的连接
    t.access.Lock()
    conn := t.connections.PopFront()
    t.access.Unlock()
    if conn != nil {
        response, err := t.exchange(ctx, message, conn)
        if err == nil { return response, nil }
        // 丢弃失败的池化连接
    }
    // 创建新的 TLS 连接
    tlsConn, err := t.dialer.DialTLSContext(ctx, t.serverAddr)
    return t.exchange(ctx, message, &tlsDNSConn{Conn: tlsConn})
}
```

交换成功后，连接会被归还到池中：

```go
func (t *TLSTransport) exchange(ctx context.Context, message *mDNS.Msg, conn *tlsDNSConn) (*mDNS.Msg, error) {
    // ... 写请求，读响应 ...
    t.connections.PushBack(conn)  // 归还到池
    return response, nil
}
```

默认端口：853。

## HTTPS Transport（DoH）

使用 HTTP/2 POST 方法，内容类型为 `application/dns-message`：

```go
const MimeType = "application/dns-message"

func (t *HTTPSTransport) exchange(ctx context.Context, message *mDNS.Msg) (*mDNS.Msg, error) {
    exMessage := *message
    exMessage.Id = 0        // DoH 去除消息 ID
    exMessage.Compress = true
    request, _ := http.NewRequestWithContext(ctx, http.MethodPost, t.destination.String(), bytes.NewReader(rawMessage))
    request.Header.Set("Content-Type", MimeType)
    request.Header.Set("Accept", MimeType)
    response, err := currentTransport.RoundTrip(request)
    // 将响应体解析为 DNS 消息
}
```

### 超时时的传输层重置

如果查询超时，HTTP 传输层会被重置以清除过期连接：

```go
if errors.Is(err, context.DeadlineExceeded) {
    t.transport.CloseIdleConnections()
    t.transport = t.transport.Clone()
    t.transportResetAt = time.Now()
}
```

默认路径：`/dns-query`。默认端口：443。
