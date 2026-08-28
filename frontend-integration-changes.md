# 前端对接改动清单（EngineType / StorageEngineType 合并到 DatasourceType）

> 背景：`EngineType` 与 `StorageEngineType` 已合并为统一的 `DatasourceType`，并新增 `exec`（是否可计算）、`store`（是否可存储）、`language`（支持语言列表 `CodeType` 编码）三个属性。下面按"必须改 / 需要对接 / 不用动"三档整理。

---

## 一、破坏性变更（前端必须改）

### 1. 数据源 CRUD 的 `storageEngine` 字段已移除

| 方向 | 接口 | 改动 |
| --- | --- | --- |
| 响应 | `GET /devops/datasource/list`、`GET /devops/datasource/all`、数据源详情 | 返回的 `DatasourceConfigVO` **不再包含 `storageEngine` 字段**（见 `DatasourceConfigVO.java`，全文无该字段） |
| 请求 | `POST /devops/datasource`、`PUT /devops/datasource` | 入参 `DatasourceConfigDTO` **已移除 `storageEngine` 字段及原 `@NotNull` 校验**（见 `DatasourceConfigDTO.java`） |

**前端动作：**
- 所有读取 `ds.storageEngine` 的逻辑改为使用 `ds.datasourceType`（其值为 code 字符串，如 `"doris"`）。
- 提交/更新时**停止发送 `storageEngine`**。该字段现被 Jackson 静默忽略（不会报错，但值丢失），且原"必填"约束已不存在，提交校验逻辑需同步调整。
- 区分「计算 / 存储」能力，改用 `/types` 返回的 `exec` / `store`（见第二节），而不是靠 `storageEngine` 是否存在判断。

---

### 2. `GET /devops/datasource/types` 响应形态变更

| 项 | 旧形态 | 新形态 |
| --- | --- | --- |
| 返回类型 | `List<String>`（code 字符串数组） | `List<DatasourceTypeMetaVO>`（富结构对象数组） |
| 示例 | `["spark","doris"]` | 见下方 JSON |

旧端点因 `DatasourceType` 的 `@JsonValue` 标注在 `code` 上，只会序列化出 code 字符串，导致新增的 `exec/store/language` 对前端不可见；新端点显式返回完整元数据。

**新响应示例：**
```json
[
  { "code": "spark",     "description": "Apache Spark", "exec": true,  "store": false, "language": ["java","scala","python","sql"] },
  { "code": "flink",     "description": "Apache Flink", "exec": true,  "store": false, "language": ["java","scala","python","sql"] },
  { "code": "kyuubi",    "description": "Apache Kyuubi","exec": true,  "store": false, "language": ["sql"] },
  { "code": "doris",     "description": "Apache Doris",  "exec": true,  "store": true,  "language": ["sql"] },
  { "code": "hbase",     "description": "Apache HBase",  "exec": true,  "store": true,  "language": ["sql"] },
  { "code": "mysql",     "description": "MySQL",         "exec": true,  "store": true,  "language": ["sql"] },
  { "code": "postgresql","description": "PostgreSQL",    "exec": true,  "store": true,  "language": ["sql"] },
  { "code": "clickhouse","description": "ClickHouse",    "exec": true,  "store": true,  "language": ["sql"] },
  { "code": "starrocks", "description": "StarRocks",     "exec": true,  "store": true,  "language": ["sql"] },
  { "code": "hive",      "description": "Hive",          "exec": false, "store": true,  "language": ["sql"] },
  { "code": "es",        "description": "Elasticsearch", "exec": false, "store": true,  "language": [] },
  { "code": "hudi",      "description": "Apache Hudi",   "exec": false, "store": true,  "language": ["sql"] },
  { "code": "iceberg",   "description": "Apache Iceberg","exec": false, "store": true,  "language": ["sql"] }
]
```

**字段说明（`DatasourceTypeMetaVO`）：**

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `code` | String | 类型编码（如 `spark`） |
| `description` | String | 中文/英文描述 |
| `exec` | boolean | 是否具备**计算（执行代码）**能力 |
| `store` | boolean | 是否具备**存储（落表/落库）**能力 |
| `language` | List<String> | 支持的语言编码：`sql` / `java` / `scala` / `python`（对应 `CodeType` 的 code） |

**前端动作：** 解析 `/types` 的逻辑由"字符串数组"改为"对象数组"，并按需读取 `exec` / `store` / `language`。

---

## 二、新增接口（前端需对接）

