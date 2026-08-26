import { useCallback, useRef, useEffect, useState, useImperativeHandle, forwardRef, useMemo } from 'react';
import Editor, { useMonaco } from '@monaco-editor/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Code, Eye, Edit3, AlertTriangle, Lightbulb, ArrowRight } from 'lucide-react';
import TabBar from './TabBar';
import ConfigParamsModal from './ConfigParamsModal';
import ExecutionResultTabs from './ExecutionResultTabs';
import type { ResultItem, HistoryItem, TabKey } from './ExecutionResultTabs';
import { StatusBarInfo, Tab } from '../../types';
import type { CodeExecutionResult } from '../../api/codeExecution';
import { parseSQLResultData } from '../../api/codeExecution';
import { parseFileHeader } from '../../utils';
import { useDataSourceCache } from '../../contexts/DataSourceContext';
import { useAuth } from '../../contexts/AuthContext';
import { pathToUri } from '../../services/lsp';
import { clearPomCache } from '../../services/ensurePomReady';
import { useLspManagement } from '../../hooks/useLspManagement';
import { useSqlCompletion } from '../../hooks/useSqlCompletion';
import type { DependencyItemLite } from '../../utils/dependencyMerge';
import { getLanguageFromFilename, isMarkdownFile, supportsRename, resolveRenameKeyAction } from './editorUtils';
import { registerAllTextmateLanguages } from '../../services/textmate';
import './EditorArea.css';

interface ExecutionRecord {
  id: string;
  time: Date;
  filePath: string;
  engineType: string;
  codeType: string;
  result: CodeExecutionResult | null;
  sqlSnippet?: string;
}

export interface EditorAreaHandle {
  validateDataSource: () => { valid: boolean; message: string | null };
  blurEditor: () => void;
}

interface EditorAreaProps {
  tabs: Tab[];
  activeTabId: string | null;
  onTabSelect: (id: string) => void;
  onTabClose: (id: string) => void;
  value: string;
  // 第二参数始终为「当前激活 Tab 的 id」（与 <Editor> 的 key 一一对应），
  // 由 EditorArea 在渲染期闭包捕获后传入，避免 onChange 在 Tab 切换瞬间把内容写错 Tab。
  onChange: (value: string, tabId: string | null) => void;
  statusInfo: StatusBarInfo;
  language?: string;
  onConfigureDependencies?: () => void;
  onRunProgram?: (selectedCode?: string) => void;
  onCompileDryRun?: () => void;
  onConfigureRunParams?: () => void;
  onConfigureParams?: () => void;
  onSubmitToScheduler?: () => void;
  onExtractMetrics?: (filePath: string, content: string) => void;
  onSaveConfigParams?: (filePath: string, data: {
    dependencies: { id: string; name: string; version: string }[];
    programParams: { id: string; key: string; value: string }[];
    taskParams: { id: string; key: string; value: string }[];
  }) => void;
  executionHistory?: ExecutionRecord[];
  currentResults?: ExecutionRecord[];
  isRunning?: boolean;
  isCompiling?: boolean;
  onCancelExecution?: () => void;
  runningLogs?: string;
  rootPath?: string;
  projectId?: number;
  projectCode?: string;
  javaHome?: string;
  workspaceRoot?: string;
  // 跳转到定义的目标位置（1-based），用于在打开依赖源码后定位到对应行
  activeTabRange?: { line: number; column: number } | null;
  // 跳转定义定位完成后的回调：父组件据此清理该 Tab 的 range，
  // 否则切回该 Tab 仍会被强制定位到原目标行，无法恢复用户后续浏览位置
  onTabRangeConsumed?: (tabId: string) => void;
  mavenHome?: string;
  mavenGroupId?: string;
  mavenArtifactId?: string;
  scalaVersion?: string;
  /** 设置页 POM 模板，透传给 LSP 生成与设置一致的 pom.xml */
  pomTemplate?: string;
  /** 项目级依赖（默认依赖集合），与逐文件依赖合并后用于更新 LSP classpath（悬停提示） */
  projectDependencies?: DependencyItemLite[];
  /** 项目源码目录（透传给 LSP 生成 pom 的 <sourceDirectory> 与 bloop sourceDir） */
  sourceDir?: string;
  /** 覆盖 bloop 输出目录（透传给 LSP） */
  bloopConfigDirectory?: string;
  /** 是否在 bloop 导出时下载依赖源码（透传给 LSP） */
  bloopDownloadSources?: boolean;
}

