import { useState, useEffect, useCallback } from 'react';
import { FolderKanban, Play, Edit3, Trash2, Plus, RefreshCw } from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import {
  PROJECT_PERM_EDIT,
  PROJECT_PERM_DELETE,
} from '../../../hooks/useProjectPermissions';
import type { DSProject, DolphinSchedulerApi } from '../../../types/dolphinscheduler';
import {
  PAGE_SIZE,
  SearchBar,
  Pagination,
  ErrorBar,
  InputModal,
  type InputModalProps,
  ConfirmModal,
  formatDateTime,
} from '../shared';

/**
 * 项目列表页 —— 多标签页里每个标签页的入口。
 *
 * 每个标签页各自持有一份列表状态（搜索词、页码、数据），互不干扰：
 * 在标签 A 翻到第 3 页再切到标签 B，A 回来时仍停在第 3 页。
 */

export interface ProjectListViewProps {
  api: DolphinSchedulerApi;
  /** 任一标签页对项目做了增删改后递增，让所有标签页的列表一起刷新，避免看到脏数据 */
  refreshToken: number;
  /**
   * 当前用户对各调度项目的最大权限类型，key 为项目名称（= 开发项目编码）。
   * null 表示权限数据仍在加载；加载期间非超管一律按「无编辑/删除权限」处理。
   */
  permissionByCode: ReadonlyMap<string, number> | null;
  onEnterProject: (project: DSProject) => void;
  onProjectsChanged: () => void;
  onProjectRenamed: (project: DSProject) => void;
  onProjectDeleted: (code: number) => void;
}

