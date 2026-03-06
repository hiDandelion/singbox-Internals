# Kernel TLS (kTLS)

Source: `common/tls/ktls.go`, `common/ktls/ktls.go`, `common/ktls/ktls_linux.go`, `common/ktls/ktls_cipher_suites_linux.go`, `common/ktls/ktls_const.go`, `common/ktls/ktls_write.go`, `common/ktls/ktls_read.go`, `common/ktls/ktls_read_wait.go`, `common/ktls/ktls_close.go`

## Overview

kTLS offloads TLS encryption/decryption to the Linux kernel, enabling zero-copy sendfile and splice operations. It is gated by build constraints: `linux && go1.25 && badlinkname`.

Only TLS 1.3 is supported. The implementation handles both TX (send) and RX (receive) offload.

## Integration Layer

The `common/tls/ktls.go` file provides wrapper types that intercept TLS handshake completion:

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

Similarly for the server side with `KTlSServerConfig`.

## Conn Initialization

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

Initialization steps:

1. **Load kernel module**: `Load()` ensures the `tls` kernel module is loaded via `modprobe`
2. **Extract syscall.Conn**: The underlying `net.Conn` must implement `syscall.Conn` for raw fd access
3. **Extract raw TLS state**: Uses `badtls.NewRawConn` to access internal TLS state (cipher keys, IVs, sequence numbers)
4. **Verify TLS 1.3**: Only `tls.VersionTLS13` is supported
5. **Process pending records**: Drains any post-handshake messages from the TLS buffer
6. **Setup kernel**: Calls `setupKernel` with the extracted crypto state

## Kernel Setup (Linux)

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

### Supported Cipher Suites

The kernel cipher mapper translates TLS cipher suite IDs to kernel-specific crypto structures:

| TLS Cipher Suite | Kernel Cipher | Key Size |
|------------------|---------------|----------|
| `TLS_AES_128_GCM_SHA256` | `TLS_CIPHER_AES_GCM_128` | 16 bytes |
| `TLS_AES_256_GCM_SHA384` | `TLS_CIPHER_AES_GCM_256` | 32 bytes |
| `TLS_CHACHA20_POLY1305_SHA256` | `TLS_CIPHER_CHACHA20_POLY1305` | 32 bytes |
| `TLS_AES_128_CCM_SHA256` | `TLS_CIPHER_AES_CCM_128` | 16 bytes |

Each cipher struct contains: TLS version, cipher type, IV, key, salt, and record sequence number, extracted from the TLS connection's internal state.

### Kernel Version Detection

Feature availability depends on kernel version:

| Feature | Minimum Kernel |
|---------|---------------|
| kTLS basic (TX) | 4.13 |
| kTLS RX | 4.17 |
| AES-256-GCM | 5.1 |
| ChaCha20-Poly1305 | 5.11 |
| TX zerocopy | 5.19 |
| RX no-padding | 6.0 |
| Key update | 6.14 |

## Splice Support

kTLS provides `SyscallConnForRead` and `SyscallConnForWrite` to enable kernel-level splice:

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

RX splice is only available on the client side due to a known kernel limitation.

## Error Handling

Non-application-data records during RX splice return `EINVAL`:

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

## Write Path

The kernel TX write path uses `sendmsg` with control messages to indicate the TLS record type:

```go
func (c *Conn) writeKernelRecord(b []byte, recordType byte) (int, error) {
    // Uses cmsg with SOL_TLS/TLS_SET_RECORD_TYPE
    // Splits writes at MSS boundaries for optimal performance
}
```

## Close

Close sends a TLS close_notify alert through the kernel:

```go
func (c *Conn) Close() error {
    if c.kernelTx {
        c.writeKernelRecord([]byte{alertCloseNotify}, recordTypeAlert)
    }
    return c.conn.Close()
}
```

## Performance Considerations

The sing-box authors explicitly warn about kTLS performance:

- kTLS TX is useful only with `sendfile`/`splice` scenarios (file serving, proxying between kTLS connections)
- kTLS RX "will definitely reduce performance" according to the source code warnings
- The kernel TLS implementation avoids context switches for crypto but adds overhead for record framing
- kTLS is most beneficial for high-throughput, low-CPU scenarios
