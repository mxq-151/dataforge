---
name: dataforge-project-conventions
description: DataForge（Tauri + React 数仓开发平台）项目的实现细节与踩坑约定。当任务涉及提交调度、**定时调度/Schedule/Quartz crontab**、**角色准入（超级管理员/运维人员）**、配置参数、程序参数提取、工作流保存闸门、x6 画布测试、AI 对话面板、回滚/删除安全闸门、opencode sidecar 或模型上下文窗口判定时加载本 skill 获取准确的函数名、文件行号与既有约定。
agent_created: true
---

# DataForge 项目实现约定

配套 `memory/MEMORY.md`（只放必须记住的硬规则）。本文件放「具体怎么做、为什么这么做」的细节。
路径均相对仓库根 `/Users/mxq/Desktop/dataforge`。

## 1. 环境与命令

- **跑 vitest / tsc / vite 一律 `env -u NODE_OPTIONS`**。agent shell 注入的 broker fs shim 让每次
  `readFileSync` 变一次同步 IPC，jsdom 788 个文件 ⇒ `import 'jsdom'` 从 0.5s 变 96s。
  指纹：CPU 占用 ~1%（纯等待）。用户自己的 Terminal 无此注入。
  详见 skill `node-run-slowdown-diagnosis`。
- 回归基线（2026-09-13 15:50 全量复跑）：**52 文件 / 861 例**（48 文件 / 797 例为 12:00 的旧基线）。
  其中 `src/views/dev-assistant/FolderSubmitScheduleModal.test.tsx` 的「外部 @依赖」例在
  **load 9.86**（落在下面那条 7~10 误报区）时也复现超时；已用 `git stash push -u` 在**原始状态**
  复跑确认同样失败 ⇒ 是 load 误报，不是回归。**下结论前先 `uptime` 看 load。**
- load 高时加 `--testTimeout=60000`。`FolderSubmitScheduleModal` 的「外部 @依赖」用例在 load≈7~10 时
  `waitFor` 超时（`createWithTasks` 0 次调用）。该文件与 `programArgs` / `useProgramRunner` 无引用关系
  （后者只被 DevAssistantView 链引用），已用 `git stash push <paths>` 在改动前状态对比排除；load 回落即过。
  **结论：load 高会误报，先看 load 再怀疑代码。**
- 对话性能基准跑法：显式 `--browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`；先
  `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy`；用
  `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort`（`npx vite` 会卡住）。
  端口：ai-bench=9333 / profile=9334。测对话模块必须 `--typing false`（输入探针自身耗 ~580ms）。
- **同一文件的多处编辑必须串行**：并行两个 `Edit` 各自基于旧快照写回全文件，后写的静默抹掉先写的。
  排除并发写者：`find src -mmin -8`。
- macOS 陷阱：`grep "a\|b"` 会交替静默失败，必须 `grep -E`。

## 2. 上下文使用量 / 模型元数据

- 进度条分母来自 `src/hooks/opencode/modelContextLimit.ts`（纯函数表 + `resolveContextLimit`：取 API 值与
  硬编码值的较大者）与 `useOpencodeClient.tsx::fetchModelContextLimit`。**改模型判定必须同步单测。**
- `deepseek-flash` = DeepSeek **V4.1** Flash（界面显示 `ds-v4.1`），**1M 窗口**。判定里既没有 `v3` 也没有
  `v4` 字样，**只能显式列出**，否则掉进泛化 `deepseek` → 128k（曾致进度条 142%）。
  DeepSeek V4 系一律 **1_000_000**，不要写 1_048_576（`Math.max` 会让分母虚高）。
- **`GET /api/model` 必须带 location**（`location[directory]=…`，SDK 同时写 header/query）。
  且**冷实例首次查询会返回 `200 + data: []`**（自愈），所以查询要重试，不能「查一次就回落硬编码」。
  传不存在的目录会 500（`FileSystem.realPath NotFound`）。
