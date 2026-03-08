# 监听器系统

监听器系统提供所有入站协议使用的共享 TCP 和 UDP 监听器实现。

**源码**: `common/listener/`

## TCP 监听器

```go
type Listener struct {
    ctx          context.Context
    logger       logger.ContextLogger
    network      []string
    listenAddr   netip.AddrPort
    tcpListener  *net.TCPListener
    handler      adapter.ConnectionHandlerEx
    threadUnsafe bool
    // TLS, proxy protocol 等
}
```

### 功能

- **监听地址**: 绑定到特定的 IPv4/IPv6 地址和端口
- **TCP 选项**: `SO_REUSEADDR`, `TCP_FASTOPEN`, `TCP_DEFER_ACCEPT`
- **Proxy Protocol**: 支持 HAProxy proxy protocol v1/v2
- **线程安全/非安全**: 可选的单 goroutine 模式，用于需要它的协议

### Accept 循环

```go
func (l *Listener) loopTCPIn() {
    for {
        conn, err := l.tcpListener.AcceptTCP()
        if err != nil {
            return
        }
        // 如果配置了则应用 proxy protocol
        // 如果配置了则包装 TLS
        go l.handler.NewConnectionEx(ctx, conn, metadata, onClose)
    }
}
```

## UDP 监听器

```go
type UDPListener struct {
    ctx        context.Context
    logger     logger.ContextLogger
    listenAddr netip.AddrPort
    udpConn    *net.UDPConn
    handler    adapter.PacketHandlerEx
    // 用于 TProxy 的 OOB 处理器
}
```

### 功能

- **OOB 数据**: 对于 TProxy，带外数据携带原始目标地址
- **数据包处理器**: 传递带有源地址的单个数据包

### 读取循环

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

## 共享监听选项

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

## Proxy Protocol 支持

当设置 `proxy_protocol: true` 时，监听器使用 proxy protocol 解析来包装连接：

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

这从负载均衡器/反向代理背后提取原始客户端地址。
