# task-diag 取数链路

本套件的所有取数都走 dataforge-server 的 telemetry v1，不再引用旧的日志/运行态接口。

服务端地址与凭据由运行环境注入：

- `DATAFORGE_API_HOST`：例如 `http://127.0.0.1:8083`
- `DATAFORGE_AUTH_TOKEN`：登录后得到的 Bearer token

## 工具 → v1 端点

| 工具 | v1 端点 | 说明 |
|---|---|---|
| `diag_capabilities` | `POST /api/telemetry/v1/metrics/query`（`mode=catalog`）<br>`POST /api/telemetry/v1/discovery/query`（`scope=sources`）<br>`POST /api/telemetry/v1/logs/query`（64 字节配置探测） | 目录 + 运行态源 + 日志后端配置探测，产出能力表与作用域票据 |
| `diag_resolve_target` | `POST /api/telemetry/v1/discovery/query`（`scope=jobs`） | 任务名精确匹配；无匹配返回 D01 |
| `diag_upstream_context` | `POST /api/telemetry/v1/discovery/query`（`scope=sources/jobs`） | 编排器独占，全轮一次 |
| `diag_collect_logs` | `POST /api/telemetry/v1/logs/query` | `dataType` + `stream` + `target` + `ref` |
| `diag_collect_runtime` | `POST /api/telemetry/v1/runtime/snapshot` | 仅 spark / flink |
| `diag_compare` | `POST /api/telemetry/v1/runtime/compare` | 进程内快照对比，需先取 snapshot |
| 指标数据 | `POST /api/telemetry/v1/metrics/query`（`instant/range/catalog`） | counter 可带 `rate=true` |

## 数据标识

通道身份是「四元组 + 数据类型 + 流」：

```
serviceType → componentId → hostId → dataTypeId (+ stream)
```

- `dataTypeId = log.service`：服务自身运行日志，后端只允许 local-disk / elasticsearch；
- `dataTypeId = log.task`：在服务上运行的任务日志，后端只允许 yarn，要求 `jobName` 或 `jobId` 非空；
- `hostId` 默认 `cluster`；local-disk 命中多个 host 时后端返回 `HOST_REQUIRED`，需在工具参数里显式传 `hostId`；
- 幂等键：`serviceType|componentId|hostId|dataTypeId|stream|<sorted-ref>`。

跨引擎通道返回 D04；本引擎但能力表判定不可用返回 D10；二者都不发后端请求。

## 能力判定

- 目录只声明「数据类型 × 支持的后端」，不暴露实例是否配置；
- 因此对每个日志通道做一次 `maxBytes=64`、哨兵关键词的配置探测：
  - 配置了 → `ok`，通道可用；
  - 没配置 → `NOT_CONFIGURED`，能力表带 `code` 与 `requirements[]`；
- 运行态通过 `discovery/query (scope=sources)` 的 `baseUrlConfigured` 与 `supportedFamilies` 判定；
- 不可用信号必须带 `code` + `requirements[]`，不允许只写「缺少能力」。

## 当前环境与已知缺口

本机验证环境配置了 `flink-rest` 与 `victoriametrics`，没有配置 local-disk / ES / yarn，因此：

- Flink 运行态（snapshot / compare）可查到真实指标；
- 所有 `log.service` / `log.task` 通道会真实返回 `NOT_CONFIGURED` 与配置键，不是空数组。

仍需后端补齐的能力：

| 缺口 | 原因 | 需要的接口/配置 |
|---|---|---|
| DS 调度侧任务日志 | v1 没有 `ds` 服务类型 | 新增调度侧任务日志接口 |
| Flink 异常摘要 | 目录只声明 `engineEvidence`，无查询端点 | 新增 engineEvidence 查询或并入 snapshot |
| YARN 运行中容器日志 | 只读聚合日志 | 开启日志聚合，或接入 local-disk / ES |
| Spark SHS 文本日志 | `/logs` 返回事件日志 zip | 用 local-disk / ES 采集文本日志 |
| Doris / StarRocks 慢查询 | 目录 `declared_not_implemented` | 实现 slowquery 后端 |

## 验证

```bash
cd /Users/mxq/Desktop/dataforge
npm run build:agentkits
npx vitest run agentkit/task-diag/lib/diag.test.ts
```

真实链路验证需要 dataforge-server 已启动，并注入 `DATAFORGE_API_HOST` / `DATAFORGE_AUTH_TOKEN`。