const ProjectListView: React.FC<ProjectListViewProps> = ({
  api,
  refreshToken,
  permissionByCode,
  onEnterProject,
  onProjectsChanged,
  onProjectRenamed,
  onProjectDeleted,
}) => {
  const { user } = useAuth();
  const [projects, setProjects] = useState<DSProject[]>([]);
  const [projectsTotal, setProjectsTotal] = useState(0);
  const [projectsPage, setProjectsPage] = useState(1);
  /**
   * 搜索词拆成两份：searchInput 是输入框里的实时文本（不触发请求），
   * appliedSearch 才是真正参与查询的词（回车或点搜索时更新）。
   * 多标签页下同屏可能挂着好几个列表，若每次按键都发请求，冗余会被成倍放大。
   */
  const [searchInput, setSearchInput] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ message: string; onConfirm: () => void } | null>(null);
  const [inputModal, setInputModal] = useState<InputModalProps | null>(null);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.project.list({
        pageNo: projectsPage,
        pageSize: PAGE_SIZE,
        searchVal: appliedSearch || undefined,
      });
      if (res.code === 0 && res.data) {
        setProjects(res.data.totalList || []);
        setProjectsTotal(res.data.total || 0);
      } else {
        setError(res.msg || '获取项目列表失败');
      }
    } catch (e: any) {
      setError(e.message || '请求失败');
    } finally {
      setLoading(false);
    }
  }, [api, projectsPage, appliedSearch]);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects, refreshToken]);

  /** 是否可编辑项目：超管放行，否则需拥有「可编辑」及以上权限（按项目名称匹配权限映射） */
  const canEditProject = (project: DSProject) =>
    !!user?.isSuperAdmin || (permissionByCode?.get(project.name) ?? 0) >= PROJECT_PERM_EDIT;

  /** 是否可删除项目：超管放行，否则需拥有「可删除」权限 */
  const canDeleteProject = (project: DSProject) =>
    !!user?.isSuperAdmin || (permissionByCode?.get(project.name) ?? 0) >= PROJECT_PERM_DELETE;

  /** 回车触发搜索：回到第一页并让搜索词生效 */
  const handleSearch = () => {
    setProjectsPage(1);
    if (searchInput !== appliedSearch) {
      setAppliedSearch(searchInput);
    } else {
      // 搜索词没变（例如连续回车）时不会触发上面的 effect，手动拉一次
      fetchProjects();
    }
  };

  const handleCreateProject = () => {
    setInputModal({
      title: '创建项目',
      fields: [
        { key: 'projectName', label: '项目名称', placeholder: '请输入项目名称', required: true },
        { key: 'description', label: '项目描述', placeholder: '请输入项目描述', type: 'textarea' },
      ],
      onConfirm: async (values) => {
        if (!values.projectName?.trim()) return;
        setInputModal(null);
        try {
          const res = await api.project.create({
            projectName: values.projectName.trim(),
            description: values.description?.trim(),
          });
          if (res.code === 0) {
            onProjectsChanged();
            fetchProjects();
          } else {
            setError(res.msg || '创建项目失败');
          }
        } catch (e: any) {
          setError(e.message || '创建失败');
        }
      },
      onCancel: () => setInputModal(null),
    });
  };

  const handleEditProject = (project: DSProject) => {
    if (!canEditProject(project)) {
      setError('当前用户没有编辑该项目的权限');
      return;
    }
    setInputModal({
      title: '编辑项目',
      fields: [
        { key: 'projectName', label: '项目名称', placeholder: '请输入项目名称', required: true, defaultValue: project.name },
        { key: 'description', label: '项目描述', placeholder: '请输入项目描述', type: 'textarea', defaultValue: project.description },
      ],
      onConfirm: async (values) => {
        if (!values.projectName?.trim()) return;
        setInputModal(null);
        try {
          const res = await api.project.update(project.code, {
            projectName: values.projectName.trim(),
            description: values.description?.trim(),
          });
          if (res.code === 0) {
            // 同步其它标签页里该项目的标题，避免标签名停留在旧名称
            onProjectRenamed({ ...project, name: values.projectName.trim(), description: values.description?.trim() ?? '' });
            fetchProjects();
          } else {
            setError(res.msg || '编辑项目失败');
          }
        } catch (e: any) {
          setError(e.message || '编辑失败');
        }
      },
      onCancel: () => setInputModal(null),
    });
  };

  const handleDeleteProject = (project: DSProject) => {
    if (!canDeleteProject(project)) {
      setError('当前用户没有删除该项目的权限');
      return;
    }
    setConfirmModal({
      message: `确定要删除项目「${project.name}」吗？此操作不可恢复。`,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          const res = await api.project.delete(project.code);
          if (res.code === 0) {
            // 已打开该项目的标签页要退回项目列表，否则会停留在已删除的项目上
            onProjectDeleted(project.code);
            fetchProjects();
          } else {
            setError(res.msg || '删除项目失败');
          }
        } catch (e: any) {
          setError(e.message || '删除失败');
        }
      },
    });
  };

  return (
    <div className="sm-view">
      {error && <ErrorBar message={error} onClose={() => setError(null)} />}

      <div className="sm-section">
        <div className="sm-section__toolbar">
          <h2 className="sm-section__title">
            <FolderKanban size={16} />
            项目管理
          </h2>
          <div className="sm-section__toolbar-actions">
            <SearchBar
              value={searchInput}
              onChange={setSearchInput}
              onSearch={handleSearch}
              placeholder="搜索项目..."
            />
            <button className="sm-btn sm-btn--primary" onClick={handleCreateProject}>
              <Plus size={14} /> 创建项目
            </button>
            <button className="sm-btn sm-btn--ghost" onClick={fetchProjects} title="刷新">
              <RefreshCw size={14} className={loading ? 'sm-spin' : undefined} />
            </button>
          </div>
        </div>

        <div className="sm-table-wrapper">
          <table className="sm-table">
            <thead>
              <tr>
                <th style={{ width: '40px' }}>#</th>
                <th>项目名称</th>
                <th>描述</th>
                <th>负责人</th>
                <th>工作流数</th>
                <th>创建时间</th>
                <th>更新时间</th>
                <th style={{ width: '140px' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {projects.length === 0 ? (
                <tr><td colSpan={8} className="sm-table__empty">{loading ? '加载中...' : '暂无项目数据'}</td></tr>
              ) : (
                projects.map((p, idx) => (
                  <tr key={p.code}>
                    <td className="sm-table__index">{(projectsPage - 1) * PAGE_SIZE + idx + 1}</td>
                    <td className="sm-table__name">
                      <button className="sm-table__link" onClick={() => onEnterProject(p)}>
                        {p.name}
                      </button>
                    </td>
                    <td className="sm-table__desc" title={p.description}>{p.description || '-'}</td>
                    <td>{p.userName || '-'}</td>
                    <td className="sm-table__count">-</td>
                    <td className="sm-table__time">{formatDateTime(p.createTime)}</td>
                    <td className="sm-table__time">{formatDateTime(p.updateTime)}</td>
                    <td className="sm-table__actions">
                      <button className="sm-btn sm-btn--ghost sm-btn--xs" onClick={() => onEnterProject(p)} title="进入项目">
                        <Play size={12} />
                      </button>
                      <button
                        className="sm-btn sm-btn--ghost sm-btn--xs"
                        onClick={() => handleEditProject(p)}
                        title={canEditProject(p) ? '编辑' : '无编辑权限'}
                        disabled={!canEditProject(p)}
                      >
                        <Edit3 size={12} />
                      </button>
                      <button
                        className="sm-btn sm-btn--danger sm-btn--xs"
                        onClick={() => handleDeleteProject(p)}
                        title={canDeleteProject(p) ? '删除' : '无删除权限'}
                        disabled={!canDeleteProject(p)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pagination current={projectsPage} total={projectsTotal} onPageChange={p => setProjectsPage(p)} />
      </div>

      {confirmModal && (
        <ConfirmModal
          message={confirmModal.message}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      )}
      {inputModal && <InputModal {...inputModal} />}
    </div>
  );
};

export default ProjectListView;
