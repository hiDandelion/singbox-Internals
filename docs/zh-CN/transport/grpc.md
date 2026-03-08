# gRPC 传输

源码：`transport/v2raygrpc/`、`transport/v2raygrpclite/`、`transport/v2ray/grpc.go`、`transport/v2ray/grpc_lite.go`

## 概述

sing-box 提供两种 gRPC 实现：

1. **完整 gRPC**（`v2raygrpc`）：使用 `google.golang.org/grpc`，需要构建标签 `with_grpc`
2. **精简 gRPC**（`v2raygrpclite`）：使用 `golang.org/x/net/http2` 的原始 HTTP/2 实现，始终可用

两者都实现了 V2Ray "Gun" 协议 —— 一个双向流式 gRPC 服务，用于隧道传输任意 TCP 数据。

## 完整 gRPC 实现

### 客户端

```go
type Client struct {
    ctx         context.Context
    dialer      N.Dialer
    serverAddr  string
    serviceName string
    dialOptions []grpc.DialOption
    conn        atomic.Pointer[grpc.ClientConn]
    connAccess  sync.Mutex
}
```

**连接缓存**使用原子指针 + 互斥锁（双重检查锁定）：

```go
func (c *Client) connect() (*grpc.ClientConn, error) {
    conn := c.conn.Load()
    if conn != nil && conn.GetState() != connectivity.Shutdown {
        return conn, nil
    }
    c.connAccess.Lock()
    defer c.connAccess.Unlock()
    conn = c.conn.Load()  // Re-check after lock
    if conn != nil && conn.GetState() != connectivity.Shutdown {
        return conn, nil
    }
    conn, err := grpc.DialContext(c.ctx, c.serverAddr, c.dialOptions...)
    c.conn.Store(conn)
    return conn, nil
}
```

**TLS 集成**：使用自定义的 `TLSTransportCredentials` 适配器，将 sing-box 的 TLS 配置接口桥接到 gRPC 的 `credentials.TransportCredentials`。没有 TLS 时使用 `insecure.NewCredentials()`。

**拨号选项**包括：
- Keepalive 参数（`IdleTimeout`、`PingTimeout`、`PermitWithoutStream`）
- 退避配置（500ms 基础值，1.5 倍乘数，19s 最大值）
- 自定义拨号器，将 `N.Dialer` 桥接到 `net.Conn`

### 自定义服务名称

Gun 协议使用自定义服务名称作为 gRPC 方法路径：

```go
func ServerDesc(name string) grpc.ServiceDesc {
    return grpc.ServiceDesc{
        ServiceName: name,
        Streams: []grpc.StreamDesc{{
            StreamName:    "Tun",
            Handler:       _GunService_Tun_Handler,
            ServerStreams: true,
            ClientStreams: true,
        }},
        Metadata: "gun.proto",
    }
}

func (c *gunServiceClient) TunCustomName(ctx context.Context, name string, opts ...grpc.CallOption) (GunService_TunClient, error) {
    stream, err := c.cc.NewStream(ctx, &ServerDesc(name).Streams[0], "/"+name+"/Tun", opts...)
    // ...
}
```

方法路径变为 `/<serviceName>/Tun`。默认服务名称为 `GunService`。

### 服务端

```go
func (s *Server) Tun(server GunService_TunServer) error {
    conn := NewGRPCConn(server, nil)
    var source M.Socksaddr
    // Extract source from gRPC peer info
    if remotePeer, loaded := peer.FromContext(server.Context()); loaded {
        source = M.SocksaddrFromNet(remotePeer.Addr)
    }
    // Override with X-Forwarded-For if present (CDN support)
    if grpcMetadata, loaded := gM.FromIncomingContext(server.Context()); loaded {
        forwardFrom := strings.Join(grpcMetadata.Get("X-Forwarded-For"), ",")
        // Parse last valid address from comma-separated list
    }
    done := make(chan struct{})
    go s.handler.NewConnectionEx(log.ContextWithNewID(s.ctx), conn, source, M.Socksaddr{},
        N.OnceClose(func(it error) { close(done) }))
    <-done  // Block until connection handler completes
    return nil
}
```

### GRPCConn

将 gRPC 双向流适配为 `net.Conn`：

```go
type GRPCConn struct {
    GunService          // Send/Recv interface
    cache     []byte    // Buffered data from oversized Recv
    cancel    context.CancelCauseFunc
    closeOnce sync.Once
}

func (c *GRPCConn) Read(b []byte) (n int, err error) {
    if len(c.cache) > 0 {
        n = copy(b, c.cache)
        c.cache = c.cache[n:]
        return
    }
    hunk, err := c.Recv()
    n = copy(b, hunk.Data)
    if n < len(hunk.Data) {
        c.cache = hunk.Data[n:]
    }
    return
}
```