- 真相源速查：
  - app 配置 `~/Library/Application Support/com.dataforge/opencode-config.json`（key = `config`）
  - sidecar `127.0.0.1:4096` 的 `/config`、`/provider`、`/api/model`
  - 服务端日志 `~/.local/share/opencode/log/opencode.log`
  - 官方窗口口径 `https://models.dev/api.json`
  - **sidecar 由 app 托管，应用一关端口就拒连**（此时 502/refused 属正常，不是故障）。
- 提示类 UI **不要用原生 `title`**（悬停延迟 0.5~1s）：改用 hover 零延迟的自定义 tooltip；且
  `.ai-panel{overflow:hidden}` 会裁剪绝对定位，需 `position:fixed`（祖先链无 transform，相对视口安全）。
  仍未改造：`AIPanel` 头部「压缩」按钮等其它 `title=`。

## 3. 任务类型 / 会话上下文

- **系统指令是逐轮下发的，不固化在会话里**：
  - `src/hooks/opencode/useOpencodeChat.ts:70` 每次 `sendMessage` 重算
    `getDeveloperInstructions(roleType, username, moduleId)`
  - 同文件 `:96` 作为 `session.prompt` 的 **body.system** 传给服务端
    （SDK `SessionPromptData.body.system?: string`，见 `@opencode-ai/sdk/dist/gen/types.gen.d.ts:2253`）
  - `roleType` 由 `useOpencodeClient.tsx:710` 用 `taskType || roleType` 注入
- SDK `UserMessage` 类型带 `agent / model / system / tools` ⇒ 每条用户消息**存下**自己那轮的 system 快照。
- **但服务端只取「最后一条用户消息」的 system**（2026-09-13 读 opencode 源码核实，勿再误判为「按轮回放」）：
  `packages/opencode/src/session/llm/request.ts::prepare()` 里

  ```ts
  const system = [[
    ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
    ...input.system,                          // 现场由 sys.* / instruction 组装
    ...(input.user.system ? [input.user.system] : []),   // ← 只有 lastUser
  ].filter(x => x).join("\n")]
  ```

  `input.user` 就是 `lastUser`（`prompt.ts` 的 runLoop 传入），历史消息的 `.system` **不参与**请求组装；
  随后 `messages` 把这段 system 作为 `role:"system"` 前置。`processor.ts` 只把 `LLM.StreamInput` 原样透传，
  不碰 system。⇒ **角色指令是「追加」在默认 agent prompt 之后，且只对当前这一轮生效**，
  中途换角色不会污染历史轮次 —— 「保留上下文换角色」在机制上无障碍。DataForge 的角色提示词确实生效。
- **现状（2026-09-13 起）**：`AIPanel.tsx:154-158 handleTaskTypeChange` 只 `setTaskType(newType)`，
  **不再新建会话** ⇒ 上下文保留、新角色从下一轮生效。`data-explore` 例外：仍调 `newSession()`
  （该模块提示词按 moduleName 短路、与 roleType 无关，且 `newSession` 承担「新建时间戳工作目录」语义）。
  需要真正开一段全新对话时走头部「新建会话」按钮（`SessionSwitcher.onNewSession`，`AIPanel.tsx:314`）。
  配套单测：`AIPanel.taskType.test.tsx`(6) + `useOpencodeChat.test.ts`(3)。
- `resetState`（`useOpencodeEvents.ts:356`）**只清本地、不删服务端会话**，旧对话仍在任务历史里可切回。
- **已知遗留（未修，属提示词语义变更，改动前需确认）**：`getDeveloperInstructions`
  （`opencodeInstructions.ts:687`）对 `_moduleName === "data-explore"` 提前
  `return getDataAnalystInstructions(username)`，**绕过 roleType 判定** ⇒ 数据探索选「运维管理」
  （SUPER_ADMIN）拿到的仍是数据分析指令，`SUPER_ADMIN_INSTRUCTIONS` 从该模块不可达。
