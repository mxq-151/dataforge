import { request, getApiHost, getAuthToken } from './index';
import { bearerHeader, ensureOk } from './httpCore';
import type { ApiResponse, PageResult } from './types';

export interface StorageConfig {
  id: number;
  storageName: string;
  storageType: string;
  endpoint: string;
  bucketName: string;
  rootPath: string;
  localMountPath: string;
  extraParams: string;
  status: number;
  createTime: string;
  updateTime: string;
}

export interface FileInfo {
  name: string;
  isDir: boolean;
  size: number;
  modifiedTime: string;
  permissions: string;
  path: string;
}

const API_BASE = '/api';

export const fileExplorerApi = {
  async getStorageConfigList(current = 1, size = 100): Promise<ApiResponse<PageResult<StorageConfig>>> {
    return request<ApiResponse<PageResult<StorageConfig>>>(`${API_BASE}/devops/storage/list`, {
      params: { current: String(current), size: String(size) },
    });
  },

  async getAllStorages(): Promise<ApiResponse<StorageConfig[]>> {
    return request<ApiResponse<StorageConfig[]>>(`${API_BASE}/devops/storage/all`);
  },

  async listFiles(storageType: string, path: string, configId?: number): Promise<ApiResponse<FileInfo[]>> {
    const params: Record<string, string> = { storageType, path };
    if (configId) params.configId = String(configId);
    return request<ApiResponse<FileInfo[]>>(`${API_BASE}/file/explorer/list`, { params });
  },

  async createDirectory(storageType: string, parentPath: string, name: string, configId?: number): Promise<ApiResponse<void>> {
    const params: Record<string, string> = { storageType, parentPath, name };
    if (configId) params.configId = String(configId);
    return request<ApiResponse<void>>(`${API_BASE}/file/explorer/directory`, {
      method: 'POST',
      params,
    });
  },

  async deleteFile(storageType: string, path: string, configId?: number): Promise<ApiResponse<void>> {
    const params: Record<string, string> = { storageType, path };
    if (configId) params.configId = String(configId);
    return request<ApiResponse<void>>(`${API_BASE}/file/explorer/file`, {
      method: 'DELETE',
      params,
    });
  },

  async renameFile(storageType: string, path: string, newName: string, configId?: number): Promise<ApiResponse<void>> {
    const params: Record<string, string> = { storageType, path, newName };
    if (configId) params.configId = String(configId);
    return request<ApiResponse<void>>(`${API_BASE}/file/explorer/file`, {
      method: 'PUT',
      params,
    });
  },

  async uploadFile(storageType: string, path: string, file: File, configId?: number): Promise<ApiResponse<void>> {
    const formData = new FormData();
    formData.append('file', file);

    let url = `${getApiHost()}${API_BASE}/file/explorer/file/upload?storageType=${encodeURIComponent(storageType)}&path=${encodeURIComponent(path)}`;
    if (configId) url += `&configId=${configId}`;

    const headers = bearerHeader(await getAuthToken());

    const res = await fetch(url, {
      method: 'POST',
      body: formData,
      headers,
    });

    ensureOk(res);
    return res.json();
  },

  async previewFile(storageType: string, path: string, configId?: number): Promise<Blob> {
    const params: Record<string, string> = { storageType, path };
    if (configId) params.configId = String(configId);

    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    const url = `${getApiHost()}${API_BASE}/file/explorer/file/preview?${qs}`;
    const headers = bearerHeader(await getAuthToken());
    const res = await fetch(url, { headers });

    ensureOk(res);
    return res.blob();
  },

  async downloadFile(storageType: string, path: string, configId?: number): Promise<Blob> {
    const params: Record<string, string> = { storageType, path };
    if (configId) params.configId = String(configId);

    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    const url = `${getApiHost()}${API_BASE}/file/explorer/file/download?${qs}`;
    const headers = bearerHeader(await getAuthToken());
    const res = await fetch(url, { headers });

    ensureOk(res);
    return res.blob();
  },

  async createStorage(data: Partial<StorageConfig>): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>(`${API_BASE}/devops/storage`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateStorage(data: Partial<StorageConfig>): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>(`${API_BASE}/devops/storage`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  async deleteStorage(id: number): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>(`${API_BASE}/devops/storage/${id}`, { method: 'DELETE' });
  },

  async testStorageConnection(id: number): Promise<ApiResponse<{ success: boolean; message: string }>> {
    return request<ApiResponse<{ success: boolean; message: string }>>(`${API_BASE}/devops/storage/${id}/test`, { method: 'POST' });
  },

  async getStorageTypeOptions(): Promise<ApiResponse<string[]>> {
    return request<ApiResponse<string[]>>(`${API_BASE}/devops/storage/types`);
  },
};
