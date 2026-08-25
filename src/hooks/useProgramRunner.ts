import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { generateId, parseFileHeader, validateFileHeader } from '../utils';
import { validateYarnJobName } from '../utils/schedulerMapping';
import type { CodeExecutionResult } from '../api/codeExecution';
import { unifiedCompile } from '../services/unifiedCompile';
import { TaskExecutionService } from '../services/taskExecutionService';
import type { TaskDefinition, TaskSet } from '../services/taskExecutionService';
import type { Tab } from '../types';
import type { EditorAreaHandle } from '../components/editor/EditorArea';
import type { ProjectInfo } from '../api/devProject';
import type { OpenCodeConfig } from '../types/opencode-backend';
import type { DependencyItemLite } from '../utils/dependencyMerge';
import { buildScopedStorageKey } from '../utils/historyIsolation';

interface SavedConfigLike {
  dependencies: { id: string; name: string; version: string; source?: string }[];
  programParams: { id: string; key: string; value: string }[];
  taskParams: { id: string; key: string; value: string }[];
}

interface ExecutionRecord {
  id: string;
  time: Date;
  filePath: string;
  engineType: string;
  codeType: string;
  result: CodeExecutionResult | null;
  sqlSnippet?: string;
}

interface UseProgramRunnerParams {
  project: ProjectInfo;
  /** 当前登录用户名，用于执行历史按「后端host + 用户 + 项目编码」隔离 */
  username: string;
  config: OpenCodeConfig;
  projectCwd?: string;
  readFile: (path: string) => Promise<Uint8Array>;
  tabs: Tab[];
  activeTabId: string | null;
  currentContent: string;
  savedConfigParams: Record<string, SavedConfigLike>;
  editorAreaRef: React.RefObject<EditorAreaHandle>;
  /** 项目级依赖（默认依赖集合），与逐文件依赖合并后用于编译 */
  projectDependencies?: DependencyItemLite[];
}

interface UseProgramRunnerReturn {
  handleRunProgram: (selectedCode?: string) => Promise<void>;
  handleCompileDryRun: () => Promise<void>;
  handleCancelExecution: () => Promise<void>;
  isRunning: boolean;
  isCompiling: boolean;
  executionHistory: ExecutionRecord[];
  currentResults: ExecutionRecord[];
  runningLogs: string;
}

const EXT_TO_CODE_TYPE: Record<string, string> = { sql: 'sql', java: 'java', scala: 'scala', py: 'python' };

function resolveDataSource(code: string, header: { dataSource?: string } | null): string | null {
  if (header?.dataSource) return header.dataSource;
  for (const line of code.split('\n')) {
    const trimmed = line.trim();
    if (/^(-{2}|\/\/)/.test(trimmed)) {
      const commentBody = trimmed.replace(/^(-{2}|\/\/)\s*/, '');
      const dsMatch = commentBody.match(/(?:@?数据源|datasource)[:\s=]+(\S+)/i);
      if (dsMatch) return dsMatch[1];
    }

  }
  return null;
}

function makeExecutionFailResult(execId: string, message: string): CodeExecutionResult {
  return {
    success: false,
    executionId: execId,
    status: 'FAILED',
    outputLog: '',
    errorMessage: message,
    affectedRows: null,
    resultData: null,
    startTime: null,
    endTime: null,
    durationMs: null,
  };
}

/** 将 SQL 文本按分号拆分为独立语句，处理注释和字符串内的分号 */
function parseSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const nextCh = sql[i + 1];

    if (inBlockComment) {
      if (ch === '*' && nextCh === '/') {
        i++;
        inBlockComment = false;
      }
      continue;
    }

    if (inSingleQuote) {
      current += ch;
      if (ch === "'" && nextCh === "'") {
        current += nextCh;
        i++;
      } else if (ch === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      current += ch;
      if (ch === '"') { inDoubleQuote = false; }
      continue;
    }

    if (ch === '-' && nextCh === '-') {
      const lineEnd = sql.indexOf('\n', i);
      if (lineEnd === -1) break;
      i = lineEnd;
      continue;
    }

    if (ch === '/' && nextCh === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === "'") { inSingleQuote = true; current += ch; continue; }
    if (ch === '"') { inDoubleQuote = true; current += ch; continue; }

    if (ch === ';') {
      current += ch;
      const trimmed = current.trim();
      if (trimmed.length > 0 && !/^(--|\/\*)/.test(trimmed)) {
        statements.push(trimmed);
      }
      current = '';
      continue;
    }

    current += ch;
  }

  const remaining = current.trim();
  if (remaining.length > 0 && !/^(--|\/\*)/.test(remaining)) {
    statements.push(remaining);
  }

  return statements;
}