- 切类型**只换 `system` 文本，不传 `agent`** ⇒ 工具集与审批策略不随类型变。
- `TaskRecord` 只有 `sessionId/title/createdAt/updatedAt`（`useOpencodeClient.tsx:32`），**不记任务类型**；
  标题取首条消息前 80 字（`useOpencodeChat.ts:77`）⇒ 想做「同会话换角色」必须补类型标记，否则历史不可辨。
- 数据探索下 `handleNewSession` 还负责**新建时间戳工作目录**（`useOpencodeClient.tsx:1181-1195`，会话=标签页）
  ⇒ 那里的类型切换不能照搬开发助手的「不新建会话」改法，否则两个会话共用一个目录。
- 若改成「同会话换角色」，需接受的副作用：provider 侧 prefix cache 失效（切换后首轮 input 全价、
  `contextUsage.cache.read` 归零重算）；`session.summarize` 会把跨角色历史压成一份摘要、角色边界模糊。

## 4. 提交调度 / 配置参数

- **菜单可见性门禁**（「配置参数」「提交调度」共用 `canConfigureParams`，分隔线一并条件渲染）：
  右键目标必须**全是文件夹**且位于 `code/{ads|dws|dwd|ods|dqc|dim}/…` 之下（含更深子目录）。
  纯函数 `src/utils/programLayout.ts::isUnderCodeLayerPath`（大小写不敏感、兼容 `\`）。
- 配置参数：批量模式 `targetPaths` 非空启用；**不回填既有配置**；逐文件 `saveConfig` upsert；
  引擎必须**逐文件**解析；展示路径带项目编码、落库路径不带。
- **「运行程序」必须先弹 `ProgramRunModal` 确认程序参数再执行**。参数形态是**键值对逐行编辑**
  （与「配置参数 → 配置程序参数」同形态，2026-09-12 由单行文本改过来；后端只收 `runParams` 键值对）。
  换算与校验收口在 `src/utils/programArgs.ts`：
  - `paramsFromItems`：**空参数名的行整行丢弃**、同名后者生效、值一律字符串
  - `findRowsMissingKey` / `findDuplicateKeys`：弹窗提示「会被忽略 / 后者生效」，不静默
  - `toParamRows`：预填复制 + 新 id，保证重开时行元素重挂载
  - 语义是**所见即所发**：确认内容整体替换已保存配置、不回写落库；删光即不带参数
    （`{}` → `runParams: undefined`）。

### 参数名提取 `extractProgramParams(content, codeType)`

- v3 代码头把参数拆成两个字段：
  - `@程序参数` → 程序自身入参 → `keys`，进预填行
  - `@任务参数` → 引擎/资源参数 → `taskParamKeys`，只列出告知、不下发 runParams
  - **无该类参数时写「无」**；两者写法同为 `--参数名 取值`，只收参数名**不收取值**（那是示例值）。
- SQL 另取正文 `${day}`。Java/Scala/Python 正文里的 `${}` 是日志模板，不是入参。
- `@程序参数` 是**显式声明即分类结果**，不再按引擎二次剔除。
- 旧字段 `@用法` 仅保留解析兼容（`header.usage`，弹窗显示「@用法（旧格式，建议拆成 @程序参数 / @任务参数）」
  提示迁移）；新旧字段并存时一并解析、不丢参数。
- `parseFileHeader` 映射：`@程序参数`→`programArgs`、`@任务参数`→`taskArgs`；生成模板
  `src/utils/index.ts::HEADER_FIELDS` 已换成这两个字段（不再产出 `@用法`）。
- 弹窗把识别到的名字并成空白行（`mergeExtractedKeys`，已存在的按名去重、无缺失时返回原数组）+
  「从代码提取」按钮补回误删行；扫描前先 `stripSqlComments`（保留字符串字面量），`$[yyyyMMdd]` 不误判。
- **提示词侧已同口径**（S3「SQL 开发规范」→「变量编写规范」）：变量须为纯标识符
  （`[A-Za-z_][\w.\-]*`）、只算**正文语句**里的 `${}`（注释内不算）、须与 `@程序参数` **同名**
  （逐字、大小写敏感、按名去重）、日期不得用 `$[yyyyMMdd]`、引用保留引号（`dt = '${day}'`）。
  `fileHeader.test.ts` 有守卫用例（提示词片段存在 + SQL 样例 `keys === ['day']` + 反例写法不被误收）。
  **提示词里不得新增 ```sql/java/scala/python 围栏块** —— `promptSamples()` 会把它们当代码头样例断言。
