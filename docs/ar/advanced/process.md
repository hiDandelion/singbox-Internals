# باحث العمليات

يحدد باحث العمليات أي عملية محلية تملك اتصال شبكة معين، مما يمكّن قواعد التوجيه المعتمدة على العمليات (`process_name`، `process_path`، `package_name`).

**المصدر**: `common/process/`

## الواجهة

```go
type Searcher interface {
    FindProcessInfo(ctx context.Context, network string, source netip.AddrPort,
        destination netip.AddrPort) (*adapter.ConnectionOwner, error)
}

type Config struct {
    Logger         log.ContextLogger
    PackageManager tun.PackageManager  // Android فقط
}

type ConnectionOwner struct {
    ProcessID          uint32
    UserId             int32
    UserName           string
    ProcessPath        string
    AndroidPackageName string
}
```

بعد أن يُرجع الباحث `ConnectionOwner`، يقوم الإطار بإثرائه عبر البحث عن اسم مستخدم Unix من UID:

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

## تطبيق Linux

**الملف**: `searcher_linux.go`، `searcher_linux_shared.go`
**قيد البناء**: `linux && !android`

### الهندسة

يستخدم باحث Linux عملية من خطوتين:

1. **تشخيص مقبس Netlink** -- العثور على inode المقبس و UID لاتصال معين
2. **بحث Procfs** -- فحص `/proc` للعثور على العملية التي تملك inode المقبس ذلك

### الخطوة 1: تشخيص مقبس Netlink

```go
func resolveSocketByNetlink(network string, source, destination netip.AddrPort) (inode, uid uint32, err error)
```

يُرسل هذا رسالة `SOCK_DIAG_BY_FAMILY` عبر netlink إلى النواة:

```go
const sizeOfSocketDiagRequest = syscall.SizeofNlMsghdr + 8 + 48

// هيكل الطلب (72 بايت):
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

يحتوي الرد على UID عند الإزاحة `[64:68]` و inode عند الإزاحة `[68:72]` (كلاهما بترتيب بايت أصلي).

### الخطوة 2: بحث Procfs

```go
func resolveProcessNameByProcSearch(inode, uid uint32) (string, error)
```

يفحص هذا `/proc/[pid]/fd/` بحثاً عن رابط رمزي يطابق `socket:[inode]`:

1. إدراج جميع مدخلات `/proc/` الرقمية (معرفات العمليات)
2. التصفية بمطابقة UID (من `stat.Uid`)
3. لكل PID، تعداد `/proc/[pid]/fd/`
4. قراءة رابط كل مدخل fd، ومقارنته مع `socket:[inode]`
5. عند العثور عليه، قراءة رابط `/proc/[pid]/exe` للحصول على مسار العملية

## تطبيق Darwin (macOS)

**الملف**: `searcher_darwin.go`

### الهندسة

يستخدم macOS `sysctl` لقراءة قائمة PCB (كتلة التحكم في البروتوكول) من النواة، ثم يطابق حسب منفذ المصدر وعنوان IP.

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

### تحليل قائمة PCB

يُرجع sysctl مصفوفة مضغوطة من هياكل `xinpcb_n` + `xsocket_n`. الإزاحات الرئيسية:

```
// أحجام الهيكل تعتمد على إصدار macOS:
//   darwin >= 22 (Ventura+): 408 بايت لكل عنصر
//   darwin < 22:             384 بايت لكل عنصر
// TCP يضيف 208 بايت لـ xtcpcb_n

