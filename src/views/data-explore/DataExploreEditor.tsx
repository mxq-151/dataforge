import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import Editor, { useMonaco } from '@monaco-editor/react';
import { Play, ChevronDown, Square } from 'lucide-react';
import ExecutionResultTabs from '../../components/editor/ExecutionResultTabs';
import type { ResultItem, HistoryItem, TabKey } from '../../components/editor/ExecutionResultTabs';
import { useDataSourceCache } from '../../contexts/DataSourceContext';
import { getEngineTypeByDatasourceType, parseSQLResultData } from '../../api/codeExecution';
import type { CodeExecutionResult } from '../../api/codeExecution';
import { useSqlCompletion } from '../../hooks/useSqlCompletion';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../components/Toast';
import { initFileSystemAPI, getPlatformDefaultWorkspace } from '../../hooks/useFileSystem';
import { joinPath } from '../../utils/pathUtils';
import { TaskExecutionService, parseSqlStatements } from '../../services/taskExecutionService';
import type { TaskDefinition, TaskItem } from '../../services/taskExecutionService';
import { registerAllTextmateLanguages } from '../../services/textmate';
import './DataExploreEditor.css';

interface QueryResult {
  columns: string[];
  rows: string[][];
  duration: number;
  rowCount: number;
  outputLog?: string;
  sqlSnippet?: string;
}

interface ExecutionHistoryItem {
  id: string;
  executionId: string | null;
  timestamp: Date;
  duration: number;
  success: boolean;
  errorMessage: string | null;
  sqlSnippet: string;
  affectedRows: number | null;
  rowCount: number | null;
}

interface DataExploreEditorProps {
  selectedDataSourceId: number | null;
  onDataSourceChange: (id: number | null) => void;
  lastFileChangeSeq?: number;
  lastFileChangePaths?: string[];
  /** 基础工作目录（$HOME/.dataforge/{后端host}/{登录用户名}/），用于定位数据探索个人工作区 */
  baseWorkspace?: string;
}

// ─── 工具函数 ────────────────────────────────────────────────

const SESSION_KEYWORDS = /^(USE|SET|SHOW|DESC|DESCRIBE|EXPLAIN|HELP)$/i;

/** 从任务结果中解析查询结果（会话级语句返回 null） */
function deriveQueryResult(task: TaskItem): QueryResult | null {
  const result = task.result;
  if (!result || !result.success) return null;

  const firstKeyword = task.definition.code.trim().split(/\s+/)[0]?.toUpperCase() || '';
  if (SESSION_KEYWORDS.test(firstKeyword)) return null;

  const duration = result.durationMs ?? 0;
  const sqlSnippet = task.definition.sqlSnippet || task.definition.code;

  if (result.columns && Array.isArray(result.columns) && result.rows && Array.isArray(result.rows)) {
    return {
      columns: result.columns,
      rows: result.rows.map(row => row.map(cell => String(cell ?? ''))),
      duration,
      rowCount: result.affectedRows ?? result.rows.length,
      outputLog: result.outputLog || undefined,
      sqlSnippet,
    };
  }

  if (result.resultData) {
    const parsedData = parseSQLResultData(result.resultData);
    if (parsedData) {
      return {
        columns: parsedData.columns,
        rows: parsedData.rows,
        duration,
        rowCount: parsedData.rowCount,
        sqlSnippet,
      };
    }
  }

  return null;
}

/** 计算结果行数 */
function computeRowCount(result: CodeExecutionResult): number | null {
  if (result.columns && result.rows) {
    return result.affectedRows ?? result.rows.length;
  }
  if (result.resultData) {
    const parsed = parseSQLResultData(result.resultData);
    return parsed?.rowCount ?? null;
  }
  return result.affectedRows ?? null;
}

/** 将服务端 TaskItem 映射为 UI 层 ExecutionHistoryItem */
function mapTaskToHistoryItem(task: TaskItem): ExecutionHistoryItem {
  const isRunning = task.status === 'RUNNING' || task.status === 'PENDING';
  const snippet = task.definition.sqlSnippet || task.definition.code;
  return {
    id: task.id,
    executionId: task.executionId,
    timestamp: new Date(),
    duration: isRunning ? 0 : (task.result?.durationMs ?? -1),
    success: task.status === 'SUCCESS',
    errorMessage: task.result?.errorMessage ?? null,
    sqlSnippet: snippet.length > 100 ? snippet.slice(0, 100) + '...' : snippet,
    affectedRows: task.result?.affectedRows ?? null,
    rowCount: task.result ? computeRowCount(task.result) : null,
  };
}

