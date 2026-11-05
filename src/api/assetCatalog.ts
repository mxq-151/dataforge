/**
 * 数据资产目录接口封装（dataforge-server /asset/*）
 *
 * ── 定位 ────────────────────────────────────────────────────
 * 资产目录是「人」侧的元数据调研入口，与智能体侧的元数据代理接口 /metadata/agent 对位。
 * 它不产生新的智能体上下文类别，而是「库表描述 + 指标描述 + 血缘 + 任务依赖」四类的聚合消费面。
 *
 * ── 边界（避免重复建设）─────────────────────────────────────
 * - 血缘不在此模块重新实现：详情页的血缘页签复用桌面端 Marquez 客户端（api/marquez.ts）。
 * - 产出任务不落服务端副本：/asset/table/{id}/producers 由服务端代理查询 DolphinScheduler。
 * - 分类不做人工维护为主：分层与业务域由表名解析（见 types 注释），categoryCode 仅作人工覆盖。
 *
 * ── 权限 ────────────────────────────────────────────────────
 * 目录树与检索结果由服务端按 sys_table_permission（含行/列）fail-close 过滤，
 * 前端不得依赖「取回后再前端过滤」——否则越权表名会先到达客户端。
 *
 * ── 错误处理 ────────────────────────────────────────────────
 * 统一 suppressError: true，由面板呈现空态/错误态。
 */

import { request } from './index';
import type { ApiResponse } from './types';
import { DEPLOY_ENV_OPTIONS, type DeployEnv } from '../utils/deployEnv';

/** 目录视角：引擎视角（数据源→库→表）与规范视角（分层→业务域→表） */
export type CatalogViewMode = 'engine' | 'convention';

/** 目录树节点。同一份结构服务两种视角，用 nodeKind 区分语义 */
export interface CatalogTreeNode {
  /** 节点稳定 key，形如 engine:{datasourceId} / db:{datasourceId}:{db} / table:{tableMetadataId} */
  key: string;
  /** 节点显示名 */
  label: string;
  nodeKind: 'datasource' | 'database' | 'table' | 'layer' | 'domain';
  /** 仅 table 节点有值，用于跳详情 */
  tableMetadataId?: number;
  datasourceId?: number;
  storageEngine?: string;
  databaseName?: string;
  tableName?: string;
  /** 规范视角下由表名解析出的属性 */
  layerCode?: string;
  domainCode?: string;
  /** 该节点下资产数（库/分层/业务域节点用） */
  assetCount?: number;
  /** 解析失败等需要治理的情况 */
  unclassified?: boolean;
  children?: CatalogTreeNode[];
}

/** 检索命中的资产类型 */
export type AssetSearchType = 'table' | 'column' | 'indicator';

export interface AssetSearchHit {
  assetType: AssetSearchType;
  /** table/indicator 用 id；column 用 tableMetadataId */
  id: number;
  tableMetadataId?: number;
  title: string;
  /** 副标题：库.表 / 表.字段 / 指标编码 */
  subtitle: string;
  /** 命中片段，用于列表高亮 */
  matchedText?: string;
  ownerName?: string;
  layerCode?: string;
  domainCode?: string;
}

export interface AssetSearchResult {
  tables: AssetSearchHit[];
  columns: AssetSearchHit[];
  indicators: AssetSearchHit[];
  total: number;
}

