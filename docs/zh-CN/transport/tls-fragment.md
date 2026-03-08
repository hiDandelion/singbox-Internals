# TLS ClientHello 分片

源码：`common/tlsfragment/index.go`、`common/tlsfragment/conn.go`、`common/tlsfragment/wait_linux.go`、`common/tlsfragment/wait_darwin.go`、`common/tlsfragment/wait_windows.go`、`common/tlsfragment/wait_stub.go`

## 概述

TLS 分片在 SNI（Server Name Indication）域名标签边界处拆分 TLS ClientHello 消息。此技术用于规避读取 SNI 以识别目标域名的 DPI（深度包检测）。通过将 SNI 拆分到多个 TCP 分段或 TLS 记录中，简单的 DPI 系统无法重组和匹配域名。

## 两种分片模式

### splitPacket 模式

在 SNI 域名标签边界处将 ClientHello 拆分为多个 TCP 分段。每个分段作为单独的 TCP 数据包发送，并启用 `TCP_NODELAY`，发送方在发送下一个分段前等待每个分段的 ACK。

### splitRecord 模式

通过在每个片段前添加原始 TLS 记录层头部（内容类型 + 版本）和新的长度字段，将每个片段重新包装为单独的 TLS 记录。这将单个 ClientHello 创建为多个有效的 TLS 记录。

两种模式可以组合使用：`splitRecord` 创建单独的 TLS 记录，`splitPacket` 将每个记录作为单独的 TCP 分段发送并等待 ACK。

## SNI 提取

`IndexTLSServerName` 函数解析原始 TLS ClientHello 以定位 SNI 扩展：

```go
func IndexTLSServerName(payload []byte) *MyServerName {
    if len(payload) < recordLayerHeaderLen || payload[0] != contentType {
        return nil  // Not a TLS handshake
    }
    segmentLen := binary.BigEndian.Uint16(payload[3:5])
    serverName := indexTLSServerNameFromHandshake(payload[recordLayerHeaderLen:])
    serverName.Index += recordLayerHeaderLen
    return serverName
}
```

解析器遍历：
1. TLS 记录层头部（5 字节）
2. Handshake 头部（6 字节）—— 验证 handshake 类型 1（ClientHello）
3. 随机数据（32 字节）
4. Session ID（可变长度）
5. 密码套件（可变长度）
6. 压缩方法（可变长度）
7. 扩展 —— 扫描 SNI 扩展（类型 0x0000）

返回 `MyServerName`，包含 SNI 的字节偏移、长度和字符串值。

## 分片连接

```go
type Conn struct {
    net.Conn
    tcpConn            *net.TCPConn
    ctx                context.Context
    firstPacketWritten bool
    splitPacket        bool
    splitRecord        bool
    fallbackDelay      time.Duration
}
```

`Conn` 仅拦截第一次 `Write` 调用（即 ClientHello）。后续写入直接透传。

### 拆分算法

```go
func (c *Conn) Write(b []byte) (n int, err error) {
    if !c.firstPacketWritten {
        defer func() { c.firstPacketWritten = true }()
        serverName := IndexTLSServerName(b)
        if serverName != nil {
            // 1. Enable TCP_NODELAY for splitPacket mode
            // 2. Parse domain labels, skip public suffix
            splits := strings.Split(serverName.ServerName, ".")
            if publicSuffix := publicsuffix.List.PublicSuffix(serverName.ServerName); publicSuffix != "" {
                splits = splits[:len(splits)-strings.Count(serverName.ServerName, ".")]
            }
            // 3. Random split point within each label
            for i, split := range splits {
                splitAt := rand.Intn(len(split))
                splitIndexes = append(splitIndexes, currentIndex+splitAt)
            }
            // 4. Send fragments
            for i := 0; i <= len(splitIndexes); i++ {
                // Extract payload slice
                if c.splitRecord {
                    // Re-wrap with TLS record header
                    buffer.Write(b[:3])              // Content type + version
                    binary.Write(&buffer, binary.BigEndian, payloadLen)
                    buffer.Write(payload)
                }
                if c.splitPacket {
                    writeAndWaitAck(c.ctx, c.tcpConn, payload, c.fallbackDelay)
                }
            }
            // 5. Restore TCP_NODELAY to false
            return len(b), nil
        }
    }
    return c.Conn.Write(b)
}
```

### 公共后缀处理

属于公共后缀（如 `.co.uk`、`.com.cn`）的域名标签使用 `golang.org/x/net/publicsuffix` 排除在拆分之外。这确保拆分仅在域名的有意义部分内进行。

### 前导通配符处理

如果域名以 `...` 开头（如 `...subdomain.example.com`），则跳过前导 `...` 标签并向前调整索引。

## 平台特定的 ACK 等待

`writeAndWaitAck` 函数确保每个 TCP 分段在发送下一个之前被确认。在不同平台上有不同实现：

### Linux（`wait_linux.go`）

使用 `TCP_INFO` 套接字选项检查 `Unacked` 字段：

```go
func waitAck(ctx context.Context, conn *net.TCPConn, fallbackDelay time.Duration) error {
    rawConn.Control(func(fd uintptr) {
        for {
            var info unix.TCPInfo
            infoBytes, _ := unix.GetsockoptTCPInfo(int(fd), unix.SOL_TCP, unix.TCP_INFO)
            if infoBytes.Unacked == 0 {
                return  // All segments acknowledged
            }
            time.Sleep(time.Millisecond)
        }
    })
}
```

### Darwin（`wait_darwin.go`）

使用 `SO_NWRITE` 套接字选项检查未发送的字节：

```go
func waitAck(ctx context.Context, conn *net.TCPConn, fallbackDelay time.Duration) error {
    rawConn.Control(func(fd uintptr) {
        for {
            nwrite, _ := unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_NWRITE)
            if nwrite == 0 {
                return  // All data sent and acknowledged
            }
            time.Sleep(time.Millisecond)
        }
    })
}
```

### Windows（`wait_windows.go`）

使用 `winiphlpapi.WriteAndWaitAck`（自定义 Windows API 包装器）。

### 后备方案（`wait_stub.go`）

在不支持的平台上，回退到 `time.Sleep(fallbackDelay)`：

```go
func writeAndWaitAck(ctx context.Context, conn *net.TCPConn, b []byte, fallbackDelay time.Duration) error {
    _, err := conn.Write(b)
    if err != nil { return err }
    time.Sleep(fallbackDelay)
    return nil
}
```

默认后备延迟为 `C.TLSFragmentFallbackDelay`。

## 连接可替换性

```go
func (c *Conn) ReaderReplaceable() bool {
    return true  // Reader can always be replaced (no read interception)
}

func (c *Conn) WriterReplaceable() bool {
    return c.firstPacketWritten  // Writer replaceable after first write
}
```

在第一个数据包写入后，`Conn` 变为透明的，其写入器可被缓冲区管道优化掉。

## 配置

TLS 分片作为 TLS 选项的一部分进行配置：

```json
{
  "tls": {
    "enabled": true,
    "fragment": true,
    "record_fragment": true,
    "fragment_fallback_delay": "20ms"
  }
}
```

| 字段 | 描述 |
|-------|-------------|
| `fragment` | 启用 TCP 数据包拆分（`splitPacket` 模式） |
| `record_fragment` | 启用 TLS 记录拆分（`splitRecord` 模式） |
| `fragment_fallback_delay` | 在没有 ACK 检测的平台上的后备延迟 |
