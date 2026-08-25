import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, RotateCcw, Eye, X, Trash2, GitBranch } from 'lucide-react';
import { indicatorApi, type IndicatorVO, type IndicatorFieldVO } from '../../api/indicator';
import { fetchProjectList, type ProjectInfo } from '../../api/devProject';
import { useToast } from '../../components/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { FIRST_LEVEL_MENU_CODES } from '../../components/layout/ActivityBar';
import './IndicatorManagementPanel.css';

const PAGE_SIZE = 15;

// 角色编码与 sys_role 表 role_code 字段一致（无 ROLE_ 前缀）
// 数据开发工程师(DATA_DEV_ENGINEER)无删除权限
const DELETE_ALLOWED_ROLE_CODES = ['SUPER_ADMIN', 'OPS_ENGINEER', 'DATA_ARCHITECT'];

interface IndicatorManagementPanelProps {
  /** 跳转到数据血缘：传入命名空间（项目编码）与数据集名（表名） */
  onNavigateToLineage?: (target: { namespace: string; datasetName: string }) => void;
}

const IndicatorManagementPanel: React.FC<IndicatorManagementPanelProps> = ({ onNavigateToLineage }) => {
  const toast = useToast();
  const { user } = useAuth();
  const canDelete = useMemo(() => {
    if (!user) return false;
    if (user.isSuperAdmin) return true;
    return user.roles.some(r =>
      DELETE_ALLOWED_ROLE_CODES.includes(r.roleCode.toUpperCase())
    );
  }, [user]);

  // 是否有数据血缘访问权限（与 App.tsx 的 isTabVisible('dataLineage') 规则一致）
  const canAccessLineage = useMemo(() => {
    if (!user) return true;
    if (user.isSuperAdmin) return true;
    const menuTags = user.menuTags ?? [];
    if (FIRST_LEVEL_MENU_CODES.every(c => menuTags.includes(c))) return true;
    return menuTags.includes('data_lineage');
  }, [user]);
  const [indicators, setIndicators] = useState<IndicatorVO[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  // 过滤条件
  const [filterProject, setFilterProject] = useState('');
  const [filterTopic, setFilterTopic] = useState('');
  const [filterKeyword, setFilterKeyword] = useState('');

  // 下拉选项数据
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [topics, setTopics] = useState<string[]>([]);

  // 详情弹窗
  const [detailIndicator, setDetailIndicator] = useState<IndicatorVO | null>(null);
  const [detailFields, setDetailFields] = useState<IndicatorFieldVO[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  // 删除确认弹窗
  const [deleteTarget, setDeleteTarget] = useState<IndicatorVO | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 批量选择
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [batchDeleteVisible, setBatchDeleteVisible] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);

  // 加载项目列表
  useEffect(() => {
    fetchProjectList({ size: 200 })
      .then(res => setProjects(res.data.records || []))
      .catch(() => {});
  }, []);

  // 加载指标列表时提取去重的 topic
  const extractTopics = (records: IndicatorVO[]) => {
    const topicSet = new Set<string>();
    records.forEach(r => { if (r.topic) topicSet.add(r.topic); });
    setTopics(Array.from(topicSet).sort());
  };

  const loadIndicators = useCallback(async () => {
    setLoading(true);
    try {
      const res = await indicatorApi.getList({
        current: page,
        size: PAGE_SIZE,
        projectCode: filterProject || undefined,
        topic: filterTopic || undefined,
        keyword: filterKeyword || undefined,
      });
      setIndicators(res.data.records || []);
      setTotal(res.data.total || 0);
      setSelectedIds(new Set());
      extractTopics(res.data.records || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [page, filterProject, filterTopic, filterKeyword]);

  useEffect(() => {
    loadIndicators();
  }, [loadIndicators]);

  // 加载全部 topic（首次加载时获取大列表来提取）
  useEffect(() => {
    indicatorApi.getList({ size: 200 })
      .then(res => {
        const allTopics = new Set<string>();
        (res.data.records || []).forEach(r => { if (r.topic) allTopics.add(r.topic); });
        setTopics(Array.from(allTopics).sort());
      })
      .catch(() => {});
  }, []);

  const handleReset = () => {
    setFilterProject('');
    setFilterTopic('');
    setFilterKeyword('');
    setPage(1);
  };

  const handleViewDetail = async (id: number) => {
    setDetailLoading(true);
    try {
      const res = await indicatorApi.getById(id);
      setDetailIndicator(res.data);
      setDetailFields(res.data.fields || []);
    } catch (e) {
      console.error(e);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await indicatorApi.batchDelete([deleteTarget.id]);
      toast.info(`指标「${deleteTarget.name}」已删除`);
      setDeleteTarget(null);
      if (detailIndicator?.id === deleteTarget.id) {
        setDetailIndicator(null);
        setDetailFields([]);
      }
      loadIndicators();
    } catch (e) {
      toast.error(`删除失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeleting(false);
    }
  };

  const allChecked = indicators.length > 0 && indicators.every(ind => selectedIds.has(ind.id));

  const toggleAll = () => {
    if (allChecked) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(indicators.map(ind => ind.id)));
    }
  };

  const toggleOne = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBatchDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBatchDeleting(true);
    try {
      await indicatorApi.batchDelete(ids);
      toast.info(`已删除 ${ids.length} 个指标`);
      setBatchDeleteVisible(false);
      setSelectedIds(new Set());
      if (detailIndicator && selectedIds.has(detailIndicator.id)) {
        setDetailIndicator(null);
        setDetailFields([]);
      }
      loadIndicators();
    } catch (e) {
      toast.error(`批量删除失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBatchDeleting(false);
    }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="indicator-mgmt">
      {/* 左侧：指标列表 */}
      <div className="indicator-mgmt__list-panel">
        <div className="indicator-mgmt__header">
          <h2 className="indicator-mgmt__title">指标管理</h2>
        </div>

        {/* 过滤栏 */}
        <div className="indicator-mgmt__filters">
          <select
            className="indicator-mgmt__select"
            value={filterProject}
            onChange={e => { setFilterProject(e.target.value); setPage(1); }}
          >
            <option value="">项目编码</option>
            {projects.map(p => (
              <option key={p.id} value={p.projectCode}>{p.projectCode} - {p.projectName}</option>
            ))}
          </select>

          <select
            className="indicator-mgmt__select"
            value={filterTopic}
            onChange={e => { setFilterTopic(e.target.value); setPage(1); }}
          >
            <option value="">主题域</option>
            {topics.map(t => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          <div className="indicator-mgmt__search-wrapper">
            <Search size={14} className="indicator-mgmt__search-icon" />
            <input
              type="text"
              className="indicator-mgmt__search-input"
              placeholder="搜索指标名称/别名/业务定义..."
              value={filterKeyword}
              onChange={e => { setFilterKeyword(e.target.value); setPage(1); }}
            />
          </div>

          <div className="indicator-mgmt__filter-actions">
            <button className="indicator-mgmt__btn indicator-mgmt__btn--small" onClick={handleReset} title="重置">
              <RotateCcw size={14} />
            </button>
            {canDelete && selectedIds.size > 0 && (
              <button
                className="indicator-mgmt__btn indicator-mgmt__btn--small indicator-mgmt__btn--danger"
                onClick={() => setBatchDeleteVisible(true)}
                title={`批量删除 (${selectedIds.size})`}
              >
                <Trash2 size={14} />
                <span>{selectedIds.size}</span>
              </button>
            )}
          </div>
        </div>

        {/* 指标列表 */}
        <div className="indicator-mgmt__list">
          {loading && indicators.length === 0 ? (
            <div className="indicator-mgmt__empty">加载中...</div>
          ) : indicators.length === 0 ? (
            <div className="indicator-mgmt__empty">暂无指标数据</div>
          ) : (
            <>
              <div className="indicator-mgmt__list-header">
                <span className="indicator-mgmt__list-header-col">指标名</span>
                <span className="indicator-mgmt__list-header-col">指标编码</span>
                <span className="indicator-mgmt__list-header-col">主题域</span>
                {canDelete && (
                  <label className="indicator-mgmt__list-header-check" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="indicator-mgmt__checkbox"
                      checked={allChecked}
                      onChange={toggleAll}
                    />
                  </label>
                )}
              </div>
              {indicators.map(ind => (
                <div
                  key={ind.id}
                  className={`indicator-mgmt__item ${detailIndicator?.id === ind.id ? 'indicator-mgmt__item--active' : ''} ${selectedIds.has(ind.id) ? 'indicator-mgmt__item--selected' : ''}`}
                  onClick={() => handleViewDetail(ind.id)}
                >
                  <div className="indicator-mgmt__item-row">
                    <span className="indicator-mgmt__item-name">{ind.name}</span>
                    {ind.code && <span className="indicator-mgmt__item-alias">{ind.code}</span>}
                    <span className="indicator-mgmt__item-topic">{ind.topic}</span>
                    {canDelete && (
                      <label className="indicator-mgmt__item-check" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="indicator-mgmt__checkbox"
                          checked={selectedIds.has(ind.id)}
                          onChange={() => toggleOne(ind.id)}
                        />
                      </label>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {/* 分页 */}
        {totalPages > 1 && (
          <div className="indicator-mgmt__pagination">
            <button
              className="indicator-mgmt__page-btn"
              disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}
            >
              上一页
            </button>
            <span className="indicator-mgmt__page-info">{page} / {totalPages}</span>
            <button
              className="indicator-mgmt__page-btn"
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
            >
              下一页
            </button>
          </div>
        )}
      </div>

      {/* 右侧：指标详情 */}
      <div className="indicator-mgmt__detail-panel">
        {detailLoading ? (
          <div className="indicator-mgmt__detail-empty">加载中...</div>
        ) : detailIndicator ? (
          <div className="indicator-mgmt__detail">
            <div className="indicator-mgmt__detail-header">
              <h3 className="indicator-mgmt__detail-title">{detailIndicator.name}</h3>
              <div className="indicator-mgmt__detail-actions">
                {canDelete && (
                  <button
                    className="indicator-mgmt__detail-delete"
                    onClick={() => setDeleteTarget(detailIndicator)}
                    title="删除指标"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
                <button className="indicator-mgmt__detail-close" onClick={() => setDetailIndicator(null)}>
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="indicator-mgmt__detail-grid">
              <div className="indicator-mgmt__detail-item">
                <span className="indicator-mgmt__detail-label">项目编码</span>
                <span className="indicator-mgmt__detail-value">{detailIndicator.projectCode}</span>
              </div>
              <div className="indicator-mgmt__detail-item">
                <span className="indicator-mgmt__detail-label">主题域</span>
                <span className="indicator-mgmt__detail-value">{detailIndicator.topic}</span>
              </div>
              <div className="indicator-mgmt__detail-item">
                <span className="indicator-mgmt__detail-label">指标编码</span>
                <span className="indicator-mgmt__detail-value">{detailIndicator.code || '-'}</span>
              </div>
              <div className="indicator-mgmt__detail-item">
                <span className="indicator-mgmt__detail-label">可见性</span>
                <span className="indicator-mgmt__detail-value">{detailIndicator.visibility || '-'}</span>
              </div>
              <div className="indicator-mgmt__detail-item">
                <span className="indicator-mgmt__detail-label">业务负责人</span>
                <span className="indicator-mgmt__detail-value">{detailIndicator.businessOwner || '-'}</span>
              </div>
              <div className="indicator-mgmt__detail-item">
                <span className="indicator-mgmt__detail-label">技术负责人</span>
                <span className="indicator-mgmt__detail-value">{detailIndicator.techOwner || '-'}</span>
              </div>
              <div className="indicator-mgmt__detail-item">
                <span className="indicator-mgmt__detail-label">刷新策略</span>
                <span className="indicator-mgmt__detail-value">
                  {detailIndicator.refreshInterval
                    ? `${detailIndicator.refreshInterval} ${detailIndicator.refreshUnit || ''}${detailIndicator.refreshDesc ? ` (${detailIndicator.refreshDesc})` : ''}`
                    : '-'}
                </span>
              </div>
              <div className="indicator-mgmt__detail-item">
                <span className="indicator-mgmt__detail-label">创建时间</span>
                <span className="indicator-mgmt__detail-value">{detailIndicator.createdAt?.replace('T', ' ') || '-'}</span>
              </div>
              <div className="indicator-mgmt__detail-item indicator-mgmt__detail-item--full">
                <span className="indicator-mgmt__detail-label">业务定义</span>
                <span className="indicator-mgmt__detail-value indicator-mgmt__detail-long">
                  {detailIndicator.businessDefinition || '-'}
                </span>
              </div>
              {detailIndicator.calcExpr && (
                <div className="indicator-mgmt__detail-item indicator-mgmt__detail-item--full">
                  <span className="indicator-mgmt__detail-label">计算表达式</span>
                  <pre className="indicator-mgmt__detail-pre">{detailIndicator.calcExpr}</pre>
                </div>
              )}
              {detailIndicator.defaultFilter && (
                <div className="indicator-mgmt__detail-item indicator-mgmt__detail-item--full">
                  <span className="indicator-mgmt__detail-label">默认过滤条件</span>
                  <pre className="indicator-mgmt__detail-pre">{detailIndicator.defaultFilter}</pre>
                </div>
              )}
              {detailIndicator.alertConfig && (
                <div className="indicator-mgmt__detail-item indicator-mgmt__detail-item--full">
                  <span className="indicator-mgmt__detail-label">告警配置</span>
                  <pre className="indicator-mgmt__detail-pre">{detailIndicator.alertConfig}</pre>
                </div>
              )}
            </div>

            {/* 关联字段 */}
            {detailFields.length > 0 && (
              <div className="indicator-mgmt__fields-section">
                <h4 className="indicator-mgmt__fields-title">关联字段</h4>
                <div className="indicator-mgmt__fields-table-wrap">
                  <table className="indicator-mgmt__fields-table">
                    <thead>
                      <tr>
                        <th>数据源</th>
                        <th>库</th>
                        <th>表</th>
                        <th>字段</th>
                        <th>类型</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailFields.map(f => (
                        <tr key={f.id}>
                          <td>{f.datasourceName}</td>
                          <td>{f.dbName}</td>
                          <td>
                            {f.tblName && onNavigateToLineage && canAccessLineage && detailIndicator?.projectCode ? (
                              <span
                                className="indicator-mgmt__field-link"
                                title={`查看 ${f.dbName ? f.dbName + '.' : ''}${f.tblName} 的数据血缘`}
                                onClick={() => onNavigateToLineage({
                                  namespace: detailIndicator.projectCode,
                                  datasetName: f.tblName,
                                })}
                              >
                                {f.tblName}
                                <GitBranch size={11} className="indicator-mgmt__field-link-icon" />
                              </span>
                            ) : (
                              f.tblName
                            )}
                          </td>
                          <td><code className="indicator-mgmt__code">{f.fieldName}</code></td>
                          <td><span className="indicator-mgmt__tag indicator-mgmt__tag--info">{f.fieldType}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="indicator-mgmt__detail-empty">
            <Eye size={32} className="indicator-mgmt__detail-empty-icon" />
            <span>选择左侧指标查看详情</span>
          </div>
        )}
      </div>

      {/* 删除确认弹窗 */}
      {deleteTarget && (
        <div className="indicator-mgmt__overlay">
          <div className="indicator-mgmt__confirm">
            <div className="indicator-mgmt__confirm-title">确认删除</div>
            <div className="indicator-mgmt__confirm-msg">
              确定要删除指标「<strong>{deleteTarget.name}</strong>」（{deleteTarget.code}）吗？此操作不可撤销。
            </div>
            <div className="indicator-mgmt__confirm-actions">
              <button
                className="indicator-mgmt__confirm-btn indicator-mgmt__confirm-btn--cancel"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                取消
              </button>
              <button
                className="indicator-mgmt__confirm-btn indicator-mgmt__confirm-btn--danger"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? '删除中...' : '删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 批量删除确认弹窗 */}
      {batchDeleteVisible && (
        <div className="indicator-mgmt__overlay">
          <div className="indicator-mgmt__confirm">
            <div className="indicator-mgmt__confirm-title">确认批量删除</div>
            <div className="indicator-mgmt__confirm-msg">
              确定要删除选中的 <strong>{selectedIds.size}</strong> 个指标吗？此操作不可撤销。
            </div>
            <div className="indicator-mgmt__confirm-actions">
              <button
                className="indicator-mgmt__confirm-btn indicator-mgmt__confirm-btn--cancel"
                onClick={() => setBatchDeleteVisible(false)}
                disabled={batchDeleting}
              >
                取消
              </button>
              <button
                className="indicator-mgmt__confirm-btn indicator-mgmt__confirm-btn--danger"
                onClick={handleBatchDelete}
                disabled={batchDeleting}
              >
                {batchDeleting ? '删除中...' : '删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default IndicatorManagementPanel;