/** 资产详情聚合体 */
export interface AssetTableDetailVO {
  id: number;
  datasourceId: number | null;
  datasourceName: string;
  storageEngine: string;
  databaseName: string;
  tableName: string;
  tableType: string;
  tableComment: string;
  /** markdown 使用说明（来自 asset_doc，区别于 table_comment） */
  description: string;
  /** 负责人，字段语义对齐 indicators 的 business_owner / tech_owner */
  businessOwner: string;
  techOwner: string;
  /** 主题域 */
  topic: string;
  /** 可见性，对齐 indicators 的 public/internal/restricted */
  visibility: string;
  /** 人工覆盖的分类编码；空表示采用表名解析结果 */
  categoryCode: string;
  layerCode: string;
  domainCode: string;
  /** 命名规范解析是否成功；false 时计入治理项 */
  conventionParsed: boolean;
  /** 刷新周期后缀（d/h/w/m/y/r/f） */
  refreshCycle: string;
  assetLevel: string;
  rowCount: number | null;
  sizeBytes: number | null;
  hotDays: number;
  coldDays: number;
  keepDays: number;
  storageFormat: string;
  /** 压缩方式，源表未提供时为 null（与 /api/metadata/tables 的 table_metadata 同列） */
  compression?: string | null;
  location: string;
  partitionColumns: string[];
  lastModifyTime: string;
  syncTime: string;
  /** 治理项计数，非加权评分 */
  healthIssueCount: number;
  columns: AssetColumnVO[];
  tags: AssetTagVO[];
}

/**
 * 生命周期三档（单位：天）。语义约束：热数据天数 ≤ 冷数据天数 ≤ 保留天数。
 * 与 table_metadata 既有的 hot_days / cold_days / keep_days 对齐，不另起字段名。
 */
export interface AssetLifecycleVO {
  hotDays: number;
  coldDays: number;
  keepDays: number;
}

export interface AssetColumnVO {
  id: number;
  columnName: string;
  columnType: string;
  /** 字段注释（技术） */
  columnComment: string;
  /** 业务描述（治理补充） */
  businessDesc: string;
  isPartition: boolean;
  isPrimaryKey: boolean;
  nullable: boolean;
  ordinalPosition: number;
  securityLevel: string;
}

export interface AssetTagVO {
  id: number;
  tagCode: string;
  tagName: string;
  color: string;
}

/**
 * 分类字典项（分层 / 业务域）。
 * 与「分类不人工维护」的定位一致：这里只是可选覆盖项，主口径仍由表名规范解析。
 */
export interface AssetCategoryVO {
  code: string;
  name: string;
  parentCode: string;
  categoryKind: 'layer' | 'domain';
}

/**
 * 元数据标注缺口摘要（复用既有 /api/metadata/annotation-gaps）。
 * 作为治理项「未标注字段」的可核查来源，与 AssetHealthIssueVO 的治理项计数互补。
 */
export interface AnnotationGapSummary {
  /** 已扫描表数 */
  tableScanned: number;
  /** 表注释缺失（或存在无注释字段）的表数 */
  unannotatedTableCount: number;
  /** 无注释字段总数 */
  unannotatedColumnCount: number;
  /** 是否因 limit 截断 */
  truncated: boolean;
  tables: Array<{
    id: number;
    datasourceId: number;
    datasourceName: string;
    storageEngine: string;
    databaseName: string;
    tableName: string;
    tableComment: string;
    tableCommentMissing: boolean;
    columnCount: number;
    unannotatedColumnCount: number;
    unannotatedColumns: Array<{
      columnName: string;
      columnType: string;
      ordinalPosition: number;
      isPartition: number;
    }>;
  }>;
}

/** 产出任务（代理查询 DolphinScheduler） */
export interface AssetProducerVO {
  projectCode: string;
  workflowCode: number;
  workflowName: string;
  nodeName: string;
  ownerName: string;
  scheduleCycle: string;
  lastRunState: string;
  lastRunTime: string;
}

/** 该表关联的指标（基于 indicators_fields 反查） */
export interface AssetIndicatorVO {
  id: number;
  code: string;
  name: string;
  topic: string;
  businessOwner: string;
  fieldName: string;
}

/** 已启用的质检规则（「数据质量」页签列表展示用的精简字段） */
export interface AssetQualityRuleVO {
  id: number;
  ruleName: string;
  /** 规则类型编码（7 类之一），用 getQualityRuleType 映射中文名 */
  ruleType: string;
  /** 字段级规则的字段名；表级/跨表规则为空 */
  columnName: string;
  /** 处置方式 BLOCK / ALERT */
  disposeMode: string;
  /** 规则负责人 */
  ownerName: string;
}

