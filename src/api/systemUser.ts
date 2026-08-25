import { request } from './index';
import type { ApiResponse, PageResult } from './types';
import { aesEncryptWithTimestamp } from '../utils/aes';

export interface UserInfo {
  id: number;
  username: string;
  password?: string;
  realName: string;
  email: string;
  phone: string;
  status: number;
  lastLoginTime?: string;
  roles?: string[];
  roleIds?: number[];
}

interface UserListParams {
  current?: number;
  size?: number;
  username?: string;
  status?: number;
}

interface LoginParams {
  username: string;
  password: string;
}

interface LoginResult {
  token: string;
}

export interface SysRoleVO {
  id: number;
  roleName: string;
  roleCode: string;
  roleType: string;
  description?: string;
  status?: number;
  createTime?: string;
  updateTime?: string;
}

export interface CurrentUserInfo {
  id: number;
  username: string;
  realName: string;
  email?: string;
  phone?: string;
  avatar?: string;
  roles: SysRoleVO[];
  menuTags: string[];
  projectCodes: string[];
  tenantId?: number;
  tenantName?: string;
}

export interface ChangePasswordDTO {
  oldPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export const systemUserApi = {
  async login(params: LoginParams): Promise<ApiResponse<LoginResult>> {
    return request<ApiResponse<LoginResult>>('/api/system/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: params.username,
        password: aesEncryptWithTimestamp(params.password),
      }),
    });
  },

  async getCurrentUser(): Promise<ApiResponse<CurrentUserInfo>> {
    return request<ApiResponse<CurrentUserInfo>>('/api/system/auth/info');
  },

  async getUserList(params: UserListParams): Promise<ApiResponse<PageResult<UserInfo>>> {
    const qs: Record<string, string> = {};
    if (params.current !== undefined) qs.current = String(params.current);
    if (params.size !== undefined) qs.size = String(params.size);
    if (params.username) qs.username = params.username;
    if (params.status !== undefined) qs.status = String(params.status);
    return request<ApiResponse<PageResult<UserInfo>>>('/api/system/user/list', { params: qs });
  },

  async createUser(data: Partial<UserInfo>): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>('/api/system/user', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateUser(data: Partial<UserInfo>): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>('/api/system/user', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async deleteUser(id: number): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>(`/api/system/user/${id}`, { method: 'DELETE' });
  },

  async changePassword(data: ChangePasswordDTO): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>('/api/system/user/password', {
      method: 'PUT',
      body: JSON.stringify({
        oldPassword: aesEncryptWithTimestamp(data.oldPassword),
        newPassword: aesEncryptWithTimestamp(data.newPassword),
        confirmPassword: aesEncryptWithTimestamp(data.confirmPassword),
      }),
    });
  },
};
