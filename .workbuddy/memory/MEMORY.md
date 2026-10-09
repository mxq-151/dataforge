# DataForge 项目长期记忆

> 只放「跨会话必须记住、忘掉就出错」的硬规则。历史过程见 `memory/YYYY-MM-DD.md`。

## 命令与环境（必守）

- **跑 vitest / tsc / vite 一律 `env -u NODE_OPTIONS`**（否则 jsdom 导入从 0.5s 变 96s，CPU ~1% 纯等待）。
- **git 写操作不在本 agent shell 跑**：写入会部分丢弃（`update-ref`/`fetch` 报成功但不落地），
  2026-09-15 11:43 由此写坏过 `.git`。只读命令安全（`dataforge`、`dataforge-server` 都是独立 git 仓库）。
- **同一文件多处编辑必须串行**（并行 Edit 会互相抹掉）。查并发写者 `find src -mmin -8`。
- macOS：`grep "a\|b"` 静默失败，须 `grep -E`；文件名加 `--include` 在 zsh 报 no matches，改用 Grep 工具。
- **回归基线（2026-10-09 实测，替代一切旧值）**：前端 **65 文件 / 1090 例**（改动前 66 文件，删了 1 个测试文件）；
  后端关心类 **74 例全通过**。负载高（load 7~10）时 `waitFor` 会超时误报，load 回落即过。
- 动后端前先跑 `export JAVA_HOME=/opt/homebrew/opt/openjdk@17; /opt/homebrew/bin/mvn -o -q compile`
  确认基线是绿的（曾被 `AssetInventoryService.java` 一个多余右括号拖垮三天）。
- 后端只跑关心的类（整包 ~5 分钟且含环境依赖失败项）：
  `mvn -o test -Dtest='DqRuleApiContractTest,DqResultServiceReportTest,DqRuleRegisterTest,DqOverviewApiContractTest,QualityRuleTypeContractTest,DqSqlBuilderMatrixTest,AssetCatalogApiContractTest' -DfailIfNoTests=false`
- mvn 在沙箱里会因无法删除 `target/surefire*` 临时目录而报「命令被拦截」——**看 `BUILD SUCCESS` 与
  `Tests run: N, Failures: 0` 判定结果**，别把沙箱告警当测试失败。

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
- **x6 画布在 jsdom 下不可渲染**：测编辑器内部交互只 mock `../dag/DagCanvas`；含 `useToast` 须包 `ToastProvider`。
- 提示词类 UI 不用原生 `title`（延迟 0.5~1s），改零延迟自定义 tooltip，面板内用 `position:fixed`。
- 流式文本逐字增长不进 `messages`（走 ref + `subscribePartText`）。
- 开发助手切任务类型**不新建会话**（system 逐轮下发）；**数据探索例外**——其 `newSession()`
  同时承担「新建时间戳工作目录」，不能照搬改法。

## 删除 / 回滚闸门

- 一切删除/回滚先过纯函数 `rollbackSafety.ts::assessRollbackSafety`；`root=null` 一律中止。
- 删除**走回收站**（`.dataforge-trash/` + manifest，须对 git 隐身），禁止直删。
- 保留策略 30 天 / 50 批 / 2 GiB（最新 2 批不清理），决策在 `trashRetention.ts`，执行在 `trashCleanup.ts`。
  **新增「移入回收站」入口必须接 `scheduleTrashRetention`**。回收站≠备份。

## 写文档前的事实核查基线（勿凭印象）

- **血缘与调度是桌面端直连上游**（`src/api/marquez.ts`、`dolphinscheduler.ts`），服务端无 Marquez 客户端、
  也不存产出任务副本（权威在 Marquez / DolphinScheduler）。
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
- **资产分类不人工维护**：表名规范 `{分层}_{业务域}_{实体描述}_{刷新周期}` ⇒ 分层与业务域可确定性解析，
  解析失败即「未分类」且自动成为治理项。
- **两条安全闸门**：校验 SQL 下发前必须过 `SqlPermissionRewriter`；资产目录的树/检索/详情必须服务端
  fail-close 过滤 `sys_table_permission`（含列级）。
- **改一级菜单必查三连锁**：① `ActiveTab` / `MENU_CODE_MAP` / `App.tsx::FIRST_LEVEL_TAB_IDS` 同批改；
  ② `FIRST_LEVEL_MENU_CODES` 由 MENU_CODE_MAP 派生；③ **菜单种子只在 `sql/testdata/*.sql`**。

