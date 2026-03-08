# NaiveProxy 协议

NaiveProxy 使用 CONNECT 方法将代理流量伪装为正常的 HTTP/2 或 HTTP/3 流量。inbound 实现了兼容 NaiveProxy 的服务器并支持 padding，而 outbound 使用 Cronet（Chromium 网络栈）库来模拟真实的 Chrome 客户端。

**源码**: `protocol/naive/inbound.go`, `protocol/naive/inbound_conn.go`, `protocol/naive/outbound.go`, `protocol/naive/quic/`

## Inbound 架构

```go
type Inbound struct {
    inbound.Adapter
    ctx              context.Context
    router           adapter.ConnectionRouterEx
    logger           logger.ContextLogger
    listener         *listener.Listener
    network          []string
    networkIsDefault bool
    authenticator    *auth.Authenticator
    tlsConfig        tls.ServerConfig
    httpServer       *http.Server
    h3Server         io.Closer
}
```

### 双传输层：HTTP/2 + HTTP/3

NaiveProxy 同时支持 HTTP/2（TCP）和 HTTP/3（QUIC）。网络默认为 TCP，可选 UDP 用于 HTTP/3：

```go
if common.Contains(inbound.network, N.NetworkUDP) {
    if options.TLS == nil || !options.TLS.Enabled {
        return nil, E.New("TLS is required for QUIC server")
    }
}
```

### HTTP/2 服务器（TCP）

TCP 监听器通过 h2c（HTTP/2 明文）提供 HTTP/2 服务，可选 TLS：

```go
n.httpServer = &http.Server{
    Handler: h2c.NewHandler(n, &http2.Server{}),
}

go func() {
    listener := net.Listener(tcpListener)
    if n.tlsConfig != nil {
        // 确保 HTTP/2 ALPN 存在
        if !common.Contains(n.tlsConfig.NextProtos(), http2.NextProtoTLS) {
            n.tlsConfig.SetNextProtos(append([]string{http2.NextProtoTLS}, n.tlsConfig.NextProtos()...))
        }
        listener = aTLS.NewListener(tcpListener, n.tlsConfig)
    }
    n.httpServer.Serve(listener)
}()
```

### HTTP/3 服务器（QUIC）

HTTP/3 通过可配置的函数指针初始化：

```go
var ConfigureHTTP3ListenerFunc func(ctx, logger, listener, handler, tlsConfig, options) (io.Closer, error)
```

这在 `protocol/naive/quic/inbound_init.go` 中外部注册，使用 `sing-quic` 库并支持可配置的拥塞控制。

### CONNECT 请求处理

核心协议逻辑在 `ServeHTTP` 中：

```go
func (n *Inbound) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
    // 1. 拒绝非 CONNECT 请求
    if request.Method != "CONNECT" {
        rejectHTTP(writer, http.StatusBadRequest)
        return
    }

    // 2. 要求 padding 头部（区分 NaiveProxy 与普通 CONNECT）
    if request.Header.Get("Padding") == "" {
        rejectHTTP(writer, http.StatusBadRequest)
        return
    }

    // 3. 通过 Proxy-Authorization 头部认证
    userName, password, authOk := sHttp.ParseBasicAuth(request.Header.Get("Proxy-Authorization"))
    if authOk {
        authOk = n.authenticator.Verify(userName, password)
    }
    if !authOk {
        rejectHTTP(writer, http.StatusProxyAuthRequired)
        return
    }

    // 4. 发送带 padding 的响应
    writer.Header().Set("Padding", generatePaddingHeader())
    writer.WriteHeader(http.StatusOK)
    writer.(http.Flusher).Flush()

    // 5. 从自定义或标准头部提取目标地址
    hostPort := request.Header.Get("-connect-authority")
    if hostPort == "" {
        hostPort = request.URL.Host
    }

    // 6. 为前 8 帧使用 padding 包装连接
    // HTTP/1.1：劫持连接
    // HTTP/2：使用 request.Body + response writer
}
```

