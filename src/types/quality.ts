/**
 * 数据质量共享常量与类型（质量模块的唯一事实源）
 *
 * ── 为什么放在 types/ ────────────────────────────────────────
 * 7 类规则类型是「全链路统一术语」：智能体提示词（S1/S2/S3 三方）、桌面端 UI、
 * 服务端枚举三处必须完全一致，且**禁止自造同义词**。
 *
 * 因此这里只定义一次，提示词由本文件的常量拼装（见 opencodeInstructions.ts
 * 的 QUALITY_RULE_SPEC），UI 也直接引用本文件 —— 任何口径变更只改一处。
 * 放在 types/ 而不是 hooks/opencode/ 或 api/，是为了让三个消费面（提示词、api、视图）
 * 都能向下依赖它，不产生反向依赖。
 *
 * ⚠ 改动前必读：
 * - label / desc 的文案与提示词中的表述**逐字一致**，改文案等于改提示词契约，
 *   必须同时跑 opencodeInstructions.test.ts 与 qualityContract.test.ts。
 * - 规则类型固定为 7 类。自定义校验 SQL 也必须归属其中一类（自定义体现在
 *   SQL 模板而非类型），否则覆盖率统计会失去口径 —— 见 QualityTemplateKind。
 */

/** 规则类型的校验对象范围：单表字段级 / 单表表级 / 跨表两表比对 */
export type QualityRuleScope = 'COLUMN' | 'TABLE' | 'PAIR';

export interface QualityRuleTypeMeta {
  /** 稳定编码，落库用；不随文案调整 */
  code: string;
  /** 规则类型名，与提示词逐字一致 */
  label: string;
  /** 规则类型说明，与提示词逐字一致 */
  desc: string;
  /** 校验对象范围，供「按表配置规则」时决定字段选择器形态 */
  scope: QualityRuleScope;
}

/**
 * 7 类规则类型 —— 与提示词「数据质量规则类型（全链路统一术语）」逐条对应。
 * 顺序即提示词中的编号，不得调整（提示词按此数组生成编号）。
 */
export const QUALITY_RULE_TYPES: readonly QualityRuleTypeMeta[] = [
  { code: 'PRIMARY_KEY_UNIQUE', label: '主键唯一性', desc: '主键/唯一键重复检测', scope: 'COLUMN' },
  { code: 'NOT_NULL', label: '非空', desc: '关键字段空值与空串检测', scope: 'COLUMN' },
  { code: 'VALUE_RANGE', label: '值域', desc: '枚举字典取值与数值区间合法性', scope: 'COLUMN' },
  { code: 'ROW_COUNT_FLUCTUATION', label: '行数波动', desc: '当日行数相对历史基线的涨跌幅', scope: 'TABLE' },
  { code: 'ROW_COUNT_MOM', label: '行数环比', desc: '当期行数与上期行数的对比', scope: 'TABLE' },
  { code: 'UPSTREAM_DOWNSTREAM_RECON', label: '上下游对账', desc: '上下游同口径记录数/金额一致性', scope: 'PAIR' },
  { code: 'METRIC_CONSISTENCY', label: '口径一致性', desc: '同一指标在不同表、不同层之间的计算结果一致性', scope: 'PAIR' },
] as const;

/** 7 类规则类型的编码集合，供服务端枚举比对与测试断言 */
export const QUALITY_RULE_TYPE_CODES: readonly string[] = QUALITY_RULE_TYPES.map(t => t.code);

/**
 * 按编码取规则类型元信息；未知编码返回 undefined（调用方需自行兜底显示）。
 */
export function getQualityRuleType(code: string): QualityRuleTypeMeta | undefined {
  return QUALITY_RULE_TYPES.find(t => t.code === code);
}

/**
 * 按规则类型名反查编码。用于把智能体在设计文档里写的规则类型名
 * （如「主键唯一性」）映射为落库编码，是「S2 稽核规则清单一键落库」的解析依据。
 */
export function getQualityRuleTypeByLabel(label: string): QualityRuleTypeMeta | undefined {
  const normalized = label.trim();
  return QUALITY_RULE_TYPES.find(t => t.label === normalized);
}

/**
 * 规则模板类别：内置（7 类之一，平台预置）与自定义（仍归属 7 类之一，差异在 SQL 模板）。
 */