/** 未通过质检记录的样例（「数据质量」页签列表展示用） */
export interface AssetQualityFailedSampleVO {
  id: number;
  /** 质检时间（结果留痕的创建时间） */
  checkTime: string;
  /** 质检规则名 */
  ruleName: string;
  /** 规则类型编码（7 类之一），用 getQualityRuleType 映射中文名 */
  ruleType: string;
  /** 校验状态 ERROR=红色异常 FAILED=校验失败 */
  status: string;
  /** 完整的数据样例：未通过明细，原样展示不截断 */
  sample: string;
}

/** 该表的质量规则摘要（跨模块读 quality） */
export interface AssetQualitySummaryVO {
  ruleCount: number;
  enabledRuleCount: number;
  /** 最近一次运行结果摘要 */
  lastRunStatus: string;
  lastRunTime: string;
  errorCount: number;
  failCount: number;
  /** 未通过规则条数，用于在资产详情上提示质量问题 */
  problemRuleCount: number;
  /** 已启用的质检规则清单；旧版本后端可能不下发，故可选 */
  enabledRules?: AssetQualityRuleVO[];
  /** 最近一次校验中未通过的记录样例；旧版本后端可能不下发，故可选 */
  failedSamples?: AssetQualityFailedSampleVO[];
}

/** 治理项：每项都可追到具体对象，不做加权分数 */
export interface AssetHealthIssueVO {
  issueCode: string;
  issueName: string;
  /** 问题对象数量 */
  count: number;
  /** 影响面描述，如「含 12 张核心表」 */
  impact: string;
  samples: Array<{ tableMetadataId: number; databaseName: string; tableName: string }>;
}

/** 资产盘点 */
export interface AssetInventoryVO {
  totalTables: number;
  totalSizeBytes: number;
  totalColumns: number;
  /** 质检规划覆盖率（0~1，当前范围）；无「应配置质检规则」的表时为 null */
  qualityCoverageRate: number | null;
  byLayer: Array<{
    layerCode: string;
    tableCount: number;
    sizeBytes: number;
    /** 该分层的质检规划覆盖率（0~1）；无应配置表时为 null */
    qualityCoverageRate: number | null;
  }>;
  byDomain: Array<{
    domainCode: string;
    tableCount: number;
    sizeBytes: number;
    /** 该业务域（数仓）的质检规划覆盖率（0~1）；无应配置表时为 null */
    qualityCoverageRate: number | null;
  }>;
  byDatasource: Array<{ datasourceId: number; datasourceName: string; tableCount: number }>;
}

// ── 资产概况（盘点看板）──────────────────────────────────────
//
// 环境口径与库名规范同源：库名 {分层}_{业务域}_{环境}，环境后缀仅限 _prod/_gray/_test，
// 故 env 由服务端按库名解析，前端不自行猜测，避免「生产库被当测试库」这类误判。
//
// 环境是资产管理模块的**切换维度**：资产概况与资产目录两处都按选中环境取全部内容，
// 因此下列接口统一接受可选的 env 参数（不传 = 全环境，兼容既有调用）。

/** 环境码：生产 / 灰度 / 测试（与库名后缀 _prod/_gray/_test 一一对应） */
export type AssetEnvCode = DeployEnv;

/**
 * 环境切换器的取值与中文名：直接复用提交调度的环境定义，
 * 保证「库里叫什么环境」与「界面上叫什么环境」只有一处来源。
 */
export const ASSET_ENV_OPTIONS: readonly { value: AssetEnvCode; label: string }[] = DEPLOY_ENV_OPTIONS;

/**
 * 资产管理默认环境：生产。
 *
 * 与提交调度的默认值（测试，见 `DEFAULT_DEPLOY_ENV`）刻意不同 ——
 * 那是「写」的默认（选风险最低的一档），这里是「看」的默认（先看真实盘子）。
 */
