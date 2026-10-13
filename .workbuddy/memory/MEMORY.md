# DataForge 长期记忆

> 只留「忘掉就出错」的可执行规则；细节见 `memory/YYYY-MM-DD.md`。**本文件须 ≤ 9.5k 字符**。

## 命令与环境
- vitest/tsc/vite 一律 `env -u NODE_OPTIONS`；Electron 还须 `-u ELECTRON_RUN_AS_NODE`。布局验证用真实浏览器（playwright + `file://` + `getBoundingClientRect`）。
- **本 shell 起不了 Electron**（沙箱）⇒ 桌面端运行验证请用户做；带调试端口时开关须在 app 路径**之后**。
- **渲染进程 `console.log` 不落盘** ⇒ 须挂临时探针写盘（`src/dev/diagStream.ts`）。
- git 写操作**真实生效**，动手前用临时 tag 建删+读回判定。仓库 `dataforge`(master)/`dataforge-server`(main)，远端 Gitee `mxq-151`；同一文件多处编辑**串行**；macOS 用 `grep -E` 代替 `"a\|b"`；zsh `--include` 报 no matches → 用 Grep 工具。
- 回归基线（2026-10-12）：前端 **78 文件/1214 例**，后端关心类 **118 例**。**非真实失败**：`textmateFix`/`AssetCatalogPanel.lifecycle` 满负载超时（单独跑即过）；`installMarker.test.ts` 的 `resolveBundleRoot` 两例在 Windows 必失败。
- 后端编译 `export JAVA_HOME=/opt/homebrew/opt/openjdk@17; mvn -o -q compile`；关心类 `mvn -o test -Dtest='DqRuleApiContractTest,DqResultServiceReportTest,DqRuleRegisterTest,DqOverviewApiContractTest,QualityRuleTypeContractTest,DqSqlBuilderMatrixTest,AssetCatalogApiContractTest' -DfailIfNoTests=false`；删不掉 `target/surefire*` → 按 `Tests run: N, Failures: 0` 判定。
- **改后端必须热更新容器**：`docker cp <fatjar> dataforge-allinone:/opt/dataforge/dataforge-server.jar` + `supervisorctl restart dataforge-server`。⚠️ 本 shell `mvn package` repackage 必失败 → rsync 到 `/tmp/dfbuild-src` 再 `mvn -o -q -DskipTests package`。⚠️ curl 登不进，验证走 psql/UI。
- **Windows 调 `.cmd/.bat` 须自拼带引号命令行**（`shell:true` 时 Node 只裸拼 file+args，DEP0190，含空格路径被 cmd.exe 截断）：实现 `electron/backend/maven.ts`（`quoteCmdArg`/`buildCmdCommandLine`/`needsCmdShell`，回归 `maven.test.ts`）。坑：两条 spawn 分支 options 须各写**字面量**，否则 TS 收宽 stdio、`cp.stdout` 变可空。

## 品牌与命名（2026-10-11）
- 可见文本**不出现 opencode**（日志前缀与正文、界面文案、错误消息一律 **agent/Agent**，`LogEntry.source: 'opencode'`→`'agent'`）；**技术标识符必须保留**：`OPENCODE_*`、`.opencode`/`opencode-*` 目录、`opencode-config.json`、二进制与 triple 名、`@opencode-ai/sdk`、IPC 通道 `opencode-process-terminated`/`start_opencode_after_login`、`useOpencodeXxx`/`OpencodeClient`/`OpenCodeConfig`。
- `LogEntry.source` 是枚举且渲染上屏：改值须同步 `types/opencode-backend.ts` 联合类型与 `SettingsView.tsx`；CSS 只有 `--stdout/--stderr/--system`。

## 日志时间 / 模型窗口
- 主进程日志（终端 + `main.log`）**一律本地时区**：前缀 `electron/backend/logTime.ts::toLocalIsoString()`（`YYYY-MM-DDTHH:mm:ss.SSS±HH:MM`）；转发 sidecar 输出前过 `localizeLogTimestamps()` 改写行内 `timestamp=<ISO>`（sidecar 自己打的是永远 UTC 的 `toISOString()`，注入 TZ 无效）。
- `deepseek-flash` = DeepSeek **V4.1** Flash **1M**；判定里无 v3/v4 字样须**显式列出**，否则掉进泛化 `deepseek`→128k；V4 系一律 1_000_000。改判定须同步单测。`GET /api/model` 必须带 location；冷实例首次 `200 + data: []` ⇒ 重试。

