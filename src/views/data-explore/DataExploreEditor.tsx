import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import Editor, { useMonaco } from '@monaco-editor/react';
import { Play, ChevronDown, Square } from 'lucide-react';
import ExecutionResultTabs from '../../components/editor/ExecutionResultTabs';
import type { ResultItem, HistoryItem, TabKey } from '../../components/editor/ExecutionResultTabs';
import TabBar from '../../components/editor/TabBar';
import { useDataSourceCache } from '../../contexts/DataSourceContext';
import { getEngineTypeByDatasourceType, parseSQLResultData } from '../../api/codeExecution';
import type { CodeExecutionResult } from '../../api/codeExecution';
import { useSqlCompletion } from '../../hooks/useSqlCompletion';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../components/Toast';
import { initFileSystemAPI } from '../../hooks/useFileSystem';
import { buildScopedStorageKey } from '../../utils/historyIsolation';
import { ensureHistoryStore, readHistory, writeHistory } from '../../utils/historyStore';
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
  /** 会话目录列表（会话=标签页），每项为 individual/{timestamp}/user_{user}.sql */
  sessionDirs?: Array<{ dir: string; filePath: string }>;
  /** 会话目录版本号（新建/删除会话时递增，驱动标签页同步） */
  sessionDirsVersion?: number;
  /** 当前激活工作目录（对应激活标签） */
  currentDirectory?: string | null;
  /** 切换工作目录（切换标签） */
  onSwitchSessionDir?: (dir: string) => void;
  /** 关闭指定会话目录的文件标签（仅关闭标签，不删会话/目录） */
  onCloseFile?: (dir: string) => void;
  /** 会话目录 → 会话标题 映射（标签页显示与任务下拉的会话名称一致） */
  sessionTitles?: Record<string, string>;
} 

// ─── 工具函数 ────────────────────────────────────────────────

/** 已保存到 individual 时间戳目录的默认 SQL（与 backend 新建会话目录写入内容一致） */
const DEFAULT_SQL = '-- 输入 SQL 查询语句\nSELECT * FROM users LIMIT 10;';

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

// ─── 执行历史持久化（统一走 utils/historyStore，落盘到主进程磁盘） ──

const HISTORY_STORAGE_KEY = 'dataforge_dataexplore_history';

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

/** 把磁盘中的原始记录还原成领域对象（ISO 字符串 → Date） */
function reviveHistoryItem(raw: unknown): ExecutionHistoryItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as SerializedHistoryItem;
  if (typeof item.id !== 'string') return null;
  return { ...item, timestamp: new Date(item.timestamp) };
}

// ─── 组件 ────────────────────────────────────────────────────

