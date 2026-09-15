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
