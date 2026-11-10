import { request } from './index';
import type { ApiResponse, PageResult } from './types';

export interface IntegrationFieldVO {
  key: string;
  label: string;
  required: boolean;
  placeholder: string;
  /** text / password / textarea / select */
  type: string;
  /** type=select 时的可选值 */
  options?: string[];
}

export interface DataSourceTypeVO {
  code: string;
  label: string;
  streamSource: boolean;
  streamSink: boolean;
  readFields: IntegrationFieldVO[];
  writeFields: IntegrationFieldVO[];
}

export interface OptionItemVO {
  code: string;
  label: string;
}

export interface IntegrationOptionsVO {
  sourceTypes: DataSourceTypeVO[];
  targetTypes: DataSourceTypeVO[];
  clusterTypes: OptionItemVO[];
  statuses: OptionItemVO[];
  jobModes: OptionItemVO[];
  triggerTypes: OptionItemVO[];
}

export type StageConfig = Record<string, string | number | boolean | null>;

/** 需要同步的一张表 */
export interface IntegrationTableVO {
  id?: number;
  /** 源表（库.表） */
  sourceTable: string;
  /** 排除字段 */
  excludeColumns: string[];
  /** 服务端按目标命名模板推导出的目标标识（topic / 索引 / 路径 / Hive 表名） */
  targetIdentifier?: string | null;
  sortNo: number;
}

export interface IntegrationTableDTO {
  sourceTable: string;
  excludeColumns: string[];
  sortNo?: number;
}

export interface IntegrationTaskVO {
  id: number;
  taskName: string;
  taskCode: string;
  description: string;
  /** 所属项目（dev_project），历史任务可能为空 */
  projectId?: number | null;
  projectCode?: string | null;
  projectName?: string | null;
  sourceType: string;
  sourceTypeLabel: string;
  /** 一份源端连接配置 */
  sourceConfig: StageConfig;
  /** 一份目标端连接配置 */
  targetType: string;
  targetTypeLabel: string;
  targetConfig: StageConfig;
  tables: IntegrationTableVO[];
  tableCount: number;
  tableSummary: string;
  clusterType: string;
  readParallelism: number;
  writeParallelism: number;
  jobMode: string;
  triggerType: string;
  triggerConfig: string;
  extraParams: Record<string, unknown>;
  status: string;
  statusLabel: string;
  jobId?: string | null;
  lastSubmitTime?: string | null;
  lastOfflineTime?: string | null;
  lastError?: string | null;
  createTime?: string;
  updateTime?: string;
}

export interface IntegrationTaskDTO {
  id?: number;
  taskName: string;
  taskCode?: string;
  description?: string;
  /** 所属项目（dev_project.id），上线时其 project_code 作为血缘 namespace */
  projectId: number;
  sourceType: string;
  sourceConfig: StageConfig;
  targetType: string;
  targetConfig: StageConfig;
  tables: IntegrationTableDTO[];
  clusterType: string;
  readParallelism: number;
  writeParallelism: number;
  jobMode: string;
  triggerType: string;
  triggerConfig?: string;
  extraParams: Record<string, unknown>;
}

export interface IntegrationParamsDTO {
  extraParams: Record<string, unknown>;
  readParallelism?: number;
  writeParallelism?: number;
}

export interface IntegrationSubmitLogVO {
  id: number;
  taskId: number;
  action: string;
  clusterType: string;
  jobId?: string | null;
  resultStatus: string;
  errorMessage?: string | null;
  operatorId?: number | null;
  operatorName?: string | null;
  durationMs?: number | null;
  createTime?: string;
  logContent?: string | null;
}

export interface IntegrationSubmitResultVO {
  taskId: number;
  jobId?: string | null;
  status: string;
  statusLabel: string;
  message: string;
  logId?: number | null;
  durationMs?: number | null;
}

export interface IntegrationTaskStatusVO {
  taskId: number;
  status: string;
  statusLabel: string;
  jobId?: string | null;
  clusterStatus?: string | null;
  clusterReachable: boolean;
  message: string;
  checkedAt?: string;
}

export interface IntegrationListParams {
  current?: number;
  size?: number;
  keyword?: string;
  status?: string;
  clusterType?: string;
  sourceType?: string;
  targetType?: string;
}

export const dataIntegrationApi = {
  getOptions(): Promise<ApiResponse<IntegrationOptionsVO>> {
    return request<ApiResponse<IntegrationOptionsVO>>('/api/integration/options');
  },

  getList(params: IntegrationListParams = {}): Promise<ApiResponse<PageResult<IntegrationTaskVO>>> {
    const qs: Record<string, string> = {};
    if (params.current !== undefined) qs.current = String(params.current);
    if (params.size !== undefined) qs.size = String(params.size);
    if (params.keyword) qs.keyword = params.keyword;
    if (params.status) qs.status = params.status;
    if (params.clusterType) qs.clusterType = params.clusterType;
    if (params.sourceType) qs.sourceType = params.sourceType;
    if (params.targetType) qs.targetType = params.targetType;
    return request<ApiResponse<PageResult<IntegrationTaskVO>>>('/api/integration/tasks', { params: qs });
  },

  getById(id: number): Promise<ApiResponse<IntegrationTaskVO>> {
    return request<ApiResponse<IntegrationTaskVO>>(`/api/integration/tasks/${id}`);
  },

  create(data: IntegrationTaskDTO): Promise<ApiResponse<IntegrationTaskVO>> {
    return request<ApiResponse<IntegrationTaskVO>>('/api/integration/tasks', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  update(data: IntegrationTaskDTO): Promise<ApiResponse<IntegrationTaskVO>> {
    return request<ApiResponse<IntegrationTaskVO>>('/api/integration/tasks', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  remove(id: number): Promise<ApiResponse<null>> {
    return request<ApiResponse<null>>(`/api/integration/tasks/${id}`, { method: 'DELETE' });
  },

  updateParams(id: number, data: IntegrationParamsDTO): Promise<ApiResponse<IntegrationTaskVO>> {
    return request<ApiResponse<IntegrationTaskVO>>(`/api/integration/tasks/${id}/params`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  submit(id: number, overrides?: IntegrationParamsDTO): Promise<ApiResponse<IntegrationSubmitResultVO>> {
    return request<ApiResponse<IntegrationSubmitResultVO>>(`/api/integration/tasks/${id}/submit`, {
      method: 'POST',
      body: overrides ? JSON.stringify(overrides) : undefined,
    });
  },

  offline(id: number): Promise<ApiResponse<IntegrationSubmitResultVO>> {
    return request<ApiResponse<IntegrationSubmitResultVO>>(`/api/integration/tasks/${id}/offline`, {
      method: 'POST',
    });
  },

  status(id: number): Promise<ApiResponse<IntegrationTaskStatusVO>> {
    return request<ApiResponse<IntegrationTaskStatusVO>>(`/api/integration/tasks/${id}/status`);
  },

  logs(id: number, limit = 20): Promise<ApiResponse<IntegrationSubmitLogVO[]>> {
    return request<ApiResponse<IntegrationSubmitLogVO[]>>(`/api/integration/tasks/${id}/logs`, {
      params: { limit: String(limit) },
    });
  },

  logDetail(logId: number): Promise<ApiResponse<IntegrationSubmitLogVO>> {
    return request<ApiResponse<IntegrationSubmitLogVO>>(`/api/integration/logs/${logId}`);
  },
};

export default dataIntegrationApi;