- **`isEngineParamFlag` 只服务旧格式 `@用法` 的兼容拆分**（SPARK 的 `--master/--deploy-mode/--class/
  --num-executors/--driver-memory/--conf…`、FLINK 的 `-c/-p/-m/-yjm/-ytm/-ys…` 与 `-Dk=v`）：
  v3 由 `@任务参数` 显式声明，落在 `taskParamKeys` 里由弹窗列出告知去向（**不静默丢**），不进预填行。
  **只按显式 `@引擎` 判定**，kyuubi/hive/python 等不剔除（避免误伤同名参数）；
  `-checkpoint` 是程序自己的入参，**不在**剔除表里（规范样例就这么写）。
  「本地运行」（`RunLocalModal` / `PendingLocalRun.defaultArgs`）仍是单行文本、保持裸 `--k v`
  （本地 args 是数组、不经 shell）。

### 工作流名称与依赖

- 名称：项目内相对目录 → 分隔符转 `_`，**不 sanitize**（清洗留给提交时）；环境后缀
  `withDeployEnvSuffix`（prod/gray/test，**默认 test**，只拼后缀）。
  **`_v{N}` 版本链已整体删除**，名称恒带后缀 ⇒ DS 里无后缀 / `_v1` 工作流不再匹配、重复提交会新建。
  推导基准必须同源用 `projectCwd`（**不能**用 `useFileSystem` 的 rootPath，否则退化成绝对路径一长串）。
- 文件夹弹窗头部：副标题 `{调度项目名称} 工作流名称：{名}`，徽标
  `{draft?.nodes.length ?? fileCount} 个任务节点`（含自动生成的「前置依赖_x」节点）；
  **环境单选放在副标题行内**，顺序 `📁名称 → 环境 → N 个任务节点`；草稿未就绪先用
  `deriveFolderWorkflowName` 推导避免闪路径；内嵌编辑器传 `hideToolbarHeader`（左侧保留空占位）。
- **自动依赖必须在「打开弹窗、草稿生成后」就完成**（用户在画布上看有没有连线，保存时才生成他看不到）：
  `resolveExternalDeps` → `reconcileWorkflowDependencies`（跨工作流/项目生成专属
  `前置依赖_{任务名}` DEPENDENT 节点）。`resolvedDepsRef` 缓存（草稿解析一次、保存复用）、
  `reconciledForRef` 防 effect 重入；`localHeaderDeps` 的 key = `sanitizeDsName(任务名)`；
  **自依赖既不停边也不进 `unresolved`**（否则成环）。
- 「应用名称」`{project}.{workflow}.{task}`（`src/utils/appName.ts`，只改 SPARK/FLINK/MR，值未变返回同一
  对象）；`{workflow}` 用**带环境后缀的最终名**；**只有两个提交入口生效**，调度管理传空 → 保持历史值可编辑。
- `mainJar` 是编译产物派生值（编译→上传→回填），**不要加必填校验**（会让文件夹路径无法保存）。

## 5. 工作流保存闸门

- 纯函数 `src/utils/workflowNodeValidation.ts::validateWorkflowNodes(nodes)` 是 `task-forms.tsx` 里
  `sm-required` 的镜像 —— 表单加必填项必须同步 `REQUIRED_PARAMS` 与单测。