/** 将 TaskSet 中的任务映射为 ExecutionRecord[]（仅当前非 hidden 的任务） */
function taskSetToExecutionRecords(taskSet: TaskSet, filePath: string): ExecutionRecord[] {
  return taskSet.tasks
    .filter(t => !t.definition.hidden)
    .map(t => ({
      id: t.id,
      time: new Date(),
      filePath,
      engineType: t.definition.engineType,
      codeType: t.definition.codeType,
      result: t.result,
      sqlSnippet: t.definition.sqlSnippet,
    }));
}

// ─── localStorage 持久化 ──────────────────────────────────────

const HISTORY_STORAGE_KEY = 'dataforge_execution_history';
const MAX_HISTORY_ITEMS = 2000;

interface SerializedRecord {
  id: string;
  time: string; // ISO
  filePath: string;
  engineType: string;
  codeType: string;
  result: CodeExecutionResult | null;
  sqlSnippet?: string;
}

function deserializeHistory(json: string): ExecutionRecord[] {
  try {
    const raw: SerializedRecord[] = JSON.parse(json);
    if (!Array.isArray(raw)) return [];
    return raw.map(r => ({ ...r, time: new Date(r.time) }));
  } catch {
    return [];
  }
}

function serializeHistory(records: ExecutionRecord[]): string {
  const trimmed = records.slice(0, MAX_HISTORY_ITEMS);
  return JSON.stringify(trimmed);
}

function loadHistoryFromStorage(key: string): ExecutionRecord[] {
  try {
    const json = localStorage.getItem(key);
    return json ? deserializeHistory(json) : [];
  } catch {
    return [];
  }
}

function saveHistoryToStorage(key: string, records: ExecutionRecord[]): void {
  try {
    localStorage.setItem(key, serializeHistory(records));
  } catch {
    // localStorage 不可用时静默忽略
  }
}

// ─── hook ────────────────────────────────────────────────────

