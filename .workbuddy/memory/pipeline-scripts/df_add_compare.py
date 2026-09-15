#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在第一章插入「同类平台对比与差异定位」小节，并把 1.3—1.5 顺延为 1.4—1.6。"""
import pathlib
import sys

MD = pathlib.Path("/Users/mxq/Desktop/dataforge/output/45d4b135-45a3-447c-86ab-8a2d7ff7a55e"
                  "/stage1/final_draft.md")

NEW_SECTION = """### 1.3 同类平台对比与差异定位

数据开发平台的既有选择大致分三类：开源 Web 开发门户（Apache Hue，在 Cloudera 发行版中已改名 Cloudera Data Explorer）、云厂商一体化数据开发治理平台（阿里云 DataWorks、华为云 DataArts Studio、腾讯云 WeData、瓴羊 Dataphin）、以及企业自建脚本与自研工具。下表按本项目关心的维度做对照，用于说明差异定位；**对手能力按公开资料整理，具体版本与功能以厂商文档为准。**

| 维度 | DataForge | Hue（Cloudera Data Explorer） | 阿里云 DataWorks | 其他云平台（DataArts / WeData / Dataphin） |
| --- | --- | --- | --- | --- |
| 形态与部署 | 桌面端 IDE + 自建服务端，私有部署，面向既有集群 | Web 门户，随 Cloudera 发行版部署（开源 Hue 可独立部署） | 云上服务，Serverless 资源组，兼容 EMR 等云引擎 | 云上服务；DataArts 强调鲲鹏 / 欧拉 / 高斯全栈信创 |
| 优化对象 | **让智能体正确理解业务数据**：把规范开发环境与四类信息做成智能体的上下文供给层 | 让分析师在浏览器里写 SQL、查表、看历史、调试查询 | 让开发者在云上完成开发—调度—运维—治理闭环 | 同左，并叠加行业方法论 |
| AI 落点 | 智能体在桌面端本地进程推理，模型与密钥由用户自配，**服务端零模型调用**；业务能力以 6 个工具组注册，经平台接口取上下文 | SQL AI Assistant：自然语言生成 / 编辑 / 解释 / 优化 / 修复 SQL，模型由客户自选（Cloudera AI、Azure OpenAI、Bedrock 等） | DataWorks Copilot：代码生成与纠错、智能建表、发布描述、异常诊断（对接 Qwen、DeepSeek-R1），并已发布端到端的数据开发 Agent | 借云侧大模型做标准推荐、质量规则推荐、异常归因与资产盘点 |
| 规范开发环境 | 代码头参数三段式声明并落地任务节点；编译为提交硬门禁；命名与口径约束 | SQL 编辑器补全与查询调试，无参数声明与编译门禁 | 代码校验、发布流程；Copilot Rule 规则引擎可用团队规范约束 Agent 产出 | 代码补全、语法检查、发布审批 |
| 库表与指标描述 | 服务端沉淀库表 / 字段描述与指标口径，并给出未标注项清单，供智能体结构化读取 | 左栏库表与对象存储浏览、查询历史；无指标口径体系 | 数据地图、智能建模、数据服务 API | 数据标准、资产目录、质量规则体系 |
| 血缘与任务依赖 | 集成 Marquez（OpenLineage）与 DolphinScheduler，血缘与依赖在平台内可查 | 无血缘图谱，提供查询历史与执行计划 | 内置血缘图谱与自带调度 | 内置血缘解析与自带调度 |
| 权限粒度 | 角色—资源三级授权，行 / 列级权限在 SQL 下发前改写生效 | 以自身与底层引擎授权为主 | 云侧权限体系，含敏感数据识别与脱敏 | 权限体系与数据分级分类（信创合规见长） |
| 引擎侧写入合规 | 可选装 spark / flink-listener，在计算引擎侧对写入做合规拦截 | 无 | 平台侧权限与审批控制 | 平台侧控制 |
| 引擎与集群兼容 | Hive / Spark / Flink / Doris / ClickHouse / Kyuubi 等 13 种数据源，面向企业既有集群 | Impala / Hive / Spark / Trino / Phoenix，随发行版 | 以阿里云引擎为主（MaxCompute / Hologres / EMR） | 以各自云引擎为主，另有多云连接器 |
| 收费模式 | 软件在企业内部免费使用（闭源），收益来自数据开发与集群运维服务 | 随 Cloudera 商业订阅；开源版免费 | 云资源与平台订阅按量计费 | 云资源与平台订阅按量计费 |

**差异定位**：

1. **优化对象不同**。既有平台优化的是"人怎么开发得更快"——更顺手的编辑器、更强的代码助手、更省事的托管运维；本平台优化的是"智能体能不能正确理解业务数据"。开发环境、库表与指标描述、血缘、任务依赖在本平台里首先是**给智能体读的上下文**，其次才是给人用的界面。
2. **上下文供给方式不同**。Hue 的 SQL 助手把当前库表结构与少量样本行作为提示上下文；本平台把五类信息沉淀在自有服务端，通过元数据代理等接口按权限、按结构提供给智能体，并让信息缺口可见（未标注表 / 字段清单、血缘覆盖率）。
3. **落地形态不同**。云平台要求数据与开发链路上云；本平台面向企业既有集群，桌面端私有部署，模型与密钥由用户自配、服务端不做模型调用，适合数据不宜出内网的场景。

**客观说明**：在托管运维与连接器丰富度上云平台明显领先（DataWorks 的 Serverless 资源组与数十种数据源连接器、WeData 与 Dataphin 的开箱即用）；Hue 在浏览器端即开即用与稳定性上有十余年积累。本平台的取舍是放弃"托管"与"连接器广度"，把工程投入集中在"让智能体读懂业务数据"这一件事上；集群部署与运维由配套服务承接（见 1.6）。

"""

# 顺序无所谓：整串匹配（含标题文字），不会互相误伤
RENAMES = [
    ("### 1.5 产品与商业模式", "### 1.6 产品与商业模式"),
    ("### 1.4 建设范围与边界", "### 1.5 建设范围与边界"),
    ("### 1.3 建设目标", "### 1.4 建设目标"),
    ("口径见 1.5 预估收入", "口径见 1.6 预估收入"),
]


def main():
    text = MD.read_text(encoding="utf-8")
    anchor = "### 1.3 建设目标\n"
    if anchor not in text:
        print("!! 找不到锚点 ### 1.3 建设目标")
        return 1
    text = text.replace(anchor, NEW_SECTION + anchor, 1)
    print(f"已插入 1.3 同类平台对比（{len(NEW_SECTION)} 字符）")
    for old, new in RENAMES:
        n = text.count(old)
        if n != 1:
            print(f"!! {old!r} 命中 {n} 次（应为 1）")
            return 1
        text = text.replace(old, new)
        print(f"  1x {old} → {new}")
    MD.write_text(text, encoding="utf-8")

    print("---- 校验 ----")
    import re
    heads = re.findall(r"^### 1\.\d .*$", text, re.M)
    print("  第一章小节:", " / ".join(h.replace("### ", "") for h in heads))
    return 0


if __name__ == "__main__":
    sys.exit(main())