- 闸门：`handleOpenSaveModal()` + `SaveWorkflowModal.onConfirm` 双重防御；手动入口是工具栏「校验」按钮
  （`data-testid="wf-toolbar-validate"`，`!readonly && !hideToolbarValidate`，**调度管理不显示、
  文件夹提交调度保留**）。编辑器用了 `useToast` ⇒ **真实渲染它的测试必须包 `ToastProvider`**。
- 任务参数是 `cell.setData` 直写、不触发图事件 ⇒ `handleSaveTask` 末尾必须手动
  `setNodes(extractNodes(graph.getNodes()))`，否则搜索/上游下拉/校验读到旧参数。

## 6. 测试与画布（易踩）

- **x6 画布在 jsdom 下不可渲染**（`new Graph()` → `viewport.getCTM is not a function`）。
  只关心父组件传参 → 整体 `vi.mock` 编辑器；要测编辑器内部交互/闸门 → **只 `vi.mock('../dag/DagCanvas')`**
  （`graphRef` 恒 null，编辑器回退到 `existingNodes` 派生的 `nodes`，真实接线都能断言，优先用这种）。
- `sm-modal` / `sm-btn` 定义在 `ScheduleManagementPanel.css`（只被该面板引入），调度模块之外渲染
  `WorkflowDefinitionEditor` 必须显式 `import`，否则保存弹窗失样式。
- 单文件弹窗 `SubmitToSchedulerModal`：底部按钮事件挂在 **onMouseDown**（`fireEvent.click` 不触发）；
  任一选择项变化会清空校验结果且项目列表异步回填 ⇒ 断言可用性要**反复点校验**。

## 7. AI 对话性能架构

- 流式文本两层：`partTextAccumDelta`（ref，逐字）+ `messages`（结构态）。逐字增长**不进 `messages`**
  （写它会连带投影/查找表/可见行全量重算），走 ref + `subscribePartText`；例外：part 首次上屏必须
  写 `messages`；用户消息文本始终全量同步。
- `PacedMarkdown` 稳定前缀必须**按块缓存元素**；行包装组件需 `React.memo`；虚拟化不解决「每次 commit
  重建视口行元素树」；行投影/查找表是 O(消息数)，长对话要单独用 `conversation` 预设验证。
- 基线：medium-8k 阻塞 172.8 / 提交 127.6ms；long-24k 非空闲 1213.1 / 阻塞 526.3 / 提交 394ms；
  conv-40t-16k 非空闲 2214.4 / 阻塞 354.8 / 提交 362.4ms。回归防线：`renderedChars` 必须逐字节一致
  （6558 / 19617 / 13087）。非空闲 CPU = 总采样 − `(idle)` 才有效；开发构建只比比值不比绝对值。

## 8. 回滚 / 删除安全闸门（2026-09-13 工作区清空事故后）

- **事故**：`handleRollback` 拿到「空快照」（拍摄时文件树未装载 ⇒ `root=null`、`files={}`），
  把「待删除集合」放大成全部现存文件，`fs.remove` 直删 test_project 的 71 个已提交文件。
  判据：磁盘只剩 83 字节 `.git`（`buildFileTree` 过滤 `.` 开头 ⇒ `.git` 是唯一幸存者）。
- 闸门在纯函数 `src/utils/rollbackSafety.ts::assessRollbackSafety`：`no-snapshot` /
  `untrusted-snapshot`（`snapshot.root === null`，**本次根因**）/ `root-mismatch` 一律中止；
  `mass-deletion`（`toDelete/current >= 0.5` 且 `current >= 4`）要 `window.confirm` 后带 `force` 重跑。
  快照结构已改成 `{ root, files }`，**新增字段必须同步单测**。
