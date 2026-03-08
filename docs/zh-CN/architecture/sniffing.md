# 协议嗅探

协议嗅探通过检查连接的前几个字节来检测应用层协议。即使客户端通过 IP 连接，这也能实现基于域名的路由。

**源码**: `common/sniff/`, `route/route.go`

## 嗅探架构

嗅探作为规则动作发生，而不是固定的管道步骤：

```json
{
  "route": {
    "rules": [
      {
        "action": "sniff",
        "timeout": "300ms"
      },
      {
        "protocol": "tls",
        "domain_suffix": [".example.com"],
        "action": "route",
        "outbound": "proxy"
      }
    ]
  }
}
```

这意味着你可以有条件地嗅探（仅对特定入站、端口等），并在后续规则中使用嗅探结果。

## 流嗅探器（TCP）

```go
type StreamSniffer = func(ctx context.Context, metadata *adapter.InboundContext, reader io.Reader) error
```

### 可用的嗅探器

| 嗅探器 | 协议 | 检测方式 |
|---------|----------|-----------|
| `TLSClientHello` | `tls` | TLS 记录类型 0x16，握手类型 0x01，SNI 扩展 |
| `HTTPHost` | `http` | HTTP 方法 + Host 头 |
| `StreamDomainNameQuery` | `dns` | TCP 上的 DNS 查询 |
| `BitTorrent` | `bittorrent` | BitTorrent 握手魔数 |
| `SSH` | `ssh` | "SSH-" 前缀 |
| `RDP` | `rdp` | RDP TPKT 头 |

### TLS 嗅探

```go
func TLSClientHello(ctx context.Context, metadata *adapter.InboundContext, reader io.Reader) error {
    // 解析 TLS 记录头
    // 解析 ClientHello 握手消息
    // 从扩展中提取 SNI
    // 从扩展中提取 ALPN
    // 设置 metadata.Protocol = "tls"
    // 设置 metadata.Domain = SNI
    // 设置 metadata.Client (JA3 指纹类别)
    // 设置 metadata.SniffContext = &TLSContext{ALPN, ClientHello}
}
```

TLS 嗅探器还将完整的 ClientHello 存储在 `SniffContext` 中，用于 JA3 指纹识别和后续 REALITY 服务器使用。

### HTTP 嗅探

```go
func HTTPHost(ctx context.Context, metadata *adapter.InboundContext, reader io.Reader) error {
    // 检查 HTTP 方法 (GET, POST 等)
    // 解析头部以查找 Host
    // 设置 metadata.Protocol = "http"
    // 设置 metadata.Domain = Host 头的值
}
```

## 数据包嗅探器（UDP）

```go
type PacketSniffer = func(ctx context.Context, metadata *adapter.InboundContext, packet []byte) error
```

### 可用的嗅探器

| 嗅探器 | 协议 | 检测方式 |
|---------|----------|-----------|
| `QUICClientHello` | `quic` | QUIC Initial 包 + TLS ClientHello |
| `DomainNameQuery` | `dns` | DNS 查询包 |
| `STUNMessage` | `stun` | STUN 消息魔数 |
| `UTP` | `bittorrent` | uTP (微传输协议) |
| `UDPTracker` | `bittorrent` | BitTorrent UDP tracker |
| `DTLSRecord` | `dtls` | DTLS 记录头 |
| `NTP` | `ntp` | NTP 包格式 |

### QUIC 嗅探

QUIC 嗅探是最复杂的 -- 它必须：
1. 解析 QUIC Initial 包头
2. 解密 QUIC 头部保护
3. 解密 QUIC 载荷（使用从连接 ID 派生的 Initial 密钥）
4. 找到包含 TLS ClientHello 的 CRYPTO 帧
5. 解析 ClientHello 以获取 SNI

QUIC ClientHello 可能跨越多个数据包，因此嗅探器返回 `sniff.ErrNeedMoreData`，路由器将读取更多数据包。

## PeekStream

```go
func PeekStream(
    ctx context.Context,
    metadata *adapter.InboundContext,
    conn net.Conn,
    existingBuffers []*buf.Buffer,
    buffer *buf.Buffer,
    timeout time.Duration,
    sniffers ...StreamSniffer,
) error {
    // 如果有缓存数据，先尝试嗅探
    if len(existingBuffers) > 0 {
        reader := io.MultiReader(buffers..., buffer)
        for _, sniffer := range sniffers {
            err := sniffer(ctx, metadata, reader)
            if err == nil { return nil }
        }
    }

    // 带超时读取新数据
    conn.SetReadDeadline(time.Now().Add(timeout))
    _, err := buffer.ReadOnceFrom(conn)
    conn.SetReadDeadline(time.Time{})

    // 尝试每个嗅探器
    reader := io.MultiReader(buffers..., buffer)
    for _, sniffer := range sniffers {
        err := sniffer(ctx, metadata, reader)
        if err == nil { return nil }
    }
    return ErrClientHelloNotFound
}
```

嗅探到的数据会被缓存，并在转发到出站之前预置到连接中（通过 `bufio.NewCachedConn`）。

## PeekPacket

```go
func PeekPacket(
    ctx context.Context,
    metadata *adapter.InboundContext,
    packet []byte,
    sniffers ...PacketSniffer,
) error {
    for _, sniffer := range sniffers {
        err := sniffer(ctx, metadata, packet)
        if err == nil { return nil }
    }
    return ErrClientHelloNotFound
}
```

对于数据包，不需要缓冲 -- 数据包被完整读取并传递给嗅探器。

## 跳过逻辑

某些端口会被跳过，因为它们使用服务器优先协议（服务器在客户端之前发送数据）：

```go
func Skip(metadata *adapter.InboundContext) bool {
    // 跳过知名端口上的服务器优先协议
    switch metadata.Destination.Port {
    case 25, 110, 143, 465, 587, 993, 995: // SMTP, POP3, IMAP
        return true
    }
    return false
}
```

## 嗅探结果流

嗅探后，元数据会被丰富：

```go
metadata.Protocol = "tls"          // 检测到的协议
metadata.Domain = "example.com"    // 提取的域名
metadata.Client = "chrome"         // TLS 客户端指纹
```

如果在嗅探动作中设置了 `OverrideDestination`，目标地址也会被更新：

```go
if action.OverrideDestination && M.IsDomainName(metadata.Domain) {
    metadata.Destination = M.Socksaddr{
        Fqdn: metadata.Domain,
        Port: metadata.Destination.Port,
    }
}
```

这允许后续规则匹配嗅探到的域名，出站将连接到域名（而非 IP）。