// ─── localStorage 持久化 ──────────────────────────────────────

const HISTORY_STORAGE_KEY = 'dataforge_dataexplore_history';
const MAX_HISTORY_ITEMS = 2000;

interface SerializedHistoryItem {
  id: string;
  executionId: string | null;
  timestamp: string; // ISO
  duration: number;
  success: boolean;
  errorMessage: string | null;
  sqlSnippet: string;
  affectedRows: number | null;
  rowCount: number | null;
}

function deserializeHistory(json: string): ExecutionHistoryItem[] {
  try {
    const raw: SerializedHistoryItem[] = JSON.parse(json);
    if (!Array.isArray(raw)) return [];
    return raw.map(r => ({ ...r, timestamp: new Date(r.timestamp) }));
  } catch {
    return [];
  }
}

function serializeHistory(records: ExecutionHistoryItem[]): string {
  return JSON.stringify(records.slice(0, MAX_HISTORY_ITEMS));
}

function loadHistoryFromStorage(): ExecutionHistoryItem[] {
  try {
    const json = localStorage.getItem(HISTORY_STORAGE_KEY);
    return json ? deserializeHistory(json) : [];
  } catch {
    return [];
  }
}

function saveHistoryToStorage(records: ExecutionHistoryItem[]): void {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, serializeHistory(records));
  } catch {
    // localStorage 不可用时静默忽略
  }
}

// ─── 组件 ────────────────────────────────────────────────────

