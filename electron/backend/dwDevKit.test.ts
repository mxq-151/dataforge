// @vitest-environment node
/**
 * dw-dev 确定性校验的契约测试：DDL 方言、文档形状、指标绑定、依赖图、代码静态规则。
 * 这些规则是「生成代码能否落盘」的唯一依据，必须用真实样例而不是 mock。
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ddlHeaderIssues, designDocIssues, renderDesignDoc, renderDdlBundle } from '../../agentkit/dw-dev/lib/render';
import {
  buildMetaIndex,
  buildTrace,
  validateGraph,
  validateMetric,
  validateQuality,
  validateTable,
  validateTrace,
} from '../../agentkit/dw-dev/lib/design-validator';
import { checkSyntax, duplicateLogicIssues, parseCodeHeader, validateJob, validateUtil } from '../../agentkit/dw-dev/lib/code-validator';
import { deriveJobPlan } from '../../agentkit/dw-dev/lib/jobs';
import type {
  EvidenceRecord,
  JobSpec,
  MetricDesign,
  QualityRuleDesign,
  TableDesign,
} from '../../agentkit/dw-dev/lib/constants';

const table: TableDesign = {
  enName: 'dwd_trade_orderdetail_d',
  cnName: '交易订单明细日表',
  layer: 'dwd',
  domain: 'trade',
  env: '_prod',
  grain: '一行代表一个订单商品明细行',
  businessDefinition: '统计期内支付成功订单的商品明细，金额为实付金额',
  drillDimensions: ['时间', '商品类目'],
  etlSteps: ['从交易库同步订单主表与订单明细', '清洗并补全商品与支付信息', '按订单商品明细粒度写入日分区'],
  primaryKey: ['order_id', 'sku_id'],
  partition: { field: 'dt', format: 'yyyy-MM-dd', strategy: 'single' },
  storage: { format: 'orc', compression: 'snappy' },
  lifecycleDays: 365,
  updateMode: 'incremental',
  rerunnable: true,
  engine: 'spark',
  datasource: '交易库',
  classification: {
    industry: '零售',
    businessAttribute: '业务领域',
    categoryPath: '零售-交易-订单明细',
  },
  level: {
    tier: '一般数据',
    impactObject: '组织权益',
    impactDegree: '一般危害',
    basis: '仅影响本组织经营分析，不涉及公共利益',
  },
  owner: '交易数据组',
  consumer: '经营分析看板',
  upstream: ['ods_trade_prod.ods_trade_order_d'],
  fields: [
    { name: 'order_id', cnName: '订单ID', logicalType: 'string', nullable: false, level: { tier: '一般数据' }, personalInfo: '否', masking: '掩码脱敏' },
    { name: 'sku_id', cnName: '商品ID', logicalType: 'string', nullable: false, level: { tier: '一般数据' }, personalInfo: '否', masking: '无需脱敏' },
    { name: 'pay_amount', cnName: '支付金额', logicalType: 'decimal(18,2)', nullable: true, level: { tier: '一般数据' }, personalInfo: '否', masking: '掩码脱敏' },
    { name: 'dt', cnName: '分区日期', logicalType: 'string', nullable: false, level: { tier: '一般数据' }, personalInfo: '否', masking: '无需脱敏' },
  ],
};

const evidence: EvidenceRecord[] = [
  {
    database: 'ods_trade_prod',
    table: 'ods_trade_order_d',
    datasource: '交易库',
    sourceTool: 'metadata_search',
    query: 'ods_trade_order_d',
    total: 1,
    hit: true,
    snippet: 'ods_trade_prod.ods_trade_order_d 交易订单贴源表',
  },
  {
    database: 'ods_trade_prod',
    table: 'ods_trade_order_d',
    column: 'order_id',
    datasource: '交易库',
    sourceTool: 'metadata_detail',
    query: 'ods_trade_order_d.order_id',
    total: 1,
    hit: true,
    snippet: 'order_id string 订单ID',
  },
];

const metric: MetricDesign = {
  code: 'TRD_0001',
  name: '支付金额',
  domain: '交易域',
  meaning: '统计期内支付成功的订单金额之和',
  expression: "sum(pay_amount) where pay_status='PAID'",
  filter: '仅正式渠道',
  dimensions: '时间(dwd_trade_prod.dwd_trade_orderdetail_d:dt)',
  sources: 'dwd_trade_prod.dwd_trade_orderdetail_d:pay_amount,dt',
  datasource: '交易库',
  isNew: false,
};

const rule: QualityRuleDesign = {
  name: 'R_TRD_001 订单明细主键唯一',
  ruleType: '主键唯一性',
  target: 'dwd_trade_prod.dwd_trade_orderdetail_d.order_id',
  threshold: '重复=0',
  disposition: '阻断下游',
  table: 'dwd_trade_prod.dwd_trade_orderdetail_d',
};

const req = {
  businessName: '交易',
  businessGoal: '看清交易规模',
  audiences: ['运营'],
  decisionScenes: ['日报'],
  updateFrequency: '日',
  latestAvailableTime: '09:00',
  historyBackfill: '365 天',
  outputs: [{ type: '看板', consumer: '运营', access: 'BI' }],
  scenes: [],
  questions: [],
  metrics: [{ name: '支付金额' }],
};

const meta = buildMetaIndex(evidence);

function validJob(overrides: Partial<JobSpec> = {}): JobSpec {
  return {
    name: 'dwd_trade_orderdetail_etl_d',
    kind: 'sql',
    engine: 'spark',
    layer: 'dwd',
    domain: 'trade',
    entity: 'orderdetail',
    op: 'etl',
    cycle: 'd',
    filePath: 'sql/dwd/dwd_trade_orderdetail_etl_d.sql',
    code: [
      '/*',
      ' * @备注: 订单明细日表加工',
      ' * @引擎: spark',
      ' * @依赖: 无',
      ' * @程序参数: --day ${day}',
      ' * @资源参数: --driver-memory 2g',
      ' * @任务参数: --master yarn',
      ' * @数据源: 交易库',
      ' */',
      "insert overwrite table dwd_trade_prod.dwd_trade_orderdetail_d partition (dt='${day}')",
      'select order_id, sku_id, pay_amount, \'${day}\' as dt',
      'from ods_trade_prod.ods_trade_order_d',
      "where dt='${day}'",
    ].join('\n'),
    dependencies: [],
    programParams: '--day ${day}',
    datasource: ['交易库'],
    targetTable: 'dwd_trade_prod.dwd_trade_orderdetail_d',
    sourceTables: ['ods_trade_prod.ods_trade_order_d'],
    metricCodes: [],
    ...overrides,
  };
}

