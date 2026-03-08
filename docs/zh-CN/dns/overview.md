# DNS 子系统概述

源码：`dns/`、`dns/transport/`、`dns/transport/fakeip/`、`dns/transport/hosts/`、`dns/transport/local/`、`dns/transport/dhcp/`

## 架构

sing-box 的 DNS 子系统由三个核心组件构成：

```
                     +------------------+
                     |   DNS Router     |   规则匹配、传输层选择
                     +------------------+
                            |
                     +------------------+
                     |   DNS Client     |   缓存、EDNS0、RDRC、TTL 管理
                     +------------------+
                            |
              +-------------+-------------+
              |             |             |
        +---------+   +---------+   +---------+
        | UDP     |   | HTTPS   |   | FakeIP  |   ... 更多传输层
        +---------+   +---------+   +---------+
```

1. **DNS Router**（`dns/router.go`）：将 DNS 查询与规则进行匹配，选择合适的传输层，处理域名策略和反向映射
2. **DNS Client**（`dns/client.go`）：执行实际的 DNS 交换，包含缓存（freelru）、EDNS0 客户端子网注入、响应域名拒绝缓存（RDRC）以及 TTL 调整
3. **DNS Transports**（`dns/transport/`）：特定协议的查询执行（UDP、TCP、TLS、HTTPS、QUIC/HTTP3、FakeIP、Hosts、Local、DHCP）

### 辅助组件

- **Transport Registry**（`dns/transport_registry.go`）：基于泛型的类型安全传输层注册
- **Transport Adapter**（`dns/transport_adapter.go`）：包含 type/tag/dependencies/strategy/clientSubnet 的基础结构体
- **Base Transport**（`dns/transport/base.go`）：状态机（New/Started/Closing/Closed），带有运行中查询追踪
- **Connector**（`dns/transport/connector.go`）：基于泛型的 singleflight 连接管理

## 查询流程

### Exchange（原始 DNS 消息）

1. **Router.Exchange** 接收一个 `*dns.Msg`
2. 元数据提取：查询类型、域名、IP 版本
3. 如果没有显式指定传输层，则与 DNS 规则进行匹配：
   - `RuleActionDNSRoute` -- 选择传输层及选项（策略、缓存、TTL、客户端子网）
   - `RuleActionDNSRouteOptions` -- 修改选项但不选择传输层
   - `RuleActionReject` -- 返回 REFUSED 或丢弃
   - `RuleActionPredefined` -- 返回预配置的响应
4. **Client.Exchange** 执行实际查询：
   - 检查缓存（通过基于 channel 的锁进行去重）
   - 检查 RDRC 中之前被拒绝的响应
   - 应用 EDNS0 客户端子网
   - 带超时地执行 transport.Exchange
   - 验证响应（地址限制检查）
   - 归一化 TTL
   - 存入缓存
5. 如果启用了反向映射，则存储 IP -> 域名的映射

### Lookup（域名到地址）

1. **Router.Lookup** 接收一个域名字符串
2. 确定策略（IPv4Only、IPv6Only、PreferIPv4、PreferIPv6、AsIS）
3. **Client.Lookup** 分派查询：
   - IPv4Only：单个 A 查询
   - IPv6Only：单个 AAAA 查询
   - 其他情况：通过 `task.Group` 并行发起 A + AAAA 查询
4. 根据策略偏好对结果排序

### 规则重试循环

当规则包含地址限制（例如对响应地址的 GeoIP 限制）时，如果响应被拒绝，路由器会使用后续匹配的规则进行重试：

```go
for {
    transport, rule, ruleIndex = r.matchDNS(ctx, true, ruleIndex, isAddressQuery, &dnsOptions)
    responseCheck := addressLimitResponseCheck(rule, metadata)
    response, err = r.client.Exchange(dnsCtx, transport, message, dnsOptions, responseCheck)
    if responseCheck != nil && rejected {
        continue  // 尝试下一个匹配的规则
    }
    break
}
```

## 关键设计决策

### 去重

缓存使用基于 channel 的去重机制来防止惊群效应：

```go
cond, loaded := c.cacheLock.LoadOrStore(question, make(chan struct{}))
if loaded {
    <-cond  // 等待正在进行的查询完成
} else {
    defer func() {
        c.cacheLock.Delete(question)
        close(cond)  // 通知等待者
    }()
}
```

### 循环检测

DNS 查询循环（例如传输层 A 需要通过传输层 A 解析其服务器地址）通过 context 检测：

```go
contextTransport, loaded := transportTagFromContext(ctx)
if loaded && transport.Tag() == contextTransport {
    return nil, E.New("DNS query loopback in transport[", contextTransport, "]")
}
ctx = contextWithTransportTag(ctx, transport.Tag())
```

### RDRC（响应域名拒绝缓存）

当响应被地址限制检查拒绝时，域名/查询类型/传输层的组合会被缓存到 RDRC 中，以跳过后续对同一传输层的查询：

```go
if rejected {
    c.rdrc.SaveRDRCAsync(transport.Tag(), question.Name, question.Qtype, c.logger)
}
// 后续查询时：
if c.rdrc.LoadRDRC(transport.Tag(), question.Name, question.Qtype) {
    return nil, ErrResponseRejectedCached
}
```

### EDNS0 客户端子网

在交换之前，如果已配置则应用客户端子网：

```go
clientSubnet := options.ClientSubnet
if !clientSubnet.IsValid() {
    clientSubnet = c.clientSubnet
}
if clientSubnet.IsValid() {
    message = SetClientSubnet(message, clientSubnet)
}
```
