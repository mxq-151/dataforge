import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Edit3, Trash2, Plug, Database, HardDrive, Package, RefreshCw } from 'lucide-react';
import type { DataSource, DatasourceTypeMeta } from '../../../api/datasource';
import { fetchDatasourceList, fetchDatasourceTypes, fetchConnectionTypes, createDatasource, updateDatasource, deleteDatasource, syncDatasourceMetadata, fetchDatabasesByDatasourceConfig, testDatasourceConnectionByConfig } from '../../../api/datasource';
import type { StorageConfig } from '../../../api/fileExplorer';
import { fileExplorerApi } from '../../../api/fileExplorer';
import type { DependencyRecord } from '../../../api/dependency';
import { fetchDependencyPageList, fetchJarSources, fetchJarCategories, fetchJarProgramTypes, createJarDependency, updateJarDependency, deleteJarDependency } from '../../../api/dependency';
import { useToast } from '../../../components/Toast';

interface DataSourceFormData extends Partial<DataSource> {
  password?: string;
}

const CONNECTION_TYPE_MAP: Record<string, string> = {
  jdbc: 'JDBC', http: 'HTTP', arrow: 'Arrow Flight',
};

const DATASOURCE_TYPE_MAP: Record<string, string> = {
  mysql: 'MySQL', doris: 'Doris', clickhouse: 'ClickHouse',
  elasticsearch: 'Elasticsearch', starrocks: 'StarRocks', postgresql: 'PostgreSQL', hive: 'Hive',
};

// 存储引擎已合并为统一的 DatasourceType，由 /types 返回的 exec/store 描述「计算 / 存储」能力，
// 不再有独立的 storageEngine 字段（见 frontend-integration-changes.md）。
const SCOPE_MAP: Record<string, string> = { compile: '编译', runtime: '运行时', provided: '提供', test: '测试' };
const SOURCE_MAP: Record<string, string> = { system: '系统内置', custom: '自定义' };

const getJarStoragePlaceholder = (): string => {
  const isWindows = navigator.userAgent.includes('Windows');
  if (isWindows) {
    return 'C:\\jars\\ 或 hdfs:///jars/';
  }
  return '/opt/jars/ 或 hdfs:///jars/';
};

const jarStoragePlaceholder = getJarStoragePlaceholder();

type ConfigSubTab = 'datasource' | 'storage' | 'dependency';

interface ConfirmModalState {
  visible: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
}

