/**
 * 统一日志访问层接口封装（dataforge-server /logs/*）。
 *
 * 所有日志都必须经 dataforge-server：前端不再直连 DolphinScheduler 的 /log/detail，
 * 也不访问 Spark / YARN 的日志文件或接口。服务端 context-path 为 /api，
 * 控制器声明不含 /api 前缀，因此这里统一写 /api/logs/...
 */

import { request } from './index';
import type { ApiResponse } from './types';

export interface LogSourceVO {
  id: string;
  name: string;
  serviceType: string;
  cluster: string;
  enabled: boolean;
  disabledReason?: string;
  baseUrlConfigured?: boolean;
  roles: string[];
  logKinds: string[];
}

export interface LogQueryParams {
  sourceId?: string;
  serviceType?: string;
  cluster?: string;
  componentRole?: string;
  logKind?: string;
  ref?: Record<string, string>;
  timeRange?: { start?: string; end?: string };
  keyword?: string;
  cursor?: string;
  limit?: number;
  maxBytes?: number;
}

export interface LogQueryResultVO {
  sourceId: string;
  serviceType: string;
  cluster: string;
  componentRole: string;
  logKind: string;
  content: string;
  lines: string[];
  lineCount: number;
  byteSize: number;
  nextCursor?: string;
  hasMore: boolean;
  truncated: boolean;
  degraded: boolean;
  degradationReason?: string;
  errorCode?: string;
  resolvedHost?: string;
  resolvedPath?: string;
  elapsedMs: number;
  message?: string;
}

export interface LogChainSegment {
  sourceId?: string;
  serviceType?: string;
  cluster?: string;
  componentRole?: string;
  logKind?: string;
  ref?: Record<string, string>;
  keyword?: string;
}

export interface LogChainRequest {
  sourceId?: string;
  serviceType?: string;
  cluster?: string;
  maxBytes?: number;
  segments: LogChainSegment[];
}

export interface LogChainSegmentVO {
  index: number;
  sourceId?: string;
  serviceType?: string;
  componentRole?: string;
  logKind?: string;
  status: string;
  content: string;
  lineCount: number;
  byteSize: number;
  degraded: boolean;
  errorCode?: string;
  message?: string;
}

export interface LogChainResultVO {
  segments: LogChainSegmentVO[];
  totalBytes: number;
  truncated: boolean;
}

/** 已配置的日志源（未配置地址的源 enabled=false，并带 disabledReason） */
export function getLogSources(): Promise<ApiResponse<LogSourceVO[]>> {
  return request<ApiResponse<LogSourceVO[]>>('/api/logs/sources', { suppressError: true });
}

/** 统一检索（不透明游标分页） */
export function queryLogs(params: LogQueryParams): Promise<ApiResponse<LogQueryResultVO>> {
  return request<ApiResponse<LogQueryResultVO>>('/api/logs/query', {
    method: 'POST',
    body: JSON.stringify(params),
    suppressError: true,
  });
}

/** 跨服务串联（DS 任务日志 -> YARN 聚合日志 -> Spark driver 日志） */
export function queryLogChain(body: LogChainRequest): Promise<ApiResponse<LogChainResultVO>> {
  return request<ApiResponse<LogChainResultVO>>('/api/logs/chain', {
    method: 'POST',
    body: JSON.stringify(body),
    suppressError: true,
  });
}
