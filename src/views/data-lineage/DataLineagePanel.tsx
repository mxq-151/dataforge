import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Search, GitBranch, Database, Cog, FileText, RefreshCw, ChevronDown, X, Loader2, AlertCircle, Layers, Columns3 } from 'lucide-react';
import type { Lineage, SearchResult, NodeType, DatasetData, JobData, ColumnLineageNodeData, DatasetField } from '../../types/marquez';
import { createMarquezApi } from '../../api/marquez';
import { fetchProjectList, type ProjectInfo } from '../../api/devProject';
import { useToast } from '../../components/Toast';
import LineageGraph from './LineageGraph';
import { shouldHideNode } from './lineageFilter';
import './DataLineagePanel.css';

interface DataLineagePanelProps {
  marquezApiUrl: string;
  /** 外部跳转目标（如从指标管理关联字段跳入），设置后自动按表名搜索并定位首个数据集结果 */
  jumpTarget?: LineageJumpTarget | null;
}

/** 数据血缘跳转目标：命名空间（项目编码）+ 数据集名（表名） */
export interface LineageJumpTarget {
  namespace: string;
  datasetName: string;
}

type LineageMode = 'dataset' | 'column';

function isDatasetData(data: unknown): data is DatasetData {
  return typeof data === 'object' && data !== null && 'physicalName' in data;
}

function isJobData(data: unknown): data is JobData {
  return typeof data === 'object' && data !== null && 'inputs' in data;
}

function isColumnLineageData(data: unknown): data is ColumnLineageNodeData {
  return typeof data === 'object' && data !== null && 'fieldType' in data;
}

function parseNodeId(nodeId: string): { type: string; namespace: string; name: string; field?: string } | null {
  const parts = nodeId.split(':');
  if (parts.length < 3) return null;

  const [type, namespace, name, field] = parts;
  if (type === 'datasetField') {
    if (!field) return null;
    return { type, namespace, name, field };
  }
  if (type === 'dataset' || type === 'job') {
    return { type, namespace, name };
  }
  return null;
}

