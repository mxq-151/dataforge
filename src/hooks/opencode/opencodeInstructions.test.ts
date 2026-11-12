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
  getDeveloperInstructions,
} from './opencodeInstructions';
import {
  AGENT_ANALYSIS_VERIFIER,
  AGENT_DATA_ARCHITECT,
  AGENT_DATA_DEV,
  AGENT_DATA_RETRIEVER,
  AGENT_DATA_VERIFIER,
  AGENT_DESIGN_VERIFIER,
  AGENT_REQUIREMENT_VERIFIER,
  AGENT_REQUIREMENT_WRITER,
} from './devAssistantAgents';
import { parseQualityRulesFromDesignDoc } from '../../utils/qualityRuleImport';
import { QUALITY_RULE_TYPES } from '../../types/quality';

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
      name: '检索协议与降级路径',
      keys: ['检索协议（四条铁律', '三轮不中即停', '本次未完成线上查证'],
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

  it('S2 与 S3 的代码头 @引擎 枚举同源一致（固定 10 个，存储格式引擎不入枚举）', () => {
    // 2026-11 收窄口径：S2 DDL 代码头与 S3 程序代码头共用同一枚举，
    // 只保留平台调度可识别的 10 个引擎；iceberg/hudi/paimon 等存储格式
    // 写进建表语句而非 @引擎，否则 S2 设计的引擎 S3 无法合法引用（链路漂移）。
    const ENGINES =
      'spark、flink、kyuubi、hive、doris、clickhouse、starrocks、mysql、postgresql、presto';
    for (const prompt of [DATA_ARCHITECT_INSTRUCTIONS, DATA_DEV_ENGINEER_INSTRUCTIONS]) {
      expect(prompt).toContain(ENGINES);
    }
    // 已收窄掉的引擎不得回流进提示词
    for (const banned of ['flink_stream', 'hivecli', 'trino', 'iceberg', 'hudi', 'paimon']) {
      expect(DATA_ARCHITECT_INSTRUCTIONS, `S2 提示词不应再出现 ${banned}`).not.toContain(banned);
      expect(DATA_DEV_ENGINEER_INSTRUCTIONS, `S3 提示词不应再出现 ${banned}`).not.toContain(banned);
    }
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

describe('需求阶段 — 编写与校验分离的闭环编排', () => {
  it('S1 声明闭环编排：一个编写子代理统一完成、一个校验子代理独立核对', () => {
    const prompt = BUSINESS_REQUESTER_INSTRUCTIONS;

    expect(prompt).toContain('## 任务定位（需求编写：需求文档编写 → 文档校验的闭环编排）');
    expect(prompt).toContain(AGENT_DATA_RETRIEVER);
    expect(prompt).toContain(AGENT_REQUIREMENT_WRITER);
    expect(prompt).toContain(AGENT_REQUIREMENT_VERIFIER);
    // 每个环节一个子代理统一完成，禁止按场景拆分起草
    expect(prompt).toContain('每个环节派生**一个**子代理统一完成该环节全部工作');
    expect(prompt).toContain('不按分析场景、不按指标、不按文档章节拆成多个子代理');
    // 校验必须换会话：继承编写方推理只会把"自洽"复核成"正确"
    expect(prompt).toContain('校验必须换人');
    expect(prompt).toContain('把「自洽」复核成「正确」');
    // 业务口径只能由用户拍板
    expect(prompt).toContain('不得替用户拍板');
    // 子代理不可用时不阻塞交付，但必须显式标注未完成独立校验
    expect(prompt).toContain('本次未完成独立校验');
  });

  it('S1 跨阶段不得分派设计与开发子代理，也不得回退按场景拆分起草', () => {
    const prompt = BUSINESS_REQUESTER_INSTRUCTIONS;

    expect(prompt).not.toContain(AGENT_DATA_ARCHITECT);
    expect(prompt).not.toContain(AGENT_DATA_DEV);
    expect(prompt).not.toContain(AGENT_DATA_VERIFIER);
    // 已删除的 metric-designer 不得回流
    expect(prompt).not.toContain('metric-designer');
  });

  it('计算口径强制五项要素，且不新增列破坏 7 列解析契约', () => {
    const prompt = BUSINESS_REQUESTER_INSTRUCTIONS;

    for (const key of ['统计对象与粒度', '计数与去重', '时间口径', '有效性限定', '归属与分摊']) {
      expect(prompt, `计算口径缺少要素: ${key}`).toContain(key);
    }
    // 五项写在同一个单元格内，保持 7 列不变
    expect(prompt).toContain('用中文分号分隔，不换行');
  });

  it('下钻维度必须与指标粒度兼容，多归属须写归属规则', () => {
    const prompt = BUSINESS_REQUESTER_INSTRUCTIONS;

    expect(prompt).toContain('粒度兼容');
    expect(prompt).toContain('未写归属规则的维度不得声明');
  });

  it('S1 是编排者：不自检产出，文档规范仅作下发与打回核对的参考', () => {
    // 自检清单是产出方的关口；S1 主智能体是编排者，产出方是 requirement-writer
    expect(BUSINESS_REQUESTER_INSTRUCTIONS).not.toContain('交付前自检清单（必须逐项核对后再回复用户）');
    expect(BUSINESS_REQUESTER_INSTRUCTIONS).toContain('## 参考规范：需求文档完整规范');
    expect(BUSINESS_REQUESTER_INSTRUCTIONS).not.toContain('命名合规：库名、表名、字段名、程序名');

    for (const prompt of [DATA_ARCHITECT_INSTRUCTIONS, DATA_DEV_ENGINEER_INSTRUCTIONS]) {
      expect(prompt).toContain('命名合规：库名、表名、字段名、程序名');
    }
  });

  it('S2 不得替需求补全缺失口径，只能退回待确认', () => {
    expect(DATA_ARCHITECT_INSTRUCTIONS).toContain('口径缺失不等于可以自行补全');
    expect(DATA_ARCHITECT_INSTRUCTIONS).toContain('不得只在设计文档里补写而不回写需求文档');
  });

  it('需求交付闭环：编写 → 文档校验 → 重写 → 复验', () => {
    const prompt = BUSINESS_REQUESTER_INSTRUCTIONS;

    // 闭环章节与阶段划分
    expect(prompt).toContain('## 两阶段闭环执行纪律（强约束）');
    expect(prompt).toContain('## 阶段零：口径确认（写入前一次问完，强约束）');
    expect(prompt).toContain('## 阶段一：需求文档编写');
    expect(prompt).toContain('## 阶段二：文档校验');
    // 写入前先形成口径基线，避免写完再靠校验暴露口径缺失
    expect(prompt).toContain('口径基线');
    expect(prompt).toContain('默认口径（待确认）');
    // 校验是放行门禁：未通过不得向用户交付
    expect(prompt).toContain('禁止向用户宣告完成、禁止交付需求文档');
    // 复验有上界，到上界停止推进并报告用户；停止推进不等于零交付
    expect(prompt).toContain('复验上界：文档校验最多复验**两轮**');
    expect(prompt).toContain('停止推进');
    expect(prompt).toContain('未通过门禁的草稿');
    expect(prompt).toContain('问题清单原样报告用户');
    // 文档由编写子代理统一落盘，重写打回编写子代理，不让校验方代改
    expect(prompt).toContain('重写打回 ' + AGENT_REQUIREMENT_WRITER);
    expect(prompt).toContain('禁止你自己编写需求文档');
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

describe('质检链路闭环 — S2 规则清单可被平台解析、S3 结果可回传平台', () => {
  /** 提示词里声明的规则清单表头，也是平台解析器的识别依据，两处必须逐字一致 */
  const RULE_TABLE_HEADER = '| 规则名 | 规则类型 | 校验对象（库.表.字段） | 阈值 | 处置方式 |';

  it('S2 声明了机器可解析的规则清单表头（5 列，顺序固定）', () => {
    expect(DATA_ARCHITECT_INSTRUCTIONS).toContain('## 稽核规则清单表格规范');
    expect(DATA_ARCHITECT_INSTRUCTIONS).toContain(RULE_TABLE_HEADER);
  });

  it('按提示词表头写出的规则清单能被平台解析器识别（表头契约不漂移）', () => {
    const doc = [
      '## 6. 数据质量稽核设计',
      '',
      RULE_TABLE_HEADER,
      '|--------|----------|------------------------|------|----------|',
      '| R_AD_001 事件主键唯一 | 主键唯一性 | test_db.dwd_event_f.event_id | 重复=0 | 阻断下游+告警 |',
    ].join('\n');

    const { rules, warnings } = parseQualityRulesFromDesignDoc(doc);
    expect(warnings).toEqual([]);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      ruleName: 'R_AD_001 事件主键唯一',
      ruleType: 'PRIMARY_KEY_UNIQUE',
      databaseName: 'test_db',
      tableName: 'dwd_event_f',
      columnName: 'event_id',
      compareMode: 'EQ',
      expectedValue: '0',
      disposeMode: 'BLOCK',
    });
    expect(rules[0].warnings).toEqual([]);
  });

  it('S3 声明了结果回传协议：接口、凭据注入方式与全部必填字段', () => {
    expect(DATA_DEV_ENGINEER_INSTRUCTIONS).toContain('## 质检结果回传规范');
    expect(DATA_DEV_ENGINEER_INSTRUCTIONS).toContain('/api/quality/run/report');
    expect(DATA_DEV_ENGINEER_INSTRUCTIONS).toContain('DATAFORGE_QUALITY_REPORT_URL');
    expect(DATA_DEV_ENGINEER_INSTRUCTIONS).toContain('DATAFORGE_QUALITY_REPORT_TOKEN');
    for (const field of ['datasourceName', 'databaseName', 'tableName', 'batchNo', 'ruleName', 'ruleType', 'passed']) {
      expect(DATA_DEV_ENGINEER_INSTRUCTIONS, `回传协议缺少字段: ${field}`).toContain(field);
    }
    // 回传失败不得改变校验任务本身的成败判定（阻断语义仍由调度 DAG 承载）
    expect(DATA_DEV_ENGINEER_INSTRUCTIONS).toContain('回传失败不得改变校验任务本身的成败判定');
  });

  it('规则名唯一键契约在 S2/S3 同时存在（改名即断链）', () => {
    for (const prompt of [DATA_ARCHITECT_INSTRUCTIONS, DATA_DEV_ENGINEER_INSTRUCTIONS]) {
      expect(prompt).toContain('规则名是全链路唯一键');
    }
  });

  it('S1 不参与校验实现，因此不下发回传协议', () => {
    expect(BUSINESS_REQUESTER_INSTRUCTIONS).not.toContain('/api/quality/run/report');
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

/**
 * 规则模板改由 opencode 的 quality-template 工具按需拉取（不再内嵌提示词）。
 * 提示词侧只负责「告诉 S3 去调这个工具、传哪个规则类型编码、怎么用结果」。
 * 工具实现见 opencode 侧 src/tool/quality-template.ts。
 */
describe('质量规则模板（工具拉取）', () => {
  it('S3 提示词要求先调 quality-template 工具取模板，再照骨架实现', () => {
    const prompt = DATA_DEV_ENGINEER_INSTRUCTIONS;

    expect(prompt).toContain('## 质量规则模板获取（强约束）');
    expect(prompt).toContain('quality-template');
    expect(prompt).toContain('ruleType');
    expect(prompt).toContain('禁止自选模板');
    // 约束：模板会改版，回传须带实际执行的 SQL
    expect(prompt).toContain('execSql');
    // 工具不可用时不阻塞开发（降级路径要写清楚，否则模型可能卡住不产出）
    expect(prompt).toContain('不阻塞开发');
  });

  it('提示词给出 7 类规则类型的编码对照，供调用工具时传参', () => {
    const prompt = DATA_DEV_ENGINEER_INSTRUCTIONS;

    for (const t of QUALITY_RULE_TYPES) {
      expect(prompt, `缺少规则类型编码对照: ${t.code}`).toContain(`${t.label}（${t.code}）`);
    }
  });

  it('S1 / S2 / 数据探索不下发模板获取章节', () => {
    expect(getDeveloperInstructions('BUSINESS_REQUESTER', 'u', 'dev-assistant'))
      .not.toContain('## 质量规则模板获取');
    expect(getDeveloperInstructions('DATA_ARCHITECT', 'u', 'dev-assistant'))
      .not.toContain('## 质量规则模板获取');
    expect(getDeveloperInstructions('DATA_ANALYST', 'u', 'dev-assistant'))
      .not.toContain('## 质量规则模板获取');
    // 数据探索模块按 moduleName 短路，即使角色是数据开发也不该带模板
    expect(getDeveloperInstructions('DATA_DEV_ENGINEER', 'u', 'data-explore'))
      .not.toContain('## 质量规则模板获取');
  });

  it('回传规范声明了 ruleId 与 execSql 两个字段', () => {
    const prompt = DATA_DEV_ENGINEER_INSTRUCTIONS;
    expect(prompt).toContain('| ruleId | 否 |');
    expect(prompt).toContain('| execSql | 否 |');
    expect(prompt).toContain('带上 ruleId 后关联不再依赖名字');
  });
});

/**
 * 规则登记（把关联键从规则名字符串换成 ID）—— 同样只进 S3。
 */
describe('规则登记规范', () => {
  it('S3 提示词声明登记接口、幂等语义与取回 ruleId 的用法', () => {
    const prompt = DATA_DEV_ENGINEER_INSTRUCTIONS;

    expect(prompt).toContain('## 规则登记规范（强约束）');
    expect(prompt).toContain('/api/quality/rule/register');
    // 幂等：判定键必须写清，否则 S3 会以为重复登记会建新规则而选择跳过
    expect(prompt).toContain('平台按"规则名 + 库 + 表"判定同一条规则');
    expect(prompt).toContain('既不新建也不覆盖已有阈值');
    // 令牌沿用回传那套环境变量，不另起一套
    expect(prompt).toContain('DATAFORGE_QUALITY_REPORT_TOKEN');
    // 失败不阻塞开发，但要在汇报里列出
    expect(prompt).toContain('必须在交付汇报里列出未登记成功的规则');
    // 自检清单要覆盖登记
    expect(prompt).toContain('登记合规');
  });

  it('登记接口只出现在数据开发提示词里，S1 / S2 不得出现', () => {
    expect(DATA_DEV_ENGINEER_INSTRUCTIONS).toContain('/api/quality/rule/register');
    expect(BUSINESS_REQUESTER_INSTRUCTIONS).not.toContain('/api/quality/rule/register');
    expect(DATA_ARCHITECT_INSTRUCTIONS).not.toContain('/api/quality/rule/register');
    expect(BUSINESS_REQUESTER_INSTRUCTIONS).not.toContain('规则登记规范');
    expect(DATA_ARCHITECT_INSTRUCTIONS).not.toContain('规则登记规范');
  });

  it('登记不再涉及"挂质检任务"（该链路已下线，不得再指导智能体去挂）', () => {
    const prompt = DATA_DEV_ENGINEER_INSTRUCTIONS;

    // 质检任务 / 运行记录 / 告警订阅三个页签及其整条服务端链路已删除，
    // 提示词里若还留着 taskId 指引，模型会去填一个平台根本不认的字段。
    expect(prompt).not.toContain('taskId');
    expect(prompt).not.toContain('质检任务页签');
    expect(prompt).not.toContain('告警订阅');
    // 登记的核心语义（幂等 + 取回 ruleId）必须保留
    expect(prompt).toContain('data.ruleId 即该规则的平台 ID');
  });
});

/**
 * 回传的表级权限：平台会 fail-close 校验，提示词必须提前说清，否则程序会以为"随便传都能落"。
 */
describe('回传的表级权限约定', () => {
  it('提示词声明无权读表会被拒绝登记结果', () => {
    const prompt = DATA_DEV_ENGINEER_INSTRUCTIONS;

    expect(prompt).toContain('无权读取的表会被拒绝登记结果');
    expect(prompt).toContain('令牌的权限就是发放者账号的权限');
  });

  it('权限说明不进 S1 / S2 提示词', () => {
    expect(BUSINESS_REQUESTER_INSTRUCTIONS).not.toContain('无权读取的表会被拒绝登记结果');
    expect(DATA_ARCHITECT_INSTRUCTIONS).not.toContain('无权读取的表会被拒绝登记结果');
  });
});

/**
 * 质检任务粒度 —— 一张被校验表一个质检程序。
 *
 * 历史问题：提示词只说"质检任务与处理任务分离、独立成文件"，没定粒度，模型把整个业务域的
 * 全部规则写进一个质检程序 —— 一个任务挂了多个上游、失败域糊在一起、重跑要整批重跑，
 * 程序名也无法对应到任何一张表。粒度必须由提示词定死，不能靠模型自行领会。
 */
describe('质检任务粒度 — 一张被校验表一个质检程序', () => {
  it('S3 声明粒度、归属依据与禁止项', () => {
    const prompt = DATA_DEV_ENGINEER_INSTRUCTIONS;

    expect(prompt).toContain('一张被校验表 = 一个质检程序');
    // 归属依据：规则的校验对象所属表，而不是规则类型 / 分层 / 业务域
    expect(prompt).toContain('不是规则类型，也不是分层或业务域');
    expect(prompt).toContain('禁止把所有表、所有规则塞进同一个质检程序');
    // 跨表对账规则必须有明确归属，否则模型会为它单建一个"共享"校验程序
    expect(prompt).toContain('归入其左侧主表所在的质检程序');
    expect(prompt).toContain('禁止把校验逻辑写进数据处理程序内部');
  });

  it('S3 给出可推导的程序名与调度挂载方式', () => {
    const prompt = DATA_DEV_ENGINEER_INSTRUCTIONS;

    expect(prompt).toContain('{分层}_{业务域}_{实体描述}_check_{执行周期}');
    expect(prompt).toContain('dwd_trade_order_check_d.sql');
    // 一个处理任务产出多张表时拆多个质检任务，而不是堆上游依赖到一个任务上
    expect(prompt).toContain('@依赖 只写该处理任务');
    expect(prompt).toContain('拆出多个质检任务');
  });

  it('自检清单覆盖质检粒度，避免产出后再被用户发现', () => {
    expect(DATA_DEV_ENGINEER_INSTRUCTIONS).toContain('质检粒度：');
  });

  it('S2 与 S3 的拆分原则都写明质检粒度（设计端不得把规则堆成一个任务）', () => {
    for (const prompt of [DATA_ARCHITECT_INSTRUCTIONS, DATA_DEV_ENGINEER_INSTRUCTIONS]) {
      expect(prompt).toContain('一张被校验表对应一个质检任务');
    }
  });

  it('S2 规则清单要求按表分组连续书写（解析器遇非表格行即中止）', () => {
    const prompt = DATA_ARCHITECT_INSTRUCTIONS;

    expect(prompt).toContain('表格必须是一张连续表格');
    expect(prompt).toContain('按"库.表"分组连续书写');
  });

  it('回传"不单开节点"的约束不会被读成"把多张表合并进一个程序"', () => {
    expect(DATA_DEV_ENGINEER_INSTRUCTIONS).toContain('不给回传单开节点');
  });
});

/**
 * 数据分类分级口径 —— 分级档位与分类枚举必须写死。
 *
 * 历史问题：提示词只给了「如 cla:用户信息-一般」一个例子，没定档位。模型每次自造一套
 * （"机密/内部/公开"、"一般1级"），三份产物对不上，资产侧统计不出分级分布；更糟的是
 * 旧口径要求"敏感字段不得低于重要"，而 GB/T 43697-2024 明确"仅影响组织自身或公民个体的
 * 数据一般不作为重要数据"—— 把个人信息抬成重要数据会触发重要数据目录报备与风险评估义务。
 * 因此：分级只有三档、分类只有六类、个人信息归一般数据、脱敏作为独立维度强制要求。
 */
describe('数据分类分级口径 — 三档分级 + 六类分类', () => {
  const GRADES = ['核心数据', '重要数据', '一般数据'];
  const CATEGORIES = '个人信息 / 业务数据 / 经营数据 / 公共数据 / 运维数据 / 其他';

  it.each(STAGES)('$id 提示词带上了共享的分类分级口径', ({ prompt }) => {
    expect(prompt).toContain('## 数据分类分级口径（全链路统一，GB/T 43697-2024）');
    for (const grade of GRADES) {
      expect(prompt, `缺少分级档位: ${grade}`).toContain(grade);
    }
    expect(prompt).toContain(CATEGORIES);
    // 档位必须写死：既不额外造档，也不再细分小级
    expect(prompt).toContain('禁止自造档位、禁止再细分小级');
  });

  it('S2 给出固定标注写法 cla:{分类}-{分级} 与可抄的示例', () => {
    const prompt = DATA_ARCHITECT_INSTRUCTIONS;

    expect(prompt).toContain('cla:{分类}-{分级}');
    expect(prompt).toContain('cla:个人信息-一般数据');
    // 表级与字段级都要标，不能只标一处
    expect(prompt).toContain('表级写在表注释尾部，字段级写在字段注释尾部');
  });

  it('个人信息默认一般数据，且明确"不得靠抬高分级代替脱敏"', () => {
    const prompt = DATA_ARCHITECT_INSTRUCTIONS;

    expect(prompt).toContain('默认归"一般数据"');
    expect(prompt).toContain('不得靠抬高分级代替脱敏');
    expect(prompt).toContain('脱敏与分级是两件事');
    // 已废除的旧口径不得残留：它会把个人信息抬成重要数据
    expect(prompt).not.toContain('不得低于"重要"');
  });

  it('S3 把 cla: 标记落到脱敏实现与自检里', () => {
    const prompt = DATA_DEV_ENGINEER_INSTRUCTIONS;

    expect(prompt).toContain('cla: 分类分级标记与脱敏建议实现脱敏');
    expect(prompt).toContain('分类分级落地：');
  });

  it('旁路角色的安全原则自带档位，不引用它们拿不到的口径章节', () => {
    // S1/S2/S3 之外的提示词（超管、数据分析师）只拿到 SECURITY_PRINCIPLES，
    // 里面若写"见数据分类分级口径"会指向一个不存在的章节。
    for (const role of ['SUPER_ADMIN', 'DATA_ANALYST']) {
      const prompt = getDeveloperInstructions(role, 'u', 'dev-assistant');
      expect(prompt).toContain('分级固定为核心数据 / 重要数据 / 一般数据三档');
      expect(prompt).not.toContain('## 数据分类分级口径');
      expect(prompt).not.toContain('见"数据分类分级口径"');
    }
  });
});

/**
 * 数仓开发 = 「数仓设计 → 设计校验 → 代码开发 → 代码校验」的闭环编排。
 *
 * 这里锁的不是文案，而是五件会导致功能静默失效的事：
 * 1. 每个阶段由一个子代理统一完成 —— 任何形式的拆分派发（按表/设计单元/处理任务/
 *    业务域/分层）都会让互相看不到对方的子代理各自决定口径，错误顺着 DAG 放大
 * 2. 设计校验必须先于代码开发，且只做一次全量 —— 数仓分层是一个整体，分批校验时
 *    校验方看不到后续分层，会把「局部自洽、全局冲突」的设计放行，分层失去全局观
 * 3. 代码校验必须是收尾门禁 —— 未通过不得结束对话、不得宣告完成
 * 4. 两个校验环节都要有复验上界 —— 两轮仍不通过就停止推进并报告用户，避免无限循环
 * 5. 两侧机器解析契约必须完整存在 —— 子代理的 prompt 不含契约，只能由主智能体下发
 */
describe('数仓开发 — 设计/设计校验/开发/代码校验四阶段闭环', () => {
  const MERGED = getDeveloperInstructions('DATA_WAREHOUSE_DEV', 'u', 'dev-assistant');

  it('同时包含完整的数仓设计与数据开发提示词', () => {
    expect(MERGED).toContain(DATA_ARCHITECT_INSTRUCTIONS);
    expect(MERGED).toContain(DATA_DEV_ENGINEER_INSTRUCTIONS);
  });

  it('声明编排者定位，并点名四个子代理', () => {
    expect(MERGED).toContain(
      '## 任务定位（数仓开发：设计 → 设计校验 → 代码开发 → 代码校验的闭环编排）',
    );
    for (const agent of [
      AGENT_DATA_ARCHITECT,
      AGENT_DESIGN_VERIFIER,
      AGENT_DATA_DEV,
      AGENT_DATA_VERIFIER,
    ]) {
      expect(MERGED, `未点名子代理: ${agent}`).toContain(agent);
    }
    expect(MERGED).toContain('分派 → 转达规范 → 打回修复 → 校验收口');
  });

  it('每阶段一个子代理统一完成，禁止任何形式的拆分派发', () => {
    expect(MERGED).toContain('## 强制分派纪律（强约束）');
    expect(MERGED).toContain('每个阶段派生**一个**子代理统一完成该阶段全部工作');
    expect(MERGED).toContain('禁止任何形式的拆分派发');
    expect(MERGED).toContain('不按表、不按设计单元、不按处理任务、不按业务域、不按分层');
    // 表数不是分派门槛：单表任务也要走完四阶段
    expect(MERGED).toContain('表数不作门槛：**只有 1 张表也必须分派**');
    // 主智能体亲自写代码 = 编排退化
    expect(MERGED).toContain('禁止你自己编写 ETL 程序');
  });

  it('设计校验是进入代码开发的前置门禁，且等全部层次设计完成后整体校验一次', () => {
    expect(MERGED).toContain('## 四阶段闭环执行纪律（强约束）');
    expect(MERGED).toContain('整体设计校验「通过」之前，禁止进入代码开发');
    // 全局观：一个子代理一次性完成所有层次设计，再整体校验一次
    expect(MERGED).toContain('全部层次的设计与 DDL 落盘后');
    expect(MERGED).toContain(`派生**一个** ${AGENT_DESIGN_VERIFIER} 一次性校验整体设计`);
    // 不得回退成按波次/分批校验
    expect(MERGED).not.toContain('波次');
  });

  it('代码校验是收尾门禁：未通过不得结束对话', () => {
    expect(MERGED).toContain('代码校验「通过」之前，禁止结束本次对话');
    expect(MERGED).toContain('不得宣告完成、不得结束对话');
  });

  it('两个校验环节都有两轮复验上界，到上界停止推进并报告用户', () => {
    expect(MERGED).toContain('设计校验与代码校验各自最多复验**两轮**');
    expect(MERGED).toContain('停止推进');
    expect(MERGED).toContain('不得自行降级放行');
  });

  it('四类子代理严格先后派生，不跨阶段派生', () => {
    expect(MERGED).toContain('禁止跳阶，禁止跨阶段派生');
  });

  it('代码验收统一由 data-verifier 独立执行，且与自检互不替代', () => {
    // 统一口径：自检（产出者）与验收（data-verifier）两道关口，此前散落的
    // "校验代码结果"表述全部收敛到同一份"交付验收规范"
    for (const prompt of [DATA_DEV_ENGINEER_INSTRUCTIONS, MERGED]) {
      expect(prompt).toContain('## 交付验收规范（强约束）');
      expect(prompt).toContain('自检与验收是两道独立关口');
      expect(prompt).toContain('自检不能替代验收');
      expect(prompt).toContain(AGENT_DATA_VERIFIER);
      // 验收必须换人：产出者不校验自己的代码
      expect(prompt).toContain('禁止产出者验收自己');
      // 验收维度随任务描述下发（子代理拿不到主提示词）
      expect(prompt).toContain('任务描述必须随附验收维度清单');
    }
    // 验收是 S3 侧职责，S1/S2 不参与
    for (const prompt of [BUSINESS_REQUESTER_INSTRUCTIONS, DATA_ARCHITECT_INSTRUCTIONS]) {
      expect(prompt).not.toContain('## 交付验收规范');
      expect(prompt).not.toContain(AGENT_DATA_VERIFIER);
    }
    // 编排者在收尾必须分派验收并汇报验收结论
    expect(MERGED).toContain(`**必须分派一个 ${AGENT_DATA_VERIFIER} 子代理**`);
    expect(MERGED).toContain('的验收结论（通过项、不通过项及修复情况）');
  });

  it('两套完整规范的机器解析契约全部保留（供任务描述下发与打回核对）', () => {
    for (const token of [
      '| 指标编码',
      '## 稽核规则清单表格规范',
      '## 代码头格式规范',
      '## 质检结果回传规范',
      '## 规则登记规范（强约束）',
    ]) {
      expect(MERGED, `数仓开发提示词缺少契约: ${token}`).toContain(token);
    }
    // 并行编排章节已删除：数仓开发各阶段由一个子代理统一完成，不再拆分派发
    expect(MERGED).not.toContain('## 多智能体并行编排');
  });

  it('不与需求编写、数据探索的系统指令混同', () => {
    expect(MERGED).not.toBe(getDeveloperInstructions('BUSINESS_REQUESTER', 'u', 'dev-assistant'));
    const explore = getDeveloperInstructions('DATA_WAREHOUSE_DEV', 'u', 'data-explore');
    // 数据探索按 moduleName 短路，即使任务类型是数仓开发也只拿数据分析指令
    expect(explore).not.toContain('## 阶段一：数仓设计');
  });
});

/**
 * 数据分析 = 「编写分析代码 → 代码校验 → 重写 → 复验」的闭环。
 *
 * 数据分析没有设计文档作为对照，若分析方自己写、自己查，口径错误会直接随结论交付给用户。
 * 因此代码校验必须是独立子代理，且作为交付前的放行门禁；复验同样有上界。
 */
describe('数据分析 — 编写分析代码 → 代码校验 → 重写 → 复验', () => {
  const ANALYST = getDeveloperInstructions('DATA_ANALYST', 'alice', 'dev-assistant');

  it('声明分析交付闭环并点名 analysis-verifier', () => {
    expect(ANALYST).toContain('## 分析交付闭环（编写代码 → 代码校验 → 重写 → 复验，强约束）');
    expect(ANALYST).toContain(AGENT_ANALYSIS_VERIFIER);
    // 一次分析只派一个校验子代理，避免按 SQL 片段拆碎验收
    expect(ANALYST).toContain('一次分析只派一个校验子代理');
  });

  it('校验通过前不得交付结论，两轮复验后停止推进', () => {
    expect(ANALYST).toContain('代码未经独立校验不得把结论交给用户');
    expect(ANALYST).toContain('最多两轮');
    expect(ANALYST).toContain('停止推进');
    expect(ANALYST).toContain('不得给出分析结论');
    // 子代理不可用时的降级路径必须显式标注
    expect(ANALYST).toContain('本次未完成独立校验');
  });

  it('校验必须换人，分析文件唯一写入者是主智能体', () => {
    expect(ANALYST).toContain('校验必须换人');
    expect(ANALYST).toContain('分析文件的唯一写入者是你');
    expect(ANALYST).toContain('校验子代理只核对不修改');
  });

  it('数据探索模块经 moduleName 短路后同样走分析闭环', () => {
    const explore = getDeveloperInstructions('DATA_DEV_ENGINEER', 'alice', 'data-explore');
    expect(explore).toContain('## 分析交付闭环');
    expect(explore).toContain(AGENT_ANALYSIS_VERIFIER);
  });
});
