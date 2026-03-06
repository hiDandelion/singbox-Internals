# Clash API

The Clash API provides a RESTful HTTP interface compatible with Clash dashboard UIs (e.g., Yacd, Metacubexd). It exposes proxy management, connection tracking, traffic statistics, configuration, log streaming, and DNS cache operations.

**Source**: `experimental/clashapi/`

## Registration

The Clash API server registers itself via an `init()` function, guarded by the `with_clash_api` build tag:

```go
// clashapi.go (with_clash_api build tag)
func init() {
    experimental.RegisterClashServerConstructor(NewServer)
}

// clashapi_stub.go (!with_clash_api build tag)
func init() {
    experimental.RegisterClashServerConstructor(func(...) (adapter.ClashServer, error) {
        return nil, E.New(`clash api is not included in this build, rebuild with -tags with_clash_api`)
    })
}
```

## Server Architecture

```go
type Server struct {
    ctx            context.Context
    router         adapter.Router
    dnsRouter      adapter.DNSRouter
    outbound       adapter.OutboundManager
    endpoint       adapter.EndpointManager
    logger         log.Logger
    httpServer     *http.Server
    trafficManager *trafficontrol.Manager
    urlTestHistory adapter.URLTestHistoryStorage

    mode           string
    modeList       []string
    modeUpdateHook *observable.Subscriber[struct{}]

    externalController       bool
    externalUI               string
    externalUIDownloadURL    string
    externalUIDownloadDetour string
}
```

### HTTP Router (chi)

The server uses `go-chi/chi` for routing with CORS middleware:

```
GET  /              -> hello (or redirect to /ui/)
GET  /logs          -> WebSocket/SSE log streaming
GET  /traffic       -> WebSocket/SSE traffic statistics
GET  /version       -> {"version": "sing-box X.Y.Z", "premium": true, "meta": true}
     /configs       -> GET, PUT, PATCH configuration
     /proxies       -> GET list, GET/PUT individual proxy, GET delay test
     /rules         -> GET routing rules
     /connections   -> GET list, DELETE close all, DELETE close by ID
     /providers/proxies -> proxy providers (stub)
     /providers/rules   -> rule providers (stub)
     /script        -> script (stub)
     /profile       -> profile (stub)
     /cache         -> cache operations
     /dns           -> DNS operations
     /ui/*          -> static file server for external UI
```

### Authentication

Bearer token authentication via the `secret` configuration option:

```go
func authentication(serverSecret string) func(next http.Handler) http.Handler {
    // Checks "Authorization: Bearer <token>" header
    // WebSocket connections can use ?token=<token> query parameter
    // If serverSecret is empty, all requests are allowed
}
```

## Connection Tracking

### Traffic Manager

```go
type Manager struct {
    uploadTotal   atomic.Int64
    downloadTotal atomic.Int64
    connections   compatible.Map[uuid.UUID, Tracker]

    closedConnectionsAccess sync.Mutex
    closedConnections       list.List[TrackerMetadata]  // capped at 1000
    memory                  uint64

    eventSubscriber *observable.Subscriber[ConnectionEvent]
}
```

The manager tracks:
- **Global upload/download totals** via atomic counters
- **Active connections** in a concurrent map keyed by UUID
- **Recently closed connections** in a capped list (max 1000 entries)
- **Memory usage** via `runtime.ReadMemStats`

### Tracker Wrapping

When a connection is routed, the Clash server wraps it with a tracking layer:

```go
func (s *Server) RoutedConnection(ctx, conn, metadata, matchedRule, matchOutbound) net.Conn {
    return trafficontrol.NewTCPTracker(conn, s.trafficManager, metadata, ...)
}
```

The tracker:
1. Generates a UUID v4 for the connection
2. Resolves the outbound chain (follows group selections to find the final outbound)
3. Wraps the connection with `bufio.NewCounterConn` to count bytes in both directions
4. Registers with the manager via `manager.Join(tracker)`
5. On close, calls `manager.Leave(tracker)` and stores metadata in the closed connections list

### TrackerMetadata JSON

Connection metadata is serialized for the API:

```go
func (t TrackerMetadata) MarshalJSON() ([]byte, error) {
    return json.Marshal(map[string]any{
        "id": t.ID,
        "metadata": map[string]any{
            "network":         t.Metadata.Network,
            "type":            inbound,        // "inboundType/inboundTag"
            "sourceIP":        source.Addr,
            "destinationIP":   dest.Addr,
            "sourcePort":      source.Port,
            "destinationPort": dest.Port,
            "host":            domain,
            "dnsMode":         "normal",
            "processPath":     processPath,
        },
        "upload":   t.Upload.Load(),
        "download": t.Download.Load(),
        "start":    t.CreatedAt,
        "chains":   t.Chain,     // reversed outbound chain
        "rule":     rule,
        "rulePayload": "",
    })
}
```

