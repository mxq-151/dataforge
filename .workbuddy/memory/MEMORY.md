# DataForge 长期记忆

> 只留「忘掉就出错」的可执行规则；过程见 `memory/YYYY-MM-DD.md`。

## 命令与环境
- vitest/tsc/vite 一律 `env -u NODE_OPTIONS`（否则 jsdom 导入 0.5s→96s）。
- **git 写操作「报成功却不落地」已不成立**（2026-10-12 实测：tag 建删、`branch -f`、`checkout -B`、`push --force-with-lease` 到 Gitee 全部真实生效）。动手前用临时 tag 建删+读回现场判定，别默认放弃执行。`dataforge`/`dataforge-server` 两仓库（远端 Gitee `mxq-151`，分支分别 master/main）。
- **本 agent shell 起不了这个 Electron 应用**：shell 有 OS 级沙箱 ⇒ Electron `sandbox initialization failed` + GPU 进程崩溃到 `GPU process isn't usable` + SIGTRAP，sidecar 的 `sandbox-exec` 也被拒；`dangerouslyDisableSandbox` **同样无效**。另 `ELECTRON_RUN_AS_NODE=1` 被注入（须 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS`，否则 electron 以 Node 模式跑并报 `whenReady` undefined）。⇒ **桌面端「真实运行验证」只能请用户做**；想让用户带调试端口起：开关必须在 app 路径**之后**（`electron . --remote-debugging-port=9222`）。
- **渲染进程日志不落盘**：`console.log` 只进 DevTools 与界面日志面板；`main.log` 仅有 sidecar（`[agent-log]`，UTC 时间戳）与主进程日志。要渲染进程证据得挂临时探针写盘（见 `src/dev/diagStream.ts` 模式，输出 `/tmp/dataforge-renderer.log`）。
- 同一文件多处编辑**串行**（并行 Edit 互相抹掉）；查并发写者 `find src -mmin -8`。
- macOS：`grep "a\|b"` 静默失败→用 `grep -E`；zsh `--include` 报 no matches→用 Grep 工具。
- 回归基线（2026-10-11）：前端 **71 文件/1155 例**；后端关心类 **118 例全过**；load 7~10 时 `waitFor` 超时属误报。
- 后端：`export JAVA_HOME=/opt/homebrew/opt/openjdk@17; mvn -o -q compile`；关心类 `mvn -o test -Dtest='DqRuleApiContractTest,DqResultServiceReportTest,DqRuleRegisterTest,DqOverviewApiContractTest,QualityRuleTypeContractTest,DqSqlBuilderMatrixTest,AssetCatalogApiContractTest' -DfailIfNoTests=false`。沙箱删不掉 `target/surefire*` 报「命令被拦截」→ 按 `BUILD SUCCESS`/`Tests run: N, Failures: 0` 判定。
- 布局验证用**真实浏览器**（playwright + `file://` + `getBoundingClientRect()`）。
- **改后端必须热更新容器**：`docker cp <fatjar> dataforge-allinone:/opt/dataforge/dataforge-server.jar` + `docker exec dataforge-allinone supervisorctl restart dataforge-server`。⚠️ 本 shell `mvn package` repackage 必失败（`Unable to rename …jar.original`）→ rsync 到 `/tmp/dfbuild-src` 再 `mvn -o -q -DskipTests package`。⚠️ 登录要加密密码，curl 登不进；验证走 psql 或 UI。

## 品牌与命名（2026-10-11 定调）
- **面向用户的可见文本里不出现 opencode**：日志前缀与正文、界面文案、错误消息一律称 **agent/Agent**（`[opencode]`→`[agent]`、`OpenCode 服务`→`Agent 服务`、`LogEntry.source: 'opencode'`→`'agent'`）。
- **技术标识符必须保留 opencode**（改了直接坏）：环境变量 `OPENCODE_*`、目录 `.opencode`/`opencode-*`、文件名 `opencode-config.json`、二进制与 triple 名、npm 包 `@opencode-ai/sdk`、IPC 通道 `opencode-process-terminated`/`start_opencode_after_login`、函数/类型名 `useOpencodeXxx`/`OpencodeClient`/`OpenCodeConfig`。源码注释里的「对齐 opencode 桌面版」等溯源说明**保留**。
- **`LogEntry.source` 是枚举且渲染到界面**（`SettingsView.tsx` 打 `log.source.toUpperCase()`）：改值须同步 `types/opencode-backend.ts` 的联合类型；CSS 只有 `--stdout/--stderr/--system`。

## 模型上下文窗口
- `deepseek-flash` = DeepSeek **V4.1** Flash **1M**；判定里无 v3/v4 字样只能**显式列出**，否则掉进泛化 `deepseek`→128k；V4 系一律 1_000_000。改判定须同步单测。
- `GET /api/model` 必须带 location；冷实例首次 `200 + data: []` ⇒ 重试。sidecar 由 app 托管（127.0.0.1:4096），应用一关端口即拒连。

