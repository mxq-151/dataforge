# DataForge 项目长期记忆

> 只放「跨会话必须记住、忘掉就出错」的硬规则。实现细节见 skill `dataforge-project-conventions`
> （注：该 skill 当前不在本机 `~/.workbuddy/skills/`，仅有本文件）；历史过程见 `memory/YYYY-MM-DD.md`。

## 命令与环境（必守）

- **跑 vitest / tsc / vite 一律 `env -u NODE_OPTIONS`**（否则 jsdom 导入从 0.5s 变 96s，CPU ~1% 纯等待）。
- **git 写操作不在本 agent shell 跑**：写入会部分丢弃（`update-ref`/`fetch` 报成功但不落地），
  2026-09-15 11:43 由此写坏过 `.git`。只读命令安全（加 `-c maintenance.auto=false -c gc.auto=0`）。
- **同一文件多处编辑必须串行**（并行 Edit 会互相抹掉）。查并发写者 `find src -mmin -8`。
- macOS：`grep "a\|b"` 静默失败，须 `grep -E`。
- 回归基线：**前端 68 文件 / 1134 例**（2026-10-07 实测；前值 67/1126、67/1117、59/1001 均已过期）。
  负载高（load 7~10）时 `waitFor` 会超时误报，**load 回落即过**。
- **后端编译状态不可信**：10-07 发现 `asset/service/AssetInventoryService.java` L530 有一个多余右括号
  （10-04 遗留），导致 `mvn compile` **整体失败三天**。动后端前先跑一次
  `export JAVA_HOME=/opt/homebrew/opt/openjdk@17; /opt/homebrew/bin/mvn -o -q compile` 确认基线是绿的。
- 后端只跑关心的类（整包 ~5 分钟且含环境依赖失败项）：
  `mvn -o test -Dtest='DqRunApiContractTest,DqRunServiceReportTest,DqRuleApiContractTest,DqRuleRegisterTest,DqTaskServiceScheduleTest,DqOverviewApiContractTest,DqAlertServiceLogTest,QualityRuleTypeContractTest,DqSqlBuilderMatrixTest,AssetCatalogApiContractTest' -DfailIfNoTests=false`；
  实测这 10 个类 **93 例全通过**（2026-10-07）。

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
## 质量链路：智能体产物 ↔ 平台（2026-10-06 核实，写文档必用）

- **关联键是 `rule_name` 字符串，没有外键**。契约链：S2 设计文档「稽核规则清单」5 列表格
  （`规则名|规则类型|校验对象|阈值|处置方式`，提示词明写「S3 禁止改写」）→ `qualityRuleImport.ts`
  解析 + 元数据反查 → `dq_rule.rule_name` → S3 回传 `rule_name` → `dq_rule_result.rule_name`。
  表注释即设计意图：「结果自包含，规则被删后仍可追溯」。
- **两条写入 `dq_rule_result` 的路径，字段填充不同**：
  ①平台执行 `/quality/task/{id}/run` → `startRun`+`executeOneRule` → **有 task_id、有 rule_id、有 exec_sql**；
  ②程序回传 `POST /quality/run/report` → `reportRun` 按 `(batchNo+库+表+当天未结束)` 复用/新建实例
  → **rule_id 与 exec_sql 已于 10-07 补上**（`resolveRuleId`：显式传入优先 → 按「规则名+库+表」三段反查
  → 查不到落 null 且不报错；回传 DTO 增 `ruleId`/`execSql`），**task_id 仍为空**（实例的 taskName 落的是规则名）。
- **五个断点已全部补全（2026-10-07，勿再写成"未闭环"）**：
  1) ~~回传不落 rule_id~~ **已修**：回传 DTO 带 `ruleId`/`execSql`，`reportRun` 落两者；
     未传 ruleId 时按「规则名+库+表」反查回填，查不到落 null 不报错。环比基线（`DqExecutionService`
     按 rule_id 取 metric_value）因此能取到程序回传的数据了；
  2) ~~告警只登记不发送~~ **已修**：渠道语义照界面既有契约落地 ——
     **INBOX 落表即 SENT**（此前一律写 PENDING 是错的）、**WEBHOOK** 按 `alert.webhook.url` 投递
     （成功 SENT / 失败 FAILED+原因）、**EMAIL** 无 SMTP 配置保持 PENDING 并写明原因。
     `sendTime` **只在真正送达时写**。程序回传路径**现在也登记告警**（此前只有平台执行路径会）。
     站内告警箱 `GET /quality/alert/log` + 前端 `AlertLogSection.tsx`；
  3) ~~调度触发缺入口~~ **已修**：`POST /quality/task/{id}/run-by-schedule`（收 scheduleInstanceId / batchNo），
     **只接受 triggerType=SCHEDULE 的任务**（手动任务被调度悄悄驱动等于配置形同虚设）；
  4) ~~回传不做表级权限校验~~ **已修**：`reportRun` 接上 `hasTableReadAccess`，**fail-close**。
     注意它第一道闸是「有没有登录」（`SecurityUtils.getCurrentUserId()`），**单测须先造 SecurityContext**，
     否则测到的是"未登录"分支而非"无权限"分支；
  5) ~~回传运行实例 taskId 为空~~ **已修**：由 `ruleId` 反查 `dq_task_rule_rel`，
     **唯一绑定才认、多绑定不猜**（猜错会让告警发错人），留空时 taskName 退化为规则名。
