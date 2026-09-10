/**
 * opencodeInstructions.test.ts — 需求 → 设计 → 开发 三阶段提示词的链路一致性测试
 *
 * 三份提示词是同一条研发链路的三个环节，靠"共享契约 + 指标主线"串起来：
 *   S1 业务需求方  docs/{业务名称}_开发需求.md
 *     → S2 数据架构师 docs/{业务名称}_数仓设计.md + ddls/{分层}_ddl.sql
 *       → S3 数据开发  {语言}/{分层}/{程序文件}
 * 若任一方改口径而另外两方没跟着改，链路就断了：需求定义的指标在设计里被改名、
 * 设计分配的编码在开发里没落地、三方各用一套质量规则术语，都会让下游对不上上游。
 *
 * 本测试锁住三类契约：
 * 1. 共享契约：周期枚举、质量规则类型、数据源口径、安全原则等在三方同时存在
 * 2. 指标主线：S1 定义（名称即主键）→ S2 继承并分配编码 → S3 按编码实现并标注
 * 3. 产物路径：三方引用同一套 docs/ddls 路径，{业务名称} 贯通
 *
 * 指标表头的列数断言在 extractMetrics.test.ts（解析器视角），
 * 这里补的是"表头在提示词中的位置"（防止映射表等插到指标表头之前被误当作表头）。
 */

import { describe, it, expect } from 'vitest';
import {
  DATA_ARCHITECT_INSTRUCTIONS,
  DATA_DEV_ENGINEER_INSTRUCTIONS,
  BUSINESS_REQUESTER_INSTRUCTIONS,
} from './opencodeInstructions';

/** 三阶段提示词，顺序即链路顺序 */
const STAGES = [
  { id: 'S1 需求', prompt: BUSINESS_REQUESTER_INSTRUCTIONS },
  { id: 'S2 设计', prompt: DATA_ARCHITECT_INSTRUCTIONS },
  { id: 'S3 开发', prompt: DATA_DEV_ENGINEER_INSTRUCTIONS },
] as const;

/** 取出提示词中首个以指定前缀开头的表格行，及其列数 */
function firstTableRow(prompt: string, prefix: string): { cols: number; line: string } {
  const line = prompt
    .split('\n')
    .map(l => l.trim())
    .find(l => l.startsWith(prefix));
  if (!line) throw new Error(`提示词中未找到以 "${prefix}" 开头的表格行`);
  return { cols: line.slice(1, -1).split('|').length, line };
}

describe('链路共享契约 — 三方必须同时具备', () => {
  /** 共享契约片段：任何一处缺失都意味着某一环没跟上链路口径 */
  const SHARED: Array<{ name: string; keys: string[] }> = [
    {
      name: '刷新周期枚举',
      keys: ['d=日，h=小时，w=周，m=月，y=年，r=实时流式，f=全量快照'],
    },
    {
      name: '质量规则 7 类',
      keys: ['主键唯一性', '非空', '值域', '行数波动', '行数环比', '上下游对账', '口径一致性'],
    },
    {
      name: '数据源口径统一',
      keys: ['数据源名称以 metadata 工具查证结果为准'],
    },
    {
      name: '安全原则',
      keys: ['不允许访问工作空间以外的目录或文件'],
    },
    {
      name: '信息获取原则',
      keys: ['信息获取原则', '避免基于猜测'],
    },
    {
      name: '增量追加不覆盖',
      keys: ['目标文件已存在时增量追加', '不得覆盖已有内容'],
    },
    {
      name: '待确认问题兜底',
      keys: ['列出待确认问题'],
    },
  ];

  it.each(SHARED)('$name 在 S1/S2/S3 三份提示词中均有定义', ({ keys }) => {
    for (const { id, prompt } of STAGES) {
      const missing = keys.filter(k => !prompt.includes(k));
      expect(missing, `${id} 提示词缺少共享契约片段: ${missing.join('、')}`).toEqual([]);
    }
  });

  it('S2 与 S3 共享同一份任务拆分原则', () => {
    for (const key of ['最小依赖原则', '容错与隔离性', '幂等可重跑', '质量校验独立']) {
      expect(DATA_ARCHITECT_INSTRUCTIONS, `S2 缺少拆分原则: ${key}`).toContain(key);
      expect(DATA_DEV_ENGINEER_INSTRUCTIONS, `S3 缺少拆分原则: ${key}`).toContain(key);
    }
  });

  it('S2 与 S3 共享同一份分层规范（S3 须遵循 S2 设计的分层）', () => {
    for (const key of ['ODS 贴源层', 'DWD 明细层', 'DWS 汇总层', 'ADS 应用层', '禁止跨层跳跃引用']) {
      expect(DATA_ARCHITECT_INSTRUCTIONS, `S2 缺少分层: ${key}`).toContain(key);
      expect(DATA_DEV_ENGINEER_INSTRUCTIONS, `S3 缺少分层: ${key}`).toContain(key);
    }
  });

  it('血缘调研只出现在掌握表级血缘的 S2/S3，S1 不强求', () => {
    expect(DATA_ARCHITECT_INSTRUCTIONS).toContain('Marquez');
    expect(DATA_DEV_ENGINEER_INSTRUCTIONS).toContain('Marquez');
    expect(BUSINESS_REQUESTER_INSTRUCTIONS).not.toContain('Marquez');
  });
});

