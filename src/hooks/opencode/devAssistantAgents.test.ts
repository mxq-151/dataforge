/**
 * devAssistantAgents.test.ts — 多智能体编排的注册完整性测试
 *
 * 子代理定义在 electron 侧（opencode 配置注入），渲染侧经 re-export 复用同一份名称
 * 常量——两侧一致性已由编译期保证。名称写错、子代理没注册、或把机器解析契约复制进
 * 子代理 prompt，仍会让编排静默失效：主智能体发出 task 调用 → 服务端找不到 agent →
 * 整批并行任务失败，而提示词测试完全无感。
 *
 * 因此这里锁三件事：
 * 1. 注册完整：每个名称常量都在 DEV_ASSISTANT_AGENTS 注册表里有定义（防止加了
 *    常量却忘了注册，让 task 分派静默失败）
 * 2. 编排章节按任务归属：各任务提示词只分派自己的子代理
 * 3. 子代理 prompt 不复制机器解析契约（9 列表头、@引擎 枚举等），避免出现第二份事实源
 */

import { describe, it, expect } from 'vitest';
import {
  DEV_ASSISTANT_AGENTS,
  AGENT_ANALYSIS_VERIFIER,
  AGENT_DATA_ARCHITECT,
  AGENT_DATA_DEV,
  AGENT_DATA_RETRIEVER,
  AGENT_DATA_VERIFIER,
  AGENT_DESIGN_VERIFIER,
  AGENT_REQUIREMENT_VERIFIER,
  AGENT_REQUIREMENT_WRITER,
} from '../../../electron/backend/devAssistantAgents';
import {
  DEV_ASSISTANT_SUBAGENT_NAMES,
} from './devAssistantAgents';
import { BUSINESS_REQUESTER_INSTRUCTIONS } from './opencodeInstructions';

describe('子代理注册 — 名称单一事实源下的注册完整性', () => {
  it('electron 侧注册的 agent 与名称清单同名同数量（无漏注册）', () => {
    expect(Object.keys(DEV_ASSISTANT_AGENTS).sort()).toEqual(
      [...DEV_ASSISTANT_SUBAGENT_NAMES].sort(),
    );
  });

  it('名称常量覆盖设计、设计校验、开发、检索、验收、分析校验与需求阶段共八个子代理', () => {
    expect(AGENT_DATA_ARCHITECT).toBe('data-architect');
    expect(AGENT_DATA_DEV).toBe('data-dev');
    expect(AGENT_DATA_RETRIEVER).toBe('data-retriever');
    expect(AGENT_DATA_VERIFIER).toBe('data-verifier');
    expect(AGENT_DESIGN_VERIFIER).toBe('design-verifier');
    expect(AGENT_ANALYSIS_VERIFIER).toBe('analysis-verifier');
    expect(AGENT_REQUIREMENT_WRITER).toBe('requirement-writer');
    expect(AGENT_REQUIREMENT_VERIFIER).toBe('requirement-verifier');
    expect(DEV_ASSISTANT_AGENTS[AGENT_DATA_ARCHITECT]).toBeDefined();
    expect(DEV_ASSISTANT_AGENTS[AGENT_DATA_DEV]).toBeDefined();
    expect(DEV_ASSISTANT_AGENTS[AGENT_DATA_RETRIEVER]).toBeDefined();
    expect(DEV_ASSISTANT_AGENTS[AGENT_DATA_VERIFIER]).toBeDefined();
    expect(DEV_ASSISTANT_AGENTS[AGENT_DESIGN_VERIFIER]).toBeDefined();
    expect(DEV_ASSISTANT_AGENTS[AGENT_ANALYSIS_VERIFIER]).toBeDefined();
    expect(DEV_ASSISTANT_AGENTS[AGENT_REQUIREMENT_WRITER]).toBeDefined();
    expect(DEV_ASSISTANT_AGENTS[AGENT_REQUIREMENT_VERIFIER]).toBeDefined();
  });

  it.each(Object.entries(DEV_ASSISTANT_AGENTS))(
    '%s 是 subagent 模式且带用途描述与角色指令',
    (_name, def) => {
      // mode 必须是 subagent：设为 primary 会污染主智能体的切换列表
      expect(def.mode).toBe('subagent');
      expect(def.description.length).toBeGreaterThan(20);
      expect(def.prompt).toContain('## 角色');
      expect(def.prompt).toContain('待确认问题');
    },
  );
});

