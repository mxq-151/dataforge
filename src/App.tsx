import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import ActivityBar from './components/layout/ActivityBar';
import TitleBar from './components/layout/TitleBar';
import { MENU_CODE_MAP, FIRST_LEVEL_MENU_CODES } from './components/layout/ActivityBar';
import DevAssistantView from './views/dev-assistant/DevAssistantView';
import ProjectList from './views/dev-assistant/ProjectList';
import DataExploreView from './views/data-explore/DataExploreView';
import KnowledgeBasePanel from './views/knowledge-base/KnowledgeBasePanel';
import FileBrowserPanel from './views/file-browser/FileBrowserPanel';
import SettingsView from './views/settings/SettingsView';
import ScheduleManagementPanel from './views/schedule-management/ScheduleManagementPanel';
import DataLineagePanel, { type LineageJumpTarget } from './views/data-lineage/DataLineagePanel';
import SystemManagementPanel from './views/system-management/SystemManagementPanel';
import IndicatorManagementPanel from './views/indicator-management/IndicatorManagementPanel';
import { DolphinSchedulerProvider } from './contexts/DolphinSchedulerContext';
import useOpencodeConfig from './hooks/useOpencodeConfig';
import { OpencodeBackendProvider } from './hooks/opencode/useOpencodeBackend';
import { OpencodeClientProvider, useOpencodeClient } from './hooks/opencode/useOpencodeClient';
import type { LogEntry } from './types/opencode-backend';
import type { OpenCodeConfig } from './types/opencode-backend';
import { ActiveTab } from './types';
import { DataSourceProvider } from './contexts/DataSourceContext';
import { useToast } from './components/Toast';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ToastProvider } from './components/Toast';
import LoginPage from './views/login/LoginPage';
import EditorTestPage from './views/editor-test/EditorTestPage';
import type { ProjectInfo } from './api/devProject';
import disableAutoCapitalize from './utils/disableAutoCapitalize';
import { gitClone, gitPull, checkGitRepoExists, ensureGitWorktree } from './api/git';
import { setApiHost } from './api/index';
import { Store } from './bridge/store';
import { joinPath, hostToDirName } from './utils/pathUtils';
import { getPlatformDefaultWorkspace } from './hooks/useFileSystem';
import './App.css';

/** 与 useOpencodeConfig / Rust 侧 auto_start_opencode 对应的 store 文件名 */
const CONFIG_STORE_FILE = 'opencode-config.json';

const FIRST_LEVEL_TAB_IDS: ActiveTab[] = [
  'devAssist',
  'dataExplore',
  'indicatorManagement',
  'knowledgeBase',
  'fileBrowser',
  'scheduleManagement',
  'dataLineage',
  'systemManagement',
  'settings',
];

const workspaceClassMap: Record<string, string> = {
  devAssist: 'app__workspace--dev-assistant',
  dataExplore: 'app__workspace--data-explore',
  indicatorManagement: 'app__workspace--indicator-management',
  knowledgeBase: 'app__workspace--knowledge-base',
  fileBrowser: 'app__workspace--file-browser',
  scheduleManagement: 'app__workspace--schedule-management',
  dataLineage: 'app__workspace--data-lineage',
  systemManagement: 'app__workspace--system-management',
  settings: 'app__workspace--settings',
};

// ── DevAssistantClientSlot: handles auto-start for dev-assistant ──

function DevAssistantClientSlot({
  config, project,
  projectCwd, workspaceRoot, dsApiUrl, dsToken, onBack,
}: {
  config: OpenCodeConfig;
  project: ProjectInfo;
  projectCwd?: string;
  workspaceRoot?: string;
  dsApiUrl?: string;
  dsToken?: string;
  onBack: () => void;
}) {
  const backend = useOpencodeClient();

  // 用 ref 持有最新的 start 函数，避免 effect 依赖 backend.start 引用变化
  // （backend.logs 在启动过程中频繁变化会导致 backend 引用变更，进而使
  //   backend.start 引用变化，effect 重跑并并发调用 start()，引发 SSE 泄漏）
  const startRef = useRef(backend.start);
  startRef.current = backend.start;

  // 首次显示时自动启动连接（directory 已由 Provider 传入，无需切换）
  useEffect(() => {
    if (!backend.connected && !backend.starting) {
      // fire-and-forget：start 内部已有 try/catch 兜底，这里再 catch 防止任何漏出
      startRef.current().catch((err) => {
        console.error('[DevAssistantClientSlot] start failed:', err);
      });
    }
  }, [backend.connected, backend.starting]);

  return (
    <DevAssistantView
      chatBackend={backend}
      project={project}
      projectCwd={projectCwd}
      workspaceRoot={workspaceRoot}
      dsApiUrl={dsApiUrl}
      dsToken={dsToken}
      config={config}
      onBack={onBack}
    />
  );
}

