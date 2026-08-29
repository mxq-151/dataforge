import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, Edit3, Trash2, UserCheck, Shield, Search, RotateCcw, Building2, Link2, Unlink, KeyRound } from 'lucide-react';
import { systemUserApi, type UserInfo, type ChangePasswordDTO } from '../../../api/systemUser';
import { systemRoleApi, type RoleInfo } from '../../../api/systemRole';
import { tenantApi, type TenantVO, type TenantDTO } from '../../../api/systemTenant';
import MultiSelect from './MultiSelect';
import { useToast } from '../../../components/Toast';

const ROLE_TYPE_MAP: Record<string, { label: string; color: string }> = {
  SUPER_ADMIN: { label: '超级管理员', color: '#f48771' },
  OPS_ENGINEER: { label: '运维工程师', color: '#d1a855' },
  DATA_ARCHITECT: { label: '数据架构师', color: '#4ec9b0' },
  DATA_DEV_ENGINEER: { label: '数据开发工程师', color: '#75beff' },
  BUSINESS_REQUESTER: { label: '业务需求方', color: '#c495f5' },
  DATA_ANALYST: { label: '数据分析师', color: '#89d185' },
};

type UserRoleSubTab = 'user' | 'role' | 'tenant';

const validatePassword = (password: string): string | null => {
  if (!password) return '请输入密码';
  if (password.length < 6 || password.length > 20) return '密码长度必须在6-20位之间';
  let types = 0;
  if (/[a-z]/.test(password)) types++;
  if (/[A-Z]/.test(password)) types++;
  if (/[0-9]/.test(password)) types++;
  if (/[^a-zA-Z0-9]/.test(password)) types++;
  if (types < 3) return '密码需包含大小写字母、数字、特殊字符中的至少3种';
  return null;
};

interface ConfirmModalState {
  visible: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
}