- 删除改走**回收站**：`useFileSystem.trashNode` → `rename` 到
  `<root>/.dataforge-trash/<stamp>/<原相对路径>`，并在批次目录写 `_manifest.json`
  （渲染层日志不落 `main.log`，这是唯一审计痕迹）。`gitDiscardFiles` 的 untracked/added 同样走回收站。
- **回收站必须对 git 隐身**（否则 `?? .dataforge-trash/` 会让 `syncWorktreeWithRemote` 的
  「工作区必须干净」前置失败、自动同步静默失效，还可能被 `git add -A` 提交进去）：
  `src/utils/workspaceTrash.ts::ensureTrashIgnored` 写 `info/exclude`。
  **实测（git 2.50.1）：链接工作树解析到的 `info/exclude` 是主仓库共享那一份，不是 per-worktree** ——
  影响范围是该仓库下所有工作树，因目录名固定所以可接受，但不要当成项目隔离。
- 工作树自愈：`restoreMissingWorktreeFiles` 判据从「目录为空」改成 `isMassFileLoss`（` D ` 计数，
  阈值：全空必恢复；否则 `>=5` 个且 `>=50%`），且必须在 `syncWorktreeWithRemote` **之前**调用
  （后者见 status 非空即跳过）。只删一两个文件不该被「自动还原」。
- 恢复：`git -C <worktree> checkout -- .`（index 干净时无损）。若报 `index.lock: File Exists`，
  先 `ps aux | grep [g]it` + `lsof` 确认无持有者，再把 0 字节陈旧锁 **`mv` 走**（不要 `rm`）。

## 9. 定时调度（DolphinScheduler Schedule）

入口在 `views/schedule-management/components/ProjectDetailView.tsx` 工作流列表行内的「定时」按钮
（原为 `setError('定时功能开发中...')` 占位）。实现三件套：
`components/ScheduleModal.tsx`（弹窗）、`utils/crontab.ts`（Quartz 表达式纯函数）、
`utils/roleAccess.ts`（角色准入）。

### 准入：只有超级管理员与运维人员

- **唯一真源** `src/utils/roleAccess.ts`：
  `PLATFORM_ADMIN_ROLE_NAMES` = `ROLE_ADMIN / ADMIN / SUPER_ADMIN / 超级管理员 /`
  `ROLE_OPS_ENGINEER / OPS_ENGINEER / 运维工程师`；`hasPlatformAdminRole(roles)`（大小写不敏感）；
  `canManageSchedule(user)` = `isSuperAdmin || hasPlatformAdminRole(roles)`。
  **`dev-assistant/ProjectList.tsx` 已改为复用这里**（原先自带一份同内容数组 + `canManageProject()`，
  别再复制第三份）。
- 门禁是**双重防御**：父组件按钮 `disabled` + `title` 写原因（沿用 ProjectList「无删除权限」的
  既有模式，**弹窗内再拦一次提交**）。
- `ProjectDetailView` 现在 `useAuth()`；它的测试（`ScheduleManagementPanel.*.test.tsx`）必须
  `vi.mock('../../contexts/AuthContext')`，否则 `useAuth` 抛错。

### API（DS 3.2 的 form-data 风格 v1 接口）

`src/api/dolphinscheduler.ts::schedule`，全都走既有的 `dsRequest`：

| 动作 | 端点 | 关键点 |
|---|---|---|
| 查已有 | `GET /projects/{pc}/schedules` | 带 `workflowDefinitionCode` 过滤；**一个工作流只应有一条** |
| 新建 | `POST /projects/{pc}/schedules` | form-data |
| 更新 | `PUT /projects/{pc}/schedules/{id}` | 同新建参数 |
| 删除 | `DELETE /projects/{pc}/schedules/{id}` | |
| 上/下线 | `POST .../{id}/online` `.offline` | |
| 预览 | `POST .../schedules/preview` | JSON body = `ScheduleParam` |

