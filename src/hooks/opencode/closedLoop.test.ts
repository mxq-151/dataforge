/**
 * closedLoop.test.ts — 各任务「编写 → 校验 → 重写 → 复验」闭环的契约测试。
 *
 * 提示词按任务类型拆分后（见 ./prompts/），闭环纪律由 shared.verificationDiscipline 统一生成。
 * 本测试分两层：
 * 1. 函数层：verificationDiscipline / getDeveloperInstructions 是闭环的唯一可执行逻辑，
 *    直接单测其分支与参数行为
 * 2. 契约层：锁住四件会导致闭环失效的事——
 *    a. 顺序：编写 → 校验 → 重写 → 复验 → 放行，不能跳步
 *    b. 门禁：校验未通过不得交付，也不得进入下一环节
 *    c. 上界：每个闭环最多复验两轮，到上界停止推进并报告用户
 *    d. 独立性与可运行性：校验由独立子代理执行、只核对不修改，且提示词里引用的
 *       每个子代理名都已在服务端注册（否则 task 分派会静默失败）
 */

import { describe, it, expect } from 'vitest';
import {
  BUSINESS_REQUESTER_INSTRUCTIONS,
  DATA_ARCHITECT_INSTRUCTIONS,
  DATA_DEV_ENGINEER_INSTRUCTIONS,
  DATA_WAREHOUSE_DEV_INSTRUCTIONS,
  SUPER_ADMIN_INSTRUCTIONS,
  getDeveloperInstructions,
} from './opencodeInstructions';
import {
  AGENT_ANALYSIS_VERIFIER,
  AGENT_DATA_ARCHITECT,
  AGENT_DATA_DEV,
  AGENT_DATA_VERIFIER,
  AGENT_DESIGN_VERIFIER,
  AGENT_REQUIREMENT_VERIFIER,
  AGENT_REQUIREMENT_WRITER,
  DEV_ASSISTANT_SUBAGENT_NAMES,
} from './devAssistantAgents';
import { DEV_ASSISTANT_AGENTS } from '../../../electron/backend/devAssistantAgents';
import { verificationDiscipline } from './prompts/shared';

const ANALYST = getDeveloperInstructions('DATA_ANALYST', 'alice', 'dev-assistant');
const WAREHOUSE = getDeveloperInstructions('DATA_WAREHOUSE_DEV', 'u', 'dev-assistant');

/** 三份带闭环的任务提示词 */
const CLOSED_LOOP_PROMPTS: Array<{ name: string; prompt: string }> = [
  { name: '需求编写', prompt: BUSINESS_REQUESTER_INSTRUCTIONS },
  { name: '数仓开发', prompt: DATA_WAREHOUSE_DEV_INSTRUCTIONS },
  { name: '数据分析', prompt: ANALYST },
];

/** 断言某个闭环具备共享校验纪律：放行门禁、换人、两轮上界、到上界停止 */
function expectSharedDiscipline(prompt: string, scope: string): void {
  expect(prompt).toContain('校验是放行门禁');
  expect(prompt).toContain('校验必须换人');
  expect(prompt).toContain(`复验上界：${scope}最多复验**两轮**`);
  expect(prompt).toContain('停止推进');
  expect(prompt).toContain('不得自行降级放行');
}

/** 断言步骤文本按给定顺序出现，防止「先放行、后校验」这类顺序错误 */
function expectOrdered(prompt: string, steps: string[]): void {
  const indexes = steps.map(step => {
    const index = prompt.indexOf(step);
    expect(index, `闭环缺少步骤: ${step}`).toBeGreaterThanOrEqual(0);
    return index;
  });
  for (let i = 1; i < indexes.length; i += 1) {
    expect(indexes[i], `步骤顺序错误: ${steps[i]} 应在 ${steps[i - 1]} 之后`)
      .toBeGreaterThan(indexes[i - 1]);
  }
}

// ──────────────────────────────────────────────────────────────
// 函数层：闭环纪律生成器
// ──────────────────────────────────────────────────────────────

