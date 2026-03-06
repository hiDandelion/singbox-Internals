# Wire Format Compatibility

This document describes the byte-level wire formats for the proxy protocols supported by sing-box, intended for reimplementers who need to interoperate with existing sing-box (and Xray-core) instances.

## VLESS Wire Format

VLESS is implemented in the `sing-vmess/vless` library. sing-box delegates all wire format handling to this library.

### Request Header

```
+----------+---------+---------+----------+---------+-------------------+
| Version  | UUID    | Addons  | Command  | Dest    | Payload           |
| 1 byte   | 16 bytes| varint+ | 1 byte   | variable| ...               |
+----------+---------+---------+----------+---------+-------------------+
```

| Field | Size | Description |
|-------|------|-------------|
| Version | 1 byte | Protocol version, always `0` |
| UUID | 16 bytes | User UUID in binary form |
| Addons Length | 1 byte | Length of protobuf-encoded addons (0 if none) |
| Addons | variable | Protobuf addons (contains Flow field for XTLS) |
| Command | 1 byte | `0x01` = TCP, `0x02` = UDP, `0x03` = MUX |
| Destination | variable | SOCKS5 address format (see below) |

### Response Header

```
+----------+---------+
| Version  | Addons  |
| 1 byte   | varint+ |
+----------+---------+
```

| Field | Size | Description |
|-------|------|-------------|
| Version | 1 byte | Always `0` |
| Addons Length | 1 byte | Length of protobuf addons (typically `0`) |

After the response header, data flows bidirectionally as raw TCP stream.

### SOCKS5 Address Format

Used in the destination field:

```
Type 0x01 (IPv4):  [1 byte type] [4 bytes addr] [2 bytes port big-endian]
Type 0x03 (FQDN):  [1 byte type] [1 byte len] [N bytes domain] [2 bytes port big-endian]
Type 0x04 (IPv6):  [1 byte type] [16 bytes addr] [2 bytes port big-endian]
```

### Packet Encoding

VLESS supports three UDP packet encoding modes:

#### 1. Plain (no encoding)

Each UDP packet is sent as a separate VLESS connection with command `0x02`. Inefficient but simple.

#### 2. PacketAddr

Uses the magic FQDN `sp.packet-addr.v2fly.arpa` as the VLESS destination. Each UDP packet within the connection is framed as:

```
[SOCKS5 addr] [2 bytes payload length big-endian] [payload]
```

#### 3. XUDP (default)

Uses VMess-style XUDP encoding within a VLESS connection with command `0x03` (MUX). Each packet is framed with session management similar to VMess XUDP.

### Flow: xtls-rprx-vision

When `flow: "xtls-rprx-vision"` is configured, VLESS uses direct TLS forwarding. The client:
1. Reads TLS records from the inner connection
2. Pads short records to hide record length patterns
3. Transitions to raw copy after the TLS handshake completes

This requires TLS-level awareness in the proxy layer.

## VMess Wire Format

VMess is implemented in the `sing-vmess` library.

### Key Derivation

```
Request Key:  MD5(UUID bytes)
Request IV:   MD5(timestamp + UUID bytes)
```

The timestamp is the current Unix time in seconds, encoded as big-endian int64, with a 30-second tolerance window for authentication.

### Request Header (AlterId = 0, AEAD)

The modern AEAD format (no alterId / alterId = 0):

```
Authentication:
  [16 bytes: HMAC-MD5 of timestamp using UUID as key]

Encrypted Header (AES-128-GCM):
  [1 byte: version (1)]
  [16 bytes: request body IV]
  [16 bytes: request body key]
  [1 byte: response authentication V]
  [1 byte: option flags]
    bit 0: chunk stream (always set)
    bit 1: connection reuse (deprecated)
    bit 2: chunk masking (global_padding)
    bit 3: authenticated length
    bit 4: padding
  [1 byte: padding length P (upper 4 bits) + security (lower 4 bits)]
  [1 byte: reserved (0)]
  [1 byte: command (0x01=TCP, 0x02=UDP)]
  [2 bytes: port big-endian]
  [address: type + addr]
  [P bytes: random padding]
  [4 bytes: FNV1a hash of header]
```

Security values (lower 4 bits):
- `0x00`: Legacy (AES-128-CFB)
- `0x03`: AES-128-GCM
- `0x04`: ChaCha20-Poly1305
- `0x05`: None (plaintext)
- `0x06`: Zero (no encryption, authenticated length mode)

### Response Header

```
[1 byte: response auth V (must match request)]
[1 byte: option flags]
[1 byte: command (0)]
[1 byte: command length (0)]
```