// ── DataExploreClientSlot: handles auto-start for data-explore ──

function DataExploreClientSlot({
  llmModels,
  activeTab,
  baseWorkspace,
}: {
  llmModels?: import('./types/opencode-backend').LLMModelConfig[];
  activeTab: ActiveTab;
  baseWorkspace?: string;
}) {
  const backend = useOpencodeClient();

  // 用 ref 持有最新的 start 函数，避免 effect 依赖 backend.start 引用变化
  const startRef = useRef(backend.start);
  startRef.current = backend.start;

  // 进入 data-explore tab 时自动启动连接
  useEffect(() => {
    if (activeTab !== 'dataExplore') return;
    if (!backend.connected && !backend.starting) {
      startRef.current().catch((err) => {
        console.error('[DataExploreClientSlot] start failed:', err);
      });
    }
  }, [activeTab, backend.connected, backend.starting]);

  return <DataExploreView chatBackend={backend} llmModels={llmModels} baseWorkspace={baseWorkspace} />;
}

// 编辑器测试页导航：URL 带 page=editor-test 或 hash 含 editor-test 时，
// 跳过登录直接进入测试页（无需后端服务，用于单独调试 src/components/editor 模块）。
const isEditorTestMode = (): boolean => {
  try {
    if (new URLSearchParams(window.location.search).get('page') === 'editor-test') return true;
  } catch { /* ignore */ }
  try {
    if (window.location.hash.toLowerCase().includes('editor-test')) return true;
  } catch { /* ignore */ }
  return false;
};

const App: React.FC = () => {
  // 编辑器测试页仅通过 URL 参数（?page=editor-test）或 hash（#editor-test）访问，应用内无可视入口
  const [testMode] = useState(() => isEditorTestMode());

  return (
    <AuthProvider>
      <ToastProvider>
        {testMode ? (
          // 测试页仍需要 Auth / DataSource 上下文（EditorArea 依赖 useAuth / useDataSourceCache），
          // 但不要求登录，user 为空时相关能力自动降级（数据源为空、无 LSP 客户端启动）。
          <DataSourceProvider>
            <EditorTestPage />
          </DataSourceProvider>
        ) : (
          <AppContent />
        )}
      </ToastProvider>
    </AuthProvider>
  );
};

