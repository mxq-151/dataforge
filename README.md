# DataForge

面向数据开发的一体化桌面端平台，基于 **Electron + React 19 + TypeScript** 实现，内置 **AI 开发助手（opencode）**、**Monaco 代码编辑器 + LSP 智能提示（Java / Scala）**、数据探索、指标管理、知识库、文件浏览、调度管理（DolphinScheduler）、数据血缘（Marquez）与系统管理等能力。

本仓库是 **DataForge 的桌面客户端**，需要配套的服务端与集群侧组件才能发挥完整能力：

| 组件 | 仓库 / 位置 | 作用 |
| --- | --- | --- |
| `dataforge` | 本仓库 | 开发者工作台：AI 助手、编辑器、数据探索、调度提交、血缘查看 |
| `dataforge-server` | `dataforge-docker/dataforge-server` | 元数据与权限中台：统一身份与多级权限、数据源与存储、库表元数据、指标、知识库、审计 |
| `spark-listener` | 独立仓库 | Spark 写入合规闸门：分析期拦截违规写入 |
| `flink-listener` | 独立仓库 | Flink 写入合规闸门：提交前拦截违规写入 |

## 功能特性

- **AI 开发助手**：集成 opencode 服务，支持多模型切换、工具调用（命令执行 / 文件编辑 / 网络检索 / 任务 / Skill 等）、沙箱执行、权限审批与交互式问答；支持会话切换、任务历史回溯与不同任务类型的角色化系统指令。
- **Monaco 编辑器**：基于 `@codingame/monaco-vscode-*` 系列实现 VS Code 级编辑体验（TextMate 语法高亮、主题、快捷键），支持 Java / Scala / SQL / Markdown 等语言。
- **LSP 智能提示**：通过 WebSocket 桥接 **JDT.LS（Java）** 与 **Metals（Scala）**，提供悬停、定义跳转（含依赖源码）、补全、诊断；支持 `jdt://` / `metals:` 类文件源码查看。
- **编译与 SQL 校验**：本地编译服务（Maven 编译 Java / Scala、SQL 语法校验），供 AI 助手与编辑器调用；编译前自动生成 Maven 工程配置。
- **数据探索**：数据源与库表浏览、表字段明细、SQL 编辑与执行、执行历史、结果集可视化（ECharts 图表分析）。
- **指标管理**：指标体系维护，支持跳转到数据血缘查看关联字段。
- **知识库**：企业知识文档管理（分类、检索）。
- **文件浏览**：两条独立通道——开发助手内的工作区文件管理，以及独立的分布式文件浏览器，支持 **HDFS / JuiceFS / S3 / 本地** 存储的浏览、新建目录、重命名、上传、下载与预览，并管理存储配置与连接测试。
- **调度管理**：对接 DolphinScheduler，管理工作流定义（含 DAG 画布）、任务配置、调度配置、任务实例与运行实例；提交调度时把代码头声明的参数落地到任务节点。
- **数据血缘**：对接 Marquez，图谱化展示表级与字段级血缘关系。
- **系统管理**：用户、角色、权限、租户、操作日志。
- **设置**：后端地址、LLM 模型、Java / Scala / Maven 环境、Git、外部系统连接、沙箱开关等集中配置。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Electron 44 |
| 渲染层 | React 19、Vite 8、TypeScript 7 |
| 编辑器 | Monaco Editor（`@codingame/monaco-vscode-api` / `-editor-api` / `-extension-api` 25.1.2、`@monaco-editor/react` 4.7.0）、`monaco-languageclient` 10.7.0 |
| AI 服务 | `@opencode-ai/sdk` 1.18.30，本地进程 `127.0.0.1:4096` |
| 图可视化 | `@xyflow/react` 12.11.3；调度 DAG 另用 `@antv/x6` 1.35.1 + `@antv/layout` |
| 图表 | ECharts 6.1（执行结果的图表分析） |
| 其它 | `react-markdown` + `remark-gfm`、`@tanstack/react-virtual`、`lucide-react`、`ws`、`adm-zip`、`crypto-js` |

> 渲染层通过 [src/bridge/](src/bridge/) 与 Electron 主进程通信（IPC 封装文件系统、Shell、HTTP、Store、路径、事件等能力），**无任何 `@tauri-apps/*` 依赖**。

## 架构概览

