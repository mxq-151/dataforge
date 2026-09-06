import { request } from './index';
import type { ApiResponse, PageResult } from './types';

export interface MenuPermission {
  id: number;
  menuName: string;
  menuCode: string;
  icon: string;
  createTime?: string;
  updateTime?: string;
}

export interface MenuRoleBindVO {
  id: number;
  menuName: string;
  menuCode: string;
  path: string;
  icon: string;
  sortOrder: number;
  visible: number;
  status: number;
  roleId: number;
  roleName: string;
  roleCode: string;
}

export interface MenuRoleBindDTO {
  menuId: number;
  roleId: number;
}

export interface FilePermission {
  id: number;
  permissionName: string;
  storageConfigId: number;
  storageType: string;
  filePath: string;
  permissionType: number;
  recursive: number;
  description: string;
  roleIds?: number[];
  roleNames?: string[];
}

export interface TablePermissionDTO {
  id?: number;
  permissionName: string;
  datasourceName: string;
  databaseName: string;
  tableNames: string[];
  permissionScope: number;
  canSelect: number;
  canInsert: number;
  canUpdate: number;
  canDelete: number;
  canExport: number;
  /** 指定行权限范围时，表名 -> 行过滤SQL（WHERE条件，支持WHERE前缀或裸表达式） */
  rowFilterSql?: Record<string, string>;
  dataMaskingRule?: string;
  /** 指定列权限范围时，表名 -> 允许可见的列名列表 */
  columnPermissions?: Record<string, string[]>;
  description: string;
  roleIds: number[];
}

export interface TablePermissionVO {
  id: number;
  tableMetadataIds?: number[];
  datasourceName: string;
  databaseName: string;
  tableNames: string[];
  permissionName: string;
  permissionScope: number;
  canSelect: number;
  canInsert: number;
  canUpdate: number;
  canDelete: number;
  canExport: number;
  /** 指定行权限范围时，表名 -> 行过滤SQL（WHERE条件） */
  rowFilterSql?: Record<string, string>;
  dataMaskingRule?: string;
  /** 指定列权限范围时，表名 -> 允许可见的列名列表 */
  columnPermissions?: Record<string, string[]>;
  description: string;
  createTime?: string;
  updateTime?: string;
  roleIds?: number[];
  roleNames?: string[];
}

export interface RolePermissionsVO {
  menuPermissionIds: number[];
  filePermissionIds: number[];
  tablePermissionIds: number[];
}

export interface AssignPermissionDTO {
  menuPermissionIds: number[];
  filePermissionIds: number[];
  tablePermissionIds: number[];
}

export const systemPermissionApi = {
  async getMenuTree(): Promise<ApiResponse<MenuPermission[]>> {
    return request<ApiResponse<MenuPermission[]>>('/api/system/menu-role/list');
  },

  async getBinds(): Promise<ApiResponse<MenuRoleBindVO[]>> {
    return request<ApiResponse<MenuRoleBindVO[]>>('/api/system/menu-role/binds');
  },

  async bindMenuRoles(data: MenuRoleBindDTO[]): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>('/api/system/menu-role/bind', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async deleteMenuPermission(id: number): Promise<ApiResponse<MenuPermission[]>> {
    return request<ApiResponse<MenuPermission[]>>(`/api/system/menu-role/delete?id=${id}`, { method: 'DELETE' });
  },

  async getFilePermissionList(params: { current: number; size: number }): Promise<ApiResponse<PageResult<FilePermission>>> {
    return request<ApiResponse<PageResult<FilePermission>>>('/api/system/permission/file/list', {
      params: { current: String(params.current), size: String(params.size) },
    });
  },

  async saveFilePermission(data: Partial<FilePermission>): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>('/api/system/permission/file', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateFilePermission(data: Partial<FilePermission>): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>('/api/system/permission/file', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async deleteFilePermission(id: number): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>(`/api/system/permission/file/${id}`, { method: 'DELETE' });
  },

  async getTablePermissionList(params: { current: number; size: number }): Promise<ApiResponse<PageResult<TablePermissionVO>>> {
    return request<ApiResponse<PageResult<TablePermissionVO>>>('/api/system/permission/table/list', {
      params: { current: String(params.current), size: String(params.size) },
    });
  },

  async saveTablePermission(data: TablePermissionDTO): Promise<ApiResponse<TablePermissionVO>> {
    return request<ApiResponse<TablePermissionVO>>('/api/system/permission/table', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateTablePermission(data: TablePermissionDTO): Promise<ApiResponse<TablePermissionVO>> {
    return request<ApiResponse<TablePermissionVO>>('/api/system/permission/table', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async deleteTablePermission(id: number): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>(`/api/system/permission/table/${id}`, { method: 'DELETE' });
  },

  async getRolePermissions(roleId: number): Promise<ApiResponse<RolePermissionsVO>> {
    return request<ApiResponse<RolePermissionsVO>>(`/api/system/permission/role/${roleId}`);
  },

  async assignRolePermissions(roleId: number, data: AssignPermissionDTO): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>(`/api/system/permission/role/${roleId}/assign`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
};
