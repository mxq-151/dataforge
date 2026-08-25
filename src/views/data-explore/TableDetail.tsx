import React, { useEffect, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { fetchTableColumns, fetchTableMetadata, TableDetailColumn } from '../../api/datasource';
import { useDataSourceCache } from '../../contexts/DataSourceContext';
import './TableDetail.css';

interface TableDetailProps {
  datasourceId: number | null;
  storageEngine: string;
  databaseName: string;
  tableName: string;
  onClose: () => void;
}

interface ProcessedTableData {
  databaseName: string;
  tableName: string;
  tableComment?: string;
  storageEngine: string;
  storageFormat: string;
  compression: string | null;
  location: string;
  hotDays: number;
  coldDays: number;
  keepDays: number;
  columns: TableDetailColumn[];
}

const TableDetailView: React.FC<TableDetailProps> = ({ datasourceId, storageEngine, databaseName, tableName, onClose }) => {
  const { dataSources, updateTableColumns } = useDataSourceCache();
  const [detail, setDetail] = useState<ProcessedTableData | null>(null);
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

        const sortedColumns = columns.sort((a, b) => (a.ordinalPosition || 0) - (b.ordinalPosition || 0));

        // 将字段信息回写到上下文，供 SQL 补全使用
        if (sortedColumns.length > 0) {
          const matchedDS = dataSources.find(ds => {
            const dsDbNames = ds.databaseName || [];
            return dsDbNames.some(n => n.toLowerCase() === databaseName.toLowerCase());
          });
          if (matchedDS) {
            updateTableColumns(matchedDS.id, databaseName, tableName, sortedColumns);
          }
        }

        const tableInfo: ProcessedTableData = {
          databaseName: tableMeta?.databaseName || columns[0]?.databaseName || databaseName,
          tableName: tableMeta?.tableName || columns[0]?.tableName || tableName,
          tableComment: tableMeta?.tableComment || '',
          storageEngine: tableMeta?.storageEngine || columns[0]?.storageEngine || storageEngine,
          storageFormat: tableMeta?.storageFormat || '',
          compression: tableMeta?.compression ?? null,
          location: tableMeta?.location || '',
          hotDays: tableMeta?.hotDays ?? 90,
          coldDays: tableMeta?.coldDays ?? 180,
          keepDays: tableMeta?.keepDays ?? 720,
          columns: sortedColumns,
        };

        console.log('Processed table data:', tableInfo);
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

          {detail && !loading && (
            <>
              <section className="table-detail-modal__info">
                <div className="table-detail-modal__info-row">
                  <div className="table-detail-modal__info-item">
                    <span className="table-detail-modal__label">存储引擎</span>
                    <span className="table-detail-modal__value">{detail.storageEngine || '-'}</span>
                  </div>
                  <div className="table-detail-modal__info-item">
                    <span className="table-detail-modal__label">存储格式</span>
                    <span className="table-detail-modal__value">{detail.storageFormat || '-'}</span>
                  </div>
                  <div className="table-detail-modal__info-item">
                    <span className="table-detail-modal__label">压缩方式</span>
                    <span className="table-detail-modal__value">{detail.compression ?? '-'}</span>
                  </div>
                  <div className="table-detail-modal__info-item">
                    <span className="table-detail-modal__label">表注释</span>
                    <span className="table-detail-modal__value">{detail.tableComment || '-'}</span>
                  </div>
                </div>

                <div className="table-detail-modal__info-row">
                  <div className="table-detail-modal__info-item">
                    <span className="table-detail-modal__label">热数据天数</span>
                    <span className="table-detail-modal__value">{detail.hotDays}</span>
                  </div>
                  <div className="table-detail-modal__info-item">
                    <span className="table-detail-modal__label">冷数据天数</span>
                    <span className="table-detail-modal__value">{detail.coldDays}</span>
                  </div>
                  <div className="table-detail-modal__info-item">
                    <span className="table-detail-modal__label">保留天数</span>
                    <span className="table-detail-modal__value">{detail.keepDays}</span>
                  </div>
                  <div className="table-detail-modal__info-item">
                    <span className="table-detail-modal__label">存储位置</span>
                    <span className="table-detail-modal__value table-detail-modal__value--truncate" title={detail.location || ''}>{detail.location || '-'}</span>
                  </div>
                </div>
              </section>

              <section className="table-detail-modal__columns">
                <h4 className="table-detail-modal__columns-title">字段结构</h4>
                {detail.columns && detail.columns.length > 0 ? (
                  <div className="table-detail-modal__columns-table-wrapper">
                    <div className="table-detail-modal__columns-scroll-container">
                      <table className="table-detail-modal__columns-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>字段名</th>
                          <th>类型</th>
                          <th>注释</th>
                          <th>分区</th>
                          <th>主键</th>
                          <th>可空</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.columns.map((column, index) => (
                          <tr key={column.id || index}>
                            <td>{index + 1}</td>
                            <td>{column.columnName}</td>
                            <td>{column.columnType || '-'}</td>
                            <td className="table-detail-modal__column-comment">{column.columnComment || '-'}</td>
                            <td>{column.isPartition === 1 ? '是' : ''}</td>
                            <td>{column.isPrimaryKey === 1 ? '是' : ''}</td>
                            <td>{column.nullable === 1 ? '是' : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                  </div>
                ) : (
                  <div className="table-detail-modal__empty-columns">暂无字段信息</div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default TableDetailView;