- **告警记录的两个状态别混**：`status` = **投递状态**（SENT / PENDING / FAILED），
  `checkStatus` = **触发状态**（WARN / ERROR / FAILED）。触发状态**不在告警表里**，
  服务端按 `runId + ruleId`（退化为规则名）回校验结果表取，一次 `in(runIds)` 批量查 ——
  **避免动四方言 DDL**；代价是 SQL 层按严重程度筛不了（要做需给 `dq_alert_log` 加列）。
- **`DATAFORGE_QUALITY_REPORT_TOKEN` 是提示词侧约定，后端不读它**（2026-10-07 核实，勿再写「令牌级鉴权」）：
  该变量在 dataforge-server **零匹配**，只存在于 `opencodeInstructions.ts` 与 api 注释里 ——
  它装的就是用户的 **bearer token**。`SecurityConfig` 为 `.anyRequest().authenticated()`，
  `/quality/run/report`、`/quality/rule/register` 都不在 `permitAll` 名单 ⇒ **需要真实 JWT**。
- **规则登记接口（2026-10-07）**：`POST /quality/rule/register` 幂等登记，返回
  `{ruleId, ruleName, ruleType, templateCode, created, taskId}`。判定键 = **规则名 + 库 + 表**，
  **必须与 `DqRunService.resolveRuleId` 的反查口径逐字一致**（否则「登记到 A、回传匹配到 B」）；
  已存在**不覆盖**（阈值可能已被人手工调过）。
  **可选 `taskId`**（`QualityRuleRegisterDTO`）：登记后幂等写 `dq_task_rule_rel`，
  任务不存在则拒绝 —— 不挂任务的规则在平台里是"孤儿"（不执行、按项目统计看不到、告警订不到）。
  **已知局限**：判定键不含数据源 ⇒ 两数据源下同名库表 + 同名规则会被视为同一条；改判定键须同时改回传反查。
  `GET /quality/rule` 已加 `ruleName` **精确**过滤。`RuleTab` 的「导入设计文档」仍走 `createRule`（未切登记，
  属产品语义变更待定）。
- **登记 ≠ 挂任务**（2026-10-07 核实，写流程必讲）：`register` 只 `dq_ruleMapper.insert`，
  **不写 `dq_task_rule_rel`**。所以登记进来的规则：进平台、能拿 ruleId、**不带项目口径时计入覆盖率**
  （分母 = `table_metadata` 表总数去重库.表），但 **平台不会执行它**（`/task/{id}/run` 要任务绑定）、
  **按项目统计看不到它**（`DqOverviewService.scopedRuleIds` 走 `dq_task_rule_rel`→taskIds）、
  **告警订阅订不到它**（按 taskId 订阅）。要让平台自己跑，必须另在「质检任务」页签挂载。
- **规则的两种来源**：①界面「导入设计文档」→ `createRule`（人工确认后新建）；②S3 程序 `POST /quality/rule/register`（幂等登记）。两条路都只建规则，**挂任务都要单独做**。
- **质检实际执行的两条路**：①S3 生成的独立质检任务在调度上跑，算完回传（主路径）；
  ②平台自己执行任务挂载的规则（`/quality/task/{id}/run`，用模板渲染 SQL 走 `CodeExecutionService`）。
  后者 task_id/rule_id/exec_sql 齐全，适合模板能完整表达的规则。
- **规则模板已按「中间档」下发（10-07）**：`opencodeInstructions.ts::buildQualityTemplateSpec()` 把平台模板
  （templateCode + ruleType + SQL 骨架 + 参数）拼进**仅数据开发（S3）**的提示词；`getDeveloperInstructions`
  第 4 参传模板，`useOpencodeChat` 发消息前拉取（模块级缓存 + in-flight 去重，失败降级空数组且**空结果不写缓存**）。
  **注意**：`DqRuleService.bindTemplate`（L381）本来就有「规则类型 → 内置模板自动绑定」，别重复实现。
  **坑**：SQL 骨架含 `${占位符}`，不能用 TS 模板字符串拼（会被当插值吃掉），必须数组 + 字符串拼接。