```
┌──────────────────────────────────────────────────────────┐
│                   渲染进程（React + Monaco）              │
│  开发助手 · 数据探索 · 编辑器 · 调度 · 血缘 · 系统管理 …   │
└──────────────┬──────────────────────────┬────────────────┘
               │ preload（contextIsolation）│ REST（业务后端）
┌──────────────▼──────────────┐   ┌────────▼──────────────────┐
│        Electron 主进程       │   │  dataforge-server          │
│  ┌────────────────────────┐ │   │  <backendHost>             │
│  │ opencode 服务（沙箱）    │ │   │  DolphinScheduler /        │
│  │ compile 编译服务        │ │   │  Marquez                   │
│  │ LSP 桥（JDT.LS/Metals） │ │   └───────────────────────────┘
│  └────────────────────────┘ │
└─────────────────────────────┘
```

- **主进程**（[electron/](electron/)）：窗口管理、IPC 注册、服务生命周期管理。
  - [backend/opencode.ts](electron/backend/opencode.ts)：启动 / 监督 / 终止 opencode 本地服务，固定监听 `127.0.0.1:4096`；macOS 用 `sandbox-exec`、Linux 用 `bubblewrap` 沙箱包装（bubblewrap 不可用时回退非沙箱并告警）；退出时优雅清理进程与 SQLite 锁文件。
  - [backend/compileServer.ts](electron/backend/compileServer.ts)：本地编译 HTTP 服务（随机端口 + Token 鉴权），端点经 `DATAFORGE_COMPILE_PORT/TOKEN` 环境变量注入 opencode。
  - [backend/lspBridge.ts](electron/backend/lspBridge.ts)：将 JDT.LS / Metals 子进程 stdio 转为 WebSocket，供前端 `monaco-languageclient` 使用。
  - [backend/compile.ts](electron/backend/compile.ts) / [maven.ts](electron/backend/maven.ts) / [lspPom.ts](electron/backend/lspPom.ts) / [localRun.ts](electron/backend/localRun.ts)：Maven 工程生成（pom.xml / bloop）与 Java / Scala 编译、本地运行。
- **渲染层**（[src/](src/)）：React 视图 + `src/api/`（业务后端 REST 封装）+ `src/hooks/opencode/`（opencode SDK 客户端、会话、事件、文件审查）+ `src/services/lsp/`（语言客户端与 Monaco provider 注册）+ `src/services/textmate/`（TextMate 语法）+ `src/features/execHistory/`（执行历史与图表分析）。

## 目录结构

```
dataforge/
├── electron/            # Electron 主进程
│   ├── main.ts          # 窗口创建（原生标题栏）、服务启动、退出清理
│   ├── ipc.ts           # IPC 命令注册（opencode / 编译 / LSP / 文件系统等）
│   ├── preload.ts       # 预加载脚本（contextIsolation）
│   ├── eventBus.ts      # 主进程 → 渲染层事件桥
│   └── backend/         # opencode、compileServer、lspBridge、compile、maven、lspPom、localRun、store、platform、logger、serviceEndpoints
├── public/
│   ├── grammars/        # TextMate 语法定义（java / scala / sql / markdown 等）
│   └── wasm/onig.wasm   # 正则引擎（oniguruma）
├── resources/
│   ├── sandbox/         # macOS 沙箱 profile（opencode-macos.sb）
│   ├── jdtls/           # JDT.LS（未入库，需单独准备）
│   ├── metals/          # Metals / coursier（未入库，需单独准备）
│   └── binaries/        # opencode 平台二进制（未入库，需单独准备）
├── scripts/             # AI 流式渲染性能基准与对比脚本
└── src/
    ├── bridge/          # 渲染层 ↔ 主进程 IPC 桥接（fs / shell / http / store / path / event）
    ├── api/             # 业务后端 REST API 封装
    ├── components/      # AI 面板、编辑器、布局（ActivityBar / TitleBar）、模态、Toast 等
    ├── contexts/        # Auth / DataSource / DolphinScheduler 上下文
    ├── features/        # 执行历史与结果图表分析
    ├── hooks/           # opencode 客户端、LSP、编译、SQL 补全、程序运行等
    ├── services/        # lsp / textmate / compileService / opencodeLifecycle / unifiedCompile
    ├── types/           # 类型定义（含 opencode-backend 配置类型）
    ├── utils/           # 工具函数（文件头解析、参数映射、调度映射、校验等）
    └── views/           # 各功能视图（见下表）
```

视图一览（`src/views/`）：

