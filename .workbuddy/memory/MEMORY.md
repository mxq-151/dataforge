# DataForge 项目长期记忆

> 只放「跨会话必须记住、忘掉就出错」的硬规则。实现细节见 skill `dataforge-project-conventions`
> （注：该 skill 当前不在本机 `~/.workbuddy/skills/`，仅有本文件）；历史过程见 `memory/YYYY-MM-DD.md`。

## 命令与环境（必守）

- **跑 vitest / tsc / vite 一律 `env -u NODE_OPTIONS`**（否则 jsdom 导入从 0.5s 变 96s，CPU ~1% 纯等待）。
- **git 写操作不在本 agent shell 跑**：写入会部分丢弃（`update-ref`/`fetch` 报成功但不落地），
  2026-09-15 11:43 由此写坏过 `.git`。只读命令安全（加 `-c maintenance.auto=false -c gc.auto=0`）。
- **同一文件多处编辑必须串行**（并行 Edit 会互相抹掉）。查并发写者 `find src -mmin -8`。
- macOS：`grep "a\|b"` 静默失败，须 `grep -E`。
- 回归基线：**59 文件 / 1001 例**。负载高（load 7~10）时 `waitFor` 会超时误报，**load 回落即过**。

## 模型上下文窗口

- `deepseek-flash` = DeepSeek **V4.1** Flash，**1M**；判定里没有 v3/v4 字样，**只能显式列出**，
  否则掉进泛化 `deepseek`→128k。DeepSeek V4 系一律 1_000_000（非 1_048_576）。
- `GET /api/model` **必须带 location**；**冷实例首次返回 `200 + data: []`** ⇒ 必须重试。改判定须同步单测。
- sidecar 由 app 托管，应用一关端口就拒连（502/refused 属正常）。

## 编码约定（要点）

- 代码头参数三字段：`@程序参数` / `@资源参数` / `@任务参数`，**取值是真实值**。两个消费面：运行弹窗
  只取参数名（`extractProgramParams`）、提交调度取取值落 `taskParams`（`headerTaskParams.ts`）。
  改字段名/语义须同步：S3 提示词 → `parseFileHeader` → `HEADER_FIELDS` → 上述两处 →
  `PendingProgramRun` → `ProgramRunModal` / `SubmitToSchedulerModal` → 6 个测试文件。
  调度侧的「任务参数」是 DolphinScheduler 概念，别跟着改。
- 工作流名**不 sanitize**、环境后缀**默认 test**；`_v{N}` 版本链已删。`mainJar` 不加必填校验。
- 表单加必填项必须同步 `REQUIRED_PARAMS` 与单测。
- **x6 画布在 jsdom 下不可渲染**：测编辑器内部交互只 mock `../dag/DagCanvas`；含 `useToast` 须包
  `ToastProvider`。
- 提示词类 UI 不用原生 `title`（延迟 0.5~1s），改零延迟自定义 tooltip，面板内用 `position:fixed`。
- 流式文本逐字增长不进 `messages`（走 ref + `subscribePartText`）。
- 开发助手切任务类型**不新建会话**（system 逐轮下发）；**数据探索例外**——其 `newSession()`
  同时承担「新建时间戳工作目录」，不能照搬改法。

## 删除 / 回滚闸门

- 一切删除/回滚先过纯函数 `rollbackSafety.ts::assessRollbackSafety`；`root=null` 一律中止。
- 删除**走回收站**（`.dataforge-trash/` + manifest，须对 git 隐身），禁止直删。
- 保留策略 30 天 / 50 批 / 2 GiB（最新 2 批不清理），决策在 `trashRetention.ts`，执行在
  `trashCleanup.ts`。**新增「移入回收站」入口必须接 `scheduleTrashRetention`**。回收站≠备份。

## 写文档前的事实核查基线（勿凭印象）

