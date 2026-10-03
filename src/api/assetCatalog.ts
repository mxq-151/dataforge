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
import type { ApiResponse, PageResult } from './types';

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
  // 使用热度（T+1 汇总）
  browseCount30d: number;
  readCount30d: number;
  bookmarkCount: number;
  lastAccessTime: string;
  /** 治理项计数，非加权评分 */
  healthIssueCount: number;
  /** 当前登录用户是否已收藏 */
  bookmarked: boolean;
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
  /** 字段热度星级 0~5 */
  hotScore: number;
}

export interface AssetTagVO {
  id: number;
  tagCode: string;
  tagName: string;
  color: string;
}

/** 使用记录（热度趋势 + 字段热度） */
export interface AssetUsageVO {
  browseTrend: Array<{ statDate: string; browseCount: number; readCount: number }>;
  topColumns: Array<{ columnName: string; hotScore: number; hitCount: number }>;
  topReaders: Array<{ userName: string; readCount: number }>;
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
  byLayer: Array<{ layerCode: string; tableCount: number; sizeBytes: number }>;
  byDomain: Array<{ domainCode: string; tableCount: number; sizeBytes: number }>;
  byDatasource: Array<{ datasourceId: number; datasourceName: string; tableCount: number }>;
  /** 命名不合规、未标注等需治理的总数 */
  unclassifiedCount: number;
}

// ── 资产概况（盘点看板）──────────────────────────────────────
//
// 环境口径与库名规范同源：库名 {分层}_{业务域}_{环境}，环境后缀仅限 _prod/_gray/_test，
// 故 env 由服务端按库名解析，前端不自行猜测，避免「生产库被当测试库」这类误判。

/** 环境码：生产 / 灰度 / 测试（与库名后缀 _prod/_gray/_test 一一对应） */
export type AssetEnvCode = 'prod' | 'gray' | 'test';

/** 按环境与项目聚合的表数量与占用空间 */
export interface AssetEnvProjectStatVO {
  env: AssetEnvCode;
  projectCode: string;
  projectName: string;
  tableCount: number;
  sizeBytes: number;
}

/** TOP 资产清单排序维度：访问频率 / 占用空间 */
export type AssetTopSortBy = 'access' | 'size';

export interface AssetTopAssetVO {
  tableMetadataId: number;
  databaseName: string;
  tableName: string;
  env: AssetEnvCode;
  projectCode: string;
  projectName: string;
  /** 近 30 天访问次数（访问频率榜口径） */
  accessCount30d: number;
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

/** 埋点上报项：浏览与读取分开统计 */
export type AssetAccessType = 'browse' | 'read' | 'bookmark' | 'query';

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
  /** 目录树。view=convention 时返回「分层→业务域→表」的规范视角 */
  async getCatalogTree(params: { view?: CatalogViewMode; datasourceId?: number; databaseName?: string; keyword?: string } = {}) {
    return request<ApiResponse<CatalogTreeNode[]>>(`${BASE}/catalog/tree`, {
      params: toQuery({ view: params.view ?? 'engine', datasourceId: params.datasourceId, databaseName: params.databaseName, keyword: params.keyword }),
      suppressError: true,
    });
  },

  /** 统一检索：表 / 字段 / 指标三类，服务端已按权限过滤 */
  async search(params: { keyword: string; types?: AssetSearchType[]; current?: number; size?: number; layerCode?: string; domainCode?: string }) {
    return request<ApiResponse<AssetSearchResult>>(`${BASE}/search`, {
      params: toQuery({
        keyword: params.keyword,
        types: params.types?.length ? params.types.join(',') : undefined,
        current: params.current,
        size: params.size,
        layerCode: params.layerCode,
        domainCode: params.domainCode,
      }),
      suppressError: true,
    });
  },

  async suggest(keyword: string) {
    return request<ApiResponse<string[]>>(`${BASE}/suggest`, { params: { keyword }, suppressError: true });
  },

  /** 资产详情聚合：基础信息 + 字段 + 分区 + 分类标签 */
  async getTableDetail(id: number) {
    return request<ApiResponse<AssetTableDetailVO>>(`${BASE}/table/${id}`, { suppressError: true });
  },