const SystemConfigTab: React.FC = () => {
  const toast = useToast();
  const [activeSubTab, setActiveSubTab] = useState<ConfigSubTab>('datasource');

  const [dsList, setDsList] = useState<DataSource[]>([]);
  const [dsTotal, setDsTotal] = useState(0);
  const [dsPage, setDsPage] = useState(1);
  const [dsLoading, setDsLoading] = useState(false);
  const [dsTypes, setDsTypes] = useState<DatasourceTypeMeta[]>([]);
  const [connectionTypes, setConnectionTypes] = useState<string[]>([]);
  const [dsDialogOpen, setDsDialogOpen] = useState(false);
  const [dsDialogTitle, setDsDialogTitle] = useState('新增数据源');
  const [dsForm, setDsForm] = useState<DataSourceFormData>({ datasourceName: '', datasourceType: '', connectionType: '', url: '', databaseName: [], username: '', password: '', extraParams: '', description: '' });
  // 可访问数据库选择模态（从列表"可访问数据库"列打开）
  const [availableDatabasesFromApi, setAvailableDatabasesFromApi] = useState<string[]>([]);
  const [loadingDatabases, setLoadingDatabases] = useState(false);
  const [dbAccessModal, setDbAccessModal] = useState<{ visible: boolean; row: DataSource | null }>({ visible: false, row: null });
  const [dbAccessSelected, setDbAccessSelected] = useState<string[]>([]);
  const [dbAccessSaving, setDbAccessSaving] = useState(false);

  // 编辑模态"测试连接"状态：'idle' | 'testing' | 'success' | 'failed'
  const [dsTestStatus, setDsTestStatus] = useState<'idle' | 'testing' | 'success' | 'failed'>('idle');
  const [dsTestMessage, setDsTestMessage] = useState<string>('');
  const [stList, setStList] = useState<StorageConfig[]>([]);
  const [stTotal, setStTotal] = useState(0);
  const [stPage, setStPage] = useState(1);
  const [stLoading, setStLoading] = useState(false);
  const [stTypeOptions, setStTypeOptions] = useState<string[]>([]);
  const [stDialogOpen, setStDialogOpen] = useState(false);
  const [stDialogTitle, setStDialogTitle] = useState('新增存储');
  const [stForm, setStForm] = useState<Partial<StorageConfig> & { accessKey?: string; secretKey?: string }>({ storageName: '', storageType: 'hdfs', endpoint: '', bucketName: '', accessKey: '', secretKey: '', rootPath: '/', localMountPath: '', extraParams: '' });
  const [extraParams, setExtraParams] = useState<{ key: string; value: string }[]>([]);

  const [depList, setDepList] = useState<DependencyRecord[]>([]);
  const [depTotal, setDepTotal] = useState(0);
  const [depPage, setDepPage] = useState(1);
  const [depLoading, setDepLoading] = useState(false);
  const [depSourceOptions, setDepSourceOptions] = useState<string[]>([]);
  const [depCategoryOptions, setDepCategoryOptions] = useState<string[]>([]);
  const [depProgramTypeOptions, setDepProgramTypeOptions] = useState<string[]>([]);
  const [depDialogOpen, setDepDialogOpen] = useState(false);
  const [depDialogTitle, setDepDialogTitle] = useState('新增依赖');
  const [depForm, setDepForm] = useState<Partial<DependencyRecord>>({ jarName: '', groupId: '', artifactId: '', version: '', scope: 'compile', source: 'system', jarPath: '', repositoryUrl: '', status: 1, description: '', category: '', programType: '', autoChoose: 0 });

  const [submitLoading, setSubmitLoading] = useState(false);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState>({ visible: false, title: '', message: '', onConfirm: () => {} });

  const loadDsList = useCallback(async () => {
    setDsLoading(true);
    try {
      const res = await fetchDatasourceList(dsPage, 10);
      setDsList(res.data.records || []);
      setDsTotal(res.data.total || 0);
    } catch (e) { console.error(e); }
    finally { setDsLoading(false); }
  }, [dsPage]);

  const loadStList = useCallback(async () => {
    setStLoading(true);
    try {
      const res = await fileExplorerApi.getStorageConfigList(stPage, 10);
      setStList(res.data.records || []);
      setStTotal(res.data.total || 0);
    } catch (e) { console.error(e); }
    finally { setStLoading(false); }
  }, [stPage]);

  const loadDepList = useCallback(async () => {
    setDepLoading(true);
    try {
      const res = await fetchDependencyPageList(depPage, 10);
      setDepList(res.data.records || []);
      setDepTotal(res.data.total || 0);
    } catch (e) { console.error(e); }
    finally { setDepLoading(false); }
  }, [depPage]);

  useEffect(() => {
    loadDsList();
    fetchDatasourceTypes().then(res => setDsTypes(res.data || [])).catch(() => {});
    fetchConnectionTypes().then(res => setConnectionTypes(res.data || [])).catch(() => {});
  }, [loadDsList]);

  useEffect(() => {
    loadStList();
    fileExplorerApi.getStorageTypeOptions().then(res => setStTypeOptions(res.data || [])).catch(() => {});
  }, [loadStList]);

  useEffect(() => {
    loadDepList();
    Promise.all([fetchJarSources(), fetchJarCategories(), fetchJarProgramTypes()])
      .then(([s, c, pt]) => { setDepSourceOptions(s.data || []); setDepCategoryOptions(c.data || []); setDepProgramTypeOptions(pt.data || []); })
      .catch(() => {});
  }, [loadDepList]);

  const loadAvailableDatabases = async (dsConfig: Partial<DataSource>) => {
    setLoadingDatabases(true);
    try {
      const res = await fetchDatabasesByDatasourceConfig(dsConfig);
      setAvailableDatabasesFromApi(res.data || []);
    } catch (e) {
      console.error('加载可用数据库失败:', e);
      setAvailableDatabasesFromApi([]);
    } finally {
      setLoadingDatabases(false);
    }
  };

  // ── 可访问数据库选择（从列表"可访问数据库"列触发） ──
  const handleOpenDbAccess = (row: DataSource) => {
    setDbAccessModal({ visible: true, row });
    setDbAccessSelected(row.databaseName || []);
    setAvailableDatabasesFromApi([]);
    loadAvailableDatabases(row);
  };

  const handleDbAccessTestAndLoad = async () => {
    const row = dbAccessModal.row;
    if (!row) return;
    setLoadingDatabases(true);
    try {
      const res = await testDatasourceConnectionByConfig(row, row.id);
      if (!res.data?.success) {
        toast.error(res.data?.message || '连接测试失败');
        return;
      }
      toast.info(`连接成功 (${res.data.costTime || ''})`);
      await loadAvailableDatabases(row);
      toast.info('已加载可用数据库列表');
    } catch (e: any) {
      toast.error(e?.message || '连接测试失败');
    } finally {
      setLoadingDatabases(false);
    }
  };

  const handleDbAccessToggle = (db: string) => {
    setDbAccessSelected(prev => prev.includes(db) ? prev.filter(d => d !== db) : [...prev, db]);
  };

  const handleDbAccessSave = async () => {
    const row = dbAccessModal.row;
    if (!row) return;
    setDbAccessSaving(true);
    try {
      await updateDatasource({ ...row, databaseName: dbAccessSelected });
      toast.info('可访问数据库已更新');
      setDbAccessModal({ visible: false, row: null });
      loadDsList();
    } catch (e: any) {
      toast.error(e?.message || '保存失败');
    } finally {
      setDbAccessSaving(false);
    }
  };

  const handleDsAdd = () => {
    setDsDialogTitle('新增数据源');
    setDsForm({ datasourceName: '', datasourceType: '', connectionType: '', url: '', databaseName: [], username: '', password: '', extraParams: '', description: '' });
    setDsTestStatus('idle');
    setDsTestMessage('');
    setDsDialogOpen(true);
  };

  const handleDsEdit = (row: DataSource) => {
    setDsDialogTitle('编辑数据源');
    setDsForm({ id: row.id, datasourceName: row.datasourceName, datasourceType: row.datasourceType, connectionType: row.connectionType || '', url: row.url, databaseName: row.databaseName || [], username: row.username, password: '', extraParams: row.extraParams || '', description: row.description });
    setDsTestStatus('idle');
    setDsTestMessage('');
    setDsDialogOpen(true);
  };

  // 由 /types 富结构构建 code → 元数据 的映射，用于渲染「计算/存储」能力标签
  const dsTypeMetaMap = useMemo(() => {
    const map: Record<string, DatasourceTypeMeta> = {};
    for (const t of dsTypes) map[t.code] = t;
    return map;
  }, [dsTypes]);

  const getTypeDisplayName = (code?: string): string => {
    if (!code) return '请选择类型';
    return DATASOURCE_TYPE_MAP[code] || dsTypeMetaMap[code]?.description || code;
  };

  /** 依据 datasourceType 的 exec/store 渲染「可计算 / 可存储」能力标签 */
  const renderCapability = (datasourceType?: string): React.ReactNode => {
    if (!datasourceType) return '-';
    const meta = dsTypeMetaMap[datasourceType];
    if (!meta) return '-';
    return (
      <div className="sys-mgmt__capability">
        {meta.exec && <span className="sys-mgmt__tag sys-mgmt__tag--success">可计算</span>}
        {meta.store && <span className="sys-mgmt__tag sys-mgmt__tag--info">可存储</span>}
        {!meta.exec && !meta.store && <span className="sys-mgmt__tag">其他</span>}
      </div>
    );
  };

  // 编辑模态"测试连接"：基于当前表单内容测试连接
  const handleDsFormTest = async () => {
    if (!dsForm.datasourceType || !dsForm.connectionType || !dsForm.url || !dsForm.username || !dsForm.password) {
      toast.warning('请先填写必填项（类型、连接方式、连接URL、用户名、密码）');
      return;
    }
    setDsTestStatus('testing');
    setDsTestMessage('');
    try {
      const res = await testDatasourceConnectionByConfig(dsForm, dsForm.id);
      if (res.data?.success) {
        setDsTestStatus('success');
        setDsTestMessage(res.data?.message || `连接成功 ${res.data.costTime ? `(${res.data.costTime})` : ''}`);
        toast.info('连接测试成功');
      } else {
        setDsTestStatus('failed');
        setDsTestMessage(res.data?.message || '连接测试失败');
        toast.error(res.data?.message || '连接测试失败');
      }
    } catch (e: any) {
      setDsTestStatus('failed');
      const msg = e?.message || '连接测试失败';
      setDsTestMessage(msg);
      toast.error(msg);
    }
  };

  const handleDsSync = (row: DataSource) => {
    setConfirmModal({
      visible: true, title: '元数据同步', message: `确定要同步数据源"${row.datasourceName}"的元数据吗？`,
      onConfirm: async () => {
        try {
          await syncDatasourceMetadata(row.id);
          toast.info('元数据同步成功');
          loadDsList();
        } catch (e: any) { toast.error(e?.message || '元数据同步失败'); }
        setConfirmModal(prev => ({ ...prev, visible: false }));
      },
    });
  };

  const handleDsDelete = (row: DataSource) => {
    setConfirmModal({
      visible: true, title: '确认删除', message: `确定要删除数据源"${row.datasourceName}"吗？`,
      onConfirm: async () => {
        try { await deleteDatasource(row.id); loadDsList(); } catch (e) { console.error(e); }
        setConfirmModal(prev => ({ ...prev, visible: false }));
      },
    });
  };

  const handleDsSubmit = async () => {
    if (!dsForm.datasourceName || !dsForm.datasourceType || !dsForm.connectionType || !dsForm.url || !dsForm.username || !dsForm.password) { toast.warning('请填写必填项（数据源名称、类型、连接方式、连接URL、用户名、密码）'); return; }
    // 测试连接未通过不允许保存
    if (dsTestStatus !== 'success') {
      toast.warning('请先进行连接测试，测试通过后方可保存');
      return;
    }
    setSubmitLoading(true);
    try {
      if (dsForm.id) await updateDatasource(dsForm);
      else await createDatasource(dsForm);
      setDsDialogOpen(false);
      loadDsList();
    } catch (e) { console.error(e); }
    finally { setSubmitLoading(false); }
  };

  const handleStAdd = () => {
    setStDialogTitle('新增存储');
    setStForm({ storageName: '', storageType: 'hdfs', endpoint: '', bucketName: '', accessKey: '', secretKey: '', rootPath: '/', localMountPath: '', extraParams: '' });
    setExtraParams([]);
    setStDialogOpen(true);
  };

  const handleStEdit = (row: StorageConfig) => {
    setStDialogTitle('编辑存储');
    setStForm({ id: row.id, storageName: row.storageName, storageType: row.storageType, endpoint: row.endpoint, bucketName: row.bucketName, accessKey: '', secretKey: '', rootPath: row.rootPath, localMountPath: row.localMountPath, extraParams: row.extraParams });
    parseExtraParams(row.extraParams);
    setStDialogOpen(true);
  };

  const handleStTest = async (row: StorageConfig) => {
    try {
      const res = await fileExplorerApi.testStorageConnection(row.id);
      if (res.data?.success) toast.info('连接成功');
      else toast.error(res.data?.message || '连接失败');
      loadStList();
    } catch (e: any) { toast.error(e?.message || '连接测试失败'); }
  };

  const handleStDelete = (row: StorageConfig) => {
    setConfirmModal({
      visible: true, title: '确认删除', message: `确定要删除存储"${row.storageName}"吗？`,
      onConfirm: async () => {
        try { await fileExplorerApi.deleteStorage(row.id); loadStList(); } catch (e) { console.error(e); }
        setConfirmModal(prev => ({ ...prev, visible: false }));
      },
    });
  };

  const handleStSubmit = async () => {
    if (!stForm.storageName || !stForm.storageType) { toast.warning('请填写必填项'); return; }
    setSubmitLoading(true);
    try {
      const submitData = { ...stForm, extraParams: buildExtraParamsJson() };
      if (stForm.id) await fileExplorerApi.updateStorage(submitData as any);
      else await fileExplorerApi.createStorage(submitData as any);
      setStDialogOpen(false);
      loadStList();
    } catch (e) { console.error(e); }
    finally { setSubmitLoading(false); }
  };

  const parseExtraParams = (ep: string | undefined) => {
    const result: { key: string; value: string }[] = [];
    if (!ep || ep.trim() === '') { setExtraParams(result); return; }
    try {
      const obj = JSON.parse(ep);
      Object.entries(obj).forEach(([k, v]) => { if (k.trim()) result.push({ key: k.trim(), value: String(v).trim() }); });
    } catch { const pairs = ep.split(','); for (const p of pairs) { const [k, ...v] = p.split('='); if (k?.trim()) result.push({ key: k.trim(), value: v.join('=').trim() }); } }
    setExtraParams(result);
  };

  const buildExtraParamsJson = () => {
    const obj: Record<string, string> = {};
    extraParams.filter(p => p.key.trim() && p.value.trim()).forEach(p => { obj[p.key.trim()] = p.value.trim(); });
    return JSON.stringify(obj);
  };

  const handleDepAdd = () => {
    setDepDialogTitle('新增依赖');
    setDepForm({ jarName: '', groupId: '', artifactId: '', version: '', scope: 'compile', source: 'system', jarPath: '', repositoryUrl: '', status: 1, description: '', category: '', programType: '', autoChoose: 0 });
    setDepDialogOpen(true);
  };

  const handleDepEdit = (row: DependencyRecord) => {
    setDepDialogTitle('编辑依赖');
    setDepForm({ id: row.id, jarName: row.jarName, groupId: row.groupId, artifactId: row.artifactId, version: row.version, scope: 'compile', source: row.source, jarPath: row.jarPath, repositoryUrl: row.repositoryUrl, status: row.status, description: row.description, category: row.category, programType: row.programType || '', autoChoose: row.autoChoose || 0 });
    setDepDialogOpen(true);
  };

  const handleDepDelete = (row: DependencyRecord) => {
    setConfirmModal({
      visible: true, title: '确认删除', message: `确定要删除依赖"${row.jarName}"吗？`,
      onConfirm: async () => {
        try { await deleteJarDependency(row.id); loadDepList(); } catch (e) { console.error(e); }
        setConfirmModal(prev => ({ ...prev, visible: false }));
      },
    });
  };

  const handleDepSubmit = async () => {
    if (!depForm.jarName || !depForm.source || !depForm.programType) { toast.warning('请填写必填项（JAR包名称、来源、程序类型）'); return; }
    if (depForm.source === 'custom' && !depForm.jarPath) { toast.warning('来源为自定义时，必须填写存储目录'); return; }
    setSubmitLoading(true);
    try {
      if (depForm.id) await updateJarDependency(depForm);
      else await createJarDependency(depForm);
      setDepDialogOpen(false);
      loadDepList();
    } catch (e) { console.error(e); }
    finally { setSubmitLoading(false); }
  };

  const renderPagination = (page: number, total: number, onPageChange: (p: number) => void) => {
    const totalPages = Math.ceil(total / 10);
    if (totalPages <= 1) return null;
    return (
      <div className="sys-mgmt__pagination">
        <button className="sys-mgmt__page-btn" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>上一页</button>
        <span className="sys-mgmt__page-info">{page} / {totalPages} (共{total}条)</span>
        <button className="sys-mgmt__page-btn" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>下一页</button>
      </div>
    );
  };

  const subTabs: { id: ConfigSubTab; label: string; icon: React.ReactNode }[] = [
    { id: 'datasource', label: '数据源配置', icon: <Database size={14} /> },
    { id: 'storage', label: '存储配置', icon: <HardDrive size={14} /> },
    { id: 'dependency', label: '依赖包配置', icon: <Package size={14} /> },
  ];

  return (
    <div className="sys-mgmt__config">
      <div className="sys-mgmt__sub-tabs">
        {subTabs.map(t => (
          <button key={t.id} className={`sys-mgmt__sub-tab ${activeSubTab === t.id ? 'sys-mgmt__sub-tab--active' : ''}`} onClick={() => setActiveSubTab(t.id)}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {activeSubTab === 'datasource' && (
        <div className="sys-mgmt__section">
          <div className="sys-mgmt__toolbar">
            <h3 className="sys-mgmt__section-title">数据源配置</h3>
            <button className="sys-mgmt__btn sys-mgmt__btn--primary" onClick={handleDsAdd}><Plus size={14} /> 新增数据源</button>
          </div>
          <div className="sys-mgmt__table-wrap">
            <table className="sys-mgmt__table">
              <thead><tr><th>数据源名称</th><th>类型</th><th>连接方式</th><th>能力</th><th>连接地址</th><th>可访问数据库</th><th>状态</th><th>最后测试</th><th className="sys-mgmt__th-actions">操作</th></tr></thead>
              <tbody>
                {dsLoading ? <tr><td colSpan={9} className="sys-mgmt__table-empty">加载中...</td></tr> :
                dsList.length === 0 ? <tr><td colSpan={9} className="sys-mgmt__table-empty">暂无数据</td></tr> :
                dsList.map(row => (
                  <tr key={row.id}>
                    <td>{row.datasourceName}</td>
                    <td><span className="sys-mgmt__tag">{getTypeDisplayName(row.datasourceType)}</span></td>
                    <td><span className="sys-mgmt__tag sys-mgmt__tag--info">{CONNECTION_TYPE_MAP[row.connectionType || ''] || row.connectionType || '-'}</span></td>
                    <td>{renderCapability(row.datasourceType)}</td>
                    <td className="sys-mgmt__td-ellipsis" title={row.url}>{row.url || '-'}</td>
                    <td>
                      <button
                        className="sys-mgmt__db-access-cell"
                        onClick={() => handleOpenDbAccess(row)}
                        title="点击管理可访问数据库"
                      >
                        {row.databaseName && row.databaseName.length > 0 ? (
                          <span className="sys-mgmt__database-count">{row.databaseName.length}个</span>
                        ) : (
                          <span className="sys-mgmt__text-muted">全部</span>
                        )}
                      </button>
                    </td>
                    <td><span className={`sys-mgmt__tag sys-mgmt__tag--${row.connectionStatus === 1 ? 'success' : row.connectionStatus === 2 ? 'danger' : 'info'}`}>{row.connectionStatus === 1 ? '正常' : row.connectionStatus === 2 ? '异常' : '未测试'}</span></td>
                    <td>{row.lastTestTime || '-'}</td>
                    <td className="sys-mgmt__td-actions">
                      <button className="sys-mgmt__btn-link" onClick={() => handleDsEdit(row)}><Edit3 size={12} /> 编辑</button>
                      <button className="sys-mgmt__btn-link sys-mgmt__btn-link--warning" onClick={() => handleDsSync(row)}><RefreshCw size={12} /> 同步</button>
                      <button className="sys-mgmt__btn-link sys-mgmt__btn-link--danger" onClick={() => handleDsDelete(row)}><Trash2 size={12} /> 删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {renderPagination(dsPage, dsTotal, setDsPage)}
        </div>
      )}

      {activeSubTab === 'storage' && (
        <div className="sys-mgmt__section">
          <div className="sys-mgmt__toolbar">
            <h3 className="sys-mgmt__section-title">存储配置</h3>
            <button className="sys-mgmt__btn sys-mgmt__btn--primary" onClick={handleStAdd}><Plus size={14} /> 新增存储</button>
          </div>
          <div className="sys-mgmt__table-wrap">
            <table className="sys-mgmt__table">
              <thead><tr><th>存储名称</th><th>类型</th><th>访问端点</th><th>根路径</th><th>状态</th><th className="sys-mgmt__th-actions">操作</th></tr></thead>
              <tbody>
                {stLoading ? <tr><td colSpan={6} className="sys-mgmt__table-empty">加载中...</td></tr> :
                stList.length === 0 ? <tr><td colSpan={6} className="sys-mgmt__table-empty">暂无数据</td></tr> :
                stList.map(row => (
                  <tr key={row.id}>
                    <td>{row.storageName}</td>
                    <td><span className="sys-mgmt__tag">{row.storageType?.toUpperCase()}</span></td>
                    <td className="sys-mgmt__td-ellipsis" title={row.endpoint}>{row.endpoint || '-'}</td>
                    <td>{row.rootPath || '-'}</td>
                    <td><span className={`sys-mgmt__tag sys-mgmt__tag--${row.status === 1 ? 'success' : row.status === 2 ? 'danger' : 'info'}`}>{row.status === 1 ? '正常' : row.status === 2 ? '异常' : '未测试'}</span></td>
                    <td className="sys-mgmt__td-actions">
                      <button className="sys-mgmt__btn-link" onClick={() => handleStTest(row)}><Plug size={12} /> 测试</button>
                      <button className="sys-mgmt__btn-link" onClick={() => handleStEdit(row)}><Edit3 size={12} /> 编辑</button>
                      <button className="sys-mgmt__btn-link sys-mgmt__btn-link--danger" onClick={() => handleStDelete(row)}><Trash2 size={12} /> 删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {renderPagination(stPage, stTotal, setStPage)}
        </div>
      )}

      {activeSubTab === 'dependency' && (
        <div className="sys-mgmt__section">
          <div className="sys-mgmt__toolbar">
            <h3 className="sys-mgmt__section-title">依赖包配置</h3>
            <button className="sys-mgmt__btn sys-mgmt__btn--primary" onClick={handleDepAdd}><Plus size={14} /> 新增依赖</button>
          </div>
          <div className="sys-mgmt__table-wrap">
            <table className="sys-mgmt__table">
              <thead><tr><th>JAR包名称</th><th>Group ID</th><th>Artifact ID</th><th>版本号</th><th>作用域</th><th>来源</th><th>分类</th><th>程序类型</th><th>状态</th><th className="sys-mgmt__th-actions">操作</th></tr></thead>
              <tbody>
                {depLoading ? <tr><td colSpan={10} className="sys-mgmt__table-empty">加载中...</td></tr> :
                depList.length === 0 ? <tr><td colSpan={10} className="sys-mgmt__table-empty">暂无数据</td></tr> :
                depList.map(row => (
                  <tr key={row.id}>
                    <td className="sys-mgmt__td-ellipsis" title={row.jarName}>{row.jarName}</td>
                    <td className="sys-mgmt__td-ellipsis" title={row.groupId}>{row.groupId || '-'}</td>
                    <td className="sys-mgmt__td-ellipsis" title={row.artifactId}>{row.artifactId || '-'}</td>
                    <td>{row.version || '-'}</td>
                    <td><span className="sys-mgmt__tag sys-mgmt__tag--info">{SCOPE_MAP[row.scope] || row.scope}</span></td>
                    <td><span className="sys-mgmt__tag">{SOURCE_MAP[row.source] || row.source}</span></td>
                    <td>{row.category ? <span className="sys-mgmt__tag sys-mgmt__tag--warning">{row.category}</span> : '-'}</td>
                    <td><span className="sys-mgmt__tag sys-mgmt__tag--info">{row.programType || '-'}</span></td>
                    <td><span className={`sys-mgmt__tag sys-mgmt__tag--${row.status === 1 ? 'success' : 'danger'}`}>{row.status === 1 ? '正常' : '禁用'}</span></td>
                    <td className="sys-mgmt__td-actions">
                      <button className="sys-mgmt__btn-link" onClick={() => handleDepEdit(row)}><Edit3 size={12} /> 编辑</button>
                      <button className="sys-mgmt__btn-link sys-mgmt__btn-link--danger" onClick={() => handleDepDelete(row)}><Trash2 size={12} /> 删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {renderPagination(depPage, depTotal, setDepPage)}
        </div>
      )}

      {dsDialogOpen && (
        <div className="sys-mgmt__modal-overlay">
          <div className="sys-mgmt__modal">
            <div className="sys-mgmt__modal-header"><h3>{dsDialogTitle}</h3><button className="sys-mgmt__modal-close" onClick={() => setDsDialogOpen(false)}>×</button></div>
            <div className="sys-mgmt__modal-body">
              <div className="sys-mgmt__form-group"><label>数据源名称 <span className="sys-mgmt__required">*</span></label><input className="sys-mgmt__input" value={dsForm.datasourceName || ''} onChange={e => setDsForm(f => ({ ...f, datasourceName: e.target.value }))} placeholder="请输入数据源名称" /></div>
              <div className="sys-mgmt__form-row">
                <div className="sys-mgmt__form-group"><label>类型 <span className="sys-mgmt__required">*</span></label><select className="sys-mgmt__select" value={dsForm.datasourceType || ''} onChange={e => setDsForm(f => ({ ...f, datasourceType: e.target.value }))}><option value="">请选择类型</option>{dsTypes.map(t => <option key={t.code} value={t.code}>{getTypeDisplayName(t.code)}</option>)}</select></div>
                <div className="sys-mgmt__form-group"><label>连接方式 <span className="sys-mgmt__required">*</span></label><select className="sys-mgmt__select" value={dsForm.connectionType || ''} onChange={e => setDsForm(f => ({ ...f, connectionType: e.target.value }))}><option value="">请选择连接方式</option>{connectionTypes.map(t => <option key={t} value={t}>{CONNECTION_TYPE_MAP[t] || t}</option>)}</select></div>
              </div>
              {dsForm.datasourceType && dsTypeMetaMap[dsForm.datasourceType] && (
                <div className="sys-mgmt__form-group"><label>能力</label>{renderCapability(dsForm.datasourceType)}</div>
              )}
              <div className="sys-mgmt__form-group"><label>连接URL <span className="sys-mgmt__required">*</span></label><input className="sys-mgmt__input" maxLength={255} value={dsForm.url || ''} onChange={e => setDsForm(f => ({ ...f, url: e.target.value }))} placeholder="请输入连接URL" /></div>
              <div className="sys-mgmt__form-row">
                <div className="sys-mgmt__form-group"><label>用户名 <span className="sys-mgmt__required">*</span></label><input className="sys-mgmt__input" value={dsForm.username || ''} onChange={e => setDsForm(f => ({ ...f, username: e.target.value }))} placeholder="请输入用户名" /></div>
                <div className="sys-mgmt__form-group"><label>密码 <span className="sys-mgmt__required">*</span></label><input className="sys-mgmt__input" type="password" value={dsForm.password || ''} onChange={e => setDsForm(f => ({ ...f, password: e.target.value }))} placeholder="请输入密码" /></div>
              </div>
              <div className="sys-mgmt__form-group"><label>额外参数</label><input className="sys-mgmt__input" value={dsForm.extraParams || ''} onChange={e => setDsForm(f => ({ ...f, extraParams: e.target.value }))} placeholder="可选填额外连接参数" /></div>
              <div className="sys-mgmt__form-group"><label>描述</label><textarea className="sys-mgmt__textarea" value={dsForm.description || ''} onChange={e => setDsForm(f => ({ ...f, description: e.target.value }))} placeholder="可选填描述" rows={2} /></div>
              <div className="sys-mgmt__ds-test-row">
                <button type="button" className="sys-mgmt__btn" disabled={dsTestStatus === 'testing'} onClick={handleDsFormTest}>
                  {dsTestStatus === 'testing' ? '测试中...' : '测试连接'}
                </button>
                <span className={`sys-mgmt__ds-test-msg ${dsTestStatus === 'success' ? 'is-success' : dsTestStatus === 'failed' ? 'is-failed' : ''}`}>
                  {dsTestStatus === 'success' && '✓ '}{dsTestStatus === 'failed' && '✗ '}{dsTestMessage}
                </span>
              </div>
            </div>
            <div className="sys-mgmt__modal-footer"><button className="sys-mgmt__btn" onClick={() => setDsDialogOpen(false)}>取消</button><button className="sys-mgmt__btn sys-mgmt__btn--primary" disabled={submitLoading || dsTestStatus === 'testing' || dsTestStatus !== 'success'} onClick={handleDsSubmit}>{submitLoading ? '提交中...' : '确定'}</button></div>
          </div>
        </div>
      )}

      {stDialogOpen && (
        <div className="sys-mgmt__modal-overlay">
          <div className="sys-mgmt__modal">
            <div className="sys-mgmt__modal-header"><h3>{stDialogTitle}</h3><button className="sys-mgmt__modal-close" onClick={() => setStDialogOpen(false)}>×</button></div>
            <div className="sys-mgmt__modal-body">
              <div className="sys-mgmt__form-group"><label>存储名称 <span className="sys-mgmt__required">*</span></label><input className="sys-mgmt__input" value={stForm.storageName || ''} onChange={e => setStForm(f => ({ ...f, storageName: e.target.value }))} placeholder="请输入存储名称" /></div>
              <div className="sys-mgmt__form-group"><label>存储类型 <span className="sys-mgmt__required">*</span></label><select className="sys-mgmt__select" value={stForm.storageType || 'hdfs'} onChange={e => setStForm(f => ({ ...f, storageType: e.target.value }))}>{stTypeOptions.map(t => <option key={t} value={t}>{t.toUpperCase()}</option>)}{stTypeOptions.length === 0 && <option value="hdfs">HDFS</option>}{stTypeOptions.length === 0 && <option value="s3">S3</option>}{stTypeOptions.length === 0 && <option value="juicefs">JUICEFS</option>}</select></div>
              {stForm.storageType === 'hdfs' && <div className="sys-mgmt__form-group"><label>访问端点</label><input className="sys-mgmt__input" value={stForm.endpoint || ''} onChange={e => setStForm(f => ({ ...f, endpoint: e.target.value }))} placeholder="hdfs://namenode:8020" /></div>}
              {stForm.storageType === 's3' && (<>
                <div className="sys-mgmt__form-group"><label>Endpoint</label><input className="sys-mgmt__input" value={stForm.endpoint || ''} onChange={e => setStForm(f => ({ ...f, endpoint: e.target.value }))} placeholder="https://s3.amazonaws.com" /></div>
                <div className="sys-mgmt__form-group"><label>Bucket名称</label><input className="sys-mgmt__input" value={stForm.bucketName || ''} onChange={e => setStForm(f => ({ ...f, bucketName: e.target.value }))} placeholder="请输入Bucket名称" /></div>
                <div className="sys-mgmt__form-row">
                  <div className="sys-mgmt__form-group"><label>Access Key</label><input className="sys-mgmt__input" value={stForm.accessKey || ''} onChange={e => setStForm(f => ({ ...f, accessKey: e.target.value }))} placeholder="请输入Access Key" /></div>
                  <div className="sys-mgmt__form-group"><label>Secret Key</label><input className="sys-mgmt__input" type="password" value={stForm.secretKey || ''} onChange={e => setStForm(f => ({ ...f, secretKey: e.target.value }))} placeholder="请输入Secret Key" /></div>
                </div>
              </>)}
              {stForm.storageType === 'juicefs' && <div className="sys-mgmt__form-group"><label>挂载路径</label><input className="sys-mgmt__input" value={stForm.localMountPath || ''} onChange={e => setStForm(f => ({ ...f, localMountPath: e.target.value }))} placeholder="/mnt/juicefs" /></div>}
              <div className="sys-mgmt__form-group"><label>根路径</label><input className="sys-mgmt__input" value={stForm.rootPath || '/'} onChange={e => setStForm(f => ({ ...f, rootPath: e.target.value }))} placeholder="/" /></div>
              <div className="sys-mgmt__form-group"><label>额外参数</label>
                <div className="sys-mgmt__extra-params">
                  {extraParams.map((p, i) => (
                    <div key={i} className="sys-mgmt__param-row">
                      <input className="sys-mgmt__input sys-mgmt__param-input" value={p.key} onChange={e => { const np = [...extraParams]; np[i] = { ...np[i], key: e.target.value }; setExtraParams(np); }} placeholder="参数名" />
                      <span className="sys-mgmt__param-eq">=</span>
                      <input className="sys-mgmt__input sys-mgmt__param-input" value={p.value} onChange={e => { const np = [...extraParams]; np[i] = { ...np[i], value: e.target.value }; setExtraParams(np); }} placeholder="参数值" />
                      <button className="sys-mgmt__btn-link sys-mgmt__btn-link--danger" onClick={() => setExtraParams(prev => prev.filter((_, idx) => idx !== i))}><Trash2 size={12} /></button>
                    </div>
                  ))}
                  <button className="sys-mgmt__btn sys-mgmt__btn--small" onClick={() => setExtraParams(prev => [...prev, { key: '', value: '' }])}>+ 添加参数</button>
                </div>
              </div>
            </div>
            <div className="sys-mgmt__modal-footer"><button className="sys-mgmt__btn" onClick={() => setStDialogOpen(false)}>取消</button><button className="sys-mgmt__btn sys-mgmt__btn--primary" disabled={submitLoading} onClick={handleStSubmit}>{submitLoading ? '提交中...' : '确定'}</button></div>
          </div>
        </div>
      )}

      {depDialogOpen && (
        <div className="sys-mgmt__modal-overlay">
          <div className="sys-mgmt__modal">
            <div className="sys-mgmt__modal-header"><h3>{depDialogTitle}</h3><button className="sys-mgmt__modal-close" onClick={() => setDepDialogOpen(false)}>×</button></div>
            <div className="sys-mgmt__modal-body">
              <div className="sys-mgmt__form-group"><label>JAR包名称 <span className="sys-mgmt__required">*</span></label><input className="sys-mgmt__input" value={depForm.jarName || ''} onChange={e => setDepForm(f => ({ ...f, jarName: e.target.value }))} placeholder="请输入JAR包名称" /></div>
              <div className="sys-mgmt__form-group"><label>来源 <span className="sys-mgmt__required">*</span></label><select className="sys-mgmt__select" value={depForm.source || 'system'} onChange={e => setDepForm(f => ({ ...f, source: e.target.value, repositoryUrl: '' }))}>{depSourceOptions.map(s => <option key={s} value={s}>{SOURCE_MAP[s] || s}</option>)}{depSourceOptions.length === 0 && Object.entries(SOURCE_MAP).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
              <div className="sys-mgmt__form-row">
                <div className="sys-mgmt__form-group"><label>Group ID</label><input className="sys-mgmt__input" value={depForm.groupId || ''} onChange={e => setDepForm(f => ({ ...f, groupId: e.target.value }))} placeholder="org.apache.spark" /></div>
                <div className="sys-mgmt__form-group"><label>Artifact ID</label><input className="sys-mgmt__input" value={depForm.artifactId || ''} onChange={e => setDepForm(f => ({ ...f, artifactId: e.target.value }))} placeholder="spark-sql_2.12" /></div>
              </div>
              <div className="sys-mgmt__form-row">
                <div className="sys-mgmt__form-group"><label>版本号</label><input className="sys-mgmt__input" value={depForm.version || ''} onChange={e => setDepForm(f => ({ ...f, version: e.target.value }))} placeholder="3.5.0" /></div>
                <div className="sys-mgmt__form-group"><label>功能分类</label><select className="sys-mgmt__select" value={depForm.category || ''} onChange={e => setDepForm(f => ({ ...f, category: e.target.value }))}><option value="">请选择</option>{depCategoryOptions.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
              </div>
              <div className="sys-mgmt__form-row">
                <div className="sys-mgmt__form-group"><label>程序类型 <span className="sys-mgmt__required">*</span></label><select className="sys-mgmt__select" value={depForm.programType || ''} onChange={e => setDepForm(f => ({ ...f, programType: e.target.value }))}><option value="">请选择程序类型</option>{depProgramTypeOptions.map(pt => <option key={pt} value={pt}>{pt}</option>)}</select></div>
                <div className="sys-mgmt__form-group"><label>自动选择</label><select className="sys-mgmt__select" value={String(depForm.autoChoose || 0)} onChange={e => setDepForm(f => ({ ...f, autoChoose: Number(e.target.value) }))}><option value="0">否</option><option value="1">是</option></select></div>
              </div>
              <div className="sys-mgmt__form-group"><label>存储目录 {depForm.source === 'custom' && <span className="sys-mgmt__required">*</span>}</label><input className="sys-mgmt__input" value={depForm.jarPath || ''} onChange={e => setDepForm(f => ({ ...f, jarPath: e.target.value }))} placeholder={jarStoragePlaceholder} /></div>
              <div className="sys-mgmt__form-group"><label>描述</label><textarea className="sys-mgmt__textarea" value={depForm.description || ''} onChange={e => setDepForm(f => ({ ...f, description: e.target.value }))} placeholder="请输入描述" rows={2} /></div>
            </div>
            <div className="sys-mgmt__modal-footer"><button className="sys-mgmt__btn" onClick={() => setDepDialogOpen(false)}>取消</button><button className="sys-mgmt__btn sys-mgmt__btn--primary" disabled={submitLoading} onClick={handleDepSubmit}>{submitLoading ? '提交中...' : '确定'}</button></div>
          </div>
        </div>
      )}

      {dbAccessModal.visible && dbAccessModal.row && (
        <div className="sys-mgmt__modal-overlay">
          <div className="sys-mgmt__modal">
            <div className="sys-mgmt__modal-header">
              <h3>可访问数据库 - {dbAccessModal.row.datasourceName}</h3>
              <button className="sys-mgmt__modal-close" onClick={() => setDbAccessModal({ visible: false, row: null })}>×</button>
            </div>
            <div className="sys-mgmt__modal-body">
              <div className="sys-mgmt__database-section">
                <button
                  className="sys-mgmt__btn sys-mgmt__btn--small sys-mgmt__btn--primary"
                  onClick={handleDbAccessTestAndLoad}
                  disabled={loadingDatabases}
                >
                  {loadingDatabases ? '加载中...' : '测试连接并加载数据库'}
                </button>
                {availableDatabasesFromApi.length > 0 && (
                  <div className="sys-mgmt__database-select-wrapper">
                    <div className="sys-mgmt__db-checkbox-list">
                      {availableDatabasesFromApi.map(db => (
                        <label key={db} className="sys-mgmt__db-checkbox-item">
                          <input
                            type="checkbox"
                            checked={dbAccessSelected.includes(db)}
                            onChange={() => handleDbAccessToggle(db)}
                          />
                          <span>{db}</span>
                        </label>
                      ))}
                    </div>
                    <p className="sys-mgmt__form-hint">
                      已选择 {dbAccessSelected.length} 个数据库
                      {dbAccessSelected.length === 0 && ' (留空表示可访问所有数据库)'}
                    </p>
                  </div>
                )}
                {loadingDatabases && <p className="sys-mgmt__form-hint">正在加载可用数据库...</p>}
                {!loadingDatabases && availableDatabasesFromApi.length === 0 && (
                  <p className="sys-mgmt__form-hint">暂无可用数据库，请点击上方按钮加载</p>
                )}
                {dbAccessSelected.length > 0 && (
                  <div className="sys-mgmt__selected-databases">
                    <span className="sys-mgmt__selected-label">已选择:</span>
                    {dbAccessSelected.map((db, index) => (
                      <span key={index} className="sys-mgmt__database-tag">
                        {db}
                        <button
                          className="sys-mgmt__database-tag-remove"
                          onClick={() => setDbAccessSelected(prev => prev.filter((_: string, i: number) => i !== index))}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="sys-mgmt__modal-footer">
              <button className="sys-mgmt__btn" onClick={() => setDbAccessModal({ visible: false, row: null })}>取消</button>
              <button className="sys-mgmt__btn sys-mgmt__btn--primary" disabled={dbAccessSaving} onClick={handleDbAccessSave}>
                {dbAccessSaving ? '保存中...' : '确定'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmModal.visible && (
        <div className="sys-mgmt__modal-overlay">
          <div className="sys-mgmt__confirm-dialog">
            <h3>{confirmModal.title}</h3>
            <p>{confirmModal.message}</p>
            <div className="sys-mgmt__confirm-actions">
              <button className="sys-mgmt__btn" onClick={() => setConfirmModal(prev => ({ ...prev, visible: false }))}>取消</button>
              <button className="sys-mgmt__btn sys-mgmt__btn--danger" onClick={confirmModal.onConfirm}>确定</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SystemConfigTab;
