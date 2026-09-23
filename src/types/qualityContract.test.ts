/**
 * 质量术语契约测试 —— 守住「7 类规则类型单一事实源」
 *
 * 背景：7 类规则类型是全链路统一术语（S1 提要求 → S2 定规则 → S3 实现），
 * 提示词里明令「禁止自造同义词」。但提示词文本与 UI 用的是两份载体，
 * 一旦只有一处增加/改名，就会出现「AI 按 A 写规则、平台按 B 存规则」的契约断裂，
 * 而且两边都不报错。
 *
 * 因此这里做两件事：
 *   1) 断言 types/quality 的枚举本身自洽（数量、编码与名称唯一）；
 *   2) 断言三方提示词确实包含枚举里的每一条 —— 即提示词由枚举生成，而非各写一份。
 *
 * ⚠ 提示词的数字前缀（1. 2. 3. …）由 QUALITY_RULE_TYPES 的数组顺序生成，
 * 调换顺序等于改提示词编号，本测试会一并校验编号连续。
 */

import { describe, it, expect } from 'vitest';
import {
  QUALITY_RULE_TYPES,
  QUALITY_RULE_TYPE_CODES,
  QUALITY_DISPOSE_MODES,
  getQualityRuleType,
  getQualityRuleTypeByLabel,
} from './quality';
import {
  BUSINESS_REQUESTER_INSTRUCTIONS,
  DATA_ARCHITECT_INSTRUCTIONS,
  DATA_DEV_ENGINEER_INSTRUCTIONS,
} from '../hooks/opencode/opencodeInstructions';

/** 三角色提示词：任一角色缺失都意味着某一环没跟上链路口径 */
const PROMPTS: Array<{ stage: string; prompt: string }> = [
  { stage: 'S1 业务需求方', prompt: BUSINESS_REQUESTER_INSTRUCTIONS },
  { stage: 'S2 数据架构师', prompt: DATA_ARCHITECT_INSTRUCTIONS },
  { stage: 'S3 数据开发工程师', prompt: DATA_DEV_ENGINEER_INSTRUCTIONS },
];

describe('质量规则类型 —— 枚举自洽', () => {
  it('固定为 7 类', () => {
    expect(QUALITY_RULE_TYPES).toHaveLength(7);
    expect(QUALITY_RULE_TYPE_CODES).toHaveLength(7);
  });

  it('规则类型名称两两不同（自造同义名会让覆盖率统计串味）', () => {
    const labels = QUALITY_RULE_TYPES.map(t => t.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('编码两两不同且为大写下划线形式', () => {
    const codes = QUALITY_RULE_TYPES.map(t => t.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('每类都有校验对象范围与说明', () => {
    for (const t of QUALITY_RULE_TYPES) {
      expect(['COLUMN', 'TABLE', 'PAIR']).toContain(t.scope);
      expect(t.desc.length).toBeGreaterThan(0);
    }
  });

  it('按编码与按名称都能反查（S2 稽核规则清单落库的解析依据）', () => {
    for (const t of QUALITY_RULE_TYPES) {
      expect(getQualityRuleType(t.code)).toEqual(t);
      // 名称可能带前后空白，反查须先 trim
      expect(getQualityRuleTypeByLabel(`  ${t.label} `)).toEqual(t);
    }
    expect(getQualityRuleType('NOT_A_REAL_TYPE')).toBeUndefined();
    expect(getQualityRuleTypeByLabel('主键唯一性校验')).toBeUndefined();
  });
});

describe('质量规则类型 —— 三方提示词与枚举同源', () => {
  it.each(PROMPTS)('$stage 提示词包含全部 7 类规则类型名称', ({ prompt }) => {
    const missing = QUALITY_RULE_TYPES.map(t => t.label).filter(label => !prompt.includes(label));
    expect(missing, `提示词缺少规则类型: ${missing.join('、')}`).toEqual([]);
  });

  it.each(PROMPTS)('$stage 提示词包含各规则类型的说明文案', ({ prompt }) => {
    const missing = QUALITY_RULE_TYPES.map(t => t.desc).filter(desc => !prompt.includes(desc));
    expect(missing, `提示词缺少规则类型说明: ${missing.join('、')}`).toEqual([]);
  });

  it.each(PROMPTS)('$stage 提示词按枚举顺序生成 1..7 编号', ({ prompt }) => {
    QUALITY_RULE_TYPES.forEach((t, i) => {
      const line = `${i + 1}. ${t.label}：${t.desc}`;
      expect(prompt, `提示词缺少编号行「${line}」`).toContain(line);
    });
  });

  it.each(PROMPTS)('$stage 提示词保留「禁止自造同义词」约束', ({ prompt }) => {
    expect(prompt).toContain('禁止自造同义词');
  });
});

describe('处置方式 —— 与提示词术语一致', () => {
  it('只有阻断下游与告警两种取值', () => {
    expect(QUALITY_DISPOSE_MODES.map(m => m.code)).toEqual(['BLOCK', 'ALERT']);
    expect(QUALITY_DISPOSE_MODES.map(m => m.label)).toEqual(['阻断下游', '告警']);
  });

  it('三方提示词都保留了「处置方式」这一 S2 设计要素', () => {
    for (const { stage, prompt } of PROMPTS) {
      expect(prompt, `${stage} 提示词缺少「处置方式」`).toContain('处置方式');
    }
  });

  it('S3 提示词明确了阻断语义（阻断下游与告警并列）', () => {
    const s3 = PROMPTS.find(p => p.stage.startsWith('S3'))!.prompt;
    expect(s3).toContain('阻断下游');
    // 阻断的实现方式已由提示词约定为「独立质检任务挂下游」，
    // 因此提示词里不应出现 DataWorks 式的「反向把调度节点置为失败」表述
    expect(s3).not.toContain('将调度节点置为失败');
    expect(s3).not.toContain('置为失败');
  });
});
