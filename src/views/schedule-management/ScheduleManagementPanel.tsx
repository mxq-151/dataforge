import { useState, useEffect, useCallback, useRef } from 'react';
import { Plus, X, FolderKanban, GitBranch, AlertTriangle } from 'lucide-react';
import { useDolphinSchedulerApi } from '../../contexts/DolphinSchedulerContext';
import type {
  DolphinSchedulerApi,
  DSProject, DSEnvironment, DSAlertGroup,
} from '../../types/dolphinscheduler';
import ProjectListView from './components/ProjectListView';
import ProjectDetailView from './components/ProjectDetailView';
import './ScheduleManagementPanel.css';

/**
 * 调度管理的多标签页宿主。
 *
 * 设计要点：
 * 1. 每个标签页的入口都是项目列表（project 为 null 时渲染 ProjectListView），
 *    在项目列表里点「进入项目」后，该标签页原地切换成项目详情，标签标题变为项目名。
 * 2. 所有标签页始终挂载、用 CSS 切换显隐，这样页码、搜索词、子 Tab、正在编辑的
 *    工作流等状态在切走再切回来后都还在（和编辑器标签页一致的体验）。
 * 3. 同一个项目不会开两个标签页：若目标项目已在别的标签打开，直接激活那个标签。
 * 4. 环境、告警组这类与项目无关的下拉数据是全局共享的，只拉一次。
 */

interface ScheduleTab {
  id: string;
  /** null 表示该标签页停在项目列表，否则停在该项目的详情页 */
  project: DSProject | null;
}

let tabSeq = 0;
const nextTabId = () => `tab-${++tabSeq}`;

const createInitialTabs = (): ScheduleTab[] => [{ id: nextTabId(), project: null }];

interface TabContextMenuState {
  x: number;
  y: number;
  tabId: string;
}

