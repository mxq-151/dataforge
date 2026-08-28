import { request } from './index';
import type { ApiResponse, PageResult } from './types';

export interface IndicatorFieldVO {
  id: number;
  indicatorsId: number;
  datasourceName: string;
  dbName: string;
  tblName: string;
  fieldName: string;
  fieldType: string;
}

export interface IndicatorVO {
  id: number;
  projectCode: string;
  topic: string;
  name: string;
  code: string;
  businessDefinition: string;
  calcExpr: string;
  defaultFilter: string;
  alertConfig: string;
  businessOwner: string;
  techOwner: string;
  refreshInterval: number | null;
  refreshUnit: string;
  refreshDesc: string;
  visibility: string;
  createdAt: string;
  updatedAt: string;
  fields?: IndicatorFieldVO[];
}

// DTO 定义已迁至 types/indicator（供 utils 等下层模块引用，避免反向依赖 api），此处 re-export
import type { IndicatorFieldDTO, IndicatorDTO } from '../types/indicator';
export type { IndicatorFieldDTO, IndicatorDTO };

interface IndicatorListParams {
  current?: number;
  size?: number;
  projectCode?: string;
  topic?: string;
  name?: string;
  keyword?: string;
}

export const indicatorApi = {
  async getList(params: IndicatorListParams = {}): Promise<ApiResponse<PageResult<IndicatorVO>>> {
    const qs: Record<string, string> = {};
    if (params.current !== undefined) qs.current = String(params.current);
    if (params.size !== undefined) qs.size = String(params.size);
    if (params.projectCode) qs.projectCode = params.projectCode;
    if (params.topic) qs.topic = params.topic;
    if (params.name) qs.name = params.name;
    if (params.keyword) qs.keyword = params.keyword;
    return request<ApiResponse<PageResult<IndicatorVO>>>('/api/metadata/indicators/list', {
      params: qs,
    });
  },

  async getById(id: number): Promise<ApiResponse<IndicatorVO>> {
    return request<ApiResponse<IndicatorVO>>(`/api/metadata/indicators/${id}`);
  },

  async filter(params: { projectCode?: string; topic?: string; keyword?: string } = {}): Promise<ApiResponse<IndicatorVO[]>> {
    const qs: Record<string, string> = {};
    if (params.projectCode) qs.projectCode = params.projectCode;
    if (params.topic) qs.topic = params.topic;
    if (params.keyword) qs.keyword = params.keyword;
    return request<ApiResponse<IndicatorVO[]>>('/api/metadata/indicators/filter', {
      params: qs,
    });
  },

  async batchSave(data: IndicatorDTO[]): Promise<ApiResponse<null>> {
    return request<ApiResponse<null>>('/api/metadata/indicators/batch', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async update(data: IndicatorDTO): Promise<ApiResponse<null>> {
    return request<ApiResponse<null>>('/api/metadata/indicators', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async batchDelete(ids: number[]): Promise<ApiResponse<null>> {
    return request<ApiResponse<null>>('/api/metadata/indicators/batch', {
      method: 'DELETE',
      body: JSON.stringify(ids),
    });
  },
};
