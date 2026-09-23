/**
 * 设计文档规则清单解析测试 —— 守住「S2 文档 → 平台规则」的解析契约
 *
 * 样例取自真实产物 docs/广告投放效果分析_数仓设计.md 的第 6 章，覆盖解析器的全部降级分支：
 * 缺库名（表.字段）、多字段并列、枚举取值、对照表（↔ / =）、阈值无比较符、类型名带括号后缀。
 * 若提示词里的表格格式改了而解析器没跟上，本测试会直接失败。
 */

import { describe, it, expect } from 'vitest';
import { parseQualityRulesFromDesignDoc, matchQualityTable } from './qualityRuleImport';
import type { QualityTableCandidate } from './qualityRuleImport';

const SAMPLE = `# 广告投放效果分析 数仓设计

## 5. 数据指标

| 指标编码 | 指标名称 |
|--------|------|
| ADV_0001 | 曝光量 |

## 6. 数据质量稽核设计

规则类型取自全链路统一术语：主键唯一性、非空、值域、行数波动、行数环比、上下游对账、口径一致性。

| 规则名 | 规则类型 | 校验对象（表.字段） | 阈值 | 处置方式 |
|--------|----------|---------------------|------|----------|
| R_AD_001 事件主键唯一 | 主键唯一性 | dwd_ad_event_detail_f.event_id | 重复=0 | 阻断+告警 |
| R_AD_005 关键字段非空 | 非空 | dwd_ad_event_detail_f.event_type/ad_id/masked_user_id/event_timestamp | 空值+空串=0 | 阻断+告警 |
| R_AD_006 交互类型值域 | 值域 | dwd_ad_event_detail_f.event_type ∈ {Impression,Click,Like} | 非法值=0 | 阻断+告警 |
| R_AD_009 关联匹配率(广告) | 上下游对账 | dwd_ad_event_detail_f.ad_id ↔ dim_ad_creative_f.ad_id | 匹配率≥99% | 阻断+告警 |
| R_AD_012 口径一致(明细vs汇总) | 口径一致性 | dwd_ad_event_detail_f 曝光量 = dws_ad_overview_f.exposure_cnt | 偏差=0 | 阻断+告警 |
| R_AD_013 口径一致(汇总vs应用) | 口径一致性 | dws_ad_overview_f.点击率 = ads_ad_overview_f.点击率 | 偏差≤0.001 | 告警 |
| R_AD_014 全量装载基线 | 行数波动（装载基线） | dws_ad_overview_f 前后两次装载记录数/金额 | 记录数与金额一致 | 阻断+告警 |
| R_AD_099 自造类型 | 数据新鲜度 | dwd_ad_event_detail_f.event_id | 重复=0 | 告警 |

## 7. 依赖与调度说明

- 无
`;

describe('parseQualityRulesFromDesignDoc — 真实设计文档样例', () => {
  const result = parseQualityRulesFromDesignDoc(SAMPLE);

  it('只解析第 6 章的规则清单，不误取第 5 章指标表', () => {
    expect(result.warnings).toEqual([]);
    expect(result.rules).toHaveLength(8);
    expect(result.rules[0].ruleName).toBe('R_AD_001 事件主键唯一');
  });

  it('规则类型按中文名反查落库编码', () => {
    expect(result.rules[0].ruleType).toBe('PRIMARY_KEY_UNIQUE');
    expect(result.rules[3].ruleType).toBe('UPSTREAM_DOWNSTREAM_RECON');
    expect(result.rules[4].ruleType).toBe('METRIC_CONSISTENCY');
  });

  it('类型名带括号后缀时降级匹配（行数波动（装载基线））', () => {
    expect(result.rules[6].ruleTypeLabel).toBe('行数波动（装载基线）');
    expect(result.rules[6].ruleType).toBe('ROW_COUNT_FLUCTUATION');
    expect(result.rules[6].scope).toBe('TABLE');
  });

  it('表.字段 解析为主表与字段，库名留空待反查', () => {
    expect(result.rules[0].databaseName).toBe('');
    expect(result.rules[0].tableName).toBe('dwd_ad_event_detail_f');
    expect(result.rules[0].columnName).toBe('event_id');
  });

  it('多字段并列只取第一个字段并给出拆条告警', () => {
    const row = result.rules[1];
    expect(row.columnName).toBe('event_type');
    expect(row.warnings.join()).toContain('含 4 个字段');
  });

  it('枚举取值不会被误当成字段', () => {
    const row = result.rules[2];
    expect(row.columnName).toBe('event_type');
    expect(row.warnings.join()).not.toContain('个字段');
  });

  it('↔ 解析出对照表', () => {
    const row = result.rules[3];
    expect(row.tableName).toBe('dwd_ad_event_detail_f');
    expect(row.columnName).toBe('ad_id');
    expect(row.refTableName).toBe('dim_ad_creative_f');
    expect(row.refColumnName).toBe('ad_id');
  });

  it('= 连接的跨表比对同样解析出对照表', () => {
    const row = result.rules[4];
    expect(row.tableName).toBe('dwd_ad_event_detail_f');
    expect(row.columnName).toBe('');
    expect(row.refTableName).toBe('dws_ad_overview_f');
    expect(row.refColumnName).toBe('exposure_cnt');
  });

  it('中文列名（点击率）解析不出字段时给出告警而非猜测', () => {
    const row = result.rules[5];
    expect(row.tableName).toBe('dws_ad_overview_f');
    expect(row.refTableName).toBe('ads_ad_overview_f');
    expect(row.refColumnName).toBe('');
  });

  it('阈值按比较符拆出比较方式与期望值', () => {
    expect(result.rules[0].compareMode).toBe('EQ');
    expect(result.rules[0].expectedValue).toBe('0');
    expect(result.rules[3].compareMode).toBe('GTE');
    expect(result.rules[3].expectedValue).toBe('99');
    expect(result.rules[5].compareMode).toBe('LTE');
    expect(result.rules[5].expectedValue).toBe('0.001');
  });

  it('阈值无比较符时保留原文并告警', () => {
    const row = result.rules[6];
    expect(row.expectedValue).toBe('记录数与金额一致');
    expect(row.warnings.join()).toContain('未含比较符');
  });

  it('处置方式含「阻断」即阻断下游，否则告警', () => {
    expect(result.rules[0].disposeMode).toBe('BLOCK');
    expect(result.rules[5].disposeMode).toBe('ALERT');
  });

  it('自造规则类型不落库，标记为需人工选择', () => {
    const row = result.rules[7];
    expect(row.ruleType).toBe('');
    expect(row.warnings.join()).toContain('不在 7 类统一术语内');
  });
});

