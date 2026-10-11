# DataForge 项目长期记忆

> 只留「跨会话必须记住、忘掉就出错」的**可执行规则**。过程见 `memory/YYYY-MM-DD.md`。

## 命令与环境
- vitest / tsc / vite 一律 `env -u NODE_OPTIONS`（否则 jsdom 导入 0.5s→96s）。
- **git 写操作不在本 agent shell 跑**（报成功却不落地）；只读安全。`dataforge`、`dataforge-server` 是两个仓库。
- **同一文件多处编辑串行**（并行 Edit 互相抹掉）；查并发写者 `find src -mmin -8`。
- macOS：`grep "a\|b"` 静默失败→用 `grep -E`；zsh 下 `--include` 报 no matches→用 Grep 工具。
- **回归基线（2026-10-11）**：前端 **70 文件 / 1152 例**；后端关心类 **118 例全过**。load 7~10 时 `waitFor` 超时属误报。
- 后端：`export JAVA_HOME=/opt/homebrew/opt/openjdk@17; mvn -o -q compile`；关心类
  `mvn -o test -Dtest='DqRuleApiContractTest,DqResultServiceReportTest,DqRuleRegisterTest,DqOverviewApiContractTest,QualityRuleTypeContractTest,DqSqlBuilderMatrixTest,AssetCatalogApiContractTest' -DfailIfNoTests=false`。
  沙箱里删不掉 `target/surefire*` 会报「命令被拦截」→ 按 `BUILD SUCCESS` / `Tests run: N, Failures: 0` 判定。
- **布局验证用真实浏览器**：playwright 1.58.2 在 `/Users/mxq/node_modules`、chromium 在 `~/Library/Caches/ms-playwright`；
  `NODE_PATH=/Users/mxq/node_modules /opt/homebrew/bin/node x.js`（`file://` + 真实 CSS，`getBoundingClientRect()` 量偏移）。别只读 CSS 猜。
- **改后端必须热更新容器**（否则前端「看起来没生效」）：`localhost:8082` = 容器 `dataforge-allinone` 的 jar →
  `docker cp <fatjar> dataforge-allinone:/opt/dataforge/dataforge-server.jar` + `docker exec dataforge-allinone supervisorctl restart dataforge-server`。
  ⚠️ 本 shell `mvn package` 的 repackage 必失败（`Unable to rename …jar.original`）→ rsync 到 `/tmp/dfbuild-src` 再 `mvn -o -q -DskipTests package`。
  ⚠️ 登录接口要**加密密码**，curl 登不进；验证后端走 psql 或 UI。

## 模型上下文窗口
- `deepseek-flash` = DeepSeek **V4.1** Flash，**1M**；判定里无 v3/v4 字样**只能显式列出**，否则掉进泛化 `deepseek`→128k；V4 系一律 1_000_000。改判定须同步单测。
- `GET /api/model` **必须带 location**；冷实例首次 `200 + data: []` ⇒ 必须重试。
- sidecar 由 app 托管（opencode，127.0.0.1:4096）；应用一关端口即拒连（502/refused 属正常）。