const EditorArea = forwardRef<EditorAreaHandle, EditorAreaProps>(({
  tabs,
  activeTabId,
  onTabSelect,
  onTabClose,
  value,
  onChange,
  statusInfo,
  language,
  onRunProgram,
  onCompileDryRun,
  onConfigureParams,
  onSubmitToScheduler,
  onExtractMetrics,
  onSaveConfigParams,
  executionHistory = [],
  currentResults = [],
  isRunning,
  isCompiling,
  onCancelExecution,
  runningLogs,
  rootPath,
  projectId,
  projectCode,
  javaHome,
  workspaceRoot,
  activeTabRange,
  onTabRangeConsumed,
  mavenHome,
  mavenGroupId,
  mavenArtifactId,
  scalaVersion,
  pomTemplate,
  projectDependencies,
  sourceDir,
  bloopConfigDirectory,
  bloopDownloadSources,
}, ref) => {
  const editorRef = useRef<any>(null);
  const [cursorPosition, setCursorPosition] = useState({ line: statusInfo.line, column: statusInfo.column });
  const actionDisposablesRef = useRef<any[]>([]);
  // 每个 Tab 的 Monaco 视图状态字典（滚动位置 / 光标 / 选区 / 折叠等），
  // 切换 Tab 时 Editor 因 key 变化重新挂载，需在挂载后恢复、卸载前持续保存
  const viewStatesRef = useRef<Record<string, any>>({});
  // 在事件回调中获取最新的 activeTabId，避免闭包捕获陈旧值
  const activeTabIdRef = useRef<string | null>(activeTabId);
  activeTabIdRef.current = activeTabId;
  const [previewMode, setPreviewMode] = useState(false);
  const [configParamsVisible, setConfigParamsVisible] = useState(false);
  const [resultTab, setResultTab] = useState<TabKey>('results');
  const [dataSourceWarning, setDataSourceWarning] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  // 右键菜单弹出时，记录右键落在编辑器中的位置（1-based），供「跳转到定义」使用。
  // Monaco 自带右键菜单禁用后，右键不会移动光标，因此需要显式记录并定位。
  const [contextMenuPos, setContextMenuPos] = useState<{ lineNumber: number; column: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Monaco overflow widgets 容器：将 hover / suggest / parameter hints 等弹出层
  // 渲染到 body 级别的固定定位容器中，避免被父级 overflow:hidden 裁剪，
  // 使其可以显示在右侧文件浏览器面板上方，不再被遮挡。
  // 使用 useState 懒初始化确保容器在编辑器创建前已存在并挂载到 body。
  const [overflowWidgetsDomNode] = useState(() => {
    const el = document.createElement('div');
    el.className = 'monaco-overflow-widgets-container';
    document.body.appendChild(el);
    return el;
  });

  // 组件卸载时移除容器
  // StrictMode 下 useEffect 会经历 挂载→卸载→再挂载：cleanup 会把 div 从 body
  // 移除，再挂载时若不重新 append，div 会脱离 DOM 树，Monaco 的 hover/suggest
  // 等 overflow widget 会被渲染到这个游离节点中，导致悬停提示不可见。
  // setup 时确保 div 在 body 中（若已被 cleanup 移除则重新挂回）。
  useEffect(() => {
    if (overflowWidgetsDomNode.parentNode !== document.body) {
      document.body.appendChild(overflowWidgetsDomNode);
    }
    return () => {
      overflowWidgetsDomNode.remove();
    };
  }, [overflowWidgetsDomNode]);

  const monaco = useMonaco();

  // 提取的 hooks
  // 注意：monaco-languageclient（LanguageClientWrapper）会根据服务器能力自动注册所有
  // Monaco provider（hover/定义跳转/补全/诊断等），因此这里不再需要手动 registerProviders。
  const { lspStatus, scalaLspStatus, updateLspClasspath } = useLspManagement({
    javaHome,
    workspaceRoot,
    mavenHome,
    mavenGroupId,
    mavenArtifactId,
    scalaVersion,
    pomTemplate,
    projectDependencies,
    projectId,
    projectCode,
    rootPath,
    sourceDir,
    bloopConfigDirectory,
    bloopDownloadSources,
  });

  // ========== 全局 Pointer 事件：检测丢失的 pointerup 并补发 ==========
  // 这是原 EditorArea.tsx 的核心逻辑，避免编辑器鼠标选中状态卡死
  const editorPointerDownRef = useRef(false);
  const lastEditorPointerIdRef = useRef(-1);

  useEffect(() => {
    const handleGlobalPointerDown = (e: PointerEvent) => {
      const editorDom = editorRef.current?.getDomNode();
      if (editorDom && editorDom.contains(e.target as Node) && e.pointerType === 'mouse' && e.button === 0) {
        editorPointerDownRef.current = true;
        lastEditorPointerIdRef.current = e.pointerId;
      }
    };

    const handleGlobalPointerUp = () => {
      if (editorPointerDownRef.current) {
        editorPointerDownRef.current = false;
      }
    };

    const handleGlobalPointerMove = (e: PointerEvent) => {
      if (!editorPointerDownRef.current) return;
      if (e.pressure === 0 && e.pointerType === 'mouse') {
        editorPointerDownRef.current = false;
        try {
          const editorDom = editorRef.current?.getDomNode();
          const target = editorDom || document.body;
          target.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            cancelable: true,
            pointerId: lastEditorPointerIdRef.current,
            pointerType: 'mouse',
            button: 0,
            buttons: 0,
            clientX: e.clientX,
            clientY: e.clientY,
            screenX: e.screenX,
            screenY: e.screenY,
          }));
        } catch { /* 忽略 dispatchEvent 可能抛出的异常 */ }
      }
    };

    document.addEventListener('pointerdown', handleGlobalPointerDown, true);
    document.addEventListener('pointerup', handleGlobalPointerUp, true);
    document.addEventListener('pointermove', handleGlobalPointerMove, true);
    return () => {
      document.removeEventListener('pointerdown', handleGlobalPointerDown, true);
      document.removeEventListener('pointerup', handleGlobalPointerUp, true);
      document.removeEventListener('pointermove', handleGlobalPointerMove, true);
    };
  }, []);

  const blurEditor = useCallback(() => {
    if (editorRef.current) {
      const domNode = editorRef.current.getDomNode?.();
      if (domNode) {
        domNode.blur();
        const textarea = domNode.querySelector('textarea');
        if (textarea) {
          textarea.blur();
        }
      }
    }
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, []);

  // 模态框打开时主动让编辑器失焦，避免第一次点击被编辑器 blur 消费
  useEffect(() => {
    if (configParamsVisible) {
      blurEditor();
    }
  }, [configParamsVisible, blurEditor]);

  // ========== 数据源相关 ==========

  const { user } = useAuth();
  const { dataSources, getTablesByDataSourceId, updateTableColumns } = useDataSourceCache();
  const [tables, setTables] = useState<any[]>([]);

  // SQL 补全 hook（需在 dataSources/tables 声明之后）
  const { setupSQLCompletion, disposeCompletion } = useSqlCompletion({
    dataSources,
    tables,
    userId: user?.id ?? null,
    onColumnsLoaded: useCallback((databaseName: string, tableName: string, columns: any[]) => {
      // 字段按需加载后回写到上下文，找到匹配的数据源 ID
      const matchedDS = dataSources.find(ds => {
        const dsTables = getTablesByDataSourceId(ds.id);
        return dsTables.some(t => t.databaseName === databaseName && t.tableName === tableName);
      });
      if (matchedDS) {
        updateTableColumns(matchedDS.id, databaseName, tableName, columns);
      }
    }, [dataSources, getTablesByDataSourceId, updateTableColumns]),
  });

  useEffect(() => {
    (window as any).__editorTables = tables;
  }, [tables]);

  const parseDataSourceFromCode = useCallback((code: string): string | null => {
    const lines = code.split('\n');
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('--') || trimmedLine.startsWith('//')) {
        const commentContent = trimmedLine.replace(/^--\s*|\/\/\s*/, '');
        const dsMatch = commentContent.match(/datasource[:\s=]+(\S+)/i);
        if (dsMatch) return dsMatch[1];
      }
      if (trimmedLine.toLowerCase().startsWith('@use ')) {
        const dsName = trimmedLine.replace(/^@use /i, '').trim().replace(/;$/, '');
        if (dsName) return dsName;
      }
    }
    return null;
  }, []);

  const validateDataSource = useCallback((): { valid: boolean; message: string | null } => {
    if (dataSources.length === 0 || !value) return { valid: true, message: null };

    const currentLang = language || (tabs.find(t => t.id === activeTabId)?.name
      ? getLanguageFromFilename(tabs.find(t => t.id === activeTabId)?.name || '')
      : 'javascript');

    if (currentLang !== 'sql') return { valid: true, message: null };

    // 优先从文件头（-- 数据源: xxx）中解析，其次检查内联格式（-- datasource: xxx / @use xxx）
    const header = parseFileHeader(value);
    const dsNameInCode = header?.dataSource || parseDataSourceFromCode(value);
    if (!dsNameInCode) return { valid: true, message: null };

    const matchedDS = dataSources.find(ds =>
      ds.datasourceName.toLowerCase() === dsNameInCode.toLowerCase()
    );

    if (!matchedDS) {
      const msg = `数据源 "${dsNameInCode}" 不存在，可用数据源: ${dataSources.map(ds => ds.datasourceName).join(', ')}`;
      setDataSourceWarning(msg);
      return { valid: false, message: msg };
    }

    setDataSourceWarning(null);
    return { valid: true, message: null };
  }, [value, dataSources, parseDataSourceFromCode, language, tabs, activeTabId]);

  useImperativeHandle(ref, () => ({ validateDataSource, blurEditor }), [validateDataSource, blurEditor]);

  useEffect(() => {
    if (dataSources.length === 0 || !value) {
      setTables([]);
      return;
    }
    const dsNameInCode = parseDataSourceFromCode(value);
    if (dsNameInCode) {
      const matchedDS = dataSources.find(ds => ds.datasourceName.toLowerCase() === dsNameInCode.toLowerCase());
      if (matchedDS) {
        setTables(getTablesByDataSourceId(matchedDS.id));
      } else {
        setTables(getTablesByDataSourceId(dataSources[0]?.id));
      }
    } else if (dataSources.length > 0) {
      setTables(getTablesByDataSourceId(dataSources[0].id));
    } else {
      setTables([]);
    }
  }, [value, dataSources, parseDataSourceFromCode, getTablesByDataSourceId]);

  // ========== 当前语言 ==========

  const currentTab = tabs.find(t => t.id === activeTabId);
  // 第三方依赖源码（metals: / jdt:）没有可靠的文件后缀，按 scheme 强制语言，
  // 保证跳转打开的 JDK / 依赖库源码有正确的语法高亮。
  const currentLanguage = language
    || (currentTab?.path.startsWith('jdt:') ? 'java'
      : currentTab?.path.startsWith('metals:') ? 'scala'
        : currentTab?.name ? getLanguageFromFilename(currentTab.name) : 'javascript');

  // ========== Markdown / 指标提取判定 ==========

  const currentFileName = tabs.find(t => t.id === activeTabId)?.name || '';
  const isMarkdown = isMarkdownFile(currentFileName);
  // 所有 Markdown 文档均支持右键"提取指标"
  // （覆盖两种提示词文档：数仓设计文档"xxx数仓设计.md"与业务需求文档）
  const canExtractMetrics = isMarkdown;

  // ========== 编辑器 Ref 回调（供右键菜单等使用）==========

  const onRunProgramRef = useRef(onRunProgram);
  const onCompileDryRunRef = useRef(onCompileDryRun);
  const onSubmitToSchedulerRef = useRef(onSubmitToScheduler);
  const onExtractMetricsRef = useRef(onExtractMetrics);
  onRunProgramRef.current = onRunProgram;
  onCompileDryRunRef.current = onCompileDryRun;
  onSubmitToSchedulerRef.current = onSubmitToScheduler;
  onExtractMetricsRef.current = onExtractMetrics;

  const onConfigureParamsRef = useRef(() => {
    onConfigureParams?.();
    setConfigParamsVisible(true);
  });
  onConfigureParamsRef.current = () => {
    onConfigureParams?.();
    setConfigParamsVisible(true);
  };

  // 获取编辑器选中文本，无选中则返回 undefined
  const getSelectedCode = useCallback((): string | undefined => {
    const editor = editorRef.current;
    if (!editor) return undefined;
    const selection = editor.getSelection();
    if (!selection || selection.isEmpty()) return undefined;
    const model = editor.getModel();
    return model?.getValueInRange(selection) || undefined;
  }, []);

  // ========== 右键「跳转到定义」==========
  // Monaco 自带右键菜单已禁用（contextmenu: false），右键也不会移动光标，
  // 因此先把光标定位到右键落点（若落点在既有选区内则保留选区），再触发
  // VS Code 内置的 editor.action.revealDefinition（F12 同款逻辑）。
  // 同文件目标由编辑器原地 reveal；跨文件目标由 LSP 导航中间件交给
  // React 层的 definitionOpener 以新 Tab 打开（见 services/lsp/languageClient.ts）。
  //
  // 注意：revealDefinition 在 @codingame/monaco-vscode-editor-api 运行时中是通过
  // registerAction2 注册的全局命令（Action2），并不在编辑器实例的 _actions 表中，
  // editor.getAction('editor.action.revealDefinition') 会返回 undefined。
  // editor.trigger(...) 内部最终兜底到全局命令服务（ICommandService.executeCommand）
  // 执行该命令，因此用 trigger 而非 getAction。
  const handleGoToDefinition = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    try {
      if (contextMenuPos) {
        const pos = { lineNumber: contextMenuPos.lineNumber, column: contextMenuPos.column };
        const selection = editor.getSelection();
        // 右键落点不在当前选区内时才移动光标，避免误折叠已有选区
        const inSelection = !!selection && !selection.isEmpty() && selection.containsPosition?.(pos);
        if (!inSelection) {
          editor.setPosition(pos);
        }
      }
      editor.focus();
      editor.trigger('contextMenu', 'editor.action.revealDefinition', null);
    } catch (e) {
      console.warn('[EditorArea] 跳转到定义失败:', e);
    }
  }, [contextMenuPos]);

  // ========== 右键「重命名符号」==========
  // 与 VS Code 的 F2 / 右键「Rename Symbol」行为对齐：触发 editor.action.rename，
  // 由 RenameController（见 bootstrapVscode.ts 的 import）弹出内联重命名输入框，
  // 输入新名字后通过 LSP renameProvider 计算 WorkspaceEdit 并应用（单文件内生效）。
  // 先把光标定位到右键落点（若在既有选区内则保留选区），再触发命令。
  // 与 revealDefinition 相同，editor.action.rename 也是 registerAction2 注册的全局命令，
  // 需用 editor.trigger 兜底到全局命令服务执行。
  const handleRenameSymbol = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    try {
      if (contextMenuPos) {
        const pos = { lineNumber: contextMenuPos.lineNumber, column: contextMenuPos.column };
        const selection = editor.getSelection();
        const inSelection = !!selection && !selection.isEmpty() && selection.containsPosition?.(pos);
        if (!inSelection) {
          editor.setPosition(pos);
        }
      }
      editor.focus();
      editor.trigger('contextMenu', 'editor.action.rename', null);
    } catch (e) {
      console.warn('[EditorArea] 重命名符号失败:', e);
    }
  }, [contextMenuPos]);

  // ========== Monaco 编辑器事件 ==========

  const handleBeforeMount = useCallback(async (monacoInstance: any) => {
    console.log('[EditorArea] handleBeforeMount 触发，currentLanguage =', currentLanguage);
    setupSQLCompletion(monacoInstance);
    // LSP provider（hover/定义跳转/补全/诊断等）由 monaco-languageclient 自动注册，无需手动调用
    // 自定义主题的 colors 覆盖（inactiveSelectionBackground / wordHighlight / hoverHighlight）
    // 已改在 bootstrapVscode.ts 通过 workbench.colorCustomizations 注入（扩展运行时下
    // monaco.editor.defineTheme 不可用）；TextMate 的 token 着色由 VS Code 主题直接驱动。
    // 注册 TextMate grammar 替换内置 Monarch 语法高亮。已注册过的语言由内部幂等跳过。
    // 按 VS Code 方式处理：不阻塞编辑器挂载去等 TextMate 预热（不再 await
    // whenTextmateWarmedUp）。语法高亮在 app 启动阶段已由 main.tsx 后台注册+预热；
    // 即便冷启动瞬时打开文件，这里也 fire-and-forget 触发注册，grammar 就绪后 Monaco
    // 会按可见区把颜色补齐（先纯文本后着色），而不是先等全部就绪才创建编辑器——
    // 因此不会再出现「正在初始化语法高亮引擎…」的长 Loading。
    registerAllTextmateLanguages(monacoInstance).catch((e) => {
      console.warn('[EditorArea] TextMate 语言注册失败:', e);
    });
  }, [setupSQLCompletion, currentLanguage]);

  const handleEditorMount = useCallback((editor: any, _monaco: any) => {
    editorRef.current = editor;
    (window as any).__monacoInstance = _monaco;

    // 恢复当前 Tab 之前保存的视图状态（滚动位置 / 光标 / 选区 / 折叠等）。
    // 因 Editor 使用 key={activeTabId}，切换 Tab 会整体重新挂载，所有视图状态
    // 默认丢失；这里在挂载后立即 restore，配合下方持续 save 实现"切回原位置"。
    const tabId = activeTabIdRef.current;
    if (tabId && viewStatesRef.current[tabId]) {
      try {
        editor.restoreViewState(viewStatesRef.current[tabId]);
      } catch (e) {
        console.warn('[EditorArea] restoreViewState 失败:', e);
      }
    }

    // 持续保存视图状态：光标移动 / 滚动 / 选区变化时均刷新字典，
    // 确保切换 Tab 前字典中保存的是最新状态（key 卸载后已无法再 save）
    const saveCurrentViewState = () => {
      const id = activeTabIdRef.current;
      if (!id) return;
      try {
        viewStatesRef.current[id] = editor.saveViewState();
      } catch { /* editor 已销毁时忽略 */ }
    };

    // 监听光标位置变化
    editor.onDidChangeCursorPosition((e: any) => {
      saveCurrentViewState();
      setCursorPosition({ line: e.position.lineNumber, column: e.position.column });
    });
    editor.onDidScrollChange(() => saveCurrentViewState());
    editor.onDidChangeCursorSelection(() => saveCurrentViewState());

    // 自定义 action 仅保留给命令面板（F1），不放到右键菜单
    const supportedLangExpr = 'editorLangId == sql || editorLangId == scala || editorLangId == java || editorLangId == python';
    const compilableLangExpr = 'editorLangId == java || editorLangId == scala';

    actionDisposablesRef.current = [
      editor.addAction({
        id: 'run-program',
        label: '运行程序',
        precondition: supportedLangExpr,
        run: () => onRunProgramRef.current?.(getSelectedCode()),
      }),
      editor.addAction({
        id: 'compile-dry-run',
        label: '编译程序',
        precondition: compilableLangExpr,
        run: () => onCompileDryRunRef.current?.(),
      }),
      editor.addAction({
        id: 'submit-to-scheduler',
        label: '提交调度',
        precondition: supportedLangExpr,
        run: () => onSubmitToSchedulerRef.current?.(),
      }),
      editor.addAction({
        id: 'configure-params',
        label: '配置参数',
        precondition: supportedLangExpr,
        run: () => onConfigureParamsRef.current?.(),
      }),
    ];
  }, [getSelectedCode]);

  // 原生方式拦截右键菜单：仅在 Monaco 编辑器内（且当前语言为支持的类型）才显示自定义菜单
  const editorAreaRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // 检查是否在 Monaco 编辑器 DOM 内（避免在执行结果/执行历史等非编辑器区域弹出）
      const monacoDom = editorRef.current?.getDomNode();
      const inMonaco = !!(monacoDom && monacoDom.contains(target));
      const inMarkdownPreview = !!target.closest?.('.editor-area__markdown-preview');
      // 记录右键落在编辑器中的位置（供「跳转到定义」定位光标）。
      // Markdown 预览区没有编辑器坐标，此时置空。
      let menuPos: { lineNumber: number; column: number } | null = null;
      if (inMonaco) {
        try {
          const hit = editorRef.current?.getTargetAtClientPoint?.(e.clientX, e.clientY);
          if (hit?.position) {
            menuPos = { lineNumber: hit.position.lineNumber, column: hit.position.column };
          }
        } catch { /* 编辑器未就绪时忽略 */ }
      }
      // Markdown 文档：在 Monaco 编辑区或 Markdown 预览区右键均触发"提取指标"菜单
      if (canExtractMetrics && (inMonaco || inMarkdownPreview)) {
        e.preventDefault();
        e.stopPropagation();
        setContextMenuPos(menuPos);
        setContextMenu({ x: e.pageX, y: e.pageY });
        return;
      }
      if (!inMonaco) return;
      // 当前语言为支持的类型才显示自定义菜单
      const supportedLanguages = ['sql', 'java', 'scala', 'python'];
      if (supportedLanguages.includes(currentLanguage)) {
        e.preventDefault();
        e.stopPropagation();
        setContextMenuPos(menuPos);
        setContextMenu({ x: e.pageX, y: e.pageY });
      }
    };
    document.addEventListener('contextmenu', handler, true); // capture 阶段
    return () => document.removeEventListener('contextmenu', handler, true);
  }, [currentLanguage, canExtractMetrics]);

  // ========== 右键（按钮 2）落在“已有选区”内时保持选区不被破坏 ==========
  // 自绘右键菜单通过 document capture 阶段拦截 contextmenu 显式菜单，
  // 但 Monaco 自身的右键 mousedown 仍会把光标落下/折叠选区，从而在
  // selectionHighlight/wordHighlight 关闭前曾导致选区染色污染下一行开头。
  // 这里在 capture 阶段拦截右键 mousedown：若点击落在当前空选区之外、且在
  // 已有选区内部，则阻止 Monaco 的默认处理（停止光标移动/选区折叠），
  // 使用户框选的文本在弹出菜单时保持原样。
  useEffect(() => {
    const handleRightDown = (e: MouseEvent) => {
      if (e.button !== 2) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const monacoDom = editorRef.current?.getDomNode();
      if (!monacoDom || !monacoDom.contains(target)) return;
      const editor = editorRef.current;
      if (!editor) return;
      const selection = editor.getSelection();
      // 空选区（或不存在）时不干预，交给 Monaco 默认行为
      if (!selection || selection.isEmpty()) return;
      let pos: { lineNumber: number; column: number } | null = null;
      try {
        const hit = editor.getTargetAtClientPoint?.(e.clientX, e.clientY);
        pos = hit?.position ?? null;
      } catch { /* 忽略 */ }
      if (!pos) return;
      if (selection.containsPosition?.(pos)) {
        // 阻止 Monaco 右键落到选区内部时折叠/挪动选区，保持用户框选状态；
        // 菜单仍由上方 contextmenu 处理器打开。
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('mousedown', handleRightDown, true);
    return () => document.removeEventListener('mousedown', handleRightDown, true);
  }, []);

  // 清理右键菜单 actions
  useEffect(() => {
    return () => {
      actionDisposablesRef.current.forEach(d => d.dispose());
    };
  }, []);

  // 清理 SQL completion
  useEffect(() => {
    return () => { disposeCompletion(); };
  }, [disposeCompletion]);

  // 关闭自定义右键菜单
  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    document.addEventListener('click', closeMenu);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', closeMenu);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // ========== 重命名输入框键盘兜底（Enter 确认 / Escape 取消）==========
  // 背景：本应用为修复 hover/suggest 被父级 overflow:hidden 裁剪，把 overflowWidgetsDomNode
  // 放到了 body 级容器。这导致 allowEditorOverflow=true 的 rename widget 也被渲染到 body 级
  // 容器（view.js 里 overflowingContentWidgetsDomNode 被 append 到 overflowWidgetsDomNode），
  // 脱离了编辑器 DOM 树。Monaco keybinding 服务在分发 keydown 时，用 findContextAttr(target)
  // 沿 parentElement 向上查找编辑器 scoped context（KEYBINDING_CONTEXT_ATTR 属性），但 rename
  // input 的 parentElement 链不经过编辑器 DOM → 查找失败 → editorFocus/renameInputVisible
  // 上下文键对 keybinding 不可见 → Enter/Escape 的 keybinding（acceptRenameInput/cancelRenameInput）
  // 永远不触发，表现为「按回车重命名输入框不消失」。
  //
  // 这里在 capture 阶段兜底：当焦点落在 rename input 上时，手动 editor.trigger 触发对应命令。
  // editor.trigger 走 editor.invokeWithinContext（用编辑器 scoped context，不依赖 DOM 查找），
  // 能正确执行 acceptRenameInput / cancelRenameInput，与 VS Code 的 F2 重命名回车确认行为一致。
  useEffect(() => {
    const handleRenameKeydown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (!active || !(active instanceof HTMLElement)) return;
      if (!active.classList.contains('rename-input')) return;
      const editor = editorRef.current;
      if (!editor) return;

      const action = resolveRenameKeyAction(e.key, e.shiftKey);
      if (!action) return;

      e.preventDefault();
      e.stopPropagation();
      editor.trigger('keyboard', action === 'accept' ? 'acceptRenameInput' : 'cancelRenameInput', null);
    };
    document.addEventListener('keydown', handleRenameKeydown, true);
    return () => document.removeEventListener('keydown', handleRenameKeydown, true);
  }, []);

  // 清理已关闭 Tab 的视图状态，避免字典无限增长导致内存泄漏
  useEffect(() => {
    const validIds = new Set(tabs.map(t => t.id));
    const cachedIds = Object.keys(viewStatesRef.current);
    if (cachedIds.some(id => !validIds.has(id))) {
      const next: Record<string, any> = {};
      validIds.forEach(id => {
        if (viewStatesRef.current[id] !== undefined) {
          next[id] = viewStatesRef.current[id];
        }
      });
      viewStatesRef.current = next;
    }
  }, [tabs]);

  // ========== SQL 补全更新 ==========

  useEffect(() => {
    if (currentLanguage === 'sql' && monaco) {
      setupSQLCompletion(monaco);
    }
  }, [tables, currentLanguage, setupSQLCompletion, monaco]);

  // ========== Markdown 预览 ==========

  useEffect(() => {
    // 打开 Markdown 文件时默认进入预览模式；切换到非 Markdown 文件时退出预览
    if (isMarkdown) {
      setPreviewMode(true);
    } else if (previewMode) {
      setPreviewMode(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMarkdown]);

  // ========== Editor path & options ==========

  // 跳转到定义后，将编辑器定位到目标行（第三方依赖源码 / 跨文件目标）
  useEffect(() => {
    if (!activeTabRange) return;
    const t = setTimeout(() => {
      const ed = editorRef.current;
      if (ed) {
        ed.revealLineInCenter(activeTabRange.line);
        ed.setPosition({ lineNumber: activeTabRange.line, column: activeTabRange.column });
        // 定位完成后通知父组件清理该 Tab 的 range，避免后续切换又被强制
        // 跳回原目标行（否则用户后续浏览到其他位置切回后无法恢复）
        if (activeTabId && onTabRangeConsumed) {
          onTabRangeConsumed(activeTabId);
        }
      }
    }, 60);
    return () => clearTimeout(t);
  }, [activeTabRange, activeTabId, onTabRangeConsumed]);

  const editorPath = useMemo(() => {
    if (!activeTabId) return undefined;
    const currentTab = tabs.find(t => t.id === activeTabId);
    if (!currentTab?.path) return undefined;
    return pathToUri(currentTab.path);
  }, [activeTabId, tabs]);

  // 第三方依赖源码以只读方式打开，避免用户误编辑：
  // - metals:/jdt: scheme 的虚拟文档
  // - file://.../.metals/readonly/... 路径（Scala 依赖源码，opener 保留原始 file:// URI
  //   以便 Metals 识别并支持悬停/跳转）
  const isActiveVirtualSourceTab = useMemo(() => {
    if (!activeTabId) return false;
    const t = tabs.find(t => t.id === activeTabId);
    return !!t && (
      t.path.startsWith('metals:') ||
      t.path.startsWith('jdt:') ||
      t.path.includes('/.metals/readonly/')
    );
  }, [activeTabId, tabs]);

  const editorOptions = useMemo(() => ({
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    tabSize: 2,
    wordWrap: 'on' as const,
    lineNumbers: 'on' as const,
    // 隐藏 glyph margin（断点/错误标记列）：本应用不需要调试断点，
    // 默认启用会在行号旁多占一列宽度，使 gutter 过宽
    glyphMargin: false,
    // 缩小行号区最小字符宽度：默认 5 字符，多数文件行数<1000，
    // 3 字符足够，可减少约 2 字符宽度的 gutter 占用
    lineNumbersMinChars: 3,
    // 行高亮仅在内容区渲染，不贯穿整个 gutter 列
    renderLineHighlight: 'line' as const,
    selectOnLineNumbers: true,
    roundedSelection: false,
    cursorBlinking: 'smooth' as const,
    cursorSmoothCaretAnimation: 'on' as const,
    smoothScrolling: true,
    contextmenu: false, // 由原生 contextmenu 捕获处理，禁用 Monaco 自带菜单
    folding: true,
    foldingStrategy: 'auto' as const,
    // 折叠控件仅在悬停时显示，而非常驻显示，减少 gutter 占位
    showFoldingControls: 'mouseover' as const,
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true },
    padding: { top: 16, bottom: 16 },
    suggestOnTriggerCharacters: true,
    quickSuggestions: true,
    parameterHints: { enabled: true },
    formatOnPaste: true,
    formatOnType: true,
    autoClosingBrackets: 'always' as const,
    autoClosingQuotes: 'always' as const,
    autoSurround: 'languageDefined' as const,
    snippetSuggestions: 'inline' as const,
    wordBasedSuggestions: 'off' as const,
    occurrencesHighlight: 'off' as const,
    // 关闭“光标所在词”的全局出现高亮（selectionHighlight / wordHighlight）：否则自绘
    // 右键菜单抑制了 Monaco 原生菜单后，Monaco 的右键 mousedown 仍会把光标落到点击处的
    // 词上，进而在整篇代码里把所有该词的复现处都涂上背景——表现为：选区内第 11/12 行
    // 颜色不一致，且未选中的下一行（第 13 行）开头背景也跟着变。关闭后不会再有这种
    // 词出现处的高亮污染。
    selectionHighlight: false,
    wordHighlight: false,
    // 将 hover / suggest / parameter hints 等浮层渲染到 body 级容器，
    // 避免被父级 overflow:hidden 裁剪，使其可以显示在文件浏览器面板上方。
    overflowWidgetsDomNode,
    // 启用 fixedOverflowWidgets：使 Monaco 使用 position: fixed + 视口坐标定位浮层，
    // 确保浮层在 body 级容器中位置正确，并始终位于最顶层。
    fixedOverflowWidgets: true,
  }), [overflowWidgetsDomNode]);

  // ========== 渲染 ==========

  return (
    <main className="editor-area" ref={editorAreaRef}>
      {dataSourceWarning && currentLanguage === 'sql' && (
        <div className="editor-area__datasource-warning">
          <AlertTriangle size={14} />
          <span>{dataSourceWarning}</span>
          <button onClick={() => setDataSourceWarning(null)} title="关闭提示">×</button>
        </div>
      )}

      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onTabSelect={onTabSelect}
        onTabClose={onTabClose}
        rootPath={rootPath}
      />

      {isMarkdown && (
        <div className="editor-area__toolbar">
          <div className="editor-area__toolbar-group">
            <button
              className={`editor-area__toolbar-btn ${!previewMode ? 'editor-area__toolbar-btn--active' : ''}`}
              onClick={() => setPreviewMode(false)}
              title="编辑模式"
            >
              <Edit3 size={14} />
              <span>编辑</span>
            </button>
            <button
              className={`editor-area__toolbar-btn ${previewMode ? 'editor-area__toolbar-btn--active' : ''}`}
              onClick={() => setPreviewMode(true)}
              title="预览模式"
            >
              <Eye size={14} />
              <span>预览</span>
            </button>
          </div>
        </div>
      )}

      <div className="editor-area__content">
        {!activeTabId && (
          <div className="editor-area__welcome">
            <p className="editor-area__welcome-subtitle">开始您的编程之旅</p>
          </div>
        )}

        {activeTabId && isMarkdown && previewMode ? (
          <div className="editor-area__markdown-preview">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code({ node, className, children, ...props }) {
                  const match = /language-(\w+)/.exec(className || '');
                  const isInline = !match && !className;
                  if (isInline) {
                    return <code className="editor-area__md-inline-code" {...props}>{children}</code>;
                  }
                  return (
                    <div className="editor-area__code-block">
                      <div className="editor-area__code-block-header">
                        <Code size={12} />
                        <span>{match?.[1] || 'text'}</span>
                      </div>
                      <pre><code className={className}>{String(children).replace(/\n$/, '')}</code></pre>
                    </div>
                  );
                },
                table({ children }) {
                  return (
                    <div className="editor-area__table-wrapper">
                      <table>{children}</table>
                    </div>
                  );
                },
              }}
            >
              {value}
            </ReactMarkdown>
          </div>
        ) : (
          <Editor
            key={activeTabId ?? '__none__'}
            height="100%"
            language={currentLanguage}
            theme="Default Dark Modern"
            path={editorPath}
            value={activeTabId ? value : ''}
            onChange={(val) => onChange(val || '', activeTabId ?? null)}
            beforeMount={handleBeforeMount}
            onMount={handleEditorMount}
            loading={
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: '100%',
                  color: '#888',
                  fontSize: '13px',
                  backgroundColor: '#1f1f1f',
                }}
              >
                正在初始化语法高亮引擎…
              </div>
            }
            options={{ ...editorOptions, readOnly: isActiveVirtualSourceTab }}
          />
        )}
      </div>

      <ExecutionResultTabs
        isExecuting={isRunning ?? false}
        isCompiling={isCompiling ?? false}
        runningLogs={runningLogs || ''}
        activeTab={resultTab}
        onTabChange={(tab: TabKey) => setResultTab(tab)}
        resultItems={currentResults
          .filter(r => r.result != null)
          .map((r): ResultItem => {
            const result = r.result!;
            let columns: string[] = [];
            let rows: string[][] = [];
            if (result.columns && Array.isArray(result.columns) && result.rows && Array.isArray(result.rows)) {
              columns = result.columns;
              rows = result.rows.map(row => row.map(cell => String(cell ?? '')));
            } else if (result.resultData) {
              const parsed = parseSQLResultData(result.resultData);
              if (parsed) { columns = parsed.columns; rows = parsed.rows; }
            }
            return {
              id: r.id,
              columns,
              rows,
              rowCount: result.affectedRows ?? rows.length,
              sqlSnippet: r.sqlSnippet,
              outputLog: result.outputLog,
              errorMessage: result.errorMessage || undefined,
              success: result.success,
            };
          })
        }
        historyItems={executionHistory.map((r): HistoryItem => {
          const isRunning = r.result?.status === 'RUNNING';
          return {
            id: r.id,
            executionId: r.result?.executionId || null,
            timestamp: r.time,
            // status 为 RUNNING 时视为正在执行，duration 设为 0 以触发 UI 的加载动画
            duration: isRunning ? 0 : (r.result?.durationMs ?? (r.result ? -1 : 0)),
            // success 需结合 status 判断：提交成功但 status 仍为 RUNNING 时视为未完成
            success: isRunning ? false : (r.result?.success ?? false),
            errorMessage: r.result?.errorMessage || null,
            sqlSnippet: r.sqlSnippet || r.filePath.split(/[/\\]/).pop() || '',
            affectedRows: r.result?.affectedRows ?? null,
            rowCount: null,
          };
        })}
        onCancelExecution={onCancelExecution}
        statusBarInfo={{
          line: cursorPosition.line,
          column: cursorPosition.column,
          language: currentLanguage,
          encoding: statusInfo.encoding,
          spaces: statusInfo.spaces,
          eol: statusInfo.eol,
          lspStatus,
          scalaLspStatus,
          showJavaLsp: currentLanguage === 'java',
          showScalaLsp: currentLanguage === 'scala',
        }}
      />

      <ConfigParamsModal
        visible={configParamsVisible}
        onClose={() => setConfigParamsVisible(false)}
        fileContent={value}
        filePath={tabs.find(t => t.id === activeTabId)?.path}
        rootPath={rootPath}
        projectId={projectId}
        onSave={(data) => {
          const fp = tabs.find(t => t.id === activeTabId)?.path;
          if (fp) onSaveConfigParams?.(fp, data);
          // 推送完整类路径（引用依赖目录中所有 jar），保证第三方依赖里的类
          // （如 spark-sql 的 SaveMode，常由传递依赖带出、未必被显式选中）可被跳转。
          // 不再只挂「项目级 + 逐文件」合并的少数 jar，否则会漏掉传递依赖中的类。
          if (currentLanguage === 'java' || currentLanguage === 'scala') {
            updateLspClasspath();
            clearPomCache();
          }
        }}
      />

      {/* 自定义右键菜单：只显示自定义选项 */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="editor-area__context-menu"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 9999,
            backgroundColor: '#252526',
            border: '1px solid #454545',
            borderRadius: 6,
            padding: '4px 0',
            minWidth: 160,
            boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
            fontSize: 13,
            color: '#cccccc',
          }}
        >
          {canExtractMetrics ? (
            <div
              className="editor-area__context-item"
              onMouseDown={(e) => {
                e.preventDefault();
                const fp = tabs.find(t => t.id === activeTabId)?.path || '';
                onExtractMetricsRef.current?.(fp, value);
                setContextMenu(null);
              }}
              style={{ padding: '6px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#094771')}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            >
              <Lightbulb size={14} />
              <span>提取指标</span>
            </div>
          ) : (
          <>
          {/* 跳转到定义：仅 Java / Scala（有 LSP 定义跳转能力）显示，与 F12 行为一致 */}
          {(currentLanguage === 'java' || currentLanguage === 'scala') && (
            <div
              className="editor-area__context-item"
              onMouseDown={(e) => { e.preventDefault(); handleGoToDefinition(); setContextMenu(null); }}
              style={{ padding: '6px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#094771')}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            >
              <ArrowRight size={14} />
              <span>跳转到定义</span>
              <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: 11 }}>F12</span>
            </div>
          )}
          {/* 重命名符号：仅 Java / Scala 且可写（非只读依赖源码）显示，与 F2 行为一致 */}
          {supportsRename(currentLanguage, isActiveVirtualSourceTab) && (
            <div
              className="editor-area__context-item"
              onMouseDown={(e) => { e.preventDefault(); handleRenameSymbol(); setContextMenu(null); }}
              style={{ padding: '6px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#094771')}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            >
              <Edit3 size={14} />
              <span>重命名符号</span>
              <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: 11 }}>F2</span>
            </div>
          )}
          {/* 虚拟源码 Tab（metals:/jdt: 依赖源码）为只读，不提供运行/编译等操作项 */}
          {!isActiveVirtualSourceTab && (
          <>
          {/* SQL 文件且有选中文本时，显示"选中执行" */}
          {currentLanguage === 'sql' && getSelectedCode() && (
            <div
              className="editor-area__context-item"
              onMouseDown={(e) => { e.preventDefault(); onRunProgramRef.current?.(getSelectedCode()); setContextMenu(null); }}
              style={{ padding: '6px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#094771')}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
            >
              选中执行
            </div>
          )}
          <div
            className="editor-area__context-item"
            onMouseDown={(e) => { e.preventDefault(); onRunProgramRef.current?.(getSelectedCode()); setContextMenu(null); }}
            style={{ padding: '6px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#094771')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            运行程序
          </div>
          {/* 编译程序仅对 Java/Scala 文件显示 */}
          {currentLanguage !== 'sql' && (
          <div
            className="editor-area__context-item"
            onMouseDown={(e) => { e.preventDefault(); onCompileDryRunRef.current?.(); setContextMenu(null); }}
            style={{ padding: '6px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#094771')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            编译程序
          </div>
          )}
          <div
            className="editor-area__context-item"
            onMouseDown={(e) => { e.preventDefault(); onSubmitToSchedulerRef.current?.(); setContextMenu(null); }}
            style={{ padding: '6px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#094771')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            提交调度
          </div>
          <div
            className="editor-area__context-item"
            onMouseDown={(e) => { e.preventDefault(); onConfigureParamsRef.current?.(); setContextMenu(null); }}
            style={{ padding: '6px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#094771')}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            配置参数
          </div>
          </>
          )}
          </>
          )}
        </div>
      )}
    </main>
  );
});

export default EditorArea;
