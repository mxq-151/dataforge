# DataForge

面向数据开发的一体化桌面端平台，基于 **Electron + React 19 + TypeScript** 实现，内置 **AI 开发助手（opencode）**、**Monaco 代码编辑器 + LSP 智能提示（Java/Scala）**、数据探索、指标管理、知识库、调度管理（DolphinScheduler）、数据血缘（Marquez）与系统管理等能力。

## 功能特性

- **AI 开发助手**：集成 opencode 服务，支持多模型切换、工具调用（Bash / 文件编辑 / Web 搜索 / 任务 / Skill 等）、沙箱执行、权限审批与问答交互。
- **Monaco 编辑器**：基于 `@codingame/monaco-vscode-*` 系列实现 VS Code 级编辑体验（TextMate 语法高亮、主题、快捷键），支持 Java / Scala / SQL / Markdown 等语言。
- **LSP 智能提示**：通过 WebSocket 桥接 **JDT.LS（Java）** 与 **Metals（Scala）**，提供悬停、定义跳转（含依赖源码）、补全、诊断；支持 `jdt://` / `metals:` 类文件源码查看。
- **编译与 SQL 校验**：本地编译服务（Maven 编译 Java/Scala、SQL 语法校验），供 AI 助手与编辑器调用。
- **数据探索**：数据库表浏览、SQL 执行、结果可视化。
- **指标管理**：指标体系维护，支持跳转到数据血缘查看关联字段。
- **知识库**：企业知识文档管理（分类、检索）。
- **文件浏览器**：本地工作区文件管理。
- **调度管理**：对接 DolphinScheduler，管理工作流定义、任务实例、运行实例。
- **数据血缘**：对接 Marquez，图谱化展示表/字段血缘关系。
- **系统管理**：用户、角色、权限、租户、操作日志等 RBAC 管理。
- **设置**：后端地址、LLM 模型、Java/Scala/Maven 环境、Git、外部系统连接等集中配置。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Electron 44 |
| 渲染层 | React 19、Vite 8、TypeScript 7 |
| 编辑器 | Monaco Editor（`@codingame/monaco-vscode-*` 25.1.2、`monaco-languageclient`） |
| AI 服务 | `@opencode-ai/sdk`，本地进程 `127.0.0.1:4096` |
| 图可视化 | `@xyflow/react`（React Flow） |
| 其它 | `react-markdown`、`@tanstack/react-virtual`、`lucide-react`、`ws`、`adm-zip` 等 |

> 说明：渲染层通过 [src/bridge/](src/bridge/) 与 Electron 主进程通信（IPC 封装文件系统、Shell、HTTP、Store、路径、事件等能力），无任何 `@tauri-apps/*` 依赖。

## 架构概览

```
┌──────────────────────────────────────────────────────────┐
│                   渲染进程（React + Monaco）              │
│  开发助手 · 数据探索 · 编辑器 · 调度 · 血缘 · 系统管理 …   │
└──────────────┬──────────────────────────┬────────────────┘
               │ preload（contextIsolation）│ REST（业务后端）
┌──────────────▼──────────────┐   ┌────────▼──────────────────┐
│        Electron 主进程       │   │  业务后端（独立部署）       │
│  ┌────────────────────────┐ │   │  http://localhost:8080     │
│  │ opencode 服务（沙箱）    │ │   │  DolphinScheduler /        │
│  │ compile 编译服务        │ │   │  Marquez                   │
│  │ LSP 桥（JDT.LS/Metals） │ │   └───────────────────────────┘
│  └────────────────────────┘ │
└─────────────────────────────┘
```

