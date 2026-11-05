# DataForge

面向数据开发的一体化桌面端平台，基于 **Electron + React 19 + TypeScript** 实现，内置 **AI 开发助手（opencode）**、**Monaco 代码编辑器 + LSP 智能提示（Java / Scala）**、数据探索、指标管理、知识库、文件浏览、调度管理（DolphinScheduler）、数据血缘（Marquez）与系统管理等能力。

本仓库是 **DataForge 的桌面客户端**，需要配套的服务端与集群侧组件才能发挥完整能力：

| 组件 | 仓库 / 位置 | 作用 |
| --- | --- | --- |
| `dataforge` | 本仓库 | 开发者工作台：AI 助手、编辑器、数据探索、调度提交、血缘查看 |
| `dataforge-server` | `dataforge-server` | 元数据与权限中台：统一身份与多级权限、数据源与存储、库表元数据、指标、知识库、审计 |
| `spark-listener` | 独立仓库 | Spark 写入合规闸门：分析期拦截违规写入 |
| `flink-listener` | 独立仓库 | Flink 写入合规闸门：提交前拦截违规写入 |

## 文档

完整文档见 [`docs/`](docs/README.md)：

- [环境准备](docs/getting-started/environment.md) · [服务部署](docs/getting-started/deployment.md) · [开发配置](docs/getting-started/configuration.md) · [开始开发](docs/getting-started/first-task.md)
- 使用教程：[项目管理](docs/guide/project-management.md) · [开发过程](docs/guide/development-process.md) · [持续集成](docs/guide/continuous-integration.md) · [权限管理](docs/guide/permission.md) · [资产管理](docs/guide/asset.md) · [需求管理](docs/guide/requirement.md) · [代码管理](docs/guide/code.md) · [问题排查](docs/guide/troubleshooting.md) · [数据应用](docs/guide/data-application.md) · [数据安全](docs/guide/data-security.md) · [知识管理](docs/guide/knowledge.md) · [指标管理](docs/guide/indicator.md)
- 产品与理念：[产品能力总览](docs/capabilities.md) · [开发即治理](docs/overview.md)

## 功能特性

- **AI 开发助手**：用自然语言描述需求，即可让它读懂项目、修改文件、执行命令、查资料并给出结论；可以随时切换模型、并行多个会话、回看历史任务，敏感操作会先征求你的同意。

- **代码编辑**：打开 Java / Scala / SQL / Markdown 等文件，获得与 VS Code 一致的编辑体验——语法高亮、主题、快捷键、文件树与多标签。

- **智能编码辅助**：自动补全、悬停提示、跳转定义、实时错误诊断，并且能直接查看依赖库中的源码。

- **编译与 SQL 校验**：在应用内编译 Java / Scala 工程、校验 SQL 语法，结果直接反馈给 AI 助手，形成“改代码 → 编译 → 修正”的闭环。

- **数据探索**：浏览数据源与库表、查看字段明细，编写并执行 SQL，回看执行历史，对结果集直接做图表分析。

- **指标管理**：维护指标体系，一键跳转血缘视图查看指标关联的字段来源。

- **知识库**：沉淀与检索企业知识文档，支持分类管理。

- **文件浏览**：管理工作区文件；也可连接 HDFS / JuiceFS / S3 等存储，进行浏览、新建目录、重命名、上传、下载与在线预览。

- **调度管理**：用画布编排工作流、配置任务与调度周期、查看任务实例运行情况，并一键提交到调度平台。

- **数据血缘**：以图谱方式查看表与字段的上游来源和下游影响。

- **系统管理**：管理用户、角色、权限、租户与操作日志。

- **设置**：集中配置服务地址、AI 模型、Java / Scala / Maven 环境、代码仓库与外部系统连接。



## 环境要求

- **Node.js 20+**（含 npm）
- **JDK 17+**（配置到设置页 `JAVA_HOME`）
- **Maven**（`MAVEN_HOME`）——Java / Scala 编译与 LSP 工程生成依赖
- **Scala**（可选，Scala 工程使用，`SCALA_HOME`）
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


## 构建与打包

```bash
npm run pack    # 构建 + electron-builder --dir（生成未打包目录 release/）
npm run dist    # 构建 + electron-builder（生成 dmg / zip 安装包）
```

### 语言服务器运行时（随包分发，首次启动不下载）

`resources/jdtls`（Java LSP）与 `resources/metals`（Scala LSP）都是**随代码提交**的离线运行时：

- `resources/metals/lib/`：Metals 主程序 + 全部运行时依赖（`java -cp lib/* scala.meta.metals.Main` 启动）
- `resources/metals/coursier-cache/`：Bloop 构建服务器构件（运行时通过 `COURSIER_CACHE` 指向它，命中即不联网）
- `resources/metals/bundle.json`：版本清单（Metals / Bloop 版本）

`npm run build`（以及 `pack` / `dist`）会先执行 `prebuild` → `npm run prepare:metals`，校验离线包是否完整，缺失或版本不一致时才重建（仅构建机需要联网）。手动重建：

```bash
npm run prepare:metals -- --force
```

可用环境变量覆盖版本：`DATAFORGE_METALS_VERSION`、`DATAFORGE_BLOOP_VERSION`、`DATAFORGE_BLOOP_MODULE`。第一次在无 Maven 的机器上执行时，脚本会把 Apache Maven 下载到 `.cache/tools/`（已 gitignore）。


## 常见问题

- **opencode 无法启动**：确认 `resources/binaries/` 下存在当前平台的 opencode 二进制（或已加入 PATH）；若提示端口 4096 被占用，关闭占用进程后重试。可通过 `DATAFORGE_DISABLE_SANDBOX=1` 临时跳过沙箱排查（仅开发 / 受限环境）。
- **LSP 启动失败 / "只成功一回，之后都失败"**：多为 JDT.LS 的 `-data` 工作区锁被占用；请确认 `resources/jdtls/`、`resources/metals/lib/` 资源完整（可用 `npm run prepare:metals` 重建），并检查设置页 `JAVA_HOME` 配置。
- **编辑器无语法高亮**：确认 `public/grammars/` 与 `public/wasm/onig.wasm` 存在；`@codingame/monaco-vscode-*` 包已在 Vite `optimizeDeps.exclude` 中排除，请勿改动该配置。
- **登录失败**：确认 `backendHost` 填的是服务根地址（不含 `/api`）且端口正确（本地运行 8083 / 容器 8082）。

## 许可

本项目基于 [Apache License 2.0](LICENSE) 开源发布。

