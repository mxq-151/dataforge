/**
 * 数据质量接口封装（dataforge-server /quality/*）
 *
 * ── 路径约定 ────────────────────────────────────────────────
 * 服务端 context-path 为 /api，控制器声明不含 /api 前缀，因此这里统一写 /api/quality/...。
 * 既有结果接口 /api/quality/check-result/* 保留兼容，新链路走 /api/quality/rule|task|run/*。
 *
 * ── 错误处理约定 ────────────────────────────────────────────
 * 本模块统一传 suppressError: true —— 不触发全局 toast，由调用方（面板）在自己的
 * 空态/错误态里呈现。原因是质量面板的数据源较多，多个接口同时失败时全局 toast 会刷屏。
 *
 * ⚠ 接口尚未在服务端实现时（当前第一批只建表），调用会抛错，面板需按「待接入」处理，
 * 不得让异常冒泡导致白屏。
 */

import { request } from './index';
import type { ApiResponse, PageResult } from './types';
import type {
  QualityRuleTemplateVO,
  QualityRuleVO,
  QualityRuleRegisterVO,
  QualityTaskVO,
  QualityRunInstanceVO,
  QualityRuleResultVO,
  QualityOverviewVO,
  QualityAlertSubscriptionVO,
  QualityAlertLogVO,
  QualityTriggerType,
} from '../types/quality';

export type {
  QualityRuleTemplateVO,
  QualityRuleVO,
  QualityRuleRegisterVO,
  QualityTaskVO,
  QualityRunInstanceVO,
  QualityRuleResultVO,
  QualityOverviewVO,
  QualityAlertSubscriptionVO,
  QualityAlertLogVO,
};

/** 创建/更新入参：由面板收集，字段与 VO 对齐（id 仅更新时必填） */
export type QualityRuleSaveDTO = Omit<QualityRuleVO, 'id' | 'createTime' | 'updateTime'> & { id?: number };
export type QualityTemplateSaveDTO = Omit<QualityRuleTemplateVO, 'id'> & { id?: number };
export type QualityTaskSaveDTO = Omit<QualityTaskVO, 'id' | 'createTime' | 'updateTime'> & { id?: number };

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

export interface QualityRunListParams {
  current?: number;
  size?: number;
  taskId?: number;
  batchNo?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
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

  /** 规则试跑：不落运行实例，只回结果，用于保存前验证阈值是否合理 */
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
   * 界面侧的批量导入（RuleTab）仍走 `createRule` / `batchCreateRulesByTemplate`：
   * 那两条面向「人工确认后落库」，语义是新建而非登记。
   */
  async registerRule(data: QualityRuleSaveDTO & { taskId?: number }): Promise<ApiResponse<QualityRuleRegisterVO>> {
    return request<ApiResponse<QualityRuleRegisterVO>>(`${BASE}/rule/register`, {
      method: 'POST',
      body: JSON.stringify(data),
      suppressError: true,
    });
  },

  // ── 质检任务 ──────────────────────────────────────────────

  async listTasks(params: { current?: number; size?: number; keyword?: string; triggerType?: QualityTriggerType; enabled?: boolean } = {}) {
    return request<ApiResponse<PageResult<QualityTaskVO>>>(`${BASE}/task`, {
      params: toQuery(params as Record<string, unknown>),
      suppressError: true,
    });
  },

  async createTask(data: QualityTaskSaveDTO): Promise<ApiResponse<null>> {
    return request<ApiResponse<null>>(`${BASE}/task`, {
      method: 'POST',
      body: JSON.stringify(data),
      suppressError: true,
    });
  },

  async updateTask(data: QualityTaskSaveDTO): Promise<ApiResponse<null>> {
    return request<ApiResponse<null>>(`${BASE}/task`, {
      method: 'PUT',
      body: JSON.stringify(data),
      suppressError: true,
    });
  },

  async deleteTask(id: number): Promise<ApiResponse<null>> {
    return request<ApiResponse<null>>(`${BASE}/task/${id}`, { method: 'DELETE', suppressError: true });
  },

  async listTaskRules(taskId: number) {
    return request<ApiResponse<QualityRuleVO[]>>(`${BASE}/task/${taskId}/rules`, { suppressError: true });
  },

  /** 手动触发：返回运行实例 id，用于随后轮询运行结果 */
  async runTask(taskId: number): Promise<ApiResponse<number>> {
    return request<ApiResponse<number>>(`${BASE}/task/${taskId}/run`, { method: 'POST', suppressError: true });
  },

  async setTaskEnabled(taskId: number, enabled: boolean): Promise<ApiResponse<null>> {
    return request<ApiResponse<null>>(`${BASE}/task/${taskId}/enable`, {
      method: 'POST',
      params: { enabled: String(enabled) },
      suppressError: true,
    });
  },

  // ── 运行记录 ──────────────────────────────────────────────

  async listRuns(params: QualityRunListParams = {}) {
    return request<ApiResponse<PageResult<QualityRunInstanceVO>>>(`${BASE}/run`, {
      params: toQuery(params as Record<string, unknown>),
      suppressError: true,
    });
  },

  async getRun(id: number): Promise<ApiResponse<QualityRunInstanceVO>> {
    return request<ApiResponse<QualityRunInstanceVO>>(`${BASE}/run/${id}`, { suppressError: true });
  },

  /** 规则级结果：满足提示词「规则名/校验对象/阈值/实际值/是否通过」五要素 */
  async listRunResults(runId: number): Promise<ApiResponse<QualityRuleResultVO[]>> {
    return request<ApiResponse<QualityRuleResultVO[]>>(`${BASE}/run/${runId}/results`, { suppressError: true });
  },

  /** 结果上报入口：S3 侧校验任务回传结果用（程序调用，非界面） */
  async reportRun(payload: {
    datasourceId?: number;
    datasourceName: string;
    databaseName: string;
    tableName: string;
    batchNo: string;
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
    passed: boolean;
    checkRecordCount?: number;
    failRecordCount?: number;
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

  // ── 大盘与告警 ────────────────────────────────────────────

  async getOverview(params: { startDate?: string; endDate?: string; projectCode?: string } = {}) {
    return request<ApiResponse<QualityOverviewVO>>(`${BASE}/overview`, {
      params: toQuery(params),
      suppressError: true,
    });
  },

  async listAlertSubscriptions(params: { current?: number; size?: number; taskId?: number } = {}) {
    return request<ApiResponse<PageResult<QualityAlertSubscriptionVO>>>(`${BASE}/alert`, {
      params: toQuery(params as Record<string, unknown>),
      suppressError: true,
    });
  },

  async saveAlertSubscription(data: Omit<QualityAlertSubscriptionVO, 'id' | 'taskName'> & { id?: number }) {
    return request<ApiResponse<null>>(`${BASE}/alert`, {
      method: 'POST',
      body: JSON.stringify(data),
      suppressError: true,
    });
  },

  /**
   * 站内告警箱：分页查告警记录。
   *
   * 「站内记录」渠道落库即送达，Webhook 的投递结果（SENT / FAILED + 原因）也落在这里，
   * 因此这一张表就是可用的告警箱。
   */
  async listAlertLogs(params: { current?: number; size?: number; taskId?: number; channel?: string; status?: string } = {}) {
    return request<ApiResponse<PageResult<QualityAlertLogVO>>>(`${BASE}/alert/log`, {
      params: toQuery(params as Record<string, unknown>),
      suppressError: true,
    });
  },
};

export default qualityApi;