describe('dw-dev 设计校验', () => {
  it('表/指标/规则在证据齐全时无确定性错误', () => {
    expect(validateTable(table, [table], meta)).toEqual([]);
    expect(validateMetric(metric, [table], ['支付金额'], meta)).toEqual([]);
    expect(validateQuality([rule], [table], meta)).toEqual([]);
    expect(validateGraph([table], [metric], { ...req, outputs: [], scenes: [] }, meta)).toEqual([]);
    const trace = buildTrace([metric]);
    expect(validateTrace(['支付金额'], [metric], trace)).toEqual([]);
    expect(trace[0]).toMatchObject({ table: 'dwd_trade_prod.dwd_trade_orderdetail_d', code: 'TRD_0001' });
  });

  it('缺 metadata 证据时失败，不放过近似名', () => {
    const issues = validateTable({ ...table, upstream: ['ods_trade_prod.ods_order_d'] }, [table], meta);
    expect(issues.some((issue) => issue.code === 'W05_META_UNVERIFIED')).toBe(true);
  });

  it('指标名称必须逐字继承需求', () => {
    const issues = validateMetric({ ...metric, name: '支付总金额' }, [table], ['支付金额'], meta);
    expect(issues.some((issue) => issue.code === 'W14_METRIC_NAME_MISMATCH')).toBe(true);
  });

  it('依赖倒挂与成环被拒绝', () => {
    const ods: TableDesign = { ...table, enName: 'ods_trade_order_d', layer: 'ods', upstream: [] };
    const upside: TableDesign = { ...table, enName: 'dwd_trade_order_d', upstream: ['dws_trade_prod.dws_trade_order_1d'] };
    const dws: TableDesign = { ...table, enName: 'dws_trade_order_1d', layer: 'dws', upstream: ['dwd_trade_prod.dwd_trade_order_d'] };
    const issues = validateGraph([ods, upside, dws], [], { ...req, outputs: [], scenes: [] }, meta);
    expect(issues.some((issue) => issue.code === 'W22_LINEAGE')).toBe(true);
  });

  it('W22 按分层允许上游：DWS 不得直连 ODS，DWS 读 DWD 合法', () => {
    const ods: TableDesign = { ...table, enName: 'ods_trade_order_d', layer: 'ods', upstream: [] };
    const illegal: TableDesign = { ...table, enName: 'dws_trade_ordersum_1d', layer: 'dws', upstream: ['ods_trade_prod.ods_trade_order_d'] };
    expect(
      validateGraph([ods, illegal], [], { ...req, outputs: [], scenes: [] }, meta).some((issue) => issue.code === 'W22_LINEAGE'),
    ).toBe(true);

    const legal: TableDesign = { ...table, enName: 'dws_trade_ordersum_1d', layer: 'dws', upstream: ['dwd_trade_prod.dwd_trade_orderdetail_d'] };
    expect(
      validateGraph([table, legal], [], { ...req, outputs: [], scenes: [] }, meta).filter((issue) => issue.code === 'W22_LINEAGE'),
    ).toEqual([]);
  });

  it('W06 严格四段、保留字与长度上限', () => {
    const codes = (candidate: TableDesign) => validateTable(candidate, [candidate], meta).map((issue) => issue.code);
    expect(codes({ ...table, enName: 'dwd_trade_order_detail_d' })).toContain('W06_TABLE_NAME');
    expect(codes({ ...table, enName: 'dwd_trade_select_d' })).toContain('W06_TABLE_NAME');
    expect(codes({ ...table, enName: `dwd_trade_${'x'.repeat(60)}_d` })).toContain('W06_TABLE_NAME');
  });

  it('W45 临时表命名与清理', () => {
    const temp = {
      ...table,
      enName: 'tmp_trade_orderdetail_d',
      cnName: '订单临时表',
      tableType: '临时表' as const,
      tempTtlDays: 3,
      lifecycleDays: 3,
    };
    const issues = validateTable(temp, [temp], meta);
    expect(issues.some((issue) => issue.code === 'W45_TEMP_TABLE' || issue.code === 'W06_TABLE_NAME')).toBe(false);

    const tooLong = { ...temp, tempTtlDays: 30, lifecycleDays: 30 };
    expect(validateTable(tooLong, [tooLong], meta).some((issue) => issue.code === 'W45_TEMP_TABLE')).toBe(true);
  });

  it('W45 临时表全链路：设计、DDL、作业计划与代码校验', () => {
    const temp: TableDesign = {
      ...table,
      enName: 'tmp_trade_orderdetail_d',
      cnName: '交易订单明细日表',
      tableType: '临时表',
      tempTtlDays: 3,
      lifecycleDays: 3,
    };
    expect(validateTable(temp, [temp], meta)).toEqual([]);

    const ddl = renderDdlBundle([temp]);
    expect(ddl.issues).toEqual([]);
    expect(ddl.files[0].content).toContain('CREATE TABLE IF NOT EXISTS dwd_trade_prod.tmp_trade_orderdetail_d');

    const plan = deriveJobPlan([temp], [])[0];
    expect(plan).toMatchObject({
      name: 'tmp_trade_orderdetail_etl_d',
      layer: 'dwd',
      filePath: 'sql/dwd/tmp_trade_orderdetail_etl_d.sql',
    });

    const tempJob = validJob({
      name: plan.name,
      layer: 'dwd',
      filePath: plan.filePath,
      targetTable: 'dwd_trade_prod.tmp_trade_orderdetail_d',
      sourceTables: ['ods_trade_prod.ods_trade_order_d'],
      code: validJob().code.replaceAll('dwd_trade_prod.dwd_trade_orderdetail_d', 'dwd_trade_prod.tmp_trade_orderdetail_d'),
    });
    expect(validateJob(tempJob, { tables: [temp], meta, trace: [] })).toEqual([]);
  });

  it('W43 公共 UDF 的 package 与类名', () => {
    const util = {
      kind: 'util' as const,
      name: 'DateUtils',
      filePath: 'code/utils/DateUtils.scala',
      code: 'package TEST.code.utils\nobject DateUtils { def day(): String = "x" }',
    };
    expect(validateUtil(util, '/tmp/warehouse/TEST').some((issue) => issue.code === 'W43_PACKAGE_CLASS')).toBe(false);
    const wrong = { ...util, code: util.code.replace('package TEST.code.utils', 'package TEST.utils') };
    expect(validateUtil(wrong, '/tmp/warehouse/TEST').some((issue) => issue.code === 'W43_PACKAGE_CLASS')).toBe(true);
  });

  it('W40/W41/W42 分类分级与中文名后缀', () => {
    const mismatch = { ...table, level: { ...table.level, tier: '重要数据' as const } };
    expect(validateTable(mismatch, [mismatch], meta).some((issue) => issue.code === 'W40_DATA_CLASSIFICATION')).toBe(true);

    const coreOffline = {
      ...table,
      level: { tier: '核心数据' as const, impactObject: '国家安全' as const, impactDegree: '特别严重危害' as const, basis: '涉及国家安全' },
    };
    expect(validateTable(coreOffline, [coreOffline], meta).some((issue) => issue.code === 'W40_DATA_CLASSIFICATION')).toBe(true);

    const badMask = {
      ...table,
      fields: table.fields.map((field) =>
        field.name === 'pay_amount' ? { ...field, level: { tier: '重要数据' as const }, masking: '掩码脱敏' as const } : field,
      ),
    };
    expect(validateTable(badMask, [badMask], meta).some((issue) => issue.code === 'W41_MASKING_MATCH')).toBe(true);
    expect(validateTable({ ...table, cnName: '订单表' }, [table], meta).some((issue) => issue.code === 'W42_TABLE_CNNAME')).toBe(true);
    expect(validateTable({ ...table, cnName: '交易订单明细拉链表', updateMode: 'scd2' }, [table], meta).some((issue) => issue.code === 'W42_TABLE_CNNAME')).toBe(false);
  });

  it('W50 设计新增指标必须显式标注', () => {
    expect(validateMetric({ ...metric, isNew: true }, [table], ['支付金额'], meta).some((issue) => issue.code === 'W50_METRIC_NEW_FLAG')).toBe(true);

    const added = { ...metric, name: '退款金额', isNew: true };
    expect(validateMetric(added, [table], ['支付金额'], meta).some((issue) => issue.code === 'W14_METRIC_NAME_MISMATCH')).toBe(false);
    expect(validateMetric({ ...added, isNew: false }, [table], ['支付金额'], meta).some((issue) => issue.code === 'W50_METRIC_NEW_FLAG')).toBe(true);
  });

  it('W48 金额字段必须 decimal', () => {
    const bad = { ...table, fields: table.fields.map((field) => (field.name === 'pay_amount' ? { ...field, logicalType: 'double' } : field)) };
    expect(validateTable(bad, [bad], meta).some((issue) => issue.code === 'W48_AMOUNT_DECIMAL')).toBe(true);
  });
});

