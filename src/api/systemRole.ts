import { request } from './index';
import type { ApiResponse, PageResult } from './types';

export interface RoleInfo {
  id: number;
  roleName: string;
  roleCode: string;
  roleType: string;
  description: string;
  status: number;
  createTime: string;
  userCount?: number;
  permissionCount?: number;
}

interface RoleListParams {
  current?: number;
  size?: number;
  roleName?: string;
}

export const systemRoleApi = {
  async getRoleList(params: RoleListParams): Promise<ApiResponse<PageResult<RoleInfo>>> {
    const qs: Record<string, string> = {};
    if (params.current !== undefined) qs.current = String(params.current);
    if (params.size !== undefined) qs.size = String(params.size);
    if (params.roleName) qs.roleName = params.roleName;
    return request<ApiResponse<PageResult<RoleInfo>>>('/api/system/role/list', { params: qs });
  },

  async getAllRoles(): Promise<ApiResponse<RoleInfo[]>> {
    return request<ApiResponse<RoleInfo[]>>('/api/system/role/all');
  },

  async createRole(data: Partial<RoleInfo>): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>('/api/system/role', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateRole(data: Partial<RoleInfo>): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>('/api/system/role', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async deleteRole(id: number): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>(`/api/system/role/${id}`, { method: 'DELETE' });
  },
};
