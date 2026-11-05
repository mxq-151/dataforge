import { request } from './index';

export interface DependencyRecord {
  id: number;
  jarName: string;
  groupId: string;
  artifactId: string;
  version: string;
  scope: string;
  source: string;
  jarPath: string;
  repositoryUrl: string | null;
  fileSize: number | null;
  checksum: number | null;
  status: number;
  description: string;
  category: string;
  programType: string;
  autoChoose: number | null;
  /** jar 存储根路径（后端 engineProperties.jar.basePath 回填），--jars 路径由 basePath + jarPath 组成 */
  basePath?: string;
  createTime: string;
  updateTime: string;
}

interface DependencyListResponse {
  code: number;
  message: string;
  data: {
    records: DependencyRecord[];
    total: number;
    size: number;
    current: number;
    pages: number;
  };
}

export const fetchDependencyList = (params?: { programType?: string }) =>
  request<DependencyListResponse>('/api/devops/dependency/list', {
    params: {
      current: '1',
      size: '10000',
      ...(params?.programType && { programType: params.programType }),
    },
  });

export const fetchDependencyPageList = (
  current = 1,
  size = 10,
  params?: { jarName?: string; source?: string; scope?: string; category?: string; programType?: string }
) =>
  request<DependencyListResponse>('/api/devops/dependency/list', {
    params: {
      current: String(current),
      size: String(size),
      ...(params?.jarName && { jarName: params.jarName }),
      ...(params?.source && { source: params.source }),
      ...(params?.scope && { scope: params.scope }),
      ...(params?.category && { category: params.category }),
      ...(params?.programType && { programType: params.programType }),
    },
  });

export const fetchJarSources = () =>
  request<{ code: number; message: string; data: string[] }>('/api/devops/dependency/sources');

export const fetchJarCategories = () =>
  request<{ code: number; message: string; data: string[] }>('/api/devops/dependency/categories');

export const fetchJarProgramTypes = () =>
  request<{ code: number; message: string; data: string[] }>('/api/devops/dependency/programTypes');

export const createJarDependency = (data: Partial<DependencyRecord>) =>
  request<{ code: number; message: string }>('/api/devops/dependency', {
    method: 'POST',
    body: JSON.stringify(data),
  });

export const updateJarDependency = (data: Partial<DependencyRecord>) =>
  request<{ code: number; message: string }>('/api/devops/dependency', {
    method: 'PUT',
    body: JSON.stringify(data),
  });

export const deleteJarDependency = (id: number) =>
  request<{ code: number; message: string }>(`/api/devops/dependency/${id}`, { method: 'DELETE' });