## 编码约定
- 代码头三字段 `@程序参数`/`@资源参数`/`@任务参数`，**取值是真实值**。两消费面：运行弹窗只取参数名（`extractProgramParams`）、提交调度取取值落 `taskParams`（`headerTaskParams.ts`）。改字段名/语义须同步：S3 提示词 → `parseFileHeader` → `HEADER_FIELDS` → 上述两处 → `PendingProgramRun` → 两个 Modal → 6 个测试文件。调度侧「任务参数」是 DS 概念，别跟着改。
- 工作流名**不 sanitize**、环境后缀**默认 test**；`_v{N}` 版本链已删；`mainJar` 不加必填校验。表单加必填项必须同步 `REQUIRED_PARAMS` 与单测。
- **x6 画布在 jsdom 下不可渲染**：只 mock `../dag/DagCanvas`；含 `useToast` 须包 `ToastProvider`。
- 提示词类 UI 不用原生 `title`（延迟 0.5~1s）→ 零延迟自定义 tooltip，面板内 `position:fixed`。
- 流式文本逐字增长不进 `messages`（走 ref + `subscribePartText`）。
- 开发助手切任务类型**不新建会话**（system 逐轮下发）；**数据探索例外**——`newSession()` 同时承担「新建时间戳工作目录」。
- **改一级菜单三连锁**：① `ActiveTab`/`MENU_CODE_MAP`/`App.tsx::FIRST_LEVEL_TAB_IDS` 同批改；② `FIRST_LEVEL_MENU_CODES` 由 MENU_CODE_MAP 派生；③ 菜单种子**只在 `sql/testdata/*.sql`**。
- **单文件提交调度 = 依赖只增不删**（用户 2026-10-11 定调）：任务**已存在** → 只更新该节点内容，依赖边一条不动、不重排全图坐标；**新增节点** → 原有边全保留，仅按代码头 `@依赖` **补齐**缺失边（跨工作流前置复用/补建专属 `前置依赖_{任务名}` 节点，已存在则只并入、按 `projectCode|definitionCode|depTaskCode` 去重）。实现 = `addMissingWorkflowDependencies()`（`utils/schedulerMapping.ts`），**不是** `reconcileWorkflowDependencies`（后者丢弃 target 全部入边 + 清孤儿 DEPENDENT 节点，**只给文件夹提交链路用**）。环校验只在「本轮确实加了边」时跑。**别再引入「扫本地全部代码文件后整体重建」的单文件路径**（`scanLocalHeaderDependencies` 已删）。

## 删除 / 回滚闸门
- 删除/回滚先过 `rollbackSafety.ts::assessRollbackSafety`；`root=null` 一律中止。
- 删除**走回收站**（`.dataforge-trash/` + manifest，须对 git 隐身），禁止直删；回收站≠备份。
- 保留策略 30 天 / 50 批 / 2 GiB（最新 2 批不清理）：`trashRetention.ts` 决策、`trashCleanup.ts` 执行。**新增「移入回收站」入口必须接 `scheduleTrashRetention`**。

## 事实核查基线（写文档前勿凭印象）
- **血缘与调度是桌面端直连上游**（`src/api/marquez.ts`、`dolphinscheduler.ts`）；服务端无 Marquez 客户端、不存产出任务副本。
- **租户不是数据隔离边界**（`sys_tenant_user` 1:1；资源表无 tenant_id）。
- **权限**：DML fail-close；行/列合并**取交集收紧**；约束在 **SQL 下发前改写**（`SqlPermissionRewriter`，Spark/Flink/HBase 已纳入）；资产目录的树/检索/详情服务端 fail-close 过滤 `sys_table_permission`（含列级）。残留：租户非隔离、只覆盖 SQL 代码类型（Scala/Python/Jar 不享行列约束）、超管短路。
- **列级脱敏是真实机制**（`full/idcard/phone/email/partial`，多角色取更严者），对智能体也生效；但无敏感数据自动识别，规则全靠人工配。
- **`cla:` 口径写死**：分级**只三档** 核心/重要/一般（GB/T 43697-2024）；分类**只六类** 个人信息/业务数据/经营数据/公共数据/运维数据/其他；写法 `cla:{分类}-{分级}`（表/字段注释尾部）。**个人信息默认「一般数据」**（旧口径「敏感字段不得低于重要」已废除；脱敏是独立维度，不得靠抬分级代替）。常量 `CLASSIFICATION_SPEC`，注入 S1/S2/S3。后端**无 `cla:` 解析器**。
- **凭据落盘已加密**（Electron `safeStorage`，信封 `{"$dfenc":"v1"}`），旧明文读时兼容；残留：设置页需明文回填、无 keyring 的 Linux 降级明文、换机器解不开；导出走 `df:store:export` 剥离。
- **提交有环境维度**：prod/gray/test（默认 test），**血缘只在 prod 注入**（`deployEnv.ts::shouldInjectLineage`）；拼装处 `src/utils/lineageParams.ts`（两入口共用）。**运行态数据只有测试环境**：`table_metadata` 仅 `*_olist_test` + `test_db`（38 张 test 后缀表）⇒ 环境切生产/灰度时看板为空是**正确结果**。
- **元数据缺失已可观测**（`MetadataAnnotationGapService` + `MetadataSyncAlertService`），勿写「静默滞后」。**资产分类不人工维护**：表名规范 `{分层}_{业务域}_{实体描述}_{刷新周期}` ⇒ 分层/业务域确定性解析，失败即「未分类」并自动成治理项。
- **库表授权「整库」=`sys_table_permission.table_names` 存 `"*"`**（不是全部表名、也不是空值）。`DataAccessPermissionService.parseTableNames/matchesTablePermission`：空值=整库可见、含 `*`=命中任意表；`getAccessibleTableNames` 含 `*` → 返回 `null`（消费方按「null=不限」）。**前端契约收敛在 `src/utils/tablePermissionScope.ts`**（`isWholeDatabaseSelection`/`supportsWholeDatabase`/`splitPerTableNames`/`validateTableSelection`/`normalizeScopeSelection`），表单有「全部表（整库授权）」开关；**`*` 只允许 scope=1**，切离 scope=1 清空选择；文案走 `describeTableSelection`。

