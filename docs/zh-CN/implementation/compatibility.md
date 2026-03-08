# 线格式兼容性

本文档描述了 sing-box 支持的代理协议的字节级线格式，面向需要与现有 sing-box（和 Xray-core）实例互操作的重新实现者。

## VLESS 线格式

VLESS 在 `sing-vmess/vless` 库中实现。sing-box 将所有线格式处理委派给此库。

### 请求头

```
+----------+---------+---------+----------+---------+-------------------+
| Version  | UUID    | Addons  | Command  | Dest    | Payload           |
| 1 字节   | 16 字节 | varint+ | 1 字节   | 可变    | ...               |
+----------+---------+---------+----------+---------+-------------------+
```

| 字段 | 大小 | 描述 |
|------|------|------|
| Version | 1 字节 | 协议版本，始终为 `0` |
| UUID | 16 字节 | 二进制形式的用户 UUID |
| Addons Length | 1 字节 | protobuf 编码的 addons 长度（无则为 0） |
| Addons | 可变 | Protobuf addons（包含用于 XTLS 的 Flow 字段） |
| Command | 1 字节 | `0x01` = TCP，`0x02` = UDP，`0x03` = MUX |
| Destination | 可变 | SOCKS5 地址格式（见下文） |

### 响应头

```
+----------+---------+
| Version  | Addons  |
| 1 字节   | varint+ |
+----------+---------+
```

| 字段 | 大小 | 描述 |
|------|------|------|
| Version | 1 字节 | 始终为 `0` |
| Addons Length | 1 字节 | protobuf addons 长度（通常为 `0`） |

响应头之后，数据作为原始 TCP 流双向传输。

### SOCKS5 地址格式

在目的地字段中使用：

```
Type 0x01 (IPv4):  [1 字节类型] [4 字节地址] [2 字节端口 大端序]
Type 0x03 (FQDN):  [1 字节类型] [1 字节长度] [N 字节域名] [2 字节端口 大端序]
Type 0x04 (IPv6):  [1 字节类型] [16 字节地址] [2 字节端口 大端序]
```

### 包编码

VLESS 支持三种 UDP 包编码模式：

#### 1. 普通（无编码）

每个 UDP 包作为单独的 VLESS 连接发送，命令为 `0x02`。效率低但简单。

#### 2. PacketAddr

使用魔法 FQDN `sp.packet-addr.v2fly.arpa` 作为 VLESS 目的地。连接内每个 UDP 包的帧格式为：

```
[SOCKS5 地址] [2 字节载荷长度 大端序] [载荷]
```

#### 3. XUDP（默认）

在命令为 `0x03`（MUX）的 VLESS 连接中使用 VMess 风格的 XUDP 编码。每个包使用类似 VMess XUDP 的会话管理进行帧封装。

### Flow：xtls-rprx-vision

当配置 `flow: "xtls-rprx-vision"` 时，VLESS 使用直接 TLS 转发。客户端：
1. 从内部连接读取 TLS 记录
2. 填充短记录以隐藏记录长度模式
3. TLS 握手完成后转为原始复制

这需要代理层具有 TLS 级别的感知。

## VMess 线格式

VMess 在 `sing-vmess` 库中实现。

### 密钥派生

```
请求密钥：MD5(UUID 字节)
请求 IV：MD5(时间戳 + UUID 字节)
```

时间戳是当前 Unix 秒数，编码为大端序 int64，认证容忍窗口为 30 秒。

### 请求头（AlterId = 0，AEAD）

现代 AEAD 格式（无 alterId / alterId = 0）：

```
认证：
  [16 字节：使用 UUID 作为密钥的时间戳 HMAC-MD5]

加密头（AES-128-GCM）：
  [1 字节：版本 (1)]
  [16 字节：请求体 IV]
  [16 字节：请求体密钥]
  [1 字节：响应认证 V]
  [1 字节：选项标志]
    bit 0：分块流（始终设置）
    bit 1：连接复用（已弃用）
    bit 2：分块掩码（global_padding）
    bit 3：认证长度
    bit 4：填充
  [1 字节：填充长度 P（高 4 位）+ 安全模式（低 4 位）]
  [1 字节：保留 (0)]
  [1 字节：命令（0x01=TCP，0x02=UDP）]
  [2 字节：端口 大端序]
  [地址：类型 + 地址]
  [P 字节：随机填充]
  [4 字节：头部的 FNV1a 哈希]
```

安全模式值（低 4 位）：
- `0x00`：旧版（AES-128-CFB）
- `0x03`：AES-128-GCM
- `0x04`：ChaCha20-Poly1305
- `0x05`：None（明文）
- `0x06`：Zero（无加密，认证长度模式）

### 响应头

```
[1 字节：响应认证 V（必须与请求匹配）]
[1 字节：选项标志]
[1 字节：命令 (0)]
[1 字节：命令长度 (0)]
```

