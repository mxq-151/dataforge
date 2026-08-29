import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Edit3, Trash2, Search, RotateCcw, List, FolderOpen, Database, FolderLock } from 'lucide-react';
import { systemPermissionApi, type MenuPermission, type MenuRoleBindVO, type MenuRoleBindDTO, type FilePermission, type TablePermissionVO, type TablePermissionDTO } from '../../../api/systemPermission';
import { projectPermissionApi, PROJECT_PERM_TYPE_MAP, PROJECT_PERM_TYPE_TAG_MAP, type ProjectPermissionVO } from '../../../api/systemProjectPermission';
import { systemRoleApi, type RoleInfo } from '../../../api/systemRole';
import { fetchAllDataSources, fetchTablesByDataSourceId } from '../../../api/datasource';
import type { DataSource, TableInfo } from '../../../api/datasource';
import { fileExplorerApi } from '../../../api/fileExplorer';
import type { StorageConfig } from '../../../api/fileExplorer';
import { fetchProjectList, type ProjectInfo } from '../../../api/devProject';
import { useToast } from '../../../components/Toast';
import MultiSelect from './MultiSelect';

const SCOPE_MAP: Record<number, string> = { 1: '整表', 2: '指定字段', 3: '指定行', 4: '组合' };
const SCOPE_TAG_MAP: Record<number, string> = { 1: 'info', 2: 'warning', 3: 'danger', 4: '' };
const PERM_TYPE_MAP: Record<number, string> = { 1: '可读', 2: '读写', 3: '完全控制' };
const PERM_TYPE_TAG_MAP: Record<number, string> = { 1: 'info', 2: 'warning', 3: 'danger' };

type PermSubTab = 'menu' | 'file' | 'table' | 'project';

interface ConfirmModalState {
  visible: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
}

