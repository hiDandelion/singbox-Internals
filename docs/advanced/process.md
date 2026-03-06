# Process Searcher

The process searcher identifies which local process owns a network connection, enabling process-based routing rules (`process_name`, `process_path`, `package_name`).

**Source**: `common/process/`

## Interface

```go
type Searcher interface {
    FindProcessInfo(ctx context.Context, network string, source netip.AddrPort,
        destination netip.AddrPort) (*adapter.ConnectionOwner, error)
}

type Config struct {
    Logger         log.ContextLogger
    PackageManager tun.PackageManager  // Android only
}

type ConnectionOwner struct {
    ProcessID          uint32
    UserId             int32
    UserName           string
    ProcessPath        string
    AndroidPackageName string
}
```

After the searcher returns a `ConnectionOwner`, the framework enriches it by looking up the Unix username from the UID:

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

## Linux Implementation

**File**: `searcher_linux.go`, `searcher_linux_shared.go`
**Build constraint**: `linux && !android`

### Architecture

The Linux searcher uses a two-step process:

1. **Netlink socket diagnosis** -- find the socket inode and UID for a given connection
2. **Procfs search** -- scan `/proc` to find which process owns that socket inode

### Step 1: Netlink Socket Diagnosis

```go
func resolveSocketByNetlink(network string, source, destination netip.AddrPort) (inode, uid uint32, err error)
```

This sends a `SOCK_DIAG_BY_FAMILY` netlink message to the kernel:

```go
const sizeOfSocketDiagRequest = syscall.SizeofNlMsghdr + 8 + 48

// Request structure (72 bytes):
// [0:4]   nlmsg_len    (native endian)
// [4:6]   nlmsg_type   = socketDiagByFamily (20)
// [6:8]   nlmsg_flags  = NLM_F_REQUEST | NLM_F_DUMP
// [8:12]  nlmsg_seq    = 0
// [12:16] nlmsg_pid    = 0
// [16]    sdiag_family = AF_INET or AF_INET6
// [17]    sdiag_protocol = IPPROTO_TCP or IPPROTO_UDP
// [18:20] pad          = 0
// [20:24] idiag_states = 0xFFFFFFFF (all states)
// [24:26] source_port  (big-endian)
// [26:28] dest_port    = 0
// [28:44] source_addr  (16 bytes, padded)
// [44:60] dest_addr    = IPv6 zero
// [60:64] idiag_if     = 0
// [64:72] idiag_cookie = 0xFFFFFFFFFFFFFFFF
```

The response contains UID at offset `[64:68]` and inode at offset `[68:72]` (both native endian).

### Step 2: Procfs Search

```go
func resolveProcessNameByProcSearch(inode, uid uint32) (string, error)
```

This scans `/proc/[pid]/fd/` for a symlink matching `socket:[inode]`:

1. List all `/proc/` entries that are numeric (PIDs)
2. Filter by UID match (from `stat.Uid`)
3. For each PID, enumerate `/proc/[pid]/fd/`
4. Readlink each fd entry, compare with `socket:[inode]`
5. When found, readlink `/proc/[pid]/exe` to get the process path

## Darwin (macOS) Implementation

**File**: `searcher_darwin.go`

### Architecture

macOS uses `sysctl` to read the kernel's PCB (Protocol Control Block) list, then matches by source port and IP address.

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

### PCB List Parsing

The sysctl returns a packed array of `xinpcb_n` + `xsocket_n` structures. Key offsets:

```
// Structure sizes depend on macOS version:
//   darwin >= 22 (Ventura+): 408 bytes per item
//   darwin < 22:             384 bytes per item
// TCP adds 208 bytes for xtcpcb_n

// Within each item (offsets from item start):
//   inp + 18:20  = source port (big-endian uint16)
//   inp + 44     = inp_vflag (0x1 = IPv4, 0x2 = IPv6)
//   inp + 64:80  = IPv6 address (or IPv4 in last 4 bytes)
//   so  + 68:72  = so_last_pid (native-endian uint32)
```