- **主进程**（[electron/](electron/)）：窗口管理、IPC 注册、服务生命周期管理。
  - [opencode.ts](electron/backend/opencode.ts)：启动/监督/终止 opencode 本地服务，固定监听 `127.0.0.1:4096`，macOS 用 `sandbox-exec`、Linux 用 `bubblewrap` 沙箱包装，退出时优雅清理进程与 SQLite 锁文件。
  - [compileServer.ts](electron/backend/compileServer.ts)：本地编译 HTTP 服务（随机端口 + Token 鉴权），端点通过 `DATAFORGE_COMPILE_PORT/TOKEN` 环境变量注入 opencode。
  - [lspBridge.ts](electron/backend/lspBridge.ts)：将 JDT.LS / Metals 子进程 stdio 转为 WebSocket，供前端 `monaco-languageclient` 使用。
  - [compile.ts](electron/backend/compile.ts) / [maven.ts](electron/backend/maven.ts) / [lspPom.ts](electron/backend/lspPom.ts)：Maven 工程生成（pom.xml / bloop）与 Java/Scala 编译。
- **渲染层**（[src/](src/)）：React 视图 + `src/api/`（业务后端 REST 封装，含请求签名/鉴权）+ `src/hooks/opencode/`（opencode SDK 客户端、会话、事件、文件审查）+ `src/services/lsp/`（语言客户端与 Monaco provider 注册）+ `src/services/textmate/`（TextMate 语法）。

## 目录结构

```
dataforge/
├── electron/            # Electron 主进程
│   ├── main.ts          # 窗口创建（原生标题栏）、服务启动、退出清理
│   ├── ipc.ts           # IPC 命令注册（opencode / 编译 / LSP / 文件系统等）
│   ├── preload.ts       # 预加载脚本（contextIsolation）
│   ├── eventBus.ts      # 主进程 → 渲染层事件桥
│   └── backend/         # opencode、compileServer、lspBridge、compile、maven、lspPom、store
├── public/
│   ├── grammars/        # TextMate 语法定义（java/scala/sql/markdown 等）
│   └── wasm/onig.wasm   # 正则引擎（oniguruma）
├── resources/
│   ├── sandbox/         # macOS 沙箱 profile（opencode-macos.sb）
│   └── binaries/        # opencode 平台二进制（不入库，需单独准备）
└── src/
    ├── bridge/          # 渲染层 ↔ 主进程 IPC 桥接（fs / shell / http / store / path / event）
    ├── api/             # 业务后端 REST API 封装
    ├── components/      # AI 面板、编辑器、布局（ActivityBar/TitleBar）等组件
    ├── contexts/        # Auth / DataSource / DolphinScheduler 上下文
    ├── hooks/           # opencode 客户端、LSP、编译、SQL 补全等 hooks
    ├── services/        # lsp / textmate / compile / taskExecution
    ├── types/           # 类型定义（含 opencode-backend 配置类型）
    ├── utils/           # 工具函数
    └── views/           # 各功能视图（dev-assistant / data-explore / schedule 等）
```

## 环境要求

