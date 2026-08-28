import { Table2, History, Trash2, CheckCircle, XCircle, Loader2, AlertCircle, ChevronRight, ChevronDown, GripVertical, Square, ChartPie } from 'lucide-react';
import { useState, useCallback, useRef, useEffect } from 'react';
import ChartAnalysisModal from './ChartAnalysisModal';
import './ExecutionResultTabs.css';

/** 执行结果条目 */
export interface ResultItem {
  id: string;
  columns: string[];
  rows: string[][];
  rowCount: number;
  sqlSnippet?: string;
  outputLog?: string;
  errorMessage?: string;
  success: boolean;
}

/** 执行历史条目 */
export interface HistoryItem {
  id: string;
  executionId: string | null;
  timestamp: Date;
  duration: number;
  success: boolean;
  errorMessage: string | null;
  sqlSnippet: string;
  affectedRows: number | null;
  rowCount: number | null;
}

export type TabKey = 'results' | 'history';

interface ExecutionResultTabsProps {
  /** 是否正在执行 */
  isExecuting: boolean;
  /** 是否正在编译（仅开发助手使用） */
  isCompiling?: boolean;
  /** 实时执行日志 */
  runningLogs: string;
  /** 当前激活的标签页 */
  activeTab: TabKey;
  /** 标签页切换回调 */
  onTabChange: (tab: TabKey) => void;
  /** 执行结果列表 */
  resultItems: ResultItem[];
  /** 清空执行结果回调 */
  onClearResults?: () => void;
  /** 执行历史列表 */
  historyItems: HistoryItem[];
  /** 清空执行历史回调 */
  onClearHistory?: () => void;
  /** 停止正在运行的任务 */
  onCancelExecution?: () => void;
  /** 状态栏信息 */
  statusBarInfo?: {
    line: number;
    column: number;
    language: string;
    encoding: string;
    spaces: number;
    eol: string;
    lspStatus?: string;
    scalaLspStatus?: string;
    showJavaLsp: boolean;
    showScalaLsp: boolean;
  };
}