const DataLineagePanel: React.FC<DataLineagePanelProps> = ({ marquezApiUrl, jumpTarget }) => {
  const api = useMemo(() => createMarquezApi(marquezApiUrl), [marquezApiUrl]);
  const toast = useToast();

  const [lineageMode, setLineageMode] = useState<LineageMode>('dataset');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selectedNamespace, setSelectedNamespace] = useState('');
  const [showNamespaceDropdown, setShowNamespaceDropdown] = useState(false);

  const [lineage, setLineage] = useState<Lineage | null>(null);
  const [isLoadingLineage, setIsLoadingLineage] = useState(false);
  const [lineageError, setLineageError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string>('');
  const [depth, setDepth] = useState(20);
  const [withDownstream, setWithDownstream] = useState(false);

  const [selectedNodeDetail, setSelectedNodeDetail] = useState<{
    id: string;
    type: NodeType;
    data: DatasetData | JobData | ColumnLineageNodeData | null;
  } | null>(null);

  const [availableFields, setAvailableFields] = useState<DatasetField[]>([]);
  const [selectedField, setSelectedField] = useState<string>('');
  const [showFieldSelector, setShowFieldSelector] = useState(false);
  const [isLoadingFields, setIsLoadingFields] = useState(false);
  const [fallbackToDatasetLevel, setFallbackToDatasetLevel] = useState(false);

  useEffect(() => {
    fetchProjectList({ size: 200 })
      .then(res => setProjects(res.data.records || []))
      .catch(() => {});
  }, []);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    if (!selectedNamespace) {
      toast.warning('请先选择项目编码');
      return;
    }
    setIsSearching(true);
    setShowResults(true);
    try {
      const res = await api.search.query(searchQuery.trim(), undefined, undefined, 20, selectedNamespace || undefined);
      // 过滤节点ID以 .deserialize_to_object 结尾的搜索结果
      setSearchResults((res.results || []).filter(r => !r.nodeId.endsWith('.deserialize_to_object')));
    } catch (e: any) {
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [api, searchQuery, selectedNamespace]);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  }, [handleSearch]);

  const loadDatasetFields = useCallback(async (namespace: string, datasetName: string) => {
    setIsLoadingFields(true);
    try {
      const dataset = await api.datasets.get(namespace, datasetName);
      if (dataset.fields && dataset.fields.length > 0) {
        setAvailableFields(dataset.fields);
        setSelectedField(dataset.fields[0].name);
        return true;
      }
      setAvailableFields([]);
      return false;
    } catch (e: any) {
      console.error('Failed to load dataset fields:', e);
      setAvailableFields([]);
      return false;
    } finally {
      setIsLoadingFields(false);
    }
  }, [api]);

  const buildColumnNodeId = useCallback((nodeId: string, fieldName: string): string => {
    const parsed = parseNodeId(nodeId);
    if (!parsed || parsed.type !== 'dataset') return nodeId;
    return `datasetField:${parsed.namespace}:${parsed.name}:${fieldName}`;
  }, []);

  const fetchLineageWithFallback = useCallback(async (
    nodeId: string,
    mode: LineageMode,
    currentDepth: number,
    downstream: boolean
  ): Promise<{ lineage: Lineage; usedFallback: boolean }> => {
    if (mode === 'column') {
      try {
        const lin = await api.lineage.getColumnLineage(nodeId, currentDepth, downstream);
        return { lineage: lin, usedFallback: false };
      } catch (e: any) {
        if (e.message?.includes('404')) {
          console.warn('Column lineage not available, falling back to dataset level');
          const parsed = parseNodeId(nodeId);
          let fallbackId = nodeId;
          if (parsed && parsed.type === 'datasetField') {
            fallbackId = `dataset:${parsed.namespace}:${parsed.name}`;
          }
          const lin = await api.lineage.get(fallbackId, currentDepth);
          return { lineage: lin, usedFallback: true };
        }
        throw e;
      }
    } else {
      const lin = await api.lineage.get(nodeId, currentDepth);
      return { lineage: lin, usedFallback: false };
    }
  }, [api]);

  const handleSelectResult = useCallback(async (result: SearchResult) => {
    setShowResults(false);
    setSelectedNodeId(result.nodeId);
    setLineageError(null);
    setIsLoadingLineage(true);
    setSelectedNodeDetail(null);
    setFallbackToDatasetLevel(false);
    setShowFieldSelector(false);

    try {
      if (lineageMode === 'column' && result.type === 'DATASET') {
        const parsed = parseNodeId(result.nodeId);
        if (parsed) {
          const hasFields = await loadDatasetFields(parsed.namespace, parsed.name);
          
          if (hasFields) {
            setShowFieldSelector(true);
            const columnNodeId = buildColumnNodeId(result.nodeId, selectedField || availableFields[0]?.name || '');
            const { lineage: lin, usedFallback } = await fetchLineageWithFallback(
              columnNodeId,
              lineageMode,
              depth,
              withDownstream
            );
            setLineage(lin);
            if (usedFallback) {
              setFallbackToDatasetLevel(true);
              setLineageWarning('当前数据集缺少字段级元数据，已自动降级显示表级血缘');
            }
          } else {
            const { lineage: lin, usedFallback } = await fetchLineageWithFallback(
              result.nodeId,
              'dataset',
              depth,
              withDownstream
            );
            setLineage(lin);
            if (usedFallback || true) {
              setFallbackToDatasetLevel(true);
              setLineageWarning('当前数据集无字段信息，已自动降级显示表级血缘');
            }
          }
        } else {
          throw new Error('Invalid node ID format');
        }
      } else {
        const { lineage: lin, usedFallback } = await fetchLineageWithFallback(
          result.nodeId,
          lineageMode,
          depth,
          withDownstream
        );
        setLineage(lin);
        if (usedFallback) {
          setFallbackToDatasetLevel(true);
        }
      }
    } catch (e: any) {
      setLineageError(e.message || '获取血缘数据失败');
      setLineage(null);
    } finally {
      setIsLoadingLineage(false);
    }
  }, [api, lineageMode, depth, withDownstream, loadDatasetFields, buildColumnNodeId, fetchLineageWithFallback, selectedField, availableFields]);

  // 保持 handleSelectResult 最新引用，供 jumpTarget effect 调用
  const handleSelectResultRef = useRef(handleSelectResult);
  useEffect(() => {
    handleSelectResultRef.current = handleSelectResult;
  }, [handleSelectResult]);

  // 外部跳转：收到 jumpTarget 时按表名搜索并自动定位首个数据集结果
  useEffect(() => {
    if (!jumpTarget) return;
    const { namespace, datasetName } = jumpTarget;
    if (!namespace || !datasetName) return;

    setSelectedNamespace(namespace);
    setSearchQuery(datasetName);
    setShowResults(true);
    setIsSearching(true);
    setLineageError(null);
    setLineageWarning(null);

    (async () => {
      try {
        const res = await api.search.query(datasetName, undefined, undefined, 20, namespace || undefined);
        // 过滤需要隐藏的中间节点（如以 .adaptive_spark_plan、.deserialize_to_object 结尾）
        const results = (res.results || []).filter(r => !shouldHideNode(r.nodeId));
        setSearchResults(results);
        const firstDataset = results.find(r => r.type === 'DATASET') ?? results[0];
        if (firstDataset) {
          handleSelectResultRef.current(firstDataset);
        } else {
          toast.info(`未在命名空间「${namespace}」中找到表「${datasetName}」的血缘数据`);
        }
      } catch (e: any) {
        setSearchResults([]);
        toast.error(`血缘搜索失败: ${e?.message || '未知错误'}`);
      } finally {
        setIsSearching(false);
      }
    })();
    // 仅在 jumpTarget 变化时触发（App 每次跳转传入新对象引用）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTarget]);

  const [lineageWarning, setLineageWarning] = useState<string | null>(null);

  const handleRefresh = useCallback(async () => {
    if (!selectedNodeId) return;
    setLineageError(null);
    setLineageWarning(null);
    setIsLoadingLineage(true);
    
    try {
      let effectiveNodeId = selectedNodeId;
      
      if (lineageMode === 'column' && showFieldSelector && selectedField) {
        const parsed = parseNodeId(selectedNodeId);
        if (parsed && parsed.type === 'dataset') {
          effectiveNodeId = `datasetField:${parsed.namespace}:${parsed.name}:${selectedField}`;
        }
      }

      const { lineage: lin, usedFallback } = await fetchLineageWithFallback(
        effectiveNodeId,
        lineageMode,
        depth,
        withDownstream
      );
      setLineage(lin);
      setFallbackToDatasetLevel(usedFallback);
      if (usedFallback) {
        setLineageWarning('当前数据集缺少字段级元数据，已自动降级显示表级血缘');
      }
    } catch (e: any) {
      setLineageError(e.message || '获取血缘数据失败');
      setLineage(null);
    } finally {
      setIsLoadingLineage(false);
    }
  }, [api, selectedNodeId, lineageMode, depth, withDownstream, showFieldSelector, selectedField, fetchLineageWithFallback]);

  const handleFieldChange = useCallback(async (fieldName: string) => {
    if (!selectedNodeId) return;
    
    setSelectedField(fieldName);
    setLineageError(null);
    setLineageWarning(null);
    setIsLoadingLineage(true);

    try {
      const parsed = parseNodeId(selectedNodeId);
      if (parsed && parsed.type === 'dataset') {
        const columnNodeId = `datasetField:${parsed.namespace}:${parsed.name}:${fieldName}`;
        const { lineage: lin, usedFallback } = await fetchLineageWithFallback(
          columnNodeId,
          lineageMode,
          depth,
          withDownstream
        );
        setLineage(lin);
        setFallbackToDatasetLevel(usedFallback);
        if (usedFallback) {
          setLineageWarning('当前数据集缺少字段级元数据，已自动降级显示表级血缘');
        }
      }
    } catch (e: any) {
      setLineageError(e.message || '获取字段血缘失败');
      setLineage(null);
    } finally {
      setIsLoadingLineage(false);
    }
  }, [selectedNodeId, lineageMode, depth, withDownstream, fetchLineageWithFallback]);

  const handleNodeClick = useCallback((_nodeId: string, _nodeType: NodeType) => {
    const rawNode = lineage?.graph?.find(n => {
      const builtId = n.id.replace(/[:#]/g, '_');
      return builtId === _nodeId;
    });
    if (rawNode) {
      setSelectedNodeDetail({
        id: rawNode.id,
        type: rawNode.type,
        data: rawNode.data as DatasetData | JobData | ColumnLineageNodeData,
      });
    }
  }, [lineage]);

  const handleDrillDown = useCallback(async (nodeId: string) => {
    setSelectedNodeId(nodeId);
    setLineageError(null);
    setLineageWarning(null);
    setIsLoadingLineage(true);
    setSelectedNodeDetail(null);
    
    const parsed = parseNodeId(nodeId);
    if (parsed && parsed.type === 'datasetField') {
      setShowFieldSelector(true);
      setSelectedField(parsed.field || '');
      await loadDatasetFields(parsed.namespace, parsed.name);
    } else {
      setShowFieldSelector(false);
    }

    try {
      const { lineage: lin, usedFallback } = await fetchLineageWithFallback(
        nodeId,
        lineageMode,
        depth,
        withDownstream
      );
      setLineage(lin);
      setFallbackToDatasetLevel(usedFallback);
      if (usedFallback) {
        setLineageWarning('当前数据集缺少字段级元数据，已自动降级显示表级血缘');
      }
    } catch (e: any) {
      setLineageError(e.message || '获取血缘数据失败');
      setLineage(null);
    } finally {
      setIsLoadingLineage(false);
    }
  }, [api, lineageMode, depth, withDownstream, fetchLineageWithFallback, loadDatasetFields]);

  if (!marquezApiUrl) {
    return (
      <div className="data-lineage-panel">
        <div className="data-lineage-panel__unconfigured">
          <GitBranch size={48} strokeWidth={1} />
          <h3>Marquez 服务未配置</h3>
          <p>请前往「设置」页面配置 Marquez API 地址后再使用数据血缘功能</p>
        </div>
      </div>
    );
  }

  return (
    <div className="data-lineage-panel">
      <div className="data-lineage-panel__toolbar">
        <div className="data-lineage-panel__search">
          <div className="data-lineage-panel__search-box">
            <Search size={14} className="data-lineage-panel__search-icon" />
            <input
              type="text"
              className="data-lineage-panel__search-input"
              placeholder="搜索数据集或作业..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
            {searchQuery && (
              <button className="data-lineage-panel__search-clear" onClick={() => { setSearchQuery(''); setSearchResults([]); setShowResults(false); }}>
                <X size={12} />
              </button>
            )}
            <button className="data-lineage-panel__search-btn" onClick={handleSearch} disabled={isSearching}>
              {isSearching ? <Loader2 size={12} className="spin" /> : '搜索'}
            </button>
          </div>
          {showResults && searchResults.length > 0 && (
            <div className="data-lineage-panel__search-results">
              {searchResults.map((r, i) => (
                <div
                  key={i}
                  className="data-lineage-panel__search-result-item"
                  onClick={() => handleSelectResult(r)}
                >
                  {r.type === 'DATASET' ? <Database size={12} /> : <Cog size={12} />}
                  <span className="data-lineage-panel__search-result-name">{r.name}</span>
                  <span className="data-lineage-panel__search-result-ns">{r.namespace}</span>
                </div>
              ))}
            </div>
          )}
          {showResults && !isSearching && searchResults.length === 0 && (
            <div className="data-lineage-panel__search-results">
              <div className="data-lineage-panel__search-empty">未找到匹配结果</div>
            </div>
          )}
        </div>

        <div className="data-lineage-panel__toolbar-right">
          <div className="data-lineage-panel__namespace-filter">
            <button
              className="data-lineage-panel__namespace-btn"
              onClick={() => setShowNamespaceDropdown(!showNamespaceDropdown)}
            >
              <Layers size={12} />
              <span>{selectedNamespace ? projects.find(p => p.projectCode === selectedNamespace)
                ? `${selectedNamespace} - ${projects.find(p => p.projectCode === selectedNamespace)!.projectName}`
                : selectedNamespace
                : '请选择项目编码'}</span>
              <ChevronDown size={10} />
            </button>
            {showNamespaceDropdown && (
              <div className="data-lineage-panel__namespace-dropdown">
                {projects.map(p => (
                  <div
                    key={p.projectCode}
                    className={`data-lineage-panel__namespace-item ${selectedNamespace === p.projectCode ? 'data-lineage-panel__namespace-item--active' : ''}`}
                    onClick={() => { setSelectedNamespace(p.projectCode); setShowNamespaceDropdown(false); }}
                  >
                    {p.projectCode} - {p.projectName}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="data-lineage-panel__mode-toggle">
            <button
              className={`data-lineage-panel__mode-btn ${lineageMode === 'dataset' ? 'data-lineage-panel__mode-btn--active' : ''}`}
              onClick={() => { setLineageMode('dataset'); setShowFieldSelector(false); }}
              title="表级血缘"
            >
              <Database size={12} />
              <span>表级</span>
            </button>
            <button
              className={`data-lineage-panel__mode-btn ${lineageMode === 'column' ? 'data-lineage-panel__mode-btn--active' : ''}`}
              onClick={() => setLineageMode('column')}
              title="列级血缘"
            >
              <Columns3 size={12} />
              <span>列级</span>
            </button>
          </div>

          {lineageMode === 'column' && (
            <label className="data-lineage-panel__downstream-toggle">
              <input
                type="checkbox"
                checked={withDownstream}
                onChange={e => setWithDownstream(e.target.checked)}
              />
              <span>含下游</span>
            </label>
          )}

          <div className="data-lineage-panel__depth-control">
            <span>深度:</span>
            <input
              type="number"
              min={1}
              max={100}
              value={depth}
              onChange={e => setDepth(parseInt(e.target.value) || 20)}
              className="data-lineage-panel__depth-input"
            />
          </div>

          <button
            className="data-lineage-panel__refresh-btn"
            onClick={handleRefresh}
            disabled={!selectedNodeId || isLoadingLineage}
            title="刷新血缘图"
          >
            <RefreshCw size={14} className={isLoadingLineage ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {showFieldSelector && availableFields.length > 0 && (
        <div className="data-lineage-panel__field-selector">
          <Columns3 size={14} />
          <span className="data-lineage-panel__field-selector-label">选择字段:</span>
          <select
            className="data-lineage-panel__field-selector-select"
            value={selectedField}
            onChange={e => handleFieldChange(e.target.value)}
            disabled={isLoadingFields || isLoadingLineage}
          >
            {availableFields.map(field => (
              <option key={field.name} value={field.name}>
                {field.name} ({field.type})
              </option>
            ))}
          </select>
          {isLoadingFields && <Loader2 size={14} className="spin" />}
        </div>
      )}

      <div className="data-lineage-panel__body">
        {selectedNodeId && (
          <div className="data-lineage-panel__breadcrumb">
            <GitBranch size={12} />
            <span className="data-lineage-panel__breadcrumb-label">当前节点:</span>
            <span className="data-lineage-panel__breadcrumb-value">{selectedNodeId}</span>
            {selectedField && showFieldSelector && (
              <span className="data-lineage-panel__breadcrumb-field">字段: {selectedField}</span>
            )}
            <span className="data-lineage-panel__breadcrumb-stats">
              {lineage?.graph ? `${lineage.graph.length} 个节点` : ''}
            </span>
            {fallbackToDatasetLevel && (
              <span className="data-lineage-panel__breadcrumb-fallback">
                <AlertCircle size={12} />
                已降级为表级血缘
              </span>
            )}
          </div>
        )}

        <div className="data-lineage-panel__graph-area">
          {isLoadingLineage && (
            <div className="data-lineage-panel__loading">
              <Loader2 size={24} className="spin" />
              <span>正在加载血缘数据...</span>
            </div>
          )}

          {lineageWarning && !isLoadingLineage && (
            <div className="data-lineage-panel__warning">
              <AlertCircle size={16} />
              <span>{lineageWarning}</span>
            </div>
          )}

          {lineageError && (
            <div className="data-lineage-panel__error">
              <AlertCircle size={20} />
              <span>{lineageError}</span>
              <button onClick={handleRefresh}>重试</button>
            </div>
          )}

          {!isLoadingLineage && !lineageError && (
            <LineageGraph lineage={lineage} onNodeClick={handleNodeClick} />
          )}
        </div>

        {selectedNodeDetail && (
          <div className="data-lineage-panel__detail">
            <div className="data-lineage-panel__detail-header">
              <span className="data-lineage-panel__detail-title">
                {selectedNodeDetail.type === 'DATASET' ? <Database size={14} /> :
                  selectedNodeDetail.type === 'JOB' ? <Cog size={14} /> :
                  <FileText size={14} />}
                节点详情
              </span>
              <button className="data-lineage-panel__detail-close" onClick={() => setSelectedNodeDetail(null)}>
                <X size={14} />
              </button>
            </div>
            <div className="data-lineage-panel__detail-body">
              <div className="data-lineage-panel__detail-row">
                <span className="data-lineage-panel__detail-key">ID</span>
                <span className="data-lineage-panel__detail-value">{selectedNodeDetail.id}</span>
              </div>
              <div className="data-lineage-panel__detail-row">
                <span className="data-lineage-panel__detail-key">类型</span>
                <span className="data-lineage-panel__detail-value">{selectedNodeDetail.type}</span>
              </div>
              {selectedNodeDetail.data && isDatasetData(selectedNodeDetail.data) && (
                <>
                  <div className="data-lineage-panel__detail-row">
                    <span className="data-lineage-panel__detail-key">名称</span>
                    <span className="data-lineage-panel__detail-value">{selectedNodeDetail.data.name}</span>
                  </div>
                  <div className="data-lineage-panel__detail-row">
                    <span className="data-lineage-panel__detail-key">物理名称</span>
                    <span className="data-lineage-panel__detail-value">{selectedNodeDetail.data.physicalName}</span>
                  </div>
                  <div className="data-lineage-panel__detail-row">
                    <span className="data-lineage-panel__detail-key">命名空间</span>
                    <span className="data-lineage-panel__detail-value">{selectedNodeDetail.data.namespace}</span>
                  </div>
                  <div className="data-lineage-panel__detail-row">
                    <span className="data-lineage-panel__detail-key">数据源</span>
                    <span className="data-lineage-panel__detail-value">{selectedNodeDetail.data.sourceName}</span>
                  </div>
                  {selectedNodeDetail.data.description && (
                    <div className="data-lineage-panel__detail-row">
                      <span className="data-lineage-panel__detail-key">描述</span>
                      <span className="data-lineage-panel__detail-value">{selectedNodeDetail.data.description}</span>
                    </div>
                  )}
                  {selectedNodeDetail.data.fields && selectedNodeDetail.data.fields.length > 0 && (
                    <div className="data-lineage-panel__detail-row data-lineage-panel__detail-row--fields">
                      <span className="data-lineage-panel__detail-key">字段</span>
                      <div className="data-lineage-panel__detail-fields">
                        {selectedNodeDetail.data.fields.map((f, i) => (
                          <span key={i} className="data-lineage-panel__detail-field-tag">
                            {f.name}: <em>{f.type}</em>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
              {selectedNodeDetail.data && isJobData(selectedNodeDetail.data) && (
                <>
                  <div className="data-lineage-panel__detail-row">
                    <span className="data-lineage-panel__detail-key">名称</span>
                    <span className="data-lineage-panel__detail-value">{selectedNodeDetail.data.name}</span>
                  </div>
                  <div className="data-lineage-panel__detail-row">
                    <span className="data-lineage-panel__detail-key">命名空间</span>
                    <span className="data-lineage-panel__detail-value">{selectedNodeDetail.data.namespace}</span>
                  </div>
                  {selectedNodeDetail.data.description && (
                    <div className="data-lineage-panel__detail-row">
                      <span className="data-lineage-panel__detail-key">描述</span>
                      <span className="data-lineage-panel__detail-value">{selectedNodeDetail.data.description}</span>
                    </div>
                  )}
                  {selectedNodeDetail.data.location && (
                    <div className="data-lineage-panel__detail-row">
                      <span className="data-lineage-panel__detail-key">位置</span>
                      <span className="data-lineage-panel__detail-value">{selectedNodeDetail.data.location}</span>
                    </div>
                  )}
                </>
              )}
              {selectedNodeDetail.data && isColumnLineageData(selectedNodeDetail.data) && (
                <>
                  <div className="data-lineage-panel__detail-row">
                    <span className="data-lineage-panel__detail-key">数据集</span>
                    <span className="data-lineage-panel__detail-value">{selectedNodeDetail.data.dataset}</span>
                  </div>
                  <div className="data-lineage-panel__detail-row">
                    <span className="data-lineage-panel__detail-key">字段</span>
                    <span className="data-lineage-panel__detail-value">{selectedNodeDetail.data.field}</span>
                  </div>
                  <div className="data-lineage-panel__detail-row">
                    <span className="data-lineage-panel__detail-key">类型</span>
                    <span className="data-lineage-panel__detail-value">{selectedNodeDetail.data.fieldType}</span>
                  </div>
                  {selectedNodeDetail.data.inputFields && selectedNodeDetail.data.inputFields.length > 0 && (
                    <div className="data-lineage-panel__detail-row data-lineage-panel__detail-row--fields">
                      <span className="data-lineage-panel__detail-key">输入字段</span>
                      <div className="data-lineage-panel__detail-fields">
                        {selectedNodeDetail.data.inputFields.map((f, i) => (
                          <span key={i} className="data-lineage-panel__detail-field-tag">
                            {f.dataset}.{f.field}
                            {f.transformationType && <em> ({f.transformationType})</em>}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
              <button
                className="data-lineage-panel__detail-drill"
                onClick={() => handleDrillDown(selectedNodeDetail.id)}
              >
                <GitBranch size={12} />
                以此节点为中心查看血缘
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DataLineagePanel;