- **Node.js 20+**（含 npm）
- **JDK 17+**（配置到设置页 `JAVA_HOME`）
- **Maven**（`MAVEN_HOME`），Java/Scala 编译与 LSP 工程生成依赖
- **Scala**（可选，Scala 工程使用，`SCALA_HOME`）
- **opencode 二进制**：`resources/binaries/opencode`（或平台 triple 命名，如 `opencode-aarch64-apple-darwin`）；开发模式会依次从 `resources/binaries/` → PATH 查找
- **LSP 服务器资源**（体积较大，未纳入 Git）：
  - `resources/jdtls/` —— JDT.LS（Java），需要包含 `plugins/org.eclipse.equinox.launcher_*`
  - `resources/metals/` —— `metals.jar` 或 `coursier.jar`（Scala/Metals）
  - 以上资源需单独准备至 `resources/` 对应目录，详见 [electron-builder 配置](package.json#L32-L52) 的 `extraResources`
- **业务后端服务**：登录页配置后端地址（默认 `http://localhost:8080`），并提供 DolphinScheduler / Marquez 服务地址与 Token

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

## 打包发布

```bash
npm run pack    # 构建 + electron-builder --dir（生成未打包目录 release/）
npm run dist    # 构建 + electron-builder（生成 dmg / zip 安装包）
```

打包相关配置见 [package.json](package.json#L20-L63)：

- 产物输出到 `release/`
- `asar: false`，`extraResources` 会带上 `sandbox`、`jdtls`、`metals`、`binaries/opencode` 等运行资源
- macOS 使用原生标题栏（`hiddenInset`），Windows/Linux 使用 `titleBarOverlay`

> 注意：`resources/metals/metals.jar`、`resources/jdtls/`、`resources/binaries/` 体积较大，已加入 [.gitignore](.gitignore) 不入库，需在构建机/运行环境单独准备。

## 桌面版启动

### 方式一：启动打包产物（推荐）

```bash
# macOS（pack 产物为 release/mac/DataForge.app，dmg 安装后从启动台启动）
npm run pack
open release/mac/DataForge.app

# Windows / Linux（pack 产物在 release/win-unpacked 或 release/linux-unpacked 下）
npm run pack
release/win-unpacked/DataForge.exe        # Windows
release/linux-unpacked/dataforge          # Linux
```

### 方式二：基于源码产物直接启动（无需打包）

先构建主进程与渲染层，再直接用 Electron 加载构建产物：

```bash
npm run build            # 生成 dist-electron/（主进程）与 dist/（渲染层）
npx electron .           # 等价于 npm run start（即 package.json 中的 electron .）
```

> `npx electron .` 会使用项目本地安装的 Electron 读取 `package.json` 的 `main` 字段（`dist-electron/main.js`）启动；由于直接以 `file://` 加载 `dist/index.html`（无 Vite 开发服务器），必须先执行 `npm run build`。

## 配置说明

应用配置存储于用户数据目录（`opencode-config.json`、`secure-store.json`），主要配置项（[types/opencode-backend.ts](src/types/opencode-backend.ts#L98-L149)）：

| 配置 | 说明 |
| --- | --- |
| `backendHost` | 业务后端服务地址（非 localhost 地址要求 HTTPS） |
| `llmModels` / `model` / `apiKey` | LLM 模型与密钥（支持 DeepSeek / Qwen 等多 provider，可在 AI 面板内切换） |
| `javaHome` / `scalaHome` / `mavenHome` | Java / Scala / Maven 环境路径 |
| `cwd` | 基础工作目录，自动计算为 `$HOME/.dataforge/{后端host}/{用户名}/` |
| `gitRepoUrl` / `gitRepoDirName` / `gitSshKeyPath` | Git 仓库同步（启动时自动 clone/pull） |
| `permissionMode` | AI 工具权限模式：`auto`（每次询问）/ `accept`（全允许）/ `reject`（全拒绝） |
| `dolphinSchedulerApiUrl` / `token` | DolphinScheduler 连接（调度管理） |
| `marquezApiUrl` / `openlineageTransportUrl` | Marquez / OpenLineage 连接（数据血缘） |
| `pomTemplate` / `scalaVersion` / `mavenGroupId` / `mavenArtifactId` | Maven 工程模板与坐标 |
| `maxTurns` | AI 助手最大轮次 |
| `enableSandbox` | 是否以沙箱模式运行 AI 助手（默认开启） |

## 常见问题

- **opencode 无法启动**：确认 `resources/binaries/` 下存在当前平台的 opencode 二进制（或已加入 PATH）。可通过环境变量 `DATAFORGE_DISABLE_SANDBOX=1` 临时跳过沙箱排查（仅开发/受限环境）。
- **LSP 启动失败 / “只成功一回，之后都失败”**：多为 JDT.LS 的 `-data` 工作区锁被占用，请确认 `resources/jdtls/`、`resources/metals/` 资源完整，并检查设置页 `JAVA_HOME` 配置。
- **编辑器无语法高亮**：确认 `public/grammars/` 与 `public/wasm/onig.wasm` 存在；`@codingame/monaco-vscode-*` 包已在 Vite `optimizeDeps.exclude` 中排除，请勿改动该配置。

## 编辑器测试页

可通过 URL 参数 `?page=editor-test` 或 hash `#editor-test` 进入（不要求登录、无需后端服务），用于单独调试 `src/components/editor` 模块。
