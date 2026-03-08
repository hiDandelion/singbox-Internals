# Redirect 和 TProxy 透明代理

Redirect 和 TProxy 是 Linux 特有的透明代理机制。Redirect 通过 `iptables REDIRECT` 拦截 TCP 连接，而 TProxy 通过 `iptables TPROXY` 拦截 TCP 和 UDP。两者都从内核数据结构中提取原始目标地址。

**源码**: `protocol/redirect/redirect.go`, `protocol/redirect/tproxy.go`, `common/redir/`

## Redirect Inbound

### 架构

```go
type Redirect struct {
    inbound.Adapter
    router   adapter.Router
    logger   log.ContextLogger
    listener *listener.Listener
}
```

### 仅 TCP

Redirect 仅支持 TCP（内核将 TCP 连接重定向到本地监听器）：

```go
redirect.listener = listener.New(listener.Options{
    Network:           []string{N.NetworkTCP},
    ConnectionHandler: redirect,
})
```

### 原始目标地址提取

关键操作是使用 `SO_ORIGINAL_DST` 从重定向的套接字中获取原始目标地址：

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

`redir.GetOriginalDestination` 函数调用 `getsockopt(fd, SOL_IP, SO_ORIGINAL_DST)`（IPv6 使用 `IP6T_SO_ORIGINAL_DST`）来获取被 iptables 重写的原始目标地址。

### 所需 iptables 规则

```bash
iptables -t nat -A PREROUTING -p tcp --dport 1:65535 -j REDIRECT --to-ports <listen_port>
```

## TProxy Inbound

### 架构

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

### TCP + UDP 支持

TProxy 同时支持 TCP 和 UDP：

```go
tproxy.listener = listener.New(listener.Options{
    Network:           options.Network.Build(),
    ConnectionHandler: tproxy,
    OOBPacketHandler:  tproxy,   // 带 OOB 数据的 UDP
    TProxy:            true,
})
```

`TProxy: true` 标志告诉监听器设置 `IP_TRANSPARENT` 套接字选项。

### TCP 处理

对于 TCP，原始目标地址就是套接字的本地地址（TProxy 保留了它）：

```go
func (t *TProxy) NewConnectionEx(ctx, conn, metadata, onClose) {
    metadata.Inbound = t.Tag()
    metadata.InboundType = t.Type()
    metadata.Destination = M.SocksaddrFromNet(conn.LocalAddr()).Unwrap()
    t.router.RouteConnectionEx(ctx, conn, metadata, onClose)
}
```

### 带 OOB 的 UDP 处理

UDP 包携带包含原始目标地址的带外（OOB）数据。`OOBPacketHandler` interface 处理这些数据：

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

`redir.GetOriginalDestinationFromOOB` 函数解析 OOB 数据中的 `IP_RECVORIGDSTADDR` 辅助消息以提取原始目标地址。

### UDP NAT

TProxy 使用 `udpnat.Service` 进行 UDP 会话跟踪：

```go
tproxy.udpNat = udpnat.New(tproxy, tproxy.preparePacketConnection, udpTimeout, false)
```

当建立新的 UDP 会话时，会创建一个可以发回响应的包写入器：

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

### TProxy UDP 回写

TProxy 包写入器必须使用伪造的源地址（原始目标地址）发送 UDP 响应。这需要 `IP_TRANSPARENT` 和 `SO_REUSEADDR`：

```go
func (w *tproxyPacketWriter) WritePacket(buffer *buf.Buffer, destination M.Socksaddr) error {
    // 如果目标匹配则复用缓存的连接
    if w.destination == destination && w.conn != nil {
        _, err := w.conn.WriteToUDPAddrPort(buffer.Bytes(), w.source)
        return err
    }

    // 创建绑定到目标地址（伪造源地址）的新套接字
    var listenConfig net.ListenConfig
    listenConfig.Control = control.Append(listenConfig.Control, control.ReuseAddr())
    listenConfig.Control = control.Append(listenConfig.Control, redir.TProxyWriteBack())
    packetConn, _ := w.listener.ListenPacket(listenConfig, w.ctx, "udp", destination.String())
    udpConn := packetConn.(*net.UDPConn)
    udpConn.WriteToUDPAddrPort(buffer.Bytes(), w.source)
}
```

`redir.TProxyWriteBack()` 控制函数在响应套接字上设置 `IP_TRANSPARENT`，允许其绑定到非本地地址（原始目标地址），使响应看起来来自正确的源地址。

### 所需 iptables 规则

```bash
# TCP
iptables -t mangle -A PREROUTING -p tcp --dport 1:65535 -j TPROXY \
    --on-port <listen_port> --tproxy-mark 0x1/0x1

# UDP
iptables -t mangle -A PREROUTING -p udp --dport 1:65535 -j TPROXY \
    --on-port <listen_port> --tproxy-mark 0x1/0x1

# 将标记的包路由到回环
ip rule add fwmark 0x1/0x1 lookup 100
ip route add local default dev lo table 100
```

## 配置示例

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

## 平台限制

Redirect 和 TProxy 都**仅限 Linux**。`redir` 包包含平台特定的实现：

- `redir.GetOriginalDestination(conn)` -- 使用 `getsockopt(SO_ORIGINAL_DST)`，仅限 Linux
- `redir.GetOriginalDestinationFromOOB(oob)` -- 解析 `IP_RECVORIGDSTADDR` 辅助数据，仅限 Linux
- `redir.TProxyWriteBack()` -- 设置 `IP_TRANSPARENT`，仅限 Linux

在非 Linux 平台上，这些协议不可用。请改用 TUN inbound 进行透明代理。