### 3. `GET /devops/execution/engines` —— 可选执行引擎列表

把后端 `CodeExecutionService.getAvailableEngines()` 暴露给前端，返回**当前已注册执行策略的引擎**，每个引擎自带完整元数据。

- 路径前缀 `/devops/execution`，与既有的 `/development/execution`（真正执行 SQL 的接口）**互不冲突**。
- 响应结构与 `/types` 完全一致（`List<DatasourceTypeMetaVO>`）。

**响应示例：**
```json
{
  "code": 200,
  "data": [
    { "code": "spark",  "description": "Apache Spark", "exec": true, "store": false, "language": ["java","scala","python","sql"] },
    { "code": "doris",  "description": "Apache Doris", "exec": true, "store": true,  "language": ["sql"] },
    { "code": "kyuubi", "description": "Apache Kyuubi","exec": true, "store": false, "language": ["sql"] }
  ]
}
```
> 具体条目取决于 `ExecutionStrategyFactory` 实际注册了哪些策略。

**前端动作：** 用此接口动态渲染「执行引擎下拉」和「该引擎支持的语言」，取代此前硬编码的映射。

---

### 4. `GET /devops/execution/engines/supported` —— 单组合法性校验

把后端 `CodeExecutionService.isExecutionSupported(engineCode, codeType)` 暴露给前端，判断某个「引擎 + 语言」组合是否可被执行。

**请求参数：**

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `engineCode` | String | 是 | 引擎编码（如 `spark`） |
| `codeType` | String | 是 | 语言编码（如 `sql` / `java`） |

**响应示例：**
```json
{ "code": 200, "data": true }
```

**前端动作：** 作为「引擎 + 语言」选择的兜底校验（如用户选了 engine=spark + codeType=python，返回 true 才能提交）。

---

## 三、无需改动（已确认形态不变）

### 5. 表元数据 `storageEngine`（`MetadataController`）
返回 `TableMetadataVO.storageEngine` 字段名保留，类型现为 `DatasourceType`，因 `@JsonValue` 序列化为 code 字符串；其取值（doris/hbase/hive/starrocks/es/hudi/iceberg/clickhouse/mysql/postgresql）与原 `StorageEngineType` 完全一致 → JSON 形态零变化，**前端不用动**。

### 6. 代码执行请求 `engineType`（`CodeExecutionController`：execute / submit / validate）
`engineType` 自始至终是 `String` code（`CodeExecutionRequest` 未使用枚举），请求体结构不变；合法 engine code 现为 13 个 `DatasourceType` 的 code，与原 `EngineType`/`StorageEngineType` 取值一致，前端沿用原值即可。

---

## 四、前端迁移检查清单

- [ ] **数据源列表/详情页**：移除对 `ds.storageEngine` 的读取，改用 `ds.datasourceType`（code 字符串）。
- [ ] **数据源创建/编辑表单**：提交体移除 `storageEngine` 字段。
- [ ] **类型下拉 / 能力判断**：`/types` 解析从 `string[]` 改为 `object[]`，用 `exec`/`store` 渲染「可计算 / 可存储」标签。
- [ ] **执行引擎选择**：优先用 `GET /devops/execution/engines` 动态拉取，替代硬编码。
- [ ] **语言选择**：基于所选引擎的 `language` 列表渲染；提交前可调用 `/engines/supported` 校验。
- [ ] **表元数据页**：`storageEngine` 仍是 code 字符串，无需改动。
- [ ] **代码执行接口**：`engineType` 仍为字符串 code，无需改动。

---

## 五、相关后端文件（供联调参考）

| 文件 | 作用 |
| --- | --- |
| `devops/controller/DatasourceConfigController.java` | `/types` 返回 `List<DatasourceTypeMetaVO>` |
| `devops/controller/ExecutionEngineController.java` | 新增 `/devops/execution/engines`、`/engines/supported` |
| `devops/vo/DatasourceTypeMetaVO.java` | 富结构视图，`code/description/exec/store/language` |
| `devops/vo/DatasourceConfigVO.java` | 已无 `storageEngine` 字段 |
| `devops/dto/DatasourceConfigDTO.java` | 已无 `storageEngine` 字段及 `@NotNull` |
| `devops/enums/DatasourceType.java` | 合并后的统一枚举，含 `exec/store/language` |
| `development/service/execution/CodeExecutionService.java` | `getAvailableEngines()` / `isExecutionSupported()` 实现 |