const PermissionManageTab: React.FC = () => {
  const toast = useToast();
  const [activeSubTab, setActiveSubTab] = useState<PermSubTab>('menu');

  const [menuData, setMenuData] = useState<MenuRoleBindVO[]>([]);
  const [menuLoading, setMenuLoading] = useState(false);
  const [menuFilter, setMenuFilter] = useState({ keyword: '' });
  const [menuPage, setMenuPage] = useState(1);
  const [menuDialogOpen, setMenuDialogOpen] = useState(false);
  const [menuForm, setMenuForm] = useState<{ roleId: number | null; items: { menuId: number | null }[] }>({ roleId: null, items: [{ menuId: null }] });

  const [fileData, setFileData] = useState<FilePermission[]>([]);
  const [fileTotal, setFileTotal] = useState(0);
  const [filePage, setFilePage] = useState(1);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileFilter, setFileFilter] = useState({ storageType: '', pathKeyword: '' });
  const [fileDialogOpen, setFileDialogOpen] = useState(false);
  const [fileForm, setFileForm] = useState<Partial<FilePermission>>({ storageConfigId: undefined, permissionName: '', filePath: '', permissionType: 1, recursive: 0, description: '', roleIds: [] });

  const [tableData, setTableData] = useState<TablePermissionVO[]>([]);
  const [tableTotal, setTableTotal] = useState(0);
  const [tablePage, setTablePage] = useState(1);
  const [tableLoading, setTableLoading] = useState(false);
  const [tableFilter, setTableFilter] = useState({ datasourceName: '', keyword: '' });
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [tableForm, setTableForm] = useState<{
    id?: number;
    permissionName: string;
    datasourceName: string;
    databaseName: string;
    tableNames: string[];
    tableMetadataIds: number[];
    permissionScope: number;
    canSelect: number;
    canInsert: number;
    canUpdate: number;
    canDelete: number;
    canExport: number;
    rowFilterSql: string;
    dataMaskingRule: string;
    description: string;
    roleIds: number[];
    selectedDatasourceId?: number;
  }>({ permissionName: '', datasourceName: '', databaseName: '', tableNames: [], tableMetadataIds: [], canSelect: 1, canInsert: 0, canUpdate: 0, canDelete: 0, canExport: 0, permissionScope: 1, rowFilterSql: '', dataMaskingRule: '', description: '', roleIds: [] });

  const [projectPermData, setProjectPermData] = useState<ProjectPermissionVO[]>([]);
  const [projectPermLoading, setProjectPermLoading] = useState(false);
  const [projectPermFilter, setProjectPermFilter] = useState({ roleId: null as number | null, projectId: null as number | null });
  const [projectPermPage, setProjectPermPage] = useState(1);
  const [projectPermDialogOpen, setProjectPermDialogOpen] = useState(false);
  const [projectPermForm, setProjectPermForm] = useState<{ roleId: number | null; items: { projectId: number | null; permissionType: number }[] }>({ roleId: null, items: [{ projectId: null, permissionType: 1 }] });

  const [roleList, setRoleList] = useState<RoleInfo[]>([]);
  const [datasourceList, setDatasourceList] = useState<DataSource[]>([]);
  const [storageList, setStorageList] = useState<StorageConfig[]>([]);
  const [storageTypeOptions, setStorageTypeOptions] = useState<string[]>([]);
  const [projectList, setProjectList] = useState<ProjectInfo[]>([]);
  const [menuTreeList, setMenuTreeList] = useState<MenuPermission[]>([]);
  const [tableList, setTableList] = useState<TableInfo[]>([]);

  const [submitLoading, setSubmitLoading] = useState(false);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState>({ visible: false, title: '', message: '', onConfirm: () => {} });

  const filteredMenuData = useMemo(() => {
    let result = [...menuData];
    if (menuFilter.keyword) { const kw = menuFilter.keyword.toLowerCase(); result = result.filter(item => item.menuName?.toLowerCase().includes(kw) || item.menuCode?.toLowerCase().includes(kw) || item.roleName?.toLowerCase().includes(kw)); }
    return result;
  }, [menuData, menuFilter]);

  const filteredFileData = useMemo(() => {
    let result = [...fileData];
    if (fileFilter.storageType) result = result.filter(item => item.storageType === fileFilter.storageType);
    if (fileFilter.pathKeyword) { const kw = fileFilter.pathKeyword.toLowerCase(); result = result.filter(item => item.filePath?.toLowerCase().includes(kw) || item.permissionName?.toLowerCase().includes(kw)); }
    return result;
  }, [fileData, fileFilter]);

  const filteredTableData = useMemo(() => {
    let result = [...tableData];
    if (tableFilter.datasourceName) result = result.filter(item => item.datasourceName === tableFilter.datasourceName);
    if (tableFilter.keyword) { const kw = tableFilter.keyword.toLowerCase(); result = result.filter(item => item.permissionName?.toLowerCase().includes(kw) || item.tableNames?.some(n => n.toLowerCase().includes(kw))); }
    return result;
  }, [tableData, tableFilter]);

  const MENU_PAGE_SIZE = 20;
  const menuTotal = filteredMenuData.length;
  const pagedMenuData = useMemo(() => {
    const start = (menuPage - 1) * MENU_PAGE_SIZE;
    return filteredMenuData.slice(start, start + MENU_PAGE_SIZE);
  }, [filteredMenuData, menuPage]);

  const PROJECT_PAGE_SIZE = 20;
  const projectPermTotal = projectPermData.length;
  const pagedProjectPermData = useMemo(() => {
    const start = (projectPermPage - 1) * PROJECT_PAGE_SIZE;
    return projectPermData.slice(start, start + PROJECT_PAGE_SIZE);
  }, [projectPermData, projectPermPage]);

  const loadMenuData = useCallback(async () => {
    setMenuLoading(true);
    try {
      const res = await systemPermissionApi.getBinds();
      setMenuData(res.data || []);
      setMenuPage(1);
    } catch (e) { console.error(e); }
    finally { setMenuLoading(false); }
  }, []);

  const loadFileData = useCallback(async () => {
    setFileLoading(true);
    try {
      const res = await systemPermissionApi.getFilePermissionList({ current: filePage, size: 20 });
      setFileData(res.data.records || []);
      setFileTotal(res.data.total || 0);
    } catch (e) { console.error(e); }
    finally { setFileLoading(false); }
  }, [filePage]);

  const loadTableData = useCallback(async () => {
    setTableLoading(true);
    try {
      const res = await systemPermissionApi.getTablePermissionList({ current: tablePage, size: 20 });
      setTableData(res.data.records || []);
      setTableTotal(res.data.total || 0);
    } catch (e) { console.error(e); }
    finally { setTableLoading(false); }
  }, [tablePage]);

  const loadProjectPermData = useCallback(async () => {
    setProjectPermLoading(true);
    try {
      if (projectPermFilter.roleId) {
        const res = await projectPermissionApi.getByRoleId(projectPermFilter.roleId);
        setProjectPermData(res.data || []);
      } else if (projectPermFilter.projectId) {
        const res = await projectPermissionApi.getByProjectId(projectPermFilter.projectId);
        setProjectPermData(res.data || []);
      } else {
        const allResults: ProjectPermissionVO[] = [];
        for (const role of roleList) {
          try {
            const res = await projectPermissionApi.getByRoleId(role.id);
            allResults.push(...(res.data || []));
          } catch (_) {}
        }
        setProjectPermData(allResults);
      }
      setProjectPermPage(1);
    } catch (e) { console.error(e); }
    finally { setProjectPermLoading(false); }
  }, [projectPermFilter, roleList]);

  useEffect(() => {
    systemRoleApi.getAllRoles().then(res => setRoleList(res.data || [])).catch(e => console.error('Failed to load roles:', e));
    fetchAllDataSources().then(res => setDatasourceList(res.data || [])).catch(e => console.error('Failed to load datasources:', e));
    fileExplorerApi.getAllStorages().then(res => setStorageList(res.data || [])).catch(e => console.error('Failed to load storages:', e));
    fileExplorerApi.getStorageTypeOptions().then(res => setStorageTypeOptions(res.data || [])).catch(e => console.error('Failed to load storage types:', e));
    fetchProjectList({ current: 1, size: 200 }).then(res => setProjectList(res.data.records || [])).catch(e => console.error('Failed to load projects:', e));
    systemPermissionApi.getMenuTree().then(res => setMenuTreeList(res.data || [])).catch(e => console.error('Failed to load menu tree:', e));
  }, []);

  const reloadRoles = useCallback(() => {
    systemRoleApi.getAllRoles().then(res => setRoleList(res.data || [])).catch(e => console.error('Failed to reload roles:', e));
  }, []);

  const reloadStorages = useCallback(() => {
    fileExplorerApi.getAllStorages().then(res => setStorageList(res.data || [])).catch(e => console.error('Failed to reload storages:', e));
  }, []);

  const reloadDatasources = useCallback(() => {
    fetchAllDataSources().then(res => setDatasourceList(res.data || [])).catch(e => console.error('Failed to reload datasources:', e));
  }, []);

  const loadTablesByDatasource = useCallback(async (datasourceId: number) => {
    try {
      const res = await fetchTablesByDataSourceId(datasourceId);
      setTableList(res.data.records || []);
    } catch (e) {
      console.error('Failed to load tables:', e);
      setTableList([]);
    }
  }, []);

  const databaseOptions = useMemo(() => {
    const dbs = new Set<string>();
    tableList.forEach(t => { if (t.databaseName) dbs.add(t.databaseName); });
    return Array.from(dbs);
  }, [tableList]);

  const filteredTableList = useMemo(() => {
    if (!tableForm.databaseName) return tableList;
    return tableList.filter(t => t.databaseName === tableForm.databaseName);
  }, [tableList, tableForm.databaseName]);

  // 编辑模式下，表列表加载完成后通过 tableName 匹配修正 tableMetadataIds
  // （后端存储的 tableMetadataId 与表列表接口返回的 TableInfo.id 可能不一致）
  useEffect(() => {
    if (!tableForm.id || !tableForm.tableNames?.length || !tableList.length) return;
    const matchedIds = tableForm.tableNames
      .map(name => {
        const found = tableList.find(t => t.tableName === name);
        return found?.id;
      })
      .filter((id): id is number => id != null);
    // 仅当匹配结果与当前值不同时更新，避免死循环
    if (matchedIds.length > 0 && JSON.stringify(matchedIds.sort()) !== JSON.stringify(tableForm.tableMetadataIds?.sort())) {
      setTableForm(f => ({ ...f, tableMetadataIds: matchedIds }));
    }
  }, [tableForm.id, tableForm.tableNames, tableList]);

  useEffect(() => { if (activeSubTab === 'menu') loadMenuData(); }, [activeSubTab, loadMenuData]);
  useEffect(() => { if (activeSubTab === 'file') loadFileData(); }, [activeSubTab, loadFileData]);
  useEffect(() => { if (activeSubTab === 'table') loadTableData(); }, [activeSubTab, loadTableData]);
  useEffect(() => { if (activeSubTab === 'project') loadProjectPermData(); }, [activeSubTab, loadProjectPermData]);

  const handleAddMenuPerm = () => {
    setMenuForm({ roleId: null, items: [{ menuId: null }] });
    setMenuDialogOpen(true);
  };

  const handleDeleteMenuPerm = (row: MenuRoleBindVO) => {
    setConfirmModal({
      visible: true, title: '确认删除', message: `确定要删除角色"${row.roleName}"对菜单"${row.menuName}"的权限吗？`,
      onConfirm: async () => {
        try { await systemPermissionApi.deleteMenuPermission(row.id); loadMenuData(); toast.info('菜单权限已删除'); } catch (e) { toast.error(`删除失败: ${e instanceof Error ? e.message : String(e)}`); }
        setConfirmModal(prev => ({ ...prev, visible: false }));
      },
    });
  };

  const handleSubmitMenuPerm = async () => {
    if (!menuForm.roleId) { toast.warning('请选择角色'); return; }
    const validItems = menuForm.items.filter(item => item.menuId !== null);
    if (validItems.length === 0) { toast.warning('请至少添加一条菜单权限'); return; }
    setSubmitLoading(true);
    let res: any;
    try {
      const bindData: MenuRoleBindDTO[] = validItems.map(item => ({
        menuId: item.menuId!,
        roleId: menuForm.roleId!,
      }));
      res = await systemPermissionApi.bindMenuRoles(bindData);
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message || '操作失败，请稍后重试');
      return;
    } finally { setSubmitLoading(false); }
    if (res.code !== undefined && res.code !== 200) {
      toast.error(res.message || '操作失败');
      return;
    }
    setMenuDialogOpen(false);
    loadMenuData();
  };

  const handleAddFilePerm = () => {
    setFileForm({ storageConfigId: undefined, permissionName: '', filePath: '', permissionType: 1, recursive: 0, description: '', roleIds: [] });
    reloadRoles();
    reloadStorages();
    setFileDialogOpen(true);
  };

  const handleEditFilePerm = (row: FilePermission) => {
    setFileForm({ ...row, roleIds: row.roleIds || [] });
    reloadRoles();
    reloadStorages();
    setFileDialogOpen(true);
  };

  const handleDeleteFilePerm = (row: FilePermission) => {
    setConfirmModal({
      visible: true, title: '确认删除', message: `确定要删除文件权限"${row.permissionName}"吗？`,
      onConfirm: async () => {
        try { await systemPermissionApi.deleteFilePermission(row.id); loadFileData(); toast.info(`文件权限"${row.permissionName}"已删除`); } catch (e) { toast.error(`删除失败: ${e instanceof Error ? e.message : String(e)}`); }
        setConfirmModal(prev => ({ ...prev, visible: false }));
      },
    });
  };

  const handleSubmitFilePerm = async () => {
    if (!fileForm.storageConfigId && fileForm.storageConfigId !== 0) { toast.warning('请选择存储配置'); return; }
    if (!fileForm.filePath) { toast.warning('请填写文件路径'); return; }
    setSubmitLoading(true);
    let res: any;
    try {
      res = fileForm.id
        ? await systemPermissionApi.updateFilePermission(fileForm as any)
        : await systemPermissionApi.saveFilePermission(fileForm as any);
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message || '操作失败，请稍后重试');
      return;
    } finally { setSubmitLoading(false); }
    if (res.code !== undefined && res.code !== 200) {
      toast.error(res.message || '操作失败');
      return;
    }
    setFileDialogOpen(false);
    loadFileData();
  };

  const handleAddTablePerm = () => {
    setTableForm({ permissionName: '', datasourceName: '', databaseName: '', tableNames: [], tableMetadataIds: [], canSelect: 1, canInsert: 0, canUpdate: 0, canDelete: 0, canExport: 0, permissionScope: 1, rowFilterSql: '', dataMaskingRule: '', description: '', roleIds: [], selectedDatasourceId: undefined });
    setTableList([]);
    reloadRoles();
    reloadDatasources();
    setTableDialogOpen(true);
  };

  const handleEditTablePerm = (row: TablePermissionVO) => {
    const ds = datasourceList.find(d => d.datasourceName === row.datasourceName);
    setTableForm({
      id: row.id,
      permissionName: row.permissionName,
      datasourceName: row.datasourceName,
      databaseName: row.databaseName,
      tableNames: row.tableNames || [],
      tableMetadataIds: row.tableMetadataIds || [],
      permissionScope: row.permissionScope,
      canSelect: row.canSelect,
      canInsert: row.canInsert,
      canUpdate: row.canUpdate,
      canDelete: row.canDelete,
      canExport: row.canExport,
      rowFilterSql: row.rowFilterSql,
      dataMaskingRule: row.dataMaskingRule || '',
      description: row.description,
      roleIds: row.roleIds || [],
      selectedDatasourceId: ds?.id,
    });
    setTableList([]);
    reloadRoles();
    reloadDatasources();
    if (ds?.id) {
      loadTablesByDatasource(ds.id);
    }
    setTableDialogOpen(true);
  };

  const handleDeleteTablePerm = (row: TablePermissionVO) => {
    setConfirmModal({
      visible: true, title: '确认删除', message: `确定要删除库表权限"${row.permissionName}"吗？`,
      onConfirm: async () => {
        try { await systemPermissionApi.deleteTablePermission(row.id); loadTableData(); toast.info(`库表权限"${row.permissionName}"已删除`); } catch (e) { toast.error(`删除失败: ${e instanceof Error ? e.message : String(e)}`); }
        setConfirmModal(prev => ({ ...prev, visible: false }));
      },
    });
  };

  const handleSubmitTablePerm = async () => {
    if (!tableForm.permissionName) { toast.warning('请填写权限名称'); return; }
    if (!tableForm.datasourceName) { toast.warning('请选择数据源'); return; }
    if (!tableForm.databaseName) { toast.warning('请选择数据库'); return; }
    if (!tableForm.tableNames || tableForm.tableNames.length === 0) { toast.warning('请选择库表'); return; }
    setSubmitLoading(true);
    let res: any;
    try {
      const dto: TablePermissionDTO = {
        permissionName: tableForm.permissionName,
        datasourceName: tableForm.datasourceName,
        databaseName: tableForm.databaseName,
        tableNames: tableForm.tableNames,
        permissionScope: tableForm.permissionScope,
        canSelect: tableForm.canSelect,
        canInsert: tableForm.canInsert,
        canUpdate: tableForm.canUpdate,
        canDelete: tableForm.canDelete,
        canExport: tableForm.canExport,
        rowFilterSql: tableForm.rowFilterSql,
        dataMaskingRule: tableForm.dataMaskingRule || undefined,
        description: tableForm.description,
        roleIds: tableForm.roleIds,
      };
      if (tableForm.id) {
        dto.id = tableForm.id;
      }
      res = tableForm.id
        ? await systemPermissionApi.updateTablePermission(dto)
        : await systemPermissionApi.saveTablePermission(dto);
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message || '操作失败，请稍后重试');
      return;
    } finally { setSubmitLoading(false); }
    if (res.code !== undefined && res.code !== 200) {
      toast.error(res.message || '操作失败');
      return;
    }
    setTableDialogOpen(false);
    loadTableData();
  };

  const handleAddProjectPerm = () => {
    setProjectPermForm({ roleId: null, items: [{ projectId: null, permissionType: 1 }] });
    setProjectPermDialogOpen(true);
  };

  const handleDeleteProjectPerm = (row: ProjectPermissionVO) => {
    setConfirmModal({
      visible: true, title: '确认删除', message: `确定要删除角色"${row.roleName}"对项目"${row.projectName}"的权限吗？`,
      onConfirm: async () => {
        try { await projectPermissionApi.removePermission(row.roleId, row.projectId); loadProjectPermData(); toast.info(`项目权限已删除`); } catch (e) { toast.error(`删除失败: ${e instanceof Error ? e.message : String(e)}`); }
        setConfirmModal(prev => ({ ...prev, visible: false }));
      },
    });
  };

  const handleSubmitProjectPerm = async () => {
    if (!projectPermForm.roleId) { toast.warning('请选择角色'); return; }
    const validItems = projectPermForm.items.filter(item => item.projectId !== null);
    if (validItems.length === 0) { toast.warning('请至少添加一条项目权限'); return; }
    setSubmitLoading(true);
    let res: any;
    try {
      res = await projectPermissionApi.batchAssignPermissions({
        roleId: projectPermForm.roleId!,
        items: validItems as { projectId: number; permissionType: number }[],
      });
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message || '操作失败，请稍后重试');
      return;
    } finally { setSubmitLoading(false); }
    if (res.code !== undefined && res.code !== 200) {
      toast.error(res.message || '操作失败');
      return;
    }
    setProjectPermDialogOpen(false);
    loadProjectPermData();
  };

  const renderPagination = (page: number, total: number, pageSize: number, onPageChange: (p: number) => void) => {
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

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
        <button className="sys-mgmt__page-btn" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>上一页</button>
        {pages.map((p, idx) =>
          p === '...' ? (
            <span key={`ellipsis-${idx}`} className="sys-mgmt__page-ellipsis">...</span>
          ) : (
            <button
              key={p}
              className={`sys-mgmt__page-num ${page === p ? 'sys-mgmt__page-num--active' : ''}`}
              onClick={() => onPageChange(p)}
            >
              {p}
            </button>
          )
        )}
        <button className="sys-mgmt__page-btn" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>下一页</button>
        <span className="sys-mgmt__page-info">(共{total}条)</span>
      </div>
    );
  };

  const subTabs: { id: PermSubTab; label: string; icon: React.ReactNode }[] = [
    { id: 'menu', label: '菜单权限', icon: <List size={14} /> },
    { id: 'file', label: '文件权限', icon: <FolderOpen size={14} /> },
    { id: 'table', label: '库表权限', icon: <Database size={14} /> },
    { id: 'project', label: '项目权限', icon: <FolderLock size={14} /> },
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

      {activeSubTab === 'menu' && (
        <div className="sys-mgmt__section">
          <div className="sys-mgmt__toolbar">
            <div className="sys-mgmt__search-bar">
              <input className="sys-mgmt__input" placeholder="搜索菜单名称或角色名称" value={menuFilter.keyword} onChange={e => setMenuFilter(f => ({ ...f, keyword: e.target.value }))} />
              <button className="sys-mgmt__btn sys-mgmt__btn--primary" onClick={loadMenuData}><Search size={14} /> 查询</button>
              <button className="sys-mgmt__btn" onClick={() => { setMenuFilter({ keyword: '' }); loadMenuData(); }}><RotateCcw size={14} /> 重置</button>
            </div>
            <button className="sys-mgmt__btn sys-mgmt__btn--primary" onClick={handleAddMenuPerm}><Plus size={14} /> 批量分配</button>
          </div>
          <div className="sys-mgmt__table-wrap">
            <table className="sys-mgmt__table">
              <thead><tr><th>角色名称</th><th>菜单名称</th><th>菜单编码</th><th>是否可见</th><th>是否可用</th><th className="sys-mgmt__th-actions">操作</th></tr></thead>
              <tbody>
                {menuLoading ? <tr><td colSpan={6} className="sys-mgmt__table-empty">加载中...</td></tr> :
                pagedMenuData.length === 0 ? <tr><td colSpan={6} className="sys-mgmt__table-empty">暂无数据</td></tr> :
                pagedMenuData.map(row => (
                  <tr key={row.id}>
                    <td><span className="sys-mgmt__tag sys-mgmt__tag--warning">{row.roleName}</span></td>
                    <td>{row.menuName}</td>
                    <td>{row.menuCode || '-'}</td>
                    <td><span className={`sys-mgmt__tag sys-mgmt__tag--${row.visible === 1 ? 'success' : 'info'}`}>{row.visible === 1 ? '是' : '否'}</span></td>
                    <td><span className={`sys-mgmt__tag sys-mgmt__tag--${row.status === 1 ? 'success' : 'danger'}`}>{row.status === 1 ? '启用' : '禁用'}</span></td>
                    <td className="sys-mgmt__td-actions">
                      <button className="sys-mgmt__btn-link sys-mgmt__btn-link--danger" onClick={() => handleDeleteMenuPerm(row)}><Trash2 size={12} /> 删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {renderPagination(menuPage, menuTotal, MENU_PAGE_SIZE, setMenuPage)}
        </div>
      )}

      {activeSubTab === 'file' && (
        <div className="sys-mgmt__section">
          <div className="sys-mgmt__toolbar">
            <div className="sys-mgmt__search-bar">
              <select className="sys-mgmt__select sys-mgmt__select--small" value={fileFilter.storageType} onChange={e => setFileFilter(f => ({ ...f, storageType: e.target.value }))}>
                <option value="">存储类型</option>
                {storageTypeOptions.map(t => <option key={t} value={t}>{t.toUpperCase()}</option>)}
              </select>
              <input className="sys-mgmt__input" placeholder="搜索目录路径" value={fileFilter.pathKeyword} onChange={e => setFileFilter(f => ({ ...f, pathKeyword: e.target.value }))} />
              <button className="sys-mgmt__btn sys-mgmt__btn--primary"><Search size={14} /> 查询</button>
              <button className="sys-mgmt__btn" onClick={() => setFileFilter({ storageType: '', pathKeyword: '' })}><RotateCcw size={14} /> 重置</button>
            </div>
            <button className="sys-mgmt__btn sys-mgmt__btn--primary" onClick={handleAddFilePerm}><Plus size={14} /> 新增</button>
          </div>
          <div className="sys-mgmt__table-wrap">
            <table className="sys-mgmt__table">
              <thead><tr><th>权限名称</th><th>存储类型</th><th>文件/目录路径</th><th>权限类型</th><th>关联角色</th><th>递归子目录</th><th className="sys-mgmt__th-actions">操作</th></tr></thead>
              <tbody>
                {fileLoading ? <tr><td colSpan={7} className="sys-mgmt__table-empty">加载中...</td></tr> :
                filteredFileData.length === 0 ? <tr><td colSpan={7} className="sys-mgmt__table-empty">暂无数据</td></tr> :
                filteredFileData.map(row => (
                  <tr key={row.id}>
                    <td>{row.permissionName}</td>
                    <td><span className="sys-mgmt__tag">{row.storageType?.toUpperCase()}</span></td>
                    <td><code className="sys-mgmt__code">{row.filePath}</code></td>
                    <td><span className={`sys-mgmt__tag sys-mgmt__tag--${PERM_TYPE_TAG_MAP[row.permissionType] || 'info'}`}>{PERM_TYPE_MAP[row.permissionType] || '未知'}</span></td>
                    <td>{row.roleNames?.map(n => <span key={n} className="sys-mgmt__tag sys-mgmt__tag--warning" style={{ margin: '1px' }}>{n}</span>) || <span style={{ color: '#666' }}>-</span>}</td>
                    <td><span className={`sys-mgmt__tag sys-mgmt__tag--${row.recursive === 1 ? 'success' : 'info'}`}>{row.recursive === 1 ? '是' : '否'}</span></td>
                    <td className="sys-mgmt__td-actions">
                      <button className="sys-mgmt__btn-link" onClick={() => handleEditFilePerm(row)}><Edit3 size={12} /> 编辑</button>
                      <button className="sys-mgmt__btn-link sys-mgmt__btn-link--danger" onClick={() => handleDeleteFilePerm(row)}><Trash2 size={12} /> 删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {renderPagination(filePage, fileTotal, 20, setFilePage)}
        </div>
      )}

      {activeSubTab === 'table' && (
        <div className="sys-mgmt__section">
          <div className="sys-mgmt__toolbar">
            <div className="sys-mgmt__search-bar">
              <select className="sys-mgmt__select sys-mgmt__select--small" value={tableFilter.datasourceName} onChange={e => setTableFilter(f => ({ ...f, datasourceName: e.target.value }))}><option value="">数据源</option>{datasourceList.map(ds => <option key={ds.id} value={ds.datasourceName}>{ds.datasourceName}</option>)}</select>
              <input className="sys-mgmt__input" placeholder="搜索表名" value={tableFilter.keyword} onChange={e => setTableFilter(f => ({ ...f, keyword: e.target.value }))} />
              <button className="sys-mgmt__btn sys-mgmt__btn--primary" onClick={loadTableData}><Search size={14} /> 查询</button>
              <button className="sys-mgmt__btn" onClick={() => { setTableFilter({ datasourceName: '', keyword: '' }); loadTableData(); }}><RotateCcw size={14} /> 重置</button>
            </div>
            <button className="sys-mgmt__btn sys-mgmt__btn--primary" onClick={handleAddTablePerm}><Plus size={14} /> 新增</button>
          </div>
          <div className="sys-mgmt__table-wrap">
            <table className="sys-mgmt__table">
              <thead><tr><th>权限名称</th><th>数据源</th><th>数据库</th><th>表名</th><th>权限范围</th><th>CRUD权限</th><th>关联角色</th><th>行过滤SQL</th><th className="sys-mgmt__th-actions">操作</th></tr></thead>
              <tbody>
                {tableLoading ? <tr><td colSpan={9} className="sys-mgmt__table-empty">加载中...</td></tr> :
                filteredTableData.length === 0 ? <tr><td colSpan={9} className="sys-mgmt__table-empty">暂无数据</td></tr> :
                filteredTableData.map(row => (
                  <tr key={row.id}>
                    <td>{row.permissionName}</td>
                    <td>{row.datasourceName || '-'}</td>
                    <td><code className="sys-mgmt__code">{row.databaseName || '-'}</code></td>
                    <td>{row.tableNames?.map(n => <span key={n} className="sys-mgmt__tag sys-mgmt__tag--info" style={{ margin: '1px' }}>{n}</span>) || <span style={{ color: '#666' }}>-</span>}</td>
                    <td><span className={`sys-mgmt__tag sys-mgmt__tag--${SCOPE_TAG_MAP[row.permissionScope] || 'info'}`}>{SCOPE_MAP[row.permissionScope] || '未知'}</span></td>
                    <td>
                      {row.canSelect === 1 && <span className="sys-mgmt__tag sys-mgmt__tag--success" style={{ margin: '1px' }}>查询</span>}
                      {row.canInsert === 1 && <span className="sys-mgmt__tag sys-mgmt__tag--warning" style={{ margin: '1px' }}>插入</span>}
                      {row.canUpdate === 1 && <span className="sys-mgmt__tag" style={{ margin: '1px', color: '#75beff' }}>更新</span>}
                      {row.canDelete === 1 && <span className="sys-mgmt__tag sys-mgmt__tag--danger" style={{ margin: '1px' }}>删除</span>}
                      {row.canExport === 1 && <span className="sys-mgmt__tag sys-mgmt__tag--info" style={{ margin: '1px' }}>导出</span>}
                    </td>
                    <td>{row.roleNames?.map(n => <span key={n} className="sys-mgmt__tag sys-mgmt__tag--warning" style={{ margin: '1px' }}>{n}</span>) || <span style={{ color: '#666' }}>-</span>}</td>
                    <td>{row.rowFilterSql ? <code className="sys-mgmt__code" style={{ color: '#d1a855' }}>{row.rowFilterSql}</code> : <span style={{ color: '#666' }}>-</span>}</td>
                    <td className="sys-mgmt__td-actions">
                      <button className="sys-mgmt__btn-link" onClick={() => handleEditTablePerm(row)}><Edit3 size={12} /> 编辑</button>
                      <button className="sys-mgmt__btn-link sys-mgmt__btn-link--danger" onClick={() => handleDeleteTablePerm(row)}><Trash2 size={12} /> 删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {renderPagination(tablePage, tableTotal, 20, setTablePage)}
        </div>
      )}

      {activeSubTab === 'project' && (
        <div className="sys-mgmt__section">
          <div className="sys-mgmt__toolbar">
            <div className="sys-mgmt__search-bar">
              <select className="sys-mgmt__select sys-mgmt__select--small" value={projectPermFilter.roleId || ''} onChange={e => setProjectPermFilter(f => ({ ...f, roleId: e.target.value ? Number(e.target.value) : null, projectId: null }))}>
                <option value="">筛选角色</option>
                {roleList.map(r => <option key={r.id} value={r.id}>{r.roleName}</option>)}
              </select>
              <button className="sys-mgmt__btn sys-mgmt__btn--primary" onClick={loadProjectPermData}><Search size={14} /> 查询</button>
              <button className="sys-mgmt__btn" onClick={() => setProjectPermFilter({ roleId: null, projectId: null })}><RotateCcw size={14} /> 重置</button>
            </div>
            <button className="sys-mgmt__btn sys-mgmt__btn--primary" onClick={handleAddProjectPerm}><Plus size={14} /> 批量分配</button>
          </div>
          <div className="sys-mgmt__table-wrap">
            <table className="sys-mgmt__table">
              <thead><tr><th>角色名称</th><th>项目名称</th><th>权限类型</th><th>创建时间</th><th className="sys-mgmt__th-actions">操作</th></tr></thead>
              <tbody>
                {projectPermLoading ? <tr><td colSpan={5} className="sys-mgmt__table-empty">加载中...</td></tr> :
                pagedProjectPermData.length === 0 ? <tr><td colSpan={5} className="sys-mgmt__table-empty">暂无数据</td></tr> :
                pagedProjectPermData.map(row => (
                  <tr key={`${row.roleId}-${row.projectId}`}>
                    <td><span className="sys-mgmt__tag sys-mgmt__tag--warning">{row.roleName}</span></td>
                    <td>{row.projectName}</td>
                    <td><span className={`sys-mgmt__tag sys-mgmt__tag--${PROJECT_PERM_TYPE_TAG_MAP[row.permissionType] || 'info'}`}>{PROJECT_PERM_TYPE_MAP[row.permissionType] || row.permissionTypeName || '未知'}</span></td>
                    <td>{row.createTime || '-'}</td>
                    <td className="sys-mgmt__td-actions">
                      <button className="sys-mgmt__btn-link sys-mgmt__btn-link--danger" onClick={() => handleDeleteProjectPerm(row)}><Trash2 size={12} /> 删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {renderPagination(projectPermPage, projectPermTotal, PROJECT_PAGE_SIZE, setProjectPermPage)}
        </div>
      )}

      {menuDialogOpen && (
        <div className="sys-mgmt__modal-overlay">
          <div className="sys-mgmt__modal sys-mgmt__modal--wide">
            <div className="sys-mgmt__modal-header"><h3>批量分配菜单权限</h3><button className="sys-mgmt__modal-close" onClick={() => setMenuDialogOpen(false)}>×</button></div>
            <div className="sys-mgmt__modal-body">
              <div className="sys-mgmt__form-group"><label>选择角色 <span className="sys-mgmt__required">*</span></label>
                <select className="sys-mgmt__select" value={menuForm.roleId || ''} onChange={e => setMenuForm(f => ({ ...f, roleId: e.target.value ? Number(e.target.value) : null }))}>
                  <option value="">请选择角色</option>
                  {roleList.map(r => <option key={r.id} value={r.id}>{r.roleName} ({r.roleCode})</option>)}
                </select>
              </div>
              <div className="sys-mgmt__form-group">
                <label>菜单权限项 <span className="sys-mgmt__required">*</span></label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {menuForm.items.map((item, idx) => (
                    <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <select className="sys-mgmt__select" value={item.menuId ?? ''} onChange={e => {
                        const newItems = [...menuForm.items];
                        newItems[idx] = { ...newItems[idx], menuId: e.target.value ? Number(e.target.value) : null };
                        setMenuForm(f => ({ ...f, items: newItems }));
                      }} style={{ width: 250 }}>
                        <option value="">请选择菜单</option>
                        {menuTreeList.map(menu => <option key={menu.id} value={menu.id}>{menu.menuName} ({menu.menuCode})</option>)}
                      </select>
                      {menuForm.items.length > 1 && (
                        <button className="sys-mgmt__btn-link sys-mgmt__btn-link--danger" onClick={() => {
                          setMenuForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));
                        }}><Trash2 size={12} /></button>
                      )}
                    </div>
                  ))}
                  <button className="sys-mgmt__btn" onClick={() => setMenuForm(f => ({ ...f, items: [...f.items, { menuId: null }] }))}><Plus size={14} /> 添加菜单</button>
                </div>
              </div>
            </div>
            <div className="sys-mgmt__modal-footer"><button className="sys-mgmt__btn" onClick={() => setMenuDialogOpen(false)}>取消</button><button className="sys-mgmt__btn sys-mgmt__btn--primary" disabled={submitLoading} onClick={handleSubmitMenuPerm}>{submitLoading ? '提交中...' : '确定'}</button></div>
          </div>
        </div>
      )}

      {fileDialogOpen && (
        <div className="sys-mgmt__modal-overlay">
          <div className="sys-mgmt__modal">
            <div className="sys-mgmt__modal-header"><h3>{fileForm.id ? '编辑文件权限' : '新增文件权限'}</h3><button className="sys-mgmt__modal-close" onClick={() => setFileDialogOpen(false)}>×</button></div>
            <div className="sys-mgmt__modal-body">
              <div className="sys-mgmt__form-group"><label>权限名称</label><input className="sys-mgmt__input" maxLength={100} value={fileForm.permissionName || ''} onChange={e => setFileForm(f => ({ ...f, permissionName: e.target.value }))} placeholder="如：生产数据目录" /></div>
              <div className="sys-mgmt__form-group"><label>存储配置</label><select className="sys-mgmt__select" value={fileForm.storageConfigId || ''} onChange={e => setFileForm(f => ({ ...f, storageConfigId: e.target.value ? Number(e.target.value) : undefined }))}><option value="">选择存储配置</option>{storageList.map(s => <option key={s.id} value={s.id}>{s.storageName} ({s.storageType?.toUpperCase()})</option>)}</select></div>
              <div className="sys-mgmt__form-group"><label>文件路径</label><input className="sys-mgmt__input" maxLength={500} value={fileForm.filePath || ''} onChange={e => setFileForm(f => ({ ...f, filePath: e.target.value }))} placeholder="/data/production/*" /></div>
              <div className="sys-mgmt__form-group"><label>权限类型</label><div className="sys-mgmt__radio-group">{Object.entries(PERM_TYPE_MAP).map(([k, v]) => <label key={k} className="sys-mgmt__radio-item"><input type="radio" name="filePermType" checked={fileForm.permissionType === Number(k)} onChange={() => setFileForm(f => ({ ...f, permissionType: Number(k) }))} />{v}</label>)}</div></div>
              <div className="sys-mgmt__form-group"><label>递归子目录</label><div className="sys-mgmt__switch"><button className={`sys-mgmt__switch-btn ${fileForm.recursive === 1 ? 'sys-mgmt__switch-btn--active' : ''}`} onClick={() => setFileForm(f => ({ ...f, recursive: 1 }))}>是</button><button className={`sys-mgmt__switch-btn ${fileForm.recursive !== 1 ? 'sys-mgmt__switch-btn--active' : ''}`} onClick={() => setFileForm(f => ({ ...f, recursive: 0 }))}>否</button></div></div>
              <div className="sys-mgmt__form-group"><label>关联角色</label>
                <MultiSelect
                  options={roleList.map(r => ({ value: r.id, label: r.roleName, tag: r.roleCode }))}
                  selectedValues={fileForm.roleIds || []}
                  onChange={ids => setFileForm(f => ({ ...f, roleIds: ids }))}
                  placeholder="请选择角色"
                />
              </div>
              <div className="sys-mgmt__form-group"><label>描述</label><textarea className="sys-mgmt__textarea" value={fileForm.description || ''} onChange={e => setFileForm(f => ({ ...f, description: e.target.value }))} placeholder="可选填" rows={2} /></div>
            </div>
            <div className="sys-mgmt__modal-footer"><button className="sys-mgmt__btn" onClick={() => setFileDialogOpen(false)}>取消</button><button className="sys-mgmt__btn sys-mgmt__btn--primary" disabled={submitLoading} onClick={handleSubmitFilePerm}>{submitLoading ? '提交中...' : '确定'}</button></div>
          </div>
        </div>
      )}

      {tableDialogOpen && (
        <div className="sys-mgmt__modal-overlay">
          <div className="sys-mgmt__modal sys-mgmt__modal--wide">
            <div className="sys-mgmt__modal-header"><h3>{tableForm.id ? '编辑库表权限' : '新增库表权限'}</h3><button className="sys-mgmt__modal-close" onClick={() => setTableDialogOpen(false)}>×</button></div>
            <div className="sys-mgmt__modal-body">
              <div className="sys-mgmt__form-group"><label>权限名称</label><input className="sys-mgmt__input" maxLength={100} value={tableForm.permissionName || ''} onChange={e => setTableForm(f => ({ ...f, permissionName: e.target.value }))} placeholder="如：订单表只读权限" /></div>
              <div className="sys-mgmt__form-row">
                <div className="sys-mgmt__form-group"><label>选择数据源</label><select className="sys-mgmt__select" value={tableForm.selectedDatasourceId || ''} onChange={e => {
                  const dsId = e.target.value ? Number(e.target.value) : undefined;
                  const dsName = dsId ? datasourceList.find(d => d.id === dsId)?.datasourceName || '' : '';
                  setTableForm(f => ({ ...f, selectedDatasourceId: dsId, datasourceName: dsName, databaseName: '', tableNames: [], tableMetadataIds: [] }));
                  if (dsId) {
                    loadTablesByDatasource(dsId);
                  } else {
                    setTableList([]);
                  }
                }}><option value="">请选择数据源</option>{datasourceList.map(ds => <option key={ds.id} value={ds.id}>{ds.datasourceName}</option>)}</select></div>
                <div className="sys-mgmt__form-group"><label>选择数据库</label><select className="sys-mgmt__select" value={tableForm.databaseName || ''} onChange={e => setTableForm(f => ({ ...f, databaseName: e.target.value, tableNames: [], tableMetadataIds: [] }))}><option value="">请选择数据库</option>{databaseOptions.map(db => <option key={db} value={db}>{db}</option>)}</select></div>
              </div>
              <div className="sys-mgmt__form-group"><label>选择库表</label>
                <MultiSelect
                  options={filteredTableList.map(t => ({ value: t.id!, label: t.tableName, tag: t.tableType }))}
                  selectedValues={tableForm.tableMetadataIds || []}
                  onChange={ids => {
                    const selectedNames = ids
                      .map(id => tableList.find(t => t.id === id)?.tableName)
                      .filter(Boolean) as string[];
                    setTableForm(f => ({ ...f, tableMetadataIds: ids, tableNames: selectedNames }));
                  }}
                  placeholder={tableForm.selectedDatasourceId ? (filteredTableList.length === 0 ? '暂无库表数据' : '请选择库表') : '请先选择数据源'}
                />
              </div>
              <div className="sys-mgmt__form-group"><label>CRUD权限</label>
                <div className="sys-mgmt__checkbox-group">
                  <label className="sys-mgmt__checkbox-item"><input type="checkbox" checked={tableForm.canSelect === 1} onChange={e => setTableForm(f => ({ ...f, canSelect: e.target.checked ? 1 : 0 }))} />查询(Select)</label>
                  <label className="sys-mgmt__checkbox-item"><input type="checkbox" checked={tableForm.canInsert === 1} onChange={e => setTableForm(f => ({ ...f, canInsert: e.target.checked ? 1 : 0 }))} />插入(Insert)</label>
                  <label className="sys-mgmt__checkbox-item"><input type="checkbox" checked={tableForm.canUpdate === 1} onChange={e => setTableForm(f => ({ ...f, canUpdate: e.target.checked ? 1 : 0 }))} />更新(Update)</label>
                  <label className="sys-mgmt__checkbox-item"><input type="checkbox" checked={tableForm.canDelete === 1} onChange={e => setTableForm(f => ({ ...f, canDelete: e.target.checked ? 1 : 0 }))} />删除(Delete)</label>
                  <label className="sys-mgmt__checkbox-item"><input type="checkbox" checked={tableForm.canExport === 1} onChange={e => setTableForm(f => ({ ...f, canExport: e.target.checked ? 1 : 0 }))} />导出(Export)</label>
                </div>
              </div>
              <div className="sys-mgmt__form-group"><label>权限范围</label><div className="sys-mgmt__radio-group">{Object.entries(SCOPE_MAP).map(([k, v]) => <label key={k} className="sys-mgmt__radio-item"><input type="radio" name="tablePermScope" checked={tableForm.permissionScope === Number(k)} onChange={() => setTableForm(f => ({ ...f, permissionScope: Number(k) }))} />{v}</label>)}</div></div>
              {(tableForm.permissionScope === 3 || tableForm.permissionScope === 4) && <div className="sys-mgmt__form-group"><label>行过滤SQL</label><textarea className="sys-mgmt__textarea" maxLength={2000} value={tableForm.rowFilterSql || ''} onChange={e => setTableForm(f => ({ ...f, rowFilterSql: e.target.value }))} placeholder="WHERE条件，如：dept_id = 101" rows={2} /></div>}
              <div className="sys-mgmt__form-group"><label>关联角色</label>
                <MultiSelect
                  options={roleList.map(r => ({ value: r.id, label: r.roleName, tag: r.roleCode }))}
                  selectedValues={tableForm.roleIds || []}
                  onChange={ids => setTableForm(f => ({ ...f, roleIds: ids }))}
                  placeholder="请选择角色"
                />
              </div>
              <div className="sys-mgmt__form-group"><label>描述</label><textarea className="sys-mgmt__textarea" value={tableForm.description || ''} onChange={e => setTableForm(f => ({ ...f, description: e.target.value }))} placeholder="可选填" rows={2} /></div>
            </div>
            <div className="sys-mgmt__modal-footer"><button className="sys-mgmt__btn" onClick={() => setTableDialogOpen(false)}>取消</button><button className="sys-mgmt__btn sys-mgmt__btn--primary" disabled={submitLoading} onClick={handleSubmitTablePerm}>{submitLoading ? '提交中...' : '确定'}</button></div>
          </div>
        </div>
      )}

      {projectPermDialogOpen && (
        <div className="sys-mgmt__modal-overlay">
          <div className="sys-mgmt__modal sys-mgmt__modal--wide">
            <div className="sys-mgmt__modal-header"><h3>批量分配项目权限</h3><button className="sys-mgmt__modal-close" onClick={() => setProjectPermDialogOpen(false)}>×</button></div>
            <div className="sys-mgmt__modal-body">
              <div className="sys-mgmt__form-group"><label>选择角色 <span className="sys-mgmt__required">*</span></label>
                <select className="sys-mgmt__select" value={projectPermForm.roleId || ''} onChange={e => setProjectPermForm(f => ({ ...f, roleId: e.target.value ? Number(e.target.value) : null }))}>
                  <option value="">请选择角色</option>
                  {roleList.map(r => <option key={r.id} value={r.id}>{r.roleName} ({r.roleCode})</option>)}
                </select>
              </div>
              <div className="sys-mgmt__form-group">
                <label>项目权限项 <span className="sys-mgmt__required">*</span></label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {projectPermForm.items.map((item, idx) => (
                    <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <select className="sys-mgmt__select" value={item.projectId ?? ''} onChange={e => {
                        const newItems = [...projectPermForm.items];
                        newItems[idx] = { ...newItems[idx], projectId: e.target.value ? Number(e.target.value) : null };
                        setProjectPermForm(f => ({ ...f, items: newItems }));
                      }} style={{ width: 200 }}>
                        <option value="">请选择项目</option>
                        {projectList.map(p => <option key={p.id} value={p.id}>{p.projectName} ({p.projectCode})</option>)}
                      </select>
                      <select className="sys-mgmt__select" value={item.permissionType} onChange={e => {
                        const newItems = [...projectPermForm.items];
                        newItems[idx] = { ...newItems[idx], permissionType: Number(e.target.value) };
                        setProjectPermForm(f => ({ ...f, items: newItems }));
                      }} style={{ width: 120 }}>
                        {Object.entries(PROJECT_PERM_TYPE_MAP).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                      {projectPermForm.items.length > 1 && (
                        <button className="sys-mgmt__btn-link sys-mgmt__btn-link--danger" onClick={() => {
                          setProjectPermForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));
                        }}><Trash2 size={12} /></button>
                      )}
                    </div>
                  ))}
                  <button className="sys-mgmt__btn" onClick={() => setProjectPermForm(f => ({ ...f, items: [...f.items, { projectId: null, permissionType: 1 }] }))}><Plus size={14} /> 添加权限项</button>
                </div>
              </div>
            </div>
            <div className="sys-mgmt__modal-footer"><button className="sys-mgmt__btn" onClick={() => setProjectPermDialogOpen(false)}>取消</button><button className="sys-mgmt__btn sys-mgmt__btn--primary" disabled={submitLoading} onClick={handleSubmitProjectPerm}>{submitLoading ? '提交中...' : '确定'}</button></div>
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

export default PermissionManageTab;
