# DataForge 项目长期记忆

> 这里只放「跨会话必须记住、忘掉就会出错」的硬规则。**实现细节、函数名、行号、踩坑过程**见 skill
> `dataforge-project-conventions`；历史过程见 `.workbuddy/memory/YYYY-MM-DD.md`。别把细节往本文件里塞
> —— 超过注入上限会被截断。

## 命令与环境（必守）

- **跑 vitest / tsc / vite 一律 `env -u NODE_OPTIONS`**（agent shell 的 broker fs shim 会让 jsdom 导入从
  0.5s 变 96s，指纹是 CPU ~1% 纯等待）。用户自己的 Terminal 无此注入。
- **git 写操作不要在本 agent shell 里跑**：本 shell 对 `.git` 的写入会部分丢弃 —— `git update-ref` / `git fetch`
  报成功（退出码 0、输出正常）但 `refs/` 下文件不落地，新建的 `refs/` 子目录也会消失；仅直写
  `echo <sha> > .git/refs/...` 能落地。2026-09-15 11:43 由此写坏过仓库（`refs/` 与 `objects/pack/*.pack`
  消失、残留 16 个空对象目录）。只读命令安全（建议加 `-c maintenance.auto=false -c gc.auto=0`）；
  写操作交用户 Terminal。诊断与恢复过程见 `memory/2026-09-15.md`。
- **同一文件的多处编辑必须串行**：并行两个 `Edit` 各基于旧快照写回全文件，后写者静默抹掉先写者。
  查并发写者 `find src -mmin -8`。
- macOS 陷阱：`grep "a\|b"` 会静默失败，须 `grep -E`。
- 回归基线（2026-09-15 全量）：**59 文件 / 1001 例**（当日演进 54/905 → 56/969 → 57/978 → 59/1001）。
  已含 `electron/**` 用例，用 `// @vitest-environment node` 声明环境（vitest `include` 已覆盖，
  `tsconfig.node.json` 已 exclude 测试文件）。
  已知负载误报只剩 `textmateFix` 的 J)（单独复跑即过）；`FolderSubmitScheduleModal` 的「外部 @依赖」超时
  **已定位并修掉**（编辑器 key 含节点数，依赖节点到达会 remount，测试点到已卸载按钮 —— 见 skill 第 6 节）。
- 测试大面积失败先看 load：load≈7~10 时 `waitFor` 会超时误报，**load 回落即过**。
- **`git` 在 agent shell 里可能整段不可用**（`fatal: not a git repository`，指纹是第一条命令能用、
  之后的就报错）：别用 `git stash` 做对照实验，改用「临时改回代码 + 复跑」。

## 模型上下文窗口

- `deepseek-flash` = DeepSeek **V4.1** Flash，**1M 窗口**。判定里没有 `v3`/`v4` 字样，**只能显式列出**，
  否则掉进泛化 `deepseek` → 128k（曾致进度条 142%）。DeepSeek V4 系一律 **1_000_000**，别写 1_048_576。
- `GET /api/model` **必须带 location**；**冷实例首次查询返回 `200 + data: []`**（自愈）⇒ 必须重试，
  不能查一次就回落硬编码。**改模型判定必须同步单测。**
- **sidecar 由 app 托管，应用一关端口就拒连**（502/refused 属正常，不是故障）。

## 任务类型 / 会话上下文

- **系统指令逐轮下发（`session.prompt` 的 `body.system`），不固化在会话里**；每条用户消息存自己那轮的
  system 快照。因此「中途换任务类型而不丢上下文」在机制上可行。
- 但**当前 `AIPanel.tsx:145-149 handleTaskTypeChange` 主动 `newSession()`** ⇒ 上下文被丢弃。
  `resetState` **只清本地、不删服务端会话**，旧对话仍在任务历史里可切回。
- 切类型**只换 `system` 文本、不传 `agent`** ⇒ 工具集与审批策略不随类型变。
- `TaskRecord` **不记任务类型** ⇒ 要做「同会话换角色」必须补类型标记，否则历史不可辨。
- 数据探索的类型切换**绑定「新建时间戳工作目录」**（会话=标签页），不能照搬开发助手的改法。

## 编码约定

- **提示词类 UI 不用原生 `title`**（悬停延迟 0.5~1s），改 hover 零延迟自定义 tooltip；面板内需
  `position:fixed`（`.ai-panel{overflow:hidden}` 会裁剪绝对定位）。仍未改造：`AIPanel` 头部「压缩」按钮。