## 打包与签名（macOS）
- **运行时不写应用包**（`asar:false` ⇒ `app.getAppPath()` = `.app/Contents/Resources/app`）：签名密封清单覆盖该目录，写一个文件 ⇒ `codesign --verify` 报 `a sealed resource is missing or invalid` ⇒ 钥匙串 ACL 不过 ⇒ 每次启动 `safeStorage` 弹「输入"登录"钥匙串密码」（只有发布版弹）。运行时文件一律落 `userData`。
- 出包自检：`codesign --verify --deep --strict` 须 `valid on disk`；`spctl -a -vvv -t exec` 仍 `rejected, source=Unnotarized Developer ID`（未配公证）。见 `构建打包说明.md` 第六节第 4 条。installMarker 指纹判定与 `electronDownload.isVerifyChecksum=false` 见当日日志。

## 编码约定
- 代码头三字段 `@程序参数`/`@资源参数`/`@任务参数`，**取值是真实值**。两消费面：运行弹窗只取参数名（`extractProgramParams`）、提交调度取取值落 `taskParams`（`headerTaskParams.ts`）。改字段名/语义须同步：S3 提示词 → `parseFileHeader` → `HEADER_FIELDS` → 上述两处 → `PendingProgramRun` → 两个 Modal → 6 个测试文件。调度侧「任务参数」是 DS 概念，别跟着改。
- 工作流名**不 sanitize**、环境后缀**默认 test**；`_v{N}` 版本链已删；`mainJar` 不加必填。表单加必填项须同步 `REQUIRED_PARAMS` 与单测。
- **x6 画布在 jsdom 下不可渲染**：只 mock `../dag/DagCanvas`；含 `useToast` 须包 `ToastProvider`。
- 提示词类 UI 不用原生 `title`（延迟 0.5~1s）→ 零延迟自定义 tooltip（面板内 `position:fixed`）。流式文本逐字增长不进 `messages`（走 ref + `subscribePartText`）。
- **改一级菜单三连锁**：① `ActiveTab`/`MENU_CODE_MAP`/`App.tsx::FIRST_LEVEL_TAB_IDS` 同批改；② `FIRST_LEVEL_MENU_CODES` 由 MENU_CODE_MAP 派生；③ 菜单种子**只在 `sql/testdata/*.sql`**。
- **单文件提交调度 = 依赖只增不删**：任务已存在 → 只更新节点内容、依赖边不动；新增节点 → 原有边全保留，仅按 `@依赖` **补齐**。实现 `addMissingWorkflowDependencies()`（`utils/schedulerMapping.ts`），**不是** `reconcileWorkflowDependencies`（丢 target 入边+清孤儿 DEPENDENT）。别引入「扫全部本地代码后重建」的单文件路径。
- **opencode client 已分层**：`useOpencodeClient.tsx` 仅门面（按 moduleId 分派 Provider + 类型再导出），实现全在 `client/`。**两模块工作空间差异的唯一落点 = `client/workspace.ts::WorkspaceStrategy` 的 5 个钩子**（devAssistantClient 全空操作=固定目录；dataExploreClient=会话独立目录）⇒ 禁止再往动作层加 `if (moduleId==='data-explore')`。`clientRef`/`unsubscribeRef` 由 core 创建共享（都要在 await 前读）；hook 顺序硬约束：agentLog → sessions → events → connection → eventStream → modelLimit → review → chat，倒序即踩环；`connected` 单独传参、其余走 `ctxRef`（只在异步回调里读）。
- **数据探索「会话=独立工作目录」不可被自动启动改写**：`App.tsx` 自动启动 effect（`if (!connected && !starting) start()`）会在 `setWorkingDirectory` 的瞬时 `connected=false` 窗口触发，无 cwd 的 `start()` 目标是模块**基础目录** ⇒ 覆盖会话目录、SSE 全丢。不变量：① `start()` 无 cwd 且已连接 ⇒ 空操作（别挡崩溃后重连）；② 切目录全程持 `starting` 闸门（`beginStartBusy()`），须在 `doDisconnect()` **之前**同步置位。回归测试须把 `start()` 放在 `await setWorkingDirectory()` 之后（并发写法会「测试过但链路照样坏」）。开发助手切任务类型**不新建会话**，数据探索相反（`newSession()` 兼「新建时间戳工作目录」）。

