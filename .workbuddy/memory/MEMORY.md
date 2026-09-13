# DataForge 项目长期记忆

> 只放「跨会话必须记住、忘掉就会出错」的规则。过程细节/一次性排查见 `.workbuddy/memory/YYYY-MM-DD.md`。

## 环境与命令（必守）

- **跑 vitest / tsc / vite 一律 `env -u NODE_OPTIONS`**：agent shell 注入的 broker fs shim 让每次
  `readFileSync` 变成一次同步 IPC，jsdom 788 个文件 ⇒ `import 'jsdom'` 从 0.5s 变 96s。
  指纹：CPU 占用 ~1%（纯等待）。用户自己的 Terminal 无此注入。详见 skill `node-run-slowdown-diagnosis`。
- 回归基线（2026-09-13 全量复跑）：**42 文件 / 734 例**（09-12 为 725 例；本模块口径 =
  `src/utils/programArgs.test`(45) + `ProgramRunModal.test`(21) + `useProgramRunner.test`(12) +
  `fileHeader.test`(22)）。
- load 高时加 `--testTimeout=60000`：`FolderSubmitScheduleModal` 的「外部 @依赖」用例在 load≈7~10 时
  会 `waitFor` 超时（`createWithTasks` 0 次调用）。**与本模块无引用关系（`programArgs`/`useProgramRunner`
  只被 DevAssistantView 链引用），已用 `git stash push <paths>` 在改动前状态对比排除；load 回落即过。**
- 本机跑对话性能基准：显式 `--browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`、
  先 `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy`、用
  `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort`（`npx vite` 会卡），
  端口 ai-bench=9333 / profile=9334，测对话模块必须 `--typing false`（输入探针自身耗 ~580ms）。
- **同一文件的多处编辑必须串行**：并行两个 `Edit` 各自基于旧快照写回全文件，后写的静默抹掉先写的。
  排除并发写者：`find src -mmin -8`。macOS 陷阱：`grep "a\|b"` 交替静默失败，须 `grep -E`。

## 上下文使用量 / 模型元数据（2026-09-13 起）

- 进度条分母来自 `hooks/opencode/modelContextLimit.ts`（纯函数表 + `resolveContextLimit` 取
  API 与硬编码较大值）与 `useOpencodeClient.fetchModelContextLimit`。**改模型判定必须同步单测**。
- `deepseek-flash` = DeepSeek **V4.1** Flash（界面显示 `ds-v4.1`），**1M 窗口**；判定里既没有
  `v3` 也没有 `v4` 字样，**只能显式列出**，否则掉进泛化 `deepseek` → 128k（曾致进度条 142%）。
  DeepSeek V4 系一律 **1_000_000**，不要写 1_048_576（Math.max 会让分母虚高）。
- **`GET /api/model` 必须带 location**（`location[directory]=…`，SDK 同时写 header/query），
  且**冷实例首次查询会返回 `200 + data: []`**（自愈），所以查询要重试，不能「查一次就回落硬编码」。
  传不存在的目录会 500（`FileSystem.realPath NotFound`）。
- 真相源速查：app 配置 `~/Library/Application Support/com.dataforge/opencode-config.json`
  （key=`config`）；sidecar `127.0.0.1:4096` 的 `/config`、`/provider`、`/api/model`；
  服务端日志 `~/.local/share/opencode/log/opencode.log`；官方窗口口径 `https://models.dev/api.json`。
  **sidecar 由 app 托管，应用一关端口就拒连**（此时 502/refused 属正常，不是故障）。
- 提示类 UI **不要用原生 `title`**（悬停延迟 0.5~1s）：改用 hover 零延迟的自定义 tooltip，
  且 `.ai-panel{overflow:hidden}` 会裁剪绝对定位，需 `position:fixed`（祖先链无 transform，
  相对视口安全）。仍未改造：`AIPanel` 头部「压缩」按钮等其它 `title=`。

## 提交调度 / 配置参数

