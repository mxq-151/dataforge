import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { FolderKanban, ArrowRight, Search, RefreshCw, Plus, Trash2, X } from 'lucide-react';
import { fetchProjectList, createProject, deleteProject } from '../../api/devProject';
import type { ProjectInfo, CreateProjectDTO } from '../../api/devProject';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../components/Toast';
import { validateName, validateCode } from '../../utils/validation';
import './ProjectList.css';

interface ProjectListProps {
  onSelectProject: (project: ProjectInfo) => void;
}

const PROJECT_MANAGE_ROLE_NAMES = ['ROLE_ADMIN', 'ADMIN', 'SUPER_ADMIN', '超级管理员', 'ROLE_OPS_ENGINEER', 'OPS_ENGINEER', '运维工程师'];

function canManageProject(roles: { roleCode: string }[] | undefined): boolean {
  if (!roles || roles.length === 0) return false;
  return roles.some(role =>
    PROJECT_MANAGE_ROLE_NAMES.some(allowed =>
      role.roleCode === allowed || role.roleCode?.toUpperCase() === allowed.toUpperCase()
    )
  );
}

const ProjectList: React.FC<ProjectListProps> = ({ onSelectProject }) => {
  const toast = useToast();
  const { user } = useAuth();
  const canManage = canManageProject(user?.roles);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchName, setSearchName] = useState('');
  const [searchCode, setSearchCode] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState<CreateProjectDTO>({
    projectName: '',
    projectCode: '',
    description: '',
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadProjects = useCallback(async (name?: string, code?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchProjectList({
        current: 1,
        size: 100,
        projectName: name || '',
        projectCode: code || '',
      });
      if (res.code !== 200) throw new Error(res.message || '获取项目列表失败');
      setProjects(res.data?.records || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : '获取项目列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const visibleProjects = useMemo(() => {
    if (user?.isSuperAdmin) return projects;
    if (!user?.projectCodes || user.projectCodes.length === 0) return [];
    return projects.filter(project => user.projectCodes!.includes(project.projectCode));
  }, [projects, user?.isSuperAdmin, user?.projectCodes]);

  const handleSearch = useCallback(() => {
    loadProjects(searchName, searchCode);
  }, [searchName, searchCode, loadProjects]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  }, [handleSearch]);

  const handleCreate = useCallback(async () => {
    const nameErr = validateName(createForm.projectName, '项目名称');
    if (nameErr) { setCreateError(nameErr); return; }
    const codeErr = validateCode(createForm.projectCode, '项目编码');
    if (codeErr) { setCreateError(codeErr); return; }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await createProject(createForm);
      if (res.code !== 200) throw new Error(res.message || '创建项目失败');
      setShowCreateModal(false);
      setCreateForm({ projectName: '', projectCode: '', description: '' });
      await loadProjects(searchName, searchCode);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : '创建项目失败');
    } finally {
      setCreating(false);
    }
  }, [createForm, searchName, searchCode, loadProjects]);

  const handleDelete = useCallback(async (id: number) => {
    setDeleting(true);
    try {
      const res = await deleteProject(id);
      if (res.code !== 200) throw new Error(res.message || '删除项目失败');
      setDeleteConfirmId(null);
      await loadProjects(searchName, searchCode);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除项目失败');
    } finally {
      setDeleting(false);
    }
  }, [searchName, searchCode, loadProjects]);

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="project-list">
      <div className="project-list__header">
        <div className="project-list__header-left">
          <FolderKanban size={22} style={{ color: '#0078d4' }} />
          <h2 className="project-list__title">开发项目</h2>
        </div>
      </div>

      <div className="project-list__search">
        <Search size={16} style={{ color: '#666', flexShrink: 0 }} />
        <input
          className="project-list__search-input"
          placeholder="项目名称"
          value={searchName}
          onChange={e => setSearchName(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <input
          className="project-list__search-input"
          placeholder="项目编码"
          value={searchCode}
          onChange={e => setSearchCode(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          className="project-list__back-btn"
          onClick={handleSearch}
        >
          <Search size={14} />
          搜索
        </button>
        <button
          className="project-list__back-btn"
          onClick={() => loadProjects(searchName, searchCode)}
        >
          <RefreshCw size={14} />
          刷新
        </button>
        {canManage && (
        <button
          className="project-list__create-btn"
          onClick={() => {
            setCreateError(null);
            setCreateForm({ projectName: '', projectCode: '', description: '' });
            setShowCreateModal(true);
          }}
        >
          <Plus size={14} />
          新增项目
        </button>
        )}
      </div>

      <div className="project-list__content">
        {loading && (
          <div className="project-list__loading">加载中...</div>
        )}

        {error && (
          <div className="project-list__error">
            <span>{error}</span>
            <button
              className="project-list__error-retry"
              onClick={() => loadProjects(searchName, searchCode)}
            >
              重试
            </button>
          </div>
        )}

        {!loading && !error && visibleProjects.length === 0 && (
          <div className="project-list__empty">
            <FolderKanban size={48} style={{ color: '#444' }} />
            <span className="project-list__empty-text">暂无项目</span>
          </div>
        )}

        {!loading && !error && visibleProjects.length > 0 && (
          <div className="project-list__grid">
            {visibleProjects.map(project => (
              <div
                key={project.id}
                className="project-list__card"
              >
                <div
                  className="project-list__card-main"
                  onClick={() => onSelectProject(project)}
                >
                  <div className="project-list__card-header">
                    <div className="project-list__card-icon">
                      <FolderKanban size={20} color="#fff" />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="project-list__card-name">{project.projectName}</div>
                      <span className="project-list__card-code">{project.projectCode}</span>
                    </div>
                  </div>

                  {project.description && (
                    <div className="project-list__card-desc">{project.description}</div>
                  )}

                  <div className="project-list__card-footer">
                    <span className="project-list__card-time">
                      {formatDate(project.updateTime || project.createTime)}
                    </span>
                    <ArrowRight size={16} className="project-list__card-arrow" />
                  </div>
                </div>
                {canManage && (
                <button
                  className="project-list__card-delete"
                  title="删除项目"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteConfirmId(project.id);
                  }}
                >
                  <Trash2 size={14} />
                </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreateModal && (
        <div className="project-list__modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="project-list__modal" onClick={e => e.stopPropagation()}>
            <div className="project-list__modal-header">
              <h3>新增项目</h3>
              <button className="project-list__modal-close" onClick={() => setShowCreateModal(false)}>
                <X size={18} />
              </button>
            </div>
            <div className="project-list__modal-body">
              <div className="project-list__form-group">
                <label className="project-list__form-label">
                  项目名称 <span style={{ color: '#f44' }}>*</span>
                </label>
                <input
                  className="project-list__form-input"
                  placeholder="请输入项目名称"
                  value={createForm.projectName}
                  onChange={e => setCreateForm(prev => ({ ...prev, projectName: e.target.value }))}
                  autoFocus
                />
              </div>
              <div className="project-list__form-group">
                <label className="project-list__form-label">
                  项目编码 <span style={{ color: '#f44' }}>*</span>
                </label>
                <input
                  className="project-list__form-input"
                  placeholder="请输入项目编码（英文、数字、下划线）"
                  value={createForm.projectCode}
                  onChange={e => setCreateForm(prev => ({ ...prev, projectCode: e.target.value }))}
                />
              </div>
              <div className="project-list__form-group">
                <label className="project-list__form-label">项目描述</label>
                <textarea
                  className="project-list__form-textarea"
                  placeholder="请输入项目描述（选填）"
                  value={createForm.description || ''}
                  onChange={e => setCreateForm(prev => ({ ...prev, description: e.target.value }))}
                  rows={3}
                />
              </div>
              {createError && (
                <div className="project-list__form-error">{createError}</div>
              )}
            </div>
            <div className="project-list__modal-footer">
              <button
                className="project-list__back-btn"
                onClick={() => setShowCreateModal(false)}
                disabled={creating}
              >
                取消
              </button>
              <button
                className="project-list__create-btn"
                onClick={handleCreate}
                disabled={creating}
              >
                {creating ? '创建中...' : '确认创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirmId !== null && (
        <div className="project-list__modal-overlay" onClick={() => setDeleteConfirmId(null)}>
          <div className="project-list__modal project-list__modal--confirm" onClick={e => e.stopPropagation()}>
            <div className="project-list__modal-header">
              <h3>确认删除</h3>
              <button className="project-list__modal-close" onClick={() => setDeleteConfirmId(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="project-list__modal-body">
              <p style={{ color: '#ccc', fontSize: 14, lineHeight: 1.6 }}>
                确定要删除该项目吗？此操作不可撤销，项目下的所有脚本和配置将被永久删除。
              </p>
            </div>
            <div className="project-list__modal-footer">
              <button
                className="project-list__back-btn"
                onClick={() => setDeleteConfirmId(null)}
                disabled={deleting}
              >
                取消
              </button>
              <button
                className="project-list__delete-confirm-btn"
                onClick={() => handleDelete(deleteConfirmId)}
                disabled={deleting}
              >
                {deleting ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProjectList;