describe('指标主线 — S1 定义 → S2 继承并编码 → S3 实现并标注', () => {
  it('S1 明确指标名称为全链路主键，下游不得改名', () => {
    expect(BUSINESS_REQUESTER_INSTRUCTIONS).toContain('全链路主键');
    expect(BUSINESS_REQUESTER_INSTRUCTIONS).toContain('禁止改名、合并或拆分');
  });

  it('S1 给出 S1→S2 的固定列映射，且 7 个需求列全部覆盖', () => {
    expect(BUSINESS_REQUESTER_INSTRUCTIONS).toContain('| 需求列 | S2 设计列 | 下游变化 |');
    // 需求表 7 列逐列给出下游落点，避免设计阶段丢列
    for (const col of ['指标名称', '主题域', '业务定义', '计算口径', '过滤条件', '下钻维度', '应用场景']) {
      expect(BUSINESS_REQUESTER_INSTRUCTIONS, `映射表未覆盖需求列: ${col}`).toContain(`| ${col} |`);
    }
  });

  it('下钻维度在 S1 定义、S2 落地、S3 实现，三方口径贯通', () => {
    // S1：用业务语言声明可下钻的维度与层级
    expect(BUSINESS_REQUESTER_INSTRUCTIONS, 'S1 未定义下钻维度').toContain('下钻维度');
    // S2：把业务维度绑定到实际维度字段
    expect(DATA_ARCHITECT_INSTRUCTIONS, 'S2 未落地下钻维度').toContain('下钻维度');
    expect(DATA_ARCHITECT_INSTRUCTIONS).toContain('维度名(库.表:字段)');
    // S3：按设计声明的维度输出分组字段
    expect(DATA_DEV_ENGINEER_INSTRUCTIONS, 'S3 未实现下钻维度').toContain('下钻维度');
  });

  it('S2 逐字继承 S1 的指标名称与主题域，并分配指标编码', () => {
    expect(DATA_ARCHITECT_INSTRUCTIONS).toContain('逐字继承需求文档');
    expect(DATA_ARCHITECT_INSTRUCTIONS).toContain('指标编码');
    expect(DATA_ARCHITECT_INSTRUCTIONS).toContain('不得遗漏');
  });

  it('S3 按设计文档的指标编码实现，且在代码中显式标注', () => {
    expect(DATA_DEV_ENGINEER_INSTRUCTIONS).toContain('## 指标实现规范');
    // 指标编码写进行注释而非代码头字段，避免破坏 generateFileHeader 的字段模板契约
    expect(DATA_DEV_ENGINEER_INSTRUCTIONS).toContain('-- 指标: {指标编码} {指标名称}');
    expect(DATA_DEV_ENGINEER_INSTRUCTIONS).toContain('不得改写口径或重命名');
  });

  it('S3 代码头 @备注 要求写明所产出的指标编码（机器解析字段未新增，靠备注承载）', () => {
    expect(DATA_DEV_ENGINEER_INSTRUCTIONS).toContain('须在此写明指标编码');
  });
});

describe('机器解析表头 — 在提示词中的位置', () => {
  it('S2 中首个以 "| 指标编码" 开头的行就是 9 列指标表头', () => {
    // 若把映射表/示例表插到指标表头之前，extractMetrics 会取错表头
    const { cols, line } = firstTableRow(DATA_ARCHITECT_INSTRUCTIONS, '| 指标编码');
    expect(cols, `首个匹配行不是 9 列表头: ${line}`).toBe(9);
    expect(line).toContain('下钻维度');
    expect(line).toContain('字段来源');
    expect(line).toContain('数据源');
  });

  it('S1 中首个以 "| 指标名称" 开头的行就是 7 列指标表头', () => {
    // S1 的"S1→S2 映射表"含 "| 指标名称 | 指标名称 | ..." 数据行，必须排在 7 列表头之后
    const { cols, line } = firstTableRow(BUSINESS_REQUESTER_INSTRUCTIONS, '| 指标名称');
    expect(cols, `首个匹配行不是 7 列表头: ${line}`).toBe(7);
    expect(line).toContain('业务定义');
    expect(line).toContain('下钻维度');
    expect(line).toContain('应用场景');
  });
});

describe('产物路径 — 三方引用同一套约定', () => {
  const ARTIFACTS = [
    'docs/{业务名称}_开发需求.md',
    'docs/{业务名称}_数仓设计.md',
    'ddls/{分层}_ddl.sql',
  ];

  it.each(STAGES)('$id 提示词中声明了全链路的三类产物路径', ({ prompt }) => {
    for (const artifact of ARTIFACTS) {
      expect(prompt, `未声明产物路径: ${artifact}`).toContain(artifact);
    }
  });

  it.each(STAGES)('$id 要求 {业务名称} 与上下游保持一致', ({ prompt }) => {
    expect(prompt).toMatch(/\{业务名称\}[^。\n]*一致|一致[^。\n]*\{业务名称\}/);
  });
});
