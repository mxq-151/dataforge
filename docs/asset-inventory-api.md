# 资产概况 —— 后端接口清单

> 交付对象：`dataforge-server`
> 对应前端：资产管理模块 → 「资产概况」页签（`src/views/asset-catalog/AssetOverviewTab.tsx`）
> 契约来源：`src/api/assetCatalog.ts`
> 日期：2026-09-29

---

## 一、背景与范围

资产管理模块已改为标签页结构（「资产目录」+「资产概况」）。「资产概况」页签由五块只读看板组成，共需后端新增 **5 个查询接口**：

| # | 看板 | 接口 |
|---|---|---|
| 1 | 按环境 × 项目的表数量与占用空间 | `GET /api/asset/inventory/env-project` |
| 2 | 访问频率 / 占用空间 TOP 100 表 | `GET /api/asset/inventory/top-assets` |
| 3 | 消耗计算资源 / 运行时长 TOP 50 任务 | `GET /api/asset/inventory/top-compute` |
| 4 | 任务延迟率（主要针对 YARN 任务） | `GET /api/asset/inventory/task-delay` |
| 5 | 数据大小增长率突增表清单 | `GET /api/asset/inventory/size-growth` |

全部为只读 GET，挂在既有 `/api/asset/inventory/*` 路径下。

---

## 二、通用约定

| 项 | 约定 |
|---|---|
| 统一前缀 | `/api/asset` |
| 响应信封 | `{ "code": 200, "message": "ok", "data": <T> }`；`code != 200` 前端按业务失败抛错 |
| 鉴权 | `Authorization: Bearer {token}` |
| 签名头 | `X-Request-Timestamp`、`X-Request-Nonce`、`X-Request-Signature` |
| 权限模型 | 沿用库表权限 fail-close：由服务端过滤，前端不做二次过滤 |
| 分页 | 本批接口均不分页，由 `limit` 参数限流（环境×项目全量返回，前端自行聚合） |
| 前端容错 | 5 个接口各自独立探测，任一 404/500 只让该看板降级为「接口待接入 + 能力清单」，不影响其它看板；读失败前端不弹全局提示 |
| 排序 | **必须在服务端完成**，前端不做全量拉取后本地排序 |

数据来源建议：

- 表数量 / 占用空间 / 增长率：`table_metadata`（`size_bytes` 等既有列）
- 访问频率：`asset_access_log`（T+1 汇总）
- 计算资源 / 运行时长 / 延迟：DolphinScheduler 运行数据 + YARN 指标

环境（`env`）统一取值 `prod | gray | test`，由服务端按库名规范 `{分层}_{业务域}_{环境}` 解析（环境后缀仅 `_prod / _gray / _test`），**前端不自行猜测环境**，避免生产库被误判为测试库。

> **2026-10-10 补充：env 已从「响应字段」升级为「查询参数」。** 资产管理模块（资产概况 + 资产目录）
> 改为**按环境切换全部内容**，因此下列接口以及目录树 / 检索 / 建议 / 收藏 / 标注缺口
> 都接受可选的 `env` 查询参数。取值与过滤口径见文末「六、环境维度」。不传 `env` 时行为与改造前一致（全环境）。

---

## 三、接口详情

### 1. 按环境与项目的资产规模

```
GET /api/asset/inventory/env-project
```

**查询参数**：无。

**响应 `data`**：数组

```json
[
  {
    "env": "prod",
    "projectCode": "olist",
    "projectName": "Olist 数仓",
    "tableCount": 128,
    "sizeBytes": 5368709120
  }
]
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `env` | string | 枚举 `prod` / `gray` / `test` |
| `projectCode` | string | 项目编码（与调度项目名口径一致） |
| `projectName` | string | 项目显示名 |
| `tableCount` | number | 该环境 × 项目下的表数量 |
| `sizeBytes` | number | 占用空间（字节） |

**口径**：粒度即「环境 × 项目」一行，**固定返回全环境**（不接 `env` 参数）。前端用它做两件事：
① 筛出所选环境的项目排行；② 用全环境合计作分母，算出「所选环境占全库空间比例」。
若本接口也按环境收窄，占比就失去了分母，因此这里刻意不收窄。

---

### 2. 访问频率 / 占用空间 TOP 100 表

```
GET /api/asset/inventory/top-assets?sortBy=access&limit=100&env=prod
```

**查询参数**：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `sortBy` | enum | `access` | `access`=按访问频率；`size`=按占用空间 |
| `limit` | number | `100` | 条数上限 |
| `env` | enum | 不传=全环境 | `prod` / `gray` / `test`，按库名后缀过滤 |

**响应 `data`**：数组

```json
[
  {
    "tableMetadataId": 1001,
    "databaseName": "dwd_trade_prod",
    "tableName": "dwd_trade_order_d",
    "env": "prod",
    "projectCode": "olist",
    "projectName": "Olist 数仓",
    "accessCount30d": 3281,
    "sizeBytes": 21474836480,
    "ownerName": "zhangsan"
  }
]
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `tableMetadataId` | number | 表元数据主键，可作为详情跳转键 |
| `databaseName` / `tableName` | string | 库.表 |
| `env` | string | `prod` / `gray` / `test` |
| `projectCode` / `projectName` | string | 归属项目 |
| `accessCount30d` | number | 近 30 天访问次数（T+1 汇总） |
| `sizeBytes` | number | 占用空间（字节） |
| `ownerName` | string | 负责人，无则空串 |

