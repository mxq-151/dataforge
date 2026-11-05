/**
 * 数据质量接口封装（dataforge-server /quality/*）
 *
 * ── 路径约定 ────────────────────────────────────────────────
 * 服务端 context-path 为 /api，控制器声明不含 /api 前缀，因此这里统一写 /api/quality/...。
 * 规则/模板走 /api/quality/rule|template/*，结果留痕走 /api/quality/run/report。
 *
 * ── 已移除的链路 ────────────────────────────────────────────
 * 质检任务（/quality/task*）、运行记录（/quality/run 的查询接口）与告警订阅（/quality/alert*）
 * 已随「质检任务 / 运行记录 / 告警订阅」三个页签一并删除，前端不再有对应调用。
 * 历史结果表接口 /quality/check-result/*（data_quality_check_result）已被 dq_rule_result 取代，一并移除。
 *
 * 结果回传（POST /quality/run/report）**保留**：它不是页签功能，而是 S3 侧校验程序写
 * 「结果留痕」（dq_rule_result）的唯一入口；路径沿用历史值，以免已部署环境的
 * DATAFORGE_QUALITY_REPORT_URL 失效。
 *
 * ── 错误处理约定 ────────────────────────────────────────────
 * 本模块统一传 suppressError: true —— 不触发全局 toast，由调用方（面板）在自己的
 * 空态/错误态里呈现。原因是质量面板的数据源较多，多个接口同时失败时全局 toast 会刷屏。
 */

import { request } from './index';
import type { ApiResponse, PageResult } from './types';
import type {
  QualityRuleTemplateVO,
  QualityRuleVO,
  QualityRuleRegisterVO,
  QualityRuleResultVO,
  QualityOverviewVO,
} from '../types/quality';

export type {
  QualityRuleTemplateVO,
  QualityRuleVO,
  QualityRuleRegisterVO,
  QualityRuleResultVO,
  QualityOverviewVO,
};

/** 创建/更新入参：由面板收集，字段与 VO 对齐（id 仅更新时必填） */
export type QualityRuleSaveDTO = Omit<QualityRuleVO, 'id' | 'createTime' | 'updateTime'> & { id?: number };
export type QualityTemplateSaveDTO = Omit<QualityRuleTemplateVO, 'id'> & { id?: number };

export interface QualityRuleListParams {
  current?: number;
  size?: number;
  datasourceId?: number;
  databaseName?: string;
  tableName?: string;
  columnName?: string;
  ruleType?: string;
  enabled?: boolean;
  /** 规则名精确匹配（非模糊）：登记前查「这条规则在不在平台」用得上 */
  ruleName?: string;
}

/** 把可选参数压成查询串，跳过 undefined / null / 空串 */
function toQuery(params: Record<string, unknown>): Record<string, string> {
  const qs: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    qs[k] = String(v);
  }
  return qs;
}

const BASE = '/api/quality';