describe('verificationDiscipline() — 闭环纪律生成器', () => {
  it('无论参数如何，六条核心条款始终齐备', () => {
    for (const text of [verificationDiscipline('文档校验'), verificationDiscipline('代码校验', false)]) {
      expect(text).toContain('校验是放行门禁');
      expect(text).toContain('校验必须换人');
      expect(text).toContain('最多复验**两轮**');
      expect(text).toContain('（首次校验 + 两轮复验）');
      expect(text).toContain('**停止推进**');
      expect(text).toContain('不得自行降级放行，也不得反复重试');
      expect(text).toContain('修复与重写由产出方完成，校验子代理只核对不修改');
    }
  });

  it('scope 参数逐字插值进复验上界行，区分各闭环的校验环节', () => {
    expect(verificationDiscipline('文档校验')).toContain('复验上界：文档校验最多复验**两轮**');
    expect(verificationDiscipline('代码校验')).toContain('复验上界：代码校验最多复验**两轮**');
    expect(verificationDiscipline('设计校验与代码校验各自'))
      .toContain('复验上界：设计校验与代码校验各自最多复验**两轮**');
  });

  it('withFallback 默认开启：产出方任务允许子代理不可用时退化为自检', () => {
    expect(verificationDiscipline('文档校验')).toContain('子代理未注册或分派失败时');
    expect(verificationDiscipline('文档校验')).toContain('本次未完成独立校验');
  });

  it('withFallback=false 关闭降级路径：编排者不能自验，不得出现自检退路', () => {
    const text = verificationDiscipline('设计校验与代码校验各自', false);
    expect(text).not.toContain('子代理未注册或分派失败时');
    expect(text).not.toContain('本次未完成独立校验');
  });
});

// ──────────────────────────────────────────────────────────────
// 函数层：闭环提示词的分发入口
// ──────────────────────────────────────────────────────────────

describe('getDeveloperInstructions() — 闭环提示词的分发入口', () => {
  it('data-explore 模块短路优先：任何角色都拿到分析闭环提示词', () => {
    for (const role of ['DATA_WAREHOUSE_DEV', 'BUSINESS_REQUESTER', 'SUPER_ADMIN', '']) {
      const prompt = getDeveloperInstructions(role, 'alice', 'data-explore');
      expect(prompt, `角色 ${role} 在 data-explore 下应拿到分析闭环`).toContain('## 分析交付闭环');
    }
  });

  it('roleType 缺省与未登记角色都兜底为数据开发提示词', () => {
    expect(getDeveloperInstructions('', 'u', 'dev-assistant')).toBe(DATA_DEV_ENGINEER_INSTRUCTIONS);
    expect(getDeveloperInstructions('NO_SUCH_ROLE', 'u', 'dev-assistant'))
      .toBe(DATA_DEV_ENGINEER_INSTRUCTIONS);
  });

  it('角色名大小写不敏感（映射表按 toUpperCase 查找）', () => {
    expect(getDeveloperInstructions('data_warehouse_dev', 'u', 'dev-assistant'))
      .toBe(DATA_WAREHOUSE_DEV_INSTRUCTIONS);
    expect(getDeveloperInstructions('business_requester', 'u', 'dev-assistant'))
      .toBe(BUSINESS_REQUESTER_INSTRUCTIONS);
  });

  it('六个已登记角色各自拿到对应提示词，互不混同', () => {
    expect(getDeveloperInstructions('SUPER_ADMIN', 'u', 'dev-assistant')).toBe(SUPER_ADMIN_INSTRUCTIONS);
    expect(getDeveloperInstructions('DATA_ARCHITECT', 'u', 'dev-assistant')).toBe(DATA_ARCHITECT_INSTRUCTIONS);
    expect(getDeveloperInstructions('DATA_DEV_ENGINEER', 'u', 'dev-assistant')).toBe(DATA_DEV_ENGINEER_INSTRUCTIONS);
    expect(getDeveloperInstructions('DATA_WAREHOUSE_DEV', 'u', 'dev-assistant')).toBe(DATA_WAREHOUSE_DEV_INSTRUCTIONS);
    expect(getDeveloperInstructions('BUSINESS_REQUESTER', 'u', 'dev-assistant')).toBe(BUSINESS_REQUESTER_INSTRUCTIONS);
    expect(getDeveloperInstructions('DATA_ANALYST', 'bob', 'dev-assistant'))
      .toBe(getDeveloperInstructions('DATA_ANALYST', 'bob', 'dev-assistant'));
  });

  it('分析闭环按用户名参数化 SQL 落盘文件，空用户名兜底为「用户」', () => {
    expect(getDeveloperInstructions('DATA_ANALYST', 'alice', 'dev-assistant')).toContain('user_alice.sql');
    expect(getDeveloperInstructions('DATA_ANALYST', '', 'dev-assistant')).toContain('user_用户.sql');
  });
});

// ──────────────────────────────────────────────────────────────
// 契约层：三个闭环的流程纪律
// ──────────────────────────────────────────────────────────────

