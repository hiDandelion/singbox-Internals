# 连接管理器

ConnectionManager 处理入站和出站连接之间的实际数据传输。它拨号远端，建立双向复制，并管理连接生命周期。

**源码**: `route/conn.go`

## 结构体

```go
type ConnectionManager struct {
    logger      logger.ContextLogger
    access      sync.Mutex
    connections list.List[io.Closer]  // 跟踪的活跃连接
}
```

## TCP 连接流程 (`NewConnection`)

```go
func (m *ConnectionManager) NewConnection(ctx, this N.Dialer, conn net.Conn, metadata, onClose) {
    // 1. 拨号远端
    if len(metadata.DestinationAddresses) > 0 || metadata.Destination.IsIP() {
        remoteConn, err = dialer.DialSerialNetwork(ctx, this, "tcp",
            metadata.Destination, metadata.DestinationAddresses,
            metadata.NetworkStrategy, metadata.NetworkType,
            metadata.FallbackNetworkType, metadata.FallbackDelay)
    } else {
        remoteConn, err = this.DialContext(ctx, "tcp", metadata.Destination)
    }

    // 2. 报告握手成功（用于需要的协议）
    N.ReportConnHandshakeSuccess(conn, remoteConn)

    // 3. 如果请求了 TLS 分片则应用
    if metadata.TLSFragment || metadata.TLSRecordFragment {
        remoteConn = tf.NewConn(remoteConn, ctx, ...)
    }

    // 4. 触发握手（发送早期数据）
    m.kickWriteHandshake(ctx, conn, remoteConn, false, &done, onClose)
    m.kickWriteHandshake(ctx, remoteConn, conn, true, &done, onClose)

    // 5. 双向复制
    go m.connectionCopy(ctx, conn, remoteConn, false, &done, onClose)
    go m.connectionCopy(ctx, remoteConn, conn, true, &done, onClose)
}
```

### 握手触发

某些协议（例如延迟握手的代理协议）需要在连接完全建立之前写入第一个数据。`kickWriteHandshake` 处理这种情况：

```go
func (m *ConnectionManager) kickWriteHandshake(ctx, source, destination, direction, done, onClose) bool {
    if !N.NeedHandshakeForWrite(destination) {
        return false  // 不需要握手
    }

    // 尝试从源读取缓存数据
    if cachedReader, ok := sourceReader.(N.CachedReader); ok {
        cachedBuffer = cachedReader.ReadCached()
    }

    if cachedBuffer != nil {
        // 写入缓存数据以触发握手
        _, err = destinationWriter.Write(cachedBuffer.Bytes())
    } else {
        // 写入空数据以触发握手
        destination.SetWriteDeadline(time.Now().Add(C.ReadPayloadTimeout))
        _, err = destinationWriter.Write(nil)
    }
    // ...
}
```

这允许早期数据（如 TLS ClientHello）与代理协议握手一起发送，减少往返次数。

### 双向复制

```go
func (m *ConnectionManager) connectionCopy(ctx, source, destination, direction, done, onClose) {
    _, err := bufio.CopyWithIncreateBuffer(destination, source,
        bufio.DefaultIncreaseBufferAfter, bufio.DefaultBatchSize)

    if err != nil {
        common.Close(source, destination)
    } else if duplexDst, isDuplex := destination.(N.WriteCloser); isDuplex {
        duplexDst.CloseWrite()  // 半关闭用于优雅关闭
    } else {
        destination.Close()
    }

    // done 是原子变量 -- 第一个完成的 goroutine 设置它
    if done.Swap(true) {
        // 第二个 goroutine：调用 onClose 并关闭两端
        if onClose != nil { onClose(err) }
        common.Close(source, destination)
    }
}
```

关键行为：
- 使用 `bufio.CopyWithIncreateBuffer` 进行自适应缓冲区大小调整
- 通过 `N.WriteCloser` 支持半关闭 (FIN)
- `atomic.Bool` 确保 `onClose` 恰好被调用一次
- 分别记录上传/下载方向的日志

## UDP 连接流程 (`NewPacketConnection`)

```go
func (m *ConnectionManager) NewPacketConnection(ctx, this, conn, metadata, onClose) {
    if metadata.UDPConnect {
        // 连接式 UDP：拨号到特定目标
        remoteConn, err = this.DialContext(ctx, "udp", metadata.Destination)
        remotePacketConn = bufio.NewUnbindPacketConn(remoteConn)
    } else {
        // 非连接式 UDP：监听数据包
        remotePacketConn, destinationAddress, err = this.ListenPacket(ctx, metadata.Destination)
    }

    // NAT 处理：当解析的 IP 与域名不同时转换地址
    if destinationAddress.IsValid() {
        remotePacketConn = bufio.NewNATPacketConn(remotePacketConn, destination, originDestination)
    }

    // UDP 超时（协议感知）
    if udpTimeout > 0 {
        ctx, conn = canceler.NewPacketConn(ctx, conn, udpTimeout)
    }

    // 双向数据包复制
    go m.packetConnectionCopy(ctx, conn, destination, false, &done, onClose)
    go m.packetConnectionCopy(ctx, destination, conn, true, &done, onClose)
}
```

### UDP 超时

UDP 超时按优先级顺序确定：
1. `metadata.UDPTimeout`（由规则动作设置）
2. `C.ProtocolTimeouts[protocol]`（协议特定的，例如 DNS = 10 秒）
3. 默认超时

### NAT PacketConn

当 DNS 将域名解析为 IP 时，远端套接字使用 IP。但客户端期望响应来自原始域名。`bufio.NewNATPacketConn` 进行地址转换：

```
Client → conn.ReadPacket() → {dest: example.com:443}
         ↓ NAT 转换
Remote → remoteConn.WritePacket() → {dest: 1.2.3.4:443}
         ↓ 响应
Remote → remoteConn.ReadPacket() → {from: 1.2.3.4:443}
         ↓ NAT 反向转换
Client → conn.WritePacket() → {from: example.com:443}
```

## 连接跟踪

ConnectionManager 跟踪所有活跃连接，用于监控和清理：

```go
func (m *ConnectionManager) TrackConn(conn net.Conn) net.Conn {
    element := m.connections.PushBack(conn)
    return &trackedConn{Conn: conn, manager: m, element: element}
}

// trackedConn 在 Close() 时从列表中移除自身
func (c *trackedConn) Close() error {
    c.manager.connections.Remove(c.element)
    return c.Conn.Close()
}
```

`CloseAll()` 在关闭期间被调用以终止所有活跃连接。

## 串行拨号

当有多个目标地址可用时（来自 DNS 解析），`dialer.DialSerialNetwork` 按顺序尝试：

```go
// 逐个尝试每个地址，遵守网络策略（优先蜂窝网络等）
func DialSerialNetwork(ctx, dialer, network, destination, addresses,
    strategy, networkType, fallbackType, fallbackDelay) (net.Conn, error)
```

这与网络策略系统集成，适用于多接口设备（移动端）。