`Hunk` protobuf 消息包含单个 `Data` 字段。当读取缓冲区小于接收的数据块时，多余的数据会被缓存供后续读取使用。

## 精简 gRPC 实现

### 线格式（Gun 协议）

精简版实现在 HTTP/2 上手动构建 Gun 线格式：

```
[0x00][4-byte big-endian frame length][0x0A][varint data length][data]
```

其中：
- `0x00`：gRPC 压缩标志（始终未压缩）
- 帧长度：`1 + varint_length + data_length`
- `0x0A`：Protobuf 字段标签（字段 1，线类型 2 = 长度分隔）
- Varint 数据长度：数据长度的标准 protobuf varint 编码

```go
func (c *GunConn) Write(b []byte) (n int, err error) {
    varLen := varbin.UvarintLen(uint64(len(b)))
    buffer := buf.NewSize(6 + varLen + len(b))
    header := buffer.Extend(6 + varLen)
    header[0] = 0x00
    binary.BigEndian.PutUint32(header[1:5], uint32(1+varLen+len(b)))
    header[5] = 0x0A
    binary.PutUvarint(header[6:], uint64(len(b)))
    common.Must1(buffer.Write(b))
    _, err = c.writer.Write(buffer.Bytes())
    if c.flusher != nil {
        c.flusher.Flush()
    }
    return len(b), nil
}
```

读取时丢弃前 6 个字节（压缩标志 + 帧长度 + protobuf 标签），读取 varint 数据长度，然后流式传输有效载荷：

```go
func (c *GunConn) read(b []byte) (n int, err error) {
    if c.readRemaining > 0 {
        // Continue reading from current frame
    }
    _, err = c.reader.Discard(6)
    dataLen, err := binary.ReadUvarint(c.reader)
    c.readRemaining = int(dataLen)
    // Read up to readRemaining bytes
}
```

### 精简版客户端

直接使用 `http2.Transport`，通过 `io.Pipe` 实现双向流：

```go
func (c *Client) DialContext(ctx context.Context) (net.Conn, error) {
    pipeInReader, pipeInWriter := io.Pipe()
    request := &http.Request{
        Method: http.MethodPost,
        Body:   pipeInReader,
        URL:    c.url,  // /<serviceName>/Tun
        Header: defaultClientHeader,  // Content-Type: application/grpc
    }
    conn := newLateGunConn(pipeInWriter)
    go func() {
        response, err := c.transport.RoundTrip(request)
        conn.setup(response.Body, err)
    }()
    return conn, nil
}
```

默认客户端头部：
```go
var defaultClientHeader = http.Header{
    "Content-Type": []string{"application/grpc"},
    "User-Agent":   []string{"grpc-go/1.48.0"},
    "TE":           []string{"trailers"},
}
```

### 精简版服务端

验证 gRPC 特定的要求：

```go
func (s *Server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
    // Handle h2c preface
    if request.Method == "PRI" && len(request.Header) == 0 && request.URL.Path == "*" {
        s.h2cHandler.ServeHTTP(writer, request)
        return
    }
    // Validate path: /<serviceName>/Tun
    // Validate method: POST
    // Validate content-type: application/grpc
    writer.Header().Set("Content-Type", "application/grpc")
    writer.Header().Set("TE", "trailers")
    writer.WriteHeader(http.StatusOK)
    conn := v2rayhttp.NewHTTP2Wrapper(newGunConn(request.Body, writer, writer.(http.Flusher)))
    s.handler.NewConnectionEx(...)
}
```

服务端同时支持 TLS（h2）和明文（h2c）HTTP/2。h2c handler 检测 HTTP/2 连接前言（`PRI * HTTP/2.0`）。

### 前部头部空间

精简版 `GunConn` 声明前部头部空间以实现零拷贝写入：

```go
func (c *GunConn) FrontHeadroom() int {
    return 6 + binary.MaxVarintLen64  // 6 + 10 = 16 bytes
}
```

## 配置

```json
{
  "transport": {
    "type": "grpc",
    "service_name": "TunService",
    "idle_timeout": "15s",
    "ping_timeout": "15s",
    "permit_without_stream": false,
    "force_lite": false
  }
}
```

| 字段 | 描述 |
|-------|-------------|
| `service_name` | gRPC 服务名称，用于方法路径 `/<name>/Tun` |
| `idle_timeout` | Keepalive 空闲超时 |
| `ping_timeout` | Keepalive ping 超时 |
| `permit_without_stream` | 允许在没有活跃流时发送 keepalive ping（仅完整 gRPC） |
| `force_lite` | 即使有 `with_grpc` 构建标签也强制使用精简版实现 |