### Data Framing (Chunk Stream)

Each data chunk:

```
Without authenticated length:
  [2 bytes: length big-endian] [encrypted payload]

With authenticated length:
  [2 bytes: encrypted length] [encrypted payload]
  (length itself is encrypted with separate AEAD)
```

Chunk masking XORs the length with a hash derived from the IV, making length analysis harder.

### Packet Encoding (XUDP)

VMess supports XUDP for UDP-over-TCP. XUDP uses session-based multiplexing where each UDP "connection" gets a session ID:

```
[2 bytes: session ID]
[1 byte: status (new/keep/end)]
[1 byte: padding length]
[address: destination]
[2 bytes: payload length]
[payload]
[padding]
```

## Trojan Wire Format

Trojan is a simple password-authenticated protocol. sing-box's implementation is in `transport/trojan/`.

### Key Derivation

```go
func Key(password string) [56]byte {
    hash := sha256.New224()  // SHA-224, produces 28 bytes
    hash.Write([]byte(password))
    hex.Encode(key[:], hash.Sum(nil))  // 28 bytes -> 56 hex chars
    return key
}
```

The key is the hex-encoded SHA-224 hash of the password, resulting in a 56-byte ASCII string.

### TCP Request

```
[56 bytes: hex key]
[2 bytes: CRLF (\r\n)]
[1 byte: command]
  0x01 = TCP (CommandTCP)
  0x03 = UDP (CommandUDP)
  0x7F = MUX (CommandMux)
[variable: SOCKS5 address (destination)]
[2 bytes: CRLF (\r\n)]
[payload...]
```

```
Example (TCP to example.com:443):
  6162636465666768...  (56 bytes hex key)
  0D 0A              (CRLF)
  01                  (TCP command)
  03 0B 65 78 61 6D 70 6C 65 2E 63 6F 6D 01 BB  (SOCKS5: domain "example.com" port 443)
  0D 0A              (CRLF)
  [TCP payload follows immediately]
```

The server responds with raw data -- there is no response header.

### UDP Packet Framing

After the initial handshake (with `CommandUDP`), each UDP packet is framed as:

```
[variable: SOCKS5 address (packet destination)]
[2 bytes: payload length big-endian]
[2 bytes: CRLF (\r\n)]
[payload bytes]
```

For the initial handshake packet, the destination appears twice -- once in the handshake header and once in the packet framing:

```
[56 bytes: key] [CRLF]
[0x03: UDP command]
[SOCKS5 addr: initial destination]  <-- handshake destination
[CRLF]
[SOCKS5 addr: packet destination]   <-- first packet destination (usually same)
[2 bytes: payload length]
[CRLF]
[payload]
```

Subsequent packets within the same connection use only the per-packet framing (no key/command prefix).

## Shadowsocks Wire Format

sing-box uses the `sing-shadowsocks2` library.

### AEAD Ciphers (aes-128-gcm, aes-256-gcm, chacha20-ietf-poly1305)

#### Key Derivation

```
Key = HKDF-SHA1(password=password, salt=nil, info="ss-subkey")
  or
Key = EVP_BytesToKey(password, key_size)  // legacy
```

#### TCP Stream

```
[salt: key_size bytes random]
[encrypted SOCKS5 address + initial payload]
[encrypted chunks...]
```

Each encrypted chunk:
```
[2 bytes encrypted length + 16 bytes AEAD tag]
[payload + 16 bytes AEAD tag]
```

Length is big-endian uint16 with maximum value 0x3FFF (16383 bytes).

Encryption uses AEAD with a per-session subkey derived via HKDF:
```
Subkey = HKDF-SHA1(key=PSK, salt=salt, info="ss-subkey")
```

Nonce starts at 0 and increments by 1 for each AEAD operation (both length and payload use separate nonce increments).

#### UDP Packet

```
[salt: key_size bytes]
[encrypted: SOCKS5 address + payload + AEAD tag]
```

Each UDP packet uses a fresh random salt and thus a fresh subkey.

### AEAD 2022 Ciphers (Shadowsocks 2022)

The 2022 ciphers use a different framing with replay protection and timestamps.

#### Key Format

Base64-encoded raw key bytes:
- `2022-blake3-aes-128-gcm`: 16-byte key
- `2022-blake3-aes-256-gcm`: 32-byte key
- `2022-blake3-chacha20-poly1305`: 32-byte key

#### TCP Header