- 「运行程序」**必须先弹 `ProgramRunModal` 确认参数**；参数是**键值对逐行编辑**，语义
  **所见即所发**（整体替换已保存配置，不回写落库，删光即不带参数）。
- 代码头参数字段共**三个**：`@程序参数`（业务入参）/ `@资源参数`（资源诉求）/ `@任务参数`（提交与引擎侧参数）。
  **取值是真实值**，有两个消费面：①「运行程序」弹窗**只取参数名**预填（`extractProgramParams`）；
  ②「提交调度」把**取值**落进任务节点 `taskParams`（`headerTaskParams.ts`，代码头优先级最高）。
  改字段名/语义须同步：S3 提示词 → `parseFileHeader` → `HEADER_FIELDS` → `extractProgramParams` /
  `headerTaskParams` → `PendingProgramRun` → `ProgramRunModal` + `SubmitToSchedulerModal` → 6 个测试文件。
  调度侧的「任务参数」是 DolphinScheduler 概念，**别跟着改**。
- 工作流名称**不 sanitize**、环境后缀**默认 test**；**`_v{N}` 版本链已整体删除**（重复提交会新建）。
- `mainJar` 是编译派生值，**不要加必填校验**（会让文件夹路径无法保存）。
- 工作流保存有闸门；**表单加必填项必须同步 `REQUIRED_PARAMS` 与单测**。
- **x6 画布在 jsdom 下不可渲染**：测编辑器内部交互就**只 mock `../dag/DagCanvas`**；渲染含 `useToast` 的
  编辑器必须包 `ToastProvider`。
- 流式文本逐字增长**不进 `messages`**（走 ref + `subscribePartText`），只首次上屏写 `messages`。

## 删除 / 回滚安全闸门（2026-09-13 事故后）

- **事故**：`handleRollback` 拿到空快照（`root=null`）把「待删除集合」放大成全部现存文件，直删了
  test_project 的 71 个已提交文件。
- 一切删除/回滚必须先过纯函数 `rollbackSafety.ts::assessRollbackSafety`；`root=null` 的快照一律中止。
- 删除**走回收站**（`.dataforge-trash/` + `_manifest.json`），禁止 `fs.remove` 直删；
  回收站**必须对 git 隐身**（否则自动同步静默失效）。
- 回收站有保留策略（默认 30 天 / 50 批 / 2 GiB，最新 2 批永不清理；决策在纯函数
  `src/utils/trashRetention.ts`，执行在 `trashCleanup.ts`，5s 合并窗口）。
  **新增「移入回收站」的入口必须接上 `scheduleTrashRetention`**，否则回收站无限增长。
  回收站是误删缓冲、不是备份 —— 对外叙事别混。
- **快照结构新增字段必须同步单测。**

## 写计划书/方案前的事实核查基线（2026-09-15 实测，勿凭印象写）

- **血缘与调度是桌面端直连上游**，不经服务端中转：`src/api/marquez.ts`、`src/api/dolphinscheduler.ts`，
  地址在客户端设置项；**服务端没有 Marquez 客户端**。OpenLineage 传输参数由提交 Spark 任务时注入
  （`SubmitToSchedulerModal` 取 `lineage.transportUrl`）；服务端构建 spark-submit 时会**剔除**业务侧
  自带的 `openlineage*` / `lineage.enabled` 配置。
- **租户不是数据隔离边界**：`sys_tenant_user` 对 `tenant_id` 与 `user_id` 各加了单列唯一约束
  （租户 ↔ 用户 1:1）；`datasource_config` / `storage_config` / `dev_project` / 各权限表**都没有 tenant_id**，
  租户只影响角色绑定与审计日志。写"多租户隔离"前先想清楚这句话站不站得住。
- **权限校验（2026-09-15 下午已加固，勿再照抄上午的旧描述）**：DML 权限检查改为 **fail-close**
  （解析失败 / 判定异常一律拒绝，不再"放行执行"）；行/列权限合并由"取并集放宽"改为**取交集收紧**；
  行/列约束改在 **SQL 下发前改写**（行条件并入 WHERE、投影列裁剪，`SqlPermissionRewriter`），
  Spark/Flink/HBase 三条策略已 `extends AbstractBaseExecutionStrategy`，与 JDBC/Kyuubi 一致。
  **仍是真实边界**：① 租户不是数据隔离边界（见上条）；② 权限约束**只覆盖 SQL 代码类型**，
  Scala/Python/Jar 等任意代码访问数据源的不享有行/列约束；③ `ROLE_SUPER_ADMIN` 仍短路所有检查。