  async getTableUsage(id: number, params: { days?: number } = {}) {
    return request<ApiResponse<AssetUsageVO>>(`${BASE}/table/${id}/usage`, {
      params: toQuery({ days: params.days ?? 30 }),
      suppressError: true,
    });
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

  // ── 收藏与标签 ────────────────────────────────────────────

  async listBookmarks(params: { current?: number; size?: number } = {}) {
    return request<ApiResponse<PageResult<AssetSearchHit>>>(`${BASE}/bookmark`, {
      params: toQuery(params as Record<string, unknown>),
      suppressError: true,
    });
  },

  async addBookmark(payload: { assetType: AssetSearchType; assetId: number; tableMetadataId?: number }) {
    return request<ApiResponse<null>>(`${BASE}/bookmark`, {
      method: 'POST',
      body: JSON.stringify(payload),
      suppressError: true,
    });
  },

  async removeBookmark(params: { assetType: AssetSearchType; assetId: number }) {
    return request<ApiResponse<null>>(`${BASE}/bookmark`, {
      method: 'DELETE',
      params: toQuery(params as Record<string, unknown>),
      suppressError: true,
    });
  },

  async listTags() {
    return request<ApiResponse<AssetTagVO[]>>(`${BASE}/tag`, { suppressError: true });
  },

  async listCategories() {
    return request<ApiResponse<Array<{ code: string; name: string; parentCode: string; categoryKind: 'layer' | 'domain' }>>>(`${BASE}/category`, { suppressError: true });
  },

  // ── 埋点与盘点 ────────────────────────────────────────────

  /**
   * 访问埋点上报。属非关键路径：失败静默不提示，不阻塞任何交互。
   * 注意写入独立轻量表 asset_access_log，不写 operation_audit_log（避免淹没真实操作留痕）。
   */
  async reportAccess(items: Array<{ assetType: AssetSearchType; assetId: number; accessType: AssetAccessType; keyword?: string }>): Promise<void> {
    try {
      await request<ApiResponse<null>>(`${BASE}/access`, {
        method: 'POST',
        body: JSON.stringify({ items }),
        suppressError: true,
      });
    } catch {
      /* 埋点失败静默降级 */
    }
  },

  async getInventoryOverview(params: { projectCode?: string } = {}) {
    return request<ApiResponse<AssetInventoryVO>>(`${BASE}/inventory/overview`, {
      params: toQuery(params),
      suppressError: true,
    });
  },

  async getInventoryHealth() {
    return request<ApiResponse<AssetHealthIssueVO[]>>(`${BASE}/inventory/health`, { suppressError: true });
  },

  // ── 资产概况（盘点看板）──────────────────────────────────

  /** 按环境（生产 / 灰度 / 测试）与项目聚合的表数量与占用空间 */
  async getInventoryByEnvProject() {
    return request<ApiResponse<AssetEnvProjectStatVO[]>>(`${BASE}/inventory/env-project`, { suppressError: true });
  },

  /** 访问频率 / 占用空间 TOP 资产（默认 100 条） */
  async getTopAssets(params: { sortBy: AssetTopSortBy; limit?: number }) {
    return request<ApiResponse<AssetTopAssetVO[]>>(`${BASE}/inventory/top-assets`, {
      params: toQuery({ sortBy: params.sortBy, limit: params.limit ?? 100 }),
      suppressError: true,
    });
  },

  /** 消耗计算资源 / 运行时长 TOP 任务（默认 50 条） */
  async getTopComputeTasks(params: { sortBy: AssetTaskSortBy; limit?: number }) {
    return request<ApiResponse<AssetTopComputeTaskVO[]>>(`${BASE}/inventory/top-compute`, {
      params: toQuery({ sortBy: params.sortBy, limit: params.limit ?? 50 }),
      suppressError: true,
    });
  },

  /** 任务延迟率（主要针对 YARN 任务） */
  async getTaskDelayRate(params: { days?: number } = {}) {
    return request<ApiResponse<AssetTaskDelayVO>>(`${BASE}/inventory/task-delay`, {
      params: toQuery({ days: params.days ?? 30 }),
      suppressError: true,
    });
  },

  /** 数据大小增长率突增表：默认 增长率 > 10% 且当前大小 > 10GB */
  async getSizeGrowthAnomalies(params: { growthPercent?: number; minSizeBytes?: number } = {}) {
    return request<ApiResponse<AssetSizeGrowthVO[]>>(`${BASE}/inventory/size-growth`, {
      params: toQuery({
        growthPercent: params.growthPercent ?? 10,
        minSizeBytes: params.minSizeBytes ?? 10 * 1024 ** 3,
      }),
      suppressError: true,
    });
  },

  /** 元数据标注缺口：既有接口，作为治理项之一接入健康度 */
  async getAnnotationGaps(params: { current?: number; size?: number } = {}) {
    return request<ApiResponse<unknown>>(`/api/metadata/annotation-gaps`, {
      params: toQuery(params as Record<string, unknown>),
      suppressError: true,
    });
  },
};

export default assetCatalogApi;