const AppContent: React.FC = () => {
  const toast = useToast();
  const { authenticated, loading, user } = useAuth();
  const [activeTab, setActiveTab] = useState<ActiveTab>('devAssist');

  // 从用户角色中提取 roleType，用于生成 OpenCode 系统指令
  const roleType = useMemo(() => {
    if (!user?.roles?.length) return undefined;
    const currentRole = user.currentRoleId
      ? user.roles.find(r => r.id === user.currentRoleId)
      : user.roles[0];
    return currentRole?.roleType;
  }, [user?.roles, user?.currentRoleId]);
  const [visitedTabs, setVisitedTabs] = useState<Set<ActiveTab>>(new Set(['devAssist']));
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(null);
  // 跟踪所有访问过的项目，为每个项目保持 OpencodeClientProvider 挂载
  const [visitedProjects, setVisitedProjects] = useState<Map<string, ProjectInfo>>(new Map());

  const handleTabChange = useCallback((tab: ActiveTab) => {
    setActiveTab(tab);
    setVisitedTabs(prev => {
      if (prev.has(tab)) return prev;
      return new Set(prev).add(tab);
    });
  }, []);

  // 数据血缘跳转目标（由指标管理关联字段触发）
  const [lineageJumpTarget, setLineageJumpTarget] = useState<LineageJumpTarget | null>(null);
  const handleNavigateToLineage = useCallback((target: { namespace: string; datasetName: string }) => {
    setLineageJumpTarget({ namespace: target.namespace, datasetName: target.datasetName });
    handleTabChange('dataLineage');
  }, [handleTabChange]);

  const visibleMenuCodes = useMemo(() => {
    if (!user) return FIRST_LEVEL_TAB_IDS.map(id => MENU_CODE_MAP[id]);
    if (user.isSuperAdmin) return FIRST_LEVEL_TAB_IDS.map(id => MENU_CODE_MAP[id]);
    const tags = user.menuTags ?? [];
    // 设置默认所有人可见
    if (!tags.includes('settings')) return [...tags, 'settings'];
    return tags;
  }, [user]);

  const visibleTabIds = useMemo(() => {
    return FIRST_LEVEL_TAB_IDS.filter(id => visibleMenuCodes.includes(MENU_CODE_MAP[id]));
  }, [visibleMenuCodes]);

  useEffect(() => {
    if (visibleTabIds.length > 0 && !visibleTabIds.includes(activeTab)) {
      handleTabChange(visibleTabIds[0]);
    }
  }, [visibleTabIds, activeTab]);

  const isTabVisible = useCallback((tabId: ActiveTab): boolean => {
    // 设置默认所有人可见
    if (tabId === 'settings') return true;
    if (!user) return true;
    if (user.isSuperAdmin) return true;
    const code = MENU_CODE_MAP[tabId];
    if (!code) return false;
    const menuTags = user.menuTags ?? [];
    if (FIRST_LEVEL_MENU_CODES.every(c => menuTags.includes(c))) return true;
    return menuTags.includes(code);
  }, [user, visibleMenuCodes]);

  const { config, updateConfig, resetConfig, loaded } = useOpencodeConfig();

  // 基础工作目录自动计算：$HOME/.dataforge/{后端host}/{登录用户名}/，无需用户配置
  const [baseWorkspace, setBaseWorkspace] = useState<string>('');
  useEffect(() => {
    if (!user?.username) {
      setBaseWorkspace('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // 从 store 读取最新 backendHost（而非本组件可能过期的 React state），
        // 避免登录页改了 host 后这里仍按旧 host 重算 cwd 并覆盖 store。
        const store = await Store.load(CONFIG_STORE_FILE);
        const cfg = (await store.get<Record<string, unknown>>('config')) || {};
        const backendHost = (cfg.backendHost as string) || '';
        if (cancelled) return;
        const home = await getPlatformDefaultWorkspace();
        const hostDir = hostToDirName(backendHost);
        // 目录结构（按需求统一）：
        //   基准（hostBase）= ~/.dataforge/{后端host目录}/
        //   bloop/metals 工作目录 = {hostBase}/code/{project_code}
        //   智能体/文件浏览器     = {hostBase}/code/{project_code}/{project_code}
        //   git 工作空间           = {hostBase}/{gitRepoDirName}/{project_code}
        const base = joinPath(home, hostDir);
        if (cancelled) return;
        setBaseWorkspace(base);
        // 直接写 store 并保留其它字段（后端地址仍以 store 内最新值为准），
        // 供后端 opencode 进程 / 编译 / Git 同步使用
        await store.set('config', { ...cfg, cwd: base });
        await store.save();
      } catch {
        // 读取或写入失败不阻塞
      }
    })();
    return () => { cancelled = true; };
  }, [user?.username]);

  useEffect(() => {
    // 后端地址以当前 store（登录/设置后落库的最新值）为准
    (async () => {
      try {
        const store = await Store.load(CONFIG_STORE_FILE);
        const cfg = (await store.get<Record<string, unknown>>('config')) || {};
        const backendHost = (cfg.backendHost as string) || '';
        if (backendHost) setApiHost(backendHost);
      } catch {
        // ignore
      }
    })();
  }, [loaded]);

  useEffect(() => {
    if (activeTab !== 'devAssist' && activeTab !== 'dataExplore') return;
    // 配置异步加载中，跳过检查（避免初始空值误判）
    if (!loaded) return;
    if (activeTab === 'devAssist' && !config.javaHome) {
      handleTabChange('settings');
      toast.warning('请先在设置页面配置「JAVA_HOME」后再使用开发助手模块');
      return;
    }
  }, [activeTab, config.javaHome, loaded]);

  // 项目目录集合（统一结构，见上方 baseWorkspace 注释）：
  //   projectDir = {hostBase}/code/{project_code}            → bloop/metals 工作目录
  //   agentDir   = {hostBase}/code/{project_code}/{project_code} → 智能体/文件浏览器目录（源码真身）
  //   repoRoot   = {hostBase}/{gitRepoDirName}               → git 全局工作空间
  //   gitProj    = {hostBase}/{gitRepoDirName}/{project_code} → 软链 → agentDir（git 读取 agentDir 数据）
  const projectDirs = useCallback((pc: string) => {
    const projectDir = joinPath(baseWorkspace, 'code', pc);
    const agentDir = joinPath(projectDir, pc);
    const repoRoot = config.gitRepoDirName
      ? joinPath(baseWorkspace, config.gitRepoDirName)
      : '';
    const gitProj = repoRoot ? joinPath(repoRoot, pc) : agentDir;
    return { projectDir, agentDir, gitProj, repoRoot };
  }, [baseWorkspace, config.gitRepoDirName]);

  // 智能体工作目录 & 文件浏览器根目录 = code/{project_code}/{project_code}（源码真身，gitProj 软链指向它）
  const getProjectCwd = useCallback((project: ProjectInfo) => {
    if (!baseWorkspace) return undefined;
    return projectDirs(project.projectCode).agentDir;
  }, [baseWorkspace, projectDirs]);

  const [gitSyncStatus, setGitSyncStatus] = useState<{
    syncing: boolean;
    message: string;
    authError: boolean;
  }>({ syncing: false, message: '', authError: false });

  useEffect(() => {
    if (!config.gitRepoUrl || !config.gitRepoDirName || !baseWorkspace) return;

    const syncGitRepo = async () => {
      const repoPath = joinPath(baseWorkspace, config.gitRepoDirName);

      setGitSyncStatus({ syncing: true, message: '正在检查 Git 仓库...', authError: false });

      try {
        const repoExists = await checkGitRepoExists(repoPath);

        if (repoExists) {
          setGitSyncStatus(prev => ({ ...prev, message: '正在拉取最新代码...' }));
          const pullResult = await gitPull(repoPath, config.gitSshKeyPath || undefined);

          if (pullResult.success) {
            setGitSyncStatus({
              syncing: false,
              message: '✓ 代码已更新到最新版本',
              authError: false,
            });
            setTimeout(() => {
              setGitSyncStatus({ syncing: false, message: '', authError: false });
            }, 2000);
          } else {
            setGitSyncStatus({
              syncing: false,
              message: `⚠ 拉取失败: ${pullResult.message}`,
              authError: pullResult.authRequired,
            });
          }
        } else {
          setGitSyncStatus(prev => ({ ...prev, message: '正在克隆 Git 仓库...（首次配置可能需要较长时间）' }));
          const cloneResult = await gitClone(config.gitRepoUrl, repoPath, config.gitSshKeyPath || undefined);

          if (cloneResult.success) {
            setGitSyncStatus({
              syncing: false,
              message: '✓ Git 仓库克隆成功',
              authError: false,
            });
            setTimeout(() => {
              setGitSyncStatus({ syncing: false, message: '', authError: false });
            }, 2000);
          } else {
            setGitSyncStatus({
              syncing: false,
              message: `⚠ 克隆失败: ${cloneResult.message}`,
              authError: cloneResult.authRequired,
            });
          }
        }
      } catch (err) {
        console.error('[App] Git 同步错误:', err);
        setGitSyncStatus({
          syncing: false,
          message: `✗ Git 操作出错: ${err instanceof Error ? err.message : String(err)}`,
          authError: false,
        });
      }
    };

    syncGitRepo();
  }, [config.gitRepoUrl, config.gitRepoDirName, baseWorkspace, config.gitSshKeyPath]);

  const handleSelectProject = useCallback((project: ProjectInfo) => {
    setSelectedProject(project);
    // 将项目添加到已访问列表，使其 Provider 保持挂载
    setVisitedProjects(prev => {
      if (prev.has(project.projectCode)) return prev;
      const next = new Map(prev);
      next.set(project.projectCode, project);
      return next;
    });
  }, []);

  const handleBackToProjectList = useCallback(() => {
    setSelectedProject(null);
    // 不 stop 服务，保持服务进程持续运行，以便下次切回时直接复用
  }, []);

  // 为每个已访问项目建立「code/{project_code}」工作区目录：
  //   - code/{pc}            → bloop/metals 工作目录（真实目录）
  //   - code/{pc}/{pc}       → 智能体/文件浏览器目录（源码真身，真实目录）
  //   - gitProj → agentDir   → hostBase/{gitRepoDirName}/{project_code} 软链指向 code/{pc}/{pc}，
  //                            使 git 在该软链下读取/提交的与智能体看到的同一份源码。
  // 未配置 gitRepoDirName 时，不建软链，智能体目录直接作为真实目录使用。
  useEffect(() => {
    if (!baseWorkspace || !loaded) return;
    const ensureOne = async (project: ProjectInfo) => {
      const { projectDir, agentDir, gitProj, repoRoot } = projectDirs(project.projectCode);
      try {
        if (repoRoot) {
          await window.dataforge.fs('symlink', { linkPath: gitProj, target: agentDir });
        } else {
          await window.dataforge.fs('mkdir', { path: agentDir, recursive: true });
        }
        await window.dataforge.fs('mkdir', { path: projectDir, recursive: true });
        // 挂载链接工作树：把 {project_code} 子树分支挂到 agentDir，使 git 直接读写/提交 agentDir 里的真实源码
        await ensureGitWorktree(repoRoot, agentDir, project.projectCode);
      } catch (err) {
        console.error('[App] 建立项目目录/软链失败:', project.projectCode, err);
      }
    };
    // hostBase 是 opencode 进程校验/启动的工作目录，先确保存在
    window.dataforge.fs('mkdir', { path: baseWorkspace, recursive: true }).catch(() => {});
    // 选择项目时同步建一次目录，避免 Provider 中的 opencode 后端先于软链启动
    if (selectedProject) void ensureOne(selectedProject);
    for (const project of Array.from(visitedProjects.values())) void ensureOne(project);
  }, [visitedProjects, selectedProject, baseWorkspace, loaded, projectDirs]);

  // Log aggregation: since each client instance lives inside its own provider,
  // we cannot easily aggregate logs from all instances here.
  // The SettingsView will receive empty arrays for now.
  const allLogs: LogEntry[] = [];
  const clearAllLogs = useCallback(() => {}, []);

  useEffect(() => {
    // 窗口初始尺寸/居中/聚焦已由主进程 createWindow 原生实现（工作区 70%），
    // 不再通过渲染层桥接垫片设置。
    disableAutoCapitalize();
  }, []);

  useEffect(() => {
    const handler = () => handleTabChange('settings');
    window.addEventListener('navigate-to-settings', handler);
    return () => window.removeEventListener('navigate-to-settings', handler);
  }, []);

  if (loading) {
    return (
      <div className="app">
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          color: '#aaa',
          gap: '16px',
        }}>
          <div style={{
            width: '32px',
            height: '32px',
            border: '3px solid #333',
            borderTopColor: '#0078d4',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
          <span>正在加载...</span>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return <LoginPage />;
  }

  return (
    <DataSourceProvider>
      <OpencodeBackendProvider options={{
        serverUrl: config.opencodeServerUrl,
        permissionMode: config.permissionMode,
        config,
      }}>
      <div className="app">
        <TitleBar title="dataforge" />
        {gitSyncStatus.message && (
          <div
            className="git-sync-status-bar"
            style={{
              padding: '8px 16px',
              backgroundColor: gitSyncStatus.authError ? '#fff3cd' : gitSyncStatus.syncing ? '#e3f2fd' : '#d4edda',
              color: gitSyncStatus.authError ? '#856404' : gitSyncStatus.syncing ? '#0c5460' : '#155724',
              borderBottom: `1px solid ${gitSyncStatus.authError ? '#ffc107' : gitSyncStatus.syncing ? '#90caf9' : '#c3e6cb'}`,
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              transition: 'all 0.3s ease',
            }}
          >
            <span>{gitSyncStatus.message}</span>
            {gitSyncStatus.authError && (
              <button
                onClick={() => handleTabChange('settings')}
                style={{
                  marginLeft: '12px',
                  padding: '4px 12px',
                  fontSize: '12px',
                  backgroundColor: '#ffc107',
                  color: '#856404',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                去配置免密访问 →
              </button>
            )}
            {!gitSyncStatus.syncing && !gitSyncStatus.authError && (
              <button
                onClick={() => setGitSyncStatus({ syncing: false, message: '', authError: false })}
                style={{
                  marginLeft: '12px',
                  padding: '2px 8px',
                  fontSize: '12px',
                  background: 'transparent',
                  border: 'none',
                  color: 'inherit',
                  cursor: 'pointer',
                  opacity: 0.7,
                }}
              >
                ✕
              </button>
            )}
          </div>
        )}
        <div className={`app__workspace ${workspaceClassMap[activeTab] || ''}`}>
        <ActivityBar
          activeTab={activeTab}
          onTabChange={handleTabChange}
        />
        <div className={`app__view-container ${activeTab === 'devAssist' ? 'app__view-container--active' : ''}`}>
          {isTabVisible('devAssist') && visitedTabs.has('devAssist') && (
          selectedProject ? (
            // 为每个已访问的项目渲染独立的 Provider，保持 hook 状态不丢失
            // 非当前选中的项目用 display:none 隐藏但保持挂载
            Array.from(visitedProjects.values()).map(project => (
              <div
                key={project.projectCode}
                style={{ display: selectedProject.projectCode === project.projectCode ? 'contents' : 'none', height: '100%' }}
              >
                <OpencodeClientProvider
                  config={config}
                  username={user?.username}
                  moduleId="dev-assistant"
                  roleType={roleType}
                  projectId={project.projectCode}
                  directory={getProjectCwd(project)}
                >
                  <DevAssistantClientSlot
                    config={config}
                    project={project}
                    projectCwd={getProjectCwd(project)}
                    workspaceRoot={projectDirs(project.projectCode).projectDir}
                    dsApiUrl={config.dolphinSchedulerApiUrl}
                    dsToken={config.dolphinSchedulerToken}
                    onBack={handleBackToProjectList}
                  />
                </OpencodeClientProvider>
              </div>
            ))
          ) : (
            <ProjectList onSelectProject={handleSelectProject} />
          )
          )}
        </div>
        <div className={`app__view-container ${activeTab === 'dataExplore' ? 'app__view-container--active' : ''}`}>
          {isTabVisible('dataExplore') && visitedTabs.has('dataExplore') && (
            <OpencodeClientProvider
              config={config}
              username={user?.username}
              moduleId="data-explore"
              roleType={roleType}
              projectId="__data_explore__"
              directory={user?.username && baseWorkspace
                ? joinPath(baseWorkspace, user.username, 'individual')
                : null}
            >
              <DataExploreClientSlot
                llmModels={config.llmModels}
                activeTab={activeTab}
                baseWorkspace={baseWorkspace}
              />
            </OpencodeClientProvider>
          )}
        </div>
        <div className={`app__view-container ${activeTab === 'indicatorManagement' ? 'app__view-container--active' : ''}`}>
          {isTabVisible('indicatorManagement') && visitedTabs.has('indicatorManagement') && <IndicatorManagementPanel onNavigateToLineage={handleNavigateToLineage} />}
        </div>
        <div className={`app__view-container ${activeTab === 'knowledgeBase' ? 'app__view-container--active' : ''}`}>
          {isTabVisible('knowledgeBase') && visitedTabs.has('knowledgeBase') && <KnowledgeBasePanel />}
        </div>
        <div className={`app__view-container ${activeTab === 'fileBrowser' ? 'app__view-container--active' : ''}`}>
          {isTabVisible('fileBrowser') && visitedTabs.has('fileBrowser') && <FileBrowserPanel />}
        </div>
        <div className={`app__view-container ${activeTab === 'scheduleManagement' ? 'app__view-container--active' : ''}`}>
          {isTabVisible('scheduleManagement') && visitedTabs.has('scheduleManagement') && (
          <DolphinSchedulerProvider apiUrl={config.dolphinSchedulerApiUrl} token={config.dolphinSchedulerToken}>
            <ScheduleManagementPanel />
          </DolphinSchedulerProvider>
          )}
        </div>
        <div className={`app__view-container ${activeTab === 'dataLineage' ? 'app__view-container--active' : ''}`}>
          {isTabVisible('dataLineage') && visitedTabs.has('dataLineage') && <DataLineagePanel marquezApiUrl={config.marquezApiUrl} jumpTarget={lineageJumpTarget} />}
        </div>
        <div className={`app__view-container ${activeTab === 'systemManagement' ? 'app__view-container--active' : ''}`}>
          {isTabVisible('systemManagement') && visitedTabs.has('systemManagement') && <SystemManagementPanel />}
        </div>
        <div className={`app__view-container ${activeTab === 'settings' ? 'app__view-container--active' : ''}`}>
          {isTabVisible('settings') && visitedTabs.has('settings') && (
          <SettingsView
            config={config}
            onUpdateConfig={updateConfig}
            onResetConfig={resetConfig}
            logs={allLogs}
            onClearLogs={clearAllLogs}
          />
          )}
        </div>
      </div>
      </div>
      </OpencodeBackendProvider>
    </DataSourceProvider>
  );
};

export default App;