## 资产管理模块
- 环境是**模块级**维度：切换器在页签条右侧（`AssetCatalogPanel` 持 state，`AssetOverviewTab` 受控只接 `env`），切一次即让**概况五块看板 + 目录树/检索/治理项/收藏一起重取**。默认生产（`ASSET_ENV_OPTIONS = DEPLOY_ENV_OPTIONS`，`DEFAULT_ASSET_ENV='prod'` ≠ `DEFAULT_DEPLOY_ENV='test'`）。
- 环境解析唯一实现 = 后端 `common/utils/DeployEnvParser`（原 `AssetEnvParser` 已迁移，metadata 模块也用）；`matches`：env 空/脏值=不过滤、**解析不出环境的名称在显式过滤时被排除**。后缀两套：**表类=库名**、**任务类（top-compute/task-delay）=工作流名**；过滤一律在权限之后。
- `/inventory/env-project` 不收窄（前端要全库分母算占比）；指标无环境维度，`/search` 指标命中不受 env 影响；`/bookmark` 指定 env 走内存分页；标注缺口下推 SQL `LIKE '%!_prod' ESCAPE '!'`（`_` 必转义）。
- **后端零 LLM、也不落后**：前后端路径全部对得上且是真实实现，**不存在「前端调了后端没写」**；缺口只在前端 UI。职责：`AssetCatalogPanel.tsx`=目录树+检索+收藏+治理项编排；`AssetDetailTabs.tsx`=详情页签；`AssetGovernanceEditor.tsx`=负责人/分类/标签/刷新元数据四个写操作；`useProbe.ts`=共用探测钩子。
- **`useProbe` 必须写 `Promise.resolve().then(loader)`**，否则 loader 同步抛错会在 effect 里冒泡成渲染错误。
- **埋点只上报有具体资产的动作**（选中表=browse / 预览=read / 新增收藏=bookmark）；服务端对 `assetId == null` 直接 `continue`；「检索」故意不上报。
- **分类/标签字典不可用时降级为只读**；标签接口是**整体替换**；写成功后宿主**重拉详情**，只有 `updateLifecycle` 就地回填。
- **坑**：`LambdaQueryWrapper.select(lambda...)` 构造期即解析列名，纯单测抛 `can not find lambda cache` → 只取几列用 `QueryWrapper.select("col1","col2")`。
- **坑**：整体替换 `api/assetCatalog` 的 mock 必须补 `ASSET_ENV_OPTIONS`/`DEFAULT_ASSET_ENV`；`AssetCatalogPanel.lifecycle.test.tsx` 用 `vi.mock` 整体替换该模块，面板新调方法要同步补 mock。

