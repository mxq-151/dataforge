import { request } from './index';
import type { ApiResponse } from './types';

export interface ProjectPermissionVO {
  id: number;
  roleId: number;
  roleName: string;
  projectId: number;
  projectName: string;
  permissionType: number;
  permissionTypeName: string;
  createTime: string;
}

export interface BatchProjectPermissionDTO {
  roleId: number;
  items: { projectId: number; permissionType: number }[];
}

export const PROJECT_PERM_TYPE_MAP: Record<number, string> = { 1: '可读', 2: '可编辑', 3: '可删除' };
export const PROJECT_PERM_TYPE_TAG_MAP: Record<number, string> = { 1: 'info', 2: 'warning', 3: 'danger' };

export const projectPermissionApi = {
  async getByRoleId(roleId: number): Promise<ApiResponse<ProjectPermissionVO[]>> {
    return request<ApiResponse<ProjectPermissionVO[]>>(`/api/system/project-permission/role/${roleId}`);
  },

  async getByProjectId(projectId: number): Promise<ApiResponse<ProjectPermissionVO[]>> {
    return request<ApiResponse<ProjectPermissionVO[]>>(`/api/system/project-permission/project/${projectId}`);
  },

  async batchAssignPermissions(data: BatchProjectPermissionDTO): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>('/api/system/project-permission/batch', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async removePermission(roleId: number, projectId: number): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>(`/api/system/project-permission/${roleId}/${projectId}`, { method: 'DELETE' });
  },
};