| 视图 | 说明 |
| --- | --- |
| `dev-assistant` | 开发助手（工程列表、文件浏览器、提交调度、Git、文件历史、指标抽取） |
| `data-explore` | 数据探索（库表浏览、字段明细、SQL 编辑器、结果集） |
| `schedule-management` | 调度管理（项目、工作流定义编辑器、DAG 画布、任务与实例详情） |
| `data-lineage` | 数据血缘 |
| `indicator-management` | 指标管理 |
| `knowledge-base` | 知识库 |
| `file-browser` | 分布式文件浏览器与存储配置管理 |
| `system-management` | 用户 / 角色 / 权限 / 租户 / 操作日志 |
| `settings` | 集中设置 |
| `login` | 登录与后端地址选择 |
| `editor-test` | 编辑器调试页（无需登录） |
| `ai-bench` | AI 流式渲染性能基准页 |

## 环境要求

- **Node.js 20+**（含 npm）
- **JDK 17+**（配置到设置页 `JAVA_HOME`）
- **Maven**（`MAVEN_HOME`）——Java / Scala 编译与 LSP 工程生成依赖
- **Scala**（可选，Scala 工程使用，`SCALA_HOME`）
- **opencode 二进制**：`resources/binaries/opencode`（或平台 triple 命名，如 `opencode-darwin-arm64` / `opencode-darwin-x64` / `opencode-windows-x64.exe` / `opencode-linux-x64`）；开发模式会依次从 `resources/binaries/` → PATH 查找
- **LSP 服务器资源**（体积较大，未纳入 Git）：
  - `resources/jdtls/` —— JDT.LS（Java），需包含 `plugins/org.eclipse.equinox.launcher_*`
  - `resources/metals/` —— `metals.jar` 或 `coursier.jar`（Scala / Metals）
  - 以上资源需单独准备至 `resources/` 对应目录，详见 [package.json](package.json) 的 `extraResources`
- **业务后端服务**：`dataforge-server`（见"与后端对接"一节），并提供 DolphinScheduler / Marquez 服务地址与 Token

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 开发模式（vite dev server + tsc watch + electron）
npm run dev

# 3. 仅构建
npm run build            # = build:main（主进程 tsc）+ build:renderer（vite）
```

开发模式说明：

- `dev:renderer`：Vite 开发服务器，端口 `5173`（`strictPort`）。
- `dev:main`：主进程 TypeScript 增量编译到 `dist-electron/`。
- `dev:electron`：等待产物就绪后以 `VITE_DEV_SERVER_URL` 启动 Electron。

## 构建与打包

```bash
npm run pack    # 构建 + electron-builder --dir（生成未打包目录 release/）
npm run dist    # 构建 + electron-builder（生成 dmg / zip 安装包）
```

打包要点（见 [package.json](package.json)）：

- 产物输出到 `release/`；`asar: false`
- `extraResources` 会带上 `sandbox`、`jdtls`、`metals` 以及当前平台的 `binaries/opencode`
- 目标格式：macOS `dmg` + `zip`（`hardenedRuntime` + entitlements）、Windows `nsis`、Linux `AppImage` + `deb`
- macOS 使用原生标题栏（`hiddenInset`），Windows / Linux 使用 `titleBarOverlay`

> `resources/metals/`、`resources/jdtls/`、`resources/binaries/` 体积较大，已加入 [.gitignore](.gitignore) 不入库，需在构建机 / 运行环境单独准备。

## 启动方式

### 方式一：启动打包产物（推荐）

```bash
# macOS：pack 产物为 release/mac/DataForge.app；dmg 安装后从启动台启动
npm run pack
open release/mac/DataForge.app

# Windows / Linux
npm run pack
release/win-unpacked/DataForge.exe        # Windows
release/linux-unpacked/dataforge          # Linux
```

### 方式二：基于源码产物直接启动（无需打包）

```bash
npm run build            # 生成 dist-electron/（主进程）与 dist/（渲染层）
npx electron .           # 等价于 npm run start
```

> `npx electron .` 会使用项目本地安装的 Electron 读取 `package.json` 的 `main` 字段（`dist-electron/main.js`）启动；由于直接以 `file://` 加载 `dist/index.html`（无 Vite 开发服务器），必须先执行 `npm run build`。

## 与后端对接

- 登录页填写的是**服务根地址，不含 `/api`**（客户端在 `src/api/` 内自行拼接 `/api/...`）。该值保存在配置的 `backendHost`，默认留空，由用户填写。
- 典型地址：
  - 本地直接运行 `dataforge-server`：`http://localhost:8083`
  - 使用 All-in-One 容器：`http://localhost:8082`