export default function ExecutionResultTabs({
  isExecuting,
  isCompiling = false,
  runningLogs,
  activeTab,
  onTabChange,
  resultItems,
  onClearResults,
  historyItems,
  onClearHistory,
  onCancelExecution,
  statusBarInfo,
}: ExecutionResultTabsProps) {
  const [expandedErrorId, setExpandedErrorId] = useState<string | null>(null);
  // 多结果项折叠状态：仅当结果数 > 1 时启用，默认全部展开
  const [collapsedResultIds, setCollapsedResultIds] = useState<Set<string>>(new Set());
  // 勾选用于图表分析的结果项（可多选）
  const [selectedResultIds, setSelectedResultIds] = useState<Set<string>>(new Set());
  // 图表分析模态框
  const [chartVisible, setChartVisible] = useState(false);
  // 执行结果区域的右键菜单
  const [resultContextMenu, setResultContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [panelHeight, setPanelHeight] = useState(() => {
    const saved = localStorage.getItem('exec-panel-height');
    return saved ? Number(saved) : 220;
  });
  const isResizing = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  const toggleErrorExpansion = useCallback((id: string) => {
    setExpandedErrorId(prev => prev === id ? null : id);
  }, []);

  const toggleResultCollapse = useCallback((id: string) => {
    setCollapsedResultIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // 勾选 / 取消勾选结果项（用于图表分析）
  const toggleSelectResult = useCallback((id: string) => {
    setSelectedResultIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // 被勾选且可图表化的结果
  const chartableResults = resultItems.filter(i => i.success && i.columns.length > 0);
  const selectedResults = chartableResults.filter(i => selectedResultIds.has(i.id));

  const handleResultsContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setResultContextMenu({ x: e.pageX, y: e.pageY });
  }, []);

  const openChartAnalysis = useCallback(() => {
    setChartVisible(true);
    setResultContextMenu(null);
  }, []);

  // 当 resultItems 变化（新的执行批次）时，重置折叠状态
  // 依据：resultItems 的首项 ID 变化即视为新一轮执行
  const firstResultId = resultItems[0]?.id ?? null;
  const isMultiResult = resultItems.length > 1;
  useEffect(() => {
    // 仅在多结果时启用折叠
    if (!isMultiResult) {
      setCollapsedResultIds(new Set());
      return;
    }
    // 新一轮执行：默认全部展开
    setCollapsedResultIds(new Set());
    setSelectedResultIds(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstResultId, isMultiResult]);

  // 关闭结果区右键菜单（点击其他处 / Esc）
  useEffect(() => {
    const closeMenu = () => setResultContextMenu(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setResultContextMenu(null);
    };
    document.addEventListener('click', closeMenu);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const busy = isExecuting || isCompiling;

  const lspColor = (status: string | undefined) => {
    if (status === 'ready' || status === 'running') return '#4EC9B0';
    if (status === 'error') return '#f44747';
    return '#CCA700';
  };

  const lspIcon = (status: string | undefined) => {
    if (status === 'ready' || status === 'running') return '●';
    if (status === 'error') return '✕';
    return '◌';
  };

  const lspLabel = (status: string | undefined) => {
    switch (status) {
      case 'ready':
      case 'running': return '就绪';
      case 'starting': return '启动中...';
      case 'initializing': return '初始化中...';
      case 'error': return '错误';
      default: return '未连接';
    }
  };

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    startY.current = e.clientY;
    startHeight.current = panelHeight;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }, [panelHeight]);

  // 全局鼠标事件（挂载在 document 上确保拖出面板区域仍有效）
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const delta = startY.current - e.clientY; // 向上拖为正（增大高度）
      const newHeight = Math.min(Math.max(startHeight.current + delta, 120), window.innerHeight * 0.7);
      setPanelHeight(newHeight);
    };
    const handleMouseUp = () => {
      if (!isResizing.current) return;
      isResizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('exec-panel-height', String(panelHeight));
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  });

  return (
    <div className="exec-tabs__panel" style={{ height: panelHeight }}>
      {/* 拖拽调节高度的手柄 */}
      <div
        className="exec-tabs__resize-handle"
        onMouseDown={handleResizeMouseDown}
        title="拖拽调节面板高度"
      >
        <GripVertical size={14} />
      </div>
      {/* Tab 栏 */}
      <div className="exec-tabs__bar">
        <button
          className={`exec-tabs__tab ${activeTab === 'results' ? 'exec-tabs__tab--active' : ''}`}
          onClick={() => onTabChange('results')}
        >
          <Table2 size={13} />
          <span>执行结果</span>
          {busy && <Loader2 size={12} className="exec-tabs__spin" />}
          {resultItems.length > 0 && (
            <span className="exec-tabs__badge">{resultItems.length}</span>
          )}
        </button>
        <button
          className={`exec-tabs__tab ${activeTab === 'history' ? 'exec-tabs__tab--active' : ''}`}
          onClick={() => onTabChange('history')}
        >
          <History size={13} />
          <span>执行历史</span>
          {historyItems.length > 0 && (
            <span className="exec-tabs__badge">{historyItems.length}</span>
          )}
        </button>
        <div className="exec-tabs__actions">
          {activeTab === 'results' && resultItems.length > 0 && onClearResults && (
            <button className="exec-tabs__clear-btn" onClick={onClearResults} title="清空结果">
              <Trash2 size={12} />
            </button>
          )}
          {activeTab === 'history' && historyItems.length > 0 && onClearHistory && (
            <button className="exec-tabs__clear-btn" onClick={onClearHistory} title="清空历史">
              <Trash2 size={12} />
            </button>
          )}
        </div>
        {statusBarInfo && (
          <div className="exec-tabs__status-bar">
            <span>Ln {statusBarInfo.line}, Col {statusBarInfo.column}</span>
            <span>{statusBarInfo.language}</span>
            <span>{statusBarInfo.encoding}</span>
            <span>Spaces: {statusBarInfo.spaces}</span>
            <span>{statusBarInfo.eol}</span>
            {statusBarInfo.showJavaLsp && (
              <span style={{
                color: lspColor(statusBarInfo.lspStatus),
                fontSize: '11px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}>
                {lspIcon(statusBarInfo.lspStatus)}
                JDT.LS {lspLabel(statusBarInfo.lspStatus)}
              </span>
            )}
            {statusBarInfo.showScalaLsp && (
              <span style={{
                color: lspColor(statusBarInfo.scalaLspStatus),
                fontSize: '11px',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}>
                {lspIcon(statusBarInfo.scalaLspStatus)}
                Metals {lspLabel(statusBarInfo.scalaLspStatus)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* 内容区 */}
      <div className="exec-tabs__content">
        {/* ========== 执行结果 Tab ========== */}
        {activeTab === 'results' && (
          <div className="exec-tabs__results" onContextMenu={handleResultsContextMenu}>
            {/* 执行/编译中：显示日志 */}
            {busy && (
              <>
                <pre className="exec-tabs__running-logs">{runningLogs || (isCompiling ? '正在编译...' : '等待日志...')}</pre>
                {/* 执行中已产生的结果 */}
                {isExecuting && resultItems.length > 0 && (
                  <div className="exec-tabs__multi-results">
                    <div className="exec-tabs__multi-header">
                      已完成 {resultItems.length} 条
                    </div>
                    {resultItems.map((item) => {
                      const collapsed = isMultiResult && collapsedResultIds.has(item.id);
                      return (
                        <div key={item.id} className={`exec-tabs__result-item ${!item.success ? 'exec-tabs__result-item--error' : ''} ${collapsed ? 'exec-tabs__result-item--collapsed' : ''}`}>
                          {isMultiResult && (
                            <div
                              className="exec-tabs__result-toggle"
                              onClick={() => toggleResultCollapse(item.id)}
                              title={collapsed ? '展开结果' : '折叠结果'}
                            >
                              {item.success && item.columns.length > 0 && (
                                <label
                                  className="exec-tabs__select-box"
                                  title="勾选用于图表分析"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <input
                                    type="checkbox"
                                    checked={selectedResultIds.has(item.id)}
                                    onChange={() => toggleSelectResult(item.id)}
                                  />
                                </label>
                              )}
                              {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                              {item.sqlSnippet && (
                                <span className="exec-tabs__result-toggle-label" title={item.sqlSnippet}>
                                  {(item.sqlSnippet).length > 50 ? (item.sqlSnippet).slice(0, 50) + '...' : item.sqlSnippet}
                                </span>
                              )}
                            </div>
                          )}
                          {!collapsed && (
                            <>
                              {!isMultiResult && item.sqlSnippet && (
                                <div className="exec-tabs__result-label" title={item.sqlSnippet}>
                                  {(item.sqlSnippet).length > 50 ? (item.sqlSnippet).slice(0, 50) + '...' : item.sqlSnippet}
                                </div>
                              )}
                              {item.errorMessage && (
                                <pre className="exec-tabs__error-msg">{item.errorMessage}</pre>
                              )}
                              {item.success && item.columns.length > 0 && (
                                <div className="exec-tabs__table-wrapper">
                                  <table className="exec-tabs__table">
                                    <thead>
                                      <tr>
                                        <th className="exec-tabs__col-idx">#</th>
                                        {item.columns.map((col, ci) => (
                                          <th key={ci}>{col}</th>
                                        ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {item.rows.map((row, ri) => (
                                        <tr key={ri}>
                                          <td className="exec-tabs__col-idx">{ri + 1}</td>
                                          {row.map((cell, cj) => (
                                            <td key={cj}>{cell}</td>
                                          ))}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                              {item.success && item.columns.length === 0 && item.outputLog && (
                                <pre className="exec-tabs__output-log">{item.outputLog}</pre>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {/* 空闲 + 无结果 */}
            {!busy && resultItems.length === 0 && (
              <div className="exec-tabs__empty">
                <Table2 size={32} className="exec-tabs__empty-icon" />
                <p>执行代码后，结果将显示在此处</p>
              </div>
            )}

            {/* 空闲 + 有结果 */}
            {!busy && resultItems.length > 0 && (
              <div className="exec-tabs__multi-results">
                {resultItems.length > 1 && (
                  <div className="exec-tabs__multi-header">
                    共 {resultItems.length} 条执行结果
                  </div>
                )}
                {resultItems.map((item) => {
                  const collapsed = isMultiResult && collapsedResultIds.has(item.id);
                  return (
                    <div key={item.id} className={`exec-tabs__result-item ${!item.success ? 'exec-tabs__result-item--error' : ''} ${collapsed ? 'exec-tabs__result-item--collapsed' : ''}`}>
                      <div
                        className={`exec-tabs__result-header ${isMultiResult ? 'exec-tabs__result-header--clickable' : ''}`}
                        onClick={isMultiResult ? () => toggleResultCollapse(item.id) : undefined}
                        title={isMultiResult ? (collapsed ? '展开结果' : '折叠结果') : undefined}
                      >
                        {item.success && item.columns.length > 0 && (
                          <label
                            className="exec-tabs__select-box"
                            title="勾选用于图表分析"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              checked={selectedResultIds.has(item.id)}
                              onChange={() => toggleSelectResult(item.id)}
                            />
                          </label>
                        )}
                        {isMultiResult && (
                          collapsed
                            ? <ChevronRight size={12} className="exec-tabs__result-chevron" />
                            : <ChevronDown size={12} className="exec-tabs__result-chevron" />
                        )}
                        <span className={item.success ? 'exec-tabs__status-ok' : 'exec-tabs__status-err'}>
                          {item.success ? <CheckCircle size={14} /> : <XCircle size={14} />}
                          {item.success ? 'SUCCESS' : 'FAILED'}
                        </span>
                        {item.sqlSnippet && (
                          <span className="exec-tabs__sql-snippet" title={item.sqlSnippet}>
                            {(item.sqlSnippet).length > 50 ? (item.sqlSnippet).slice(0, 50) + '...' : item.sqlSnippet}
                          </span>
                        )}
                      </div>
                      {!collapsed && (
                        <>
                          {item.errorMessage && (
                            <pre className="exec-tabs__error-msg">{item.errorMessage}</pre>
                          )}
                          {item.success && item.columns.length > 0 && (
                            <div className="exec-tabs__table-wrapper">
                              <table className="exec-tabs__table">
                                <thead>
                                  <tr>
                                    <th className="exec-tabs__col-idx">#</th>
                                    {item.columns.map((col, ci) => (
                                      <th key={ci}>{col}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {item.rows.map((row, ri) => (
                                    <tr key={ri}>
                                      <td className="exec-tabs__col-idx">{ri + 1}</td>
                                      {row.map((cell, cj) => (
                                        <td key={cj}>{cell}</td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                          {item.success && item.columns.length === 0 && item.outputLog && (
                            <pre className="exec-tabs__output-log">{item.outputLog}</pre>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ========== 执行历史 Tab ========== */}
        {activeTab === 'history' && (
          <>
            {historyItems.length === 0 ? (
              <div className="exec-tabs__empty">
                <History size={32} className="exec-tabs__empty-icon" />
                <p>执行代码后，历史记录将显示在此处</p>
              </div>
            ) : (
              <div className="exec-tabs__history-list">
                {historyItems.map((item) => (
                  <div
                    key={item.id}
                    className={`exec-tabs__history-item ${!item.success ? 'exec-tabs__history-item--error' : ''}`}
                  >
                    <div className="exec-tabs__history-header">
                      <div className="exec-tabs__history-left">
                        {item.success ? (
                          <CheckCircle size={14} className="exec-tabs__icon-success" />
                        ) : item.duration === 0 ? (
                          <Loader2 size={14} className="exec-tabs__spin" />
                        ) : (
                          <XCircle size={14} className="exec-tabs__icon-error" />
                        )}
                        <span className="exec-tabs__history-exec-id">
                          {item.executionId || `exec_${item.id.slice(-8)}`}
                        </span>
                      </div>
                      <div className="exec-tabs__history-right">
                        <span className="exec-tabs__history-time">
                          {item.timestamp.toLocaleTimeString('zh-CN', {
                            hour: '2-digit', minute: '2-digit', second: '2-digit',
                          })}
                        </span>
                        {item.duration === 0 && !item.success && onCancelExecution && (
                          <button
                            className="exec-tabs__stop-btn"
                            onClick={onCancelExecution}
                            title="停止执行"
                          >
                            <Square size={12} />
                            <span>停止</span>
                          </button>
                        )}
                        <span className={`exec-tabs__history-duration ${item.success ? '' : 'exec-tabs__history-duration--error'}`}>
                          {item.duration > 0 ? `${item.duration}ms` : item.duration === 0 ? '执行中...' : '-'}
                        </span>
                      </div>
                    </div>

                    <div className="exec-tabs__history-body">
                      <div className="exec-tabs__history-sql">{item.sqlSnippet}</div>

                      {(item.affectedRows !== null || item.rowCount !== null) && (
                        <div className="exec-tabs__history-stats">
                          {item.rowCount !== null && <span>返回 {item.rowCount} 行</span>}
                          {item.affectedRows !== null && <span>影响 {item.affectedRows} 行</span>}
                        </div>
                      )}

                      {!item.success && item.errorMessage && (
                        <div className="exec-tabs__history-error">
                          <button
                            className="exec-tabs__history-error-toggle"
                            onClick={() => toggleErrorExpansion(item.id)}
                          >
                            <AlertCircle size={12} />
                            <span>{expandedErrorId === item.id ? '收起' : '展开'}错误详情</span>
                            <ChevronRight
                              size={12}
                              className={`exec-tabs__history-chevron ${expandedErrorId === item.id ? 'exec-tabs__history-chevron--expanded' : ''}`}
                            />
                          </button>
                          {expandedErrorId === item.id && (
                            <div className="exec-tabs__history-error-content">{item.errorMessage}</div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* 结果区右键菜单：图表分析 */}
      {resultContextMenu && chartableResults.length > 0 && (
        <div
          className="exec-tabs__context-menu"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: resultContextMenu.x,
            top: resultContextMenu.y,
            zIndex: 10000,
          }}
        >
          <div
            className={`exec-tabs__context-item ${selectedResults.length === 0 ? 'exec-tabs__context-item--disabled' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); if (selectedResults.length > 0) openChartAnalysis(); }}
            onMouseEnter={(e) => {
              if (selectedResults.length > 0) ((e.currentTarget as HTMLDivElement).style.backgroundColor = 'rgba(255,255,255,0.04)');
            }}
            onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.backgroundColor = 'transparent')}
            title={selectedResults.length === 0 ? '请先在执行结果中勾选数据结果' : undefined}
          >
            <ChartPie size={14} />
            <span>
              {selectedResults.length > 0
                ? `图表分析（已选 ${selectedResults.length} 个结果）`
                : '图表分析（请先勾选结果）'}
            </span>
          </div>
        </div>
      )}

      {/* 图表分析模态框 */}
      <ChartAnalysisModal
        visible={chartVisible}
        onClose={() => { setChartVisible(false); }}
        results={selectedResults}
      />
    </div>
  );
}
