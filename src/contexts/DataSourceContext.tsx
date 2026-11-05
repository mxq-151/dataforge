import React, { createContext, useContext, useState, useCallback } from 'react';
import { fetchAllDataSources, fetchTablesByDataSourceId, DataSource, TableInfo, ColumnInfo } from '../api/datasource';
import { useAuth } from './AuthContext';

/** 生成带用户隔离的缓存 key：`${userId}:${datasourceId}` */
function makeCacheKey(userId: number | null | undefined, datasourceId: number): string {
  return `${userId ?? '_anon'}:${datasourceId}`;
}

interface DataSourceCache {
  dataSources: DataSource[];
  tablesMap: Record<string, TableInfo[]>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  getTablesByDataSourceId: (id: number) => TableInfo[];
  /** 按需更新某张表的字段信息（字段懒加载后回写） */
  updateTableColumns: (datasourceId: number, databaseName: string, tableName: string, columns: ColumnInfo[]) => void;
}

const DataSourceContext = createContext<DataSourceCache | null>(null);

export const DataSourceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [tablesMap, setTablesMap] = useState<Record<string, TableInfo[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 当前用户 ID，用于缓存隔离 */
  const currentUserId = user?.id ?? null;

  const loadAllDataSources = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const dsRes = await fetchAllDataSources();

      if (dsRes.code === 200 && dsRes.data) {
        setDataSources(dsRes.data);

        const results = await Promise.allSettled(
          dsRes.data.map(ds => fetchTablesByDataSourceId(ds.id))
        );

        const newTablesMap: Record<string, TableInfo[]> = {};
        dsRes.data.forEach((ds, index) => {
          const result = results[index];
          if (result.status === 'fulfilled' && result.value.code === 200 && result.value.data?.records) {
            newTablesMap[makeCacheKey(currentUserId, ds.id)] = result.value.data.records;
          }
        });

        setTablesMap(newTablesMap);
      }
    } catch (err) {
      console.error('[DataSourceContext] 加载数据源信息失败:', err);
      setError('加载数据源信息失败: ' + (err instanceof Error ? err.message : '未知错误'));
      setDataSources([]);
      setTablesMap({});
    } finally {
      setLoading(false);
    }
  }, [currentUserId]);

  const refresh = useCallback(async () => {
    await loadAllDataSources();
  }, [loadAllDataSources]);

  const getTablesByDataSourceId = useCallback((id: number): TableInfo[] => {
    return tablesMap[makeCacheKey(currentUserId, id)] || [];
  }, [tablesMap, currentUserId]);

  /** 按需更新某张表的字段信息 */
  const updateTableColumns = useCallback((datasourceId: number, databaseName: string, tableName: string, columns: ColumnInfo[]) => {
    const key = makeCacheKey(currentUserId, datasourceId);
    setTablesMap(prev => {
      const tables = prev[key];
      if (!tables) return prev;
      const updated = tables.map(t =>
        t.databaseName === databaseName && t.tableName === tableName
          ? { ...t, columns }
          : t
      );
      return { ...prev, [key]: updated };
    });
  }, [currentUserId]);

  const value: DataSourceCache = {
    dataSources,
    tablesMap,
    loading,
    error,
    refresh,
    getTablesByDataSourceId,
    updateTableColumns,
  };

  return (
    <DataSourceContext.Provider value={value}>
      {children}
    </DataSourceContext.Provider>
  );
};

export const useDataSourceCache = (): DataSourceCache => {
  const context = useContext(DataSourceContext);
  if (!context) {
    throw new Error('useDataSourceCache must be used within a DataSourceProvider');
  }
  return context;
};

export default DataSourceContext;