## 编码约定
- 代码头三字段 `@程序参数`/`@资源参数`/`@任务参数`，**取值是真实值**。两消费面：运行弹窗只取参数名（`extractProgramParams`）、提交调度取取值落 `taskParams`（`headerTaskParams.ts`）。改字段名/语义须同步：S3 提示词 → `parseFileHeader` → `HEADER_FIELDS` → 上述两处 → `PendingProgramRun` → 两个 Modal → 6 个测试文件。调度侧「任务参数」是 DS 概念，别跟着改。
- 工作流名**不 sanitize**、环境后缀**默认 test**；`_v{N}` 版本链已删；`mainJar` 不加必填。表单加必填项须同步 `REQUIRED_PARAMS` 与单测。
- **x6 画布在 jsdom 下不可渲染**：只 mock `../dag/DagCanvas`；含 `useToast` 须包 `ToastProvider`。
- 提示词类 UI 不用原生 `title`（延迟 0.5~1s）→ 零延迟自定义 tooltip（面板内 `position:fixed`）。流式文本逐字增长不进 `messages`（走 ref + `subscribePartText`）。
- 开发助手切任务类型**不新建会话**；**数据探索例外**——`newSession()` 同时承担「新建时间戳工作目录」。
- **数据探索「会话=独立工作目录」的目录不可被自动启动改写**（2026-10-12 定因）：`App.tsx` 两个 slot 的自动启动 effect（`if (!connected && !starting) start()`）会在 `setWorkingDirectory` 的瞬时 `connected=false` 窗口触发，而无 cwd 的 `start()` 目标是模块**基础目录** ⇒ 覆盖会话目录、SSE 事件被目录过滤全丢（症状：回复不上屏，切走再切回才看到）。两条不变量：① `start()` 无 cwd 且已连接 ⇒ 空操作（含 `connected` 判断，别挡住崩溃后重连）；② 目录切换全程持有 `starting` 闸门（`beginStartBusy()` 计数），且必须在 `doDisconnect()` **之前**同步置位，让 `connected=false` 与 `starting=true` 同批提交。
- **该模块的回归测试必须把 `start()` 放在 `await setWorkingDirectory()` 之后**：实测抢跑发生在切换**完成之后** ~13ms，并发调用的写法落在闸门有效窗口内，会「测试通过但真实链路照样坏」（b8b2ee5 就是这么误判的）。
- **改一级菜单三连锁**：① `ActiveTab`/`MENU_CODE_MAP`/`App.tsx::FIRST_LEVEL_TAB_IDS` 同批改；② `FIRST_LEVEL_MENU_CODES` 由 MENU_CODE_MAP 派生；③ 菜单种子**只在 `sql/testdata/*.sql`**。
- **单文件提交调度 = 依赖只增不删**：任务已存在 → 只更新节点内容、依赖边不动不重排；新增节点 → 原有边全保留，仅按 `@依赖` **补齐**（前置复用/补建 `前置依赖_{任务名}`，按 `projectCode|definitionCode|depTaskCode` 去重）。实现 `addMissingWorkflowDependencies()`（`utils/schedulerMapping.ts`），**不是** `reconcileWorkflowDependencies`（丢 target 入边 + 清孤儿 DEPENDENT，只给文件夹链路）。环校验只在「本轮真加了边」时跑。别再引入「扫全部本地代码后重建」的单文件路径。

## 删除 / 回滚闸门
- 删除/回滚先过 `rollbackSafety.ts::assessRollbackSafety`；`root=null` 一律中止。
- 删除**走回收站**（`.dataforge-trash/` + manifest，须对 git 隐身），禁止直删；回收站≠备份。保留策略 30 天/50 批/2 GiB（最新 2 批不清理）：`trashRetention.ts` 决策、`trashCleanup.ts` 执行。**新增「移入回收站」入口必须接 `scheduleTrashRetention`**。

