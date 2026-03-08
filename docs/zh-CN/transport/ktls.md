# 内核 TLS（kTLS）

源码：`common/tls/ktls.go`、`common/ktls/ktls.go`、`common/ktls/ktls_linux.go`、`common/ktls/ktls_cipher_suites_linux.go`、`common/ktls/ktls_const.go`、`common/ktls/ktls_write.go`、`common/ktls/ktls_read.go`、`common/ktls/ktls_read_wait.go`、`common/ktls/ktls_close.go`

## 概述

kTLS 将 TLS 加密/解密卸载到 Linux 内核，实现零拷贝的 sendfile 和 splice 操作。它受构建约束限制：`linux && go1.25 && badlinkname`。

仅支持 TLS 1.3。该实现处理 TX（发送）和 RX（接收）两个方向的卸载。

## 集成层

`common/tls/ktls.go` 文件提供包装类型，在 TLS handshake 完成时进行拦截：

```go
type KTLSClientConfig struct {
    Config
    logger             logger.ContextLogger
    kernelTx, kernelRx bool
}

func (w *KTLSClientConfig) ClientHandshake(ctx context.Context, conn net.Conn) (aTLS.Conn, error) {
    tlsConn, err := aTLS.ClientHandshake(ctx, conn, w.Config)
    if err != nil { return nil, err }
    kConn, err := ktls.NewConn(ctx, w.logger, tlsConn, w.kernelTx, w.kernelRx)
    if err != nil {
        tlsConn.Close()
        return nil, E.Cause(err, "initialize kernel TLS")
    }
    return kConn, nil
}
```

服务端类似，使用 `KTlSServerConfig`。

## Conn 初始化

```go
type Conn struct {
    aTLS.Conn
    ctx             context.Context
    logger          logger.ContextLogger
    conn            net.Conn
    rawConn         *badtls.RawConn
    syscallConn     syscall.Conn
    rawSyscallConn  syscall.RawConn
    readWaitOptions N.ReadWaitOptions
    kernelTx        bool
    kernelRx        bool
    pendingRxSplice bool
}
```

初始化步骤：

1. **加载内核模块**：`Load()` 通过 `modprobe` 确保 `tls` 内核模块已加载
2. **提取 syscall.Conn**：底层 `net.Conn` 必须实现 `syscall.Conn` 以提供原始文件描述符访问
3. **提取原始 TLS 状态**：使用 `badtls.NewRawConn` 访问内部 TLS 状态（加密密钥、IV、序列号）
4. **验证 TLS 1.3**：仅支持 `tls.VersionTLS13`
5. **处理待处理记录**：从 TLS 缓冲区排空任何 handshake 后消息
6. **设置内核**：使用提取的加密状态调用 `setupKernel`

## 内核设置（Linux）

```go
func (c *Conn) setupKernel(txOffload, rxOffload bool) error {
    // 1. Set TCP_ULP to "tls"
    rawSyscallConn.Control(func(fd uintptr) {
        unix.SetsockoptString(int(fd), unix.SOL_TCP, unix.TCP_ULP, "tls")
    })

    // 2. Extract cipher info and setup TX/RX
    cipherInfo := kernelCipher(c.rawConn)
    if txOffload {
        unix.SetsockoptString(int(fd), SOL_TLS, TLS_TX, cipherInfo.txData)
        c.kernelTx = true
    }
    if rxOffload {
        unix.SetsockoptString(int(fd), SOL_TLS, TLS_RX, cipherInfo.rxData)
        c.kernelRx = true
    }

    // 3. Enable TX zerocopy (optional)
    unix.SetsockoptInt(int(fd), SOL_TLS, TLS_TX_ZEROCOPY_RO, 1)
    // 4. Disable RX padding (optional)
    unix.SetsockoptInt(int(fd), SOL_TLS, TLS_RX_EXPECT_NO_PAD, 1)
}
```

### 支持的密码套件

内核密码映射器将 TLS 密码套件 ID 转换为内核特定的加密结构：

| TLS 密码套件 | 内核密码 | 密钥大小 |
|------------------|---------------|----------|
| `TLS_AES_128_GCM_SHA256` | `TLS_CIPHER_AES_GCM_128` | 16 字节 |
| `TLS_AES_256_GCM_SHA384` | `TLS_CIPHER_AES_GCM_256` | 32 字节 |
| `TLS_CHACHA20_POLY1305_SHA256` | `TLS_CIPHER_CHACHA20_POLY1305` | 32 字节 |
| `TLS_AES_128_CCM_SHA256` | `TLS_CIPHER_AES_CCM_128` | 16 字节 |

每个密码 struct 包含：TLS 版本、密码类型、IV、密钥、盐和记录序列号，从 TLS 连接的内部状态提取。

### 内核版本检测

功能可用性取决于内核版本：

| 功能 | 最低内核版本 |
|---------|---------------|
| kTLS 基础版（TX） | 4.13 |
| kTLS RX | 4.17 |
| AES-256-GCM | 5.1 |
| ChaCha20-Poly1305 | 5.11 |
| TX 零拷贝 | 5.19 |
| RX 无填充 | 6.0 |
| 密钥更新 | 6.14 |

## Splice 支持

kTLS 提供 `SyscallConnForRead` 和 `SyscallConnForWrite` 以启用内核级 splice：

```go
func (c *Conn) SyscallConnForRead() syscall.RawConn {
    if !c.kernelRx { return nil }
    if !*c.rawConn.IsClient {
        c.logger.WarnContext(c.ctx, "ktls: RX splice is unavailable on the server side")
        return nil
    }
    return c.rawSyscallConn
}

func (c *Conn) SyscallConnForWrite() syscall.RawConn {
    if !c.kernelTx { return nil }
    return c.rawSyscallConn
}
```

由于已知的内核限制，RX splice 仅在客户端可用。

## 错误处理

RX splice 期间的非应用数据记录返回 `EINVAL`：

```go
func (c *Conn) HandleSyscallReadError(inputErr error) ([]byte, error) {
    if errors.Is(inputErr, unix.EINVAL) {
        c.pendingRxSplice = true
        err := c.readRecord()  // Read and process the non-app record
        // Return any buffered application data
    } else if errors.Is(inputErr, unix.EBADMSG) {
        return nil, c.rawConn.In.SetErrorLocked(c.sendAlert(alertBadRecordMAC))
    }
}
```

## 写入路径

内核 TX 写入路径使用 `sendmsg` 配合控制消息来指示 TLS 记录类型：

```go
func (c *Conn) writeKernelRecord(b []byte, recordType byte) (int, error) {
    // Uses cmsg with SOL_TLS/TLS_SET_RECORD_TYPE
    // Splits writes at MSS boundaries for optimal performance
}
```

## 关闭

关闭时通过内核发送 TLS close_notify 警报：

```go
func (c *Conn) Close() error {
    if c.kernelTx {
        c.writeKernelRecord([]byte{alertCloseNotify}, recordTypeAlert)
    }
    return c.conn.Close()
}
```

## 性能考量

sing-box 作者明确警告了 kTLS 性能：

- kTLS TX 仅在 `sendfile`/`splice` 场景下有用（文件服务、kTLS 连接之间的代理）
- 根据源代码中的警告，kTLS RX "肯定会降低性能"
- 内核 TLS 实现避免了加密的上下文切换开销，但增加了记录帧处理的开销
- kTLS 在高吞吐量、低 CPU 场景中最为有益
