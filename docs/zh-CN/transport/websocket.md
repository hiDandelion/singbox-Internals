# WebSocket 传输

源码：`transport/v2raywebsocket/client.go`、`transport/v2raywebsocket/server.go`、`transport/v2raywebsocket/conn.go`、`transport/v2raywebsocket/writer.go`

## 概述

WebSocket 传输使用 `github.com/sagernet/ws`（`gobwas/ws` 的 fork 版本）实现兼容 V2Ray 的 WebSocket 隧道。它支持 early data 传输以实现 0-RTT 连接建立，可通过 URL 路径编码或自定义 HTTP 头部传递。

## 客户端

### 构造

```go
func NewClient(ctx context.Context, dialer N.Dialer, serverAddr M.Socksaddr,
    options option.V2RayWebsocketOptions, tlsConfig tls.Config) (adapter.V2RayClientTransport, error)
```

关键设置逻辑：
- 如果配置了 TLS，ALPN 默认为 `["http/1.1"]`，并使用 `tls.NewDialer` 包装拨号器
- URL 方案为 `ws`（明文）或 `wss`（TLS）
- 选项中的 `Host` 头部覆盖 URL 主机
- 默认 User-Agent 为 `"Go-http-client/1.1"`

### 连接建立

```go
func (c *Client) DialContext(ctx context.Context) (net.Conn, error) {
    if c.maxEarlyData <= 0 {
        conn, err := c.dialContext(ctx, &c.requestURL, c.headers)
        // ... return WebsocketConn directly
    } else {
        return &EarlyWebsocketConn{Client: c, ctx: ctx, create: make(chan struct{})}, nil
    }
}
```

在没有 early data 的情况下，客户端通过 `ws.Dialer.Upgrade()` 立即执行 WebSocket 升级。有 early data 时，返回一个延迟初始化的 `EarlyWebsocketConn`，将实际连接推迟到首次写入。

### WebSocket 升级

```go
func (c *Client) dialContext(ctx context.Context, requestURL *url.URL, headers http.Header) (*WebsocketConn, error) {
    conn, err := c.dialer.DialContext(ctx, N.NetworkTCP, c.serverAddr)
    // ...
    deadlineConn.SetDeadline(time.Now().Add(C.TCPTimeout))
    reader, _, err := ws.Dialer{Header: ws.HandshakeHeaderHTTP(headers), Protocols: protocols}.Upgrade(deadlineConn, requestURL)
    deadlineConn.SetDeadline(time.Time{})
    // If reader has buffered data, wrap conn with CachedConn
    return NewConn(conn, nil, ws.StateClientSide), nil
}
```

`Sec-WebSocket-Protocol` 头部被提取到 `Protocols` 字段中，以进行正确的 WebSocket 子协议协商。在 handshake 期间设置 `TCPTimeout` 截止时间，完成后清除。

## Early Data

Early data 允许将首个有效载荷嵌入 WebSocket handshake 中，实现 0-RTT：

### 两种模式

1. **URL 路径模式**（`earlyDataHeaderName == ""`）：base64 编码的 early data 追加到 URL 路径
2. **自定义头部模式**（`earlyDataHeaderName != ""`）：base64 编码的 early data 放入指定的 HTTP 头部（通常为 `Sec-WebSocket-Protocol`）

### EarlyWebsocketConn

此 struct 使用原子指针和 channel 实现延迟初始化同步：

```go
type EarlyWebsocketConn struct {
    *Client
    ctx    context.Context
    conn   atomic.Pointer[WebsocketConn]
    access sync.Mutex
    create chan struct{}
    err    error
}
```

**写入**（触发连接建立）：
```go
func (c *EarlyWebsocketConn) Write(b []byte) (n int, err error) {
    conn := c.conn.Load()
    if conn != nil {
        return conn.Write(b)  // Fast path: already connected
    }
    c.access.Lock()
    defer c.access.Unlock()
    // ... double-check conn after acquiring lock
    err = c.writeRequest(b)   // Establish connection with early data
    c.err = err
    close(c.create)           // Signal readers
    // ...
}
```

**读取**（阻塞直到连接存在）：
```go
func (c *EarlyWebsocketConn) Read(b []byte) (n int, err error) {
    conn := c.conn.Load()
    if conn == nil {
        <-c.create           // Wait for Write to establish connection
        if c.err != nil {
            return 0, c.err
        }
        conn = c.conn.Load()
    }
    return conn.Read(b)
}
```