describe('dw-dev 渲染与 DDL', () => {
  it('渲染出 8 章、9 列指标表、5 列规则表', () => {
    const markdown = renderDesignDoc('交易', req, [table], [metric], [rule]);
    expect(designDocIssues(markdown)).toEqual([]);
    expect(markdown).toContain('## 5. 数据指标');
    expect(markdown).toContain('| 指标编码 | 指标名称 | 主题域 | 指标含义 | 计算表达式 | 过滤条件 | 下钻维度 | 字段来源 | 数据源 |');
    expect(markdown).toContain('| 规则名 | 规则类型 | 校验对象（库.表.字段） | 阈值 | 处置方式 |');
    expect(markdown).toContain('   - 加工步骤：');
    expect(markdown).toContain('   - 业务口径：统计期内支付成功订单的商品明细，金额为实付金额');

    const withNew = renderDesignDoc('交易', req, [table], [{ ...metric, isNew: true }], [rule]);
    expect(withNew).toContain('设计新增指标（需求文档未列出，需需求方确认）：TRD_0001 支付金额');
  });

  it('第 2/3/7 章渲染分层规范、职责边界、表清单与程序命名', () => {
    const markdown = renderDesignDoc('交易', req, [table], [metric], [rule]);
    expect(markdown).toContain('### 2.1 分层规范');
    expect(markdown).toContain('| 分层 | 定位 | 存什么 | 不存什么 | 允许上游 |');
    expect(markdown).toContain('### 2.2 职责与边界');
    expect(markdown).toContain('- 下游使用边界：');
    expect(markdown).toContain('<!-- dw:table-list:start -->');
    expect(markdown).toContain('| 表英文名 | 中文名 | 类型 | 分层 | 主题域 | 粒度 | 主键 | 分区 | 更新方式 | 分类路径 | 数据级别 | 生命周期 | 负责人 |');
    expect(markdown).toContain('| 字段名 | 中文名 | 数据类型 | 是否必填 | 默认值 | 来源 | 计算逻辑 | 个人信息 | 数据级别 | 脱敏要求 |');
    expect(markdown).toContain('### 7.1 程序与任务命名');
    expect(markdown).toContain('| 程序文件 | 调度任务名 | 目录 | 依赖任务 |');
    expect(markdown).toContain('| dwd_trade_orderdetail_etl_d.sql | dwd_trade_orderdetail_etl_d | sql/dwd | 无 |');
    expect(markdown).toContain('可被平台口径覆盖');
  });

  it('Spark DDL 生成分区与存储，Presto 显式报 W12', () => {
    const spark = renderDdlBundle([table]);
    expect(spark.issues).toEqual([]);
    expect(spark.files[0].content).toContain('PARTITIONED BY (`dt` STRING');
    expect(spark.files[0].content).toContain('STORED AS ORC');
    expect(spark.files[0].content).toContain('cla:零售-一般数据');
    expect(spark.files[0].content).toContain("'dw.level'='一般数据'");

    const bucketed = renderDdlBundle([{ ...table, partition: { ...table.partition, buckets: 4 } }]);
    expect(bucketed.files[0].content).toContain('CLUSTERED BY (`order_id`, `sku_id`) INTO 4 BUCKETS');

    const presto = renderDdlBundle([{ ...table, engine: 'presto' }]);
    expect(presto.issues.some((message) => message.includes('不支持 DDL 生成'))).toBe(true);
    expect(presto.files).toEqual([]);
  });

  it('W24 读取 DDL 内容校验代码头', () => {
    const bundle = renderDdlBundle([table]);
    const content = bundle.files[0].content;
    expect(ddlHeaderIssues(content, { datasources: ['交易库'], engines: ['spark'] })).toEqual([]);
    expect(ddlHeaderIssues(content.replace('@引擎: spark', '@引擎: presto'), { engines: ['spark'] })).not.toEqual([]);
    expect(ddlHeaderIssues(content.replace('@数据源: 交易库', '@数据源: 订单库'), { datasources: ['交易库'] })).not.toEqual([]);
    expect(ddlHeaderIssues('CREATE TABLE x (a int);')).not.toEqual([]);
  });
});