export const DEFAULT_ASSET_ENV: AssetEnvCode = 'prod';

/** 按环境与项目聚合的表数量与占用空间 */
export interface AssetEnvProjectStatVO {
  env: AssetEnvCode;
  projectCode: string;
  projectName: string;
  tableCount: number;
  sizeBytes: number;
}

export interface AssetTopAssetVO {
  tableMetadataId: number;
  databaseName: string;
  tableName: string;
  env: AssetEnvCode;
  projectCode: string;
  projectName: string;
  sizeBytes: number;
  ownerName: string;
}

/** TOP 任务排行排序维度：消耗计算资源 / 运行时长 */
export type AssetTaskSortBy = 'resource' | 'duration';

export interface AssetTopComputeTaskVO {
  workflowName: string;
  nodeName: string;
  /** 任务类型（SPARK / HIVE / FLINK…） */
  taskType: string;
  projectName: string;
  /** 消耗 CPU 核·小时 */
  cpuHours: number;
  /** 内存 GB·小时 */
  memoryGbHours: number;
  /** 运行时长（秒） */
  runDurationSeconds: number;
  execCount: number;
}

/** 任务延迟率（主要指 YARN 任务）：延迟 = 实际开始晚于计划开始 */
export interface AssetTaskDelayVO {
  totalTasks: number;
  delayedTasks: number;
  /** 延迟率 0~1 */
  delayRate: number;
  /** 统计窗口（天） */
  windowDays: number;
  byQueue: Array<{ queueName: string; totalTasks: number; delayedTasks: number; delayRate: number }>;
}

/** 数据大小增长率突增表（默认阈值：增长率 > 10% 且当前大小 > 10GB） */
export interface AssetSizeGrowthVO {
  tableMetadataId: number;
  databaseName: string;
  tableName: string;
  env: AssetEnvCode;
  projectName: string;
  previousSizeBytes: number;
  currentSizeBytes: number;
  growthBytes: number;
  /** 增长率 0~1 */
  growthRate: number;
}

const BASE = '/api/asset';

function toQuery(params: Record<string, unknown>): Record<string, string> {
  const qs: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    qs[k] = String(v);
  }
  return qs;
}

