# 进程搜索器

进程搜索器识别哪个本地进程拥有一个网络连接，从而支持基于进程的路由规则（`process_name`、`process_path`、`package_name`）。

**源码**：`common/process/`

## Interface

```go
type Searcher interface {
    FindProcessInfo(ctx context.Context, network string, source netip.AddrPort,
        destination netip.AddrPort) (*adapter.ConnectionOwner, error)
}

type Config struct {
    Logger         log.ContextLogger
    PackageManager tun.PackageManager  // 仅 Android
}

type ConnectionOwner struct {
    ProcessID          uint32
    UserId             int32
    UserName           string
    ProcessPath        string
    AndroidPackageName string
}
```

搜索器返回 `ConnectionOwner` 后，框架通过从 UID 查找 Unix 用户名来丰富信息：

```go
func FindProcessInfo(searcher Searcher, ctx, network, source, destination) (*ConnectionOwner, error) {
    info, err := searcher.FindProcessInfo(ctx, network, source, destination)
    if info.UserId != -1 {
        osUser, _ := user.LookupId(F.ToString(info.UserId))
        if osUser != nil {
            info.UserName = osUser.Username
        }
    }
    return info, nil
}
```

## Linux 实现

**文件**：`searcher_linux.go`、`searcher_linux_shared.go`
**构建约束**：`linux && !android`

### 架构

Linux 搜索器使用两步流程：

1. **Netlink socket 诊断** -- 查找给定连接的 socket inode 和 UID
2. **Procfs 搜索** -- 扫描 `/proc` 找到拥有该 socket inode 的进程

### 步骤 1：Netlink Socket 诊断

```go
func resolveSocketByNetlink(network string, source, destination netip.AddrPort) (inode, uid uint32, err error)
```

这向内核发送 `SOCK_DIAG_BY_FAMILY` netlink 消息：

```go
const sizeOfSocketDiagRequest = syscall.SizeofNlMsghdr + 8 + 48

// 请求结构（72 字节）：
// [0:4]   nlmsg_len    （本机字节序）
// [4:6]   nlmsg_type   = socketDiagByFamily (20)
// [6:8]   nlmsg_flags  = NLM_F_REQUEST | NLM_F_DUMP
// [8:12]  nlmsg_seq    = 0
// [12:16] nlmsg_pid    = 0
// [16]    sdiag_family = AF_INET 或 AF_INET6
// [17]    sdiag_protocol = IPPROTO_TCP 或 IPPROTO_UDP
// [18:20] pad          = 0
// [20:24] idiag_states = 0xFFFFFFFF（所有状态）
// [24:26] source_port  （大端序）
// [26:28] dest_port    = 0
// [28:44] source_addr  （16 字节，填充）
// [44:60] dest_addr    = IPv6 零
// [60:64] idiag_if     = 0
// [64:72] idiag_cookie = 0xFFFFFFFFFFFFFFFF
```

响应中 UID 位于偏移 `[64:68]`，inode 位于偏移 `[68:72]`（均为本机字节序）。

### 步骤 2：Procfs 搜索

```go
func resolveProcessNameByProcSearch(inode, uid uint32) (string, error)
```

扫描 `/proc/[pid]/fd/` 查找匹配 `socket:[inode]` 的符号链接：

1. 列出 `/proc/` 中所有数字的条目（PID）
2. 按 UID 匹配过滤（从 `stat.Uid`）
3. 对每个 PID，枚举 `/proc/[pid]/fd/`
4. 对每个 fd 条目执行 readlink，与 `socket:[inode]` 比较
5. 找到后，readlink `/proc/[pid]/exe` 获取进程路径

## Darwin（macOS）实现

**文件**：`searcher_darwin.go`

### 架构

macOS 使用 `sysctl` 读取内核的 PCB（协议控制块）列表，然后通过源端口和 IP 地址进行匹配。

```go
func findProcessName(network string, ip netip.Addr, port int) (string, error) {
    var spath string
    switch network {
    case "tcp": spath = "net.inet.tcp.pcblist_n"
    case "udp": spath = "net.inet.udp.pcblist_n"
    }
    value, err := unix.SysctlRaw(spath)
    // ...
}
```

### PCB 列表解析

sysctl 返回 `xinpcb_n` + `xsocket_n` 结构的紧凑数组。关键偏移量：

```
// 结构大小取决于 macOS 版本：
//   darwin >= 22 (Ventura+)：每项 408 字节
//   darwin < 22：           每项 384 字节
// TCP 额外增加 208 字节用于 xtcpcb_n

// 每个项目内的偏移（从项目起始）：
//   inp + 18:20  = 源端口（大端序 uint16）
//   inp + 44     = inp_vflag（0x1 = IPv4，0x2 = IPv6）
//   inp + 64:80  = IPv6 地址（或最后 4 字节中的 IPv4）
//   so  + 68:72  = so_last_pid（本机字节序 uint32）
```

找到匹配的 PID 后，调用 `proc_info` 系统调用获取进程路径：