const ScheduleManagementPanelInner: React.FC<{ api: DolphinSchedulerApi }> = ({ api }) => {
  const [tabs, setTabs] = useState<ScheduleTab[]>(createInitialTabs);
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id);

  const [environments, setEnvironments] = useState<DSEnvironment[]>([]);
  const [alertGroups, setAlertGroups] = useState<DSAlertGroup[]>([]);

  /** 任一标签页对项目做了增删改后自增，驱动所有标签页里的项目列表刷新 */
  const [projectListRefreshToken, setProjectListRefreshToken] = useState(0);

  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 与项目无关的下拉数据源，全模块共享
  useEffect(() => {
    let cancelled = false;
    const fetchSharedConfig = async () => {
      try {
        const [envRes, agRes] = await Promise.all([
          api.environment.list({ pageNo: 1, pageSize: 100 }),
          api.alertGroup.list({ pageNo: 1, pageSize: 100 }),
        ]);
        if (cancelled) return;
        if (envRes.code === 0 && envRes.data) {
          const list = Array.isArray(envRes.data) ? envRes.data : (envRes.data.totalList || []);
          setEnvironments(list);
        } else {
          console.warn('[ScheduleManagement] Environments response:', envRes);
        }
        // 个别版本的 DS 返回 status=SUCCESS 而非 code=0，两种成功形态都认
        if ((agRes.code === 0 || (agRes as any).status === 'SUCCESS') && agRes.data) {
          const list = Array.isArray(agRes.data) ? agRes.data : (agRes.data.totalList || []);
          setAlertGroups(list);
        } else {
          console.warn('[ScheduleManagement] Alert groups response:', agRes);
        }
      } catch (err) {
        console.error('[ScheduleManagement] Failed to load config data:', err);
      }
    };
    fetchSharedConfig();
    return () => { cancelled = true; };
  }, [api]);

  // 右键菜单：点击空白处或按 Esc 关闭
  useEffect(() => {
    if (!tabContextMenu) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setTabContextMenu(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTabContextMenu(null);
    };
    // 捕获阶段监听，避免被标签栏自身的 click 抢先
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [tabContextMenu]);

  const addTab = useCallback(() => {
    const id = nextTabId();
    setTabs(prev => [...prev, { id, project: null }]);
    setActiveTabId(id);
  }, []);

  const closeTab = useCallback((tabId: string) => {
    // 始终保留至少一个标签页：关到最后一个时把它重置回项目列表而不是一起关掉
    if (tabs.length <= 1) {
      const only = tabs[0];
      setTabs([{ id: only.id, project: null }]);
      setActiveTabId(only.id);
      return;
    }
    const closedIndex = tabs.findIndex(t => t.id === tabId);
    const remaining = tabs.filter(t => t.id !== tabId);
    setTabs(remaining);
    // 关掉的是当前激活页时，激活它左侧（没有左侧则右侧）的邻居
    if (activeTabId === tabId) {
      setActiveTabId(remaining[Math.min(closedIndex, remaining.length - 1)].id);
    }
  }, [tabs, activeTabId]);

  const closeOtherTabs = useCallback((tabId: string) => {
    setTabs(prev => prev.filter(t => t.id === tabId));
    setActiveTabId(tabId);
  }, []);

  const closeAllTabs = useCallback(() => {
    const fresh = createInitialTabs();
    setTabs(fresh);
    setActiveTabId(fresh[0].id);
  }, []);

  /** 项目列表里点「进入项目」：已在别的标签打开则直接激活，否则在当前标签页原地切换 */
  const handleEnterProject = useCallback((tabId: string, project: DSProject) => {
    const existing = tabs.find(t => t.project?.code === project.code);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    setTabs(prev => prev.map(t => (t.id === tabId ? { ...t, project } : t)));
    setActiveTabId(tabId);
  }, [tabs]);

  /** 项目详情页点「返回项目列表」：当前标签页退回入口，标签标题恢复为「项目列表」 */
  const handleBackToProjectList = useCallback((tabId: string) => {
    setTabs(prev => prev.map(t => (t.id === tabId ? { ...t, project: null } : t)));
  }, []);

  const handleProjectsChanged = useCallback(() => {
    setProjectListRefreshToken(t => t + 1);
  }, []);

  const handleProjectRenamed = useCallback((project: DSProject) => {
    // 同步持有该项目的标签页标题
    setTabs(prev => prev.map(t => (t.project?.code === project.code ? { ...t, project: { ...t.project!, ...project } } : t)));
    setProjectListRefreshToken(t => t + 1);
  }, []);

  const handleProjectDeleted = useCallback((code: number) => {
    // 项目被删后，所有停在该项目的标签页退回项目列表
    setTabs(prev => prev.map(t => (t.project?.code === code ? { ...t, project: null } : t)));
    setProjectListRefreshToken(t => t + 1);
  }, []);

  return (
    <div className="schedule-management">
      <div className="sm-main">
        <div className="sm-tabbar">
          <div className="sm-tabbar__list" role="tablist">
            {tabs.map(tab => {
              const isActive = tab.id === activeTabId;
              const title = tab.project ? tab.project.name : '项目列表';
              return (
                <div
                  key={tab.id}
                  role="tab"
                  aria-selected={isActive}
                  className={`sm-tab ${isActive ? 'sm-tab--active' : ''}`}
                  title={title}
                  onClick={() => setActiveTabId(tab.id)}
                  onMouseDown={e => {
                    // 中键关闭，与编辑器标签页习惯一致
                    if (e.button === 1) {
                      e.preventDefault();
                      closeTab(tab.id);
                    }
                  }}
                  onContextMenu={e => {
                    e.preventDefault();
                    setTabContextMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
                  }}
                >
                  <span className="sm-tab__icon">
                    {tab.project ? <GitBranch size={13} /> : <FolderKanban size={13} />}
                  </span>
                  <span className="sm-tab__label">{title}</span>
                  <span
                    className="sm-tab__close"
                    title="关闭标签页"
                    onClick={e => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                  >
                    <X size={12} />
                  </span>
                </div>
              );
            })}
          </div>
          <button className="sm-tabbar__new" onClick={addTab} title="新建标签页">
            <Plus size={14} />
          </button>
        </div>

        {tabContextMenu && (
          <div
            ref={menuRef}
            className="sm-tab-menu"
            style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
          >
            <button
              className="sm-tab-menu__item"
              onClick={() => { closeTab(tabContextMenu.tabId); setTabContextMenu(null); }}
            >
              关闭
            </button>
            <button
              className="sm-tab-menu__item"
              disabled={tabs.length <= 1}
              onClick={() => { closeOtherTabs(tabContextMenu.tabId); setTabContextMenu(null); }}
            >
              关闭其他
            </button>
            <button
              className="sm-tab-menu__item"
              onClick={() => { closeAllTabs(); setTabContextMenu(null); }}
            >
              关闭全部
            </button>
          </div>
        )}

        <div className="sm-tab-pages">
          {tabs.map(tab => (
            <div
              key={tab.id}
              className={`sm-tab-page ${tab.id === activeTabId ? 'sm-tab-page--active' : ''}`}
              role="tabpanel"
            >
              {tab.project ? (
                <ProjectDetailView
                  key={`${tab.id}:${tab.project.code}`}
                  api={api}
                  project={tab.project}
                  active={tab.id === activeTabId}
                  environments={environments}
                  alertGroups={alertGroups}
                  onBack={() => handleBackToProjectList(tab.id)}
                />
              ) : (
                <ProjectListView
                  key={tab.id}
                  api={api}
                  refreshToken={projectListRefreshToken}
                  onEnterProject={p => handleEnterProject(tab.id, p)}
                  onProjectsChanged={handleProjectsChanged}
                  onProjectRenamed={handleProjectRenamed}
                  onProjectDeleted={handleProjectDeleted}
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const ScheduleManagementPanel: React.FC = () => {
  const { api } = useDolphinSchedulerApi();

  if (!api) {
    return (
      <div className="sm-panel">
        <div className="sm-empty" style={{ padding: 48, textAlign: 'center' }}>
          <AlertTriangle size={48} style={{ color: '#e74c3c', marginBottom: 16 }} />
          <h3 style={{ marginBottom: 8 }}>未配置调度系统</h3>
          <p style={{ color: '#888' }}>请在设置中配置DolphinScheduler API地址和Token后再使用调度管理功能。</p>
        </div>
      </div>
    );
  }

  return <ScheduleManagementPanelInner api={api} />;
};

export default ScheduleManagementPanel;
