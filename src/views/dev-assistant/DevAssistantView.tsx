import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import AIPanel from '../../components/ai/AIPanel';
import EditorArea from '../../components/editor/EditorArea';
import type { EditorAreaHandle } from '../../types';
import ExplorerPanel from './ExplorerPanel';
import SubmitToSchedulerModal from './SubmitToSchedulerModal';
import ExtractMetricsModal from './ExtractMetricsModal';
import FileHistoryModal from './FileHistoryModal';
import { gitRestoreFile, gitFileHasChanges, toRepoRelativePath } from '../../api/git';
import useFileSystem from '../../hooks/useFileSystem';
import useDevProjectConfig from '../../hooks/useDevProjectConfig';
import { useAuth } from '../../contexts/AuthContext';
import { useDataSourceCache } from '../../contexts/DataSourceContext';
import { StatusBarInfo, Tab, FileNode } from '../../types';
import { generateId, generateFileHeader } from '../../utils';
import { getBaseName, splitPath } from '../../utils/pathUtils';
import { extractMetricsFromMarkdown, expandCalcExprBatch } from '../../utils/extractMetrics';
import { generateCommitSummary } from '../../utils/commitSummary';
import { mapCodeFileToTask } from '../../utils/schedulerMapping';
import type { CodeFileMapping, SavedConfig } from '../../utils/schedulerMapping';
import type { ProjectInfo } from '../../api/devProject';
import { createRealDolphinSchedulerApi } from '../../api/dolphinscheduler';
import { indicatorApi } from '../../api/indicator';
import type { IndicatorDTO } from '../../api/indicator';
import type { OpenCodeConfig } from '../../types/opencode-backend';
import type { OpencodeClientBackend } from '../../components/ai/types';
import { useProgramRunner } from '../../hooks/useProgramRunner';
import { ArrowLeft, FolderKanban } from 'lucide-react';
import GlobalSearch from './GlobalSearch';
import { useToast } from '../../components/Toast';
import { invoke } from '../../bridge/ipc';
import { registerDefinitionOpener, readJavaClassFileContent, uriToPath } from '../../services/lsp';
import useProjectDependencyConfig from '../../hooks/useProjectDependencyConfig';
import ProjectDependencyModal from './ProjectDependencyModal';
import { Package } from 'lucide-react';

const CODE_FILE_EXTENSIONS = new Set(['scala', 'sql', 'java', 'py']);
const DEVELOPER_ROLE_NAMES = ['ROLE_DATA_DEV_ENGINEER', 'DATA_DEV_ENGINEER', '数据开发工程师'];

// Recursively read all file contents from the file tree
async function snapshotWorkspaceFiles(
  nodes: FileNode[],
  readFileContent: (path: string) => Promise<string>
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function traverse(nodeList: FileNode[]) {
    for (const node of nodeList) {
      if (node.type === 'file') {
        try {
          files[node.path] = await readFileContent(node.path);
        } catch {
          // Skip files that can't be read
        }
      }
      if (node.children) {
        await traverse(node.children);
      }
    }
  }
  await traverse(nodes);
  return files;
}

/** Derive all folder paths from a set of file paths */
function deriveFolderPaths(filePaths: string[]): Set<string> {
  const folders = new Set<string>();
  for (const fp of filePaths) {
    const parts = splitPath(fp);
    // Build parent paths: 'a/b/c.txt' → 'a', 'a/b'
    for (let i = 1; i < parts.length; i++) {
      folders.add(parts.slice(0, i).join('/'));
    }
  }
  return folders;
}

/** Collect all folder paths from a file tree */
function collectFolderPaths(nodes: FileNode[]): string[] {
  const paths: string[] = [];
  function traverse(nodeList: FileNode[]) {
    for (const node of nodeList) {
      if (node.type === 'folder') {
        paths.push(node.path);
      }
      if (node.children) {
        traverse(node.children);
      }
    }
  }
  traverse(nodes);
  return paths;
}

function isCodeFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return CODE_FILE_EXTENSIONS.has(ext);
}

function isDeveloper(roles: { roleCode: string; roleName?: string }[]): boolean {
  if (!roles || roles.length === 0) return false;
  return roles.some(role =>
    DEVELOPER_ROLE_NAMES.some(devRole =>
      role.roleCode === devRole ||
      role.roleCode?.toUpperCase() === devRole.toUpperCase() ||
      role.roleName === devRole
    )
  );
}

// 将任意字符串映射为稳定的短标识（用于依赖源码 Tab 的唯一 id）
function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(36);
}

// 内容指纹：取前 36 个字符，换行替换为 ⏎，便于在日志中识别"哪段内容进了哪个 Tab"。
function fp(s?: string): string {
  return (s || '').slice(0, 36).replace(/\r?\n/g, '⏎');
}

// 判断 Tab 是否为 LSP 虚拟源码 Tab（只读，由定义跳转以新 Tab 打开）：
// - metals: Scala 的第三方依赖源码（.metals/readonly）—— 现在 Tab path 用原始
//   file://.../.metals/readonly/... URI（见下方 opener），所以也要识别这种路径。
// - jdt: Java 的 JDK / 第三方库类源码（JDT.LS 虚拟文档）
// 二者内容只在内存中，绝不能触发磁盘读写/落盘。
function isVirtualSourceTab(tab: Tab | undefined): boolean {
  return !!tab && (
    tab.path.startsWith('metals:') ||
    tab.path.startsWith('jdt:') ||
    tab.path.includes('/.metals/readonly/')
  );
}

interface DevAssistantViewProps {
  chatBackend: OpencodeClientBackend;
  project: ProjectInfo;
  projectCwd?: string;
  /** bloop/metals 工作目录（code/{project_code}）。缺省回退到 config.cwd。 */
  workspaceRoot?: string;
  /** git 每次拉取/挂载源码完成后递增，用于在拉完代码后刷新文件浏览器（首进常有打开空目录的竞态） */
  gitRefreshSeq?: number;
  dsApiUrl?: string;
  dsToken?: string;
  config: OpenCodeConfig;
  onBack: () => void;
}