## Traffic Streaming

The `/traffic` endpoint streams per-second traffic deltas via WebSocket or chunked HTTP:

```go
func traffic(ctx, trafficManager) http.HandlerFunc {
    // Every 1 second:
    // 1. Read current total upload/download
    // 2. Compute delta from previous reading
    // 3. Send JSON: {"up": delta_up, "down": delta_down}
}
```

## Log Streaming

The `/logs` endpoint streams log entries with level filtering:

```go
func getLogs(logFactory) http.HandlerFunc {
    // Accepts ?level=info|debug|warn|error
    // Subscribes to the observable log factory
    // Streams JSON: {"type": "info", "payload": "log message"}
    // Supports both WebSocket and chunked HTTP
}
```

## Mode Switching

sing-box implements Clash-style mode switching (Rule, Global, Direct, etc.):

```go
func (s *Server) SetMode(newMode string) {
    // 1. Validate mode is in modeList (case-insensitive)
    // 2. Update s.mode
    // 3. Emit mode update hook (notifies subscribers)
    // 4. Clear DNS cache
    // 5. Persist to cache file
    // 6. Log the change
}
```

Modes are persisted in the bbolt cache file under the `clash_mode` bucket, keyed by cache ID.

## Proxy Management

### GET /proxies

Returns all outbounds and endpoints with their metadata:

```go
func proxyInfo(server, detour) *badjson.JSONObject {
    // type:    Clash display name (e.g., "Shadowsocks", "VMess")
    // name:    outbound tag
    // udp:     whether UDP is supported
    // history: URL test delay history
    // now:     current selection (for groups)
    // all:     available members (for groups)
}
```

A synthetic `GLOBAL` proxy group is always added, containing all non-system outbounds with the default outbound listed first.

### PUT /proxies/{name}

Updates the selected outbound for `Selector` groups:

```go
func updateProxy(w, r) {
    selector, ok := proxy.(*group.Selector)
    selector.SelectOutbound(req.Name)
}
```

### GET /proxies/{name}/delay

Performs a URL test with configurable timeout:

```go
func getProxyDelay(server) http.HandlerFunc {
    // Reads ?url=...&timeout=... query parameters
    // Calls urltest.URLTest(ctx, url, proxy)
    // Returns {"delay": ms} or error
    // Stores result in URL test history
}
```

## Provider Interface

Proxy providers (`/providers/proxies`) and rule providers (`/providers/rules`) are stubbed out -- they return empty results or 404. This maintains API compatibility with Clash dashboards that expect these endpoints to exist.

## Snapshot API

The `/connections` endpoint returns a snapshot of all active connections:

```go
type Snapshot struct {
    Download    int64
    Upload      int64
    Connections []Tracker
    Memory      uint64    // from runtime.MemStats
}
```

The snapshot endpoint also supports WebSocket for real-time updates with a configurable polling interval (`?interval=1000` in milliseconds).

## Configuration

```json
{
  "experimental": {
    "clash_api": {
      "external_controller": "127.0.0.1:9090",
      "external_ui": "ui",
      "external_ui_download_url": "",
      "external_ui_download_detour": "",
      "secret": "my-secret",
      "default_mode": "Rule",
      "access_control_allow_origin": ["*"],
      "access_control_allow_private_network": false
    }
  }
}
```

## Start Lifecycle

The server starts in two phases:

1. **`StartStateStart`**: Loads persisted mode from cache file
2. **`StartStateStarted`**: Downloads external UI if needed, starts the HTTP listener (with retry logic for Android `EADDRINUSE`)

## Reimplementation Notes

1. The API is designed for compatibility with Clash dashboards (Yacd, Metacubexd). The response format must exactly match what these dashboards expect
2. WebSocket support is critical -- traffic, logs, and connections all use WebSocket for real-time streaming
3. The `"premium": true, "meta": true` version response flags enable additional features in dashboards
4. Connection tracking wraps every routed connection/packet connection, adding per-connection byte counters
5. The closed connections list is bounded to 1000 entries (FIFO eviction)
6. Memory statistics come from `runtime.ReadMemStats` which includes stack, heap in use, and idle heap
7. DNS operations and cache clearing are exposed through the `/dns` and `/cache` routes
