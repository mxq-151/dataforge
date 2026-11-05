<p align="center">
  <img src="images/logo.svg" width="72" height="72" alt="DataForge logo">
</p>

# DataForge 文档

DataForge 是面向数据开发的一体化桌面端平台，基于 **Electron + React 19 + TypeScript** 实现，内置 **AI 开发助手（opencode）**、**Monaco 代码编辑器 + LSP 智能提示（Java / Scala）**、数据探索、指标管理、知识库、文件浏览、调度管理（DolphinScheduler）、数据血缘（Marquez）与系统管理等能力。

它的核心理念是 **开发即治理**：把指标口径、开发规范与血缘追踪直接内置进 AI 开发链路，让治理从「事后补救」变成开发的内生能力。

- **需求文档进，治理合格的调度任务出** —— 一句话需求 → 数仓设计 → 代码生成 → 提交前校验 → 上线调度 → 血缘入库。
- **链路可单用，也可串联** —— 开发助手、数据探查、作业调度、指标管理、数据血缘等能力各自独立，也可串成一条完整链路。

## 文档导航

### 快速开始

| 文档 | 内容 |
| --- | --- |
| [环境准备](getting-started/environment.md) | 操作系统、Docker 等前置要求 |
| [服务部署](getting-started/deployment.md) | All-in-One 镜像、startup 脚本与启动验证 |
| [开发配置](getting-started/configuration.md) | 基础环境、预置账号 / 数据源 / 项目、依赖包 |
| [开始开发](getting-started/first-task.md) | 从登录到血缘、指标的完整首个任务链路 |

### 使用教程

| 文档 | 内容 |
| --- | --- |
| [项目管理](guide/project-management.md) | 开发项目 / 调度项目 / 血缘命名空间的映射与目录规范 |
| [开发过程](guide/development-process.md) | S1 需求 → S2 设计 → S3 开发 → 稽核 → 提交 → 上线 |
| [持续集成](guide/continuous-integration.md) | 提交前校验、测试 / 灰度 / 生产三套环境与库表隔离 |
| [权限管理](guide/permission.md) | RBAC、租户继承与菜单 / 文件 / 项目 / 库表四类授权 |
| [资产管理](guide/asset.md) | 存储与文件资产、数据源、元数据与生命周期、使用统计 |
| [需求管理](guide/requirement.md) | 需求文档章节规范与「数据指标」表强约束 |
| [代码管理](guide/code.md) | 目录结构、命名规范、代码头契约与 SQL / Java / Scala 规范 |
| [问题排查](guide/troubleshooting.md) | 调度失败归因、日志与上下游联动定位 |
| [数据应用](guide/data-application.md) | 血缘图、指标查询与统计数据 |
| [数据安全](guide/data-security.md) | 权限下推、数据掩码、导出管控与审计 |
| [知识管理](guide/knowledge.md) | 规范与业务知识沉淀，供 AI 生成前检索 |
| [指标管理](guide/indicator.md) | 指标编码、口径与字段来源绑定 |

### 产品与理念

| 文档 | 内容 |
| --- | --- |
| [产品能力总览](capabilities.md) | 开发链路 / 数据治理 / 平台运维三类共 9 个模块 |
| [开发即治理](overview.md) | 为什么需要治理、全链路环节与产品速览 |

## 配套组件

本仓库是 **DataForge 的桌面客户端**，需要配套的服务端与集群侧组件才能发挥完整能力：

| 组件 | 仓库 / 位置 | 作用 |
| --- | --- | --- |
| `dataforge` | 本仓库 | 开发者工作台：AI 助手、编辑器、数据探索、调度提交、血缘查看 |
| `dataforge-server` | `dataforge-server` | 元数据与权限中台：统一身份与多级权限、数据源与存储、库表元数据、指标、知识库、审计 |
| `spark-listener` | 独立仓库 | Spark 写入合规闸门：分析期拦截违规写入 |
| `flink-listener` | 独立仓库 | Flink 写入合规闸门：提交前拦截违规写入 |

安装与构建客户端本体，请参见仓库根目录的 [README](../README.md)。