export type QualityTemplateKind = 'builtin' | 'custom';

/** 处置方式 —— 与提示词中 S2 的「处置方式」同义，取值即提示词里的「阻断下游 / 告警」 */
export interface QualityDisposeModeMeta {
  code: QualityDisposeMode;
  label: string;
}

export type QualityDisposeMode = 'BLOCK' | 'ALERT';

export const QUALITY_DISPOSE_MODES: readonly QualityDisposeModeMeta[] = [
  { code: 'BLOCK', label: '阻断下游' },
  { code: 'ALERT', label: '告警' },
] as const;

/** 比较方式，决定阈值与实际值如何比较 */
export type QualityCompareMode = 'EQ' | 'NE' | 'GT' | 'GTE' | 'LT' | 'LTE';

/** 校验结果状态：通过 / 橙色异常（超警告阈值）/ 红色异常（超错误阈值）/ 校验失败（SQL 未跑通） */
export type QualityCheckStatus = 'PASS' | 'WARN' | 'ERROR' | 'FAILED';

/** 质检任务运行实例状态 */
export type QualityRunStatus = 'RUNNING' | 'SUCCESS' | 'FAILED';

/** 质检任务触发方式 */
export type QualityTriggerType = 'SCHEDULE' | 'MANUAL';

/** 规则模板 */
export interface QualityRuleTemplateVO {
  id: number;
  /** 模板编码，内置模板与 7 类规则类型编码同名 */
  templateCode: string;
  templateName: string;
  /** 归属的规则类型编码，取自 QUALITY_RULE_TYPE_CODES */
  ruleType: string;
  templateKind: QualityTemplateKind;
  /** SQL 模板，含 ${占位符}；内置模板由平台维护 */
  sqlTemplate: string;
  /** 适用字段类型，逗号分隔；空表示不限 */
  fieldTypes: string;
  /** 占位符参数定义（JSON 字符串），供配置界面动态渲染表单 */
  paramSchema: string;
  remark: string;
  /** 是否启用（自定义模板可停用，内置模板恒为启用） */
  enabled: boolean;
}

/** 监控规则 */
export interface QualityRuleVO {
  id: number;
  ruleName: string;
  ruleType: string;
  templateId: number | null;
  templateCode: string;
  datasourceId: number | null;
  datasourceName: string;
  databaseName: string;
  tableName: string;
  /** 字段级规则的字段名；表级/跨表规则为空 */
  columnName: string;
  /** 分区表达式，如 dt=${yyyyMMdd} */
  partitionExpr: string;
  /** 跨表比对时的对照表 */
  refDatasourceId: number | null;
  refDatabaseName: string;
  refTableName: string;
  refColumnName: string;
  compareMode: QualityCompareMode;
  expectedValue: string;
  /** 橙色（警告）阈值，空表示不设 */
  warnThreshold: string;
  /** 红色（错误）阈值 */
  errorThreshold: string;
  disposeMode: QualityDisposeMode;
  ownerName: string;
  enabled: boolean;
  createTime: string;
  updateTime: string;
}

/**
 * 规则登记回执。
 *
 * 「登记」是幂等的：平台按「规则名 + 库 + 表」判定同一条规则 —— 该口径与结果回传时
 * 服务端的反查口径**故意一致**，否则会出现「登记到 A、回传匹配到 B」这种最难查的错配。
 * 已登记则原样返回既有记录（不覆盖，平台里的阈值可能已被人手工调过）。
 */
export interface QualityRuleRegisterVO {
  /** 平台规则 ID —— 回传结果时带上它，改名不会断开链路 */
  ruleId: number;
  /** 规则名（逐字回显，便于核对匹配到的就是自己要的那条） */
  ruleName: string;
  /** 规则类型编码（7 类之一） */
  ruleType: string;
  /** 自动绑定到的模板编码；无内置模板时退化为规则类型编码 */
  templateCode: string;
  /** true=本次新建；false=已存在，直接复用 */
  created: boolean;
}

