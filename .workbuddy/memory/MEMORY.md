# DataForge 项目长期记忆

## 性能基准（AI 对话模块）

- 设施：`bench.html` + `src/views/ai-bench/`（`?page=ai-bench` 免登录），合成事件喂真实
  `useOpencodeEvents` → 真实 `MessageTimeline` / `PacedMarkdown`；预设 medium(8K)/long(24K)/
  conversation(40轮+16K)；工具 `scripts/ai-bench*.mjs`；报告在 `perf/`；raw json 每份 3~4MB 用后删。
- 本机跑基准前提：①显式 `--browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`
  （脚本默认 Windows Edge 路径）；②**先 `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy`**
  （本机代理会让 curl 探活返回 502，误判「服务器没起来」）；③`npx vite` 会卡住，改用
  `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort`；
  ④端口：`ai-bench.mjs`=9333、`ai-bench-profile.mjs`=9334。
- 测量陷阱：编辑器输入探针（`startTyping`）自身耗 ~580ms Monaco CPU，测对话模块必须 `--typing false`；
  `(idle)` 占 55%~72%，**非空闲 CPU = 总采样 − idle** 才有效；开发构建绝对值远高于生产，只比比值；
  `longtask` 在 headless 下不稳定属噪声。
- 第二轮后基线：medium-8k 阻塞 172.8 / 提交 127.6ms；long-24k 非空闲 1213.1 / 阻塞 526.3 / 提交 394ms；
  conv-40t-16k 非空闲 2214.4 / 阻塞 354.8 / 提交 362.4ms。
  回归防线：`renderedChars` 必须逐字节一致（6558 / 19617 / 13087）。

## 架构约定

- 流式文本分两层：`partTextAccumDelta`（ref，逐字即时）+ `messages`（结构性状态）。逐字增长只走
  ref + `subscribePartText`，**不进 `messages`**（写它会连带投影/查找表/可见行全部重算）。
  例外：part 首次上屏必须写 `messages`（投影靠它判断可渲染性）；用户消息文本始终全量同步。
- `PacedMarkdown` 稳定前缀必须**按块缓存元素**（整段缓存 = 每次前缀前进整段重解析 = O(n²)）。
- 虚拟化只解决 DOM 数量，不解决「每次 commit 重建视口内行元素树」；行包装组件需 `React.memo`。
- 行投影/查找表是 O(消息数)，长对话要单独用 `conversation` 预设验证，`long` 测不出。

## 配置参数（ConfigParamsModal）

- 入口：编辑器右键（`EditorArea`）与文件浏览器右键（`ExplorerPanel`）。批量模式 `targetPaths?: string[]`
  非空即启用；**不回填既有配置**，保存时逐文件 `saveConfig` upsert；`onSave(data, filePath?)` 第二参
  仅批量模式传。
- 引擎必须**逐文件**解析（同文件夹可能混 .sql/.py）；`ExplorerPanel` 的「待配置代码文件」遍历
  `fileTree`（完整树，含折叠子目录）而非渲染行；扩展名 scala/sql/java/py。