form-data 的组装在 `buildScheduleFormData()`：**「生效区间+crontab+时区」四项打包成
`schedule` JSON 串**，其余字段平铺。踩坑：
- 优先级字段是 **`workflowInstancePriority`**（3.2 改名），不是 `processInstancePriority`；
- `environmentCode` 用「不传」表达默认环境，别传 -1；
- `tenantCode` 必须显式传（DS 缺省会取当前用户名）；
- preview 的返回形态跨版本不一致（`Result.data` / 裸数组 / `data.totalList`），
  已在 API 层归一化成 `DolphinSchedulerResponse<string[]>`。
- **DS 硬约束**：定时上线要求关联工作流已上线（否则 `WORKFLOW_DEFINITION_NOT_RELEASE`）；
  重复创建返回 `SCHEDULE_ALREADY_EXISTS`；**启用状态下改 crontab 可能被拒，需先停用**。
  前两条已拦下并提示，第三条只做非阻断提示。

### crontab 是 Quartz 方言，不是 Linux 5 段

`src/utils/crontab.ts`（纯函数，可放心加边界用例）：
`parseCrontab / validateCrontab / describeCrontab / nextFireTimes / isLocallyComputable /
defaultScheduleRange / validateScheduleRange / formatScheduleDateTime / zonedParts`。

- 6 或 7 段（秒 分 时 日 月 周 [年]）；**周字段 1=周日**（JS `getDay()` 是 0=周日，差 1）；
- **「日」「周」必须有一个写 `?`**，且不能同时为 `*` —— Quartz 硬约束，照搬 Linux crontab 必踩；
- 只支持 `* ? , - /` 与日字段 `L`；`W` / `#` / `nL` **语法接受但置 `needsServerPreview`**，
  `nextFireTimes` 直接返回空数组（宁可让用户去问 DS，也不本地算错时间），由弹窗引导到
  「从调度系统预览」；
- 时区：`Intl.DateTimeFormat.formatToParts` 取墙上时间（`hourCycle:'h23'`，别用 `hour12:false`
  单独控制，会出现 24 点），非法时区名回退本地时区而不是抛错。
- **性能坑（必读）**：逐分钟空转会被「2 月 30 日」这类永不成立的表达式放大到 **2.5s**（输入框实时
  预览直接卡 UI）。现改为**日期不匹配时按天跳到目标时区次日 00:00**，最坏 366 次迭代，
  整个测试文件从 2.5s → 78ms。两个必须守住的细节：
  1. `wallTimeToUtc()` 迭代逼近时 **偏差必须带上时分秒一起比对**（`Date.UTC(y,m,d,h,mi,s)`）。
     只比日期会「看起来已收敛」，返回值整体偏移一个时区偏移量 —— 曾让跳跃落到当天 08:00、
     漏掉凌晨触发点；
  2. 跨年那一刻**不能用 `+24h` 硬跳**，否则会越过年初的触发点（用例：`0 0 0 1 1 ? 2027`）。

### 弹窗约定

- 表单状态用 `DSScheduleForm`（扁平视角），打包成 DS 参数的动作只在 API 层做。
- 逐字符**不发请求**（与 `SearchBar` 一致）：本地校验/描述/预览走纯函数；
  「从调度系统预览」按钮才调 `schedule.preview`，并把结果标为「来源：调度系统」。
- `data-testid`：`schedule-crontab / schedule-warning-type / schedule-warning-group /
  schedule-save / schedule-status / cron-desc / cron-preview`（表单里 select 多，靠 testid 断言才稳）。
- 通知策略非「都不发」时**必须选告警组**（保存按钮禁用）；选「都不发」则提交时
  `warningGroupId` 置 null。默认区间「立即生效 + `2099-12-31 23:59:59`」。
- 样式：基础类在 `ScheduleManagementPanel.css`（要显式 import），定时专有的在
  `components/ScheduleModal.css`。该弹窗**不用 `useToast`**，测试无需 `ToastProvider`。