### 数据帧（分块流）

每个数据分块：

```
无认证长度：
  [2 字节：长度 大端序] [加密载荷]

有认证长度：
  [2 字节：加密长度] [加密载荷]
  （长度本身使用单独的 AEAD 加密）
```

分块掩码将长度与从 IV 派生的哈希进行异或，使长度分析更困难。

### 包编码（XUDP）

VMess 支持 XUDP 用于 UDP-over-TCP。XUDP 使用基于会话的多路复用，每个 UDP "连接"获得一个会话 ID：

```
[2 字节：会话 ID]
[1 字节：状态（new/keep/end）]
[1 字节：填充长度]
[地址：目的地]
[2 字节：载荷长度]
[载荷]
[填充]
```

## Trojan 线格式

Trojan 是一个简单的密码认证协议。sing-box 的实现在 `transport/trojan/` 中。

### 密钥派生

```go
func Key(password string) [56]byte {
    hash := sha256.New224()  // SHA-224，产生 28 字节
    hash.Write([]byte(password))
    hex.Encode(key[:], hash.Sum(nil))  // 28 字节 -> 56 个十六进制字符
    return key
}
```

密钥是密码的十六进制编码 SHA-224 哈希，产生 56 字节的 ASCII 字符串。

### TCP 请求

```
[56 字节：十六进制密钥]
[2 字节：CRLF (\r\n)]
[1 字节：命令]
  0x01 = TCP (CommandTCP)
  0x03 = UDP (CommandUDP)
  0x7F = MUX (CommandMux)
[可变：SOCKS5 地址（目的地）]
[2 字节：CRLF (\r\n)]
[载荷...]
```

```
示例（TCP 到 example.com:443）：
  6162636465666768...  （56 字节十六进制密钥）
  0D 0A              （CRLF）
  01                  （TCP 命令）
  03 0B 65 78 61 6D 70 6C 65 2E 63 6F 6D 01 BB  （SOCKS5：域名 "example.com" 端口 443）
  0D 0A              （CRLF）
  [TCP 载荷紧随其后]
```

服务端以原始数据响应 -- 没有响应头。

### UDP 包帧

初始握手（使用 `CommandUDP`）后，每个 UDP 包的帧格式为：

```
[可变：SOCKS5 地址（包目的地）]
[2 字节：载荷长度 大端序]
[2 字节：CRLF (\r\n)]
[载荷字节]
```

对于初始握手包，目的地出现两次 -- 一次在握手头中，一次在包帧中：

```
[56 字节：密钥] [CRLF]
[0x03：UDP 命令]
[SOCKS5 地址：初始目的地]  <-- 握手目的地
[CRLF]
[SOCKS5 地址：包目的地]   <-- 第一个包目的地（通常相同）
[2 字节：载荷长度]
[CRLF]
[载荷]
```

同一连接内后续的包仅使用逐包帧（无密钥/命令前缀）。

## Shadowsocks 线格式

sing-box 使用 `sing-shadowsocks2` 库。

### AEAD 密码（aes-128-gcm、aes-256-gcm、chacha20-ietf-poly1305）

#### 密钥派生

```
Key = HKDF-SHA1(password=password, salt=nil, info="ss-subkey")
  或
Key = EVP_BytesToKey(password, key_size)  // 旧版
```

#### TCP 流

```
[salt：key_size 字节随机数]
[加密的 SOCKS5 地址 + 初始载荷]
[加密分块...]
```

每个加密分块：
```
[2 字节加密长度 + 16 字节 AEAD 标签]
[载荷 + 16 字节 AEAD 标签]
```

长度为大端序 uint16，最大值 0x3FFF（16383 字节）。

加密使用 AEAD，通过 HKDF 派生的逐会话子密钥：
```
Subkey = HKDF-SHA1(key=PSK, salt=salt, info="ss-subkey")
```

Nonce 从 0 开始，每次 AEAD 操作递增 1（长度和载荷使用单独的 nonce 递增）。

#### UDP 包

```
[salt：key_size 字节]
[加密：SOCKS5 地址 + 载荷 + AEAD 标签]
```

每个 UDP 包使用新鲜的随机 salt，因此使用新鲜的子密钥。

### AEAD 2022 密码（Shadowsocks 2022）

2022 密码使用不同的帧格式，带有重放保护和时间戳。

#### 密钥格式

Base64 编码的原始密钥字节：
- `2022-blake3-aes-128-gcm`：16 字节密钥
- `2022-blake3-aes-256-gcm`：32 字节密钥
- `2022-blake3-chacha20-poly1305`：32 字节密钥

#### TCP 头