### 拒绝行为

拒绝时，连接使用 RST 而非优雅关闭，以模拟真实 Web 服务器的行为：

```go
func rejectHTTP(writer http.ResponseWriter, statusCode int) {
    hijacker, ok := writer.(http.Hijacker)
    if !ok {
        writer.WriteHeader(statusCode)
        return
    }
    conn, _, _ := hijacker.Hijack()
    if tcpConn, isTCP := common.Cast[*net.TCPConn](conn); isTCP {
        tcpConn.SetLinger(0)  // RST 而非 FIN
    }
    conn.Close()
}
```

## Padding 协议

padding 协议为前 8 次读写操作添加随机 padding 以抵抗流量指纹识别。

### 常量和结构

```go
const paddingCount = 8

type paddingConn struct {
    readPadding      int   // 已读取的带 padding 帧数
    writePadding     int   // 已写入的带 padding 帧数
    readRemaining    int   // 当前帧中剩余的数据字节数
    paddingRemaining int   // 需要跳过的剩余 padding 字节数
}
```

### Padding 头部格式

Padding HTTP 头部使用从字符集 `!#$()+<>?@[]^`{}~` 中选取的 30-62 个随机字符：

```go
func generatePaddingHeader() string {
    paddingLen := rand.Intn(32) + 30
    padding := make([]byte, paddingLen)
    bits := rand.Uint64()
    for i := 0; i < 16; i++ {
        padding[i] = "!#$()+<>?@[]^`{}"[bits&15]
        bits >>= 4
    }
    for i := 16; i < paddingLen; i++ {
        padding[i] = '~'
    }
    return string(padding)
}
```

### 线路格式（带 Padding 的帧）

前 8 帧中的每一帧编码如下：

```
+---------------+----------+------+---------+
| Data Length   | Pad Size | Data | Padding |
| (2 bytes BE) | (1 byte) | (var)| (var)   |
+---------------+----------+------+---------+
```

```go
func (p *paddingConn) writeWithPadding(writer io.Writer, data []byte) (n int, err error) {
    if p.writePadding < paddingCount {
        paddingSize := rand.Intn(256)
        buffer := buf.NewSize(3 + len(data) + paddingSize)
        header := buffer.Extend(3)
        binary.BigEndian.PutUint16(header, uint16(len(data)))
        header[2] = byte(paddingSize)
        buffer.Write(data)
        buffer.Extend(paddingSize)  // 随机 padding 字节
        _, err = writer.Write(buffer.Bytes())
        p.writePadding++
        return
    }
    // 8 帧之后直接写入
    return writer.Write(data)
}
```

### 读取带 Padding 的帧

```go
func (p *paddingConn) readWithPadding(reader io.Reader, buffer []byte) (n int, err error) {
    // 如果当前帧有剩余数据，读取它
    if p.readRemaining > 0 { /* 读取剩余数据 */ }

    // 跳过前一帧剩余的 padding
    if p.paddingRemaining > 0 {
        rw.SkipN(reader, p.paddingRemaining)
    }

    // 读取下一个带 padding 的帧头部（3 字节）
    if p.readPadding < paddingCount {
        io.ReadFull(reader, paddingHeader[:3])
        originalDataSize := binary.BigEndian.Uint16(paddingHeader[:2])
        paddingSize := int(paddingHeader[2])
        n, _ = reader.Read(buffer[:originalDataSize])
        p.readPadding++
        p.readRemaining = originalDataSize - n
        p.paddingRemaining = paddingSize
        return
    }

    // 8 帧之后直接读取
    return reader.Read(buffer)
}
```

### 连接可替换性

padding 阶段（8 帧）结束后，padding 包装变为透明：

```go
func (p *paddingConn) readerReplaceable() bool {
    return p.readPadding == paddingCount
}