## 数据质量模块（2026-10-09 大改）
- **只剩 3 页签**：质量大盘/规则配置/规则模板。质检任务、运行记录、告警订阅**已彻底删除**（前端组件、服务端各层、五张表 `dq_task`/`dq_task_rule_rel`/`dq_run_instance`/`dq_alert_log`/`dq_alert_subscription`、提示词里 taskId 与告警描述、`App.tsx` 注入的 DS Provider）。
- **`dq_rule_result` 保留为「结果留痕」**：去 `run_id`，增 `batch_no`/`check_record_count`/`fail_record_count`。消费者：① `DqExecutionService.resolveBaseline`（按 rule_id 取 metric_value 做基线）；② `AssetCatalogService.quality()`（按规则取最近一条 + 同日归集，状态仍只 SUCCESS/FAILED）。
- **回传入口 `POST /quality/run/report` 路径刻意不变**（避免已部署环境的 `DATAFORGE_QUALITY_REPORT_URL` 失效），换成轻量 `DqResultService`：解析 ruleId（显式优先 →「规则名+库+表」三段反查 → 查不到落 null 不报错）→ **表级读权限 fail-close** → 落一行。DTO `QualityResultReportDTO`。单测 `DqResultServiceReportTest`：**非管理员用例必须先造 SecurityContext**。
- 大盘去掉 `passRateTrend`/`blockCount`，`projectCode` 入参移除，`topProblemTables` 直接聚合时间窗。规则登记不再有 `taskId`（`QualityRuleRegisterDTO` 已删，用 `QualityRuleSaveDTO`）；判定键仍是「规则名+库+表」，与回传反查逐字一致。
- **7 类规则类型契约不变**：`types/quality.ts::QUALITY_RULE_TYPES` ↔ SQL 种子 ↔ 提示词三方逐字一致，`template_code == rule_type`；`qualityContract.test.ts`、`df_sql_check.py` 在守它。
- 模板下发：`buildQualityTemplateSpec()` 仅拼进 S3 提示词，`useOpencodeChat` 发消息前拉取（模块级缓存 + in-flight 去重，**空结果不写缓存**）；`DqRuleService.bindTemplate` 已有「规则类型 → 内置模板自动绑定」。**坑**：SQL 骨架含 `${}`，不能用 TS 模板字符串拼。
- 「阻断下游」= 独立质量校验任务挂处理任务下游，**失败即非零退出**，平台**不反向改写调度状态**。
- **质检任务粒度 = 一张被校验表一个程序**：命名 `{分层}_{业务域}_{实体描述}_check_{执行周期}`，@依赖 只写产出该表的处理任务，跨表规则归**左侧主表**；禁止合并多表/跨分层。**别把「回传不单独建节点」读成「合并质检任务」**。S2 规则清单须按库.表分组**连续**书写——`qualityRuleImport.ts` 遇首个非 `|` 行即 break。

## 数据库脚本与方言（改 schema 必读）
- **无迁移阶段**：`sql/migrate/` 已删，**`init/*.sql` 是 schema 唯一来源**。四方言 init 各 **41 表**，**无 Flyway**。顺序：`init/` 四方言 → `testdata/`（仅当涉及菜单/角色/授权）。**参考数据放 init**（7 类规则模板 / 7 个分层分类 / 4 个默认资产标签），菜单与授权只在 `testdata/dataforge-testdata-postgresql.sql`。
- **真目标只两个**：PostgreSQL 14（docker）、MySQL（本地开发）；**MariaDB / H2 连驱动都没有**。**四方言结构一致**（不变量：同表列名/列序一致、类型跨方言等价）。验证见 skill **`dataforge-sql-dialect-verification`**：`df_sql_check.py` → `verify_pg.sh`/`verify_mysql.sh`。
- **本机无 `psql`/`mysql` 客户端**；docker CLI 在 `/Applications/Docker.app/Contents/Resources/bin/docker`；JDBC 驱动 `/Users/mxq/Desktop/mysql-connector-j-8.0.33.jar`。**改完 SQL 必须重新切分再验证**；断言别写死数量。`init-dataforge.sh` 用 `ON_ERROR_STOP=0`（吞错误）→ 验证时必改 `1`。
- **InnoDB 索引键上限 3072 字节**（utf8mb4 4 字节/字符）：`varchar(1024)` 建索引会**整张表建不出来**。
- ⚠️ `df_sql_check.py` 顶部 `KNOWN_DIALECT_DIFFS` 有 **10 处存量跨方言差异**：`indicators.code`/`indicators.id` 是**真实漂移**（独立修复任务），其余是方言表达差异。
- **真实部署容器 `dataforge-allinone` 常驻**（PG 5432 / 服务 8082 / 前端 3000 / DS 12345）——验证只用一次性库（`df_sqlcheck_*`），收尾必须清理，绝不指向它。
- ⚠️ **bash 陷阱**：`$VAR` 紧跟中文/全角标点会被并进变量名 → 一律写 `${VAR}`；自查正则 `\$(\w+)(?=[^\x00-\x7F])`。

