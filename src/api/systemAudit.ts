import { request, getAuthToken, getApiHost } from './index';
import type { ApiResponse, PageResult } from './types';

export interface AuditLog {
  id: number;
  userId: number;
  username: string;
  tenantName: string;
  module: string;
  operation: string;
  operationType: string;
  targetType: string;
  targetId: number;
  targetName: string;
  requestMethod: string;
  requestUrl: string;
  requestParams: string;
  responseStatus: number;
  errorMessage: string;
  ipAddress: string;
  userAgent: string;
  operationTime: string;
  durationMs: number;
  isSensitive: number;
  isAiRequest: number;
}

export interface AuditStatistics {
  totalOperations: number;
  sensitiveOperations: number;
  errorOperations: number;
  todayOperations: number;
  weekOperations: number;
  avgDurationMs: number;
}

interface AuditLogListParams {
  current?: number;
  size?: number;
  module?: string;
  operation?: string;
  username?: string;
  operationType?: string;
  isSensitive?: number;
  startTime?: string;
  endTime?: string;
}

interface AuditLogExportParams {
  module?: string;
  operation?: string;
  username?: string;
  operationType?: string;
  isSensitive?: number;
  startTime?: string;
  endTime?: string;
}

export const systemAuditApi = {
  async getAuditLogList(params: AuditLogListParams): Promise<ApiResponse<PageResult<AuditLog>>> {
    const qs: Record<string, string> = {};
    if (params.current !== undefined) qs.current = String(params.current);
    if (params.size !== undefined) qs.size = String(params.size);
    if (params.module) qs.module = params.module;
    if (params.operation) qs.operation = params.operation;
    if (params.username) qs.username = params.username;
    if (params.operationType) qs.operationType = params.operationType;
    if (params.isSensitive !== undefined) qs.isSensitive = String(params.isSensitive);
    if (params.startTime) qs.startTime = params.startTime;
    if (params.endTime) qs.endTime = params.endTime;
    return request<ApiResponse<PageResult<AuditLog>>>('/api/system/audit-log/list', { params: qs });
  },

  async getAuditLogDetail(id: number): Promise<ApiResponse<AuditLog>> {
    return request<ApiResponse<AuditLog>>(`/api/system/audit-log/${id}`);
  },

  async getAuditModules(): Promise<ApiResponse<string[]>> {
    return request<ApiResponse<string[]>>('/api/system/audit-log/modules');
  },

  async getAuditOperations(): Promise<ApiResponse<string[]>> {
    return request<ApiResponse<string[]>>('/api/system/audit-log/operations');
  },

  async getAuditOperationTypes(): Promise<ApiResponse<string[]>> {
    return request<ApiResponse<string[]>>('/api/system/audit-log/operation-types');
  },

  async getAuditStatistics(params?: { startTime?: string; endTime?: string }): Promise<ApiResponse<AuditStatistics>> {
    const qs: Record<string, string> = {};
    if (params?.startTime) qs.startTime = params.startTime;
    if (params?.endTime) qs.endTime = params.endTime;
    return request<ApiResponse<AuditStatistics>>('/api/system/audit-log/statistics', { params: qs });
  },

  async exportAuditLogs(params: AuditLogExportParams): Promise<void> {
    const qs: Record<string, string> = {};
    if (params.module) qs.module = params.module;
    if (params.operation) qs.operation = params.operation;
    if (params.username) qs.username = params.username;
    if (params.operationType) qs.operationType = params.operationType;
    if (params.isSensitive !== undefined) qs.isSensitive = String(params.isSensitive);
    if (params.startTime) qs.startTime = params.startTime;
    if (params.endTime) qs.endTime = params.endTime;

    const token = await getAuthToken();
    const queryStr = Object.entries(qs)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');

    const fetchUrl = `${getApiHost()}/api/system/audit-log/export${queryStr ? `?${queryStr}` : ''}`;

    try {
      const res = await fetch(fetchUrl, {
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const contentDisposition = res.headers.get('Content-Disposition');
      let filename = `audit_log_${new Date().toISOString().slice(0, 10)}.csv`;
      if (contentDisposition) {
        const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?(.+)/i);
        if (match) filename = decodeURIComponent(match[1].replace(/["']/g, ''));
      }
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      console.error('导出审计日志失败:', e);
      throw e;
    }
  },

  async cleanupOldLogs(days?: number): Promise<ApiResponse<number>> {
    const qs: Record<string, string> = {};
    if (days !== undefined) qs.days = String(days);
    return request<ApiResponse<number>>('/api/system/audit-log/cleanup', { method: 'DELETE', params: qs });
  },
};