- **菜单可见性门禁**（「配置参数」「提交调度」共用 `canConfigureParams`，分隔线一并条件渲染）：
  右键目标必须**全是文件夹**且位于 `code/{ads|dws|dwd|ods|dqc|dim}/…` 之下（含更深子目录）。
  纯函数 `utils/programLayout.ts::isUnderCodeLayerPath`（大小写不敏感、兼容 `\`）。
- 配置参数：批量模式 `targetPaths` 非空启用；**不回填既有配置**；逐文件 `saveConfig` upsert；
  引擎必须**逐文件**解析；展示路径带项目编码、落库路径不带。
- **「运行程序」必须先弹 `ProgramRunModal` 确认程序参数再执行**，参数形态是**键值对逐行编辑**
  （与「配置参数 → 配置程序参数」同形态，2026-09-12 由单行文本改过来；后端只收
  `runParams` 键值对）。换算与校验收口在 `utils/programArgs.ts`：`paramsFromItems`（**空参数名的行
  整行丢弃**、同名后者生效、值一律字符串）、`findRowsMissingKey` / `findDuplicateKeys`（弹窗提示
  「会被忽略 / 后者生效」，不静默）、`toParamRows`（预填复制 + 新 id，保证重开时行元素重挂载）。
  语义是**所见即所发**：确认内容整体替换已保存配置、不回写落库；删光即不带参数（`{}` → `runParams: undefined`）。
- **参数名提取**（`extractProgramParams(content, codeType)`）：v3 代码头把参数拆成两个字段 ——
  `@程序参数`（程序自身入参 → `keys`，进预填行）、`@任务参数`（引擎/资源参数 → `taskParamKeys`，
  只列出告知、不下发 runParams），**无该类参数时写「无」**；两者写法同为 `--参数名 取值`，
  只收参数名**不收取值**（那是示例值）。SQL 另取正文 `${day}`（Java/Scala/Python 正文 `${}` 是日志模板不是入参）。
  `@程序参数` 是**显式声明即分类结果**，不再按引擎二次剔除。旧字段 `@用法` 仅保留解析兼容
  （`header.usage`，弹窗显示「@用法（旧格式，建议拆成 @程序参数 / @任务参数）」提示迁移），
  新旧字段并存时一并解析、不丢参数。`parseFileHeader` 映射：`@程序参数`→`programArgs`、`@任务参数`→`taskArgs`；
  生成模板 `utils/index.ts::HEADER_FIELDS` 已换成这两个字段（不再产出 `@用法`）。
  弹窗把识别到的名字并成空白行（`mergeExtractedKeys`，已存在的按名去重、无缺失时返回原数组）+
  「从代码提取」按钮补回误删行；扫描前先 `stripSqlComments`（保留字符串字面量），`$[yyyyMMdd]` 不误判。
  **提示词侧已同口径**（S3「SQL 开发规范」→「变量编写规范」）：变量须为纯标识符（`[A-Za-z_][\w.\-]*`）、
  只算**正文语句**里的 `${}`（注释内不算）、须与 `@程序参数` **同名**（逐字、大小写敏感、按名去重）、
  日期不得用 `$[yyyyMMdd]`、引用保留引号（`dt = '${day}'`）；`fileHeader.test.ts` 有守卫用例
  （提示词片段存在 + SQL 样例 `keys === ['day']` + 反例写法不被误收）。**提示词里不得新增
  ```sql/java/scala/python 围栏块**——`promptSamples()` 会把它们当代码头样例断言。
- **引擎参数表（`isEngineParamFlag`）现在只服务旧格式 `@用法` 的兼容拆分**（SPARK 的
  `--master/--deploy-mode/--class/--num-executors/--driver-memory/--conf…`、FLINK 的
  `-c/-p/-m/-yjm/-ytm/-ys…` 与 `-Dk=v`）：v3 由 `@任务参数` 显式声明，落在 `taskParamKeys` 里由弹窗
  列出告知去向（**不静默丢**），不进预填行。**只按显式 `@引擎` 判定**，kyuubi/hive/python 等不剔除
  （避免误伤同名参数）；`-checkpoint` 是程序自己的入参，**不在**剔除表里（规范样例就这么写）。
  「本地运行」(`RunLocalModal`/`PendingLocalRun.defaultArgs`) 仍是单行文本、保持裸 `--k v`（本地 args 是数组、不经 shell）。
