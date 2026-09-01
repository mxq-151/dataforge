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

/**
 * 项目级 JAR 依赖（对应后端 DevJarDependencyDTO / DevJarDependencyVO）。
 * 后端 /params 接口的 jarDependencyCatalogs 已是对象数组，不再是坐标字符串列表。
 */
export interface DevJarDependency {
  id?: number;
  /** JAR 名称（后端 @NotBlank，保存时必填） */
  jarName: string;
  groupId?: string;
  artifactId?: string;
  version?: string;
  scope?: string;
  source?: string;
  jarPath?: string;
  repositoryUrl?: string;
  fileSize?: number;
  checksum?: string;
  status?: number;
  description?: string;
  category?: string;
  /** 程序类型（SPARK / FLINK / JAVA 等，后端 @NotBlank） */
  programType?: string;
  autoChoose?: number | null;
  createTime?: string;
  updateTime?: string;
}

export interface ProgramParamsVO {
  projectId: number;
  filePath: string;
  engine: string;
  datasources: string[];
  jarDependencyCatalogs: DevJarDependency[];
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
  jarDependencyCatalogs: DevJarDependency[];
  runParams: Record<string, unknown>;
  computeResources: Record<string, unknown>;
  remark: string;
}

export const fetchProjectConfigByFilePath = (projectId: number, filePath: string) =>
  request<ApiResponse<ProgramParamsVO>>(`/api/development/project/${projectId}/params`, {
    params: { filePath },
  });

/**
 * 保存/更新程序参数（upsert）。
 * 后端 DevProjectController 仅暴露 PUT /development/project/{projectId}/params：
 *   - filePath 放在请求体（不再读取 query 参数）
 *   - 按联合主键 (project_id, file_path) 原子 upsert，无需前端先查后写
 * 旧版 POST 保存接口已移除（POST / 现为创建项目本体，需 SUPER_ADMIN 角色）。
 */
export const saveProjectConfig = (projectId: number, body: ProgramParamsDTO) =>
  request<ApiResponse<null>>(`/api/development/project/${projectId}/params`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