- **列级脱敏是真实机制（2026-09-15 核实，此前记忆漏记）**：脱敏档位 `full / idcard / phone / email /
  partial`，多角色命中时按列**取更严格者合并**（`DataAccessPermissionService.mergeDataMaskingRule`）；
  `MetadataAgentController` 会把 `maskingType` 交给智能体，`full` 字段不可读、有脱敏规则的字段不可写
  ⇒ **脱敏对智能体同样生效**。但**无敏感数据自动识别与分级分类**，规则全靠人工在权限里指定。
- **凭据落盘已加密（2026-09-15 起，此前是明文）**：`userData/df-stores/*.json` 的敏感字段经
  Electron `safeStorage` 包成 `{"$dfenc":"v1","v":"…"}` 信封，咽喉只有 `electron/backend/store.ts`
  一处；旧明文文件读时兼容、写时自动升级。**别再把「凭据明文落盘」写成现状**。
  残留真实缺口：密钥在设置页需明文回填（截图可带走）；无 keyring 的 Linux 降级为明文；
  换机器/重置钥匙串后信封解不开、按「未配置」处理。导出配置走 `df:store:export`，
  在主进程侧剥离凭据（值 `***`）。服务端的数据源与租户密码仍是 AES。
- **元数据缺失已可观测（2026-09-15 起）**：`MetadataAnnotationGapService` + `GET /metadata/annotation-gaps`
  输出未标注表 / 字段清单；`MetadataSyncAlertService` 把同步失败写成审计日志
  （`module=metadata`、`operation=METADATA_SYNC_FAILED`）并打 `[METADATA-SYNC-ALERT]` ERROR 日志。
  ⇒「同步失败只 warn、元数据静默滞后」已不成立，勿再照抄。
- **提交有环境维度（2026-09-15 起）**：三档 `prod / gray / test`（默认 test、不记忆），环境后缀拼进
  工作流名（`withDeployEnvSuffix`）；**血缘只在 prod 注入**，是硬闸门
  （`deployEnv.ts::shouldInjectLineage`），非生产环境即使文件写 `lineage.enabled=true` 也不翻盘；
  OpenLineage 参数唯一拼装处 `src/utils/lineageParams.ts`（单文件 / 文件夹两个提交入口共用——
  此前文件夹入口整条漏注入，生产批量提交出来的 Spark 任务没有血缘，已修）。

## 需求驱动的开发闭环（对外叙事，用户认定的核心优势）

- **业务需求方是平台一级角色**：服务端 `RoleType` 六角色 = 超级管理员 / 运维工程师 / 数据开发工程师 /
  **业务需求方** / 数据分析师 / **数据架构师**；开发助手的任务类型即角色：
  **需求编写（BUSINESS_REQUESTER）→ 数仓设计（DATA_ARCHITECT）→ 数据开发（DATA_DEV_ENGINEER）**
  （数据探索模块是另一套：数据分析 / 运维管理）。
- **三段产物同名贯穿**：`docs/{业务名称}_开发需求.md` → `docs/{业务名称}_数仓设计.md` +
  `ddls/{分层}_ddl.sql` → `{语言}/{分层}/{程序文件}` + 调度任务。
- **契约唯一来源**：`src/hooks/opencode/opencodeInstructions.ts`（S1/S2/S3 三方共享契约常量）。
  **指标是唯一主线**（S1 定义"要算什么" → S2 分配编码并绑定字段 → S3 按编码实现）；
  另有四条端到端同源线：**数据时效 / 数据源名称 / 数据质量 / 敏感数据**（降级必须显式说明）。
- **开发助手内切换任务类型不新建会话**（system 逐轮下发，新角色下一轮生效、上下文与工具结果保留）；
  **数据探索例外**——该模块的 `newSession()` 同时承担"新建时间戳工作目录"，不能去掉。
  ⇒ 写文档时别把两者混为一谈。

## 交付偏好