## 平台定位与商业模式（对外叙事必守）

- 核心目标：**让智能体正确理解业务数据**。四大核心组件 = dataforge（规范开发环境）、
  dataforge-server（库表+指标描述）、Marquez（血缘）、DolphinScheduler（任务依赖）。
  **listener 类组件是治理增强、可插拔，别抬高。**
- **核心差异（2026-09-15 用户定调，写文档必讲）**：DataForge 类似 opencode / WorkBuddy 这类 AI 编程
  助手，但**提需求的人不同**——编程助手是开发者提需求，DataForge 是**业务方提需求**（不懂 SQL）；
  ≠ 编程助手，也 ≠ DataWorks（业务方在平台外提、由开发者转述）。
  ⇒ 这正是**数据代开发服务**成立的技术基础。
- **软件在企业内部免费、代码闭源**；收益 = 数据开发服务 + 集群运维服务。
- 五类上下文信息：规范开发环境 / 库表描述 / 指标描述 / 血缘 / 任务依赖。

## 需求驱动的闭环（核心优势）

- 六角色含**业务需求方**与**数据架构师**；开发助手任务类型即角色：需求编写(BUSINESS_REQUESTER)
  → 数仓设计(DATA_ARCHITECT) → 数据开发(DATA_DEV_ENGINEER)（数据探索是另一套）。
- 三段产物同名贯穿，契约唯一来源 `src/hooks/opencode/opencodeInstructions.ts`；**指标是唯一主线**，
  另有四条同源线：数据时效 / 数据源名称 / 数据质量 / 敏感数据。
- `TaskRecord` 不记任务类型；`AIPanel.tsx:145` 的 `handleTaskTypeChange` 当前主动 `newSession()`。

## AI 能力落点（标状态前必看）

- **推理在客户端**本地 sidecar（opencode，127.0.0.1:4096），模型与密钥用户自配；**服务端零 LLM 调用**。
- **已落地**：6 个工具组（compile / indicator-query / knowledge-document / lineage / metadata-agent /
  sql-validate）、元数据代理 `/metadata/agent/*`。
- **规划中**：自动化问题排障、数据价值评估、知识检索增强（当前是 MyBatis-Plus `like`，无向量库）。
- **不做的**：服务端统一推理入口（2026-09-14 已决策）。
- 别整条一刀切标状态：一个目标常是「一半已落地 + 一半规划」。

## 数据质量模块（2026-10-09 大改，必读）

- **只剩 3 个页签**：质量大盘 / 规则配置 / 规则模板。**质检任务、运行记录、告警订阅已彻底删除** ——
  前端组件（TaskTab / AlertTab / AlertLogSection）、服务端 controller+service+entity+mapper+vo+dto、
  五张表 DDL（`dq_task` / `dq_task_rule_rel` / `dq_run_instance` / `dq_alert_log` / `dq_alert_subscription`）、
  提示词里的 taskId 与告警描述、`App.tsx` 给质量面板注入的 DS Provider 全部移除。
- **`dq_rule_result` 保留为「结果留痕」**：去掉 `run_id`（及其索引），新增
  `batch_no` / `check_record_count` / `fail_record_count`；索引 `idx_dq_result_rule|status|batch|time`。
  **它现在只有两个消费者，改它必看这两处**：
  ① `DqExecutionService.resolveBaseline`（行数波动/环比的试跑基线，按 rule_id 取 metric_value）；
  ② `AssetCatalogService.quality()`（资产详情「数据质量」页签摘要，改为按规则取最近一条结果 + 同日归集，
     状态仍只有 SUCCESS / FAILED 两档，红色异常由 errorCount 单独体现）。
- **回传入口 `POST /quality/run/report` 保留**（路径刻意不变，避免已部署环境的
  `DATAFORGE_QUALITY_REPORT_URL` 失效），但实现换成轻量 `DqResultService`：
  解析 ruleId（显式优先 → 「规则名+库+表」三段反查 → 查不到落 null 不报错）→ **表级读权限 fail-close**
  → 落一行 `dq_rule_result`。不再有运行实例合并、任务归属、告警登记。DTO 改名 `QualityResultReportDTO`
  （字段集合原样保留，回传契约不受影响）。
  单测 `DqResultServiceReportTest`：**非管理员用例必须先造 SecurityContext**，否则测到的是「未登录」分支。