- 工作流名称：项目内相对目录 → 分隔符转 `_`，**不 sanitize**（清洗留给提交时）；环境后缀
  `withDeployEnvSuffix`（prod/gray/test，**默认 test**，只拼后缀）。**`_v{N}` 版本链已整体删除**，
  名称恒带后缀 ⇒ DS 里无后缀/`_v1` 工作流不再匹配、重复提交会新建。推导基准必须同源用
  `projectCwd`（**不能**用 `useFileSystem` 的 rootPath，否则退化成绝对路径一长串）。
- 文件夹弹窗头部：副标题 `{调度项目名称} 工作流名称：{名}`，徽标 `{draft?.nodes.length ?? fileCount} 个任务节点`
  （含自动生成的「前置依赖_x」节点）；**环境单选放在副标题行内**，顺序 `📁名称 → 环境 → N 个任务节点`；
  草稿未就绪先用 `deriveFolderWorkflowName` 推导避免闪路径；内嵌编辑器传 `hideToolbarHeader`（左侧保留空占位）。
- **自动依赖必须在「打开弹窗、草稿生成后」就完成**（用户在画布上看有没有连线，保存时才生成他看不到）：
  `resolveExternalDeps` → `reconcileWorkflowDependencies`（跨工作流/项目生成专属 `前置依赖_{任务名}` DEPENDENT 节点）。
  `resolvedDepsRef` 缓存（草稿解析一次、保存复用）、`reconciledForRef` 防 effect 重入；
  `localHeaderDeps` 的 key = `sanitizeDsName(任务名)`；**自依赖既不停边也不进 `unresolved`**（否则成环）。
- 「应用名称」`{project}.{workflow}.{task}`（`utils/appName.ts`，只改 SPARK/FLINK/MR，值未变返回同一对象）；
  `{workflow}` 用**带环境后缀的最终名**；**只有两个提交入口生效**，调度管理传空 → 保持历史值可编辑。
- `mainJar` 是编译产物派生值（编译→上传→回填），**不要加必填校验**（会让文件夹路径无法保存）。

## 工作流保存闸门

- 纯函数 `utils/workflowNodeValidation.ts::validateWorkflowNodes(nodes)` 是 `task-forms.tsx` 里
  `sm-required` 的镜像 —— 表单加必填项必须同步 `REQUIRED_PARAMS` 与单测。
- 闸门：`handleOpenSaveModal()` + `SaveWorkflowModal.onConfirm` 双重防御；手动入口是工具栏「校验」
  按钮（`data-testid="wf-toolbar-validate"`，`!readonly && !hideToolbarValidate`，**调度管理不显示、
  文件夹提交调度保留**）。编辑器用了 `useToast` ⇒ **真实渲染它的测试必须包 `ToastProvider`**。
- 任务参数是 `cell.setData` 直写、不触发图事件 ⇒ `handleSaveTask` 末尾必须手动
  `setNodes(extractNodes(graph.getNodes()))`，否则搜索/上游下拉/校验读到旧参数。

## 测试与画布（易踩）

- **x6 画布在 jsdom 下不可渲染**（`new Graph()` → `viewport.getCTM is not a function`）。
  只关心父组件传参 → 整体 `vi.mock` 编辑器；要测编辑器内部交互/闸门 → **只 `vi.mock('../dag/DagCanvas')`**
  （`graphRef` 恒 null，编辑器回退到 `existingNodes` 派生的 `nodes`，真实接线都能断言，优先用这种）。
- `sm-modal` / `sm-btn` 定义在 `ScheduleManagementPanel.css`（只被该面板引入），调度模块之外渲染
  `WorkflowDefinitionEditor` 必须显式 `import`，否则保存弹窗失样式。
- 单文件弹窗 `SubmitToSchedulerModal`：底部按钮事件挂在 **onMouseDown**（`fireEvent.click` 不触发）；
  任一选择项变化会清空校验结果且项目列表异步回填 ⇒ 断言可用性要**反复点校验**。

