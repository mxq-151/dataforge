import { request } from './index';
import type { ApiResponse, PageResult } from './types';

export interface DataSource {
  id: number;
  datasourceName: string;
  datasourceType?: string;
  connectionType?: string;
  storageEngine?: string;
  url?: string;
  databaseName?: string[];
  username?: string;
  extraParams?: string;
  connectionStatus?: number;
  lastTestTime?: string;
  description?: string;
}

export interface TableInfo {
  id?: number;
  datasourceId?: number;
  storageEngine?: string;
  databaseName?: string;
  tableName: string;
  tableType?: string;
  tableComment?: string;
  storageFormat?: string;
  compression?: string | null;
  location?: string;
  rowCount?: number | null;
  sizeBytes?: number | null;
  hotDays?: number;
  coldDays?: number;
  keepDays?: number;
  columns?: ColumnInfo[];
}

export interface ColumnInfo {
  columnName: string;
  columnType?: string;
  columnComment?: string;
  isPartition?: number;
  isPrimaryKey?: number;
  nullable?: number;
  defaultValue?: string | null;
  ordinalPosition?: number;
}

export interface TableDetailColumn extends ColumnInfo {
  id?: number;
  tableMetadataId?: number;
  storageEngine?: string;
  databaseName?: string;
  tableName?: string;
  storageFormat?: string;
  compression?: string | null;
  location?: string;
  rowCount?: number | null;
  sizeBytes?: number | null;
  hotDays?: number;
  coldDays?: number;
  keepDays?: number;
  syncTime?: string;
  createTime?: string;
  updateTime?: string;
}

export const fetchAllDataSources = () =>
  request<ApiResponse<DataSource[]>>('/api/devops/datasource/all');

export const fetchDatasourceList = (current = 1, size = 10) =>
  request<ApiResponse<PageResult<DataSource>>>('/api/devops/datasource/list', {
    params: { current: String(current), size: String(size) },
  });

export const fetchDatasourceTypes = () =>
  request<ApiResponse<string[]>>('/api/devops/datasource/types');

export const fetchConnectionTypes = () =>
  request<ApiResponse<string[]>>('/api/devops/datasource/connection-types');

export const createDatasource = (data: Partial<DataSource>) =>
  request<ApiResponse<void>>('/api/devops/datasource', {
    method: 'POST',
    body: JSON.stringify(data),
  });

export const updateDatasource = (data: Partial<DataSource>) =>
  request<ApiResponse<void>>('/api/devops/datasource', {
    method: 'PUT',
    body: JSON.stringify(data),
  });

export const deleteDatasource = (id: number) =>
  request<ApiResponse<void>>(`/api/devops/datasource/${id}`, { method: 'DELETE' });

export const testDatasourceConnectionByConfig = (data: Partial<DataSource>, id?: number) =>
  request<ApiResponse<{ success: boolean; message: string; costTime?: string }>>('/api/devops/datasource/test', {
    method: 'POST',
    body: JSON.stringify(data),
    ...(id ? { params: { id: String(id) } } : {}),
  });

export const syncDatasourceMetadata = (id: number) =>
  request<ApiResponse<void>>(`/api/devops/datasource/${id}/sync-metadata`, { method: 'POST' });

export const fetchTablesByDataSourceId = (datasourceId: number, current = 1, size = 10000) =>
  request<ApiResponse<PageResult<TableInfo>>>('/api/metadata/tables', {
    params: { current: current.toString(), size: size.toString(), datasourceId: datasourceId.toString() },
  });

export const fetchTableColumns = (storageEngine: string, databaseName: string, tableName: string) =>
  request<ApiResponse<TableDetailColumn[]>>('/api/metadata/table/columns', {
    params: { storageEngine, databaseName, tableName },
  });

export const fetchTableMetadata = (datasourceId: number, databaseName: string, tableName: string) =>
  request<ApiResponse<PageResult<TableInfo>>>('/api/metadata/tables', {
    params: { current: '1', size: '1', datasourceId: datasourceId.toString(), databaseName, tableName },
  });

export const fetchDatabasesByDatasourceConfig = (data: Partial<DataSource>) =>
  request<ApiResponse<string[]>>('/api/devops/datasource/databases', {
    method: 'POST',
    body: JSON.stringify(data),
  });