const UserRoleManageTab: React.FC = () => {
  const toast = useToast();
  const [activeSubTab, setActiveSubTab] = useState<UserRoleSubTab>('user');

  const [userList, setUserList] = useState<UserInfo[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [userPage, setUserPage] = useState(1);
  const [userLoading, setUserLoading] = useState(false);
  const [userSearch, setUserSearch] = useState('');
  const [appliedUserSearch, setAppliedUserSearch] = useState('');
  const [userDialogOpen, setUserDialogOpen] = useState(false);
  const [userDialogTitle, setUserDialogTitle] = useState('新增用户');
  const [userForm, setUserForm] = useState<Partial<UserInfo>>({ username: '', realName: '', email: '', phone: '', password: '', status: 1 });

  const [allUsersList, setAllUsersList] = useState<UserInfo[]>([]);
  const allUsersCache = useRef<UserInfo[] | null>(null);

  const [roleList, setRoleList] = useState<RoleInfo[]>([]);
  const [roleLoading, setRoleLoading] = useState(false);
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [roleDialogTitle, setRoleDialogTitle] = useState('新增角色');
  const [roleForm, setRoleForm] = useState<Partial<RoleInfo>>({ roleName: '', roleCode: '', roleType: '', description: '', status: 1 });

  const [allRoles, setAllRoles] = useState<RoleInfo[]>([]);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserInfo | null>(null);
  const [selectedRoleIds, setSelectedRoleIds] = useState<number[]>([]);

  const [submitLoading, setSubmitLoading] = useState(false);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState>({ visible: false, title: '', message: '', onConfirm: () => {} });

  const [tenantList, setTenantList] = useState<TenantVO[]>([]);
  const [tenantTotal, setTenantTotal] = useState(0);
  const [tenantPage, setTenantPage] = useState(1);
  const [tenantLoading, setTenantLoading] = useState(false);
  const [tenantSearch, setTenantSearch] = useState('');
  const [appliedTenantSearch, setAppliedTenantSearch] = useState('');
  const [tenantDialogOpen, setTenantDialogOpen] = useState(false);
  const [tenantDialogTitle, setTenantDialogTitle] = useState('新增租户');
  const [tenantForm, setTenantForm] = useState<Partial<TenantDTO>>({ tenantName: '', tenantCode: '', contactName: '', contactPhone: '', contactEmail: '', description: '', status: 1, password: '' });
  const [bindUserDialogOpen, setBindUserDialogOpen] = useState(false);
  const [currentTenant, setCurrentTenant] = useState<TenantVO | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);

  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [passwordTargetUser, setPasswordTargetUser] = useState<UserInfo | null>(null);
  const [passwordForm, setPasswordForm] = useState<ChangePasswordDTO>({ oldPassword: '', newPassword: '', confirmPassword: '' });

  const loadUsers = useCallback(async () => {
    setUserLoading(true);
    allUsersCache.current = null;
    try {
      const res = await systemUserApi.getUserList({ current: userPage, size: 10, username: appliedUserSearch || undefined });
      setUserList(res.data.records || []);
      setUserTotal(res.data.total || 0);
    } catch (e) { console.error(e); }
    finally { setUserLoading(false); }
  }, [userPage, appliedUserSearch]);

  const loadRoles = useCallback(async () => {
    setRoleLoading(true);
    try {
      const [rolesRes, allRes] = await Promise.all([
        systemRoleApi.getRoleList({ current: 1, size: 100 }),
        systemRoleApi.getAllRoles(),
      ]);
      setRoleList(rolesRes.data.records || []);
      setAllRoles(allRes.data || []);
    } catch (e) { console.error(e); }
    finally { setRoleLoading(false); }
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);
  useEffect(() => { loadRoles(); }, [loadRoles]);

  const loadTenants = useCallback(async () => {
    setTenantLoading(true);
    try {
      const res = await tenantApi.getList({ current: tenantPage, size: 10, tenantName: appliedTenantSearch || undefined });
      setTenantList(res.data.records || []);
      setTenantTotal(res.data.total || 0);
    } catch (e) { console.error(e); }
    finally { setTenantLoading(false); }
  }, [tenantPage, appliedTenantSearch]);

  const loadAllUsers = useCallback(async () => {
    if (allUsersCache.current) {
      setAllUsersList(allUsersCache.current);
      return;
    }
    try {
      const res = await systemUserApi.getUserList({ current: 1, size: 200 });
      const users = res.data.records || [];
      allUsersCache.current = users;
      setAllUsersList(users);
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { if (activeSubTab === 'tenant') loadTenants(); }, [activeSubTab, loadTenants]);

  const handleAddUser = () => {
    setUserDialogTitle('新增用户');
    setUserForm({ username: '', realName: '', email: '', phone: '', password: '', status: 1 });
    setUserDialogOpen(true);
  };

  const handleEditUser = (row: UserInfo) => {
    setUserDialogTitle('编辑用户');
    setUserForm({ id: row.id, username: row.username, realName: row.realName, email: row.email, phone: row.phone, password: '', status: row.status });
    setUserDialogOpen(true);
  };

  const handleAssignRole = (row: UserInfo) => {
    setCurrentUser(row);
    setSelectedRoleIds(row.roleIds || []);
    setAssignDialogOpen(true);
  };

  const handleDeleteUser = (row: UserInfo) => {
    setConfirmModal({
      visible: true, title: '确认删除', message: `确定要删除用户"${row.username}"吗？`,
      onConfirm: async () => {
        try { await systemUserApi.deleteUser(row.id); loadUsers(); toast.info(`用户"${row.username}"已删除`); } catch (e) { toast.error(`删除失败: ${e instanceof Error ? e.message : String(e)}`); }
        setConfirmModal(prev => ({ ...prev, visible: false }));
      },
    });
  };

  const handleChangePassword = (row: UserInfo) => {
    setPasswordTargetUser(row);
    setPasswordForm({ oldPassword: '', newPassword: '', confirmPassword: '' });
    setPasswordDialogOpen(true);
  };

  const handleSubmitChangePassword = async () => {
    if (!passwordForm.oldPassword) { toast.warning('请输入原密码'); return; }
    const pwdError = validatePassword(passwordForm.newPassword);
    if (pwdError) { toast.warning(pwdError); return; }
    if (passwordForm.newPassword !== passwordForm.confirmPassword) { toast.warning('两次输入的密码不一致'); return; }
    setSubmitLoading(true);
    try {
      const res = await systemUserApi.changePassword(passwordForm);
      if (res.code !== undefined && res.code !== 200) {
        toast.error(res.message || '修改失败');
        return;
      }
      setPasswordDialogOpen(false);
      toast.info('密码修改成功');
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message || '修改失败，请稍后重试');
    } finally { setSubmitLoading(false); }
  };

  const handleSubmitUser = async () => {
    if (!userForm.username) { toast.warning('请填写用户名'); return; }
    if (!userForm.id) {
      const pwdError = validatePassword(userForm.password || '');
      if (pwdError) { toast.warning(pwdError); return; }
    }
    setSubmitLoading(true);
    try {
      if (userForm.id) await systemUserApi.updateUser({ id: userForm.id, username: userForm.username, realName: userForm.realName, email: userForm.email, phone: userForm.phone, status: userForm.status });
      else await systemUserApi.createUser(userForm as any);
      setUserDialogOpen(false);
      loadUsers();
    } catch (e) { console.error(e); }
    finally { setSubmitLoading(false); }
  };

  const handleSubmitAssignRole = async () => {
    if (!currentUser) return;
    setSubmitLoading(true);
    try {
      await systemUserApi.updateUser({ id: currentUser.id, roleIds: selectedRoleIds });
      setAssignDialogOpen(false);
      loadUsers();
    } catch (e) { console.error(e); }
    finally { setSubmitLoading(false); }
  };

  const handleAddRole = () => {
    setRoleDialogTitle('新增角色');
    setRoleForm({ roleName: '', roleCode: '', roleType: '', description: '', status: 1 });
    setRoleDialogOpen(true);
  };

  const handleEditRole = (row: RoleInfo) => {
    setRoleDialogTitle('编辑角色');
    setRoleForm({ id: row.id, roleName: row.roleName, roleCode: row.roleCode, roleType: row.roleType, description: row.description, status: row.status });
    setRoleDialogOpen(true);
  };

  const handleDeleteRole = (row: RoleInfo) => {
    setConfirmModal({
      visible: true, title: '确认删除', message: `确定要删除角色"${row.roleName}"吗？`,
      onConfirm: async () => {
        try { await systemRoleApi.deleteRole(row.id); loadRoles(); toast.info(`角色"${row.roleName}"已删除`); } catch (e) { toast.error(`删除失败: ${e instanceof Error ? e.message : String(e)}`); }
        setConfirmModal(prev => ({ ...prev, visible: false }));
      },
    });
  };

  const handleSubmitRole = async () => {
    if (!roleForm.roleName || !roleForm.roleCode) { toast.warning('请填写角色名称和编码'); return; }
    setSubmitLoading(true);
    try {
      if (roleForm.id) await systemRoleApi.updateRole(roleForm as any);
      else await systemRoleApi.createRole(roleForm as any);
      setRoleDialogOpen(false);
      loadRoles();
    } catch (e) { console.error(e); }
    finally { setSubmitLoading(false); }
  };

  const handleAddTenant = () => {
    setTenantDialogTitle('新增租户');
    setTenantForm({ tenantName: '', tenantCode: '', contactName: '', contactPhone: '', contactEmail: '', description: '', status: 1, password: '' });
    setTenantDialogOpen(true);
  };

  const handleEditTenant = (row: TenantVO) => {
    setTenantDialogTitle('编辑租户');
    setTenantForm({ id: row.id, tenantName: row.tenantName, tenantCode: row.tenantCode, contactName: row.contactName, contactPhone: row.contactPhone, contactEmail: row.contactEmail, description: row.description, status: row.status, password: '' });
    setTenantDialogOpen(true);
  };

  const handleDeleteTenant = (row: TenantVO) => {
    setConfirmModal({
      visible: true, title: '确认删除', message: `确定要删除租户"${row.tenantName}"吗？`,
      onConfirm: async () => {
        try { await tenantApi.deleteTenant(row.id); loadTenants(); toast.info(`租户"${row.tenantName}"已删除`); } catch (e) { toast.error(`删除失败: ${e instanceof Error ? e.message : String(e)}`); }
        setConfirmModal(prev => ({ ...prev, visible: false }));
      },
    });
  };

  const handleSubmitTenant = async () => {
    if (!tenantForm.tenantName || !tenantForm.tenantCode) { toast.warning('请填写租户名称和编码'); return; }
    if (!tenantForm.id) {
      const pwdError = validatePassword(tenantForm.password || '');
      if (pwdError) { toast.warning(pwdError); return; }
    } else if (tenantForm.password) {
      const pwdError = validatePassword(tenantForm.password);
      if (pwdError) { toast.warning(pwdError); return; }
    }
    setSubmitLoading(true);
    try {
      if (tenantForm.id) await tenantApi.updateTenant(tenantForm as TenantDTO);
      else await tenantApi.createTenant(tenantForm as TenantDTO);
      setTenantDialogOpen(false);
      loadTenants();
    } catch (e) { console.error(e); }
    finally { setSubmitLoading(false); }
  };

  const handleBindUser = (row: TenantVO) => {
    setCurrentTenant(row);
    setSelectedUserId(row.userId || null);
    loadAllUsers();
    setBindUserDialogOpen(true);
  };

  const handleSubmitBindUser = async () => {
    if (!currentTenant || !selectedUserId) { toast.warning('请选择要绑定的用户'); return; }
    setSubmitLoading(true);
    try {
      if (currentTenant.userId && currentTenant.userId !== selectedUserId) {
        await tenantApi.unbindUser(currentTenant.id, currentTenant.userId);
      }
      await tenantApi.bindUser(currentTenant.id, selectedUserId);
      setBindUserDialogOpen(false);
      loadTenants();
    } catch (e) { console.error(e); }
    finally { setSubmitLoading(false); }
  };

  const handleUnbindUser = (row: TenantVO) => {
    if (!row.userId) return;
    setConfirmModal({
      visible: true, title: '解绑用户', message: `确定要解绑租户"${row.tenantName}"与用户"${row.username}"的关联吗？`,
      onConfirm: async () => {
        try { await tenantApi.unbindUser(row.id, row.userId!); loadTenants(); } catch (e) { console.error(e); }
        setConfirmModal(prev => ({ ...prev, visible: false }));
      },
    });
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

  const subTabs: { id: UserRoleSubTab; label: string; icon: React.ReactNode }[] = [
    { id: 'user', label: '用户管理', icon: <UserCheck size={14} /> },
    { id: 'role', label: '角色管理', icon: <Shield size={14} /> },
    { id: 'tenant', label: '租户管理', icon: <Building2 size={14} /> },
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

      {activeSubTab === 'user' && (
        <div className="sys-mgmt__section">
          <div className="sys-mgmt__toolbar">
            <div className="sys-mgmt__search-bar">
              <input className="sys-mgmt__input" placeholder="搜索用户名" value={userSearch} onChange={e => setUserSearch(e.target.value)} />
              <button className="sys-mgmt__btn sys-mgmt__btn--primary" onClick={() => { setUserPage(1); setAppliedUserSearch(userSearch); }}><Search size={14} /> 查询</button>
              <button className="sys-mgmt__btn" onClick={() => { setUserSearch(''); setAppliedUserSearch(''); setUserPage(1); }}><RotateCcw size={14} /> 重置</button>
            </div>
            <button className="sys-mgmt__btn sys-mgmt__btn--primary" onClick={handleAddUser}><Plus size={14} /> 新增用户</button>
          </div>
          <div className="sys-mgmt__table-wrap">
            <table className="sys-mgmt__table">
              <thead><tr><th>用户名</th><th>真实姓名</th><th>邮箱</th><th>手机号</th><th>角色</th><th>状态</th><th>最后登录</th><th className="sys-mgmt__th-actions">操作</th></tr></thead>
              <tbody>
                {userLoading ? <tr><td colSpan={8} className="sys-mgmt__table-empty">加载中...</td></tr> :
                userList.length === 0 ? <tr><td colSpan={8} className="sys-mgmt__table-empty">暂无数据</td></tr> :
                userList.map(row => (
                  <tr key={row.id}>
                    <td>{row.username}</td>
                    <td>{row.realName || '-'}</td>
                    <td>{row.email || '-'}</td>
                    <td>{row.phone || '-'}</td>
                    <td>{row.roles?.map(r => <span key={r} className="sys-mgmt__tag" style={{ margin: '1px' }}>{r}</span>) || '-'}</td>
                    <td><span className={`sys-mgmt__tag sys-mgmt__tag--${row.status === 1 ? 'success' : 'danger'}`}>{row.status === 1 ? '启用' : '禁用'}</span></td>
                    <td>{row.lastLoginTime || '-'}</td>
                    <td className="sys-mgmt__td-actions">
                      <button className="sys-mgmt__btn-link" onClick={() => handleEditUser(row)}><Edit3 size={12} /> 编辑</button>
                      <button className="sys-mgmt__btn-link" onClick={() => handleAssignRole(row)}><UserCheck size={12} /> 分配角色</button>
                      <button className="sys-mgmt__btn-link" onClick={() => handleChangePassword(row)}><KeyRound size={12} /> 修改密码</button>
                      <button className="sys-mgmt__btn-link sys-mgmt__btn-link--danger" onClick={() => handleDeleteUser(row)}><Trash2 size={12} /> 删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {renderPagination(userPage, userTotal, setUserPage)}
        </div>
      )}

      {activeSubTab === 'role' && (
        <div className="sys-mgmt__section">
          <div className="sys-mgmt__toolbar">
            <h3 className="sys-mgmt__section-title">角色管理</h3>
            <button className="sys-mgmt__btn sys-mgmt__btn--primary" onClick={handleAddRole}><Plus size={14} /> 新增角色</button>
          </div>
          <div className="sys-mgmt__table-wrap">
            <table className="sys-mgmt__table">
              <thead><tr><th>角色名称</th><th>角色编码</th><th>角色类型</th><th>描述</th><th>状态</th><th>创建时间</th><th className="sys-mgmt__th-actions">操作</th></tr></thead>
              <tbody>
                {roleLoading ? <tr><td colSpan={9} className="sys-mgmt__table-empty">加载中...</td></tr> :
                roleList.length === 0 ? <tr><td colSpan={9} className="sys-mgmt__table-empty">暂无数据</td></tr> :
                roleList.map(row => (
                  <tr key={row.id}>
                    <td>{row.roleName}</td>
                    <td><span className="sys-mgmt__tag">{row.roleCode}</span></td>
                    <td><span className="sys-mgmt__tag" style={{ color: ROLE_TYPE_MAP[row.roleType]?.color }}>{ROLE_TYPE_MAP[row.roleType]?.label || row.roleType}</span></td>
                    <td className="sys-mgmt__td-ellipsis" title={row.description}>{row.description || '-'}</td>
                    <td><span className={`sys-mgmt__tag sys-mgmt__tag--${row.status === 1 ? 'success' : 'danger'}`}>{row.status === 1 ? '启用' : '禁用'}</span></td>
                    <td>{row.createTime || '-'}</td>
                    <td className="sys-mgmt__td-actions">
                      <button className="sys-mgmt__btn-link" onClick={() => handleEditRole(row)}><Edit3 size={12} /> 编辑</button>
                      <button className="sys-mgmt__btn-link sys-mgmt__btn-link--danger" onClick={() => handleDeleteRole(row)}><Trash2 size={12} /> 删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeSubTab === 'tenant' && (
        <div className="sys-mgmt__section">
          <div className="sys-mgmt__toolbar">
            <div className="sys-mgmt__search-bar">
              <input className="sys-mgmt__input" placeholder="搜索租户名称" value={tenantSearch} onChange={e => setTenantSearch(e.target.value)} />
              <button className="sys-mgmt__btn sys-mgmt__btn--primary" onClick={() => { setTenantPage(1); setAppliedTenantSearch(tenantSearch); }}><Search size={14} /> 查询</button>
              <button className="sys-mgmt__btn" onClick={() => { setTenantSearch(''); setAppliedTenantSearch(''); setTenantPage(1); }}><RotateCcw size={14} /> 重置</button>
            </div>
            <button className="sys-mgmt__btn sys-mgmt__btn--primary" onClick={handleAddTenant}><Plus size={14} /> 新增租户</button>
          </div>
          <div className="sys-mgmt__table-wrap">
            <table className="sys-mgmt__table">
              <thead><tr><th>租户名称</th><th>租户编码</th><th>联系人</th><th>联系电话</th><th>关联用户</th><th>状态</th><th>创建时间</th><th className="sys-mgmt__th-actions">操作</th></tr></thead>
              <tbody>
                {tenantLoading ? <tr><td colSpan={8} className="sys-mgmt__table-empty">加载中...</td></tr> :
                tenantList.length === 0 ? <tr><td colSpan={8} className="sys-mgmt__table-empty">暂无数据</td></tr> :
                tenantList.map(row => (
                  <tr key={row.id}>
                    <td>{row.tenantName}</td>
                    <td><span className="sys-mgmt__tag">{row.tenantCode}</span></td>
                    <td>{row.contactName || '-'}</td>
                    <td>{row.contactPhone || '-'}</td>
                    <td>{row.username ? <span className="sys-mgmt__tag sys-mgmt__tag--success">{row.userRealName || row.username}</span> : <span style={{ color: '#666' }}>未绑定</span>}</td>
                    <td><span className={`sys-mgmt__tag sys-mgmt__tag--${row.status === 1 ? 'success' : 'danger'}`}>{row.status === 1 ? '启用' : '禁用'}</span></td>
                    <td>{row.createTime || '-'}</td>
                    <td className="sys-mgmt__td-actions">
                      <button className="sys-mgmt__btn-link" onClick={() => handleEditTenant(row)}><Edit3 size={12} /> 编辑</button>
                      <button className="sys-mgmt__btn-link" onClick={() => handleBindUser(row)}><Link2 size={12} /> 绑定用户</button>
                      {row.userId && <button className="sys-mgmt__btn-link" onClick={() => handleUnbindUser(row)}><Unlink size={12} /> 解绑</button>}
                      <button className="sys-mgmt__btn-link sys-mgmt__btn-link--danger" onClick={() => handleDeleteTenant(row)}><Trash2 size={12} /> 删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {renderPagination(tenantPage, tenantTotal, setTenantPage)}
        </div>
      )}

      {userDialogOpen && (
        <div className="sys-mgmt__modal-overlay">
          <div className="sys-mgmt__modal">
            <div className="sys-mgmt__modal-header"><h3>{userDialogTitle}</h3><button className="sys-mgmt__modal-close" onClick={() => setUserDialogOpen(false)}>×</button></div>
            <div className="sys-mgmt__modal-body">
              <div className="sys-mgmt__form-group"><label>用户名 <span className="sys-mgmt__required">*</span></label><input className="sys-mgmt__input" maxLength={32} value={userForm.username || ''} onChange={e => setUserForm(f => ({ ...f, username: e.target.value }))} placeholder="请输入用户名" disabled={!!userForm.id} /></div>
              <div className="sys-mgmt__form-group"><label>真实姓名</label><input className="sys-mgmt__input" maxLength={64} value={userForm.realName || ''} onChange={e => setUserForm(f => ({ ...f, realName: e.target.value }))} placeholder="请输入真实姓名" /></div>
              <div className="sys-mgmt__form-row">
                <div className="sys-mgmt__form-group"><label>邮箱</label><input className="sys-mgmt__input" type="email" maxLength={128} value={userForm.email || ''} onChange={e => setUserForm(f => ({ ...f, email: e.target.value }))} placeholder="请输入邮箱" /></div>
                <div className="sys-mgmt__form-group"><label>手机号</label><input className="sys-mgmt__input" maxLength={20} value={userForm.phone || ''} onChange={e => setUserForm(f => ({ ...f, phone: e.target.value }))} placeholder="请输入手机号" /></div>
              </div>
              {!userForm.id && <div className="sys-mgmt__form-group"><label>密码 <span className="sys-mgmt__required">*</span></label><input className="sys-mgmt__input" type="password" maxLength={20} value={userForm.password || ''} onChange={e => setUserForm(f => ({ ...f, password: e.target.value }))} placeholder="6-20位，含大小写字母/数字/特殊字符至少3种" /></div>}
              <div className="sys-mgmt__form-group"><label>状态</label><div className="sys-mgmt__switch"><button className={`sys-mgmt__switch-btn ${userForm.status === 1 ? 'sys-mgmt__switch-btn--active' : ''}`} onClick={() => setUserForm(f => ({ ...f, status: 1 }))}>启用</button><button className={`sys-mgmt__switch-btn ${userForm.status !== 1 ? 'sys-mgmt__switch-btn--active' : ''}`} onClick={() => setUserForm(f => ({ ...f, status: 0 }))}>禁用</button></div></div>
            </div>
            <div className="sys-mgmt__modal-footer"><button className="sys-mgmt__btn" onClick={() => setUserDialogOpen(false)}>取消</button><button className="sys-mgmt__btn sys-mgmt__btn--primary" disabled={submitLoading} onClick={handleSubmitUser}>{submitLoading ? '提交中...' : '确定'}</button></div>
          </div>
        </div>
      )}

      {roleDialogOpen && (
        <div className="sys-mgmt__modal-overlay">
          <div className="sys-mgmt__modal">
            <div className="sys-mgmt__modal-header"><h3>{roleDialogTitle}</h3><button className="sys-mgmt__modal-close" onClick={() => setRoleDialogOpen(false)}>×</button></div>
            <div className="sys-mgmt__modal-body">
              <div className="sys-mgmt__form-group"><label>角色名称 <span className="sys-mgmt__required">*</span></label><input className="sys-mgmt__input" value={roleForm.roleName || ''} onChange={e => setRoleForm(f => ({ ...f, roleName: e.target.value }))} placeholder="请输入角色名称" /></div>
              <div className="sys-mgmt__form-group"><label>角色编码 <span className="sys-mgmt__required">*</span></label><input className="sys-mgmt__input" value={roleForm.roleCode || ''} onChange={e => setRoleForm(f => ({ ...f, roleCode: e.target.value }))} placeholder="请输入角色编码（英文）" disabled={!!roleForm.id} /></div>
              <div className="sys-mgmt__form-group"><label>角色类型</label><select className="sys-mgmt__select" value={roleForm.roleType || ''} onChange={e => setRoleForm(f => ({ ...f, roleType: e.target.value }))}><option value="">请选择</option>{Object.entries(ROLE_TYPE_MAP).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div>
              <div className="sys-mgmt__form-group"><label>描述</label><textarea className="sys-mgmt__textarea" value={roleForm.description || ''} onChange={e => setRoleForm(f => ({ ...f, description: e.target.value }))} placeholder="请输入描述" rows={3} /></div>
              <div className="sys-mgmt__form-group"><label>状态</label><div className="sys-mgmt__switch"><button className={`sys-mgmt__switch-btn ${roleForm.status === 1 ? 'sys-mgmt__switch-btn--active' : ''}`} onClick={() => setRoleForm(f => ({ ...f, status: 1 }))}>启用</button><button className={`sys-mgmt__switch-btn ${roleForm.status !== 1 ? 'sys-mgmt__switch-btn--active' : ''}`} onClick={() => setRoleForm(f => ({ ...f, status: 0 }))}>禁用</button></div></div>
            </div>
            <div className="sys-mgmt__modal-footer"><button className="sys-mgmt__btn" onClick={() => setRoleDialogOpen(false)}>取消</button><button className="sys-mgmt__btn sys-mgmt__btn--primary" disabled={submitLoading} onClick={handleSubmitRole}>{submitLoading ? '提交中...' : '确定'}</button></div>
          </div>
        </div>
      )}

      {assignDialogOpen && currentUser && (
        <div className="sys-mgmt__modal-overlay">
          <div className="sys-mgmt__modal sys-mgmt__modal--assign-role">
            <div className="sys-mgmt__modal-header"><h3>分配角色</h3><button className="sys-mgmt__modal-close" onClick={() => setAssignDialogOpen(false)}>×</button></div>
            <div className="sys-mgmt__modal-body">
              <p style={{ marginBottom: 12, color: '#999' }}>当前用户：<strong style={{ color: '#ccc' }}>{currentUser.username} ({currentUser.realName})</strong></p>
              <div className="sys-mgmt__form-group"><label>选择角色 <span className="sys-mgmt__required">*</span></label>
                <MultiSelect
                  options={allRoles.map(r => ({
                    value: r.id,
                    label: r.roleName,
                    tag: ROLE_TYPE_MAP[r.roleType]?.label || r.roleType,
                    tagColor: ROLE_TYPE_MAP[r.roleType]?.color,
                  }))}
                  selectedValues={selectedRoleIds}
                  onChange={setSelectedRoleIds}
                  placeholder="请选择角色"
                />
              </div>
            </div>
            <div className="sys-mgmt__modal-footer"><button className="sys-mgmt__btn" onClick={() => setAssignDialogOpen(false)}>取消</button><button className="sys-mgmt__btn sys-mgmt__btn--primary" disabled={submitLoading} onClick={handleSubmitAssignRole}>{submitLoading ? '提交中...' : '确定'}</button></div>
          </div>
        </div>
      )}

      {tenantDialogOpen && (
        <div className="sys-mgmt__modal-overlay">
          <div className="sys-mgmt__modal">
            <div className="sys-mgmt__modal-header"><h3>{tenantDialogTitle}</h3><button className="sys-mgmt__modal-close" onClick={() => setTenantDialogOpen(false)}>×</button></div>
            <div className="sys-mgmt__modal-body">
              <div className="sys-mgmt__form-group"><label>租户名称 <span className="sys-mgmt__required">*</span></label><input className="sys-mgmt__input" maxLength={64} value={tenantForm.tenantName || ''} onChange={e => setTenantForm(f => ({ ...f, tenantName: e.target.value }))} placeholder="请输入租户名称" /></div>
              <div className="sys-mgmt__form-group"><label>租户编码 <span className="sys-mgmt__required">*</span></label><input className="sys-mgmt__input" maxLength={32} value={tenantForm.tenantCode || ''} onChange={e => setTenantForm(f => ({ ...f, tenantCode: e.target.value }))} placeholder="请输入租户编码（英文）" disabled={!!tenantForm.id} /></div>
              <div className="sys-mgmt__form-row">
                <div className="sys-mgmt__form-group"><label>联系人</label><input className="sys-mgmt__input" maxLength={64} value={tenantForm.contactName || ''} onChange={e => setTenantForm(f => ({ ...f, contactName: e.target.value }))} placeholder="请输入联系人" /></div>
                <div className="sys-mgmt__form-group"><label>联系电话</label><input className="sys-mgmt__input" maxLength={20} value={tenantForm.contactPhone || ''} onChange={e => setTenantForm(f => ({ ...f, contactPhone: e.target.value }))} placeholder="请输入联系电话" /></div>
              </div>
              <div className="sys-mgmt__form-group"><label>联系邮箱</label><input className="sys-mgmt__input" type="email" maxLength={128} value={tenantForm.contactEmail || ''} onChange={e => setTenantForm(f => ({ ...f, contactEmail: e.target.value }))} placeholder="请输入联系邮箱" /></div>
              {!tenantForm.id && <div className="sys-mgmt__form-group"><label>租户密码 <span className="sys-mgmt__required">*</span></label><input className="sys-mgmt__input" type="password" maxLength={20} value={tenantForm.password || ''} onChange={e => setTenantForm(f => ({ ...f, password: e.target.value }))} placeholder="6-20位，含大小写字母/数字/特殊字符至少3种" /></div>}
              {tenantForm.id && <div className="sys-mgmt__form-group"><label>租户密码</label><input className="sys-mgmt__input" type="password" maxLength={20} value={tenantForm.password || ''} onChange={e => setTenantForm(f => ({ ...f, password: e.target.value }))} placeholder="留空则不修改" /></div>}
              <div className="sys-mgmt__form-group"><label>描述</label><textarea className="sys-mgmt__textarea" value={tenantForm.description || ''} onChange={e => setTenantForm(f => ({ ...f, description: e.target.value }))} placeholder="请输入描述" rows={3} /></div>
              <div className="sys-mgmt__form-group"><label>状态</label><div className="sys-mgmt__switch"><button className={`sys-mgmt__switch-btn ${tenantForm.status === 1 ? 'sys-mgmt__switch-btn--active' : ''}`} onClick={() => setTenantForm(f => ({ ...f, status: 1 }))}>启用</button><button className={`sys-mgmt__switch-btn ${tenantForm.status !== 1 ? 'sys-mgmt__switch-btn--active' : ''}`} onClick={() => setTenantForm(f => ({ ...f, status: 0 }))}>禁用</button></div></div>
            </div>
            <div className="sys-mgmt__modal-footer"><button className="sys-mgmt__btn" onClick={() => setTenantDialogOpen(false)}>取消</button><button className="sys-mgmt__btn sys-mgmt__btn--primary" disabled={submitLoading} onClick={handleSubmitTenant}>{submitLoading ? '提交中...' : '确定'}</button></div>
          </div>
        </div>
      )}

      {bindUserDialogOpen && currentTenant && (
        <div className="sys-mgmt__modal-overlay">
          <div className="sys-mgmt__modal">
            <div className="sys-mgmt__modal-header"><h3>绑定用户</h3><button className="sys-mgmt__modal-close" onClick={() => setBindUserDialogOpen(false)}>×</button></div>
            <div className="sys-mgmt__modal-body">
              <p style={{ marginBottom: 12, color: '#999' }}>当前租户：<strong style={{ color: '#ccc' }}>{currentTenant.tenantName} ({currentTenant.tenantCode})</strong></p>
              {currentTenant.userId && <p style={{ marginBottom: 12, color: '#d1a855', fontSize: 12 }}>当前已绑定用户：{currentTenant.userRealName || currentTenant.username}，选择新用户将自动解绑旧用户</p>}
              <div className="sys-mgmt__form-group"><label>选择用户 <span className="sys-mgmt__required">*</span></label>
                <select className="sys-mgmt__select" value={selectedUserId || ''} onChange={e => setSelectedUserId(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">请选择用户</option>
                  {allUsersList.map(u => <option key={u.id} value={u.id}>{u.username} ({u.realName || '-'})</option>)}
                </select>
              </div>
            </div>
            <div className="sys-mgmt__modal-footer"><button className="sys-mgmt__btn" onClick={() => setBindUserDialogOpen(false)}>取消</button><button className="sys-mgmt__btn sys-mgmt__btn--primary" disabled={submitLoading} onClick={handleSubmitBindUser}>{submitLoading ? '提交中...' : '确定'}</button></div>
          </div>
        </div>
      )}

      {passwordDialogOpen && passwordTargetUser && (
        <div className="sys-mgmt__modal-overlay">
          <div className="sys-mgmt__modal" style={{ maxWidth: 420 }}>
            <div className="sys-mgmt__modal-header"><h3>修改密码</h3><button className="sys-mgmt__modal-close" onClick={() => setPasswordDialogOpen(false)}>×</button></div>
            <div className="sys-mgmt__modal-body">
              <p style={{ marginBottom: 16, color: '#999', fontSize: 13 }}>正在为用户 <strong style={{ color: '#ccc' }}>{passwordTargetUser.username} ({passwordTargetUser.realName || '-'})</strong> 修改密码</p>
              <div className="sys-mgmt__form-group"><label>原密码 <span className="sys-mgmt__required">*</span></label><input className="sys-mgmt__input" type="password" value={passwordForm.oldPassword} onChange={e => setPasswordForm(f => ({ ...f, oldPassword: e.target.value }))} placeholder="请输入原密码" /></div>
              <div className="sys-mgmt__form-group"><label>新密码 <span className="sys-mgmt__required">*</span></label><input className="sys-mgmt__input" type="password" maxLength={20} value={passwordForm.newPassword} onChange={e => setPasswordForm(f => ({ ...f, newPassword: e.target.value }))} placeholder="6-20位，含大小写字母/数字/特殊字符至少3种" /></div>
              <div className="sys-mgmt__form-group"><label>确认密码 <span className="sys-mgmt__required">*</span></label><input className="sys-mgmt__input" type="password" value={passwordForm.confirmPassword} onChange={e => setPasswordForm(f => ({ ...f, confirmPassword: e.target.value }))} placeholder="请再次输入新密码" /></div>
            </div>
            <div className="sys-mgmt__modal-footer"><button className="sys-mgmt__btn" onClick={() => setPasswordDialogOpen(false)}>取消</button><button className="sys-mgmt__btn sys-mgmt__btn--primary" disabled={submitLoading} onClick={handleSubmitChangePassword}>{submitLoading ? '提交中...' : '确定修改'}</button></div>
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

export default UserRoleManageTab;