- 性能类任务**诊断驱动**：先量化定位再改，不接受凭猜测优化。
- 交付含**量化对比**、变更表、决策理由、**未改动项清单**；改动附 `tsc --noEmit` 与 `vitest` 计数，
  新增逻辑配套单测（尤其纯函数分支边界）。
- **计划书类交付不再出 Word（2026-09-15 用户明确）**：`output/<request_id>/` 的最终交付物是
  `stage3/…html`（网页版）；不再跑 html-to-docx，也不再走 editor_sdk 改 docx。
  内容源仍维护 `stage1/final_draft.md`，`stage2/…html` 保留（网页版由它生成），只是不转 docx。
- **计划书不再设「风险识别与应对」章节（2026-09-15 用户明确）**：用户判断其中多数条目属"如此设计"
  （设计选择而非待处理风险）。现行结构 = 一 概述 / 二 需求 / 三 架构 / 四 组件 / 五 模块优先级 /
  六 推广与时间 / **七 验收与质量保障** / **八 预期效益** / **九 附录：现状基线**。
  重生成前确认 `df_gen_stage2.py` 的 LEADIN 键是「七 / 九」、附录判定是 `startswith("九、附录")`。
  真正的残留边界（权限、血缘、凭据）留在本文件「事实核查基线」里，不要重新写回文档。

## 平台定位（对外叙事，写文档/计划书时必守）

- 平台核心目标是**让智能体正确理解业务数据**。
- **四大核心组件**：dataforge（规范开发环境）、dataforge-server（库表描述 + 指标描述）、
  Marquez（数据血缘）、DolphinScheduler（任务依赖）。
- **spark-listener / flink-listener 是治理增强，可插拔、非核心**——不要在叙事里抬得太高。
- 智能体理解业务数据的**五类信息**：规范开发环境、库表描述、指标描述、血缘、任务依赖。
- 一句话：规范环境保证信息源头无歧义；库表+指标回答"是什么"；血缘回答"从哪来到哪去"；
  任务依赖回答"何时、依赖什么产出"。

## 商业模式（对外叙事，必守）

- **软件在企业内部免费使用，代码不开源（闭源）。**
- **收益来源 = 数据开发服务 + 集群运维服务**（"软件免费、服务收费"，软件是获客载体、服务是收益）。

## AI 能力落点（写文档/标状态前必看，别误判）

- **推理在客户端**：桌面端本地 sidecar（opencode，`127.0.0.1:4096`），模型与密钥由用户自配；
  **服务端零 LLM 调用**（全 Java 源码搜 openai/deepseek/apiKey/chatCompletion/llm 无实质命中）。
- **业务能力 = 6 个工具组**，嵌在 `~/Desktop/opencode/packages/opencode/src/tool/`：
  `compile` / `indicator-query` / `knowledge-document` / `lineage` / `metadata-agent` / `sql-validate`，
  通过 REST 调平台接口（如 `/api/metadata/indicators/list`、`/api/knowledge/document/list`）。**已落地**。
- **元数据代理** `/metadata/agent/{tables,table-detail,search,indicators}` 已落地，是服务端给智能体喂上下文的接口。
- **未落地**：仅**知识检索增强**——知识库检索是 MyBatis-Plus `like`（title/content 关键字），
  **无向量库、无 embedding、无 rerank**（桌面端与服务端均无向量依赖）。
- **已决策（2026-09-14）**：**不把「服务端统一推理入口」列为规划/待办**——推理保留在客户端本地 sidecar。
  写文档时不要再把它当作缺口或规划项。AI 侧唯一的规划项是知识检索增强。
- ⇒ 别再把"AI 能力"笼统标成"规划中"：已落地的工具组/元数据代理必须与"向量检索增强"分开描述。



## 功能状态速查（标注"已落地 / 规划中"前必看 —— 已两次标错）

- **已落地**：规范开发环境、库表/字段/指标描述、元数据代理、Marquez 血缘、DolphinScheduler 调度、
  6 个智能体工具组、文件浏览与库表管理、**一键上线调度**（SQL / Scala / Java 提交调度，代码头参数落地任务节点）。
- **规划中**：自动化问题排障（按集群部署信息 + 任务依赖做根因定位）、数据价值评估、
  知识检索增强（向量检索）。**服务端统一推理入口已明确不做**，勿再列为规划项。
- ⚠️ **不要整条一刀切**：一个目标或条目常是"一半已落地 + 一半规划"。标注前先按能力颗粒度拆开，再逐项给状态。