## 平台定位与商业模式（对外叙事必守）
- 核心目标：**让智能体正确理解业务数据**。四大组件 = dataforge（规范开发环境）、dataforge-server（库表+指标描述）、Marquez（血缘）、DolphinScheduler（任务依赖）；**listener 类是治理增强、可插拔，别抬高**。五类上下文 = 规范开发环境 / 库表描述 / 指标描述 / 血缘 / 任务依赖。
- **核心差异（2026-09-15 用户定调，写文档必讲）**：类似 opencode / WorkBuddy 的 AI 编程助手，但**提需求的人不同**——编程助手是开发者提需求，DataForge 是**业务方提需求**（不懂 SQL）；≠ 编程助手，也 ≠ DataWorks（业务方在平台外提、由开发者转述）⇒ **数据代开发服务**成立的技术基础。**软件在企业内部免费、代码闭源**；收益 = 数据开发服务 + 集群运维服务。
- **需求闭环**：六角色含**业务需求方**与**数据架构师**；开发助手任务类型即角色：需求编写(BUSINESS_REQUESTER) → 数仓设计(DATA_ARCHITECT) → 数据开发(DATA_DEV_ENGINEER)（数据探索另一套）；三段产物同名贯穿，契约唯一来源 `src/hooks/opencode/opencodeInstructions.ts`；**指标是唯一主线**，另四条同源线：数据时效/数据源名称/数据质量/敏感数据。`TaskRecord` 不记任务类型。
- **AI 能力落点**：**已落地** 6 个工具组（compile / indicator-query / knowledge-document / lineage / metadata-agent / sql-validate）+ 元数据代理 `/metadata/agent/*`；**规划中** 自动化问题排障、数据价值评估、知识检索增强（现为 MyBatis-Plus `like`，无向量库）；**不做** 服务端统一推理入口。别一刀切标状态——一个目标常是「一半已落地 + 一半规划」。

## 交付偏好
- 性能类任务**诊断驱动**，先量化再改；交付含量化对比、变更表、决策理由、未改动项清单，附 `tsc --noEmit` 与 vitest 计数，新增逻辑配套单测。
- **计划书不出 Word**：`output/<request_id>/` 交付物是 `stage3/…html`，**不设「风险识别与应对」章节**；结构 = 一 概述 / 二 需求 / 三 架构 / 四 组件 / 五 模块优先级 / 六 推广与时间 / 七 验收质量 / 八 预期效益 / 九 附录：现状基线。真实残留边界放本文档，不写回计划书。生成脚本可用版在 `output/45d4b135-…/tools/`。
- **表格列名必须短（≤ 约 12 视觉字符）**：`thead th` 是 `white-space:nowrap`，长表头撑宽整张表（主区可用宽 ≈ 790px）；带枚举的列名拆成「短列名 + 导语里一句说明」。**对照表按「一项能力一行」，能力项与非能力项分表**：能力表 = 数据集成/数据治理/开发环境/作业调度/数据血缘/权限管理/任务管理/指标管理/知识管理（+ AI 能力落点）；形态与部署/引擎兼容/角色模型/设计取向/收费模式属「比较坐标」，另列一表。

## 布局与 CSS 坑
- **sticky 表头别被「表格自身的滚动容器」吃掉**：`position: sticky` 只认**最近的滚动容器**。`.ac-table` 为做圆角带了 `overflow: hidden` → 表格自己成容器，表头跟内容滚走（实测 -119px）。修法：`.ac-ov-scroll .ac-table { overflow: visible; border-radius: 0; }`（`border-collapse: collapse` **与此无关**）。**同类排查**：写 `sticky` 前确认「sticky 元素 → 最近滚动祖先」间没有 `overflow: hidden/auto`；全仓已有 13 处 `position: sticky`。
- **资产目录左右两栏「顶部工具带」必须等高 73px**，否则左栏「搜索行+视角行」的 `border-bottom` 与右栏 `.ac-main__header` 错开（改前实测 **18.5px**）。构成：左 10+30+5 + 27+1 = 73；右 16+22（标题行高显式写死 22，别继承 `:root` 1.5→22.5）+4+18+12+1 = 73。只在这两个选择器和 `.ac-viewbtn` 上调；改字号/内边距必须重算两者。
- 本项目**没有全局 `box-sizing` reset**；`button`/`input` 不继承 `:root` 的 font-family 与 line-height（走 UA 的 Arial + normal），故换字体栈时左栏行高不漂移。