export const qualityApi = {
  // ── 规则模板 ──────────────────────────────────────────────

  /** 内置模板：即 types/quality 的 7 类规则类型，由平台预置 */
  async listBuiltinTemplates(): Promise<ApiResponse<QualityRuleTemplateVO[]>> {
    return request<ApiResponse<QualityRuleTemplateVO[]>>(`${BASE}/template/builtin`, { suppressError: true });
  },

  /** 自定义模板分页 */
  async listTemplates(params: { current?: number; size?: number; ruleType?: string; keyword?: string } = {}) {
    return request<ApiResponse<PageResult<QualityRuleTemplateVO>>>(`${BASE}/template`, {
      params: toQuery(params),
      suppressError: true,
    });
  },

  async createTemplate(data: QualityTemplateSaveDTO): Promise<ApiResponse<null>> {
    return request<ApiResponse<null>>(`${BASE}/template`, {
      method: 'POST',
      body: JSON.stringify(data),
      suppressError: true,
    });
  },

  async updateTemplate(data: QualityTemplateSaveDTO): Promise<ApiResponse<null>> {
    return request<ApiResponse<null>>(`${BASE}/template`, {
      method: 'PUT',
      body: JSON.stringify(data),
      suppressError: true,
    });
  },

  async deleteTemplate(id: number): Promise<ApiResponse<null>> {
    return request<ApiResponse<null>>(`${BASE}/template/${id}`, { method: 'DELETE', suppressError: true });
  },

  /** 把模板参数渲染为方言 SQL 预览，供配置界面核对 */
  async previewSql(payload: { templateId: number; datasourceId: number; databaseName: string; tableName: string; columnName?: string; params?: Record<string, string> }) {
    return request<ApiResponse<{ sql: string }>>(`${BASE}/template/preview-sql`, {
      method: 'POST',
      body: JSON.stringify(payload),
      suppressError: true,
    });
  },

  // ── 监控规则 ──────────────────────────────────────────────

  async listRules(params: QualityRuleListParams = {}) {
    return request<ApiResponse<PageResult<QualityRuleVO>>>(`${BASE}/rule`, {
      params: toQuery(params as Record<string, unknown>),
      suppressError: true,
    });
  },

  async createRule(data: QualityRuleSaveDTO): Promise<ApiResponse<null>> {
    return request<ApiResponse<null>>(`${BASE}/rule`, {
      method: 'POST',
      body: JSON.stringify(data),
      suppressError: true,
    });
  },

  async updateRule(data: QualityRuleSaveDTO): Promise<ApiResponse<null>> {
    return request<ApiResponse<null>>(`${BASE}/rule`, {
      method: 'PUT',
      body: JSON.stringify(data),
      suppressError: true,
    });
  },

  async deleteRule(id: number): Promise<ApiResponse<null>> {
    return request<ApiResponse<null>>(`${BASE}/rule/${id}`, { method: 'DELETE', suppressError: true });
  },

  /** 规则试跑：不落结果，只回结果，用于保存前验证阈值是否合理 */
  async testRunRule(payload: { ruleId?: number; rule?: QualityRuleSaveDTO; batchNo?: string }) {
    return request<ApiResponse<QualityRuleResultVO>>(`${BASE}/rule/test-run`, {
      method: 'POST',
      body: JSON.stringify(payload),
      suppressError: true,
    });
  },

  /** 按模板批量建规则（对齐 DataWorks「按模板批量配置」） */
  async batchCreateRulesByTemplate(payload: { templateId: number; targets: Array<{ datasourceId: number; databaseName: string; tableName: string; columnName?: string }>; defaults: Partial<QualityRuleSaveDTO> }) {
    return request<ApiResponse<{ created: number; skipped: number }>>(`${BASE}/rule/batch-by-template`, {
      method: 'POST',
      body: JSON.stringify(payload),
      suppressError: true,
    });
  },

  /**
   * 规则登记（幂等）。
   *
   * 给 S3 侧质检程序用：实现校验逻辑前先登记并取回 `ruleId`，之后实现与回传都用 ID 关联，
   * 规则名退化为展示字段——改名不再断开链路。判定键是「规则名 + 库 + 表」，
   * 与 `/quality/run/report` 的服务端反查口径一致；已登记则原样返回既有记录（不覆盖）。
   *
   * 面向「人工确认后落库」的规则维护仍走 `createRule` / `batchCreateRulesByTemplate`：
   * 那两条语义是新建而非登记。
   */
  async registerRule(data: QualityRuleSaveDTO): Promise<ApiResponse<QualityRuleRegisterVO>> {
    return request<ApiResponse<QualityRuleRegisterVO>>(`${BASE}/rule/register`, {
      method: 'POST',
      body: JSON.stringify(data),
      suppressError: true,
    });
  },

  // ── 结果回传（程序调用，非界面） ──────────────────────────

  /**
   * 结果上报入口：S3 侧校验任务回传结果用。
   *
   * 落「校验结果留痕」（dq_rule_result）。这是「行数波动 / 行数环比」试跑基线与
   * 资产目录质量摘要的数据来源，因此即使运行实例链路已移除，这个入口仍保留。
   * 路径沿用历史的 /quality/run/report，避免已部署环境的环境变量失效。
   */
  async reportResult(payload: {
    datasourceId?: number;
    datasourceName: string;
    databaseName: string;
    tableName: string;
    ruleName: string;
    /**
     * 平台规则 ID。可选，但**能拿到就一定要传**：
     * 平台默认按规则名匹配，改名即断链；带 ruleId 后关联不再依赖名字字符串。
     */
    ruleId?: number;
    ruleType: string;
    checkObject?: string;
    threshold?: string;
    actualValue?: string;
    /** 原始度量值（行数类=当期行数）；不传时按 actualValue 留痕 */
    metricValue?: string;
    passed: boolean;
    failDetail?: string;
    /** 本次**实际执行**的校验 SQL：模板会改版，留下它才能事后核对口径 */
    execSql?: string;
  }): Promise<ApiResponse<null>> {
    return request<ApiResponse<null>>(`${BASE}/run/report`, {
      method: 'POST',
      body: JSON.stringify(payload),
      suppressError: true,
    });
  },

  // ── 大盘 ──────────────────────────────────────────────────

  async getOverview(params: { startDate?: string; endDate?: string } = {}) {
    return request<ApiResponse<QualityOverviewVO>>(`${BASE}/overview`, {
      params: toQuery(params),
      suppressError: true,
    });
  },
};

export default qualityApi;