After finding the matching PID, it calls `proc_info` syscall to get the process path:

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

### UDP Fallback

For UDP, if no exact source IP match is found, the implementation falls back to a matching entry with an unspecified (0.0.0.0 or ::) source address, since UDP sockets may not be bound to a specific address.

## Windows Implementation

**File**: `searcher_windows.go`

### Architecture

Windows uses the IP Helper API (`GetExtendedTcpTable` / `GetExtendedUdpTable`) via the `winiphlpapi` package:

```go
func (s *windowsSearcher) FindProcessInfo(ctx, network, source, destination) (*ConnectionOwner, error) {
    pid, err := winiphlpapi.FindPid(network, source)
    path, err := getProcessPath(pid)
    return &ConnectionOwner{ProcessID: pid, ProcessPath: path, UserId: -1}, nil
}
```

Process path retrieval uses `OpenProcess` + `QueryFullProcessImageName`:

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

## Android Implementation

**File**: `searcher_android.go`

### Architecture

Android reuses the Linux netlink socket diagnosis to get the UID, then maps the UID to a package name using the `tun.PackageManager`:

```go
func (s *androidSearcher) FindProcessInfo(ctx, network, source, destination) (*ConnectionOwner, error) {
    _, uid, err := resolveSocketByNetlink(network, source, destination)
    // Android uses user ID remapping: actual UID = uid % 100000
    if sharedPackage, loaded := s.packageManager.SharedPackageByID(uid % 100000); loaded {
        return &ConnectionOwner{UserId: int32(uid), AndroidPackageName: sharedPackage}, nil
    }
    if packageName, loaded := s.packageManager.PackageByID(uid % 100000); loaded {
        return &ConnectionOwner{UserId: int32(uid), AndroidPackageName: packageName}, nil
    }
    return &ConnectionOwner{UserId: int32(uid)}, nil
}
```

Android's multi-user system uses UID ranges: `actual_app_uid = uid % 100000`. The `PackageManager` maps these app UIDs to package names.

## Stub Implementation

**File**: `searcher_stub.go`
**Build constraint**: `!linux && !windows && !darwin`

Unsupported platforms return `os.ErrInvalid`:

```go
func NewSearcher(_ Config) (Searcher, error) {
    return nil, os.ErrInvalid
}
```

## Platform Interface Override

On mobile platforms (Android/iOS via libbox), the process searcher may be overridden by the platform interface. The `platformInterfaceWrapper` delegates to either:
- `procfs` scanning (when `UseProcFS()` returns true on Android)
- The platform's native `FindConnectionOwner()` method

## How Process Info Is Used in Routing

When `route.find_process` is enabled, the router calls the process searcher for each new connection. The result populates `InboundContext.ProcessInfo`, which routing rules can match against:

- `process_name` -- matches the executable filename (basename of `ProcessPath`)
- `process_path` -- matches the full executable path
- `process_path_regex` -- regex match on the full path
- `package_name` -- matches Android package name

Rule set metadata tracks `ContainsProcessRule` to avoid the expensive process lookup when no rules need it.

## Reimplementation Notes

1. **Linux**: The netlink protocol is well-documented. The `SOCK_DIAG_BY_FAMILY` message is standard. The procfs scan is O(processes * fds) and can be slow on systems with many processes
2. **macOS**: The sysctl PCB list format is not publicly documented and changes between macOS versions. The struct size detection via `kern.osrelease` is a fragile but necessary heuristic
3. **Windows**: Requires loading `iphlpapi.dll` functions. The `GetExtendedTcpTable`/`GetExtendedUdpTable` functions are well-documented in MSDN
4. **Android**: UID-to-package mapping requires access to the Android package manager, typically via the platform interface binding
5. **Performance**: Process lookup is performed per-connection and can be expensive. The `ContainsProcessRule` metadata flag allows skipping it entirely when not needed