## AI 对话性能架构

- 流式文本两层：`partTextAccumDelta`（ref，逐字）+ `messages`（结构态）。逐字增长**不进 `messages`**
  （写它会连带投影/查找表/可见行全量重算），走 ref + `subscribePartText`；例外：part 首次上屏必须
  写 `messages`；用户消息文本始终全量同步。
- `PacedMarkdown` 稳定前缀必须**按块缓存元素**；行包装组件需 `React.memo`；虚拟化不解决「每次 commit
  重建视口行元素树」；行投影/查找表是 O(消息数)，长对话要单独用 `conversation` 预设验证。
- 基线：medium-8k 阻塞 172.8 / 提交 127.6ms；long-24k 非空闲 1213.1 / 阻塞 526.3 / 提交 394ms；
  conv-40t-16k 非空闲 2214.4 / 阻塞 354.8 / 提交 362.4ms。回归防线：`renderedChars` 必须逐字节一致
  （6558 / 19617 / 13087）。非空闲 CPU = 总采样 − `(idle)` 才有效；开发构建只比比值不比绝对值。

## 回滚 / 删除安全闸门（2026-09-13 工作区清空事故后）

- **事故**：`handleRollback` 拿到「空快照」（拍摄时文件树未装载 ⇒ `root=null`、`files={}`），
  把「待删除集合」放大成全部现存文件，`fs.remove` 直删 test_project 的 71 个已提交文件。
  判据：磁盘只剩 83 字节 `.git`（`buildFileTree` 过滤 `.` 开头 ⇒ `.git` 是唯一幸存者）。
- 闸门在纯函数 `utils/rollbackSafety.ts::assessRollbackSafety`：`no-snapshot` /
  `untrusted-snapshot`（`snapshot.root === null`，**本次根因**）/ `root-mismatch` 一律中止；
  `mass-deletion`（`toDelete/current >= 0.5` 且 `current >= 4`）要 `window.confirm` 后带 `force` 重跑。
  快照结构已改成 `{ root, files }`，**新增字段必须同步单测**。
- 删除改走**回收站**：`useFileSystem.trashNode` → `rename` 到 `<root>/.dataforge-trash/<stamp>/<原相对路径>`，
  并在批次目录写 `_manifest.json`（渲染层日志不落 `main.log`，这是唯一审计痕迹）。
  `gitDiscardFiles` 的 untracked/added 同样走回收站，不再 `remove`。
- **回收站必须对 git 隐身**（否则 `?? .dataforge-trash/` 会让 `syncWorktreeWithRemote` 的
  「工作区必须干净」前置失败、自动同步静默失效，还可能被 `git add -A` 提交进去）：
  `utils/workspaceTrash.ts::ensureTrashIgnored` 写 `info/exclude`。**实测（git 2.50.1）：
  链接工作树解析到的 `info/exclude` 是主仓库共享那一份，不是 per-worktree** —— 影响范围是
  该仓库下所有工作树，因目录名固定所以可接受，但不要当成项目隔离。
- 工作树自愈：`restoreMissingWorktreeFiles` 判据从「目录为空」改成 `isMassFileLoss`（` D ` 计数，
  阈值：全空必恢复；否则 `>=5` 个且 `>=50%`），且必须在 `syncWorktreeWithRemote` **之前**调用
  （后者见 status 非空即跳过）。只删一两个文件不该被「自动还原」。
- 恢复：`git -C <worktree> checkout -- .`（index 干净时无损）。若报 `index.lock: File Exists`，
  先 `ps aux | grep [g]it` + `lsof` 确认无持有者，再把 0 字节陈旧锁 **`mv` 走**（不要 `rm`）。

## 用户偏好（项目相关）

- 性能类任务**诊断驱动**：先量化定位再改，不接受凭猜测优化。
- 交付含**量化对比**、变更表、决策理由、**未改动项清单**。
- 改动需附 `tsc --noEmit` 与 `vitest` 计数；新增逻辑配套单测（尤其纯函数分支边界）。