## 删除 / 回滚闸门
- 删除/回滚先过 `rollbackSafety.ts::assessRollbackSafety`；`root=null` 一律中止。
- 删除**走回收站**（`.dataforge-trash/` + manifest，须对 git 隐身），禁止直删。保留 30 天/50 批/2 GiB（最新 2 批不清理）：`trashRetention.ts` 决策、`trashCleanup.ts` 执行。**新增「移入回收站」入口必须接 `scheduleTrashRetention`**。
- **会话历史删除 = 本地先落地**：`setTasks(removeSessionHistoryEntry(...))` 必须在任何 `await` 之前；删除写墓碑 `{key}::deleted`，`refreshTasks` 服务端播种前须按墓碑过滤。

## 事实核查基线（写文档前勿凭印象）
- **血缘与调度是桌面端直连上游**（`src/api/marquez.ts`、`dolphinscheduler.ts`）；服务端无 Marquez 客户端、不存产出任务副本。**租户不是数据隔离边界**（`sys_tenant_user` 1:1；资源表无 tenant_id）。
- **权限**：DML fail-close；行/列合并**取交集收紧**；约束在 **SQL 下发前改写**（`SqlPermissionRewriter`，含 Spark/Flink/HBase）；资产目录树/检索/详情服务端 fail-close 过滤 `sys_table_permission`（含列级）。**列级脱敏真实存在**（`full/idcard/phone/email/partial`，多角色取更严者，对智能体生效）。残留：租户非隔离、只覆盖 SQL 代码类型、超管短路。
- **`cla:` 口径写死**：分级只三档 核心/重要/一般（GB/T 43697-2024），分类只六类 个人信息/业务数据/经营数据/公共数据/运维数据/其他；写法 `cla:{分类}-{分级}`（表/字段注释尾部）。常量 `CLASSIFICATION_SPEC` 注入 S1/S2/S3；后端**无解析器**。
- **提交有环境维度** prod/gray/test（默认 test），**血缘只在 prod 注入**（`deployEnv.ts::shouldInjectLineage`）。**运行态数据只有测试环境**：`table_metadata` 仅 `*_olist_test` + `test_db`（38 张）⇒ 切生产/灰度看板为空是**正确结果**。
- **库表授权「整库」= `table_names` 存 `"*"`**：空值=整库可见、含 `*`=命中任意表；`getAccessibleTableNames` 含 `*` → `null`（消费方按「null=不限」）。契约 `src/utils/tablePermissionScope.ts`；**`*` 只允许 scope=1**，切离 scope=1 清空选择。
- 其余（凭据 `safeStorage` 加密落盘与残留、元数据缺口告警）见当日日志。

## 资产管理模块
- 环境是**模块级**维度（切换器在页签条右侧），切一次让**概况五块看板 + 目录树/检索/治理项/收藏一起重取**。默认生产（`DEFAULT_ASSET_ENV='prod'` ≠ `DEFAULT_DEPLOY_ENV='test'`）。
- 环境解析唯一实现 = 后端 `common/utils/DeployEnvParser`。后缀两套：**表类=库名**、**任务类=工作流名**；过滤一律在权限之后。env 空/脏值=不过滤、**解析不出环境的名称在显式过滤时被排除**。
- `/inventory/env-project` 不收窄；指标无环境维度；`/bookmark` 指定 env 走内存分页；标注缺口下推 SQL `LIKE '%!_prod' ESCAPE '!'`（`_` 必转义）。
- 前端编排：`AssetCatalogPanel.tsx`（目录树/检索/收藏/治理项）、`AssetDetailTabs.tsx`、`AssetGovernanceEditor.tsx`（四个写操作）、`useProbe.ts`。
- **坑**：`useProbe` 必须写 `Promise.resolve().then(loader)`；字典不可用降级只读、标签接口整体替换；`LambdaQueryWrapper.select(lambda...)` 纯单测抛 `can not find lambda cache` → 用 `QueryWrapper.select("col1","col2")`；整体替换 `api/assetCatalog` 的 mock 须补 `ASSET_ENV_OPTIONS`/`DEFAULT_ASSET_ENV`。