- **血缘与调度是桌面端直连上游**（`src/api/marquez.ts`、`dolphinscheduler.ts`），服务端无 Marquez 客户端。
- **租户不是数据隔离边界**（`sys_tenant_user` 1:1 绑定；资源表无 tenant_id）。
- **权限已加固**：DML 检查 fail-close；行/列合并**取交集收紧**；约束在 **SQL 下发前改写**
  （`SqlPermissionRewriter`），Spark/Flink/HBase 已纳入。残留边界：租户非隔离边界、权限只覆盖 SQL
  代码类型（Scala/Python/Jar 不享行列约束）、超管短路。
- **列级脱敏是真实机制**（`full/idcard/phone/email/partial`，多角色取更严者），对智能体同样生效；
  但无敏感数据自动识别，规则全靠人工配。
- **凭据落盘已加密**（Electron `safeStorage` 信封 `{"$dfenc":"v1"}`），旧明文读时兼容；
  残留：设置页需明文回填、无 keyring 的 Linux 降级明文、换机器解不开。导出走 `df:store:export` 剥离。
- **元数据缺失已可观测**：`MetadataAnnotationGapService`（未标注清单）+ `MetadataSyncAlertService`
  （同步失败写审计日志 + ERROR）。勿再写「静默滞后」。
- **提交有环境维度**：三档 prod/gray/test（默认 test），**血缘只在 prod 注入**（硬闸门
  `deployEnv.ts::shouldInjectLineage`）；拼装处 `src/utils/lineageParams.ts`（两入口共用）。

## 平台定位与商业模式（对外叙事必守）

- 核心目标：**让智能体正确理解业务数据**。四大核心组件 = dataforge（规范开发环境）、
  dataforge-server（库表+指标描述）、Marquez（血缘）、DolphinScheduler（任务依赖）。
  **listener 类组件是治理增强、可插拔，别抬高。**
- **核心差异（2026-09-15 用户定调，写文档必讲）**：DataForge 类似 opencode / WorkBuddy 这类 AI 编程
  助手，但**提需求的人不同**——编程助手是开发者提需求，DataForge 是**业务方提需求**（不懂 SQL）；
  这既不同于编程助手，也不同于 DataWorks 等云产品（业务方在平台外提、由开发者转述）。
  ⇒ 这正是**数据代开发服务**成立的技术基础：企业方人员提需求，我方完成程序开发、上线与维护。
- **软件在企业内部免费、代码闭源**；收益 = 数据开发服务 + 集群运维服务（软件免费、服务收费）。
- 五类上下文信息：规范开发环境 / 库表描述 / 指标描述 / 血缘 / 任务依赖。

## 需求驱动的闭环（核心优势）

- 六角色含**业务需求方**与**数据架构师**；开发助手任务类型即角色：需求编写(BUSINESS_REQUESTER)
  → 数仓设计(DATA_ARCHITECT) → 数据开发(DATA_DEV_ENGINEER)（数据探索是另一套）。
- 三段产物同名贯穿，契约唯一来源 `src/hooks/opencode/opencodeInstructions.ts`；**指标是唯一主线**，
  另有四条同源线：数据时效 / 数据源名称 / 数据质量 / 敏感数据。
- `TaskRecord` 不记任务类型；`AIPanel.tsx:145` 的 `handleTaskTypeChange` 当前主动 `newSession()`。

## 交付偏好

- 性能类任务**诊断驱动**，先量化再改。交付含量化对比、变更表、决策理由、未改动项清单，附
  `tsc --noEmit` 与 vitest 计数，新增逻辑配套单测。
- **计划书不出 Word**（2026-09-15 用户明确）：`output/<request_id>/` 最终交付物是
  `stage3/…html`（网页版），stage2 HTML 保留为中间产物。内容源 `stage1/final_draft.md`。
- **计划书不设「风险识别与应对」章节**（用户判断多数条目属「如此设计」）。现行结构 =
  一 概述 / 二 需求 / 三 架构 / 四 组件 / 五 模块优先级 / 六 推广与时间 / 七 验收质量 /
  八 预期效益 / 九 附录：现状基线。真实残留边界留在本文「事实核查基线」里，别写回文档。
