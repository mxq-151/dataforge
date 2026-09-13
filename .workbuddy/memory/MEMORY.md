# DataForge 项目长期记忆

> 这里只放「跨会话必须记住、忘掉就会出错」的硬规则。**实现细节、函数名、行号、踩坑过程**见 skill
> `dataforge-project-conventions`；历史过程见 `.workbuddy/memory/YYYY-MM-DD.md`。别把细节往本文件里塞
> —— 超过注入上限会被截断。

## 命令与环境（必守）

- **跑 vitest / tsc / vite 一律 `env -u NODE_OPTIONS`**（agent shell 的 broker fs shim 会让 jsdom 导入从
  0.5s 变 96s，指纹是 CPU ~1% 纯等待）。用户自己的 Terminal 无此注入。
- **同一文件的多处编辑必须串行**：并行两个 `Edit` 各基于旧快照写回全文件，后写者静默抹掉先写者。
  查并发写者 `find src -mmin -8`。
- macOS 陷阱：`grep "a\|b"` 会静默失败，须 `grep -E`。
- 回归基线（2026-09-13 12:00 全量）：**48 文件 / 797 例全绿**。
- 测试大面积失败先看 load：load≈7~10 时 `FolderSubmitScheduleModal` 的 `waitFor` 会超时误报，
  **load 回落即过**。

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
- `extractProgramParams`：`@程序参数` → 进预填行；`@任务参数` → 只列出告知、不下发；两者**只收参数名**。
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
- **快照结构新增字段必须同步单测。**

## 交付偏好

- 性能类任务**诊断驱动**：先量化定位再改，不接受凭猜测优化。
- 交付含**量化对比**、变更表、决策理由、**未改动项清单**；改动附 `tsc --noEmit` 与 `vitest` 计数，
  新增逻辑配套单测（尤其纯函数分支边界）。