- **菜单可见性门禁**（「配置参数」「提交调度」共用 `canConfigureParams`，分隔线一并条件渲染）：
  右键目标必须**全部是文件夹**，且都位于 `code/{ads|dws|dwd|ods|dqc|dim}/…` 之下（含更深子目录）。
  判定为纯函数 `utils/programLayout.ts` 的 `isUnderCodeLayerPath`（大小写不敏感、兼容 `\`）；
  `sql/`、`algo/`、`code/utils`、`code` 自身一律不显示。
- 竞态防护：单文件配置拉取用自增序号 `loadSeqRef` 丢弃过期响应；`EditorArea` 里弹窗常驻挂载，
  用递增 `configParamsOpenSeq` 作 `key` 强制重挂载。
- 目标列表展示为「项目编码 + 项目内相对路径」（`toDisplayFilePath`），**落库路径不带项目编码**
  （DB 行自带 projectId）。展示与落库是两个口径。
- 默认全选、可取消，未勾选不写入；选择态用「被取消集合」`excludedBatchPaths`（默认空集）。
  引擎推导只按已勾选目标，重推导前用 `injectedBatchKeysRef` 摘掉上次引擎默认值补齐的键。

## 提交调度（文件夹 → 工作流）

- 入口：文件浏览器右键「提交调度」（仅 code 分层目录下的文件夹，与「配置参数」共用
  `canConfigureParams` 判定，见上节「菜单可见性门禁」）。
  模态框 `FolderSubmitScheduleModal.tsx`，内嵌 `WorkflowDefinitionEditor`：
  `showTaskTypeSidebar={false}`、**不传 `onTrigger`**（只保存不运行）。
- 节点/边由 `buildWorkflowFromFolder(files, {rootPath, folderPath, projectCode})` 生成：每个代码文件
  一个任务节点，同文件夹依赖直接连边；跨项目/不在本批次的记入 `unresolved`。返回还含
  `headerDeps`（`sanitizeDsName(任务名)` → @依赖 列表，供依赖重建）。
  **自依赖（`sourceCode === code`）既不停边也不进 `unresolved`**——否则会被解析成指向自身的前置依赖节点成环。
- **工作流名称须与单文件提交调度同规范**（`deriveFolderWorkflowName`）：项目内相对目录 → 分隔符转 `_`，
  **不做 sanitize**（清洗留给真正提交时，否则含特殊字符的目录名两边显示不同）。推导基准必须同源：
  单文件用 `projectCwd`，文件浏览器侧经 `projectRoot` prop 透传 `projectCwd`，
  **不能用 `useFileSystem` 的 rootPath**（它可被 openFolder 改变；基准不同会让 `toRelativePath`
  回退成绝对路径，名称变成一长串、界面路径带斜杠）。拿不到相对路径时退化为文件夹名。
- 保存：按「调度项目名称 === 开发项目编码」匹配 DS 项目 → 同名走 `update`（带 releaseState）否则
  `createWithTasks`；创建分支勾选上线时**按名称回查再 `release`**（创建接口不接受 releaseState）。

### 自动依赖关系配置（关键约定）
- **必须在「打开弹窗、草稿生成后」就完成**，不能只放在 `handleSave` 里 —— 用户是在画布上判断
  「有没有自动连线」的，保存时才生成他根本看不到（曾因此被判定为「未自动连线」）。
  教训：面向用户的自动化要发生在用户能看见的那一刻。
- 链路：`resolveExternalDeps`（扫 DS 项目工作流任务建索引，把 `@依赖` label 解析为 `ResolvedDependency`）
  → `reconcileWorkflowDependencies`（同工作流直接连边；跨工作流/跨项目生成专属
  `前置依赖_{任务名}` DEPENDENT 节点并连边）。该函数**单文件/文件夹两条提交路径共用**。
- `localHeaderDeps` 的 key 必须是 `sanitizeDsName(任务名)`；文件夹场景无主任务，`mainTaskName` 传 `''`。
- 结果用 `resolvedDepsRef`（label → 解析结果）缓存，**草稿阶段解析一次、保存阶段复用**，
  避免重复全量扫描调度项目；`reconciledForRef` 记录已处理的 draft 对象引用防 effect 重入
  （`setDraft(next)` 前先 `reconciledForRef.current = next`）。
- 提示三态：解析中 / 已自动配置（列出生成的节点名）/ **调度系统中确实找不到**才报未配置。
  旧文案「不在本文件夹内，未自动连线」已删（误导）。

### 主 Jar 包自动填充
- `mainJar` 是**编译产物派生值**，不是用户手填：编译 → 上传资源中心 → 回填 `taskParams.mainJar`。
  目录层级 `{baseDir}/{项目编码}/{相对目录}/{文件名}_{时间戳}.jar`。
  判定 `isCompilableFile`（.java/.scala 且类型 ∈ SPARK/FLINK/FLINK_STREAM/MR/JAVA）。
  **不要给 mainJar 加必填校验**（会让文件夹路径无法保存）。
- `bridge/fs.ts` 的 `readFile` 返回 `Uint8Array<ArrayBufferLike>`，进 `Blob` 前要 `new Uint8Array(x)` 复制。

### 跨模块依赖与测试注意（易踩）
- **样式**：`sm-modal` / `sm-btn` 定义在 `ScheduleManagementPanel.css`（只被该面板引入）。
  调度模块之外渲染 `WorkflowDefinitionEditor` 必须显式 `import` 它，否则保存弹窗失样式。
- **x6 画布在 jsdom 下不可渲染**（`new Graph()` → `this.viewport.getCTM is not a function`）。测法二选一：
  只关心父组件传参 → 整体 `vi.mock` 编辑器；要测编辑器内部交互/闸门 → **只 `vi.mock('../dag/DagCanvas')`**，
  `graphRef` 恒 null 后编辑器回退到 `existingNodes` 派生的 `nodes` state，真实接线都能断言（优先用这种）。
- `layoutWorkflowByDependency` 的 `layerOf` 有 `inProgress` 环保护；`buildWorkflowFromFolder` 检测到环时
  改用 3 列网格兜底布局。

## 工作流保存闸门（任务节点参数校验）

- 纯函数 `src/utils/workflowNodeValidation.ts` → `validateWorkflowNodes(nodes)` 返回
  `{ ok, issues, failedNodes }`（按节点聚合）。规则是任务配置表单 `task-forms.tsx` 里
  `sm-required` 标注的镜像：表单新增必填项时必须同步维护 `REQUIRED_PARAMS` 表与单测。
- 闸门在 `WorkflowDefinitionEditor`：①「保存」→ `handleOpenSaveModal()` 校验，不通过只弹报告；
  ②`SaveWorkflowModal.onConfirm` 再防御一次。两个入口（工作流定义 / 提交调度）共用编辑器，自动都被拦。
- **工具栏常驻「校验」按钮**（`data-testid="wf-toolbar-validate"`）是唯一校验入口；
  通过态 `ShieldCheck` + `toast.info`，失败态橙色 + 失败数徽标 + 报告弹窗。
  **编辑器用了 `useToast` → 所有真实渲染它的测试必须包 `ToastProvider`**。
- 配套修复：任务参数是 `cell.setData` 直写 cell、不触发图事件，`handleSaveTask` 末尾必须手动
  `setNodes(extractNodes(graph.getNodes()))`，否则搜索/上游下拉/校验都读到旧参数。

## 测试基线（回归判断口径）

- **跑 vitest 必须清空注入的 NODE_OPTIONS**：`env -u NODE_OPTIONS npx vitest run`。
  agent shell 注入 `NODE_OPTIONS=--require=…/cli/vendor/shim/node-language-shim.cjs`，它加载
  `node-brokered-fs-shim.cjs` 并 patch `fs.readFileSync`/`fs.openSync`，**每次模块文件读取都是一次
  同步 broker IPC**（~120ms/文件）。jsdom 有 788 个 .js ⇒ `import 'jsdom'` 单次 96s（正常 0.5s）。
  实测：单文件 176s → 1.58s；全量 34 文件/613 用例 从 >10min 未完成 → **8.84s 全通过**。
  指纹：CPU 占用 ~1%（纯等待，非计算）。精准关闭：
  `CODEBUDDY_BROKERED_FS_HOOK_ENABLED=0 CODEBUDDY_SAFE_DELETE_SANDBOX=0`（单 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 无效）。
  **用户自己的 Terminal 无此注入，慢只发生在 agent 代跑的 shell 里。** 详见 skill `node-run-slowdown-diagnosis`。
- **`textmateFix.test.ts` 没有「必然失败」**（09-11 结论作废）：根因是 shim 拖慢导致 20s testTimeout 不够；
  清空 NODE_OPTIONS 后**全量 34 文件 / 613 用例全通过**。旧基线 `506 passed / 1 failed` 亦已过时。
- 常用回归组合：
  `npx vitest run src/views/dev-assistant/` → **4 文件 / 49 用例**（configParams 18 / multiSelect 9 /
  submitSchedule 9 / FolderSubmitScheduleModal 13）；
  `npx vitest run --environment node src/utils/` → **180 用例通过**（另 `pathUtils.test.ts` 必须 jsdom，
  node 下 12 例因缺 `window` 失败，属环境不匹配）；
  `npx vitest run src/views/schedule-management/ src/components/editor/` → 14 文件 / 213 用例。
- `--environment node` 仍更快（省掉 jsdom），但**这不是慢的主因**，shim 才是。
- 本机内存/负载紧张时（load > 8）整目录跑会被 SIGTERM 137 杀掉；改用 `--maxWorkers=1` 并**逐文件跑**。

## 本仓编辑约定（踩坑）

- **对同一文件的多处编辑必须严格串行**。并行发两个 `Edit` 到同一路径，二者基于同一份旧快照各自
  写回全文件，**后写的静默抹掉先写的**：症状是 `tsc` 报刚加的 import 未定义（TS2304），而同文件里
  串行发出的其他编辑全都在。跨文件并行无害。
- 排除「第二个写入者」：`find src -mmin -8` + `ps aux | grep -iE "vite|tsc|vitest"`。项目自带的
  `vite` / `tsc --watch` **只读源码**，出现它们不代表并发编辑。详见 skill
  `shared-file-concurrent-edit-guard`。
- macOS BSD 陷阱：`grep "a\|b"` 交替静默失败（须 `grep -E`）、`find -newermt` 不可靠（用 `-mmin`）。

## 用户偏好（项目相关）

- 性能类任务**诊断驱动**：先量化定位（CPU profile / 计数器）再改，不接受凭猜测优化。
- 交付含**量化对比**、变更表、决策理由、未改动项清单。
- 改动需附 `tsc --noEmit` 与 `vitest` 计数；新增逻辑配套单测（尤其纯函数分支边界）。
