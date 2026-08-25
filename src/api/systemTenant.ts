import { request } from './index';
import type { ApiResponse, PageResult } from './types';

export interface TenantVO {
  id: number;
  tenantName: string;
  tenantCode: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  description: string;
  status: number;
  userId: number | null;
  username: string;
  userRealName: string;
  roleIds: number[];
  password?: string;
  createTime: string;
  updateTime: string;
}

export interface TenantDTO {
  id?: number;
  tenantName: string;
  tenantCode: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  description?: string;
  status?: number;
  userId?: number;
  roleIds?: number[];
  password?: string;
}

export const tenantApi = {
  async getList(params: { current: number; size: number; tenantName?: string; status?: number }): Promise<ApiResponse<PageResult<TenantVO>>> {
    const qs: Record<string, string> = { current: String(params.current), size: String(params.size) };
    if (params.tenantName) qs.tenantName = params.tenantName;
    if (params.status !== undefined) qs.status = String(params.status);
    return request<ApiResponse<PageResult<TenantVO>>>('/api/system/tenant/list', { params: qs });
  },

  async createTenant(data: TenantDTO): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>('/api/system/tenant', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateTenant(data: TenantDTO): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>('/api/system/tenant', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async deleteTenant(id: number): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>(`/api/system/tenant/${id}`, { method: 'DELETE' });
  },

  async bindUser(tenantId: number, userId: number): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>(`/api/system/tenant/${tenantId}/bind-user/${userId}`, { method: 'POST' });
  },

  async unbindUser(tenantId: number, userId: number): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>(`/api/system/tenant/${tenantId}/unbind-user/${userId}`, { method: 'DELETE' });
  },
};
