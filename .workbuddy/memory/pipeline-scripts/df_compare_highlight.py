#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""改写 1.3 同类平台对比：补「开发语言」「编译与一键上调度」两行，并把本平台优势提到台面上。"""
import pathlib
import sys

MD = pathlib.Path("/Users/mxq/Desktop/dataforge/output/45d4b135-45a3-447c-86ab-8a2d7ff7a55e"
                  "/stage1/final_draft.md")

NEW = """### 1.3 同类平台对比与差异定位

数据开发平台的既有选择大致分三类：开源 Web 开发门户（Apache Hue，在 Cloudera 发行版中已改名 Cloudera Data Explorer）、云厂商一体化数据开发治理平台（阿里云 DataWorks、华为云 DataArts Studio、腾讯云 WeData、瓴羊 Dataphin）、以及企业自建脚本与自研工具。下表按本项目关心的维度做对照；**对手能力按公开资料整理，具体版本与功能以厂商文档为准。**

| 维度 | DataForge | Hue（Cloudera Data Explorer） | 阿里云 DataWorks | 其他云平台（DataArts / WeData / Dataphin） |
| --- | --- | --- | --- | --- |
| 形态与部署 | 桌面端 IDE + 自建服务端，私有部署，面向既有集群 | Web 门户，随 Cloudera 发行版部署（开源 Hue 可独立部署） | 云上服务，Serverless 资源组，兼容 EMR 等云引擎 | 云上服务；DataArts 强调鲲鹏 / 欧拉 / 高斯全栈信创 |
| 开发语言 | **Java / Scala / Python / SQL / Shell 五类，同一开发环境内编辑与调试** | 以 SQL 为主（Hive / Impala / Spark SQL / Trino），另有 Spark / PySpark 交互式笔记 | 以 SQL / Python / Shell 为主，支持 Notebook | 以 SQL / Python / Shell 为主 |
| 编译与一键上调度 | **Java / Scala 本地编译（Maven）产出主 Jar 包，Python / SQL / Shell 免编译；五类程序一并一键提交调度，代码头声明的参数自动落地任务节点** | 可在门户内调度查询与工作流，不涉及程序编译与提交 | 支持把任务发布到调度系统；Java / Scala 需自行编译打包后以资源或 UDF 形式引用，无本地编译闭环 | 支持发布到调度系统；无本地编译闭环 |
| 优化对象 | **让智能体正确理解业务数据**：把规范开发环境与四类信息做成智能体的上下文供给层 | 让分析师在浏览器里写 SQL、查表、看历史、调试查询 | 让开发者在云上完成开发—调度—运维—治理闭环 | 同左，并叠加行业方法论 |
| AI 落点 | 智能体在桌面端本地进程推理，模型与密钥由用户自配，**服务端零模型调用**；业务能力以 6 个工具组注册，经平台接口取上下文 | SQL AI Assistant：自然语言生成 / 编辑 / 解释 / 优化 / 修复 SQL，模型由客户自选（Cloudera AI、Azure OpenAI、Bedrock 等） | DataWorks Copilot：代码生成与纠错、智能建表、发布描述、异常诊断（对接 Qwen、DeepSeek-R1），并已发布端到端的数据开发 Agent | 借云侧大模型做标准推荐、质量规则推荐、异常归因与资产盘点 |
| 参数与约束 | 代码头参数三段式声明（业务入参 / 资源诉求 / 引擎侧参数），提交时落地任务节点；命名与口径约束 | 无参数声明机制 | 任务参数在平台内配置；Copilot Rule 规则引擎可用团队规范约束 Agent 产出 | 任务参数在平台内配置 |
| 库表与指标描述 | 服务端沉淀库表 / 字段描述与指标口径，并给出未标注项清单，供智能体结构化读取 | 左栏库表与对象存储浏览、查询历史；无指标口径体系 | 数据地图、智能建模、数据服务 API | 数据标准、资产目录、质量规则体系 |
| 血缘与任务依赖 | 集成 Marquez（OpenLineage）与 DolphinScheduler，血缘与依赖在平台内可查 | 无血缘图谱，提供查询历史与执行计划 | 内置血缘图谱与自带调度 | 内置血缘解析与自带调度 |
| 权限粒度 | 角色—资源三级授权，行 / 列级权限在 SQL 下发前改写生效 | 以自身与底层引擎授权为主 | 云侧权限体系，含敏感数据识别与脱敏 | 权限体系与数据分级分类（信创合规见长） |
| 引擎侧写入合规 | 可选装 spark / flink-listener，在计算引擎侧对写入做合规拦截 | 无 | 平台侧权限与审批控制 | 平台侧控制 |
| 引擎与集群兼容 | Hive / Spark / Flink / Doris / ClickHouse / Kyuubi 等 13 种数据源，面向企业既有集群 | Impala / Hive / Spark / Trino / Phoenix，随发行版 | 以阿里云引擎为主（MaxCompute / Hologres / EMR） | 以各自云引擎为主，另有多云连接器 |
| 收费模式 | 软件在企业内部免费使用（闭源），收益来自数据开发与集群运维服务 | 随 Cloudera 商业订阅；开源版免费 | 云资源与平台订阅按量计费 | 云资源与平台订阅按量计费 |

**本平台的四点优势**：

1. **开发到上线是一条闭环，且不限 SQL。**在一个开发环境里用 Java / Scala / Python / SQL / Shell 写程序：Java / Scala 本地编译（Maven）产出主 Jar 包，Python / SQL / Shell 免编译，随后**一键提交调度**，代码头声明的参数自动落在调度任务节点上。同类平台以 SQL / Python / Shell 编辑器为主，Java / Scala 通常要自己编译打包、再以资源或 UDF 形式引用，开发与上线是两段。
2. **给智能体喂上下文，而不是只给人用界面。**开发环境、库表与指标描述、血缘、任务依赖在本平台里首先是**给智能体读的上下文**——经元数据代理等接口按权限、按结构提供；并让信息缺口可见（未标注表 / 字段清单、血缘覆盖率）。
3. **推理在本地，平台不做模型调用。**智能体在桌面端本地进程执行，模型与密钥由用户自配，服务端零模型调用，适合数据不宜出内网的场景；云平台的 AI 能力默认走云侧模型。
4. **写入在引擎侧还有一道闸门。**可选装 spark / flink-listener，在计算引擎侧对写入做合规拦截——这是同类平台没有的一层，它们依赖平台侧权限与审批。

**客观说明**：在托管运维与连接器丰富度上云平台明显领先（DataWorks 的 Serverless 资源组与数十种数据源连接器、WeData 与 Dataphin 的开箱即用）；Hue 在浏览器端即开即用与稳定性上有十余年积累；云平台在数据集成、数据质量、资产目录等治理模块的完整度也更成熟。本平台的取舍是放弃"托管"与"连接器广度"，把工程投入集中在"多语言开发闭环 + 让智能体读懂业务数据"这一件事上；集群部署与运维由配套服务承接（见 1.6）。

"""


def main():
    text = MD.read_text(encoding="utf-8")
    start = text.index("### 1.3 同类平台对比与差异定位")
    end = text.index("### 1.4 建设目标")
    old = text[start:end]
    if "开发语言" in old:
        print("!! 已经改过（旧文本已含「开发语言」），中止")
        return 1
    text = text[:start] + NEW + text[end:]
    MD.write_text(text, encoding="utf-8")
    print(f"1.3 小节 {len(old)} → {len(NEW)} 字符")
    print("表格行数:", NEW.count("\n| ") - 2, "（含表头）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
