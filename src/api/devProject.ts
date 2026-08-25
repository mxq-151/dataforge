import { request } from './index';
import type { ApiResponse, PageResult } from './types';

export interface ProjectInfo {
  id: number;
  projectName: string;
  projectCode: string;
  description?: string;
  createTime?: string;
  updateTime?: string;
  [key: string]: unknown;
}

export interface ProgramParamsVO {
  projectId: number;
  filePath: string;
  engine: string;
  datasources: string[];
  jarDependencyCatalogs: string[];
  runParams: Record<string, unknown>;
  computeResources: Record<string, unknown>;
  remark: string;
}

interface FetchProjectListParams {
  current?: number;
  size?: number;
  projectName?: string;
  projectCode?: string;
}

export interface CreateProjectDTO {
  projectName: string;
  projectCode: string;
  description?: string;
  ownerId?: number;
  ownerName?: string;
  status?: number;
}

export const createProject = (data: CreateProjectDTO) =>
  request<ApiResponse<null>>('/api/development/project', {
    method: 'POST',
    body: JSON.stringify(data),
  });

export const deleteProject = (id: number) =>
  request<ApiResponse<null>>(`/api/development/project/${id}`, {
    method: 'DELETE',
  });

export const fetchProjectList = (params: FetchProjectListParams = {}) =>
  request<ApiResponse<PageResult<ProjectInfo>>>('/api/development/project/list', {
    params: {
      current: String(params.current ?? 1),
      size: String(params.size ?? 100),
      projectName: params.projectName ?? '',
      projectCode: params.projectCode ?? '',
    },
  });

export interface ProgramParamsDTO {
  projectId: number;
  filePath: string;
  engine: string;
  datasources: string[];
  jarDependencyCatalogs: string[];
  runParams: Record<string, unknown>;
  computeResources: Record<string, unknown>;
  remark: string;
}

export const fetchProjectConfigByFilePath = (projectId: number, filePath: string) =>
  request<ApiResponse<ProgramParamsVO>>(`/api/development/project/${projectId}/params`, {
    params: { filePath },
  });

export const saveProjectConfig = (projectId: number, body: ProgramParamsDTO) =>
  request<ApiResponse<null>>(`/api/development/project/${projectId}/params`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const updateProjectConfig = (projectId: number, filePath: string, body: ProgramParamsDTO) =>
  request<ApiResponse<null>>(`/api/development/project/${projectId}/params`, {
    method: 'PUT',
    params: { filePath },
    body: JSON.stringify(body),
  });