export const assetCatalogApi = {
  /** 目录树。view=convention 时返回「分层→业务域→表」的规范视角；env 按库名后缀过滤 */
  async getCatalogTree(params: { view?: CatalogViewMode; datasourceId?: number; databaseName?: string; keyword?: string; env?: AssetEnvCode } = {}) {
    return request<ApiResponse<CatalogTreeNode[]>>(`${BASE}/catalog/tree`, {
      params: toQuery({ view: params.view ?? 'engine', datasourceId: params.datasourceId, databaseName: params.databaseName, keyword: params.keyword, env: params.env }),
      suppressError: true,
    });
  },

  /** 统一检索：表 / 字段 / 指标三类，服务端已按权限过滤；env 只对表 / 字段生效（指标无环境维度） */
  async search(params: { keyword: string; types?: AssetSearchType[]; current?: number; size?: number; layerCode?: string; domainCode?: string; env?: AssetEnvCode }) {
    return request<ApiResponse<AssetSearchResult>>(`${BASE}/search`, {
      params: toQuery({
        keyword: params.keyword,
        types: params.types?.length ? params.types.join(',') : undefined,
        current: params.current,
        size: params.size,
        layerCode: params.layerCode,
        domainCode: params.domainCode,
        env: params.env,
      }),
      suppressError: true,
    });
  },

  async suggest(keyword: string, env?: AssetEnvCode) {
    return request<ApiResponse<string[]>>(`${BASE}/suggest`, { params: toQuery({ keyword, env }), suppressError: true });
  },

  /** 资产详情聚合：基础信息 + 字段 + 分区 + 分类标签 */
  async getTableDetail(id: number) {
    return request<ApiResponse<AssetTableDetailVO>>(`${BASE}/table/${id}`, { suppressError: true });
  },

  /** 产出任务：服务端代理查询 DolphinScheduler，不在服务端落副本 */
  async getTableProducers(id: number) {
    return request<ApiResponse<AssetProducerVO[]>>(`${BASE}/table/${id}/producers`, { suppressError: true });
  },

  async getTableIndicators(id: number) {
    return request<ApiResponse<AssetIndicatorVO[]>>(`${BASE}/table/${id}/indicators`, { suppressError: true });
  },

  async getTableQuality(id: number) {
    return request<ApiResponse<AssetQualitySummaryVO>>(`${BASE}/table/${id}/quality`, { suppressError: true });
  },

  /** 预览：服务端必须过列权限与脱敏 */
  async previewTable(id: number, params: { limit?: number; partition?: string } = {}) {
    return request<ApiResponse<{ columns: string[]; rows: Array<Array<string | null>> }>>(`${BASE}/table/${id}/preview`, {
      params: toQuery({ limit: params.limit ?? 20, partition: params.partition }),
      suppressError: true,
    });
  },

  // ── 资产治理（写操作）────────────────────────────────────

  async updateOwner(id: number, payload: { businessOwner?: string; techOwner?: string }) {
    return request<ApiResponse<null>>(`${BASE}/table/${id}/owner`, {
      method: 'PUT',
      body: JSON.stringify(payload),
      suppressError: true,
    });
  },

  async updateCategory(id: number, payload: { categoryCode?: string; topic?: string; visibility?: string; assetLevel?: string }) {
    return request<ApiResponse<null>>(`${BASE}/table/${id}/category`, {
      method: 'PUT',
      body: JSON.stringify(payload),
      suppressError: true,
    });
  },

  async updateTags(id: number, tagCodes: string[]) {
    return request<ApiResponse<null>>(`${BASE}/table/${id}/tags`, {
      method: 'PUT',
      body: JSON.stringify({ tagCodes }),
      suppressError: true,
    });
  },

  /**
   * 修改生命周期（热 / 冷 / 保留天数）。
   * 服务端须在同一事务内校验 hotDays ≤ coldDays ≤ keepDays，并做库表权限校验与操作留痕；
   * 已确认的历史事实（table_metadata 既有列）直接覆盖写，不产生新副本。
   */
  async updateLifecycle(id: number, payload: AssetLifecycleVO) {
    return request<ApiResponse<null>>(`${BASE}/table/${id}/lifecycle`, {
      method: 'PUT',
      body: JSON.stringify(payload),
      suppressError: true,
    });
  },

  async getTableDoc(id: number) {
    return request<ApiResponse<{ content: string; updateTime: string; updateBy: string }>>(`${BASE}/table/${id}/doc`, { suppressError: true });
  },

  async saveTableDoc(id: number, content: string) {
    return request<ApiResponse<null>>(`${BASE}/table/${id}/doc`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
      suppressError: true,
    });
  },

  async listDocHistory(id: number) {
    return request<ApiResponse<Array<{ version: number; updateTime: string; updateBy: string }>>>(`${BASE}/table/${id}/doc/history`, { suppressError: true });
  },

  /** 刷新单表元数据（复用既有同步能力，此处仅做入口收口） */
  async refreshTableMetadata(id: number) {
    return request<ApiResponse<null>>(`${BASE}/table/${id}/refresh`, { method: 'POST', suppressError: true });
  },

  // ── 标签 ──────────────────────────────────────────────────

  async listTags() {
    return request<ApiResponse<AssetTagVO[]>>(`${BASE}/tag`, { suppressError: true });
  },

  async listCategories() {
    return request<ApiResponse<AssetCategoryVO[]>>(`${BASE}/category`, { suppressError: true });
  },

  // ── 盘点 ──────────────────────────────────────────────────

  /**
   * 盘点概况。可按「数仓名称（→ domainCode，即规范视角的业务域）」或「数仓分层（→ layerCode）」收窄：
   * 两者都不传 = 当前环境全量；同时传 = 该业务域下该分层。
   * 注意：domainCode ≠ projectCode（后者是调度项目编码，如 test_project）。
   * 选中层级下推服务端，保证「表总数 / 字段总数 / 占用空间 / 质检规划覆盖率」四项口径一致。
   */
  async getInventoryOverview(
    params: { projectCode?: string; domainCode?: string; layerCode?: string; env?: AssetEnvCode } = {}
  ) {
    return request<ApiResponse<AssetInventoryVO>>(`${BASE}/inventory/overview`, {
      params: toQuery(params as Record<string, unknown>),
      suppressError: true,
    });
  },

  /** 治理项清单；env 按库名后缀过滤，domainCode / layerCode 与盘点同口径收窄（规范视角选中项） */
  async getInventoryHealth(params: { env?: AssetEnvCode; domainCode?: string; layerCode?: string } = {}) {
    return request<ApiResponse<AssetHealthIssueVO[]>>(`${BASE}/inventory/health`, {
      params: toQuery(params as Record<string, unknown>),
      suppressError: true,
    });
  },

  // ── 资产概况（盘点看板）──────────────────────────────────

  /** 按环境（生产 / 灰度 / 测试）与项目聚合的表数量与占用空间 */
  async getInventoryByEnvProject() {
    return request<ApiResponse<AssetEnvProjectStatVO[]>>(`${BASE}/inventory/env-project`, { suppressError: true });
  },

  /** 占用空间 TOP 资产（默认 100 条）；env 按库名后缀过滤 */
  async getTopAssets(params: { limit?: number; env?: AssetEnvCode } = {}) {
    return request<ApiResponse<AssetTopAssetVO[]>>(`${BASE}/inventory/top-assets`, {
      params: toQuery({ limit: params.limit ?? 100, env: params.env }),
      suppressError: true,
    });
  },

  /** 消耗计算资源 / 运行时长 TOP 任务（默认 50 条）；env 按工作流名后缀过滤 */
  async getTopComputeTasks(params: { sortBy: AssetTaskSortBy; limit?: number; env?: AssetEnvCode }) {
    return request<ApiResponse<AssetTopComputeTaskVO[]>>(`${BASE}/inventory/top-compute`, {
      params: toQuery({ sortBy: params.sortBy, limit: params.limit ?? 50, env: params.env }),
      suppressError: true,
    });
  },

  /** 任务延迟率（主要针对 YARN 任务）；env 按工作流名后缀过滤 */
  async getTaskDelayRate(params: { days?: number; env?: AssetEnvCode } = {}) {
    return request<ApiResponse<AssetTaskDelayVO>>(`${BASE}/inventory/task-delay`, {
      params: toQuery({ days: params.days ?? 30, env: params.env }),
      suppressError: true,
    });
  },

  /** 数据大小增长率突增表：默认 增长率 > 10% 且当前大小 > 10GB；env 按库名后缀过滤 */
  async getSizeGrowthAnomalies(params: { growthPercent?: number; minSizeBytes?: number; env?: AssetEnvCode } = {}) {
    return request<ApiResponse<AssetSizeGrowthVO[]>>(`${BASE}/inventory/size-growth`, {
      params: toQuery({
        growthPercent: params.growthPercent ?? 10,
        minSizeBytes: params.minSizeBytes ?? 10 * 1024 ** 3,
        env: params.env,
      }),
      suppressError: true,
    });
  },

  /** 元数据标注缺口：既有接口，作为治理项之一接入健康度；env 按库名后缀过滤，domainCode / layerCode 同口径收窄 */
  async getAnnotationGaps(
    params: { current?: number; size?: number; env?: AssetEnvCode; domainCode?: string; layerCode?: string } = {}
  ) {
    return request<ApiResponse<AnnotationGapSummary>>(`/api/metadata/annotation-gaps`, {
      params: toQuery(params as Record<string, unknown>),
      suppressError: true,
    });
  },
};

export default assetCatalogApi;