`writeRequest` 方法在 `maxEarlyData` 边界处分割数据：限制内的数据放入 handshake，超出部分在连接建立后作为普通 WebSocket 帧写入。

## 服务端

### 请求处理

服务端验证传入的 HTTP 请求并提取 early data：

```go
func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
    // Path validation
    // Early data extraction (URL path or custom header)
    earlyData, err = base64.RawURLEncoding.DecodeString(earlyDataStr)
    // WebSocket upgrade
    wsConn, _, _, err := ws.UpgradeHTTP(request, writer)
    conn = NewConn(wsConn, source, ws.StateServerSide)
    if len(earlyData) > 0 {
        conn = bufio.NewCachedConn(conn, buf.As(earlyData))
    }
    s.handler.NewConnectionEx(v2rayhttp.DupContext(request.Context()), conn, source, M.Socksaddr{}, nil)
}
```

当 `earlyDataHeaderName` 为空且 `maxEarlyData > 0` 时，服务端接受以配置路径为前缀的任何路径，并将后缀视为 base64 编码的 early data。

## WebsocketConn

用 WebSocket 帧读写包装原始 `net.Conn`：

### 读取

```go
func (c *WebsocketConn) Read(b []byte) (n int, err error) {
    for {
        n, err = c.reader.Read(b)
        if n > 0 { return }
        // Get next frame
        header, err = c.reader.NextFrame()
        if header.OpCode.IsControl() {
            // Handle control frames (ping/pong/close)
            c.controlHandler(header, c.reader)
            continue
        }
        if header.OpCode&ws.OpBinary == 0 {
            c.reader.Discard()  // Skip non-binary frames
            continue
        }
    }
}
```

仅处理二进制帧；文本帧被静默丢弃。控制帧（ping、pong、close）通过 `controlHandler` 回调内联处理。

### 关闭

```go
func (c *WebsocketConn) Close() error {
    c.Conn.SetWriteDeadline(time.Now().Add(C.TCPTimeout))
    frame := ws.NewCloseFrame(ws.NewCloseFrameBody(ws.StatusNormalClosure, ""))
    if c.state == ws.StateClientSide {
        frame = ws.MaskFrameInPlace(frame)
    }
    ws.WriteFrame(c.Conn, frame)
    c.Conn.Close()
    return nil
}
```

根据 WebSocket RFC，客户端的关闭帧需要进行掩码处理。

## 优化写入器

`Writer` struct 使用缓冲区头部空间提供零拷贝帧写入：

```go
func (w *Writer) WriteBuffer(buffer *buf.Buffer) error {
    // Calculate payload bit length (1, 3, or 9 bytes)
    // Calculate header length (1 + payloadBitLength + optional 4 mask bytes)
    header := buffer.ExtendHeader(headerLen)
    header[0] = byte(ws.OpBinary) | 0x80  // FIN + Binary
    // Encode payload length
    if !w.isServer {
        // Client side: generate and apply mask
        maskKey := rand.Uint32()
        ws.Cipher(data, [4]byte(header[1+payloadBitLength:]), 0)
    }
    return w.writer.WriteBuffer(buffer)
}

func (w *Writer) FrontHeadroom() int {
    return 14  // Maximum header size (2 + 8 + 4)
}
```

`FrontHeadroom()` 方法返回 14 字节（最大 WebSocket 头部：2 基础字节 + 8 扩展长度字节 + 4 掩码密钥字节），允许上游缓冲区分配预留头部空间，避免数据拷贝。

## 配置

```json
{
  "transport": {
    "type": "ws",
    "path": "/tunnel",
    "headers": {
      "Host": "cdn.example.com"
    },
    "max_early_data": 2048,
    "early_data_header_name": "Sec-WebSocket-Protocol"
  }
}
```

| 字段 | 描述 |
|-------|-------------|
| `path` | WebSocket 端点的 URL 路径（自动添加 `/` 前缀） |
| `headers` | 附加 HTTP 头部；`Host` 覆盖 URL 主机 |
| `max_early_data` | 嵌入 handshake 的最大字节数（0 = 禁用） |
| `early_data_header_name` | early data 的头部名称（空 = 使用 URL 路径） |