```
Request Salt: [key_size bytes random]
Fixed Header (encrypted):
  [1 byte: type (0=client, 1=server)]
  [8 bytes: timestamp big-endian (Unix epoch)]
  [2 bytes: request salt length]
  [N bytes: request salt (for response correlation)]
Variable Header (encrypted, separate nonce):
  [1 byte: SOCKS5 addr type]
  [variable: SOCKS5 addr]
  [2 bytes: initial payload padding length]
  [N bytes: padding]
  [initial payload]
```

#### Multi-User (EIH)

For multi-user servers, Encrypted Identity Headers are prepended:
```
[N * 16 bytes: EIH blocks]
```

Each block is `AES-ECB(identity_subkey, salt[0:16] XOR PSK_hash[0:16])`.

## Multiplex (sing-mux) Format

sing-box uses the `sing-mux` library for connection multiplexing, supporting three protocols.

### Protocol Selection

```json
{
  "multiplex": {
    "enabled": true,
    "protocol": "h2mux",  // or "smux", "yamux"
    "max_connections": 4,
    "min_streams": 4,
    "max_streams": 0,
    "padding": false
  }
}
```

### sing-mux Handshake

Before the underlying mux protocol, sing-mux adds a version and protocol negotiation:

```
[1 byte: version]
[1 byte: protocol]
  0x00 = smux
  0x01 = yamux
  0x02 = h2mux
[padding if enabled]
```

### Stream Request Header

Each new stream within the mux starts with:

```
[1 byte: network]
  0x00 = TCP
  0x01 = UDP
[SOCKS5 address: destination]
```

For UDP streams, each packet is additionally framed with length prefixing.

### Padding

When `padding: true` is enabled, random-length padding is added to the handshake and each stream to resist traffic analysis:

```
[2 bytes: padding length big-endian]
[N bytes: random padding]
```

### Brutal Mode

Brutal is a custom congestion control mode that forces a fixed send rate:

```json
{
  "brutal": {
    "enabled": true,
    "up_mbps": 100,
    "down_mbps": 100
  }
}
```

This overrides TCP congestion control with a fixed bandwidth, useful for networks with packet loss where normal TCP backs off too aggressively.

## UDP-over-TCP (UoT)

Used by Shadowsocks when the server does not support native UDP relay:

```json
{
  "udp_over_tcp": true
}
```

### UoT v2 Frame Format

Each UDP packet is framed over the TCP stream as:

```
[2 bytes: total frame length big-endian (includes address)]
[SOCKS5 address: packet destination]
[payload]
```

The UoT version is negotiated via the `sing/common/uot` package. Version 2 (current default) uses the above format.

## SOCKS5 Address Serialization

This format is used throughout all protocols for encoding destination addresses. It follows the SOCKS5 address format:

```
IPv4:   [0x01] [4 bytes: address]  [2 bytes: port big-endian]
Domain: [0x03] [1 byte: length] [N bytes: domain] [2 bytes: port big-endian]
IPv6:   [0x04] [16 bytes: address] [2 bytes: port big-endian]
```

sing-box uses `M.SocksaddrSerializer` from the `sing` library which implements this exact format.

## Interoperability Notes

### With Xray-core

- **VMess**: Full compatibility. Use `security: "auto"` or explicit cipher. Set `alterId: 0` for AEAD mode (required for modern Xray)
- **VLESS**: Full compatibility. XUDP packet encoding is the default and matches Xray's behavior
- **Trojan**: Full compatibility. Password hashing (SHA-224 hex) is identical
- **Shadowsocks**: Full compatibility for AEAD and 2022 ciphers

### With Clash.Meta

- **VMess**: Compatible. Clash.Meta uses the same `sing-vmess` library
- **Trojan**: Compatible
- **Shadowsocks**: Compatible

### Common Pitfalls

1. **VMess timestamp**: The authentication uses the current Unix timestamp in seconds. Clock skew of more than 120 seconds will cause authentication failures. Use NTP
2. **VLESS UUID**: Must be exactly 16 bytes in binary form. Parse from standard UUID string format (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
3. **Trojan key**: SHA-224 (not SHA-256) is used. The output is hex-encoded to produce exactly 56 ASCII bytes
4. **Shadowsocks nonce**: Starts at 0 and increments sequentially. The nonce is typically 12 bytes (96 bits) with the counter in the first bytes (little-endian for most implementations)
5. **Shadowsocks 2022 timestamps**: Must be within 30 seconds of server time. Use NTP
6. **SOCKS5 address type byte**: Must be `0x01` (IPv4), `0x03` (domain), or `0x04` (IPv6). Type `0x00` is invalid
7. **Port encoding**: Always big-endian uint16 in all protocols
8. **TLS requirement**: VLESS and Trojan should always be used with TLS in production. Without TLS, the key/UUID is sent in plaintext
