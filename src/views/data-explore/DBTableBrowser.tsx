import React, { useState, useCallback, useMemo } from 'react';
import {
  Database,
  Table2,
  RefreshCw,
  ChevronRight,
  ChevronLeft,
  Search,
  Columns3,
} from 'lucide-react';
import { useDataSourceCache } from '../../contexts/DataSourceContext';
import './DBTableBrowser.css';

interface DBTableBrowserProps {
  dataSourceId?: number | null;
  onTableSelect?: (schemaName: string, tableName: string) => void;
  onTableDetail?: (datasourceId: number, storageEngine: string, databaseName: string, tableName: string) => void;
}

const DBTableBrowser: React.FC<DBTableBrowserProps> = ({ dataSourceId, onTableSelect, onTableDetail }) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [expandedTables, _setExpandedTables] = useState<Set<string>>(new Set());
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [searchValue, setSearchValue] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  const { dataSources, getTablesByDataSourceId, loading, refresh } = useDataSourceCache();

  const handleToggle = () => {
    setIsCollapsed(!isCollapsed);
  };

  const handleSchemaToggle = useCallback((schemaName: string) => {
    setExpandedSchemas(prev => {
      const newSet = new Set(prev);
      if (newSet.has(schemaName)) {
        newSet.delete(schemaName);
      } else {
        newSet.add(schemaName);
      }
      return newSet;
    });
  }, []);

  const handleTableClick = useCallback((datasourceId: number, schemaName: string, tableName: string, tableKey: string, table?: any) => {
    console.log('Table clicked:', { datasourceId, schemaName, tableName, tableKey, table });
    setSelectedTable(tableKey);
    if (onTableDetail && table) {
      onTableDetail(datasourceId, table.storageEngine || '', schemaName, tableName);
    } else {
      console.warn('No table or onTableDetail callback');
    }
    onTableSelect?.(schemaName, tableName);
  }, [onTableSelect, onTableDetail]);

  const handleSearchToggle = useCallback(() => {
    setIsSearching(prev => !prev);
    if (isSearching) {
      setSearchValue('');
    }
  }, [isSearching]);

  const filteredDataSources = useMemo(() => {
    let sources = dataSources;

    if (dataSourceId) {
      sources = sources.filter(ds => ds.id === dataSourceId);
    }

    if (!searchValue) return sources;

    return sources
      .map(ds => {
        const tables = getTablesByDataSourceId(ds.id).filter((t: any) =>
          t.tableName.toLowerCase().includes(searchValue.toLowerCase()) ||
          (t.tableComment && t.tableComment.toLowerCase().includes(searchValue.toLowerCase()))
        );
        return { ...ds, _filteredTables: tables };
      })
      .filter(ds => (ds._filteredTables as any[]).length > 0);
  }, [dataSources, getTablesByDataSourceId, searchValue, dataSourceId]);

  return (
    <aside className={`db-table-browser ${isCollapsed ? 'db-table-browser--collapsed' : ''}`}>
      <header className={`db-table-browser__header ${isCollapsed ? 'db-table-browser__header--collapsed' : ''}`}>
        {isCollapsed ? (
          <button
            className="db-table-browser__expand-btn"
            title="展开库表浏览器"
            onClick={handleToggle}
          >
            <ChevronLeft size={18} />
          </button>
        ) : (
          <>
            <div className="db-table-browser__title">
              <Database size={16} className="db-table-browser__icon" />
              <span>库表浏览器</span>
            </div>
            <div className="db-table-browser__actions">
              <button
                className="db-table-browser__action-btn"
                title="搜索表"
                onClick={handleSearchToggle}
              >
                <Search size={14} />
              </button>
              <button
                className="db-table-browser__action-btn"
                title="刷新"
                onClick={refresh}
              >
                <RefreshCw size={14} />
              </button>
              <button
                className="db-table-browser__action-btn"
                title="折叠"
                onClick={handleToggle}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </>
        )}
      </header>

      {!isCollapsed && (
        <>
          {isSearching && (
            <div className="db-table-browser__search-wrapper">
              <Search size={14} className="db-table-browser__search-icon" />
              <input
                type="text"
                className="db-table-browser__search-input"
                value={searchValue}
                onChange={(e) => setSearchValue(e.target.value)}
                placeholder="搜索表名或注释..."
                autoFocus
              />
            </div>
          )}

          <div className="db-table-browser__content">
            {loading ? (
              <div className="db-table-browser__loading">加载数据源信息...</div>
            ) : filteredDataSources.length === 0 ? (
              <div className="db-table-browser__empty">暂无数据源</div>
            ) : (
              filteredDataSources.map((ds: any) => {
                const tables = (ds._filteredTables || getTablesByDataSourceId(ds.id) || []);

                const groupedByDatabase: Record<string, any[]> = {};
                tables.forEach((table: any) => {
                  const dbName = table.databaseName || ds.datasourceName;
                  if (!groupedByDatabase[dbName]) groupedByDatabase[dbName] = [];
                  groupedByDatabase[dbName].push(table);
                });

                return Object.entries(groupedByDatabase).map(([actualDatabaseName, dbTables]) => (
                  <div key={`${ds.id}-${actualDatabaseName}`} className="db-table-browser__schema">
                    <div
                      className="db-table-browser__schema-header"
                      onClick={() => handleSchemaToggle(actualDatabaseName)}
                    >
                      <span className="db-table-browser__toggle">
                        {expandedSchemas.has(actualDatabaseName) ? <ChevronRight size={14} className="db-table-browser__toggle--expanded" /> : <ChevronRight size={14} />}
                      </span>
                      <Database size={14} className="db-table-browser__schema-icon" />
                      <span className="db-table-browser__schema-name">{actualDatabaseName}</span>
                      <span className="db-table-browser__schema-count">{dbTables.length}</span>
                    </div>

                    {expandedSchemas.has(actualDatabaseName) && (
                      <div className="db-table-browser__tables">
                        {dbTables.map((table: any) => {
                          const tableKey = `${actualDatabaseName}.${table.tableName}`;
                          const isExpanded = expandedTables.has(tableKey);
                          const isSelected = selectedTable === tableKey;

                          return (
                            <div key={table.tableName} className="db-table-browser__table">
                              <div
                                className={`db-table-browser__table-header ${isSelected ? 'db-table-browser__table-header--selected' : ''}`}
                                onClick={() => handleTableClick(ds.id, actualDatabaseName, table.tableName, tableKey, table)}
                              >
                                <span className="db-table-browser__toggle">
                                  {isExpanded ? <ChevronRight size={12} className="db-table-browser__toggle--expanded" /> : <ChevronRight size={12} />}
                                </span>
                                <Table2 size={14} className="db-table-browser__table-icon" />
                                <span className="db-table-browser__table-name" title={table.tableName}>{table.tableName}</span>
                              </div>

                              {isExpanded && table.columns && table.columns.length > 0 && (
                                <div className="db-table-browser__columns">
                                  {table.columns.map((column: any) => (
                                    <div key={column.columnName} className="db-table-browser__column">
                                      <span className="db-table-browser__column-icon">
                                        <Columns3 size={12} />
                                      </span>
                                      <span className="db-table-browser__column-name">{column.columnName}</span>
                                      <span className="db-table-browser__column-type">{column.columnType || '-'}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ));
              })
            )}
          </div>

          <footer className="db-table-browser__footer">
            <span className="db-table-browser__footer-text">
              {dataSources.reduce((acc, ds) => acc + getTablesByDataSourceId(ds.id).length, 0)} 张表 · {dataSources.length} 个数据源
            </span>
          </footer>
        </>
      )}
    </aside>
  );
};

export default DBTableBrowser;