describe('编排章节 — 各任务只分派自己的子代理', () => {
  it('验收子代理只核对不修改：独立验收、语法校验、结构化报告三要素齐备', () => {
    const def = DEV_ASSISTANT_AGENTS[AGENT_DATA_VERIFIER];

    // 验收必须独立：只读不改，问题走报告，由主智能体安排修复
    expect(def.prompt).toContain('只核对、不修改');
    expect(def.prompt).toContain('不要修复代码');
    expect(def.prompt).toContain('验收与开发必须分开');
    // 语法校验是验收的一部分
    expect(def.prompt).toContain('compile（Java/Scala）或 sql-validate（SQL）');
    // 验收以需求 → 设计 → 代码为主线：核对的是"是否符合开发需求要求"
    expect(def.prompt).toContain('需求 → 设计 → 代码');
    expect(def.prompt).toContain('都要在代码中找到落地');
    // 结构化出口：整体结论 + 通过项 + 不通过项 + 待确认
    expect(def.prompt).toContain('验收结论：通过 / 不通过');
    expect(def.prompt).toContain('不通过项清单');
    // 首轮 P0 全量、复验增量、问题登记表与单次编译
    expect(def.prompt).toContain('## 校验分层与成本约束');
    expect(def.prompt).toContain('复验增量');
    expect(def.prompt).toContain('问题登记表');
    expect(def.prompt).toContain('只跑一次批处理');
    expect(def.prompt).toContain('P1 未关闭不阻断草稿交付');
    // 验收必须分级，避免任一格式问题触发整轮全量验收
    for (const level of ['P0', 'P1', 'P2']) {
      expect(def.prompt, `验收缺少分级: ${level}`).toContain(level);
    }
  });

  it('设计校验子代理整体校验全部层次，P0 未关闭不得放行进入代码开发', () => {
    const def = DEV_ASSISTANT_AGENTS[AGENT_DESIGN_VERIFIER];

    // 设计校验与设计产出必须分开：只读不改，问题走报告
    expect(def.prompt).toContain('只核对、不修改');
    expect(def.prompt).toContain('不替用户做业务决策');
    // 查不到的事项不得默认通过
    expect(def.prompt).toContain('三态判定');
    expect(def.prompt).toContain('无法判定');
    // 全局观：等全部层次设计落盘后一次校验，不按波次/分层分批
    expect(def.prompt).toContain('全部层次的数仓设计与 DDL 落盘后');
    expect(def.prompt).toContain('全局分层与依赖');
    expect(def.prompt).not.toContain('波次');
    // 门禁语义：设计错误必须在编码之前拦截
    expect(def.prompt).toContain('不得放行进入代码开发');
    // 设计层校验维度必须齐备，避免只知道"看一致性"却漏掉解析契约
    for (const dim of ['需求覆盖', '三方一致', '指标一致', '可溯性', '命名与环境', '分类分级', '稽核规则']) {
      expect(def.prompt, `设计校验缺少维度: ${dim}`).toContain(dim);
    }
    // P0/P1/P2 分级与证据要求
    expect(def.prompt).toContain('P0');
    expect(def.prompt).toContain('证据');
    // 首轮 P0 全量、复验增量、问题登记表与证据复用
    expect(def.prompt).toContain('## 校验分层与成本约束');
    expect(def.prompt).toContain('复验增量');
    expect(def.prompt).toContain('问题登记表');
    expect(def.prompt).toContain('证据包视为已查证事实');
    expect(def.prompt).toContain('单次最多 2 张表');
    expect(def.prompt).toContain('P1 未关闭不阻断草稿交付');
  });

  it('分析代码校验子代理只核对不修改，且校验通过前不得交付结论', () => {
    const def = DEV_ASSISTANT_AGENTS[AGENT_ANALYSIS_VERIFIER];

    expect(def.prompt).toContain('只核对、不修改');
    expect(def.prompt).toContain('三态判定');
    expect(def.prompt).toContain('无法判定');
    // 只读是数据分析的硬边界：写操作直接判不通过
    expect(def.prompt).toContain('只允许 SELECT / WITH');
    expect(def.prompt).toContain('INSERT');
    // 校验目的是防止口径错误随结论交付给用户
    expect(def.prompt).toContain('不得把分析结论交付给用户');
    expect(def.prompt).toContain('sql-validate');
    // 查询规范与脱敏必须在校验维度里
    expect(def.prompt).toContain('LIMIT');
    expect(def.prompt).toContain('敏感字段');
  });

  it('设计与开发子代理统一完成全部工作，不再按任何粒度拆分', () => {
    const architect = DEV_ASSISTANT_AGENTS[AGENT_DATA_ARCHITECT];
    const dev = DEV_ASSISTANT_AGENTS[AGENT_DATA_DEV];

    // 设计：一个子代理统一做完本次需求的全部设计，直接落盘
    expect(architect.prompt).toContain('统一完成本次需求的全部数仓设计');
    expect(architect.prompt).toContain('从 ODS 到 ADS 的所有目标表一次做完');
    expect(architect.prompt).toContain('直接写入');
    // 修订任务最小化：只改受影响表与 DDL，不整篇重写、不重跑全量格式自检
    expect(architect.prompt).toContain('## 修订模式');
    expect(architect.prompt).toContain('只改受影响表与 DDL');
    expect(architect.prompt).toContain('禁止整篇重写设计文档');
    expect(architect.prompt).toContain('不重跑全量格式自检');
    expect(architect.prompt).toContain('bash 工具调用不超过 3 次');
    expect(architect.prompt).toContain('上下文压缩');
    // 开发：一个子代理统一做完全部处理任务与质检程序
    expect(dev.prompt).toContain('统一完成设计文档定义的全部代码开发');
    expect(dev.prompt).toContain('全部处理任务');
    // 质检粒度不变：一张被校验表一个质检程序
    expect(dev.prompt).toContain('一张被校验表一个质检程序');
  });

  it('S1 只分派需求阶段子代理（编写与校验各一个），不跨越到设计与开发链路', () => {
    const prompt = BUSINESS_REQUESTER_INSTRUCTIONS;
    expect(prompt).toContain('## 任务定位（需求编写：需求文档编写 → 文档校验的闭环编排）');
    expect(prompt).toContain(AGENT_DATA_RETRIEVER);
    expect(prompt).toContain(AGENT_REQUIREMENT_WRITER);
    expect(prompt).toContain(AGENT_REQUIREMENT_VERIFIER);
    // 需求阶段不得跨阶段分派设计与开发子代理
    expect(prompt).not.toContain(AGENT_DATA_DEV);
    expect(prompt).not.toContain(AGENT_DATA_ARCHITECT);
    expect(prompt).not.toContain(AGENT_DATA_VERIFIER);
    // 已删除的按场景拆分起草子代理不得回流
    expect(prompt).not.toContain('metric-designer');
    expect(prompt).not.toContain('多智能体并行编排');
  });
});