/** 质检任务（一组规则的执行计划） */
export interface QualityTaskVO {
  id: number;
  taskName: string;
  ownerName: string;
  description: string;
  /** 监控对象表 */
  datasourceId: number | null;
  datasourceName: string;
  databaseName: string;
  tableName: string;
  triggerType: QualityTriggerType;
  /** 调度触发时关联的调度项目编码 / 工作流编码 / 节点名 */
  projectCode: string;
  workflowCode: number | null;
  workflowName: string;
  nodeName: string;
  /** 任务级默认处置策略，规则未单独设置时生效 */
  disposePolicy: QualityDisposeMode;
  enabled: boolean;
  createTime: string;
  updateTime: string;
}

/** 质检任务运行实例 */
export interface QualityRunInstanceVO {
  id: number;
  taskId: number;
  taskName: string;
  /** 本次校验的业务批次，如 20260917 */
  batchNo: string;
  triggerType: QualityTriggerType;
  /** 调度触发时对应的调度实例号，用于跳转调度实例详情 */
  scheduleInstanceId: number | null;
  startTime: string;
  endTime: string;
  status: QualityRunStatus;
  /** 检查记录总数 */
  checkRecordCount: number;
  /** 未通过记录总数 */
  failRecordCount: number;
  passCount: number;
  warnCount: number;
  errorCount: number;
  /** SQL 未跑通的规则数，与「校验不通过」区分 */
  failedCount: number;
}

/** 规则级校验结果 —— 对应提示词「校验输出须可定位」的五个要素 */
export interface QualityRuleResultVO {
  id: number;
  runId: number;
  ruleId: number | null;
  /** 规则名 */
  ruleName: string;
  ruleType: string;
  /** 校验对象 */
  checkObject: string;
  /** 阈值 */
  threshold: string;
  /** 实际值 */
  actualValue: string;
  /** 是否通过 */
  status: QualityCheckStatus;
  /** 异常等级，仅 status 为 WARN/ERROR 时有值 */
  severity: string;
  execSql: string;
  errorMsg: string;
  costMs: number;
}

/** 质量大盘 */
export interface QualityOverviewVO {
  /** 已配置规则的表数 */
  coveredTableCount: number;
  /** 应配置规则的核心表数（有产出任务的关键表） */
  targetTableCount: number;
  /** 规则覆盖率（0~1） */
  ruleCoverage: number;
  /** 规则总数 / 启用数 */
  ruleCount: number;
  enabledRuleCount: number;
  /** 近 N 日通过率趋势 */
  passRateTrend: Array<{ statDate: string; passRate: number; failCount: number }>;
  /** TOP 质量问题表 */
  topProblemTables: Array<{
    databaseName: string;
    tableName: string;
    failCount: number;
    ownerName: string;
  }>;
  /** 强规则阻断次数 */
  blockCount: number;
}

/**
 * 告警记录（站内告警箱）。
 *
 * 「站内记录」渠道（INBOX）落 `dq_alert_log` 即送达，所以这张表本身就是可用的告警箱。
 *
 * 别把两个状态搞混：
 * - `status` 是**投递状态**（SENT 已送达 / PENDING 待发 / FAILED 投递失败），衡量"通知发出去了没有"；
 * - `checkStatus` 是**触发状态**（WARN / ERROR / FAILED），衡量"因为什么触发"。
 *   后者不在告警表里，服务端按 runId + ruleId 回校验结果表取出来。
 */
export interface QualityAlertLogVO {
  id: number;
  runId: number;
  taskId: number;
  /** 任务名（服务端由 taskId 反查） */
  taskName: string;
  ruleId: number | null;
  ruleName: string;
  /** 渠道编码：INBOX / EMAIL / WEBHOOK */
  channel: string;
  receiver: string;
  /** 投递状态：SENT 已送达 / PENDING 待发 / FAILED 投递失败 */
  status: string;
  /** 投递失败或未投递的原因；已送达时为空 */
  failReason: string;
  /** 实际送达时间；待发记录为空 */
  sendTime: string;
  /** 触发本次告警的校验结果状态：WARN / ERROR / FAILED */
  checkStatus: string;
}

/** 告警订阅 */
export interface QualityAlertSubscriptionVO {
  id: number;
  taskId: number;
  taskName: string;
  /** 触发告警的结果状态集合，逗号分隔，如 ERROR,FAILED */
  notifyOn: string;
  channels: string;
  receivers: string;
  enabled: boolean;
}