- ⚠️ 计划书生成脚本：`.workbuddy/memory/pipeline-scripts/` 里的是**旧版**（硬编码 Mac 路径
  `/Users/mxq/...`，LEADIN 也落后一版）；**可用版在 `output/45d4b135-…/tools/`**
  （`df_md.py` 内核 + `df_gen_stage2.py` / `df_make_web.py` + 抽出的 css）。渲染规则与校验手法
  见 `memory/2026-09-15.md` 18:10 那条（h3 id 为章内 0-based 块号；第五/六章导语在正文里不重复注入）。
- **表格列名必须短（≤ 约 12 视觉字符）**：`web.css` / `stage2.css` 的 `thead th` 是
  `white-space:nowrap`，长表头不折行、直接撑宽整张表（主区可用宽 ≈ 790px）。带枚举的列名
  （如「其他云平台（DataArts / WeData / Dataphin）」）一律拆成"短列名 + 导语里一句列名说明"。
  改动前用脚本扫一遍 md 各表表头单元格长度，≥18 字即待处理。
- **对照表按"一项能力一行"组织，能力项与非能力项分表**（2026-09-15 用户要求）：能力表 =
  数据集成 / 数据治理 / 开发环境 / 作业调度 / 数据血缘 / 权限管理 / 任务管理 / 指标管理 / 知识管理
  （+ AI 能力落点）；形态与部署 / 引擎兼容 / 角色模型 / 设计取向 / 收费模式 属"比较坐标"，另列一表。
  新增到对照表的缺口只说"2.2 规划中"清单里已有的，否则与 7.5 / 8.1 追溯链打架。

## AI 能力落点（标状态前必看）

- **推理在客户端**本地 sidecar（opencode，127.0.0.1:4096），模型与密钥用户自配；**服务端零 LLM 调用**。
- **已落地**：6 个工具组（compile / indicator-query / knowledge-document / lineage / metadata-agent /
  sql-validate）、元数据代理 `/metadata/agent/*`。
- **规划中**：自动化问题排障、数据价值评估、知识检索增强（当前是 MyBatis-Plus `like`，无向量库）。
- **不做的**：服务端统一推理入口（2026-09-14 已决策），勿再列为规划项。
- 别整条一刀切标状态：一个目标常是「一半已落地 + 一半规划」。

## 数据质量 / 资产目录（2026-09-17 评估，写文档必用）

- **7 类规则类型是既有契约，不得自造同义词**：`opencodeInstructions.ts::QUALITY_RULE_SPEC`（L81-96）=
  主键唯一性 / 非空 / 值域 / 行数波动 / 行数环比 / 上下游对账 / 口径一致性；S1 提要求、S2 定
  规则名+校验对象+阈值+处置方式、S3 独立成文件挂处理任务下游（「校验输出须可定位：规则名/校验对象/
  阈值/实际值/是否通过」）。**DQC 质量层 = 规则定义 + 稽核结果存储**（`LAYERING_SPEC`），前缀 `dqc_`，
  DDL 文件 `ddls/dqc_ddl.sql`。
- **「阻断下游」的既有约定是「独立质检任务挂下游」，不是 DataWorks 式「反向置调度节点失败」**。别再提后者。
- **质量侧现状 = 半条链路**：只有结果表 `data_quality_check_result`（「检查项」是自由文本）+ `/quality/check-result`
  四接口，**无规则/模板/任务/触发/告警，桌面端零 UI**。别再写「完全没有」。
- **资产分类不人工维护**：表名规范 `{分层}_{业务域}_{实体描述}_{刷新周期}` ⇒ 分层与业务域可确定性解析，
  解析失败即「未分类」且自动成为治理项。这是与 DataWorks（人工维护业务分类树）的核心差异。
- **改一级菜单必查三连锁**：① `ActiveTab` / `MENU_CODE_MAP` / `App.tsx::FIRST_LEVEL_TAB_IDS` 同批改，
  否则 `MENU_CODE_MAP[id]=undefined` ⇒ 入口静默消失；② `FIRST_LEVEL_MENU_CODES` 由 MENU_CODE_MAP 派生，
  加码后「持有旧全量码」的非超管角色会失去 `every()` 兜底（超管不受影响）；③ **菜单种子只在
  `sql/testdata/*.sql`**，四方言 `sql/init` 无菜单 ⇒ 迁移脚本必须自带幂等菜单与授权种子。