describe('需求阶段子代理 — 编写与校验分离', () => {
  it('需求文档编写子代理统一完成全部文档并直接落盘，不做技术设计', () => {
    const def = DEV_ASSISTANT_AGENTS[AGENT_REQUIREMENT_WRITER];

    expect(def.prompt).toContain('统一完成本次需求的全部需求文档');
    expect(def.prompt).toContain('直接写入');
    expect(def.prompt).toContain('不写 SQL');
    // 指标行必须写全归属规则；否则订单级指标按类目下钻会重复计数
    expect(def.prompt).toContain('归属或分摊规则');
    // 机器契约由主智能体随任务描述下发，子代理不自行猜测
    expect(def.prompt).toContain('以任务描述中主智能体下发的规范摘要为准');
    // 口径取舍不替用户拍板
    expect(def.prompt).toContain('口径取舍不要自行拍板');
    // 修订任务最小化：只改受影响段落，不整篇重写、不重跑全量格式自检
    expect(def.prompt).toContain('## 修订模式');
    expect(def.prompt).toContain('只改受影响段落');
    expect(def.prompt).toContain('禁止整篇重写');
    expect(def.prompt).toContain('不重跑全量格式自检');
    expect(def.prompt).toContain('bash 工具调用不超过 3 次');
    expect(def.prompt).toContain('上下文压缩');
  });

  it('需求校验子代理只核对不修改，三态判定且不替用户决策', () => {
    const def = DEV_ASSISTANT_AGENTS[AGENT_REQUIREMENT_VERIFIER];

    expect(def.prompt).toContain('只核对、不修改');
    // 查不到的事项不得默认通过，必须显式判"无法判定"
    expect(def.prompt).toContain('三态判定');
    expect(def.prompt).toContain('无法判定');
    // 需求校验不做技术评审，也不替业务拍板
    expect(def.prompt).toContain('不替用户做业务决策');
    expect(def.prompt).toContain('不评价技术实现');
  });

  it('需求校验子代理的口径完整性规则可逐条判定', () => {
    const def = DEV_ASSISTANT_AGENTS[AGENT_REQUIREMENT_VERIFIER];

    expect(def.prompt).toContain('## 口径完整性校验规则');
    // 首轮 P0 不允许抽样：每个指标 × 每条 P0 规则都要过；复验按问题登记表增量核对
    expect(def.prompt).toContain('不得抽样');
    expect(def.prompt).toContain('## 校验分层与成本约束');
    expect(def.prompt).toContain('复验增量');
    expect(def.prompt).toContain('问题登记表');
    expect(def.prompt).toContain('证据包视为已查证事实');
    expect(def.prompt).toContain('单次最多 2 张表');
    for (const rule of [
      '粒度声明',
      '计数方式',
      '比率结构',
      '时间语义',
      '限定词可判定',
      '归属规则',
      '分摊完整性',
      '总额守恒',
      '指标间一致',
    ]) {
      expect(def.prompt, `缺少口径规则: ${rule}`).toContain(rule);
    }
    // 问题必须可追溯到具体规则，避免只给"口径不完整"的笼统结论
    expect(def.prompt).toContain('规则编号');
  });
});