```
请求 Salt：[key_size 字节随机数]
固定头（加密）：
  [1 字节：类型（0=客户端，1=服务端）]
  [8 字节：时间戳 大端序（Unix 纪元）]
  [2 字节：请求 salt 长度]
  [N 字节：请求 salt（用于响应关联）]
可变头（加密，单独 nonce）：
  [1 字节：SOCKS5 地址类型]
  [可变：SOCKS5 地址]
  [2 字节：初始载荷填充长度]
  [N 字节：填充]
  [初始载荷]
```

#### 多用户（EIH）

对于多用户服务器，加密身份头被前置：
```
[N * 16 字节：EIH 块]
```

每个块为 `AES-ECB(identity_subkey, salt[0:16] XOR PSK_hash[0:16])`。

## 多路复用（sing-mux）格式

sing-box 使用 `sing-mux` 库进行连接多路复用，支持三种协议。

### 协议选择

```json
{
  "multiplex": {
    "enabled": true,
    "protocol": "h2mux",  // 或 "smux"、"yamux"
    "max_connections": 4,
    "min_streams": 4,
    "max_streams": 0,
    "padding": false
  }
}
```

### sing-mux 握手

在底层 mux 协议之前，sing-mux 添加版本和协议协商：

```
[1 字节：版本]
[1 字节：协议]
  0x00 = smux
  0x01 = yamux
  0x02 = h2mux
[如果启用则添加填充]
```

### 流请求头

mux 内每个新流以此开始：

```
[1 字节：网络]
  0x00 = TCP
  0x01 = UDP
[SOCKS5 地址：目的地]
```

对于 UDP 流，每个包额外使用长度前缀帧封装。

### 填充

当 `padding: true` 启用时，握手和每个流中添加随机长度的填充以抵抗流量分析：

```
[2 字节：填充长度 大端序]
[N 字节：随机填充]
```

### Brutal 模式

Brutal 是一种自定义拥塞控制模式，强制使用固定发送速率：

```json
{
  "brutal": {
    "enabled": true,
    "up_mbps": 100,
    "down_mbps": 100
  }
}
```

这覆盖 TCP 拥塞控制为固定带宽，适用于丢包率高、正常 TCP 退避过于激进的网络。

## UDP-over-TCP（UoT）

当服务器不支持原生 UDP 中继时，Shadowsocks 使用：

```json
{
  "udp_over_tcp": true
}
```

### UoT v2 帧格式

每个 UDP 包在 TCP 流上的帧格式为：

```
[2 字节：总帧长度 大端序（包含地址）]
[SOCKS5 地址：包目的地]
[载荷]
```

UoT 版本通过 `sing/common/uot` 包协商。版本 2（当前默认）使用上述格式。

## SOCKS5 地址序列化

此格式在所有协议中用于编码目的地地址。它遵循 SOCKS5 地址格式：

```
IPv4:   [0x01] [4 字节：地址]  [2 字节：端口 大端序]
域名:   [0x03] [1 字节：长度] [N 字节：域名] [2 字节：端口 大端序]
IPv6:   [0x04] [16 字节：地址] [2 字节：端口 大端序]
```

sing-box 使用 `sing` 库中的 `M.SocksaddrSerializer` 实现此格式。

## 互操作性说明

### 与 Xray-core

- **VMess**：完全兼容。使用 `security: "auto"` 或显式密码。设置 `alterId: 0` 启用 AEAD 模式（现代 Xray 必需）
- **VLESS**：完全兼容。XUDP 包编码是默认设置，与 Xray 的行为匹配
- **Trojan**：完全兼容。密码哈希（SHA-224 十六进制）相同
- **Shadowsocks**：AEAD 和 2022 密码完全兼容

### 与 Clash.Meta

- **VMess**：兼容。Clash.Meta 使用相同的 `sing-vmess` 库
- **Trojan**：兼容
- **Shadowsocks**：兼容

### 常见陷阱

1. **VMess 时间戳**：认证使用当前 Unix 秒数时间戳。时钟偏差超过 120 秒会导致认证失败。请使用 NTP
2. **VLESS UUID**：必须恰好为 16 字节二进制形式。从标准 UUID 字符串格式（`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）解析
3. **Trojan 密钥**：使用 SHA-224（不是 SHA-256）。输出经十六进制编码产生恰好 56 个 ASCII 字节
4. **Shadowsocks nonce**：从 0 开始顺序递增。nonce 通常为 12 字节（96 位），计数器在前几个字节中（大多数实现为小端序）
5. **Shadowsocks 2022 时间戳**：必须在服务器时间的 30 秒以内。请使用 NTP
6. **SOCKS5 地址类型字节**：必须为 `0x01`（IPv4）、`0x03`（域名）或 `0x04`（IPv6）。类型 `0x00` 无效
7. **端口编码**：所有协议中始终为大端序 uint16
8. **TLS 要求**：VLESS 和 Trojan 在生产环境中应始终与 TLS 一起使用。没有 TLS 时，密钥/UUID 以明文发送