- 非 localhost 地址要求 HTTPS。
- 登录成功后令牌保存在会话层（`src/session.ts`），随请求以 `Authorization: Bearer <token>` 携带。

## 配置说明

应用配置存储于用户数据目录（`opencode-config.json`、`secure-store.json`），主要配置项见 [src/types/opencode-backend.ts](src/types/opencode-backend.ts)：

| 配置 | 说明 |
| --- | --- |
| `backendHost` | 业务后端服务根地址（非 localhost 地址要求 HTTPS） |
| `llmModels` / `model` / `apiKey` | LLM 模型与密钥（支持多 provider，可在 AI 面板内切换） |
| `javaHome` / `scalaHome` / `mavenHome` | Java / Scala / Maven 环境路径 |
| `cwd` | 基础工作目录，自动计算为 `$HOME/.dataforge/{后端host}/{用户名}/` |
| `gitRepoUrl` / `gitRepoDirName` / `gitSshKeyPath` | Git 仓库同步（启动时自动 clone / pull） |
| `permissionMode` | AI 工具权限模式：`auto`（每次询问）/ `accept`（全允许）/ `reject`（全拒绝） |
| `dolphinSchedulerApiUrl` / `token` | DolphinScheduler 连接（调度管理） |
| `marquezApiUrl` / `openlineageTransportUrl` | Marquez / OpenLineage 连接（数据血缘） |
| `pomTemplate` / `scalaVersion` / `mavenGroupId` / `mavenArtifactId` | Maven 工程模板与坐标 |
| `maxTurns` | AI 助手最大轮次 |
| `enableSandbox` | 是否以沙箱模式运行 AI 助手（默认开启） |

## 主进程环境变量

主进程启动 opencode 时会注入以下变量（`electron/backend/`）：

| 变量 | 用途 |
| --- | --- |
| `DATAFORGE_API_HOST` / `DATAFORGE_AUTH_TOKEN` | 业务后端地址与鉴权令牌，供 AI 工具调用平台接口 |
| `DATAFORGE_COMPILE_PORT` / `DATAFORGE_COMPILE_TOKEN` | 本地编译服务端点与令牌 |
| `DATAFORGE_JDTLS_PATH` / `DATAFORGE_METALS_PATH` | 语言服务器资源路径 |
| `DATAFORGE_DISABLE_SANDBOX=1` | **开发逃生阀**：跳过沙箱启动（受限终端 / 调试环境使用，桌面正常启动不受影响） |

## 调试页面入口

无需登录、不依赖后端服务，通过 URL 参数或 hash 进入：

| 入口 | 用途 |
| --- | --- |
| `?page=editor-test`（或 hash `#editor-test`） | 单独调试 `src/components/editor` 模块 |
| `?page=ai-bench`（或 hash `#ai-bench`） | AI 流式渲染性能基准 |

## 测试与性能基准

```bash
npm test                 # vitest run（单元测试）
npm run test:watch       # vitest watch

npm run bench:ai              # 跑 AI 流式渲染基准，输出 perf/bench.json
npm run bench:ai:before       # 改动前基线 → perf/before.json
npm run bench:ai:after        # 改动后 → perf/after.json
npm run bench:ai:report       # 对比 before / after 生成报告
npm run bench:ai:profile      # 长文本预设的性能剖析
npm run bench:ai:profile:conv # 对话预设的性能剖析
```

## 常见问题

- **opencode 无法启动**：确认 `resources/binaries/` 下存在当前平台的 opencode 二进制（或已加入 PATH）；若提示端口 4096 被占用，关闭占用进程后重试。可通过 `DATAFORGE_DISABLE_SANDBOX=1` 临时跳过沙箱排查（仅开发 / 受限环境）。
- **LSP 启动失败 / "只成功一回，之后都失败"**：多为 JDT.LS 的 `-data` 工作区锁被占用；请确认 `resources/jdtls/`、`resources/metals/` 资源完整，并检查设置页 `JAVA_HOME` 配置。
- **编辑器无语法高亮**：确认 `public/grammars/` 与 `public/wasm/onig.wasm` 存在；`@codingame/monaco-vscode-*` 包已在 Vite `optimizeDeps.exclude` 中排除，请勿改动该配置。
- **登录失败**：确认 `backendHost` 填的是服务根地址（不含 `/api`）且端口正确（本地运行 8083 / 容器 8082）。

## 许可

Proprietary（见 [软件使用许可协议.txt](软件使用许可协议.txt)）。