const DataExploreEditor: React.FC<DataExploreEditorProps> = ({
  selectedDataSourceId,
  onDataSourceChange,
  lastFileChangeSeq,
  lastFileChangePaths,
  sessionDirs,
  sessionDirsVersion,
  currentDirectory,
  onSwitchSessionDir,
  onCloseFile,
  sessionTitles,
}) => {
  const { user } = useAuth();
  const toast = useToast();

  const canExecuteNonSelectSql = useMemo(() => {
    if (!user) return false;
    if (user.isSuperAdmin) return true;
    const allowedRoleTypes = ['OPS_ENGINEER', 'DATA_DEV_ENGINEER'];
    return user.roles.some(r => allowedRoleTypes.includes(r.roleType));
  }, [user]);
  // 每个会话目录的编辑器内容（dir → SQL）
  const [sqlContents, setSqlContents] = useState<Record<string, string>>({});
  // 每个会话目录最近已保存内容（dir → SQL），用于自动保存 diff
  const lastSavedRef = useRef<Record<string, string>>({});
  // 每个会话目录对应的 SQL 文件路径（dir → filePath）
  const sqlFilePathsRef = useRef<Record<string, string>>({});
  // 本地激活目录（标签即时高亮；与 backend currentDirectory 同步）
  const [localActiveDir, setLocalActiveDir] = useState<string | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [activeResultTab, setActiveResultTab] = useState<TabKey>('results');
  const [queryResults, setQueryResults] = useState<QueryResult[]>([]);
  const [executionHistory, setExecutionHistory] = useState<ExecutionHistoryItem[]>([]);
  const [runningLogs, setRunningLogs] = useState('');
  const [_currentStatementIndex, setCurrentStatementIndex] = useState(-1);
  const editorRef = useRef<any>(null);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const handleExecuteRef = useRef<() => void>(() => {});

  // 任务执行服务
  const serviceRef = useRef<TaskExecutionService | null>(null);
  // 已完成执行的历史累积（服务每次 submitTaskSet 会替换当前任务集，旧记录需要在此保留）
  const accumulatedHistoryRef = useRef<ExecutionHistoryItem[]>([]);
  // 记录上次合并的任务集 ID，避免 stop() 触发两次 notify 导致重复追加
  const lastMergedTaskSetIdRef = useRef<string | null>(null);
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // 执行历史按「后端host + 用户」隔离存储（数据探索为平台级模块，无项目维度）
  const historyStorageKey = useMemo(
    () => buildScopedStorageKey(HISTORY_STORAGE_KEY, user?.username || ''),
    [user?.username],
  );
  const historyStorageKeyRef = useRef(historyStorageKey);
  historyStorageKeyRef.current = historyStorageKey;

  // 首次加载 / 切换 host+用户时：从统一历史库恢复对应作用域的历史
  useEffect(() => {
    let cancelled = false;
    void ensureHistoryStore().then(() => {
      if (cancelled) return;
      const stored = readHistory(historyStorageKeyRef.current, reviveHistoryItem);
      // 按 id 去重：旧版本 generateId 用 Date.now()+Math.random()，同一毫秒内浮点精度
      // 丢失可能产生重复 id，导致 React 列表 key 重复告警（保留最新记录）
      const seen = new Set<string>();
      const deduped = stored.filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
      accumulatedHistoryRef.current = deduped;
      setExecutionHistory(deduped);
    });
    return () => { cancelled = true; };
  }, [historyStorageKey]);

  const { dataSources, getTablesByDataSourceId, updateTableColumns } = useDataSourceCache();

  const [tables, setTables] = useState<any[]>([]);
  const monaco = useMonaco();

  // ── 多标签：激活标签 = backend.currentDirectory，本地切换即时高亮 ──
  const activeDir = useMemo(() => {
    const dirs = sessionDirs || [];
    // 本地显式切换优先（标签即时高亮，不等后端异步重建连接）
    if (localActiveDir && dirs.some(d => d.dir === localActiveDir)) return localActiveDir;
    // 否则跟随后端 currentDirectory
    if (currentDirectory && dirs.some(d => d.dir === currentDirectory)) return currentDirectory;
    // 回退到首个会话目录（新建/删除后 currentDirectory 短暂指向已不存在目录时兜底）
    return dirs[0]?.dir || null;
  }, [currentDirectory, sessionDirs, localActiveDir]);

  // TabBar 标签模型（标签名 = 会话名称，与会话重命名保持一致；无映射时回退时间戳目录名）
  const tabs = useMemo(() => (sessionDirs || []).map(d => {
    const name = sessionTitles?.[d.dir] || d.dir.split(/[\\/]/).pop() || d.filePath;
    const content = sqlContents[d.dir];
    const isModified = content !== undefined && content !== lastSavedRef.current[d.dir];
    return { id: d.dir, name, path: d.filePath, isModified };
  }), [sessionDirs, sqlContents, sessionTitles]);

  // 加载指定会话目录内容（尚未加载时），并注册文件路径
  const loadSqlContent = useCallback(async (dir: string, filePath: string) => {
    try {
      const api = await initFileSystemAPI();
      const encoder = new TextEncoder();
      let text = '';
      if (await api.exists(filePath)) {
        const buf = await api.readFile(filePath);
        text = new TextDecoder().decode(buf);
      }
      const content = text || DEFAULT_SQL;
      if (!text) {
        await api.writeFile(filePath, encoder.encode(content));
      }
      setSqlContents(prev => (prev[dir] === content ? prev : { ...prev, [dir]: content }));
      lastSavedRef.current[dir] = content;
    } catch (error) {
      console.error('[DataExploreEditor] 加载会话文件失败:', error);
      setSqlContents(prev => (prev[dir] === DEFAULT_SQL ? prev : { ...prev, [dir]: DEFAULT_SQL }));
      lastSavedRef.current[dir] = DEFAULT_SQL;
    }
  }, []);

  // 激活目录变化：注册文件路径并加载内容（幂等，已在内存则跳过）
  useEffect(() => {
    if (!activeDir) return;
    const dirs = sessionDirs || [];
    const item = dirs.find(d => d.dir === activeDir);
    if (!item) return;
    sqlFilePathsRef.current[activeDir] = item.filePath;
    if (sqlContents[activeDir] === undefined) {
      loadSqlContent(activeDir, item.filePath);
    }
  }, [activeDir, sessionDirs, sqlContents, loadSqlContent]);

  // 会话目录列表变化：清理已删除会话的缓存内容；新建会话后重置本地激活跟随后端
  useEffect(() => {
    const dirs = new Set((sessionDirs || []).map(d => d.dir));
    setSqlContents(prev => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const k of Object.keys(prev)) {
        if (dirs.has(k)) { next[k] = prev[k]; } else { changed = true; }
      }
      return changed ? next : prev;
    });
    for (const ref of [lastSavedRef.current, sqlFilePathsRef.current]) {
      for (const k of Object.keys(ref)) {
        if (!dirs.has(k)) delete ref[k];
      }
    }
    setLocalActiveDir(null);
  }, [sessionDirs]);

  // 每秒自动保存当前激活会话的内容
  useEffect(() => {
    if (!activeDir) return;
    const filePath = sqlFilePathsRef.current[activeDir];
    if (!filePath) return;
    const timer = setInterval(async () => {
      const content = sqlContents[activeDir];
      if (content === undefined) return;
      if (content === lastSavedRef.current[activeDir]) return;
      try {
        const api = await initFileSystemAPI();
        await api.writeFile(filePath, new TextEncoder().encode(content));
        lastSavedRef.current[activeDir] = content;
      } catch (error) {
        console.error('[DataExploreEditor] 自动保存失败:', error);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [activeDir, sqlContents]);

  // 监听 AI 智能体文件变更，刷新当前激活编辑器内容
  useEffect(() => {
    if (!activeDir) return;
    const filePath = sqlFilePathsRef.current[activeDir];
    if (!lastFileChangeSeq || !lastFileChangePaths?.length || !filePath) return;
    const normalized = filePath.replace(/\\/g, '/');
    const isAffected = lastFileChangePaths.some(p => p.replace(/\\/g, '/') === normalized);
    if (!isAffected) return;
    const before = sqlContents[activeDir];
    // 同步 lastSaved，防止自动保存定时器在异步读取期间将旧内容写回覆盖 AI 修改（竞态修复）
    lastSavedRef.current[activeDir] = before;
    (async () => {
      try {
        const api = await initFileSystemAPI();
        const buf = await api.readFile(filePath);
        const text = new TextDecoder().decode(buf);
        if (text && text !== before) {
          setSqlContents(prev => ({ ...prev, [activeDir]: text }));
          lastSavedRef.current[activeDir] = text;
        }
      } catch (error) {
        console.error('[DataExploreEditor] 刷新文件内容失败:', error);
      }
    })();
  }, [lastFileChangeSeq, lastFileChangePaths, activeDir, sqlContents]);

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
          writeHistory(historyStorageKeyRef.current, accumulatedHistoryRef.current);
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
    return ((activeDir && sqlContents[activeDir]) || '').trim();
  }, [sqlContents, activeDir]);

  /** 关闭标签页 = 仅关闭该会话目录的文件标签（不删会话/目录，与任务下拉勾选取消等价） */
  const handleTabClose = useCallback((id: string) => {
    onCloseFile?.(id);
  }, [onCloseFile]);

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
      if (!editorArea || !editorArea.contains(target)) return;

      const sel = editorRef.current?.getSelection();
      const hasSelection = sel && !sel.isEmpty();
      // 仅当有选中文本时才弹自定义菜单（选中执行）；否则不拦截默认右键菜单
      if (!hasSelection) return;

      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.pageX, y: e.pageY });
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

      <TabBar
        tabs={tabs}
        activeTabId={activeDir}
        onTabSelect={(id) => {
          setLocalActiveDir(id);
          onSwitchSessionDir?.(id);
          // 【临时定位】切换文件名后 300ms 内逐帧采样编辑器区域的白色元素并输出到 console，
          // 用于定位"点击文件名闪白"。定位完成后请删除本段代码。
          const diagStart = performance.now();
          const diagTimer = window.setInterval(() => {
            if (performance.now() - diagStart > 300) { window.clearInterval(diagTimer); return; }
            const area = editorAreaRef.current;
            if (!area) return;
            const rect = area.getBoundingClientRect();
            for (let x = rect.left + 4; x < rect.right - 4; x += 20) {
              for (let y = rect.top + 4; y < rect.bottom - 4; y += 20) {
                const el = document.elementFromPoint(x, y);
                if (!el) continue;
                const cs = getComputedStyle(el);
                const m = cs?.backgroundColor?.match(/\d+/g);
                if (!m || m.length < 3) continue;
                const r = +m[0], g = +m[1], b = +m[2];
                if (r > 235 && g > 235 && b > 235) {
                  const cls = typeof el.className === 'string' ? el.className.trim().replace(/\s+/g, '.') : '';
                  const path = (() => { const a: string[] = []; let n: any = el; while (n && n !== document.body) { a.unshift(n.tagName + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\s+/).join('.') : '')); n = n.parentElement; } return a.join(' -> '); })();
                  console.log('[白色闪元素] bg=', cs.backgroundColor, 'tag.class=', el.tagName + (cls ? '.' + cls : ''), 'path=', path);
                  window.clearInterval(diagTimer);
                  return;
                }
              }
            }
          }, 16);
        }}
        onTabClose={handleTabClose}
        rootPath=""
      />

      <div className="de-editor__editor-area" ref={editorAreaRef}>
        <Editor
          height="100%"
          language="sql"
          theme="Default Dark Modern"
          value={activeDir ? (sqlContents[activeDir] ?? DEFAULT_SQL) : DEFAULT_SQL}
          onChange={(val) => {
            if (activeDir) {
              setSqlContents(prev => ({ ...prev, [activeDir]: val || '' }));
            }
          }}
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