```go
func getExecPathFromPID(pid uint32) (string, error) {
    // SYS_PROC_INFO with PROC_PIDPATHINFO
    buf := make([]byte, 1024)
    syscall.Syscall6(syscall.SYS_PROC_INFO,
        2,              // PROCCALLNUM_PIDINFO
        uintptr(pid),
        0xb,            // PROC_PIDPATHINFO
        0, uintptr(unsafe.Pointer(&buf[0])), 1024)
    return unix.ByteSliceToString(buf), nil
}
```

### UDP 回退

对于 UDP，如果没有找到精确的源 IP 匹配，实现会回退到源地址为未指定（0.0.0.0 或 ::）的匹配条目，因为 UDP socket 可能未绑定到特定地址。

## Windows 实现

**文件**：`searcher_windows.go`

### 架构

Windows 通过 `winiphlpapi` 包使用 IP Helper API（`GetExtendedTcpTable` / `GetExtendedUdpTable`）：

```go
func (s *windowsSearcher) FindProcessInfo(ctx, network, source, destination) (*ConnectionOwner, error) {
    pid, err := winiphlpapi.FindPid(network, source)
    path, err := getProcessPath(pid)
    return &ConnectionOwner{ProcessID: pid, ProcessPath: path, UserId: -1}, nil
}
```

进程路径获取使用 `OpenProcess` + `QueryFullProcessImageName`：

```go
func getProcessPath(pid uint32) (string, error) {
    switch pid {
    case 0: return ":System Idle Process", nil
    case 4: return ":System", nil
    }
    handle, _ := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
    defer windows.CloseHandle(handle)
    buf := make([]uint16, syscall.MAX_LONG_PATH)
    windows.QueryFullProcessImageName(handle, 0, &buf[0], &size)
    return windows.UTF16ToString(buf[:size]), nil
}
```

## Android 实现

**文件**：`searcher_android.go`

### 架构

Android 复用 Linux 的 netlink socket 诊断获取 UID，然后使用 `tun.PackageManager` 将 UID 映射到包名：

```go
func (s *androidSearcher) FindProcessInfo(ctx, network, source, destination) (*ConnectionOwner, error) {
    _, uid, err := resolveSocketByNetlink(network, source, destination)
    // Android 使用用户 ID 重映射：实际 UID = uid % 100000
    if sharedPackage, loaded := s.packageManager.SharedPackageByID(uid % 100000); loaded {
        return &ConnectionOwner{UserId: int32(uid), AndroidPackageName: sharedPackage}, nil
    }
    if packageName, loaded := s.packageManager.PackageByID(uid % 100000); loaded {
        return &ConnectionOwner{UserId: int32(uid), AndroidPackageName: packageName}, nil
    }
    return &ConnectionOwner{UserId: int32(uid)}, nil
}
```

Android 的多用户系统使用 UID 范围：`实际应用 UID = uid % 100000`。`PackageManager` 将这些应用 UID 映射到包名。

## Stub 实现

**文件**：`searcher_stub.go`
**构建约束**：`!linux && !windows && !darwin`

不支持的平台返回 `os.ErrInvalid`：

```go
func NewSearcher(_ Config) (Searcher, error) {
    return nil, os.ErrInvalid
}
```

## 平台 Interface 覆盖

在移动平台（通过 libbox 的 Android/iOS）上，进程搜索器可能被平台 interface 覆盖。`platformInterfaceWrapper` 委派给：
- `procfs` 扫描（当 Android 上 `UseProcFS()` 返回 true 时）
- 平台原生的 `FindConnectionOwner()` 方法

## 进程信息在路由中的使用

当 `route.find_process` 启用时，路由器会为每个新连接调用进程搜索器。结果填充到 `InboundContext.ProcessInfo` 中，路由规则可以据此匹配：

- `process_name` -- 匹配可执行文件名（`ProcessPath` 的基本名）
- `process_path` -- 匹配完整可执行文件路径
- `process_path_regex` -- 对完整路径进行正则匹配
- `package_name` -- 匹配 Android 包名

规则集元数据追踪 `ContainsProcessRule` 以在没有规则需要时避免昂贵的进程查找。

## 重新实现注意事项

1. **Linux**：Netlink 协议文档齐全。`SOCK_DIAG_BY_FAMILY` 消息是标准的。procfs 扫描的复杂度为 O(进程数 * fd 数)，在进程很多的系统上可能较慢
2. **macOS**：sysctl PCB 列表格式未公开文档化，且在 macOS 版本间有变化。通过 `kern.osrelease` 检测结构大小是一种脆弱但必要的启发式方法
3. **Windows**：需要加载 `iphlpapi.dll` 函数。`GetExtendedTcpTable`/`GetExtendedUdpTable` 函数在 MSDN 中有详细文档
4. **Android**：UID 到包名的映射需要访问 Android 包管理器，通常通过平台 interface 绑定
5. **性能**：进程查找按连接执行，可能开销较大。`ContainsProcessRule` 元数据标志允许在不需要时完全跳过