- **服务端不存血缘与产出任务副本**：血缘权威在 Marquez、任务权威在 DolphinScheduler（桌面端直连）。
- **两条安全闸门**：校验 SQL 下发前必须过 `SqlPermissionRewriter`；资产目录的树/检索/详情必须服务端
  fail-close 过滤 `sys_table_permission`（含列级），否则泄露越权表名与字段名。
- 相关评估稿：`output/2026-09-17-dataworks-gap/index.html`（含 12 处桌面端改动 + 服务端 15 新表 / 3 改造表 / ~46 接口清单）。

## 数据库脚本与方言（2026-09-17 落地第一批，改 schema 必读）

- schema **手写维护**在 `dataforge-server/src/main/resources/sql/`，**无 Flyway**。第一批后四方言 init 各 **35 表**。
  改动顺序：`init/` 四方言 → `migrate/`（PG + MySQL）→ `testdata/`（仅当涉及菜单）。
- **真目标只有两个**：PostgreSQL 14（docker 部署，`run-dataforge.sh` 用 `--spring.datasource.url` 覆盖）、
  MySQL（本地开发，`application.yml` 默认 3306，实测本机是 MySQL 9.6）。
  **MariaDB / H2 在 pom.xml 里连驱动都没有**，属"保持平行"的文档级脚本，别当成能跑的。
- **新装 == 升级**（不变量）：`init/*.sql` 建出的 schema 必须与「老库 + migrate」**逐字一致**
  —— 列集合/类型/可空/默认值/索引名。两边漂移会产生"新装能用、升级报错"这类最难查的问题。
- **参考数据放 init，菜单放 testdata**：7 类规则模板与 7 个分层分类属平台级数据，必须进 `init/*.sql`；
  菜单与授权只在 `testdata/dataforge-testdata-postgresql.sql`（init 只建菜单表结构）。
  ⇒ **已上线库必须靠 migrate 自带菜单+授权种子**，否则新入口无权限码 ⇒ 入口静默消失。
  部署脚本 `init-dataforge.sh` 用 `ON_ERROR_STOP=0`（**吞掉错误**），验证时务必改 `1`。
- **InnoDB 索引键上限 3072 字节**（utf8mb4 每字符 4 字节）：`varchar(1024)` 建索引 = 4096 字节，
  报 `Specified key was too long` 且**整张表建不出来**（不是只失败索引）。
  `table_metadata.business_owner/tech_owner` 因此取 **varchar(255)**；`indicators` 同名列是 1024 且
  **故意未建索引** —— 宽度差异是有意的，已在注释写明。
- **MySQL 8/9 没有 `ADD COLUMN IF NOT EXISTS`，也没有 `CREATE INDEX IF NOT EXISTS`** ⇒ 迁移脚本用存储过程
  查 `information_schema` 守卫，末尾自行 DROP；命名 `df_add_column_if_missing` / `df_add_index_if_missing`。
- **`DELIMITER` 是 mysql CLI 的指令，JDBC 不需要**：`$$` 包起来的 `CREATE PROCEDURE` 整条发送即可。
- **三方契约**（`df_sql_check.py` 会强制）：SQL 种子 ↔ `src/types/quality.ts::QUALITY_RULE_TYPES`
  ↔ 提示词；`template_code` 必须与 `rule_type` 同名；`remark` 与前端 `desc` 逐字一致。
- 验证三板斧见 skill **`dataforge-sql-dialect-verification`**：静态跨方言+契约检查 → PG 一次性容器 → MySQL JDBC。
  **本机没有 `psql`/`mysql` 客户端**；docker CLI 在 `/Applications/Docker.app/Contents/Resources/bin/docker`；
  JDBC 驱动 `/Users/mxq/Desktop/mysql-connector-j-8.0.33.jar`（Java 17 可用）。
- **真实部署容器 `dataforge-allinone` 常驻运行**（PG 5432 / 服务 8082 / 前端 3000 / DS 12345）——
  验证一律用一次性容器 + 一次性库，收尾必须清理，绝不指向它。
