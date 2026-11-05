# 开发配置

> [文档首页](../README.md) › 快速开始

服务部署后到云盘下载对应操作系统的app并安装

## 1. 基础环境配置

DataForge 的运行与开发依赖一套基础工具链与环境（Java / Maven / Git / 引擎 / 调度 / 模型提供商等），均可按实际开发环境调整。All-in-One 镜像内置的主链路组件及默认约定如下：

| 组件 | 版本 | 配置值 | 说明 |
| --- | --- | --- | --- |
| **Java** | JDK 17 | 根据java实际安装路径设置，安装包在云盘tool文件夹 | DataForge Server、Spark、DolphinScheduler、Marquez 的运行与 Java/Scala 编译基础环境 |
| **Maven** | 3.9 | 根据java实际安装路径设置，安装包在云盘tool文件夹 | Java/Scala 程序编译与依赖解析的基础构建工具，按 Maven 坐标从仓库解析依赖 |
| **Git** | — | `git`（镜像内置） | 开发项目与代码的版本控制，用于工程管理与变更追溯 |
| **DolphinScheduler** | 3.4.1 standalone | `http://localhost:12345/dolphinscheduler/` | web UI位于`http://localhost:12345/dolphinscheduler/` |
| **Marquez** | 0.51.1 | `http://localhost:5000` | 数据血缘与元数据服务，Web UI 位于 `http://localhost:3000` |
| **LLM** | AI 助手模型提供商 | —（部署后配置） | 面向 AI 辅助开发的模型提供商设置，默认设置思考模式，配置大模型后需要重启APP |

## 2. 配置后端服务地址

在登录页面填入 DataForge Server 的 API 地址。Docker 部署默认为 `http://localhost:8082`，客户端将通过该地址访问后端全部 API 能力。

## 3. 预置账号

初始化脚本自动创建以下账号（初始密码均为 `123456`）：

| 账号 | 身份 | 说明 |
| --- | --- | --- |
| **admin** | 超级管理员 | 平台超级管理员（SUPER_ADMIN），拥有全部菜单、文件、项目与库表权限 |
| **test** | 测试用户 | 隶属于「测试租户」（test_tenant），用于体验预置数据源与授权 |

## 4. 预置数据源

镜像已预置 1 个 PostgreSQL 数据源 `test_datasource`，指向 PG 演示业务库 `test_db`（连接串 `jdbc:postgresql://127.0.0.1:5432/test_db`，含 `ad_events` 示例表）。登录后可直接用于数据探查、SQL 查询与元数据采集，也可在「数据源管理」中新建并连接其他类型。

## 5. 预置项目与授权

镜像已预置「测试项目」（test_project，归属 test 用户）与「测试租户」（test_tenant），并完成以下权限预配置，可边登录边验证：

- **项目权限** — SUPER_ADMIN 对测试项目完全控制，数据开发工程师可编辑
- **库表权限** — 预置「test_db 读写权限」，覆盖 test_datasource 下 test_db 全部表（*），支持增删改查与导出，已授予数据开发工程师、数据架构师
- **菜单权限** — 数据开发工程师默认开通开发助手、数据探索、知识库、指标管理

角色权限采用 RBAC 模型，从功能菜单到数据行级全覆盖，四类资源各自独立授权：**菜单权限**（控制可访问的功能模块）、**文件权限**（按存储配置与文件路径控制大数据集群数据文件的可读 / 读写 / 完全控制）、**项目权限**（控制开发、指标、调度模块的项目访问级别）、**库表权限**（控制数据表增删改查导出，支持整表授权、字段级授权与行级过滤）。

## 6. 依赖包配置

初始化环境中已预置一组编译依赖，供 Java / Scala 程序在引擎上编译与运行使用。预置的依赖 jar 如下：

| 依赖 jar | 说明 |
| --- | --- |
| **spark-core** | Spark 核心库，Java / Scala 程序编译及 `spark-submit` 运行的基础依赖 |
| **spark-sql** | Spark SQL 能力，支撑 SQL 语言与 DataFrame / Table API 任务的编译执行 |
| **postgresql-jdbc**（org.postgresql : postgresql） | PostgreSQL JDBC 驱动，使 Java 程序可通过 JDBC 读写 PostgreSQL 数据源（如预置的 `test_db`） |

配置基于引擎执行链路确定：Spark 引擎负责承载 SQL 与 Java / Scala 任务的真实运行，因此需内置 `spark-core` / `spark-sql` 支撑编译与提交；平台默认数据源为 PostgreSQL，Java 程序读写库表必须依赖 JDBC 驱动，故一并预置 `postgresql-jdbc`。依赖全部在「依赖包管理」中统一维护，编译打包时自动解析挂载，达到各工程无需重复引入、一处配置全局生效的目的

---

| ← 上一篇 | 下一篇 → |
| --- | --- |
| [服务部署](deployment.md) | [开始开发](first-task.md) |

[返回文档首页](../README.md)