describe('需求编写闭环 — 编写 → 文档校验 → 重写 → 复验', () => {
  const prompt = BUSINESS_REQUESTER_INSTRUCTIONS;

  it('两个阶段严格按顺序出现：文档编写在前、文档校验在后', () => {
    expect(prompt).toContain('## 任务定位（需求编写：需求文档编写 → 文档校验的闭环编排）');
    expectOrdered(prompt, [
      '## 阶段一：需求文档编写',
      '## 阶段二：文档校验',
    ]);
  });

  it('口径确认前置：写入前一次问完 12 项口径并形成口径基线', () => {
    expect(prompt).toContain('## 阶段零：口径确认（写入前一次问完，强约束）');
    expect(prompt).toContain('一次性列出全部 12 项');
    expect(prompt).toContain('口径基线');
    expect(prompt).toContain('默认口径（待确认）');
    // 阶段零必须先于编写，避免"写完再让校验暴露口径问题"的返工
    expect(prompt.indexOf('## 阶段零：口径确认')).toBeLessThan(
      prompt.indexOf('## 阶段一：需求文档编写'),
    );
  });

  it('复验增量核对；到上界仍有 P0 时交付标注草稿而非零交付', () => {
    expect(prompt).toContain('复验只查未关闭问题、改动段落与新增指标');
    expect(prompt).toContain('问题登记表');
    expect(prompt).toContain('未通过门禁的草稿');
    expect(prompt).toContain('不得宣告完成');
  });

  it('文档校验是放行门禁，未通过不得交付', () => {
    expect(prompt).toContain(AGENT_REQUIREMENT_WRITER);
    expect(prompt).toContain(AGENT_REQUIREMENT_VERIFIER);
    expect(prompt).toContain('文档校验「通过」之前，禁止向用户宣告完成、禁止交付需求文档');
    expectSharedDiscipline(prompt, '文档校验');
  });

  it('文档由编写子代理统一落盘，重写打回编写子代理，校验子代理不代改', () => {
    expect(prompt).toContain('每个环节派生**一个**子代理统一完成该环节全部工作');
    expect(prompt).toContain('不按分析场景、不按指标、不按文档章节拆成多个子代理');
    expect(prompt).toContain('禁止你自己编写需求文档');
    expect(prompt).toContain('校验子代理只核对不修改');
  });
});

describe('数仓开发闭环 — 设计 → 设计校验 → 代码开发 → 代码校验', () => {
  const prompt = DATA_WAREHOUSE_DEV_INSTRUCTIONS;

  it('四个阶段严格按顺序出现，不能跳阶', () => {
    expectOrdered(prompt, [
      '## 阶段一：数仓设计',
      '## 阶段二：设计校验',
      '## 阶段三：代码开发',
      '## 阶段四：代码校验',
    ]);
  });

  it('设计校验通过前禁止进入代码开发', () => {
    expect(prompt).toContain(AGENT_DESIGN_VERIFIER);
    expect(prompt).toContain('整体设计校验「通过」之前，禁止进入代码开发');
    // 设计由一个子代理统一做完所有层次，整体校验一次，不做波次/分批校验
    expect(prompt).toContain('全部层次的设计与 DDL 落盘后');
    expect(prompt).not.toContain('波次');
  });

  it('代码校验通过前不得结束对话', () => {
    expect(prompt).toContain(AGENT_DATA_VERIFIER);
    expect(prompt).toContain('代码校验「通过」之前，禁止结束本次对话');
    expect(prompt).toContain('不得宣告完成、不得结束对话');
  });

  it('两个校验环节共用同一份复验上界与换人纪律', () => {
    expectSharedDiscipline(prompt, '设计校验与代码校验各自');
    // 编排者不能自验，因此不适用「子代理不可用时自检」的降级路径
    expect(prompt).not.toContain('本次未完成独立校验');
  });

  it('每阶段一个子代理统一完成，禁止任何形式的拆分派发', () => {
    expect(prompt).toContain(AGENT_DATA_ARCHITECT);
    expect(prompt).toContain(AGENT_DATA_DEV);
    expect(prompt).toContain('每个阶段派生**一个**子代理统一完成该阶段全部工作');
    expect(prompt).toContain('禁止任何形式的拆分派发');
    // 不按表、不按设计单元、不按处理任务、不按业务域、不按分层拆
    expect(prompt).toContain('不按表、不按设计单元、不按处理任务、不按业务域、不按分层');
    // 主智能体是纯编排者：不写表级产物
    expect(prompt).toContain('禁止你自己编写 ETL 程序、禁止自己写表结构设计');
  });
});