// داخل كل عنصر (الإزاحات من بداية العنصر):
//   inp + 18:20  = منفذ المصدر (big-endian uint16)
//   inp + 44     = inp_vflag (0x1 = IPv4, 0x2 = IPv6)
//   inp + 64:80  = عنوان IPv6 (أو IPv4 في آخر 4 بايت)
//   so  + 68:72  = so_last_pid (native-endian uint32)
```

بعد العثور على PID المطابق، يستدعي syscall `proc_info` للحصول على مسار العملية:

```go
func getExecPathFromPID(pid uint32) (string, error) {
    // SYS_PROC_INFO مع PROC_PIDPATHINFO
    buf := make([]byte, 1024)
    syscall.Syscall6(syscall.SYS_PROC_INFO,
        2,              // PROCCALLNUM_PIDINFO
        uintptr(pid),
        0xb,            // PROC_PIDPATHINFO
        0, uintptr(unsafe.Pointer(&buf[0])), 1024)
    return unix.ByteSliceToString(buf), nil
}
```

### الرجوع لـ UDP

بالنسبة لـ UDP، إذا لم يُعثر على تطابق دقيق لعنوان IP المصدر، يرجع التطبيق إلى مدخل مطابق بعنوان مصدر غير محدد (0.0.0.0 أو ::)، لأن مقابس UDP قد لا تكون مرتبطة بعنوان محدد.

## تطبيق Windows

**الملف**: `searcher_windows.go`

### الهندسة

يستخدم Windows واجهة IP Helper API (`GetExtendedTcpTable` / `GetExtendedUdpTable`) عبر حزمة `winiphlpapi`:

```go
func (s *windowsSearcher) FindProcessInfo(ctx, network, source, destination) (*ConnectionOwner, error) {
    pid, err := winiphlpapi.FindPid(network, source)
    path, err := getProcessPath(pid)
    return &ConnectionOwner{ProcessID: pid, ProcessPath: path, UserId: -1}, nil
}
```

استرجاع مسار العملية يستخدم `OpenProcess` + `QueryFullProcessImageName`:

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

## تطبيق Android

**الملف**: `searcher_android.go`

### الهندسة

يعيد Android استخدام تشخيص مقبس netlink في Linux للحصول على UID، ثم يربط UID باسم الحزمة باستخدام `tun.PackageManager`:

```go
func (s *androidSearcher) FindProcessInfo(ctx, network, source, destination) (*ConnectionOwner, error) {
    _, uid, err := resolveSocketByNetlink(network, source, destination)
    // Android يستخدم إعادة تعيين معرف المستخدم: UID الفعلي = uid % 100000
    if sharedPackage, loaded := s.packageManager.SharedPackageByID(uid % 100000); loaded {
        return &ConnectionOwner{UserId: int32(uid), AndroidPackageName: sharedPackage}, nil
    }
    if packageName, loaded := s.packageManager.PackageByID(uid % 100000); loaded {
        return &ConnectionOwner{UserId: int32(uid), AndroidPackageName: packageName}, nil
    }
    return &ConnectionOwner{UserId: int32(uid)}, nil
}
```

نظام المستخدمين المتعددين في Android يستخدم نطاقات UID: `actual_app_uid = uid % 100000`. `PackageManager` يربط معرفات التطبيقات هذه بأسماء الحزم.

## التطبيق البديل (Stub)

**الملف**: `searcher_stub.go`
**قيد البناء**: `!linux && !windows && !darwin`

المنصات غير المدعومة تُرجع `os.ErrInvalid`:

```go
func NewSearcher(_ Config) (Searcher, error) {
    return nil, os.ErrInvalid
}
```

## تجاوز واجهة المنصة

على المنصات المحمولة (Android/iOS عبر libbox)، قد يتم تجاوز باحث العمليات بواسطة واجهة المنصة. `platformInterfaceWrapper` يفوض إلى أحد:
- فحص `procfs` (عندما يُرجع `UseProcFS()` true على Android)
- طريقة `FindConnectionOwner()` الأصلية للمنصة

## كيف تُستخدم معلومات العملية في التوجيه

عند تفعيل `route.find_process`، يستدعي الموجه باحث العمليات لكل اتصال جديد. تملأ النتيجة `InboundContext.ProcessInfo`، والتي يمكن لقواعد التوجيه مطابقتها مع:

- `process_name` -- يطابق اسم الملف التنفيذي (الاسم الأساسي لـ `ProcessPath`)
- `process_path` -- يطابق المسار الكامل للملف التنفيذي
- `process_path_regex` -- مطابقة تعبير نمطي على المسار الكامل
- `package_name` -- يطابق اسم حزمة Android

البيانات الوصفية لمجموعة القواعد تتتبع `ContainsProcessRule` لتجنب البحث المكلف عن العمليات عندما لا تحتاجه أي قاعدة.

## ملاحظات إعادة التنفيذ

1. **Linux**: بروتوكول netlink موثق جيداً. رسالة `SOCK_DIAG_BY_FAMILY` قياسية. فحص procfs بتعقيد O(العمليات * واصفات الملفات) ويمكن أن يكون بطيئاً على الأنظمة ذات العمليات الكثيرة
2. **macOS**: تنسيق قائمة PCB عبر sysctl غير موثق علنياً ويتغير بين إصدارات macOS. اكتشاف حجم الهيكل عبر `kern.osrelease` هو أسلوب هش لكنه ضروري
3. **Windows**: يتطلب تحميل دوال `iphlpapi.dll`. دوال `GetExtendedTcpTable`/`GetExtendedUdpTable` موثقة جيداً في MSDN
4. **Android**: ربط UID باسم الحزمة يتطلب الوصول إلى مدير حزم Android، عادة عبر ربط واجهة المنصة
5. **الأداء**: يتم البحث عن العملية لكل اتصال ويمكن أن يكون مكلفاً. علامة البيانات الوصفية `ContainsProcessRule` تسمح بتخطيه كلياً عندما لا يكون مطلوباً