const DataExploreEditor: React.FC<DataExploreEditorProps> = ({ selectedDataSourceId, onDataSourceChange, lastFileChangeSeq, lastFileChangePaths, baseWorkspace }) => {
  const { user } = useAuth();
  const toast = useToast();

  const canExecuteNonSelectSql = useMemo(() => {
    if (!user) return false;
    if (user.isSuperAdmin) return true;
    const allowedRoleTypes = ['OPS_ENGINEER', 'DATA_DEV_ENGINEER'];
    return user.roles.some(r => allowedRoleTypes.includes(r.roleType));
  }, [user]);
  const [sqlValue, setSqlValue] = useState('-- 输入 SQL 查询语句\nSELECT * FROM users LIMIT 10;');
  const [isExecuting, setIsExecuting] = useState(false);
  const [activeResultTab, setActiveResultTab] = useState<TabKey>('results');
  const [queryResults, setQueryResults] = useState<QueryResult[]>([]);
  const [executionHistory, setExecutionHistory] = useState<ExecutionHistoryItem[]>([]);
  const [runningLogs, setRunningLogs] = useState('');
  const [_currentStatementIndex, setCurrentStatementIndex] = useState(-1);
  const editorRef = useRef<any>(null);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const sqlFilePathRef = useRef<string | null>(null);
  const lastSavedSqlRef = useRef<string>('');
  const handleExecuteRef = useRef<() => void>(() => {});

  // 任务执行服务
  const serviceRef = useRef<TaskExecutionService | null>(null);
  // 已完成执行的历史累积（服务每次 submitTaskSet 会替换当前任务集，旧记录需要在此保留）
  const accumulatedHistoryRef = useRef<ExecutionHistoryItem[]>([]);
  // 记录上次合并的任务集 ID，避免 stop() 触发两次 notify 导致重复追加
  const lastMergedTaskSetIdRef = useRef<string | null>(null);
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // 首次加载：从 localStorage 恢复历史
  useEffect(() => {
    const stored = loadHistoryFromStorage();
    if (stored.length > 0) {
      accumulatedHistoryRef.current = stored;
      setExecutionHistory(stored);
    }
  }, []);

  const { dataSources, getTablesByDataSourceId, updateTableColumns } = useDataSourceCache();

  const [tables, setTables] = useState<any[]>([]);
  const monaco = useMonaco();

  // 初始化用户 SQL 文件路径并加载内容
  useEffect(() => {
    if (!user?.username) return;

    const initUserFile = async () => {
      try {
        // 跟随新基础工作目录：$HOME/.dataforge/{后端host}/{登录用户名}/individual
        let dirPath: string;
        if (baseWorkspace) {
          dirPath = joinPath(baseWorkspace, 'individual');
        } else {
          const workspacePath = await getPlatformDefaultWorkspace();
          const separator = workspacePath.includes('\\') ? '\\' : '/';
          dirPath = `${workspacePath}${separator}individual${separator}${user.username}`;
        }
        const separator = dirPath.includes('\\') ? '\\' : '/';
        const filePath = `${dirPath}${separator}user_${user.username}.sql`;

        sqlFilePathRef.current = filePath;

        const api = await initFileSystemAPI();

        try {
          await api.createDir(dirPath);
        } catch {
          // 目录可能已存在
        }

        const fileExists = await api.exists(filePath);
        if (fileExists) {
          const content = await api.readFile(filePath);
          const text = new TextDecoder().decode(content);
          if (text) {
            setSqlValue(text);
            lastSavedSqlRef.current = text;
          }
        } else {
          const defaultContent = '-- 输入 SQL 查询语句\nSELECT * FROM users LIMIT 10;';
          const encoder = new TextEncoder();
          await api.writeFile(filePath, encoder.encode(defaultContent));
          lastSavedSqlRef.current = defaultContent;
        }
      } catch (error) {
        console.error('[DataExploreEditor] 初始化用户文件失败:', error);
      }
    };

    initUserFile();
  }, [user?.username, baseWorkspace]);

  // 每秒自动保存编辑器内容到文件
  useEffect(() => {
    const timer = setInterval(async () => {
      const filePath = sqlFilePathRef.current;
      if (!filePath) return;

      const currentSql = sqlValue;
      if (currentSql === lastSavedSqlRef.current) return;

      try {
        const api = await initFileSystemAPI();
        const encoder = new TextEncoder();
        await api.writeFile(filePath, encoder.encode(currentSql));
        lastSavedSqlRef.current = currentSql;
      } catch (error) {
        console.error('[DataExploreEditor] 自动保存失败:', error);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [sqlValue]);

  // 监听 AI 智能体文件变更，刷新 SQL 编辑器内容
  useEffect(() => {
    console.log('[DF::DataExploreEditor] fileChange effect triggered: lastFileChangeSeq=', lastFileChangeSeq, 'lastFileChangePaths=', lastFileChangePaths, 'sqlFilePath=', sqlFilePathRef.current);

    if (!lastFileChangeSeq || !lastFileChangePaths?.length || !sqlFilePathRef.current) {
      console.log('[DF::DataExploreEditor] fileChange effect skipped: seq=', lastFileChangeSeq, 'paths=', lastFileChangePaths?.length, 'sqlFile=', sqlFilePathRef.current);
      return;
    }

    const currentFilePath = sqlFilePathRef.current;
    const normalizedCurrent = currentFilePath.replace(/\\/g, '/');
    const isAffected = lastFileChangePaths.some(p => {
      const normalizedP = p.replace(/\\/g, '/');
      console.log('[DF::DataExploreEditor] comparing: file=', normalizedP, 'vs current=', normalizedCurrent, 'match=', normalizedP === normalizedCurrent);
      return normalizedP === normalizedCurrent;
    });
    console.log('[DF::DataExploreEditor] isAffected=', isAffected);

    if (!isAffected) return;

    // 立即同步更新 lastSavedSqlRef，防止自动保存定时器在异步读取文件期间
    // 将编辑器旧内容写回文件，覆盖 AI 的修改（竞态条件修复）
    const editorContentBeforeReload = sqlValue;
    lastSavedSqlRef.current = editorContentBeforeReload;

    const reloadFile = async () => {
      try {
        const api = await initFileSystemAPI();
        const content = await api.readFile(currentFilePath);
        const text = new TextDecoder().decode(content);
        console.log('[DF::DataExploreEditor] reloaded file content length=', text.length, 'current editor length=', editorContentBeforeReload.length, 'same=', text === editorContentBeforeReload);
        if (text && text !== editorContentBeforeReload) {
          setSqlValue(text);
          lastSavedSqlRef.current = text;
          console.log('[DataExploreEditor] AI 修改文件后刷新编辑器内容');
        }
      } catch (error) {
        console.error('[DataExploreEditor] 刷新文件内容失败:', error);
      }
    };

    reloadFile();
  }, [lastFileChangeSeq, lastFileChangePaths]);

  // SQL 补全（统一使用 useSqlCompletion hook）
  const { setupSQLCompletion, disposeCompletion } = useSqlCompletion({
    dataSources,
    tables,
    userId: user?.id ?? null,
    onColumnsLoaded: useCallback((databaseName: string, tableName: string, columns: any[]) => {
      if (selectedDataSourceId) {
        updateTableColumns(selectedDataSourceId, databaseName, tableName, columns);
      }
    }, [selectedDataSourceId, updateTableColumns]),
  });

  useEffect(() => {
    if (dataSources.length > 0 && !selectedDataSourceId) {
      onDataSourceChange(dataSources[0].id);
    }
  }, [dataSources, selectedDataSourceId, onDataSourceChange]);

  useEffect(() => {
    if (!selectedDataSourceId) {
      setTables([]);
      return;
    }

    const fetchedTables = getTablesByDataSourceId(selectedDataSourceId);
    setTables(fetchedTables);
  }, [selectedDataSourceId, dataSources, getTablesByDataSourceId]);

  useEffect(() => {
    if (monaco) {
      setupSQLCompletion(monaco);
    }
  }, [tables, setupSQLCompletion, monaco]);

  useEffect(() => {
    return () => { disposeCompletion(); };
  }, [disposeCompletion]);

  const handleBeforeMount = useCallback((monacoInstance: any) => {
    setupSQLCompletion(monacoInstance);
    // 自定义主题的 colors 覆盖（inactiveSelectionBackground / wordHighlight /
    // hoverHighlight）已统一在 bootstrapVscode.ts 通过 workbench.colorCustomizations
    // 注入；扩展运行时下 monaco.editor.defineTheme 不可用，故此处不再调用。
    // 与 EditorArea 一致（VS Code 方式）：fire-and-forget 触发 TextMate grammar 注册，
    // 不阻塞编辑器挂载去等预热。语法高亮由 main.tsx 启动阶段后台注册+预热，这里仅作
    // 兜底；grammar 就绪后 Monaco 对可见区增量补色。
    registerAllTextmateLanguages(monacoInstance).catch((e) => {
      console.warn('[DataExploreEditor] TextMate 语言注册失败:', e);
    });
  }, [setupSQLCompletion, tables]);

  // ─── 任务执行服务初始化 ──────────────────────────────────────

  useEffect(() => {
    const service = new TaskExecutionService();
    serviceRef.current = service;

    const unsubscribe = service.subscribe((taskSet) => {
      setIsExecuting(service.isActive());
      setRunningLogs(taskSet.logs);
      setCurrentStatementIndex(taskSet.currentTaskIndex);

      // 执行中只展示已开始的任务（PENDING 任务等开始执行后再展示，避免一次显示 N 条"执行中"）
      const visibleTasks = service.isActive()
        ? taskSet.tasks.filter(t => t.status !== 'PENDING')
        : taskSet.tasks;
      // 将当前任务集映射为历史条目
      const currentItems = visibleTasks.map(mapTaskToHistoryItem);

      if (service.isActive()) {
        // 执行中：显示当前任务 + 已累积历史
        setExecutionHistory([...currentItems, ...accumulatedHistoryRef.current]);

        // 从已成功的任务中派生查询结果
        const results: QueryResult[] = [];
        for (const task of taskSet.tasks) {
          if (task.status === 'SUCCESS' && task.result) {
            const qr = deriveQueryResult(task);
            if (qr) results.push(qr);
          }
        }
        setQueryResults(results);
      } else if (taskSet.status !== 'IDLE') {
        // 执行结束：将当前任务合并到累积历史（同个 taskSetId 只合并一次，避免 stop
        // 触发了 stopInternal + executeAllTasks 结束两次 notify 导致重复）
        if (currentItems.length > 0 && lastMergedTaskSetIdRef.current !== taskSet.id) {
          lastMergedTaskSetIdRef.current = taskSet.id;
          accumulatedHistoryRef.current = [...currentItems, ...accumulatedHistoryRef.current];
          saveHistoryToStorage(accumulatedHistoryRef.current);
        }
        setExecutionHistory([...accumulatedHistoryRef.current]);

        // 根据结果切换标签页
        if (taskSet.tasks.length === 1) {
          setActiveResultTab(taskSet.tasks[0].status === 'SUCCESS' ? 'results' : 'history');
        } else {
          setActiveResultTab('results');
        }

        // 多语句执行出错时弹出提示（与原 handleExecuteLineByLine 行为一致）
        if (taskSet.tasks.length > 1 && (taskSet.status === 'FAILED' || taskSet.status === 'PARTIAL')) {
          const failedTask = taskSet.tasks.find(t => t.status === 'FAILED');
          if (failedTask) {
            toastRef.current.warning(`语句执行失败，已停止后续执行 (${failedTask.result?.errorMessage || '未知错误'})`);
          }
        }
      }
    });

    return () => { unsubscribe(); service.destroy(); serviceRef.current = null; };
  }, []);

  // ─── SQL 校验 ───────────────────────────────────────────────

  const validateSingleStatement = useCallback((sql: string): { valid: boolean; error?: string } => {
    const cleanedSql = sql
      .replace(/--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();

    if (!cleanedSql) {
      return { valid: false, error: 'SQL 语句为空' };
    }

    const statements = cleanedSql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    if (statements.length === 0) {
      return { valid: false, error: '未检测到有效的 SQL 语句' };
    }

    if (statements.length > 1) {
      const statementTypes = statements.map(s => {
        const firstWord = s.split(/\s+/)[0]?.toUpperCase() || '';
        return firstWord;
      });

      const selectCount = statementTypes.filter(t => t === 'SELECT').length;

      if (selectCount > 1) {
        return {
          valid: false,
          error: `检测到 ${selectCount} 个 SELECT 语句，数据探索模式每次只允许执行单个 SELECT 查询。请拆分为多条单独的 SQL 语句后分别执行。`,
        };
      }

      const nonSelectTypes = statementTypes.filter(t => t !== 'SELECT');
      if (!canExecuteNonSelectSql && nonSelectTypes.length > 0) {
        return {
          valid: false,
          error: `检测到多个 SQL 语句（包含 ${nonSelectTypes.join(', ')} 等非 SELECT 语句），当前角色仅支持执行单个 SELECT 查询。如需执行其他操作，请联系管理员分配数据开发工程师或运维工程师角色。`,
        };
      }
    }

    const firstKeyword = statements[0].split(/\s+/)[0]?.toUpperCase() || '';
    if (!canExecuteNonSelectSql && firstKeyword !== 'SELECT') {
      return {
        valid: false,
        error: `当前角色仅支持执行 SELECT 查询语句，当前语句类型为 ${firstKeyword}。如需执行 ${firstKeyword} 操作，请联系管理员分配数据开发工程师或运维工程师角色。`,
      };
    }

    return { valid: true };
  }, [canExecuteNonSelectSql]);

  // ─── 执行 / 停止 ────────────────────────────────────────────

  /** 获取编辑器中选区文本或全部文本 */
  const getEditorSql = useCallback((): string => {
    if (editorRef.current) {
      const selection = editorRef.current.getSelection();
      const model = editorRef.current.getModel();
      if (selection && !selection.isEmpty()) {
        return model?.getValueInRange(selection) || '';
      }
      return model?.getValue()?.trim() || '';
    }
    return sqlValue.trim();
  }, [sqlValue]);

  /** 统一执行入口：单条/多条语句均通过 TaskExecutionService 提交 */
  const handleExecute = useCallback(async () => {
    const service = serviceRef.current;
    if (!service || service.isActive()) return;

    const sqlToExecute = getEditorSql();
    if (!sqlToExecute) return;

    // 拆分语句
    const statements = parseSqlStatements(sqlToExecute);
    if (statements.length === 0) {
      toast.warning('未检测到有效的 SQL 语句');
      return;
    }

    // 单条语句时进行权限校验
    if (statements.length === 1) {
      const validation = validateSingleStatement(sqlToExecute);
      if (!validation.valid) {
        toast.warning(validation.error || 'SQL 语句校验失败');
        return;
      }
    }

    // 校验数据源
    const selectedDataSource = dataSources.find(ds => ds.id === selectedDataSourceId);
    if (!selectedDataSource) {
      toast.warning('未选择数据源或数据源不存在，请先选择一个数据源');
      return;
    }

    const engineType = getEngineTypeByDatasourceType(selectedDataSource.datasourceType);
    const remark = `数据探索 - ${selectedDataSource.datasourceName}`;

    // 构建任务定义列表
    const tasks: TaskDefinition[] = statements.map(stmt => ({
      code: stmt,
      codeType: 'sql',
      engineType,
      datasources: [selectedDataSource.datasourceName],
      sqlSnippet: stmt.length > 100 ? stmt.slice(0, 100) + '...' : stmt,
      remark,
    }));

    // 清空旧查询结果，提交任务集
    setQueryResults([]);
    service.submitTaskSet(tasks, (logs) => setRunningLogs(logs));
  }, [getEditorSql, selectedDataSourceId, dataSources, validateSingleStatement, toast]);

  /** 停止执行 */
  const handleCancelExecution = useCallback(() => {
    serviceRef.current?.stop();
    setIsExecuting(false);
  }, []);

  // 保持 ref 始终指向最新的 handleExecute，避免 Ctrl+Enter 快捷键闭包过期
  useEffect(() => {
    handleExecuteRef.current = handleExecute;
  }, [handleExecute]);

  const handleEditorMount = useCallback((editor: any) => {
    editorRef.current = editor;

    // 监听光标位置变化
    editor.onDidChangeCursorPosition((e: any) => {
      setCursorPosition({ line: e.position.lineNumber, column: e.position.column });
    });

    if (monaco) {
      try {
        editor.addCommand(
          monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
          () => {
            handleExecuteRef.current();
          }
        );
      } catch {}
    }
  }, [monaco]);

  const pointerIsDownInEditorRef = useRef(false);
  const lastPointerIdRef = useRef(-1);

  useEffect(() => {
    const handleGlobalPointerDown = (e: PointerEvent) => {
      const editorDom = editorRef.current?.getDomNode();
      if (editorDom && editorDom.contains(e.target as Node) && e.pointerType === 'mouse' && e.button === 0) {
        pointerIsDownInEditorRef.current = true;
        lastPointerIdRef.current = e.pointerId;
      }
    };

    const handleGlobalPointerUp = () => {
      if (pointerIsDownInEditorRef.current) {
        pointerIsDownInEditorRef.current = false;
      }
    };

    const handleGlobalPointerMove = (e: PointerEvent) => {
      if (!pointerIsDownInEditorRef.current) return;
      if (e.pressure === 0 && e.pointerType === 'mouse') {
        pointerIsDownInEditorRef.current = false;
        try {
          const editorDom = editorRef.current?.getDomNode();
          const target = editorDom || document.body;
          target.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            cancelable: true,
            pointerId: lastPointerIdRef.current,
            pointerType: 'mouse',
            button: 0,
            buttons: 0,
            clientX: e.clientX,
            clientY: e.clientY,
            screenX: e.screenX,
            screenY: e.screenY,
          }));
        } catch {}
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

  // ─── 右键菜单 ─────────────────────────────────────────────────

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const editorAreaRef = useRef<HTMLDivElement>(null);

  // 在 capture 阶段拦截 contextmenu，阻止全局 security.ts 的 preventDefault 生效
  // 使用 editorAreaRef 容器判断而非 editorRef.getDomNode()，避免 Monaco 内部 DOM 重建
  // 导致 contains() 检查失效，右键菜单弹不出来的问题
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const editorArea = editorAreaRef.current;
      if (editorArea && editorArea.contains(target)) {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.pageX, y: e.pageY });
      }
    };
    document.addEventListener('contextmenu', handler, true); // capture 阶段
    return () => document.removeEventListener('contextmenu', handler, true);
  }, []);

  // 关闭右键菜单
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

  const handleClearResults = useCallback(() => {
    setQueryResults([]);
  }, []);

  const handleClearHistory = useCallback(() => {
    accumulatedHistoryRef.current = [];
    setExecutionHistory([]);
  }, []);

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
    contextmenu: false, // 由 capture 阶段拦截 contextmenu 事件弹出自定义菜单
    folding: true,
    foldingStrategy: 'auto' as const,
    // 折叠控件仅在悬停时显示，而非常驻显示，减少 gutter 占位
    showFoldingControls: 'mouseover' as const,
    bracketPairColorization: { enabled: true },
    guides: {
      bracketPairs: true,
      indentation: true,
    },
    padding: { top: 12, bottom: 12 },
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
    // 与 EditorArea 一致：关闭“光标所在词”的全篇复现高亮（selectionHighlight /
    // wordHighlight），否则多行选区内光标落到某个词时会把该词所有复现处染色，
    // 造成选区不同行颜色不一、相邻未选中行开头被染色。
    selectionHighlight: false,
    wordHighlight: false,
  }), []);

  return (
    <main className="de-editor">
      <div className="de-editor__toolbar">
        <div className="de-editor__toolbar-left">
          <div className="de-editor__datasource-selector">
            <select
              className="de-editor__datasource-select"
              value={selectedDataSourceId || ''}
              onChange={(e) => onDataSourceChange(Number(e.target.value))}
              disabled={dataSources.length === 0}
            >
              {dataSources.length === 0 && (
                <option value="">加载中...</option>
              )}
              {dataSources.map((ds) => (
                <option key={ds.id} value={ds.id}>
                  {ds.datasourceName}
                </option>
              ))}
            </select>
            <ChevronDown size={14} className="de-editor__datasource-select-icon" />
          </div>
        </div>
        <div className="de-editor__toolbar-right">
          {isExecuting ? (
            <button
              className="de-editor__stop-btn"
              onMouseDown={(e) => {
                e.preventDefault();
                handleCancelExecution();
              }}
              title="停止执行"
            >
              <Square size={14} />
              <span>停止</span>
            </button>
          ) : (
            <button
              className="de-editor__run-btn"
              onMouseDown={(e) => {
                e.preventDefault();
                handleExecute();
              }}
              title="执行查询 (Ctrl+Enter)"
            >
              <Play size={14} />
              <span>执行</span>
            </button>
          )}
        </div>
      </div>

      <div className="de-editor__editor-area" ref={editorAreaRef}>
        <Editor
          height="100%"
          language="sql"
          theme="Default Dark Modern"
          value={sqlValue}
          onChange={(val) => setSqlValue(val || '')}
          beforeMount={handleBeforeMount}
          onMount={handleEditorMount}
          options={editorOptions}
        />
      </div>

      <ExecutionResultTabs
        isExecuting={isExecuting}
        runningLogs={runningLogs}
        activeTab={activeResultTab}
        onTabChange={(tab: TabKey) => setActiveResultTab(tab)}
        resultItems={queryResults.map((r, idx): ResultItem => ({
          id: `result_${idx}`,
          columns: r.columns,
          rows: r.rows,
          rowCount: r.rowCount,
          sqlSnippet: r.sqlSnippet,
          outputLog: r.outputLog,
          success: true,
        }))}
        onClearResults={handleClearResults}
        historyItems={executionHistory.map((item): HistoryItem => ({
          id: item.id,
          executionId: item.executionId,
          timestamp: item.timestamp,
          duration: item.duration,
          success: item.success,
          errorMessage: item.errorMessage,
          sqlSnippet: item.sqlSnippet,
          affectedRows: item.affectedRows,
          rowCount: item.rowCount,
        }))}
        onClearHistory={handleClearHistory}
        onCancelExecution={handleCancelExecution}
        statusBarInfo={{
          line: cursorPosition.line,
          column: cursorPosition.column,
          language: 'SQL',
          encoding: 'UTF-8',
          spaces: 2,
          eol: 'LF',
          showJavaLsp: false,
          showScalaLsp: false,
        }}
      />

      {/* 自定义右键菜单 */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="de-editor__context-menu"
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
          {(() => {
            const selection = editorRef.current?.getSelection();
            const hasSelection = selection && !selection.isEmpty();
            return (
              <>
                {hasSelection && (
                  <div
                    className="de-editor__context-item"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      // 有选区时 handleExecute 自动执行选中文本
                      handleExecuteRef.current();
                      setContextMenu(null);
                    }}
                    style={{ padding: '6px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#094771')}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <Play size={14} />
                    <span>选中执行</span>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}
    </main>
  );
};

export default DataExploreEditor;