- **质量大盘**去掉 `passRateTrend` / `blockCount`（数据源随运行实例消失），`projectCode` 入参移除
  （项目归属原先只能由质检任务推导）；`topProblemTables` 改为直接聚合 `dq_rule_result` 时间窗。
- **规则登记**不再有 `taskId`；`QualityRuleRegisterDTO` 已删（直接用 `QualityRuleSaveDTO`）；
  `QualityRuleRegisterVO` 去掉 `taskId`。判定键仍是「规则名 + 库 + 表」，与回传反查口径必须逐字一致。
- **7 类规则类型契约不变**：`types/quality.ts::QUALITY_RULE_TYPES` ↔ SQL 种子 ↔ 提示词三方逐字一致，
  `template_code == rule_type`。S1/S2/S3 三方提示词、`qualityContract.test.ts`、`df_sql_check.py` 都在守它。
- **模板下发不变**：`buildQualityTemplateSpec()` 仅拼进 S3 提示词，`useOpencodeChat` 发消息前拉取
  （模块级缓存 + in-flight 去重，**空结果不写缓存**）。`DqRuleService.bindTemplate` 已有「规则类型 → 内置模板
  自动绑定」，别重复实现。**坑**：SQL 骨架含 `${}`，不能用 TS 模板字符串拼，必须数组 + 字符串拼接。
- 「阻断下游」的既有约定：独立质量校验任务挂处理任务下游，**失败即非零退出**，平台**不反向改写调度状态**。

## 资产目录接口接线（勿回退）

- **后端零 LLM、也不落后**：前后端路径全部对得上且是真实实现，**不存在「前端调了后端没写」**；
  缺口从来只在前端 UI。
- **文件分工**：`AssetCatalogPanel.tsx` = 目录树 + 检索 + 收藏 + 治理项三视图编排；
  `AssetDetailTabs.tsx` = 详情页签；`AssetGovernanceEditor.tsx` = 负责人/分类/标签/刷新元数据四个写操作；
  `useProbe.ts` = 共用探测钩子。
- **`useProbe` 必须写成 `Promise.resolve().then(loader)`**，否则 loader 同步抛错会在 effect 里冒泡成渲染错误。
- **埋点只上报有具体资产的动作**（选中表=browse / 预览=read / 新增收藏=bookmark）；服务端对 `assetId == null`
  直接 `continue`，「检索」故意不上报，别为凑 accessType 补 query。
- **分类/标签字典不可用时降级为只读**；标签接口是**整体替换**；写成功后由宿主**重拉详情**，
  只有 `updateLifecycle` 沿用就地回填。
- **改模块级 mock 要连坐**：`AssetCatalogPanel.lifecycle.test.tsx` 用 `vi.mock` 整体替换 `api/assetCatalog`，
  面板新调一个方法就必须在该 mock 里补上。

## 数据库脚本与方言（改 schema 必读）

- **无迁移阶段（2026-10-09 用户决定）**：`sql/migrate/` 目录、`df_gen_mysql_migrate.py` 生成器，
   以及校验脚本里所有 migrate 回退/幂等/等价性步骤**已整体删除** —— 项目在开发阶段，
   新库直接建、开发库直接重建，**`init/*.sql` 是 schema 的唯一来源**。
   连带解决了历史包袱：migrate 里残留的 `deleted` 列（早前"全表移除 deleted"时没跟着改）
   与 batch1 引用 `sys_role.deleted` 导致老库必失败的问题，都随之消失。
- schema **手写维护**在 `dataforge-server/src/main/resources/sql/`，**无 Flyway**。四方言 init 各 **41 表**
   （2026-10-09）。改动顺序：`init/` 四方言 → `testdata/`（仅当涉及菜单/角色/授权）。
- **真目标只有两个**：PostgreSQL 14（docker 部署）、MySQL（本地开发，实测 9.6）。
   **MariaDB / H2 在 pom.xml 里连驱动都没有**，属"保持平行"的文档级脚本（MariaDB 在 MySQL 上做语法冒烟）。
