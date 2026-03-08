# Clash API

Clash API предоставляет RESTful HTTP-интерфейс, совместимый с пользовательскими интерфейсами панелей управления Clash (напр., Yacd, Metacubexd). Он обеспечивает управление прокси, отслеживание соединений, статистику трафика, настройку конфигурации, потоковую передачу логов и операции с DNS-кэшем.

**Исходный код**: `experimental/clashapi/`

## Регистрация

Сервер Clash API регистрируется через функцию `init()`, защищённую тегом сборки `with_clash_api`:

```go
// clashapi.go (тег сборки with_clash_api)
func init() {
    experimental.RegisterClashServerConstructor(NewServer)
}

// clashapi_stub.go (тег сборки !with_clash_api)
func init() {
    experimental.RegisterClashServerConstructor(func(...) (adapter.ClashServer, error) {
        return nil, E.New(`clash api is not included in this build, rebuild with -tags with_clash_api`)
    })
}
```

## Архитектура сервера

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

### HTTP-маршрутизатор (chi)

Сервер использует `go-chi/chi` для маршрутизации с CORS-мидлваром:

```
GET  /              -> hello (или перенаправление на /ui/)
GET  /logs          -> потоковая передача логов через WebSocket/SSE
GET  /traffic       -> статистика трафика через WebSocket/SSE
GET  /version       -> {"version": "sing-box X.Y.Z", "premium": true, "meta": true}
     /configs       -> GET, PUT, PATCH конфигурации
     /proxies       -> GET список, GET/PUT отдельный прокси, GET тест задержки
     /rules         -> GET правила маршрутизации
     /connections   -> GET список, DELETE закрыть все, DELETE закрыть по ID
     /providers/proxies -> провайдеры прокси (заглушка)
     /providers/rules   -> провайдеры правил (заглушка)
     /script        -> скрипт (заглушка)
     /profile       -> профиль (заглушка)
     /cache         -> операции с кэшем
     /dns           -> DNS-операции
     /ui/*          -> статический файловый сервер для внешнего UI
```

### Аутентификация

Аутентификация по Bearer-токену через опцию конфигурации `secret`:

```go
func authentication(serverSecret string) func(next http.Handler) http.Handler {
    // Проверяет заголовок "Authorization: Bearer <token>"
    // WebSocket-соединения могут использовать параметр запроса ?token=<token>
    // Если serverSecret пуст, все запросы разрешены
}
```

## Отслеживание соединений

### Менеджер трафика

```go
type Manager struct {
    uploadTotal   atomic.Int64
    downloadTotal atomic.Int64
    connections   compatible.Map[uuid.UUID, Tracker]

    closedConnectionsAccess sync.Mutex
    closedConnections       list.List[TrackerMetadata]  // ограничен 1000
    memory                  uint64

    eventSubscriber *observable.Subscriber[ConnectionEvent]
}
```

Менеджер отслеживает:
- **Глобальные итоги загрузки/скачивания** через атомарные счётчики
- **Активные соединения** в конкурентном словаре с ключом UUID
- **Недавно закрытые соединения** в ограниченном списке (максимум 1000 записей)
- **Использование памяти** через `runtime.ReadMemStats`

### Обёртка трекера

Когда соединение маршрутизируется, сервер Clash оборачивает его слоем отслеживания:

```go
func (s *Server) RoutedConnection(ctx, conn, metadata, matchedRule, matchOutbound) net.Conn {
    return trafficontrol.NewTCPTracker(conn, s.trafficManager, metadata, ...)
}
```

Трекер:
1. Генерирует UUID v4 для соединения
2. Разрешает цепочку исходящих (следует за выбором группы для нахождения финального исходящего)
3. Оборачивает соединение с помощью `bufio.NewCounterConn` для подсчёта байт в обоих направлениях
4. Регистрируется в менеджере через `manager.Join(tracker)`
5. При закрытии вызывает `manager.Leave(tracker)` и сохраняет метаданные в списке закрытых соединений

### JSON TrackerMetadata

