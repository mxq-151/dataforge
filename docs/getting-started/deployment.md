# 服务部署

> [文档首页](../README.md) › 快速开始

## 架构说明

DataForge 采用「桌面客户端 + 后端服务」的协作架构：**DataForge 桌面客户端**负责代码编辑、AI 对话与可视化交互；**DataForge Server** 作为后端服务，提供数据源管理、指标管理、知识库、用户权限、依赖管理等核心 API 能力。客户端通过 HTTP 访问 Server 的 API 地址（Docker 部署默认为 `http://localhost:8082`）完成登录与平台初始化。

推荐使用 Docker 部署后端服务：**All-in-One 镜像**将 dataforge-server 及其全部依赖组件打包进单个容器，直接拉取镜像即可启动，无需手动安装 JDK、数据库与调度组件。

> [!NOTE]
> **镜像内置组件**：dataforge-server 1.0.0（JDK 17）、PostgreSQL 14（平台主库 + Marquez 元数据库）、Spark 3.5.9（local 模式）、DolphinScheduler 3.4.1（Standalone）、Marquez 0.51.1（数据血缘 api + web）、Nginx。

### 环境要求

| 组件 | 版本要求 | 说明 |
| --- | --- | --- |
| **Docker** | ≥ 20.10（含 Docker Compose） | 在云盘的tool目录有安装包(Windows需要安装WSL) |
| **内存** | ≥ 8GB | 建议为 Docker 分配 8GB 以上可用内存 |
| **磁盘** | ≥ 10GB | 镜像与数据卷占用 |

### 步骤一：拉取 / 构建镜像

方案 A：从阿里云镜像仓库拉取 All-in-One 镜像并标记为编排文件使用的本地标签 `dataforge-allinone:1.0`：

**拉取 All-in-One 镜像**

```bash
docker pull crpi-mcl4kmj9q60uvesn.cn-wulanchabu.personal.cr.aliyuncs.com/dataforge_docker/dataforge-allinone:1.0 && docker tag crpi-mcl4kmj9q60uvesn.cn-wulanchabu.personal.cr.aliyuncs.com/dataforge_docker/dataforge-allinone:1.0  dataforge-allinone:1.0
```

发布包内含 `startup/` 启动脚本目录（`macos/`、`windows/` 两个平台），编排文件位于 `startup/compose/`，无需手工编写 Compose 文件，直接调用封装脚本即可完成启动、停止与清理。

### 步骤二：下载 app及startup 脚本并启动

**startup 启动脚本**位于**云盘「tool」目录**，请先从云盘下载并解压到本地任意工作目录。脚本目录包含：编排文件 `startup/compose/`，以及平台脚本 `startup/macos/`（macOS）与 `startup/windows/`（Windows），无需手工编写 Compose 文件，直接调用封装脚本即可完成启动。

启动容器只需一条命令：

**启动容器**

```bash
# macOS：启动（数据写入容器内，首次启动自动初始化数据库 schema）
./startup/macos/start.sh
# Windows：startup\windows\start.bat

# 如需持久化数据，改用（挂载命名卷 df-pgdata / df-data）
./startup/macos/start-persist.sh
# Windows：startup\windows\start-persist.bat
```

### 步骤三：验证服务

**检查服务状态**

```bash
# 检查 dataforge-server 是否启动成功
curl http://localhost:8082/api/system/auth/info

# 预期返回 JSON 响应即表示服务正常
# API 文档（Knife4j）：http://localhost:8082/api/doc.html
```

> [!NOTE]
> **默认管理员账号**：首次启动后可使用 `admin / 123456` 登录，请及时修改默认密码。

> [!NOTE]
> Spark 以 local 模式在容器内运行（`spark-submit` 默认 `local[*]`），不占用常驻端口。Marquez API 映射为 `localhost:5000`、admin 为 `localhost:5001`；若本机 5000 端口被占用（如 macOS AirPlay），可自行调整端口映射后重新启动。

---

| ← 上一篇 | 下一篇 → |
| --- | --- |
| [环境准备](environment.md) | [开发配置](configuration.md) |

[返回文档首页](../README.md)