## 数据质量模块（2026-10-09 大改）
- **只剩 3 页签**：大盘/规则配置/规则模板；质检任务、运行记录、告警订阅及五张表**已彻底删除**（含提示词 taskId）。`dq_rule_result` 保留作结果留痕：去 `run_id`、增 `batch_no`/`check_record_count`/`fail_record_count`；消费者 `DqExecutionService.resolveBaseline`、`AssetCatalogService.quality()`。
- **回传 `POST /quality/run/report` 路径刻意不变**（保 `DATAFORGE_QUALITY_REPORT_URL`）；实现换 `DqResultService`：解析 ruleId（显式 →「规则名+库+表」反查 → null）→ **表级读权限 fail-close** → 落一行。单测**非管理员须先造 SecurityContext**。
- **7 类规则类型契约不变**：`types/quality.ts::QUALITY_RULE_TYPES` ↔ SQL 种子 ↔ 提示词三方逐字一致，`template_code == rule_type`（`qualityContract.test.ts`、`df_sql_check.py` 守）。**坑**：SQL 骨架含 `${}`，不能用 TS 模板字符串拼。
- **质检任务粒度 = 一张被校验表一个程序**：命名 `{分层}_{业务域}_{实体描述}_check_{执行周期}`，@依赖 只写产出该表的处理任务，跨表规则归**左侧主表**。「阻断下游」= 独立质量任务挂下游、**失败即非零退出**，平台**不反向改写调度状态**。S2 规则清单须按库.表分组**连续**书写——`qualityRuleImport.ts` 遇首个非 `|` 行即 break。

## 数据库脚本与方言（改 schema 必读）
- **无迁移阶段**：`init/*.sql` 是 schema 唯一来源。四方言 init 各 **41 表**，**无 Flyway**。顺序：`init/` 四方言 → `testdata/`（涉菜单/角色/授权时）；菜单与授权只在 `testdata/*.sql`。
- **真目标只两个**：PostgreSQL 14（docker）、MySQL；**MariaDB/H2 连驱动都没有**。验证见 skill **`dataforge-sql-dialect-verification`**：`df_sql_check.py` → `verify_pg.sh`/`verify_mysql.sh`。
- **本机无 `psql`/`mysql` 客户端**；**改完 SQL 必须重新切分再验证**；断言别写死数量。`init-dataforge.sh` 用 `ON_ERROR_STOP=0` → 验证时须改 `1`。**验证只用一次性库（`df_sqlcheck_*`），收尾必须清理**。
- **InnoDB 索引键上限 3072 字节**：`varchar(1024)` 建索引会**整张表建不出来**。
- ⚠️ `df_sql_check.py` 的 `KNOWN_DIALECT_DIFFS`：`indicators.code`/`indicators.id` 是**真实漂移**（独立修复任务），其余是方言表达差异。
- ⚠️ **真实部署容器 `dataforge-allinone` 常驻**（PG 5432/服务 8082/前端 3000/DS 12345）。⚠️ **bash 陷阱**：`$VAR` 紧跟中文/全角标点会被并进变量名 → 一律写 `${VAR}`。

## 平台定位与商业模式（对外叙事必守）
- 核心目标：**让智能体正确理解业务数据**；四大组件 = dataforge（规范开发环境）/dataforge-server（库表+指标描述）/Marquez（血缘）/DolphinScheduler（任务依赖），**listener 类是可插拔治理增强，别抬高**。**提需求的是业务方**（不懂 SQL），≠ 编程助手、≠ DataWorks ⇒ **数据代开发服务**的基础；**企业内部免费、代码闭源**。
- 六角色含**业务需求方**与**数据架构师**（开发助手任务类型即角色）；契约唯一来源 `src/hooks/opencode/opencodeInstructions.ts`；**指标是唯一主线**。完整叙事（五类上下文、AI 能力落点、计划书结构）见当日日志。

## 交付偏好与 CSS 坑
- 性能类任务**诊断驱动**，先量化再改；交付含量化对比、变更表、决策理由、未改动项清单，附 `tsc --noEmit` 与 vitest 计数，新增逻辑配套单测。
- **计划书不出 Word**：交付物 `output/<request_id>/stage3/…html`，**不设「风险识别与应对」章节**（完整结构见当日日志）。
- **sticky 表头别被表格自身的滚动容器吃掉**：`position: sticky` 只认**最近滚动容器**；`.ac-table` 圆角 + `overflow: hidden` ⇒ 表头跟内容滚走。修法 `.ac-ov-scroll .ac-table { overflow: visible; border-radius: 0; }`。主区可用宽 ≈ 790px，列名保持短。CSS 补充（无全局 `box-sizing` reset 等）见当日日志。