const DevAssistantView: React.FC<DevAssistantViewProps> = ({ chatBackend, project, projectCwd, workspaceRoot, gitRefreshSeq, dsApiUrl, dsToken, config, onBack }) => {
  const { user } = useAuth();
  const { refresh } = useDataSourceCache();
  const toast = useToast();

  // 项目级依赖配置（开发助手模块）：作为编译与悬停提示的默认依赖集合，
  // 与逐文件依赖合并生效。后端未部署项目级接口时优雅降级为空（仅逐文件行为）。
  const projectDepConfig = useProjectDependencyConfig(project.id, project.projectCode);

  // 逐文件参数配置读写（含依赖 jarPath 等）：用于打开标签时从后端 /params 兜底加载，
  // 避免 --jars 只依赖本会话手动勾选
  const devProjectConfig = useDevProjectConfig();

  // 打开开发助手模块时加载库表信息
  useEffect(() => {
    refresh();
  }, [refresh]);

  // handleFileSelect 在下方声明，用 ref 转发以避免循环依赖并始终调用最新实现。
  // 第二个可选参数为「跳转目标位置」（1-based），用于定义跳转打开文件后定位到目标行。
  const handleFileSelectRef = useRef<((filePath: string, revealRange?: { line: number; column: number }) => void) | undefined>(undefined);
  useEffect(() => {
    handleFileSelectRef.current = handleFileSelect;
  });

  // 注册 LSP 定义跳转的「外部目标」打开器：第三方 JAR 源码（.metals/readonly、jdt://）与
  // 项目内其它文件，均在本应用的 Tab 体系中以新 Tab 打开，并定位到定义所在行。
  // 本应用是单编辑器架构，VS Code EditorService 打开的外部文档无法渲染，因此必须由 React 层接管。
  useEffect(() => {
    registerDefinitionOpener(async (locations) => {
      for (const loc of locations) {
        const uriStr = loc.uri;
        invoke('trace_log', { msg: `[DEF>opener] uri=${uriStr}` }).catch(() => undefined);
        if (uriStr.startsWith('file://') && uriStr.includes('/.metals/readonly/')) {
          const diskPath = uriToPath(uriStr);
          const base = diskPath.split('/').pop() || 'source';
          const tabId = `metals-${hashStr(diskPath)}`;
          // 关键：保留原始 file:// URI 作为 Tab path（而非转成 metals://）。
          // Metals 服务器原生返回的就是 file://.../.metals/readonly/... URI，它认识这种路径；
          // documentSelector 的 {scheme:'file'} 能匹配 → 客户端 didOpen 给 Metals →
          // 悬停/定义跳转在该只读 Tab 内可用。之前用 metals:// scheme 会被 Metals 拒绝
          // （Internal error），改用 file:// 即可与 VS Code Metals 行为一致。
          const tabPath = uriStr;
          // 立即创建 Tab + 占位内容 + 定位 + 切换，让编辑器瞬时响应；源码异步回填。
          // 首次读取 JAR 较慢（LSP 冷启动 + 解压），占位避免用户以为「卡死」。
          setTabs(prev =>
            prev.some(t => t.id === tabId)
              ? prev
              : [...prev, { id: tabId, name: base, path: tabPath, isModified: false }]
          );
          setEditorContent(prev => prev[tabId] !== undefined
            ? prev
            : { ...prev, [tabId]: `// 正在加载 ${base} 的源码…\n` });
          const r = loc.range?.start;
          if (r) {
            setTabRanges(prev => ({ ...prev, [tabId]: { line: (r.line ?? 0) + 1, column: (r.character ?? 0) + 1 } }));
          }
          setActiveTabId(tabId);
          // 已有内容（重复跳转）或在途加载（Ctrl+Click 双触发）则不再重复读取
          if (editorContentRef.current[tabId] === undefined && !fetchingTabsRef.current.has(tabId)) {
            fetchingTabsRef.current.add(tabId);
            invoke<string>('read_metals_source', { path: diskPath })
              .then((content) => {
                setEditorContent(prev => ({ ...prev, [tabId]: content }));
              })
              .catch((e) => {
                console.warn('[DevAssistant] 打开依赖源码失败:', e);
                setEditorContent(prev => ({ ...prev, [tabId]: `// 无法加载依赖源码: ${base}\n// ${String((e as Error)?.message ?? e)}\n` }));
                toast.warning('无法打开依赖源码（请确认依赖已正确导入）');
              })
              .finally(() => { fetchingTabsRef.current.delete(tabId); });
          }
        } else if (uriStr.startsWith('jdt:')) {
          // JDK / 第三方库类源码（JDT.LS 的 jdt:// 虚拟文档）：向 JDT.LS 请求类文件源码
          // （源码附件或反编译结果），以只读 Tab 打开，体验与 Red Hat Java 扩展一致。
          // jdt:// URI 形如 jdt://contents/java.base/java.lang/String.class?...
          // 取路径最后一段（含 .class 后缀）作为 Tab 名，EditorArea 按 jdt: 前缀强制 Java 高亮
          const className = uriStr.split('?')[0].split('/').pop() || 'Class.class';
          const tabId = `jdt-${hashStr(uriStr)}`;
          // 立即创建 Tab + 占位 + 切换；类源码（可能需反编译）异步回填
          setTabs(prev =>
            prev.some(t => t.id === tabId)
              ? prev
              : [...prev, { id: tabId, name: className, path: uriStr, isModified: false }]
          );
          setEditorContent(prev => prev[tabId] !== undefined
            ? prev
            : { ...prev, [tabId]: `// 正在加载 ${className} 的源码…\n` });
          const r = loc.range?.start;
          if (r) {
            setTabRanges(prev => ({ ...prev, [tabId]: { line: (r.line ?? 0) + 1, column: (r.character ?? 0) + 1 } }));
          }
          setActiveTabId(tabId);
          invoke('trace_log', { msg: `[DEF>jdt] 切换tab=${tabId} 内容已载=${editorContentRef.current[tabId] !== undefined} fetching=${fetchingTabsRef.current.has(tabId)}` }).catch(() => undefined);
          // 重复跳转同一类命中前端缓存（readJavaClassFileContent 内部已缓存）；双触发时在途去重
          if (editorContentRef.current[tabId] === undefined && !fetchingTabsRef.current.has(tabId)) {
            fetchingTabsRef.current.add(tabId);
            readJavaClassFileContent(uriStr)
              .then((content) => {
                setEditorContent(prev => ({
                  ...prev,
                  [tabId]: content
                    ? content
                    : `// 类源码不可用: ${className}\n// JDT.LS 既无源码附件（sources jar）也未能反编译出内容。\n// 可尝试在依赖里附带 -sources.jar，或检查 Maven 是否下载了源码包。\n`,
                }));
              })
              .catch((e) => {
                console.warn('[DevAssistant] 打开 JDK / 依赖类源码失败:', e);
                setEditorContent(prev => ({ ...prev, [tabId]: `// 无法加载类源码: ${className}\n// ${String((e as Error)?.message ?? e)}\n` }));
                toast.warning('无法打开类源码（请确认 JDT.LS 已就绪）');
              })
              .finally(() => { fetchingTabsRef.current.delete(tabId); });
          }
        } else if (uriStr.startsWith('file://')) {
          // 项目内文件：走现有逻辑打开为普通 Tab，并定位到定义所在行
          const r = loc.range?.start;
          const reveal = r ? { line: (r.line ?? 0) + 1, column: (r.character ?? 0) + 1 } : undefined;
          const diskPath = uriToPath(uriStr);
          invoke('trace_log', { msg: `[DEF>file] path=${diskPath} reveal=${JSON.stringify(reveal)} handler=${!!handleFileSelectRef.current}` }).catch(() => undefined);
          handleFileSelectRef.current?.(diskPath, reveal);
        } else {
          // 无法路由的 scheme（既非 metals readonly、也非 jdt、也非项目内 file://）
          console.warn('[DevAssistant] 不支持的跳转目标 URI，已忽略:', uriStr);
          toast.warning(`不支持的定义跳转目标：${uriStr.slice(0, 80)}`);
        }
      }
    });
    return () => {
      registerDefinitionOpener(null);
    };
  }, [toast]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState<Record<string, string>>({});
  // 记录各 Tab 的「跳转目标位置」（1-based），用于打开依赖源码后定位到定义行
  const [tabRanges, setTabRanges] = useState<Record<string, { line: number; column: number }>>({});

  // 跳转定义定位完成后清理对应 Tab 的 range，避免后续切换又被强制跳回原目标行，
  // 从而让 viewState 恢复机制能正确恢复用户后续浏览的位置
  const handleTabRangeConsumed = useCallback((tabId: string) => {
    setTabRanges(prev => {
      if (!prev[tabId]) return prev;
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  }, []);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [savedConfigParams, setSavedConfigParams] = useState<Record<string, {
    dependencies: { id: string; name: string; version: string; source?: string; jarPath?: string; groupId?: string; scope?: string; autoChoose?: number | null; basePath?: string }[];
    programParams: { id: string; key: string; value: string }[];
    taskParams: { id: string; key: string; value: string }[];
  }>>({});
  const [submitModalVisible, setSubmitModalVisible] = useState(false);
  const [extractMetricsVisible, setExtractMetricsVisible] = useState(false);
  const [extractedIndicators, setExtractedIndicators] = useState<IndicatorDTO[]>([]);
  const [projectDepModalVisible, setProjectDepModalVisible] = useState(false);
  const [explorerWidth, setExplorerWidth] = useState<number | null>(null);
  const [isExplorerCollapsed, setIsExplorerCollapsed] = useState(false);
  const editorAreaRef = useRef<EditorAreaHandle>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isResizingRef = useRef(false);
  const resizeStartXRef = useRef(0);
  const resizeStartWidthRef = useRef(0);

  // 用 ref 持有最新的 activeTabId / editorContent，避免 handleEditorChange 等回调
  // 因闭包拿到过期的 activeTabId 而把内容写错 Tab（Tab 快速切换时的竞态）。
  const activeTabIdRef = useRef<string | null>(null);
  activeTabIdRef.current = activeTabId;
  const editorContentRef = useRef<Record<string, string>>({});
  editorContentRef.current = editorContent;
  // 正在加载源码的 Tab 集合：避免 Ctrl+Click「预览+点击」双触发时对同一 Tab 读两次源码
  // （第二次调用时 setEditorContent 的占位内容尚未刷到 ref，会误判为未加载而重复读取）
  const fetchingTabsRef = useRef<Set<string>>(new Set());

  // File snapshots for rollback: Map<userMessageIndex, Record<filePath, content>>
  const [fileSnapshots, setFileSnapshots] = useState<Map<number, Record<string, string>>>(new Map());
  const fileSnapshotsRef = useRef<Map<number, Record<string, string>>>(new Map());

  // Keep ref in sync with state
  useEffect(() => {
    fileSnapshotsRef.current = fileSnapshots;
  }, [fileSnapshots]);

  // SubmitToSchedulerModal 打开时强制编辑器失焦，避免第一个点击被编辑器 blur 消费
  useEffect(() => {
    if (submitModalVisible) {
      editorAreaRef.current?.blurEditor();
    }
  }, [submitModalVisible]);

  const dsApi = useMemo(() => {
    if (dsApiUrl && dsToken) {
      return { api: createRealDolphinSchedulerApi(dsApiUrl, dsToken), isRealApi: true };
    }
    return { api: null, isRealApi: false };
  }, [dsApiUrl, dsToken]);

  const currentMapping: CodeFileMapping | null = useMemo(() => {
    if (!activeTabId) return null;
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return null;
    const content = editorContent[activeTabId] || '';
    if (!content.trim()) return null;
    const config = savedConfigParams[tab.path] as SavedConfig | undefined;
    return mapCodeFileToTask(tab.name, content, tab.path, projectCwd, config || null);
  }, [activeTabId, tabs, editorContent, savedConfigParams, projectCwd]);

  const {
    rootPath,
    fileTree,
    isLoading,
    openFolder,
    readFile,
    readFileContent,
    createFile,
    createFolder,
    saveFile,
    deleteNode,
    renameNode,
    moveNode,
    copyNode,
    refreshTree,
  } = useFileSystem(projectCwd);

  // git 拉取/挂载源码完成（gitRefreshSeq 递增）后刷新文件浏览器，
  // 解决首次进入项目时文件浏览器先于 git 拉取完成、看到空目录的问题。
  useEffect(() => {
    if (gitRefreshSeq !== undefined && gitRefreshSeq > 0) {
      refreshTree();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitRefreshSeq]);

  // AI 修改文件后自动刷新编辑器和文件树
  useEffect(() => {
    if (chatBackend.lastFileChangeSeq === 0) return; // 初始状态不触发
    const changedPaths = chatBackend.lastFileChangePaths;
    console.log('[DF::FileChange] Refreshing editor after AI file change, seq=', chatBackend.lastFileChangeSeq, 'paths=', changedPaths);

    // 1. 刷新文件树
    refreshTree();

    // 2. 刷新当前打开的标签页中匹配变更路径的内容
    if (changedPaths.length > 0 && tabs.length > 0) {
      const changedSet = new Set(changedPaths);
      for (const tab of tabs) {
        if (changedSet.has(tab.path)) {
          readFileContent(tab.path)
            .then(content => {
              setEditorContent(prev => ({ ...prev, [tab.id]: content }));
              setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, isModified: false } : t));
              console.log('[DF::FileChange] Refreshed editor content for', tab.path);
            })
            .catch(err => {
              console.warn('[DF::FileChange] Failed to refresh editor for', tab.path, err);
            });
        }
      }
    }
  }, [chatBackend.lastFileChangeSeq]);

  // 逐文件 --jars 兜底：标签已打开但本会话未保存过配置（savedConfigParams 缺失）时，
  // 从后端 /params 拉取已保存的依赖/参数配置并写入内存态，使 --jars 无需手动勾选即可生成。
  useEffect(() => {
    if (!activeTabId) return;
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return;
    if (savedConfigParams[tab.path]) return; // 内存态已有，无需兜底
    if (!projectCwd) return;
    let cancelled = false;
    // 后端持久化/查询按 (project_id, file_path) 联合键，file_path 需为项目内相对路径
    // （unifiedCompile 也用相对路径回读），故转相对后再请求
    const relPath = toRepoRelativePath(tab.path, projectCwd);
    devProjectConfig.fetchByFilePath(project.id, relPath).then(loaded => {
      if (cancelled) return;
      if (!loaded) return;
      setSavedConfigParams(prev => {
        // 若加载期间用户已保存则不再覆盖
        if (prev[tab.path]) return prev;
        return { ...prev, [tab.path]: {
          dependencies: loaded.dependencies,
          programParams: loaded.programParams,
          taskParams: loaded.taskParams,
        } };
      });
    });
    return () => { cancelled = true; };
    // activeTabId 切换时重新评估；savedConfigParams 更新后条件自然放行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, tabs, project.id, savedConfigParams]);

  // 提取的运行/编译/取消执行逻辑
  const {
    handleRunProgram,
    handleCompileDryRun,
    handleCancelExecution,
    isRunning,
    isCompiling,
    executionHistory,
    currentResults,
    runningLogs,
  } = useProgramRunner({
    project,
    username: user?.username ?? '',
    config,
    projectCwd,
    readFile,
    tabs,
    activeTabId,
    currentContent: activeTabId ? (editorContent[activeTabId] || '') : '',
    savedConfigParams,
    editorAreaRef: editorAreaRef as any,
    projectDependencies: projectDepConfig.dependencies,
  });

  const currentContent = activeTabId ? editorContent[activeTabId] || '' : ''; // computed for JSX

  // Wrap sendMessage to take file snapshot before each user message
  const sendMessageWithSnapshot = useCallback(async (line: string) => {
    // Take snapshot of current workspace files before sending
    const currentUserCount = chatBackend.messages.filter(e => e.info.role === 'user').length;
    const snapshot = await snapshotWorkspaceFiles(fileTree, readFileContent);
    setFileSnapshots(prev => {
      const newMap = new Map(prev);
      newMap.set(currentUserCount, snapshot);
      return newMap;
    });
    chatBackend.sendMessage(line);
  }, [chatBackend, fileTree, readFileContent]);

  // Handle rollback: restore files + rollback context
  const handleRollback = useCallback(async (messageId: string) => {
    // 0. Refresh file tree to get current state (including AI-created files not yet in the tree)
    const currentTree = await refreshTree();

    // 将 messageId 转换为用户消息索引（用于查找快照）
    const messageIdx = chatBackend.messages.findIndex(e => e.info.id === messageId);
    const userMessageIndex = messageIdx >= 0
      ? chatBackend.messages.slice(0, messageIdx + 1).filter(e => e.info.role === 'user').length - 1
      : -1;

    // 1. Restore files from snapshot
    const snapshot = userMessageIndex >= 0 ? fileSnapshotsRef.current.get(userMessageIndex) : undefined;
    if (snapshot) {
      // Restore all files from the snapshot
      for (const [path, content] of Object.entries(snapshot)) {
        await saveFile(path, content);
      }

      // Delete files that were created after the snapshot (exist on disk but not in snapshot)
      const currentFiles = await snapshotWorkspaceFiles(currentTree, readFileContent);
      for (const path of Object.keys(currentFiles)) {
        if (!(path in snapshot)) {
          await deleteNode(path, 'file');
        }
      }

      // Delete folders that were created after the snapshot
      const snapshotFolderPaths = deriveFolderPaths(Object.keys(snapshot));
      const currentFolderPaths = collectFolderPaths(currentTree);
      // Sort by depth descending (deepest first) so children are deleted before parents
      const foldersToDelete = currentFolderPaths
        .filter(p => !snapshotFolderPaths.has(p))
        .sort((a, b) => splitPath(b).length - splitPath(a).length);
      for (const folderPath of foldersToDelete) {
        await deleteNode(folderPath, 'folder');
      }

      // Refresh tree again to reflect restored + deleted files
      await refreshTree();
    }

    // 2. Rollback context via backend
    await chatBackend.sendRollback(messageId);

    // 3. Clean up snapshots for rolled-back messages
    if (userMessageIndex >= 0) {
      setFileSnapshots(prev => {
        const newMap = new Map(prev);
        for (const key of Array.from(newMap.keys())) {
          if (key >= userMessageIndex) {
            newMap.delete(key);
          }
        }
        return newMap;
      });
    }

    // 4. Update open tabs: close tabs for deleted files, update content for restored files
    setTabs(prev => {
      let tabsAfterClose = prev;
      if (snapshot) {
        tabsAfterClose = prev.filter(tab => {
          if (!(tab.path in snapshot)) {
            // File was deleted, remove from editorContent
            setEditorContent(editorPrev => {
              const next = { ...editorPrev };
              delete next[tab.id];
              return next;
            });
            return false;
          }
          return true;
        });
      }
      return tabsAfterClose;
    });

    // 5. Update editor content for tabs whose files were restored
    if (snapshot) {
      setEditorContent(prev => {
        const next = { ...prev };
        for (const tab of tabs) {
          if (tab.path in snapshot) {
            next[tab.id] = snapshot[tab.path];
          }
        }
        return next;
      });
    }

    toast.info('已回滚到指定消息之前的状态');
  }, [chatBackend, readFileContent, saveFile, deleteNode, refreshTree, toast, tabs]);

  const handleOpenFolder = useCallback(async () => {
    await openFolder(rootPath || undefined);
  }, [openFolder, rootPath]);

  // 文件历史版本：当前查看的文件
  const [historyTarget, setHistoryTarget] = useState<{ filePath: string } | null>(null);

  // 用指定提交的内容回滚文件：写盘 + 刷新文件树 + 同步已打开的编辑器标签
  const handleRollbackFile = useCallback(async (commitHash: string, content: string): Promise<boolean> => {
    if (!historyTarget) return false;
    const fp = historyTarget.filePath;

    const ok = await saveFile(fp, content);
    if (!ok) return false;

    await refreshTree();

    const tab = tabs.find(t => t.path === fp);
    if (tab) {
      setEditorContent(prev => ({ ...prev, [tab.id]: content }));
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, isModified: false } : t));
    }

    console.log(`[DF] 文件已回滚: ${fp} <- ${commitHash}`);
    return true;
  }, [historyTarget, saveFile, refreshTree, tabs, setEditorContent]);

  // 撤销文件变更：把文件恢复到上次提交(HEAD)状态，丢弃所有未提交改动
  const handleRevertFile = useCallback(async (filePath: string) => {
    const name = filePath.split(/[/\\]/).pop() || filePath;
    if (!projectCwd) {
      toast.error('无法定位仓库根目录');
      return;
    }
    if (!window.confirm(`确认撤销「${name}」中的所有未提交修改？\n该操作将把文件恢复到最后一次提交的状态，不可恢复！`)) {
      return;
    }
    const rel = toRepoRelativePath(filePath, projectCwd);
    const ok = await gitRestoreFile(projectCwd, rel);
    if (!ok) {
      toast.error('撤销失败：该文件没有未提交改动或尚未纳入 Git 管理');
      return;
    }
    await refreshTree();
    // 若文件已打开，重新读取内容刷新编辑器
    const tab = tabs.find(t => t.path === filePath);
    if (tab) {
      const content = await readFileContent(filePath);
      setEditorContent(prev => ({ ...prev, [tab.id]: content }));
      setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, isModified: false } : t));
    }
    toast.info(`已撤销「${name}」的未提交修改`);
  }, [projectCwd, refreshTree, readFileContent, tabs, toast]);

  // 判断文件是否有未提交变更（用于置灰「撤销文件变更」）
  const handleCheckFileChanged = useCallback(async (filePath: string): Promise<boolean> => {
    if (!projectCwd) return false;
    const rel = toRepoRelativePath(filePath, projectCwd);
    return gitFileHasChanges(projectCwd, rel);
  }, [projectCwd]);

  const handleFileSelect = useCallback(async (filePath: string, revealRange?: { line: number; column: number }) => {
    if (isCodeFile(filePath) && !user?.isSuperAdmin && !isDeveloper(user?.roles || [])) {
      toast.warning(`当前角色无权编辑代码文件（.${filePath.split('.').pop()}），仅数据开发工程师可操作 Scala/SQL/Java/Python 文件`);
      setSelectedFile(filePath);
      return;
    }
    setSelectedFile(filePath);

    const fileName = getBaseName(filePath);
    const existingTab = tabs.find(t => t.path === filePath);

    if (!existingTab) {
      const newTab: Tab = {
        id: generateId().toString(),
        name: fileName,
        path: filePath,
        isModified: false,
      };

      setTabs(prev => [...prev, newTab]);
      setActiveTabId(newTab.id);
      // 定义跳转打开的文件：记录目标行，EditorArea 挂载后定位
      if (revealRange) {
        setTabRanges(prev => ({ ...prev, [newTab.id]: revealRange }));
      }

      try {
        const content = await readFileContent(filePath);
        const header = generateFileHeader(filePath, rootPath || undefined);
        const finalContent = content.trim() === '' && header ? header : content;
        setEditorContent(prev => ({ ...prev, [newTab.id]: finalContent }));
        console.log('[DF::Trace][fileOpen] tab=', newTab.id, 'path=', filePath, 'fp=', fp(finalContent));
        if (finalContent !== content) {
          await saveFile(filePath, finalContent);
        }
      } catch (error) {
        console.error('读取文件失败:', error);
        const header = generateFileHeader(filePath, rootPath || undefined);
        setEditorContent(prev => ({ ...prev, [newTab.id]: header }));
        if (header) {
          await saveFile(filePath, header);
        }
      }
    } else {
      setActiveTabId(existingTab.id);
      // 已打开的文件：更新目标行以触发定位
      if (revealRange) {
        setTabRanges(prev => ({ ...prev, [existingTab.id]: revealRange }));
      }
    }
  }, [tabs, readFileContent, user]);

  const handleFolderToggle = useCallback((folderPath: string) => {
    setExpandedFolders(prev => {
      const newSet = new Set(prev);
      if (newSet.has(folderPath)) {
        newSet.delete(folderPath);
      } else {
        newSet.add(folderPath);
      }
      return newSet;
    });
  }, []);

  const handleViewDiff = useCallback((filePath: string, patch: string) => {
    const filename = getBaseName(filePath);
    const diffTabId = `__diff__${filePath}`;

    // 如果已有该 diff 标签页，直接切换
    const existingTab = tabs.find(t => t.id === diffTabId);
    if (existingTab) {
      setActiveTabId(diffTabId);
      return;
    }

    // 创建 diff 标签页，内容为格式化的 diff
    const newTab: Tab = {
      id: diffTabId,
      name: `变更: ${filename}`,
      path: filePath,
      isModified: false,
    };

    setTabs(prev => [...prev, newTab]);
    setActiveTabId(diffTabId);

    // 格式化 patch 为可读的 diff 内容
    const lines = patch.split('\n');
    const formatted = lines.map(line => {
      if (line.startsWith('@@')) return `  ${line}`;
      if (line.startsWith('+')) return `+ ${line.slice(1)}`;
      if (line.startsWith('-')) return `- ${line.slice(1)}`;
      return `  ${line}`;
    }).join('\n');

    setEditorContent(prev => ({ ...prev, [diffTabId]: formatted }));
  }, [tabs]);

  const handleTabSelect = useCallback(async (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (tab && isVirtualSourceTab(tab)) {
      // 虚拟源码（metals:/jdt:）已在打开时载入内存，无需从磁盘重新读取
      setActiveTabId(tabId);
      setSelectedFile(tab.path);
      return;
    }
    setActiveTabId(tabId);
    const tab2 = tabs.find(t => t.id === tabId);
    if (tab2) {
      setSelectedFile(tab2.path);
      // 关键修复：仅当该 Tab 从未载入内存内容时才从磁盘读取。
      // 否则每次切换 Tab 都会用磁盘旧内容覆盖内存中的编辑（例如 F12 跳转离开再返回
      // 时，未保存的修改会被静默冲掉），这正是「原文件内容被替换」的根因。
      // 已在内存中的 Tab（含未保存编辑）直接保留；外部（AI）改动由 lastFileChangeSeq
      // 副作用统一刷新，不在此重复回读。
      if (!editorContentRef.current[tabId]) {
        try {
          const content = await readFileContent(tab2.path);
          setEditorContent(prev => ({ ...prev, [tabId]: content }));
          console.log('[DF::Trace][diskRead] tab=', tabId, 'path=', tab2.path, 'fp=', fp(content));
          // 清除修改标记（因为已与磁盘同步）
          setTabs(prev => prev.map(t => t.id === tabId ? { ...t, isModified: false } : t));
        } catch {
          // 读取失败时保留缓存内容
        }
      }
    }
  }, [tabs, readFileContent]);

  const handleTabClose = useCallback((tabId: string) => {
    setTabs(prev => prev.filter(t => t.id !== tabId));
    setEditorContent(prev => {
      const newContent = { ...prev };
      delete newContent[tabId];
      return newContent;
    });

    if (activeTabId === tabId) {
      const remainingTabs = tabs.filter(t => t.id !== tabId);
      if (remainingTabs.length > 0) {
        const lastTab = remainingTabs[remainingTabs.length - 1];
        setActiveTabId(lastTab.id);
        setSelectedFile(lastTab.path);
      } else {
        setActiveTabId(null);
        setSelectedFile(null);
      }
    }
  }, [activeTabId, tabs]);

  const handleDeleteNode = useCallback(async (nodePath: string, nodeType: 'file' | 'folder'): Promise<boolean> => {
    const success = await deleteNode(nodePath, nodeType);
    if (success) {
      if (nodeType === 'file') {
        const tabToClose = tabs.find(t => t.path === nodePath);
        if (tabToClose) {
          handleTabClose(tabToClose.id);
        }
        if (selectedFile === nodePath) {
          setSelectedFile(null);
        }
      }
      if (nodeType === 'folder') {
        setExpandedFolders(prev => {
          const newSet = new Set(prev);
          const pathsToRemove = Array.from(newSet).filter(p => p.startsWith(nodePath));
          pathsToRemove.forEach(p => newSet.delete(p));
          return newSet;
        });
        const tabsToClose = tabs.filter(t => t.path.startsWith(nodePath + '/'));
        tabsToClose.forEach(tab => handleTabClose(tab.id));
      }
    }
    return success;
  }, [deleteNode, tabs, selectedFile, handleTabClose]);

  const handleEditorChange = useCallback(async (value: string, tabId: string | null) => {
    // 写入目标优先取编辑器实例在挂载时绑定的 tabId（与 <Editor> 的 key={activeTabId} 一一对应），
    // 彻底消除「单编辑器 + 多 Tab」架构下 onChange 在 Tab 切换瞬间把内容写错 Tab 的竞态。
    // 仅当 tabId 缺失时回退到 activeTabIdRef.current（理论上不会发生）。
    const tid = tabId ?? activeTabIdRef.current;
    // 诊断：若写入目标与当前激活 Tab 不一致，说明仍存在竞态，记录以便定位。
    if (tid && tid !== activeTabIdRef.current) {
      console.warn('[DF::EditorChange] ⚠ 写入目标与当前激活 Tab 不一致:', tid, 'vs active=', activeTabIdRef.current, 'len=', value.length);
    }
    if (tid) {
      const currentTab = tabs.find(t => t.id === tid);
      if (currentTab && isVirtualSourceTab(currentTab)) {
        // 虚拟源码为只读，仅更新内存内容，不落盘、不标记修改
        setEditorContent(prev => ({ ...prev, [tid]: value }));
        return;
      }
      if (currentTab && isCodeFile(currentTab.path) && !user?.isSuperAdmin && !isDeveloper(user?.roles || [])) {
        toast.warning(`当前角色无权编辑代码文件（.${currentTab.path.split('.').pop()}），仅数据开发工程师可操作`);
        return;
      }
      setEditorContent(prev => ({ ...prev, [tid]: value }));
      console.log('[DF::Trace][editWrite] tid=', tid, 'path=', currentTab?.path, 'fp=', fp(value));

      // 标记为已修改未保存（黄色圆点）
      setTabs(prev =>
        prev.map(tab =>
          tab.id === tid ? { ...tab, isModified: true, isSaving: false } : tab
        )
      );

      // 防抖保存：取消上一次定时器，800ms 后执行保存
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      const tabId = tid;
      const tabPath = currentTab?.path;
      saveTimerRef.current = setTimeout(async () => {
        // 防御：只读 / 虚拟源码（metals:/jdt:）绝不落盘（避免把依赖源码等内容误写到真实文件）
        if (tabPath && !isVirtualSourceTab(currentTab)) {
          // 标记为正在保存（黄色闪烁）
          setTabs(prev =>
            prev.map(tab =>
              tab.id === tabId ? { ...tab, isSaving: true } : tab
            )
          );
          await saveFile(tabPath, value);
          // 保存完成（绿色圆点）
          setTabs(prev =>
            prev.map(tab =>
              tab.id === tabId ? { ...tab, isModified: false, isSaving: false } : tab
            )
          );
        }
      }, 800);
    }
  }, [activeTabId, tabs, saveFile, user]);

  const handleSaveConfigParams = useCallback((filePath: string, data: {
    dependencies: { id: string; name: string; version: string; source?: string; jarPath?: string; groupId?: string; scope?: string; autoChoose?: number | null; basePath?: string }[];
    programParams: { id: string; key: string; value: string }[];
    taskParams: { id: string; key: string; value: string }[];
  }) => {
    setSavedConfigParams(prev => ({ ...prev, [filePath]: data }));
  }, []);

  // 从文档"数据指标"章节解析指标表格（支持 8 列数仓设计文档与 6 列业务需求文档，兼容旧版 4 列文档）
  const handleExtractMetrics = useCallback(async (_filePath: string, content: string) => {
    const indicators = extractMetricsFromMarkdown(content, project.projectCode);
    if (indicators.length === 0) {
      toast.warning('未在文档"数据指标"标题下找到可提取的指标定义（需含"指标名"或"业务定义"列的表格）');
      return;
    }
    // 打开模态框供用户检查，确认后再提交到后端
    setExtractedIndicators(indicators);
    setExtractMetricsVisible(true);
  }, [project, toast]);

  // 模态框确认后批量提交指标到后端
  // 提交前先展开 calcExpr 中引用的其他指标编码
  const handleSubmitExtractMetrics = useCallback(async (indicators: IndicatorDTO[]) => {
    toast.info(`正在提交 ${indicators.length} 个指标...`);
    try {
      // 拉取已有指标构建 code → calcExpr 查找表
      const existingLookup = new Map<string, string>();
      try {
        const res = await indicatorApi.filter({ projectCode: project.projectCode });
        for (const ind of res.data || []) {
          if (ind.code && ind.calcExpr) {
            existingLookup.set(ind.code, ind.calcExpr);
          }
        }
      } catch {
        // 拉取失败不影响提交，仅跳过展开
      }

      const expanded = expandCalcExprBatch(indicators, existingLookup);
      await indicatorApi.batchSave(expanded);
      toast.info(`成功提交 ${indicators.length} 个指标`);
      setExtractMetricsVisible(false);
    } catch (e) {
      toast.error(`提交失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [toast, project.projectCode]);

  const statusInfo: StatusBarInfo = {
    line: 1,
    column: 1,
    encoding: 'UTF-8',
    spaces: 4,
    eol: 'LF',
  };

  // Create modified chatBackend with snapshot-aware sendMessage
  // 拒绝文件变更：更新审批状态 + 通过 SDK revert API 回退文件
  const handleRejectFile = useCallback(async (filePath: string, change: { type: 'edit' | 'write' | 'apply_patch'; messageID?: string; partID?: string }) => {
    const client = chatBackend.client;
    const sessionId = chatBackend.currentSessionId;

    try {
      // 优先使用 SDK session.revert API 回退文件（支持 partID 级别精确回滚单个文件变更）
      if (client && sessionId && change.messageID) {
        // session.revert({ sessionID, messageID, partID }) 回滚指定 part，
        // 服务端会自动回退该 part 对应的文件变更
        await client.session.revert({
          sessionID: sessionId,
          messageID: change.messageID,
          partID: change.partID,
        });

        // 关闭已打开的标签页
        const tab = tabs.find(t => t.path === filePath);
        if (tab) {
          setTabs(prev => prev.filter(t => t.id !== tab.id));
          setEditorContent(prev => { const next = { ...prev }; delete next[tab.id]; return next; });
        }
        await refreshTree();
        toast.info(`已回退文件: ${getBaseName(filePath)}`);
      } else if (change.type === 'write') {
        // SDK 不可用时的降级方案：新建文件直接删除
        await deleteNode(filePath, 'file');
        const tab = tabs.find(t => t.path === filePath);
        if (tab) {
          setTabs(prev => prev.filter(t => t.id !== tab.id));
          setEditorContent(prev => { const next = { ...prev }; delete next[tab.id]; return next; });
        }
        await refreshTree();
        toast.info(`已删除新建文件: ${getBaseName(filePath)}`);
      } else {
        toast.warning(`无法自动回退文件，请手动处理: ${getBaseName(filePath)}`);
      }
    } catch (err) {
      console.warn('[DevAssistant] 拒绝文件变更失败:', err);
      toast.warning(`文件回退失败: ${getBaseName(filePath)}`);
    }
  }, [chatBackend, deleteNode, tabs, refreshTree, toast]);

  const modifiedchatBackend = useMemo(() => ({
    ...chatBackend,
    sendMessage: sendMessageWithSnapshot,
    rejectFileChange: handleRejectFile,
  }), [chatBackend, sendMessageWithSnapshot, handleRejectFile]);

  // 组件卸载时清理保存定时器
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  // 文件浏览器拖拽调整宽度
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    resizeStartXRef.current = e.clientX;
    // 记录起始宽度：如果已有设定宽度则用该值，否则测量当前元素宽度
    const explorerEl = document.querySelector('.dev-assistant-wrapper__body > .explorer-panel') as HTMLElement | null;
    resizeStartWidthRef.current = explorerWidth ?? (explorerEl?.offsetWidth ?? 280);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    // 拖拽期间禁用 explorer-panel 的 transition（all 0.3s ease 会让 width 变化
    // 滞后于鼠标移动，产生"拖不动/跟手差"的错觉）。见 ExplorerPanel.css
    document.body.classList.add('is-resizing-explorer');
  }, [explorerWidth]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      const delta = resizeStartXRef.current - e.clientX; // 向左拖增加宽度
      const newWidth = Math.max(150, Math.min(600, resizeStartWidthRef.current + delta));
      setExplorerWidth(newWidth);
    };
    const handleMouseUp = () => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.body.classList.remove('is-resizing-explorer');
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const explorerStyle = explorerWidth !== null
    ? { flex: '0 0 auto', width: `${explorerWidth}px` } as React.CSSProperties
    : undefined;

  return (
    <div className="dev-assistant-wrapper">
      <div className="dev-assistant-wrapper__header">
        <button className="dev-assistant-wrapper__back-btn" onClick={onBack} title="返回项目列表">
          <ArrowLeft size={10} />
        </button>
        <FolderKanban size={10} style={{ color: '#0078d4' }} />
        <span className="dev-assistant-wrapper__project-name">{project.projectName}</span>
        <span className="dev-assistant-wrapper__project-code">{project.projectCode}</span>
        <div className="dev-assistant-wrapper__header-actions">
          <button
            className="dev-assistant-wrapper__dep-btn"
            title="配置项目级依赖（编译与悬停提示共用）"
            onClick={() => setProjectDepModalVisible(true)}
          >
            <Package size={12} />
            <span>项目依赖</span>
            {projectDepConfig.dependencies.length > 0 && (
              <span className="dev-assistant-wrapper__dep-count">{projectDepConfig.dependencies.length}</span>
            )}
          </button>
          <GlobalSearch fileTree={fileTree} readFileContent={readFileContent} onFileOpen={handleFileSelect} />
        </div>
      </div>
      <div className="dev-assistant-wrapper__body">
        <AIPanel chatBackend={modifiedchatBackend} llmModels={config.llmModels} onRollback={handleRollback} onOpenFile={handleFileSelect} onViewDiff={handleViewDiff} moduleId="dev-assistant" projectId={String(project.id)} fileTree={fileTree} />
        <EditorArea
          ref={editorAreaRef}
          tabs={tabs}
          activeTabId={activeTabId}
          onTabSelect={handleTabSelect}
          onTabClose={handleTabClose}
          value={currentContent}
          onChange={handleEditorChange}
          statusInfo={statusInfo}
          onRunProgram={handleRunProgram}
          onCompileDryRun={handleCompileDryRun}
          onSubmitToScheduler={() => setSubmitModalVisible(true)}
          onExtractMetrics={handleExtractMetrics}
          onShowHistory={(fp) => setHistoryTarget({ filePath: fp })}
          onRevertFile={handleRevertFile}
          onCheckFileChanged={handleCheckFileChanged}
          executionHistory={executionHistory}
          currentResults={currentResults}
          onSaveConfigParams={handleSaveConfigParams}
          isRunning={isRunning}
          isCompiling={isCompiling}
          onCancelExecution={handleCancelExecution}
          runningLogs={runningLogs}
          rootPath={projectCwd}
          projectId={project.id}
          projectCode={project.projectCode}
          openlineageTransportUrl={config.openlineageTransportUrl}
          javaHome={config.javaHome}
          workspaceRoot={workspaceRoot ?? config.cwd}
          activeTabRange={activeTabId ? (tabRanges[activeTabId] ?? null) : null}
          onTabRangeConsumed={handleTabRangeConsumed}
          mavenHome={config.mavenHome}
          mavenGroupId={config.mavenGroupId}
          mavenArtifactId={config.mavenArtifactId}
          scalaVersion={config.scalaVersion}
          pomTemplate={config.pomTemplate}
          projectDependencies={projectDepConfig.dependencies}
        />
        <div
          className={`dev-assistant-wrapper__resizer${isExplorerCollapsed ? ' dev-assistant-wrapper__resizer--hidden' : ''}`}
          onMouseDown={handleResizeStart}
          title="拖拽调整文件浏览器宽度"
        />
        <ExplorerPanel
          fileTree={fileTree}
          rootPath={rootPath}
          isLoading={isLoading}
          selectedFile={selectedFile}
          expandedFolders={expandedFolders}
          onFileSelect={handleFileSelect}
          onFolderToggle={handleFolderToggle}
          onOpenFolder={handleOpenFolder}
          onCreateFile={createFile}
          onCreateFolder={createFolder}
          onDeleteNode={handleDeleteNode}
          onRenameNode={renameNode}
          onMoveNode={moveNode}
          onCopyNode={copyNode}
          onShowHistory={(fp) => setHistoryTarget({ filePath: fp })}
          onRevertFile={handleRevertFile}
          onCheckFileChanged={handleCheckFileChanged}
          // git 提交只负责版本管理，不验证 SQL 头部数据源是否可用；
          // 数据源可用性校验应放在「提交到调度系统」流程（SubmitToSchedulerModal），
          // 否则会因活动编辑器的 SQL 头部引用未接入的数据源而错误阻断 git commit。
          onBeforeCommit={() => ({ valid: true, message: null })}
          onAISummarize={async (files: string[], diffs: string) => {
            // 通过 opencode 临时会话生成业务维度的提交信息；服务不可用时回退本地统计摘要
            return generateCommitSummary({
              serverUrl: config.opencodeServerUrl,
              permissionMode: config.permissionMode,
              model: chatBackend.activeLLMModel,
              files,
              diffs,
            });
          }}
          style={explorerStyle}
          onCollapsedChange={setIsExplorerCollapsed}
        />
      </div>
      <SubmitToSchedulerModal
        visible={submitModalVisible}
        fileName={tabs.find(t => t.id === activeTabId)?.name || ''}
        codeContent={currentContent}
        mapping={currentMapping}
        savedConfig={activeTabId ? (savedConfigParams[tabs.find(t => t.id === activeTabId)?.path || ''] as SavedConfig | null) ?? null : null}
        filePath={tabs.find(t => t.id === activeTabId)?.path}
        rootPath={projectCwd}
        projectCode={project.projectCode}
        devProjectId={project.id}
        dsApi={dsApi.api}
        isRealApi={dsApi.isRealApi}
        compileConfig={{
          javaHome: config.javaHome,
          scalaHome: config.scalaHome,
          mavenHome: config.mavenHome,
          scalaVersion: config.scalaVersion,
          pomTemplate: config.pomTemplate,
          workspace: config.cwd,
          mavenGroupId: config.mavenGroupId,
          mavenArtifactId: config.mavenArtifactId,
        }}
        openlineageTransportUrl={config.openlineageTransportUrl}
        onClose={() => setSubmitModalVisible(false)}
        onSuccess={(_projectName, workflowName) => {
          console.log(`已提交到调度系统，工作流: ${workflowName}`);
        }}
      />
      <ExtractMetricsModal
        visible={extractMetricsVisible}
        indicators={extractedIndicators}
        onClose={() => setExtractMetricsVisible(false)}
        onSubmit={handleSubmitExtractMetrics}
      />
      <ProjectDependencyModal
        visible={projectDepModalVisible}
        onClose={() => setProjectDepModalVisible(false)}
        projectId={project.id}
        dependencies={projectDepConfig.dependencies}
        onSave={async (deps) => {
          const ok = await projectDepConfig.save(deps);
          if (!ok && projectDepConfig.error) {
            toast.error(projectDepConfig.error);
          }
        }}
      />
      {historyTarget && (
        <FileHistoryModal
          filePath={historyTarget.filePath}
          repoPath={projectCwd || ''}
          onClose={() => setHistoryTarget(null)}
          onRollback={handleRollbackFile}
        />
      )}
    </div>
  );
};

export default DevAssistantView;