describe('dw-dev 代码校验', () => {
  it('合规作业无静态错误，代码头可解析', () => {
    const job = validJob();
    const header = parseCodeHeader(job.code);
    expect(header.ok).toBe(true);
    expect(header.entries['引擎']).toBe('spark');
    const issues = validateJob(job, { tables: [table], meta, trace: buildTrace([metric]) });
    expect(issues).toEqual([]);
  });

  it('select * / 缺分区 / 硬编码日期 / 字段顺序都被拦下', () => {
    const bad = validJob({
      code: validJob().code
        .replace("select order_id, sku_id, pay_amount, '${day}' as dt", 'select *')
        .replace("partition (dt='${day}')", '')
        .replace("where dt='${day}'", "where dt='20260101'"),
    });
    const issues = validateJob(bad, { tables: [table], meta, trace: buildTrace([metric]) });
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain('W31_SQL_STATIC');
    expect(codes).toContain('W32_PARAM');
  });

  it('产出指标的作业必须有指标注释', () => {
    const job = validJob({ metricCodes: ['TRD_0001'] });
    const issues = validateJob(job, { tables: [table], meta, trace: buildTrace([metric]) });
    expect(issues.some((issue) => issue.code === 'W35_METRIC_ANNOTATION')).toBe(true);
  });

  it('引用未声明的表直接失败', () => {
    const job = validJob({
      sourceTables: ['ods_trade_prod.ods_trade_unknown_d'],
      code: validJob().code.replace('ods_trade_prod.ods_trade_order_d', 'ods_trade_prod.ods_trade_unknown_d'),
    });
    const issues = validateJob(job, { tables: [table], meta, trace: [] });
    expect(issues.some((issue) => issue.code === 'W33_UNKNOWN_OBJECT')).toBe(true);
  });

  it('W29 作业名必须等于目标表推导的五段名', () => {
    const renamed = validJob({ name: 'dwd_trade_order_etl_d', filePath: 'sql/dwd/dwd_trade_order_etl_d.sql' });
    const issues = validateJob(renamed, { tables: [table], meta, trace: [] });
    expect(issues.some((issue) => issue.code === 'W29_JOB_NAME_PATH')).toBe(true);
  });

  it('W29 依赖只写作业名并校验存在性', () => {
    const withProject = validJob({ dependencies: ['dw.dwd_trade_orderdetail_etl_d'] });
    expect(validateJob(withProject, { tables: [table], meta, trace: [] }).some((issue) => issue.code === 'W29_JOB_NAME_PATH')).toBe(true);

    const missing = validJob({ dependencies: ['dwd_trade_missing_etl_d'] });
    const issues = validateJob(missing, { tables: [table], meta, trace: [], jobNames: ['dwd_trade_orderdetail_etl_d'] });
    expect(issues.some((issue) => issue.code === 'W29_JOB_NAME_PATH' && issue.message.includes('不在作业清单中'))).toBe(true);

    const ok = validJob({
      dependencies: ['dwd_trade_order_etl_d'],
      code: validJob().code.replace(' * @依赖: 无', ' * @依赖: dwd_trade_order_etl_d'),
    });
    expect(
      validateJob(ok, { tables: [table], meta, trace: [], jobNames: ['dwd_trade_orderdetail_etl_d', 'dwd_trade_order_etl_d'] }).filter(
        (issue) => issue.code === 'W29_JOB_NAME_PATH' || issue.code === 'W34_HEADER_CONSISTENCY',
      ),
    ).toEqual([]);
  });

  it('W30 代码头 7 字段与资源/任务参数归属', () => {
    const missing = validJob({ code: validJob().code.replace(' * @数据源: 交易库\n', '') });
    expect(validateJob(missing, { tables: [table], meta, trace: [] }).some((issue) => issue.code === 'W30_CODE_HEADER')).toBe(true);

    const noWarehouseField = validJob({ code: validJob().code.replace(' * @任务参数: --queue default', ' * @任务参数: --queue default\n * @数仓: dw') });
    expect(validateJob(noWarehouseField, { tables: [table], meta, trace: [] }).some((issue) => issue.code === 'W30_CODE_HEADER')).toBe(false);

    const resourceHasMaster = validJob({ code: validJob().code.replace('@资源参数: --driver-memory 2g', '@资源参数: --master yarn') });
    expect(validateJob(resourceHasMaster, { tables: [table], meta, trace: [] }).some((issue) => issue.code === 'W30_CODE_HEADER')).toBe(true);

    const taskHasMemory = validJob({ code: validJob().code.replace('@任务参数: --master yarn', '@任务参数: --executor-memory 4g') });
    expect(validateJob(taskHasMemory, { tables: [table], meta, trace: [] }).some((issue) => issue.code === 'W30_CODE_HEADER')).toBe(true);

    const queueIsResource = validJob({ code: validJob().code.replace('@资源参数: --driver-memory 2g', '@资源参数: --queue root.default --driver-memory 2g') });
    expect(validateJob(queueIsResource, { tables: [table], meta, trace: [] }).some((issue) => issue.code === 'W30_CODE_HEADER')).toBe(false);

    const noResource = validJob({ code: validJob().code.replace('@资源参数: --driver-memory 2g', '@资源参数: 默认') });
    expect(validateJob(noResource, { tables: [table], meta, trace: [] }).some((issue) => issue.code === 'W30_CODE_HEADER')).toBe(true);

    const noneTask = validJob({ code: validJob().code.replace('@任务参数: --master yarn', '@任务参数: 无') });
    expect(validateJob(noneTask, { tables: [table], meta, trace: [] }).some((issue) => issue.code === 'W30_CODE_HEADER')).toBe(false);
  });

  it('W43 Java 包名按 {项目编码}.{目录路径} 校验', () => {
    const javaJob = validJob({
      kind: 'java',
      engine: 'java',
      filePath: 'code/dwd/dwd_trade_orderdetail_etl_d.java',
      code: [
        '/*',
        ' * @备注: 订单明细日表加工',
        ' * @引擎: java',
        ' * @依赖: 无',
        ' * @程序参数: --day ${day}',
        ' * @资源参数: --num-executors 2',
        ' * @任务参数: 无',
        ' * @数据源: 交易库',
        ' */',
        'package TEST.code.dwd;',
        'public class dwd_trade_orderdetail_etl_d {',
        '  public static void main(String[] args) { }',
        '}',
      ].join('\n'),
    });
    const ctx = { tables: [table], meta, trace: [], workspaceRoot: '/tmp/warehouse/TEST' };
    expect(validateJob(javaJob, ctx).some((issue) => issue.code === 'W43_PACKAGE_CLASS')).toBe(false);

    const wrongPackage = { ...javaJob, code: javaJob.code.replace('package TEST.code.dwd;', 'package TEST.dwd;') };
    expect(validateJob(wrongPackage, ctx).some((issue) => issue.code === 'W43_PACKAGE_CLASS')).toBe(true);

    const wrongClass = { ...javaJob, code: javaJob.code.replace('public class dwd_trade_orderdetail_etl_d', 'public class DwdTradeOrderdetailEtlD') };
    expect(validateJob(wrongClass, ctx).some((issue) => issue.code === 'W43_PACKAGE_CLASS')).toBe(true);
  });

  it('W44 拦截两个 Java 作业间连续 20 行重复逻辑', () => {
    const body = Array.from({ length: 20 }, (_, index) => `    int value${index} = ${index};`).join('\n');
    const make = (name: string): JobSpec =>
      validJob({
        name,
        kind: 'java',
        engine: 'java',
        filePath: `code/dwd/${name}.java`,
        code: `/*\n * @备注: 测试\n * @引擎: java\n * @依赖: 无\n * @程序参数: 无\n * @资源参数: 无\n * @任务参数: 无\n * @数据源: 交易库\n */\npackage TEST.code.dwd;\npublic class X {\n${body}\n}\n`,
      });
    const issues = duplicateLogicIssues([make('dwd_trade_orderdetail_etl_d'), make('dwd_trade_order_etl_d')]);
    expect(issues.filter((issue) => issue.code === 'W44_DUPLICATE_LOGIC').length).toBe(2);
  });

  it('W34 资源/任务参数与作业声明一致', () => {
    const mismatch = validJob({ resourceParams: '--driver-memory 4g', taskParams: '--master yarn' });
    const issues = validateJob(mismatch, { tables: [table], meta, trace: [] });
    expect(issues.filter((issue) => issue.code === 'W34_HEADER_CONSISTENCY').length).toBe(1);

    const matched = validJob({ resourceParams: '--driver-memory 2g', taskParams: '--master yarn' });
    expect(validateJob(matched, { tables: [table], meta, trace: [] }).some((issue) => issue.code === 'W34_HEADER_CONSISTENCY')).toBe(false);
  });

  it('语法校验只发 Authorization: Bearer，不附加 x-dataforge-token', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-syntax-'));
    const previous = {
      port: process.env.DATAFORGE_COMPILE_PORT,
      token: process.env.DATAFORGE_COMPILE_TOKEN,
    };
    process.env.DATAFORGE_COMPILE_PORT = '43210';
    process.env.DATAFORGE_COMPILE_TOKEN = 'test-token';
    const headers: Record<string, string>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      headers.push(init.headers);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });

    try {
      const result = await checkSyntax(root, [validJob()], { enabled: true });
      expect(result.status).toBe('passed');
      expect(headers).toEqual([{ 'content-type': 'application/json', authorization: 'Bearer test-token' }]);
      expect('x-dataforge-token' in headers[0]).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      if (previous.port === undefined) delete process.env.DATAFORGE_COMPILE_PORT;
      else process.env.DATAFORGE_COMPILE_PORT = previous.port;
      if (previous.token === undefined) delete process.env.DATAFORGE_COMPILE_TOKEN;
      else process.env.DATAFORGE_COMPILE_TOKEN = previous.token;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