## 事实核查基线（写文档前勿凭印象）
- **血缘与调度是桌面端直连上游**（`src/api/marquez.ts`、`dolphinscheduler.ts`）；服务端无 Marquez 客户端、不存产出任务副本。**租户不是数据隔离边界**（`sys_tenant_user` 1:1；资源表无 tenant_id）。
- **权限**：DML fail-close；行/列合并**取交集收紧**；约束在 **SQL 下发前改写**（`SqlPermissionRewriter`，Spark/Flink/HBase 已纳入）；资产目录树/检索/详情服务端 fail-close 过滤 `sys_table_permission`（含列级）。残留：租户非隔离、只覆盖 SQL 代码类型、超管短路。
- **列级脱敏真实存在**（`full/idcard/phone/email/partial`，多角色取更严者，对智能体生效）；无敏感数据自动识别。
- **`cla:` 口径写死**：分级只三档 核心/重要/一般（GB/T 43697-2024）；分类只六类 个人信息/业务数据/经营数据/公共数据/运维数据/其他；写法 `cla:{分类}-{分级}`（表/字段注释尾部）。个人信息默认「一般数据」。常量 `CLASSIFICATION_SPEC` 注入 S1/S2/S3。后端**无 `cla:` 解析器**。
- **凭据已加密落盘**（Electron `safeStorage`，信封 `{"$dfenc":"v1"}`，旧明文兼容）；残留：设置页明文回填、无 keyring 的 Linux 降级明文、换机器解不开；导出走 `df:store:export` 剥离。
- **提交有环境维度** prod/gray/test（默认 test），**血缘只在 prod 注入**（`deployEnv.ts::shouldInjectLineage`）。**运行态数据只有测试环境**：`table_metadata` 仅 `*_olist_test` + `test_db`（38 张）⇒ 切生产/灰度看板为空是**正确结果**。**元数据缺失已可观测**（`MetadataAnnotationGapService`/`MetadataSyncAlertService`），勿写「静默滞后」。
- **资产分类不人工维护**：表名 `{分层}_{业务域}_{实体描述}_{刷新周期}` 确定性解析，失败即「未分类」并成治理项。
- **库表授权「整库」= `table_names` 存 `"*"`**：空值=整库可见、含 `*`=命中任意表；`getAccessibleTableNames` 含 `*` → `null`（消费方按「null=不限」）。前端契约在 `src/utils/tablePermissionScope.ts`；**`*` 只允许 scope=1**，切离 scope=1 清空选择。

## 资产管理模块
- 环境是**模块级**维度（切换器在页签条右侧，`AssetCatalogPanel` 持 state），切一次让**概况五块看板 + 目录树/检索/治理项/收藏一起重取**。默认生产（`DEFAULT_ASSET_ENV='prod'` ≠ `DEFAULT_DEPLOY_ENV='test'`）。
- 环境解析唯一实现 = 后端 `common/utils/DeployEnvParser`。后缀两套：**表类=库名**、**任务类=工作流名**；过滤一律在权限之后。env 空/脏值=不过滤、**解析不出环境的名称在显式过滤时被排除**。
- `/inventory/env-project` 不收窄；指标无环境维度；`/bookmark` 指定 env 走内存分页；标注缺口下推 SQL `LIKE '%!_prod' ESCAPE '!'`（`_` 必转义）。
- 后端**零 LLM 且不落后**：前后端路径全对得上，缺口只在前端 UI。`AssetCatalogPanel.tsx`=目录树/检索/收藏/治理项编排；`AssetDetailTabs.tsx`=详情页签；`AssetGovernanceEditor.tsx`=四个写操作；`useProbe.ts`=共用探测钩子。
- **坑**：`useProbe` 必须写 `Promise.resolve().then(loader)`；埋点只上报有具体资产的动作；分类/标签字典不可用降级只读、标签接口是整体替换；`LambdaQueryWrapper.select(lambda...)` 纯单测抛 `can not find lambda cache` → 用 `QueryWrapper.select("col1","col2")`；整体替换 `api/assetCatalog` 的 mock 必须补 `ASSET_ENV_OPTIONS`/`DEFAULT_ASSET_ENV`。

## 数据质量模块（2026-10-09 大改）
- **只剩 3 页签**：质量大盘/规则配置/规则模板。质检任务、运行记录、告警订阅**已彻底删除**（含五张表、提示词 taskId、`App.tsx` 的 DS Provider）。`dq_rule_result` 保留为「结果留痕」：去 `run_id`、增 `batch_no`/`check_record_count`/`fail_record_count`，消费者 `DqExecutionService.resolveBaseline`、`AssetCatalogService.quality()`。
- **回传入口 `POST /quality/run/report` 路径刻意不变**（保 `DATAFORGE_QUALITY_REPORT_URL` 有效），实现换轻量 `DqResultService`：解析 ruleId（显式优先 →「规则名+库+表」反查 → 查不到落 null）→ **表级读权限 fail-close** → 落一行。单测**非管理员用例必须先造 SecurityContext**。
- **7 类规则类型契约不变**：`types/quality.ts::QUALITY_RULE_TYPES` ↔ SQL 种子 ↔ 提示词三方逐字一致，`template_code == rule_type`（`qualityContract.test.ts`、`df_sql_check.py` 守它）。模板下发 `buildQualityTemplateSpec()` 仅拼进 S3 提示词。**坑**：SQL 骨架含 `${}`，不能用 TS 模板字符串拼。
- **质检任务粒度 = 一张被校验表一个程序**：命名 `{分层}_{业务域}_{实体描述}_check_{执行周期}`，@依赖 只写产出该表的处理任务，跨表规则归**左侧主表**。「阻断下游」= 独立质量校验任务挂下游、**失败即非零退出**，平台**不反向改写调度状态**。S2 规则清单须按库.表分组**连续**书写——`qualityRuleImport.ts` 遇首个非 `|` 行即 break。