- S3 回传约定：地址/令牌走环境变量 `DATAFORGE_QUALITY_REPORT_URL` / `DATAFORGE_QUALITY_REPORT_TOKEN`，
  禁止硬编码；**回传失败不得改变校验任务成败判定**；回传与校验写在同一任务内，不为回传单独建调度节点。
- 「阻断下游」的既有约定是「独立质检任务挂处理任务下游（失败即非零退出）」，平台**不反向改写调度状态**。

- ~~质量侧现状 = 半条链路~~ **已过期，勿再引用**。2026-10-06 复核：服务端已补齐
  `DqRule` / `DqRuleTemplate` / `DqTask` / `DqRun` / `DqOverview` 五个控制器（均真实实现），
  桌面端 `views/data-quality/` 已有六页签 UI（大盘 / 规则配置 / 规则模板 / 质检任务 / 运行记录 / 告警订阅）；
  `/quality/check-result/*` 降级为保留兼容的遗留端点。旧说法「无规则/模板/任务/告警，桌面端零 UI」作废。
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

## 资产 / 质量 接口接线（2026-10-06 已补全，勿回退）

- **现状：资产 31/31、质量 25/26 已接线**。唯一未接线是 `POST /quality/run/report`（供 S3 程序回传，
  非界面调用）；`/asset/task/*/run` ×3 与 `/quality/check-result/*` ×6 属内部/遗留端点。
- **后端零 LLM、也不落后**：两边路径**全部**对得上且是真实实现，**不存在「前端调了后端没写」**。
  缺口从来只在前端 UI，别看到空态就以为要写后端。
- **资产模块文件分工（新）**：`AssetCatalogPanel.tsx` = 目录树 + 检索 + 收藏 + 治理项三视图编排；
  `AssetDetailTabs.tsx` = 详情 9 页签（概览由宿主注入，其余各自探各自的口）；
  `AssetGovernanceEditor.tsx` = 负责人/分类/标签/刷新元数据四个写操作；
  `useProbe.ts` = 共用探测钩子（AssetOverviewTab 已改为引用它，别再各写一份）。
- **`useProbe` 必须写成 `Promise.resolve().then(loader)`**，否则 loader **同步抛错**（接口封装缺失、
  mock 未定义方法）会在 effect 里冒泡成渲染错误而不是降级为 unavailable。
- **埋点只上报有具体资产的动作**（选中表=browse / 预览=read / 新增收藏=bookmark）。
  服务端 `recordAccess` 对 `assetId == null` 直接 `continue`，所以「检索」这个无资产动作**故意不上报**，
  避免写 `assetId=0` 脏数据。别为了凑 accessType 把 query 补上。
- **分类/标签字典不可用时降级为只读，不放开自由文本**（否则写入服务端不认识的编码）；
  标签接口是**整体替换**（提交最终集合）。写成功后由宿主**重拉详情**，不本地推测
  （`categoryCode` 清空后服务端会按表名重解析分层/业务域）；只有 `updateLifecycle` 沿用就地回填。
- 质量侧「规则模板」页签已从本地契约静态渲染改为真接口（`TemplateTab.tsx`：内置只读 + 自定义 CRUD +
  `preview-sql`）；**模板校验前置对齐服务端**：单条 SELECT/WITH、必须归属 7 类之一、编码/名称非空；
  内置模板服务端 `assertCustom` 拒绝改删，界面也不给入口。`preview-sql` 必须选目标表才渲染得出方言 SQL。
- **改模块级 mock 要连坐**：`AssetCatalogPanel.lifecycle.test.tsx` 用 `vi.mock` 整体替换
  `api/assetCatalog`，**面板新调一个方法就必须在该 mock 里补上**，否则未定义方法调用会炸。
- 核查/复核手法（可复用）：后端 `grep -nE "@(Rest)?Controller|@GetMapping|@PostMapping|@PutMapping|@DeleteMapping"`；
  前端封装方法名在 `src/` 全量 grep 调用点。**注意**：① zsh 不做默认分词，循环要写数组
  `for m in $array`；② 文件名加 `--include` 会报 no matches，用 `grep -rl` 或 Grep 工具；
  ③ 调用拆成多行时（`assetCatalogApi\n  .getCatalogTree(...)`）单行正则会漏，须另查 `\.方法名\(`。

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