describe('数据分析闭环 — 编写代码 → 代码校验 → 重写 → 复验', () => {
  const prompt = ANALYST;

  it('步骤按编写 → 代码校验 → 重写 → 复验 → 放行排列', () => {
    expect(prompt).toContain('## 分析交付闭环（编写代码 → 代码校验 → 重写 → 复验，强约束）');
    expectOrdered(prompt, [
      '1. 编写：',
      '2. 代码校验：',
      '3. 重写：',
      '4. 复验：',
      '5. 放行：',
    ]);
  });

  it('代码校验是交付门禁，未通过不得给出分析结论', () => {
    expect(prompt).toContain(AGENT_ANALYSIS_VERIFIER);
    expect(prompt).toContain('代码未经独立校验不得把结论交给用户');
    expect(prompt).toContain('不得给出分析结论');
    expectSharedDiscipline(prompt, '代码校验');
  });

  it('分析文件由主智能体独占写入，校验子代理只读', () => {
    expect(prompt).toContain('分析文件的唯一写入者是你');
    expect(prompt).toContain('校验子代理只核对不修改');
  });
});

describe('校验子代理 — 独立、只读、与共享纪律同源', () => {
  const VERIFIERS = [
    AGENT_REQUIREMENT_VERIFIER,
    AGENT_DESIGN_VERIFIER,
    AGENT_ANALYSIS_VERIFIER,
    AGENT_DATA_VERIFIER,
  ];

  it.each(VERIFIERS)('%s 只核对不修改，且必须给出待确认问题', name => {
    const def = DEV_ASSISTANT_AGENTS[name];
    expect(def).toBeDefined();
    expect(def.mode).toBe('subagent');
    expect(def.prompt).toContain('只核对、不修改');
    expect(def.prompt).toContain('待确认问题');
  });

  it('三处闭环引用的纪律与 shared.verificationDiscipline 完全一致', () => {
    expect(BUSINESS_REQUESTER_INSTRUCTIONS).toContain(verificationDiscipline('文档校验'));
    expect(ANALYST).toContain(verificationDiscipline('代码校验'));
    expect(WAREHOUSE).toContain(verificationDiscipline('设计校验与代码校验各自', false));
  });
});

// ──────────────────────────────────────────────────────────────
// 契约层：闭环的可运行性（防 task 分派静默失败）
// ──────────────────────────────────────────────────────────────

describe('闭环引用的子代理 — 全部已在服务端注册', () => {
  it('提示词里出现的每个子代理名都必须在 DEV_ASSISTANT_AGENTS 注册', () => {
    // 提示词引用未注册的 agent 名时，opencode 服务端找不到定义，
    // 主智能体的 task 分派会整批失败且提示词测试无感——在这里前置拦截。
    for (const { name, prompt } of CLOSED_LOOP_PROMPTS) {
      const referenced = DEV_ASSISTANT_SUBAGENT_NAMES.filter(agent => prompt.includes(agent));
      expect(referenced.length, `${name} 闭环未引用任何子代理`).toBeGreaterThan(0);
      for (const agent of referenced) {
        expect(DEV_ASSISTANT_AGENTS[agent], `${name} 闭环引用了未注册的子代理: ${agent}`)
          .toBeDefined();
        expect(DEV_ASSISTANT_AGENTS[agent].mode, `${agent} 必须是 subagent 模式`).toBe('subagent');
      }
    }
  });

  it('每个闭环至少引用一个校验子代理作为放行门禁', () => {
    const GATES: Array<{ name: string; prompt: string; verifier: string }> = [
      { name: '需求编写', prompt: BUSINESS_REQUESTER_INSTRUCTIONS, verifier: AGENT_REQUIREMENT_VERIFIER },
      { name: '数仓开发·设计校验', prompt: DATA_WAREHOUSE_DEV_INSTRUCTIONS, verifier: AGENT_DESIGN_VERIFIER },
      { name: '数仓开发·代码校验', prompt: DATA_WAREHOUSE_DEV_INSTRUCTIONS, verifier: AGENT_DATA_VERIFIER },
      { name: '数据分析', prompt: ANALYST, verifier: AGENT_ANALYSIS_VERIFIER },
    ];
    for (const { name, prompt, verifier } of GATES) {
      expect(prompt, `${name} 的放行门禁应引用 ${verifier}`).toContain(verifier);
    }
  });

  it('产出型子代理（设计/开发）也被数仓开发闭环引用且已注册', () => {
    // 闭环不只是校验：设计与编码的产出方同样走 task 分派，
    // 引用未注册一样会让闭环在阶段一/阶段三静默失败。
    for (const agent of [AGENT_DATA_ARCHITECT, AGENT_DATA_DEV]) {
      expect(WAREHOUSE, `数仓开发闭环应引用产出方 ${agent}`).toContain(agent);
      expect(DEV_ASSISTANT_AGENTS[agent], `${agent} 未注册`).toBeDefined();
    }
  });
});