## 数据库脚本与方言（改 schema 必读）
- **无迁移阶段**：`init/*.sql` 是 schema 唯一来源。四方言 init 各 **41 表**，**无 Flyway**。顺序：`init/` 四方言 → `testdata/`（仅当涉及菜单/角色/授权）。参考数据放 init，菜单与授权只在 `testdata/dataforge-testdata-postgresql.sql`。
- **真目标只两个**：PostgreSQL 14（docker）、MySQL；**MariaDB/H2 连驱动都没有**。验证见 skill **`dataforge-sql-dialect-verification`**：`df_sql_check.py` → `verify_pg.sh`/`verify_mysql.sh`。
- **本机无 `psql`/`mysql` 客户端**；docker CLI 在 `/Applications/Docker.app/Contents/Resources/bin/docker`；JDBC 驱动 `/Users/mxq/Desktop/mysql-connector-j-8.0.33.jar`。**改完 SQL 必须重新切分再验证**；断言别写死数量。`init-dataforge.sh` 用 `ON_ERROR_STOP=0`（吞错误）→ 验证时必改 `1`。
- **InnoDB 索引键上限 3072 字节**：`varchar(1024)` 建索引会**整张表建不出来**。
- ⚠️ `df_sql_check.py` 的 `KNOWN_DIALECT_DIFFS` 有存量差异：`indicators.code`/`indicators.id` 是**真实漂移**（独立修复任务），其余是方言表达差异。
- ⚠️ **真实部署容器 `dataforge-allinone` 常驻**（PG 5432/服务 8082/前端 3000/DS 12345）——验证只用一次性库（`df_sqlcheck_*`），收尾必须清理。
- ⚠️ **bash 陷阱**：`$VAR` 紧跟中文/全角标点会被并进变量名 → 一律写 `${VAR}`。

## 平台定位与商业模式（对外叙事必守）
- 核心目标：**让智能体正确理解业务数据**。四大组件 = dataforge（规范开发环境）/dataforge-server（库表+指标描述）/Marquez（血缘）/DolphinScheduler（任务依赖）；**listener 类是治理增强、可插拔，别抬高**。五类上下文 = 规范开发环境/库表描述/指标描述/血缘/任务依赖。
- **核心差异**：像 AI 编程助手，但**提需求的人不同**——编程助手是开发者提需求，DataForge 是**业务方提需求**（不懂 SQL）；≠ 编程助手，也 ≠ DataWorks ⇒ **数据代开发服务**的技术基础。**软件企业内部免费、代码闭源**；收益 = 数据开发服务 + 集群运维服务。
- **需求闭环**：六角色含**业务需求方**与**数据架构师**；开发助手任务类型即角色：需求编写 → 数仓设计 → 数据开发（数据探索另一套）；契约唯一来源 `src/hooks/opencode/opencodeInstructions.ts`；**指标是唯一主线**，另四条同源线：数据时效/数据源名称/数据质量/敏感数据。`TaskRecord` 不记任务类型。
- **AI 能力落点**：**已落地** 6 工具组（compile/indicator-query/knowledge-document/lineage/metadata-agent/sql-validate）+ 元数据代理 `/metadata/agent/*`；**规划中** 自动化排障、数据价值评估、知识检索增强（现为 MyBatis-Plus `like`）；**不做** 服务端统一推理入口。

## 交付偏好与 CSS 坑
- 性能类任务**诊断驱动**，先量化再改；交付含量化对比、变更表、决策理由、未改动项清单，附 `tsc --noEmit` 与 vitest 计数，新增逻辑配套单测。
- **计划书不出 Word**：交付物是 `output/<request_id>/stage3/…html`，**不设「风险识别与应对」章节**；结构 = 概述/需求/架构/组件/模块优先级/推广与时间/验收质量/预期效益/附录：现状基线。
- **sticky 表头别被「表格自身的滚动容器」吃掉**：`position: sticky` 只认**最近滚动容器**。`.ac-table` 圆角 + `overflow: hidden` → 表头跟内容滚走。修法：`.ac-ov-scroll .ac-table { overflow: visible; border-radius: 0; }`。长表头会撑宽整表（主区可用宽 ≈ 790px），列名保持短。项目**无全局 `box-sizing` reset**；`button`/`input` 不继承 `:root` 的 font-family 与 line-height。
