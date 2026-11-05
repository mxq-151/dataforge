import { request } from './index';
import type { ApiResponse, PageResult } from './types';

export enum DocType {
  BUSINESS_KNOWLEDGE = 'business_knowledge',
  CLUSTER_OPS = 'cluster_ops',
  DEV_STANDARD = 'dev_standard',
}

export const DOC_TYPE_OPTIONS = [
  { value: DocType.BUSINESS_KNOWLEDGE, label: '业务知识' },
  { value: DocType.CLUSTER_OPS, label: '集群运维' },
  { value: DocType.DEV_STANDARD, label: '开发规范' },
];

export interface KnowledgeDocument {
  id: number;
  title: string;
  docType: DocType;
  category: string;
  content: string;
  authorName?: string;
  authorId?: number;
  status?: number;
  syncToRag?: number;
  viewCount?: number;
  tags?: string;
  description?: string;
  createTime: string;
  updateTime: string;
}

export interface KnowledgeDocumentDTO {
  id?: number;
  title: string;
  docType: DocType;
  category?: string;
  content?: string;
  authorName?: string;
  authorId?: number;
  status?: number;
  tags?: string;
  description?: string;
}

const API_BASE = '/api/knowledge/document';

export const knowledgeApi = {
  async getDocumentList(
    current = 1,
    size = 10,
    params?: { keyword?: string; docType?: DocType }
  ): Promise<ApiResponse<PageResult<KnowledgeDocument>>> {
    const queryParams: Record<string, string> = {
      current: String(current),
      size: String(size),
    };
    if (params?.keyword) queryParams.keyword = params.keyword;
    if (params?.docType) queryParams.docType = params.docType;

    return request<ApiResponse<PageResult<KnowledgeDocument>>>(`${API_BASE}/list`, {
      params: queryParams,
    });
  },

  async createDocument(dto: KnowledgeDocumentDTO): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>(`${API_BASE}`, {
      method: 'POST',
      body: JSON.stringify(dto),
    });
  },

  async updateDocument(dto: KnowledgeDocumentDTO): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>(`${API_BASE}`, {
      method: 'PUT',
      body: JSON.stringify(dto),
    });
  },

  async deleteDocument(id: number): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>(`${API_BASE}/${id}`, {
      method: 'DELETE',
    });
  },

  async incrementViewCount(id: number): Promise<ApiResponse<void>> {
    return request<ApiResponse<void>>(`${API_BASE}/${id}/view`, {
      method: 'POST',
    });
  },
};