func (p *paddingConn) writerReplaceable() bool {
    return p.writePadding == paddingCount
}
```

### 两种连接类型

- **`naiveConn`**：用于 HTTP/1.1 劫持的连接（包装 `net.Conn`）
- **`naiveH2Conn`**：用于 HTTP/2 流（包装 `io.Reader` + `io.Writer` + `http.Flusher`）；每次写入后必须刷新

## Outbound 架构（Cronet）

outbound 使用 Cronet 库（Chromium 的网络栈），使连接与真实的 Chrome 无法区分：

```go
//go:build with_naive_outbound

type Outbound struct {
    outbound.Adapter
    ctx       context.Context
    logger    logger.ContextLogger
    client    *cronet.NaiveClient
    uotClient *uot.Client
}
```

### 构建标签

outbound 需要 `with_naive_outbound` 构建标签。

### TLS 限制

许多 TLS 选项不受支持，因为 Cronet 管理自己的 TLS：

```go
if options.TLS.DisableSNI { return nil, E.New("not supported") }
if options.TLS.Insecure { return nil, E.New("not supported") }
if len(options.TLS.ALPN) > 0 { return nil, E.New("not supported") }
if options.TLS.UTLS != nil { return nil, E.New("not supported") }
if options.TLS.Reality != nil { return nil, E.New("not supported") }
// ... 更多限制
```

### 客户端配置

```go
client, _ := cronet.NewNaiveClient(cronet.NaiveClientOptions{
    ServerAddress:           serverAddress,
    ServerName:              serverName,
    Username:                options.Username,
    Password:                options.Password,
    InsecureConcurrency:     options.InsecureConcurrency,
    ExtraHeaders:            extraHeaders,
    TrustedRootCertificates: trustedRootCertificates,
    Dialer:                  outboundDialer,
    DNSResolver:             dnsResolver,
    ECHEnabled:              echEnabled,
    QUIC:                    options.QUIC,
    QUICCongestionControl:   quicCongestionControl,
})
```

### QUIC 拥塞控制（Outbound）

outbound 支持多种 QUIC 拥塞控制算法：

```go
switch options.QUICCongestionControl {
case "bbr":   quicCongestionControl = cronet.QUICCongestionControlBBR
case "bbr2":  quicCongestionControl = cronet.QUICCongestionControlBBRv2
case "cubic": quicCongestionControl = cronet.QUICCongestionControlCubic
case "reno":  quicCongestionControl = cronet.QUICCongestionControlReno
}
```

### ECH 支持

outbound 支持加密客户端 Hello（Encrypted Client Hello）：

```go
if options.TLS.ECH != nil && options.TLS.ECH.Enabled {
    echEnabled = true
    echConfigList = block.Bytes  // PEM 解码的 "ECH CONFIGS"
}
```

### DNS 集成

outbound 使用 sing-box DNS 路由器在 Cronet 内部进行名称解析：

```go
dnsResolver = func(dnsContext context.Context, request *mDNS.Msg) *mDNS.Msg {
    response, _ := dnsRouter.Exchange(dnsContext, request, outboundDialer.(dialer.ResolveDialer).QueryOptions())
    return response
}
```

### 通过 UoT 支持 UDP

UDP 仅通过 UDP-over-TCP 可用：

```go
if uotOptions.Enabled {
    outbound.uotClient = &uot.Client{
        Dialer:  &naiveDialer{client},
        Version: uotOptions.Version,
    }
}
```

## 配置示例

### Inbound

```json
{
  "type": "naive",
  "tag": "naive-in",
  "listen": "::",
  "listen_port": 443,
  "users": [
    { "username": "user1", "password": "pass1" }
  ],
  "tls": {
    "enabled": true,
    "certificate_path": "/path/to/cert.pem",
    "key_path": "/path/to/key.pem"
  }
}
```

### Outbound

```json
{
  "type": "naive",
  "tag": "naive-out",
  "server": "example.com",
  "server_port": 443,
  "username": "user1",
  "password": "pass1",
  "tls": {
    "enabled": true,
    "server_name": "example.com"
  },
  "udp_over_tcp": {
    "enabled": true,
    "version": 2
  }
}
```
