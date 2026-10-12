# DataForge 长期记忆

> 只留「忘掉就出错」的可执行规则；过程见 `memory/YYYY-MM-DD.md`。**本文件须 ≤ 9.5k 字符**，超了注入时会被截断（细节一律写当日日志，别往这里堆）。

## 命令与环境
- vitest/tsc/vite 一律 `env -u NODE_OPTIONS`（否则 jsdom 导入 0.5s→96s）。布局验证用真实浏览器（playwright + `file://` + `getBoundingClientRect`）。
- **本 shell 起不了 Electron**（OS 沙箱 ⇒ sandbox init failed + GPU 崩溃 + SIGTRAP；sidecar 的 `sandbox-exec` 同样被拒，`dangerouslyDisableSandbox` 无效）；`ELECTRON_RUN_AS_NODE=1` 被注入，须 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS`。⇒ 桌面端运行验证只能请用户做；带调试端口时开关须在 app 路径**之后**。
- **渲染进程 `console.log` 不落盘**（只进 DevTools 与界面面板）；`main.log` 只有 sidecar（`[agent-log]`）与主进程日志；渲染进程证据得挂临时探针写盘（模式见 `src/dev/diagStream.ts`）。
- git 写操作**真实生效**（2026-10-12 实测 tag/branch -f/checkout -B/push --force-with-lease 到 Gitee）；动手前用临时 tag 建删+读回判定。仓库 `dataforge`(master)/`dataforge-server`(main)，远端 Gitee `mxq-151`。
- 同一文件多处编辑**串行**；查并发写者 `find src -mmin -8`。macOS：`grep "a\|b"` 静默失败→用 `grep -E`；zsh `--include` 报 no matches→用 Grep 工具。
- 回归基线：前端 **73 文件/1167 例**（原 71/1155）；后端关心类 **118 例**；load 7~10 时 `waitFor` 超时属误报。
- 后端：`export JAVA_HOME=/opt/homebrew/opt/openjdk@17; mvn -o -q compile`；关心类 `mvn -o test -Dtest='DqRuleApiContractTest,DqResultServiceReportTest,DqRuleRegisterTest,DqOverviewApiContractTest,QualityRuleTypeContractTest,DqSqlBuilderMatrixTest,AssetCatalogApiContractTest' -DfailIfNoTests=false`；沙箱删不掉 `target/surefire*` → 按 `Tests run: N, Failures: 0` 判定。
- **改后端必须热更新容器**：`docker cp <fatjar> dataforge-allinone:/opt/dataforge/dataforge-server.jar` + `docker exec dataforge-allinone supervisorctl restart dataforge-server`。⚠️ 本 shell `mvn package` repackage 必失败 → rsync 到 `/tmp/dfbuild-src` 后 `mvn -o -q -DskipTests package`。⚠️ curl 登不进（密码加密），验证走 psql/UI。

## 品牌与命名（2026-10-11 定调）
- 可见文本**不出现 opencode**（日志前缀与正文、界面文案、错误消息一律 **agent/Agent**，`LogEntry.source: 'opencode'`→`'agent'`）；但**技术标识符必须保留**（改了直接坏）：`OPENCODE_*` 环境变量、`.opencode`/`opencode-*` 目录、`opencode-config.json`、二进制与 triple 名、`@opencode-ai/sdk`、IPC 通道 `opencode-process-terminated`/`start_opencode_after_login`、`useOpencodeXxx`/`OpencodeClient`/`OpenCodeConfig`。注释里的溯源说明保留。
- `LogEntry.source` 是枚举且渲染上屏（`SettingsView.tsx` 打 `log.source.toUpperCase()`）：改值须同步 `types/opencode-backend.ts` 联合类型；CSS 只有 `--stdout/--stderr/--system`。

## 日志时间（2026-10-12）
- 主进程日志（终端 + `main.log`）**一律本地时区**：行首前缀用 `electron/backend/logTime.ts::toLocalIsoString()`（`YYYY-MM-DDTHH:mm:ss.SSS±HH:MM`）；转发 sidecar 输出前过 `localizeLogTimestamps()` 改写行内 `timestamp=<ISO>`。sidecar 自己打的是 `toISOString()`（永远 UTC，注入 TZ 无效）。界面侧本就用 `toLocaleTimeString`。

## 模型上下文窗口
- `deepseek-flash` = DeepSeek **V4.1** Flash **1M**；判定里无 v3/v4 字样只能**显式列出**，否则掉进泛化 `deepseek`→128k；V4 系一律 1_000_000。改判定须同步单测。
- `GET /api/model` 必须带 location；冷实例首次 `200 + data: []` ⇒ 重试。sidecar 由 app 托管（127.0.0.1:4096），应用一关端口即拒连。

## 打包与签名（macOS）
- **运行时不写应用包**（`asar:false` ⇒ `app.getAppPath()` 就是 `.app/Contents/Resources/app`）：签名密封清单（800+ 条 `Resources/app/` 记录）覆盖该目录，往包里写一个文件就让 `codesign --verify` 报 `a sealed resource is missing or invalid / file added`；签名一失效，macOS 钥匙串 ACL 校验就过不去 ⇒ 每次启动 `safeStorage` 解密都弹「请输入"登录"钥匙串密码」（开发态跑官方 Electron.app 签名有效，故只有发布版弹）。运行时文件一律落 `userData`。
- 协议同意标记已按此改造：`electron/backend/installMarker.ts`（纯逻辑 + 注入 fs 端口，22 例）。标记落 `userData/install-marker.json`；「重装即重新同意」改为比对**应用包 `(inode, birthtimeMs)` 指纹**，且**只在打包态**参与判定（dev 传 `bundleRoot: null` —— 否则 dev 的 Electron.app 与打包的 DataForge.app 共用同一份 userData，交替运行会被反复判成重装、每切一次弹一次协议页）。包内旧标记 `.df-install-token` 只读迁移一次，**读取侧保守放行**（拿不到指纹不做重装判定）。
- `.df-install-token` 已 `git rm --cached` + 写进 `.gitignore`（旧实现会把 token 写进仓库根并被入库）。
- 出包自检：`codesign --verify --deep --strict` 须 `valid on disk`；`spctl -a -vvv -t exec` 目前仍是 `rejected, source=Unnotarized Developer ID`（未配公证凭据）。见 `构建打包说明.md` 第六节第 4 条。
- **electron-builder 不复用 `node_modules/electron/dist`**：它按 (版本/平台/架构) 自己下 zip 到 `~/Library/Caches/electron/<sha256(URL目录)>/`（目录名 = @electron/get 对 URL dirname 的 sha256；同版本各架构共用一个目录）。
- **「每次构建都下载 Electron」的根因**：@electron/get 命中缓存后**仍要联网**取 `SHASUMS256.txt` 校验（`cacheMode=Bypass`，注释原文 "Never use the cache for loading checksums"）；该请求一失败，`Cache hit` 就被降级成 `falling back to re-download` ⇒ 白下 133 MB，而重下后内容哈希相同 ⇒ `putFileInCache` 不重写 ⇒ 缓存文件 mtime 永远不变（看着像「缓存没生效」，其实是校验那一步没走通）。自证：`DEBUG='@electron/get*' npx electron-builder --mac --dir 2>&1 | grep -E "Cache (hit|miss)|checksum|falling back"`。修复：`build.electronDownload.isVerifyChecksum=false`（实测 `• using cached artifact` 8 ms 返回、零网络；代价是不校验 sha256）或配 `electron_mirror` 镜像让校验请求稳定。

## 编码约定
- 代码头三字段 `@程序参数`/`@资源参数`/`@任务参数`，**取值是真实值**。两消费面：运行弹窗只取参数名（`extractProgramParams`）、提交调度取取值落 `taskParams`（`headerTaskParams.ts`）。改字段名/语义须同步：S3 提示词 → `parseFileHeader` → `HEADER_FIELDS` → 上述两处 → `PendingProgramRun` → 两个 Modal → 6 个测试文件。调度侧「任务参数」是 DS 概念，别跟着改。
- 工作流名**不 sanitize**、环境后缀**默认 test**；`_v{N}` 版本链已删；`mainJar` 不加必填。表单加必填项须同步 `REQUIRED_PARAMS` 与单测。
- **x6 画布在 jsdom 下不可渲染**：只 mock `../dag/DagCanvas`；含 `useToast` 须包 `ToastProvider`。
- 提示词类 UI 不用原生 `title`（延迟 0.5~1s）→ 零延迟自定义 tooltip（面板内 `position:fixed`）。流式文本逐字增长不进 `messages`（走 ref + `subscribePartText`）。
- 开发助手切任务类型**不新建会话**；**数据探索例外**——`newSession()` 同时承担「新建时间戳工作目录」。
- **数据探索「会话=独立工作目录」不可被自动启动改写**：`App.tsx` 两个 slot 的自动启动 effect（`if (!connected && !starting) start()`）会在 `setWorkingDirectory` 的瞬时 `connected=false` 窗口触发，无 cwd 的 `start()` 目标是模块**基础目录** ⇒ 覆盖会话目录、SSE 被目录过滤全丢（回复不上屏，切走再切回才看到）。不变量：① `start()` 无 cwd 且已连接 ⇒ 空操作（含 `connected` 判断，别挡崩溃后重连）；② 切目录全程持 `starting` 闸门（`beginStartBusy()` 计数），须在 `doDisconnect()` **之前**同步置位，让二者同批提交。回归测试须把 `start()` 放在 `await setWorkingDirectory()` 之后（抢跑在切换完成后 ~13ms；并发写法会「测试过但链路照样坏」，b8b2ee5 即误判）。
- **改一级菜单三连锁**：① `ActiveTab`/`MENU_CODE_MAP`/`App.tsx::FIRST_LEVEL_TAB_IDS` 同批改；② `FIRST_LEVEL_MENU_CODES` 由 MENU_CODE_MAP 派生；③ 菜单种子**只在 `sql/testdata/*.sql`**。
- **单文件提交调度 = 依赖只增不删**：任务已存在 → 只更新节点内容、依赖边不动不重排；新增节点 → 原有边全保留，仅按 `@依赖` **补齐**（复用前置/补建 `前置依赖_{任务名}`，按 `projectCode|definitionCode|depTaskCode` 去重）。实现 `addMissingWorkflowDependencies()`（`utils/schedulerMapping.ts`），**不是** `reconcileWorkflowDependencies`（丢 target 入边+清孤儿 DEPENDENT，只给文件夹链路）。环校验只在「本轮真加了边」时跑。别引入「扫全部本地代码后重建」的单文件路径。

## 删除 / 回滚闸门
- 删除/回滚先过 `rollbackSafety.ts::assessRollbackSafety`；`root=null` 一律中止。
- 删除**走回收站**（`.dataforge-trash/` + manifest，须对 git 隐身），禁止直删；回收站≠备份。保留 30 天/50 批/2 GiB（最新 2 批不清理）：`trashRetention.ts` 决策、`trashCleanup.ts` 执行。**新增「移入回收站」入口必须接 `scheduleTrashRetention`**。
- **会话历史（智能体对话下拉框）删除 = 本地先落地**：`setTasks(removeSessionHistoryEntry(...))` 必须在任何 `await` 之前（服务端 `session.delete` 挂起/失败不得留住那一行，也不回滚）；删除写墓碑 `{key}::deleted`，`refreshTasks` 服务端播种前须按墓碑过滤，否则已删会话复活。

## 事实核查基线（写文档前勿凭印象）
- **血缘与调度是桌面端直连上游**（`src/api/marquez.ts`、`dolphinscheduler.ts`）；服务端无 Marquez 客户端、不存产出任务副本。**租户不是数据隔离边界**（`sys_tenant_user` 1:1；资源表无 tenant_id）。
- **权限**：DML fail-close；行/列合并**取交集收紧**；约束在 **SQL 下发前改写**（`SqlPermissionRewriter`，含 Spark/Flink/HBase）；资产目录树/检索/详情服务端 fail-close 过滤 `sys_table_permission`（含列级）。残留：租户非隔离、只覆盖 SQL 代码类型、超管短路。
- **列级脱敏真实存在**（`full/idcard/phone/email/partial`，多角色取更严者，对智能体生效）；无敏感数据自动识别。
- **`cla:` 口径写死**：分级只三档 核心/重要/一般（GB/T 43697-2024）；分类只六类 个人信息/业务数据/经营数据/公共数据/运维数据/其他；写法 `cla:{分类}-{分级}`（表/字段注释尾部），个人信息默认「一般数据」。常量 `CLASSIFICATION_SPEC` 注入 S1/S2/S3。后端**无 `cla:` 解析器**。
- **凭据已加密落盘**（Electron `safeStorage`，信封 `{"$dfenc":"v1"}`，兼容旧明文）；残留：设置页明文回填、无 keyring 的 Linux 降级明文、换机器解不开；导出走 `df:store:export` 剥离。
- **提交有环境维度** prod/gray/test（默认 test），**血缘只在 prod 注入**（`deployEnv.ts::shouldInjectLineage`）。**运行态数据只有测试环境**：`table_metadata` 仅 `*_olist_test` + `test_db`（38 张）⇒ 切生产/灰度看板为空是**正确结果**。元数据缺失已可观测（`MetadataAnnotationGapService`/`MetadataSyncAlertService`）。
- **资产分类不人工维护**：表名 `{分层}_{业务域}_{实体描述}_{刷新周期}` 确定性解析，失败即「未分类」并成治理项。
- **库表授权「整库」= `table_names` 存 `"*"`**：空值=整库可见、含 `*`=命中任意表；`getAccessibleTableNames` 含 `*` → `null`（消费方按「null=不限」）。契约在 `src/utils/tablePermissionScope.ts`；**`*` 只允许 scope=1**，切离 scope=1 清空选择。

## 资产管理模块
- 环境是**模块级**维度（`AssetCatalogPanel` 持 state，切换器在页签条右侧），切一次让**概况五块看板 + 目录树/检索/治理项/收藏一起重取**。默认生产（`DEFAULT_ASSET_ENV='prod'` ≠ `DEFAULT_DEPLOY_ENV='test'`）。
- 环境解析唯一实现 = 后端 `common/utils/DeployEnvParser`。后缀两套：**表类=库名**、**任务类=工作流名**；过滤一律在权限之后。env 空/脏值=不过滤、**解析不出环境的名称在显式过滤时被排除**。
- `/inventory/env-project` 不收窄；指标无环境维度；`/bookmark` 指定 env 走内存分页；标注缺口下推 SQL `LIKE '%!_prod' ESCAPE '!'`（`_` 必转义）。
- 后端**零 LLM 且不落后**：前后端路径全对得上，缺口只在前端 UI。`AssetCatalogPanel.tsx`=目录树/检索/收藏/治理项编排；`AssetDetailTabs.tsx`=详情页签；`AssetGovernanceEditor.tsx`=四个写操作；`useProbe.ts`=共用探测钩子。
- **坑**：`useProbe` 必须写 `Promise.resolve().then(loader)`；埋点只上报有具体资产的动作；分类/标签字典不可用降级只读、标签接口是整体替换；`LambdaQueryWrapper.select(lambda...)` 纯单测抛 `can not find lambda cache` → 用 `QueryWrapper.select("col1","col2")`；整体替换 `api/assetCatalog` 的 mock 须补 `ASSET_ENV_OPTIONS`/`DEFAULT_ASSET_ENV`。

## 数据质量模块（2026-10-09 大改）
- **只剩 3 页签**：质量大盘/规则配置/规则模板。质检任务、运行记录、告警订阅**已彻底删除**（含五张表、提示词 taskId、`App.tsx` 的 DS Provider）。`dq_rule_result` 保留为「结果留痕」：去 `run_id`、增 `batch_no`/`check_record_count`/`fail_record_count`；消费者 `DqExecutionService.resolveBaseline`、`AssetCatalogService.quality()`。
- **回传 `POST /quality/run/report` 路径刻意不变**（保 `DATAFORGE_QUALITY_REPORT_URL`）；实现换 `DqResultService`：解析 ruleId（显式 →「规则名+库+表」反查 → null）→ **表级读权限 fail-close** → 落一行。单测**非管理员须先造 SecurityContext**。
- **7 类规则类型契约不变**：`types/quality.ts::QUALITY_RULE_TYPES` ↔ SQL 种子 ↔ 提示词三方逐字一致，`template_code == rule_type`（`qualityContract.test.ts`、`df_sql_check.py` 守）。模板 `buildQualityTemplateSpec()` 只拼进 S3 提示词。**坑**：SQL 骨架含 `${}`，不能用 TS 模板字符串拼。
- **质检任务粒度 = 一张被校验表一个程序**：命名 `{分层}_{业务域}_{实体描述}_check_{执行周期}`，@依赖 只写产出该表的处理任务，跨表规则归**左侧主表**。「阻断下游」= 独立质量任务挂下游、**失败即非零退出**，平台**不反向改写调度状态**。S2 规则清单须按库.表分组**连续**书写——`qualityRuleImport.ts` 遇首个非 `|` 行即 break。

## 数据库脚本与方言（改 schema 必读）
- **无迁移阶段**：`init/*.sql` 是 schema 唯一来源。四方言 init 各 **41 表**，**无 Flyway**。顺序：`init/` 四方言 → `testdata/`（仅当涉及菜单/角色/授权）。参考数据放 init，菜单与授权只在 `testdata/dataforge-testdata-postgresql.sql`。
- **真目标只两个**：PostgreSQL 14（docker）、MySQL；**MariaDB/H2 连驱动都没有**。验证见 skill **`dataforge-sql-dialect-verification`**：`df_sql_check.py` → `verify_pg.sh`/`verify_mysql.sh`。
- **本机无 `psql`/`mysql` 客户端**；docker CLI 在 `/Applications/Docker.app/Contents/Resources/bin/docker`；JDBC 驱动 `/Users/mxq/Desktop/mysql-connector-j-8.0.33.jar`。**改完 SQL 必须重新切分再验证**；断言别写死数量。`init-dataforge.sh` 用 `ON_ERROR_STOP=0` → 验证时须改 `1`。
- **InnoDB 索引键上限 3072 字节**：`varchar(1024)` 建索引会**整张表建不出来**。
- ⚠️ `df_sql_check.py` 的 `KNOWN_DIALECT_DIFFS`：`indicators.code`/`indicators.id` 是**真实漂移**（独立修复任务），其余是方言表达差异。
- ⚠️ **真实部署容器 `dataforge-allinone` 常驻**（PG 5432/服务 8082/前端 3000/DS 12345）——验证只用一次性库（`df_sqlcheck_*`），收尾必须清理。
- ⚠️ **bash 陷阱**：`$VAR` 紧跟中文/全角标点会被并进变量名 → 一律写 `${VAR}`。

## 平台定位与商业模式（对外叙事必守）
- 核心目标：**让智能体正确理解业务数据**。四大组件 = dataforge（规范开发环境）/dataforge-server（库表+指标描述）/Marquez（血缘）/DolphinScheduler（任务依赖）；**listener 类是治理增强、可插拔，别抬高**。五类上下文 = 规范开发环境/库表描述/指标描述/血缘/任务依赖。
- **核心差异**：像 AI 编程助手，但**提需求的人不同**——编程助手是开发者提需求，DataForge 是**业务方提需求**（不懂 SQL）；≠ 编程助手，≠ DataWorks ⇒ **数据代开发服务**的技术基础。**软件企业内部免费、代码闭源**；收益 = 数据开发服务 + 集群运维服务。
- **需求闭环**：六角色含**业务需求方**与**数据架构师**；开发助手任务类型即角色（需求编写 → 数仓设计 → 数据开发，数据探索另一套）；契约唯一来源 `src/hooks/opencode/opencodeInstructions.ts`；**指标是唯一主线**，另四条同源线：数据时效/数据源名称/数据质量/敏感数据。`TaskRecord` 不记任务类型。
- **AI 能力落点**：**已落地** 6 工具组（compile/indicator-query/knowledge-document/lineage/metadata-agent/sql-validate）+ 元数据代理 `/metadata/agent/*`；**规划中** 自动化排障、数据价值评估、知识检索增强；**不做** 服务端统一推理入口。

## 交付偏好与 CSS 坑
- 性能类任务**诊断驱动**，先量化再改；交付含量化对比、变更表、决策理由、未改动项清单，附 `tsc --noEmit` 与 vitest 计数，新增逻辑配套单测。
- **计划书不出 Word**：交付物是 `output/<request_id>/stage3/…html`，**不设「风险识别与应对」章节**；结构 = 概述/需求/架构/组件/模块优先级/推广与时间/验收质量/预期效益/附录：现状基线。
- **sticky 表头别被「表格自身的滚动容器」吃掉**：`position: sticky` 只认**最近滚动容器**；`.ac-table` 圆角 + `overflow: hidden` ⇒ 表头跟内容滚走。修法 `.ac-ov-scroll .ac-table { overflow: visible; border-radius: 0; }`。长表头会撑宽整表（主区可用宽 ≈ 790px），列名保持短。项目**无全局 `box-sizing` reset**；`button`/`input` 不继承 `:root` 的 font-family 与 line-height。
