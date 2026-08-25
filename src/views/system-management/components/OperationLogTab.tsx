import { useState, useEffect, useCallback } from 'react';
import { Search, RotateCcw, Download, Eye, X } from 'lucide-react';
import { systemAuditApi, type AuditLog, type AuditStatistics } from '../../../api/systemAudit';

const OperationLogTab: React.FC = () => {
  const [logList, setLogList] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [modules, setModules] = useState<string[]>([]);
  const [operations, setOperations] = useState<string[]>([]);
  const [operationTypes, setOperationTypes] = useState<string[]>([]);
  const [_statistics, setStatistics] = useState<AuditStatistics | null>(null);
  const [filterModule, setFilterModule] = useState('');
  const [filterOperation, setFilterOperation] = useState('');
  const [filterOperationType, setFilterOperationType] = useState('');
  const [filterUsername, setFilterUsername] = useState('');
  const [filterStartDate, setFilterStartDate] = useState('');
  const [filterEndDate, setFilterEndDate] = useState('');
  const [detailLog, setDetailLog] = useState<AuditLog | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [exporting, setExporting] = useState(false);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await systemAuditApi.getAuditLogList({
        current: page,
        size: 20,
        module: filterModule || undefined,
        operation: filterOperation || undefined,
        operationType: filterOperationType || undefined,
        username: filterUsername || undefined,
        startTime: filterStartDate || undefined,
        endTime: filterEndDate || undefined,
      });
      setLogList(res.data.records || []);
      setTotal(res.data.total || 0);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [page, filterModule, filterOperation, filterOperationType, filterUsername, filterStartDate, filterEndDate]);

  const loadStatistics = useCallback(async () => {
    try {
      const res = await systemAuditApi.getAuditStatistics({
        startTime: filterStartDate || undefined,
        endTime: filterEndDate || undefined,
      });
      setStatistics(res.data);
    } catch (e) { console.error(e); }
  }, [filterStartDate, filterEndDate]);

  useEffect(() => {
    systemAuditApi.getAuditModules().then(res => setModules(res.data || [])).catch(() => {});
    systemAuditApi.getAuditOperations().then(res => setOperations(res.data || [])).catch(() => {});
    systemAuditApi.getAuditOperationTypes().then(res => setOperationTypes(res.data || [])).catch(() => {});
  }, []);

  useEffect(() => { loadLogs(); }, [loadLogs]);
  useEffect(() => { loadStatistics(); }, [loadStatistics]);

  const handleReset = () => {
    setFilterModule('');
    setFilterOperation('');
    setFilterOperationType('');
    setFilterUsername('');
    setFilterStartDate('');
    setFilterEndDate('');
    setPage(1);
  };

  const handleViewDetail = async (id: number) => {
    try {
      const res = await systemAuditApi.getAuditLogDetail(id);
      setDetailLog(res.data);
      setShowDetail(true);
    } catch (e) { console.error(e); }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      await systemAuditApi.exportAuditLogs({
        module: filterModule || undefined,
        operation: filterOperation || undefined,
        operationType: filterOperationType || undefined,
        username: filterUsername || undefined,
        startTime: filterStartDate || undefined,
        endTime: filterEndDate || undefined,
      });
    } catch (e) { console.error(e); }
    finally { setExporting(false); }
  };

  const totalPages = Math.max(1, Math.ceil(total / 20));

  const renderPagination = () => {
    const pages: (number | '...')[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (page > 3) pages.push('...');
      const start = Math.max(2, page - 1);
      const end = Math.min(totalPages - 1, page + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (page < totalPages - 2) pages.push('...');
      pages.push(totalPages);
    }

    return (
      <div className="sys-mgmt__pagination">
        <button className="sys-mgmt__page-btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
        {pages.map((p, idx) =>
          p === '...' ? (
            <span key={`ellipsis-${idx}`} className="sys-mgmt__page-ellipsis">...</span>
          ) : (
            <button
              key={p}
              className={`sys-mgmt__page-num ${page === p ? 'sys-mgmt__page-num--active' : ''}`}
              onClick={() => setPage(p)}
            >
              {p}
            </button>
          )
        )}
        <button className="sys-mgmt__page-btn" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</button>
        <span className="sys-mgmt__page-info">(共{total}条)</span>
      </div>
    );
  };

  return (
    <div className="sys-mgmt__section">


      <div className="sys-mgmt__toolbar">
        <div className="sys-mgmt__search-bar">
          <select className="sys-mgmt__select sys-mgmt__select--small" value={filterModule} onChange={e => { setFilterModule(e.target.value); setPage(1); }}>
            <option value="">操作模块</option>
            {modules.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <select className="sys-mgmt__select sys-mgmt__select--small" value={filterOperation} onChange={e => { setFilterOperation(e.target.value); setPage(1); }}>
            <option value="">操作名称</option>
            {operations.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
          <select className="sys-mgmt__select sys-mgmt__select--small" value={filterOperationType} onChange={e => { setFilterOperationType(e.target.value); setPage(1); }}>
            <option value="">操作类型</option>
            {operationTypes.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <input className="sys-mgmt__input" placeholder="操作用户" value={filterUsername} onChange={e => { setFilterUsername(e.target.value); setPage(1); }} />
          <input className="sys-mgmt__input" type="date" value={filterStartDate} onChange={e => { setFilterStartDate(e.target.value); setPage(1); }} />
          <span style={{ color: '#999' }}>至</span>
          <input className="sys-mgmt__input" type="date" value={filterEndDate} onChange={e => { setFilterEndDate(e.target.value); setPage(1); }} />
          <button className="sys-mgmt__btn sys-mgmt__btn--primary" onClick={() => { setPage(1); loadLogs(); }}><Search size={14} /> 查询</button>
          <button className="sys-mgmt__btn" onClick={handleReset}><RotateCcw size={14} /> 重置</button>
        </div>
        <div className="sys-mgmt__toolbar-actions">
          <button className="sys-mgmt__btn" onClick={handleExport} disabled={exporting}>
            <Download size={14} /> {exporting ? '导出中...' : '导出CSV'}
          </button>
        </div>
      </div>

      <div className="sys-mgmt__table-wrap">
        <table className="sys-mgmt__table">
          <thead>
            <tr>
              <th>操作用户</th><th>模块</th><th>操作名称</th><th>操作类型</th><th>请求方法</th><th>响应状态</th><th>IP地址</th><th>操作时间</th><th>耗时(ms)</th><th>敏感</th><th>AI请求</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={12} className="sys-mgmt__table-empty">加载中...</td></tr> :
            logList.length === 0 ? <tr><td colSpan={12} className="sys-mgmt__table-empty">暂无数据</td></tr> :
            logList.map(row => (
              <tr key={row.id}>
                <td>{row.username}</td>
                <td>{row.module}</td>
                <td>{row.operation}</td>
                <td>{row.operationType || '-'}</td>
                <td><code className="sys-mgmt__code">{row.requestMethod}</code></td>
                <td><span className={`sys-mgmt__tag sys-mgmt__tag--${row.responseStatus >= 200 && row.responseStatus < 300 ? 'success' : 'danger'}`}>{row.responseStatus}</span></td>
                <td>{row.ipAddress}</td>
                <td>{row.operationTime}</td>
                <td>{row.durationMs}</td>
                <td><span className={`sys-mgmt__tag sys-mgmt__tag--${row.isSensitive === 1 ? 'danger' : 'info'}`}>{row.isSensitive === 1 ? '是' : '否'}</span></td>
                <td><span className={`sys-mgmt__tag sys-mgmt__tag--${row.isAiRequest === 1 ? 'warning' : 'info'}`}>{row.isAiRequest === 1 ? '是' : '否'}</span></td>
                <td>
                  <button className="sys-mgmt__btn sys-mgmt__btn--link" onClick={() => handleViewDetail(row.id)} title="查看详情">
                    <Eye size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {renderPagination()}

      {showDetail && detailLog && (
        <div className="sys-mgmt__modal-overlay" onClick={() => setShowDetail(false)}>
          <div className="sys-mgmt__modal" onClick={e => e.stopPropagation()}>
            <div className="sys-mgmt__modal-header">
              <h3>审计日志详情</h3>
              <button className="sys-mgmt__modal-close" onClick={() => setShowDetail(false)}><X size={18} /></button>
            </div>
            <div className="sys-mgmt__modal-body">
              <div className="sys-mgmt__detail-grid">
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">日志ID</span><span>{detailLog.id}</span></div>
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">操作用户</span><span>{detailLog.username}</span></div>
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">用户ID</span><span>{detailLog.userId}</span></div>
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">租户</span><span>{detailLog.tenantName || '-'}</span></div>
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">模块</span><span>{detailLog.module}</span></div>
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">操作名称</span><span>{detailLog.operation}</span></div>
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">操作类型</span><span>{detailLog.operationType || '-'}</span></div>
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">对象类型</span><span>{detailLog.targetType}</span></div>
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">对象ID</span><span>{detailLog.targetId}</span></div>
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">对象名称</span><span>{detailLog.targetName}</span></div>
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">请求方法</span><span><code className="sys-mgmt__code">{detailLog.requestMethod}</code></span></div>
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">请求URL</span><span className="sys-mgmt__detail-long">{detailLog.requestUrl || '-'}</span></div>
                <div className="sys-mgmt__detail-item sys-mgmt__detail-item--full"><span className="sys-mgmt__detail-label">请求参数</span><span className="sys-mgmt__detail-long"><pre className="sys-mgmt__detail-pre">{detailLog.requestParams ? (() => { try { return JSON.stringify(JSON.parse(detailLog.requestParams), null, 2); } catch { return detailLog.requestParams; } })() : '-'}</pre></span></div>
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">响应状态</span><span className={`sys-mgmt__tag sys-mgmt__tag--${detailLog.responseStatus >= 200 && detailLog.responseStatus < 300 ? 'success' : 'danger'}`}>{detailLog.responseStatus}</span></div>
                {detailLog.errorMessage && (
                  <div className="sys-mgmt__detail-item sys-mgmt__detail-item--full"><span className="sys-mgmt__detail-label">错误信息</span><span className="sys-mgmt__detail-long sys-mgmt__detail-error">{detailLog.errorMessage}</span></div>
                )}
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">IP地址</span><span>{detailLog.ipAddress}</span></div>
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">User-Agent</span><span className="sys-mgmt__detail-long">{detailLog.userAgent || '-'}</span></div>
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">操作时间</span><span>{detailLog.operationTime}</span></div>
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">耗时</span><span>{detailLog.durationMs}ms</span></div>
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">敏感操作</span><span className={`sys-mgmt__tag sys-mgmt__tag--${detailLog.isSensitive === 1 ? 'danger' : 'info'}`}>{detailLog.isSensitive === 1 ? '是' : '否'}</span></div>
                <div className="sys-mgmt__detail-item"><span className="sys-mgmt__detail-label">AI请求</span><span className={`sys-mgmt__tag sys-mgmt__tag--${detailLog.isAiRequest === 1 ? 'warning' : 'info'}`}>{detailLog.isAiRequest === 1 ? '是' : '否'}</span></div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default OperationLogTab;
