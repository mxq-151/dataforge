/**
 * 质量术语契约测试 —— 守住「7 类规则类型单一事实源」
 *
 * 7 类规则类型是平台统一术语。提示词侧已随经典编排下线（数仓开发改走 dw-dev kit），
 * 这里只保留枚举自身的自洽校验，防止 UI/解析器出现「AI 按 A 写规则、平台按 B 存规则」。
 */

import { describe, it, expect } from 'vitest';
import {
  QUALITY_RULE_TYPES,
  QUALITY_RULE_TYPE_CODES,
  QUALITY_DISPOSE_MODES,
  getQualityRuleType,
  getQualityRuleTypeByLabel,
} from './quality';

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

describe('处置方式 —— 枚举自洽', () => {
  it('只有阻断下游与告警两种取值', () => {
    expect(QUALITY_DISPOSE_MODES.map(m => m.code)).toEqual(['BLOCK', 'ALERT']);
    expect(QUALITY_DISPOSE_MODES.map(m => m.label)).toEqual(['阻断下游', '告警']);
  });
});