Метаданные соединения сериализуются для API:

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
        "chains":   t.Chain,     // обратная цепочка исходящих
        "rule":     rule,
        "rulePayload": "",
    })
}
```

## Потоковая передача трафика

Эндпоинт `/traffic` передаёт дельту трафика в секунду через WebSocket или чанкированный HTTP:

```go
func traffic(ctx, trafficManager) http.HandlerFunc {
    // Каждую 1 секунду:
    // 1. Чтение текущих итогов загрузки/скачивания
    // 2. Вычисление дельты от предыдущего показания
    // 3. Отправка JSON: {"up": delta_up, "down": delta_down}
}
```

## Потоковая передача логов

Эндпоинт `/logs` передаёт записи логов с фильтрацией по уровню:

```go
func getLogs(logFactory) http.HandlerFunc {
    // Принимает ?level=info|debug|warn|error
    // Подписывается на наблюдаемую фабрику логов
    // Передаёт JSON: {"type": "info", "payload": "log message"}
    // Поддерживает как WebSocket, так и чанкированный HTTP
}
```

## Переключение режимов

sing-box реализует переключение режимов в стиле Clash (Rule, Global, Direct и т.д.):

```go
func (s *Server) SetMode(newMode string) {
    // 1. Проверка, что режим есть в modeList (без учёта регистра)
    // 2. Обновление s.mode
    // 3. Отправка хука обновления режима (уведомление подписчиков)
    // 4. Очистка DNS-кэша
    // 5. Сохранение в файл кэша
    // 6. Логирование изменения
}
```

Режимы сохраняются в файле кэша bbolt в бакете `clash_mode`, с ключом по cache ID.

## Управление прокси

### GET /proxies

Возвращает все исходящие и эндпоинты с их метаданными:

```go
func proxyInfo(server, detour) *badjson.JSONObject {
    // type:    отображаемое имя Clash (напр., "Shadowsocks", "VMess")
    // name:    тег исходящего
    // udp:     поддерживается ли UDP
    // history: история задержки URL-теста
    // now:     текущий выбор (для групп)
    // all:     доступные члены (для групп)
}
```

Всегда добавляется синтетическая группа прокси `GLOBAL`, содержащая все несистемные исходящие, с исходящим по умолчанию в начале списка.

### PUT /proxies/{name}

Обновляет выбранный исходящий для групп `Selector`:

```go
func updateProxy(w, r) {
    selector, ok := proxy.(*group.Selector)
    selector.SelectOutbound(req.Name)
}
```

### GET /proxies/{name}/delay

Выполняет URL-тест с настраиваемым таймаутом:

```go
func getProxyDelay(server) http.HandlerFunc {
    // Читает параметры запроса ?url=...&timeout=...
    // Вызывает urltest.URLTest(ctx, url, proxy)
    // Возвращает {"delay": ms} или ошибку
    // Сохраняет результат в историю URL-тестов
}
```

## Интерфейс провайдеров

Провайдеры прокси (`/providers/proxies`) и провайдеры правил (`/providers/rules`) являются заглушками — они возвращают пустые результаты или 404. Это поддерживает совместимость API с панелями управления Clash, которые ожидают существования этих эндпоинтов.

## API снимков

Эндпоинт `/connections` возвращает снимок всех активных соединений:

```go
type Snapshot struct {
    Download    int64
    Upload      int64
    Connections []Tracker
    Memory      uint64    // из runtime.MemStats
}
```

Эндпоинт снимков также поддерживает WebSocket для обновлений в реальном времени с настраиваемым интервалом опроса (`?interval=1000` в миллисекундах).

## Конфигурация

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

## Жизненный цикл запуска

Сервер запускается в два этапа:

1. **`StartStateStart`**: Загрузка сохранённого режима из файла кэша
2. **`StartStateStarted`**: Загрузка внешнего UI при необходимости, запуск HTTP-слушателя (с логикой повторных попыток для Android `EADDRINUSE`)

## Замечания по реализации

1. API разработан для совместимости с панелями управления Clash (Yacd, Metacubexd). Формат ответов должен точно соответствовать ожиданиям этих панелей
2. Поддержка WebSocket критически важна — трафик, логи и соединения используют WebSocket для потоковой передачи в реальном времени
3. Флаги `"premium": true, "meta": true` в ответе версии активируют дополнительные функции в панелях управления
4. Отслеживание соединений оборачивает каждое маршрутизированное соединение/пакетное соединение, добавляя счётчики байт для каждого соединения
5. Список закрытых соединений ограничен 1000 записями (вытеснение FIFO)
6. Статистика памяти берётся из `runtime.ReadMemStats`, которая включает стек, используемую кучу и простаивающую кучу
7. DNS-операции и очистка кэша доступны через маршруты `/dns` и `/cache`
