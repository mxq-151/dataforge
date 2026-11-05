import React, { useEffect, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { fetchTableColumns, fetchTableMetadata, TableDetailColumn } from '../../api/datasource';
import { useDataSourceCache } from '../../contexts/DataSourceContext';
import TableDetailContent from './TableDetailContent';
import type { TableDetailColumnItem, TableDetailData } from './TableDetailContent';
import './TableDetail.css';

/** 接口字段（0/1）→ 展示字段（布尔），与资产目录对齐同一份渲染输入 */
function toColumnItem(column: TableDetailColumn): TableDetailColumnItem {
  return {
    id: column.id,
    columnName: column.columnName,
    columnType: column.columnType || '',
    columnComment: column.columnComment || '',
    isPartition: column.isPartition === 1,
    isPrimaryKey: column.isPrimaryKey === 1,
    nullable: column.nullable === 1,
  };
}

interface TableDetailProps {
  datasourceId: number | null;
  storageEngine: string;
  databaseName: string;
  tableName: string;
  onClose: () => void;
}

const TableDetailView: React.FC<TableDetailProps> = ({ datasourceId, storageEngine, databaseName, tableName, onClose }) => {
  const { dataSources, updateTableColumns } = useDataSourceCache();
  const [detail, setDetail] = useState<TableDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!datasourceId || !storageEngine || !databaseName || !tableName) {
      setDetail(null);
      return;
    }

    const loadDetail = async () => {
      setLoading(true);
      setError(null);
      try {
        const [columnsRes, metadataRes] = await Promise.all([
          fetchTableColumns(storageEngine, databaseName, tableName),
          fetchTableMetadata(datasourceId, databaseName, tableName),
        ]);

        const columns = (columnsRes && Array.isArray(columnsRes.data)) ? columnsRes.data : [];
        const tableMeta = (metadataRes?.code === 200 && metadataRes.data?.records?.length > 0)
          ? metadataRes.data.records[0]
          : null;

        if (columns.length === 0 && !tableMeta) {
          setError('未获取到表详情数据');
          return;
        }

        const sortedColumns = columns.slice().sort((a, b) => (a.ordinalPosition || 0) - (b.ordinalPosition || 0));

        // 将字段信息回写到上下文，供 SQL 补全使用（上下文沿用接口原始形态）
        if (sortedColumns.length > 0) {
          const matchedDS = dataSources.find(ds => {
            const dsDbNames = ds.databaseName || [];
            return dsDbNames.some(n => n.toLowerCase() === databaseName.toLowerCase());
          });
          if (matchedDS) {
            updateTableColumns(matchedDS.id, databaseName, tableName, sortedColumns);
          }
        }

        // 展示层统一映射为 TableDetailData，与资产目录共用同一份渲染
        const tableInfo: TableDetailData = {
          storageEngine: tableMeta?.storageEngine || columns[0]?.storageEngine || storageEngine,
          storageFormat: tableMeta?.storageFormat || '',
          compression: tableMeta?.compression ?? null,
          tableComment: tableMeta?.tableComment || '',
          location: tableMeta?.location || '',
          hotDays: tableMeta?.hotDays ?? 90,
          coldDays: tableMeta?.coldDays ?? 180,
          keepDays: tableMeta?.keepDays ?? 720,
          columns: sortedColumns.map(toColumnItem),
        };

        setDetail(tableInfo);
      } catch (err) {
        setError('加载表详情失败');
        console.error('Failed to fetch table detail:', err);
      } finally {
        setLoading(false);
      }
    };

    loadDetail();
  }, [datasourceId, storageEngine, databaseName, tableName, dataSources, updateTableColumns]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && datasourceId && storageEngine && databaseName) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [datasourceId, storageEngine, databaseName, onClose]);

  if (!datasourceId || !storageEngine || !databaseName || !tableName) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="table-detail-modal" onClick={handleOverlayClick}>
      <div className="table-detail-modal__container">
        <header className="table-detail-modal__header">
          <h3 className="table-detail-modal__title" title={`${databaseName}.${tableName}`}>{databaseName}.{tableName}</h3>
          <button className="table-detail-modal__close-btn" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="table-detail-modal__body">
          {loading && (
            <div className="table-detail-modal__loading">
              <Loader2 size={24} className="table-detail-modal__spinner" />
              <span>加载中...</span>
            </div>
          )}

          {error && <div className="table-detail-modal__error">{error}</div>}

          {detail && !loading && <TableDetailContent detail={detail} />}
        </div>
      </div>
    </div>
  );
};

export default TableDetailView;