export function useProgramRunner({
  project,
  username,
  config,
  projectCwd,
  readFile,
  tabs,
  activeTabId,
  currentContent,
  savedConfigParams,
  editorAreaRef,
  projectDependencies,
}: UseProgramRunnerParams): UseProgramRunnerReturn {
  const [isRunning, setIsRunning] = useState(false);
  const [isCompiling, setIsCompiling] = useState(false);
  const [_runningExecutionId, setRunningExecutionId] = useState<string | null>(null);
  const [executionHistory, setExecutionHistory] = useState<ExecutionRecord[]>([]);
  const [currentResults, setCurrentResults] = useState<ExecutionRecord[]>([]);
  const [runningLogs, setRunningLogs] = useState('');

  // 任务执行服务实例
  const serviceRef = useRef<TaskExecutionService | null>(null);
  // 记录当前执行对应的 filePath，用于映射 TaskSet → ExecutionRecord
  const currentFilePathRef = useRef<string>('');
  // 已完成的执行历史累积（服务每次 submitTaskSet 会替换当前任务集）
  const accumulatedHistoryRef = useRef<ExecutionRecord[]>([]);
  // 记录上次合并的任务集 ID，避免 stop 触发两次 notify 导致重复
  const lastMergedTaskSetIdRef = useRef<string | null>(null);

  // 执行历史按「后端host + 用户 + 项目编码」隔离存储
  const historyStorageKey = useMemo(
    () => buildScopedStorageKey(HISTORY_STORAGE_KEY, username, project.projectCode),
    [username, project.projectCode],
  );
  const historyStorageKeyRef = useRef(historyStorageKey);
  historyStorageKeyRef.current = historyStorageKey;

  // 首次加载 / 切换 host+用户+项目时：从 localStorage 恢复对应作用域的历史
  useEffect(() => {
    const stored = loadHistoryFromStorage(historyStorageKeyRef.current);
    accumulatedHistoryRef.current = stored;
    setExecutionHistory(stored);
  }, [historyStorageKey]);

  // 初始化服务并订阅状态变更
  useEffect(() => {
    const service = new TaskExecutionService();
    serviceRef.current = service;

    const unsubscribe = service.subscribe((taskSet) => {
      setIsRunning(service.isActive());
      setRunningExecutionId(service.getCurrentExecutionId());
      setRunningLogs(taskSet.logs);

      // 执行中只展示已开始的任务（PENDING 任务等开始执行后再展示，避免一次显示 N 条"执行中"）
      const visibleTasks = service.isActive()
        ? taskSet.tasks.filter(t => t.status !== 'PENDING')
        : taskSet.tasks;
      const currentItems = taskSetToExecutionRecords(
        { ...taskSet, tasks: visibleTasks },
        currentFilePathRef.current,
      );

      if (service.isActive()) {
        // 执行中：当前任务仅显示本次执行结果
        setCurrentResults(currentItems);
        // 历史：当前任务 + 已累积历史
        setExecutionHistory([...currentItems, ...accumulatedHistoryRef.current]);
      } else if (taskSet.status !== 'IDLE') {
        // 执行结束：保留当前结果
        setCurrentResults(currentItems);
        // 合并新完成的任务到累积历史（同个 taskSetId 只合并一次）
        if (currentItems.length > 0 && lastMergedTaskSetIdRef.current !== taskSet.id) {
          lastMergedTaskSetIdRef.current = taskSet.id;
          accumulatedHistoryRef.current = [...currentItems, ...accumulatedHistoryRef.current];
          saveHistoryToStorage(historyStorageKeyRef.current, accumulatedHistoryRef.current);
        }
        setExecutionHistory([...accumulatedHistoryRef.current]);
      }
    });

    return () => {
      unsubscribe();
      service.destroy();
      serviceRef.current = null;
    };
  }, []);

  const getFileInfo = useCallback(() => {
    const tabFileName = tabs.find(t => t.id === activeTabId)?.name || '';
    const filePath = tabs.find(t => t.id === activeTabId)?.path || '';
    const fileName = tabFileName || (filePath ? filePath.split(/[/\\]/).pop() || '' : '');
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const codeType = EXT_TO_CODE_TYPE[ext] || 'sql';
    return { fileName, filePath, ext, codeType };
  }, [tabs, activeTabId]);

  const handleRunProgram = useCallback(async (selectedCode?: string) => {
    const service = serviceRef.current;
    if (!service || service.isActive()) return;

    // 每次点击运行程序时，清空执行结果标签页
    setCurrentResults([]);
    setRunningLogs('');

    const content = selectedCode || currentContent;
    if (!content.trim()) {
      const execId = generateId().toString();
      const errorRecord: ExecutionRecord = {
        id: execId, time: new Date(), filePath: getFileInfo().filePath,
        engineType: 'unknown', codeType: 'unknown',
        result: makeExecutionFailResult(execId, '代码内容为空，无法执行'),
      };
      setCurrentResults([errorRecord]);
      setExecutionHistory(prev => [errorRecord, ...prev]);
      return;
    }

    const { fileName, filePath, codeType } = getFileInfo();
    const isJavaOrScala = codeType === 'java' || codeType === 'scala';
    currentFilePathRef.current = filePath;

    // 校验文件头
    const headerValidation = validateFileHeader(content, fileName,
      filePath && projectCwd && filePath.startsWith(projectCwd + '/') ? filePath.slice(projectCwd.length + 1) : undefined,
      project.projectCode || undefined
    );
    if (!headerValidation.valid) {
      const execId = generateId().toString();
      const errorRecord: ExecutionRecord = {
        id: execId, time: new Date(), filePath, engineType: 'unknown', codeType,
        result: makeExecutionFailResult(execId, headerValidation.message),
      };
      setCurrentResults([errorRecord]);
      setExecutionHistory(prev => [errorRecord, ...prev]);
      return;
    }

    // YARN 作业名称校验（Spark/Flink/SQL/Hive/MR 等提交到 YARN 的任务）：
    // 代码中若显式设置了 yarn 作业名称（如 Spark 的 .setAppName("xxx")、Flink 的
    // env.execute("xxx")、SQL 的 set mapreduce.job.name=xxx 等），必须与文件名一致，
    // 否则提交到 YARN 后难以定位作业。未显式设置时视为无需校验（不拦截）。
    const yarnCheck = validateYarnJobName(content, fileName);
    if (!yarnCheck.valid) {
      const execId = generateId().toString();
      const errorRecord: ExecutionRecord = {
        id: execId, time: new Date(), filePath, engineType: isJavaOrScala ? 'spark' : 'unknown', codeType,
        result: makeExecutionFailResult(execId, yarnCheck.message),
      };
      setCurrentResults([errorRecord]);
      setExecutionHistory(prev => [errorRecord, ...prev]);
      return;
    }

    // 环境校验
    if (isJavaOrScala) {
      if (!config.javaHome) {
        const execId = generateId().toString();
        const errorRecord: ExecutionRecord = {
          id: execId, time: new Date(), filePath, engineType: 'spark', codeType,
          result: makeExecutionFailResult(execId, 'JAVA_HOME 未配置，请在设置页面配置 JAVA_HOME'),
        };
        setCurrentResults([errorRecord]);
        setExecutionHistory(prev => [errorRecord, ...prev]);
        return;
      }
    } else {
      const validation = editorAreaRef.current?.validateDataSource();
      if (validation && !validation.valid) {
        return;
      }
    }

    const header = parseFileHeader(content);
    const engineType = header?.engine || (isJavaOrScala ? 'spark' : 'kyuubi');
    const resolvedDataSource = isJavaOrScala ? null : resolveDataSource(content, header);

    const fileParams = savedConfigParams[filePath];
    const runParams: Record<string, unknown> = {};
    (fileParams?.programParams || []).forEach(p => { if (p.key) runParams[p.key] = p.value; });
    const computeResources: Record<string, unknown> = {};
    (fileParams?.taskParams || []).forEach(p => { if (p.key) computeResources[p.key] = p.value; });

    // 公共参数
    const allDepNames = fileParams?.dependencies?.filter(d => d.name).map(d => d.name) || [];
    const commonParams = {
      jarDependencyCatalogs: isJavaOrScala
        ? fileParams?.dependencies?.filter(d => d.name && d.source === 'custom').map(d => d.name) || []
        : allDepNames,
      runParams: Object.keys(runParams).length > 0 ? runParams : undefined,
      computeResources: Object.keys(computeResources).length > 0 ? computeResources : undefined,
      remark: header?.remark || '',
    };

    try {
      if (isJavaOrScala) {
        // ── Java/Scala: 先编译再提交 JAR ──
        setIsCompiling(true);
        setRunningLogs('正在编译中，请稍候...');
        const compileResult = await unifiedCompile({
          projectId: project.id,
          projectCode: project.projectCode || undefined,
          filePath,
          codeContent: content,
          rootPath: projectCwd || undefined,
          envConfig: {
            javaHome: config.javaHome,
            scalaHome: config.scalaHome,
            mavenHome: config.mavenHome,
            scalaVersion: config.scalaVersion || undefined,
            pomTemplate: config.pomTemplate || undefined,
            workspace: config.cwd || undefined,
            mavenGroupId: config.mavenGroupId || undefined,
            mavenArtifactId: config.mavenArtifactId || undefined,
          },
          savedConfig: fileParams || null,
          projectDependencies,
        });

        if (!compileResult || !compileResult.success) {
          throw new Error(compileResult?.error || compileResult?.output || '本地编译失败');
        }

        let resolvedJarPath = compileResult.jarPath;
        if (!resolvedJarPath && compileResult.output) {
          const workDirMatch = compileResult.output.match(/工作目录:\s*(.+)/);
          if (workDirMatch?.[1]) {
            const jarBaseName = fileName.replace(/\.[^.]+$/, '') || 'App';
            resolvedJarPath = `${workDirMatch[1].trim().replace(/\/+$/, '')}/target/${jarBaseName}.jar`;
          }
        }

        if (!resolvedJarPath) {
          throw new Error(`编译成功但 JAR 路径为空。输出日志: ${compileResult.output || '(无)'}`);
        }

        const jarUint8Array = await readFile(resolvedJarPath);
        const jarFileName = resolvedJarPath.split(/[/\\]/).pop() || 'App.jar';
        const actualClassName = fileName.replace(/\.[^.]+$/, '') || 'App';

        const task: TaskDefinition = {
          code: content,
          codeType,
          engineType,
          sqlSnippet: fileName,
          jarData: jarUint8Array,
          jarFileName,
          mainClass: `${compileResult.packageName}.${actualClassName}`,
          fileName,
          uploadedJarPath: resolvedJarPath,
          ...commonParams,
        };

        service.submitTaskSet([task], (logs) => setRunningLogs(logs));
        setIsCompiling(false);

      } else if (codeType === 'sql') {
        const isBatchEngine = /^(spark|flink)$/i.test(engineType);

        if (isBatchEngine) {
          // ── Spark/Flink SQL: 整体提交，不拆分 ──
          const task: TaskDefinition = {
            code: content,
            codeType,
            engineType,
            datasources: resolvedDataSource ? [resolvedDataSource] : undefined,
            sqlSnippet: content.slice(0, 200),
            ...commonParams,
          };
          service.submitTaskSet([task], (logs) => setRunningLogs(logs));

        } else {
          // ── Kyuubi SQL: 拆分语句逐行执行，遇错停止 ──
          const statements = parseSqlStatements(content);
          if (statements.length === 0) {
            throw new Error('未检测到有效的 SQL 语句');
          }

          const tasks: TaskDefinition[] = statements.map((stmt) => {
            const firstKeyword = stmt.split(/\s+/)[0]?.toUpperCase() || '';
            const isHidden = /^(USE|SET)$/.test(firstKeyword);
            return {
              code: stmt,
              codeType,
              engineType,
              datasources: resolvedDataSource ? [resolvedDataSource] : undefined,
              sqlSnippet: stmt,
              hidden: isHidden,
              ...commonParams,
            };
          });

          service.submitTaskSet(tasks, (logs) => setRunningLogs(logs));
        }

      } else {
        // ── Python: 整体提交 ──
        const task: TaskDefinition = {
          code: content,
          codeType,
          engineType,
          datasources: resolvedDataSource ? [resolvedDataSource] : undefined,
          sqlSnippet: fileName,
          ...commonParams,
        };
        service.submitTaskSet([task], (logs) => setRunningLogs(logs));
      }
    } catch (e) {
      setIsCompiling(false);
      const message = e instanceof Error ? e.message : String(e);
      const execId = generateId().toString();
      const errorRecord: ExecutionRecord = {
        id: execId, time: new Date(), filePath, engineType, codeType,
        result: makeExecutionFailResult(execId, message),
      };
      setCurrentResults([errorRecord]);
      setExecutionHistory(prev => [errorRecord, ...prev]);
    }
  }, [currentContent, getFileInfo, savedConfigParams, config, projectCwd, readFile, project, editorAreaRef]);

  const handleCompileDryRun = useCallback(async () => {
    if (serviceRef.current?.isActive()) return;

    // 清空当前执行结果
    setCurrentResults([]);

    const content = currentContent;
    const { fileName, filePath, ext, codeType } = getFileInfo();

    if (!content.trim()) {
      const execId = generateId().toString();
      const errorRecord: ExecutionRecord = {
        id: execId, time: new Date(), filePath,
        engineType: 'unknown', codeType: 'unknown',
        result: makeExecutionFailResult(execId, '代码内容为空，无法编译'),
        sqlSnippet: '编译程序',
      };
      setCurrentResults([errorRecord]);
      setExecutionHistory(prev => [errorRecord, ...prev]);
      return;
    }

    if (codeType !== 'java' && codeType !== 'scala') {
      const execId = generateId().toString();
      const errorRecord: ExecutionRecord = {
        id: execId, time: new Date(), filePath,
        engineType: 'unknown', codeType,
        result: makeExecutionFailResult(execId, `不支持的文件类型 .${ext}，仅支持编译 Java (.java) 和 Scala (.scala) 代码`),
        sqlSnippet: '编译程序',
      };
      setCurrentResults([errorRecord]);
      setExecutionHistory(prev => [errorRecord, ...prev]);
      return;
    }

    const relativePath = projectCwd && filePath.startsWith(projectCwd + '/')
      ? filePath.slice(projectCwd.length + 1) : filePath;

    const headerValidation = validateFileHeader(content, fileName, relativePath, project.projectCode || undefined);
    if (!headerValidation.valid) {
      const execId = generateId().toString();
      let errorDetail = headerValidation.message;
      if (headerValidation.packageErrors.length > 0) {
        errorDetail += '\n\n问题详情:\n' + headerValidation.packageErrors.map((e: string) => `• ${e}`).join('\n');
      }
      if (headerValidation.missingFields.length > 0) {
        errorDetail += '\n\n缺少字段: ' + headerValidation.missingFields.join('、');
      }
      const errorRecord: ExecutionRecord = {
        id: execId, time: new Date(), filePath,
        engineType: 'unknown', codeType,
        result: makeExecutionFailResult(execId, errorDetail),
        sqlSnippet: '编译程序',
      };
      setCurrentResults([errorRecord]);
      setExecutionHistory(prev => [errorRecord, ...prev]);
      return;
    }

    if (!config.javaHome) {
      const execId = generateId().toString();
      const errorRecord: ExecutionRecord = {
        id: execId, time: new Date(), filePath,
        engineType: 'spark', codeType,
        result: makeExecutionFailResult(execId, 'JAVA_HOME 未配置，请在设置页面配置 JAVA_HOME'),
        sqlSnippet: '编译程序',
      };
      setCurrentResults([errorRecord]);
      setExecutionHistory(prev => [errorRecord, ...prev]);
      return;
    }

    const execId = generateId().toString();
    const startTime = Date.now();
    setIsCompiling(true);
    setRunningLogs('正在编译中，请稍候...');
    const pendingRecord: ExecutionRecord = {
      id: execId, time: new Date(), filePath,
      engineType: 'spark', codeType,
      result: null,
      sqlSnippet: fileName,
    };
    setCurrentResults([pendingRecord]);
    setExecutionHistory(prev => [pendingRecord, ...prev]);

    try {
      const result = await unifiedCompile({
        projectId: project.id,
        projectCode: project.projectCode || undefined,
        filePath,
        codeContent: content,
        rootPath: projectCwd || undefined,
        envConfig: {
          javaHome: config.javaHome,
          scalaHome: config.scalaHome,
          mavenHome: config.mavenHome,
          scalaVersion: config.scalaVersion || undefined,
          pomTemplate: config.pomTemplate || undefined,
          workspace: config.cwd || undefined,
          mavenGroupId: config.mavenGroupId || undefined,
          mavenArtifactId: config.mavenArtifactId || undefined,
        },
        savedConfig: savedConfigParams[filePath] || null,
        projectDependencies,
      });

      const duration = Date.now() - startTime;
      setIsCompiling(false);
      if (result.success) {
        const successResult: CodeExecutionResult = {
          success: true,
          executionId: execId,
          status: 'SUCCESS',
          outputLog: `包名: ${result.packageName}\n类名: ${result.className}\nJAR 路径: ${result.jarPath}\n${result.output}`,
          errorMessage: null,
          affectedRows: null,
          resultData: null,
          startTime: null,
          endTime: null,
          durationMs: duration,
        };
        setCurrentResults(prev => prev.map(e => e.id === execId ? { ...e, result: successResult } : e));
        setExecutionHistory(prev => prev.map(e => e.id === execId ? { ...e, result: successResult } : e));
        setRunningLogs(`编译成功 (${duration}ms)\n包名: ${result.packageName}\n类名: ${result.className}\nJAR: ${result.jarPath}`);
      } else {
        const failResult = makeExecutionFailResult(execId, result.error || result.output || '编译失败');
        setCurrentResults(prev => prev.map(e => e.id === execId ? { ...e, result: failResult } : e));
        setExecutionHistory(prev => prev.map(e => e.id === execId ? { ...e, result: failResult } : e));
        setRunningLogs(`编译失败 (${duration}ms)\n${result.error || result.output}`);
      }
    } catch (e) {
      const duration = Date.now() - startTime;
      setIsCompiling(false);
      const failResult = makeExecutionFailResult(execId, e instanceof Error ? e.message : String(e));
      setCurrentResults(prev => prev.map(e => e.id === execId ? { ...e, result: failResult } : e));
      setExecutionHistory(prev => prev.map(e => e.id === execId ? { ...e, result: failResult } : e));
      setRunningLogs(`编译失败 (${duration}ms)\n${e instanceof Error ? e.message : String(e)}`);
    }
  }, [currentContent, getFileInfo, savedConfigParams, config, projectCwd, project]);

  const handleCancelExecution = useCallback(async () => {
    serviceRef.current?.stop();

    // 向后端发送取消请求（服务内部已处理，此处确保一致性）
    const service = serviceRef.current;
    if (!service) return;

    // 服务停止后所有状态已通过订阅更新到 React state
    setIsRunning(false);
    setRunningExecutionId(null);
  }, []);

  return {
    handleRunProgram,
    handleCompileDryRun,
    handleCancelExecution,
    isRunning,
    isCompiling,
    executionHistory,
    currentResults,
    runningLogs,
  };
}