describe('子代理 prompt 不复制机器解析契约', () => {
  /**
   * 这些字符串是 extractMetrics / fileHeader / programArgs 的解析依据，
   * 唯一事实源必须是 S2/S3 提示词。复制进子代理 prompt 就会产生第二份，且无人对齐。
   */
  const FORBIDDEN = [
    '| 指标编码',
    'spark、flink、flink_stream',
    'cla:{分类}-{分级}',
    '| 规则名 | 规则类型',
  ];

  it.each(Object.entries(DEV_ASSISTANT_AGENTS))(
    '%s 的角色指令里没有契约正文',
    (_name, def) => {
      for (const token of FORBIDDEN) {
        expect(def.prompt, `子代理 prompt 出现了契约正文: ${token}`).not.toContain(token);
      }
    },
  );

  it('设计与开发子代理被明确要求以主智能体下发的规范摘要为准', () => {
    for (const name of [AGENT_DATA_ARCHITECT, AGENT_DATA_DEV]) {
      const def = DEV_ASSISTANT_AGENTS[name];
      expect(def.prompt).toContain('规范来源（强约束）');
      expect(def.prompt).toContain('以任务描述中');
    }
  });

  it('检索子代理只负责找，不写产物，且要求带证据与置信度', () => {
    const def = DEV_ASSISTANT_AGENTS[AGENT_DATA_RETRIEVER];

    // 检索过程隔离在子会话里，产物只有证据包
    expect(def.prompt).toContain('不写文件');
    expect(def.prompt).toContain('不产出设计方案');
    // 必须知道用哪些工具、怎么判收敛
    expect(def.prompt).toContain('metadata_search');
    expect(def.prompt).toContain('knowledge_search');
    expect(def.prompt).toContain('lineage_walk');
    expect(def.prompt).toContain('最多三轮');
    // 未命中要有结构化出口，否则模型会用推测填空
    expect(def.prompt).toContain('resolved');
    expect(def.prompt).toContain('confidence');
    expect(def.prompt).toContain('unresolved');
  });
});