---

### 3. 计算资源 / 运行时长 TOP 50 任务

```
GET /api/asset/inventory/top-compute?sortBy=resource&limit=50&env=gray
```

**查询参数**：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `sortBy` | enum | `resource` | `resource`=按消耗计算资源；`duration`=按运行时长 |
| `limit` | number | `50` | 条数上限 |
| `env` | enum | 不传=全环境 | `prod` / `gray` / `test`，按**工作流名后缀**过滤 |

**响应 `data`**：数组

```json
[
  {
    "workflowName": "ads_olist_daily",
    "nodeName": "spark_ads_trade",
    "taskType": "SPARK",
    "projectName": "Olist 数仓",
    "cpuHours": 182.5,
    "memoryGbHours": 1460.0,
    "runDurationSeconds": 3720,
    "execCount": 30
  }
]
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `workflowName` / `nodeName` | string | 工作流与节点名 |
| `taskType` | string | `SPARK` / `HIVE` / `FLINK` 等 |
| `projectName` | string | 调度项目名 |
| `cpuHours` | number | 消耗 CPU 核·小时 |
| `memoryGbHours` | number | 消耗内存 GB·小时 |
| `runDurationSeconds` | number | 运行时长（秒） |
| `execCount` | number | 统计窗口内执行次数 |

**口径建议**：`resource` 排序以 `cpuHours` 为主键、`memoryGbHours` 为次键降序；`duration` 排序以 `runDurationSeconds` 降序。统计窗口默认近 30 天，与调度运行记录一致；如需前端可配，可补 `days` 参数。

---

### 4. 任务延迟率（YARN）

```
GET /api/asset/inventory/task-delay?days=30&env=test
```

**查询参数**：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `days` | number | `30` | 统计窗口天数 |
| `env` | enum | 不传=全环境 | `prod` / `gray` / `test`，按**工作流名后缀**过滤 |

**响应 `data`**：对象

```json
{
  "totalTasks": 1200,
  "delayedTasks": 156,
  "delayRate": 0.13,
  "windowDays": 30,
  "byQueue": [
    { "queueName": "root.etl", "totalTasks": 800, "delayedTasks": 120, "delayRate": 0.15 }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `totalTasks` | number | 统计窗口内任务总数 |
| `delayedTasks` | number | 延迟任务数 |
| `delayRate` | number | 延迟率，0~1 小数（前端按百分比展示） |
| `windowDays` | number | 统计窗口天数（回显用） |
| `byQueue` | array | 按 YARN 队列拆分，可为空数组 |

`byQueue[]` 元素：`{ queueName, totalTasks, delayedTasks, delayRate }`。

**延迟口径（需服务端确认并固化）**：任务实际开始时间晚于计划开始时间即计为延迟；以 YARN 任务为主。

---

### 5. 数据大小增长率突增表清单

```
GET /api/asset/inventory/size-growth?growthPercent=10&minSizeBytes=10737418240&env=prod
```

**查询参数**：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `growthPercent` | number | `10` | 增长率阈值（百分比） |
| `minSizeBytes` | number | `10737418240` | 当前大小下限（= 10GB，字节） |
| `env` | enum | 不传=全环境 | `prod` / `gray` / `test`，按库名后缀过滤 |

**响应 `data`**：数组

```json
[
  {
    "tableMetadataId": 1002,
    "databaseName": "dwd_trade_prod",
    "tableName": "dwd_trade_log_d",
    "env": "prod",
    "projectName": "Olist 数仓",
    "previousSizeBytes": 17179869184,
    "currentSizeBytes": 32212254720,
    "growthBytes": 15032385536,
    "growthRate": 0.875
  }
]
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `tableMetadataId` | number | 表元数据主键 |
| `databaseName` / `tableName` | string | 库.表 |
| `env` | string | `prod` / `gray` / `test` |
| `projectName` | string | 归属项目 |
| `previousSizeBytes` | number | 上期大小（字节） |
| `currentSizeBytes` | number | 本期大小（字节） |
| `growthBytes` | number | 增长量（字节） |
| `growthRate` | number | 增长率，0~1 小数，`(current - previous) / previous` |

**筛选与排序在服务端完成**：`growthRate > growthPercent` 且 `currentSizeBytes > minSizeBytes`，按 `growthRate` 降序返回。

---

## 四、类型对照（前端 TS 类型）

| 接口 | `data` 类型 |
|---|---|
| `env-project` | `AssetEnvProjectStatVO[]` |
| `top-assets` | `AssetTopAssetVO[]` |
| `top-compute` | `AssetTopComputeTaskVO[]` |
| `task-delay` | `AssetTaskDelayVO` |
| `size-growth` | `AssetSizeGrowthVO[]` |

以上类型定义见 `src/api/assetCatalog.ts`，字段名需与本文逐字一致（前端按驼峰直取，无别名映射）。

---

## 五、附：资产模块其余接口（既有契约）

以下为本文档聚焦的 5 个接口之外的既有契约，列出供整体排期与对照（**不在本次环境维度改造的新增范围内，但同样接受 `env`，见第六节**）：

| 分组 | 接口 |
|---|---|
| 目录与检索 | `GET /catalog/tree`、`GET /search`、`GET /suggest` |
| 表详情 | `GET /table/{id}`、`GET /table/{id}/usage`、`/producers`、`/indicators`、`/quality`、`/preview` |
| 表治理（写） | `PUT /table/{id}/owner`、`/category`、`/tags`、`/lifecycle`、`GET|PUT /table/{id}/doc`、`GET /table/{id}/doc/history`、`POST /table/{id}/refresh` |
| 收藏 / 标签 / 分类 | `GET|POST|DELETE /bookmark`、`GET /tag`、`GET /category` |
| 埋点与盘点 | `POST /access`、`GET /inventory/overview`、`GET /inventory/health`、`GET /api/metadata/annotation-gaps` |

字段级契约以 `src/api/assetCatalog.ts` 为准。

**补充（表详情一致性）**：`GET /api/asset/table/{id}` 的响应需包含 `compression`（压缩方式，可为 null），
与 `GET /api/metadata/tables` 同列。资产目录的表详情与数据探索模块共用同一份渲染
（`src/views/data-explore/TableDetailContent.tsx`），字段缺一会直接显示为 `-`。

---

## 六、环境维度（env 查询参数）

> 背景：资产管理模块的「资产概况」与「资产目录」改为**按环境切换全部内容**。
> 环境切换器是**模块级**的：挂在资产管理模块的页签条右侧，「资产概况」与「资产目录」共用同一个选中环境
> （生产 / 灰度 / 测试，**默认生产**）。切换一次即让两个页签下的**全部内容**重取 ——
> 资产概况的五块看板图表（含①的项目排行与占比环形图）与资产目录的目录树 / 检索 / 治理项 / 收藏一起切。

### 6.1 接受 `env` 的接口

| 接口 | 过滤依据 | 说明 |
|---|---|---|
| `GET /api/asset/catalog/tree` | 库名后缀 | 环境在权限过滤之后生效，父节点计数与可见子节点一致 |
| `GET /api/asset/search` | 库名后缀 | **只对表 / 字段生效**；指标是定义级资产，无环境维度，不受 `env` 影响 |
| `GET /api/asset/suggest` | 库名后缀 | 输入建议只返回表名 |
| `GET /api/asset/bookmark` | 被收藏对象所属库 | 指标收藏无环境维度，始终返回；指定环境时改走内存分页（保证 totals 与页码一致） |
| `GET /api/asset/inventory/overview` / `health` / `top-assets` / `size-growth` | 库名后缀 | 表类资产看板 |
| `GET /api/asset/inventory/top-compute` / `task-delay` | **工作流名后缀** | 提交调度时环境拼在工作流名末尾（`olist_code_ods` + test → `olist_code_ods_test`），与库名后缀是同一套约定 |
| `GET /api/metadata/annotation-gaps` | 库名后缀 | 环境条件下推到 SQL（`LIKE '%!_prod' ESCAPE '!'`），与 `limit` 截断同层，避免截断到别的环境的表 |
| `GET /api/asset/inventory/env-project` | — | **不接受 `env`**：前端需要全环境明细来计算「所选环境占全库空间比例」 |

### 6.2 取值与判定口径（唯一实现：`common/utils/DeployEnvParser`）

| 入参 | 行为 |
|---|---|
| 不传 / 空串 | 不过滤，返回全环境（与改造前一致） |
| `prod` / `gray` / `test`（大小写不敏感） | 只返回该环境 |
| 非法值（如 `production`） | 按「不过滤」处理，**不清空结果** |
| 对象名称解析不出环境（如库名 `dwd_trade`、`test_db`） | 显式过滤时被排除 —— 「不知道是什么环境」不等于「属于所选环境」 |

### 6.3 与权限的关系

环境只缩小「看哪一套」，**不改变权限边界**：所有过滤都在服务端权限过滤（`sys_table_permission` fail-close）**之后**执行，
越权表不会因为切换环境而出现。前端只透传 `env`，不自行从库名推断环境。