describe('parseQualityRulesFromDesignDoc — 文档级降级', () => {
  it('没有质量章节时给出可读原因', () => {
    const r = parseQualityRulesFromDesignDoc('# 设计\n\n## 1. 需求概述\n- 无');
    expect(r.rules).toEqual([]);
    expect(r.warnings[0]).toContain('未找到');
  });

  it('章节内没有规则清单表格时给出可读原因', () => {
    const r = parseQualityRulesFromDesignDoc('## 6. 数据质量稽核设计\n\n暂无规则。');
    expect(r.rules).toEqual([]);
    expect(r.warnings[0]).toContain('未找到同时含');
  });

  it('缺「校验对象」列时整体拒绝，避免落出一批无表可依的规则', () => {
    const r = parseQualityRulesFromDesignDoc(
      '## 6. 数据质量稽核设计\n\n| 规则名 | 规则类型 | 阈值 |\n|------|------|------|\n| R1 | 非空 | 空值=0 |\n'
    );
    expect(r.rules).toEqual([]);
    expect(r.warnings[0]).toContain('缺少必需列');
  });

  it('缺「阈值」列时仍解析，但提示阈值需人工补充', () => {
    const r = parseQualityRulesFromDesignDoc(
      '## 6. 数据质量稽核设计\n\n| 规则名 | 规则类型 | 校验对象 | 处置方式 |\n|------|------|------|------|\n| R1 | 非空 | dwd_x_f.a | 告警 |\n'
    );
    expect(r.rules).toHaveLength(1);
    expect(r.warnings.join()).toContain('缺少「阈值」列');
    expect(r.rules[0].warnings.join()).toContain('阈值为空');
  });
});

describe('matchQualityTable — 元数据反查', () => {
  const candidates: QualityTableCandidate[] = [
    { datasourceId: 1, datasourceName: 'test_datasource', databaseName: 'test_db', tableName: 'dwd_ad_event_detail_f' },
    { datasourceId: 2, datasourceName: 'other_ds', databaseName: 'other_db', tableName: 'ads_ad_overview_f' },
  ];

  it('库+表精确匹配优先', () => {
    const hit = matchQualityTable(candidates, 'test_db', 'dwd_ad_event_detail_f', 'event_id');
    expect(hit?.target.datasourceId).toBe(1);
    expect(hit?.columnName).toBe('event_id');
  });

  it('缺库名时按表名跨库匹配', () => {
    const hit = matchQualityTable(candidates, '', 'dwd_ad_event_detail_f', 'event_id');
    expect(hit?.target.datasourceId).toBe(1);
  });

  it('把「库.表」误读成「表.字段」时兜底换位，字段位置空待人工补', () => {
    const swapped = matchQualityTable(candidates, '', 'test_db', 'dwd_ad_event_detail_f');
    expect(swapped?.target.datasourceId).toBe(1);
    expect(swapped?.columnName).toBe('');
  });

  it('匹配不到返回 undefined，由界面标记为未匹配', () => {
    expect(matchQualityTable(candidates, '', 'not_exist_f', 'a')).toBeUndefined();
  });
});