- **四方言结构一致**（不变量）：同一张表在四份 init 里列名/列序一致、类型跨方言等价。
- **参考数据放 init，菜单放 testdata**：7 类规则模板 / 7 个分层分类 / 4 个默认资产标签必须进 `init/*.sql`；
   菜单与授权只在 `testdata/dataforge-testdata-postgresql.sql`（init 只建菜单表结构）。
   部署脚本 `init-dataforge.sh` 用 `ON_ERROR_STOP=0`（吞错误），验证时务必改 `1`。
- **InnoDB 索引键上限 3072 字节**（utf8mb4 每字符 4 字节）：`varchar(1024)` 建索引会**整张表建不出来**。
- **验证两层**见 skill **`dataforge-sql-dialect-verification`**（脚本在
   `~/.workbuddy/skills/dataforge-sql-dialect-verification/scripts/`）：`df_sql_check.py`（静态，
   已改为「全表比对」，不再有 migrate 概念）→ `verify_pg.sh` / `verify_mysql.sh`（真库执行 init+testdata）。
   **本机没有 `psql`/`mysql` 客户端**；docker CLI 在 `/Applications/Docker.app/Contents/Resources/bin/docker`；
   JDBC 驱动 `/Users/mxq/Desktop/mysql-connector-j-8.0.33.jar`。
   **改完 SQL 必须重新切分再验证**（`df_split_sql.py` 的输出是缓存的，拿旧切分文件验证会得到假结论；
   `verify_*.sh` 现在会自己强制重切）。断言里别写死数量，由 init 动态解析或取下界。
- ⚠️ **静态检查里有 10 处存量跨方言类型差异**（登记在 `df_sql_check.py` 顶部的
   `KNOWN_DIALECT_DIFFS`，以提示形式输出不报错）：其中 `indicators.code`（PG varchar(1024) vs
   MySQL varchar(100)）与 `indicators.id`（bigint vs int）是**真实漂移**，属独立修复任务；
   其余是方言表达差异（smallint(1) 表布尔、MariaDB 用 clob 承载 JSON 等）。
- **真实部署容器 `dataforge-allinone` 常驻运行**（PG 5432 / 服务 8082 / 前端 3000 / DS 12345）——
   验证只用一次性库（`df_sqlcheck_*`），收尾必须清理，绝不指向它。
- ⚠️ **bash 陷阱**：`$VAR` 紧跟中文/全角标点会被并进变量名（`set -u` 下直接报 unbound variable 中断），
   一律写 `${VAR}`。自查正则：`\$(\w+)(?=[^\x00-\x7F])`。

## 交付偏好

- 性能类任务**诊断驱动**，先量化再改。交付含量化对比、变更表、决策理由、未改动项清单，附
  `tsc --noEmit` 与 vitest 计数，新增逻辑配套单测。
- **计划书不出 Word**（2026-09-15 用户明确）：`output/<request_id>/` 最终交付物是 `stage3/…html`，
  stage2 HTML 是中间产物，内容源 `stage1/final_draft.md`。
- **计划书不设「风险识别与应对」章节**。现行结构 = 一 概述 / 二 需求 / 三 架构 / 四 组件 /
  五 模块优先级 / 六 推广与时间 / 七 验收质量 / 八 预期效益 / 九 附录：现状基线。
  真实残留边界留在本文「事实核查基线」里，别写回文档。
- 生成脚本：`.workbuddy/memory/pipeline-scripts/` 里的是**旧版**（硬编码 Mac 路径）；
  **可用版在 `output/45d4b135-…/tools/`**（`df_md.py` + `df_gen_stage2.py` / `df_make_web.py` + css）。
  渲染规则与校验手法见 `memory/2026-09-15.md` 18:10 那条。
- **表格列名必须短（≤ 约 12 视觉字符）**：`web.css` / `stage2.css` 的 `thead th` 是 `white-space:nowrap`，
  长表头会撑宽整张表（主区可用宽 ≈ 790px）。带枚举的列名一律拆成「短列名 + 导语里一句说明」。
- **对照表按"一项能力一行"组织，能力项与非能力项分表**：能力表 = 数据集成 / 数据治理 / 开发环境 /
  作业调度 / 数据血缘 / 权限管理 / 任务管理 / 指标管理 / 知识管理（+ AI 能力落点）；
  形态与部署 / 引擎兼容 / 角色模型 / 设计取向 / 收费模式属"比较坐标"，另列一表。
