import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { generateId } from '../utils';
import { parseFileHeader, validateFileHeader } from '../utils/fileHeader';
import { validateYarnJobName } from '../utils/schedulerMapping';
import { toRelativePath } from '../utils/pathUtils';
import { extractProgramParams, paramsFromItems } from '../utils/programArgs';
import type { ProgramParamItem } from '../utils/programArgs';
import type { CodeExecutionResult } from '../api/codeExecution';
import { unifiedCompile } from '../services/unifiedCompile';
import { TaskExecutionService } from '../features/execHistory';
import type { TaskDefinition, TaskSet } from '../features/execHistory';
import type { Tab, EditorAreaHandle } from '../types';
import type { ProjectInfo } from '../api/devProject';
import type { OpenCodeConfig } from '../types/opencode-backend';
import type { DependencyItemLite } from '../utils/dependencyMerge';
import { buildScopedStorageKey, ensureHistoryStore, readHistory, writeHistory } from '../features/execHistory';
import { invoke } from '../bridge/ipc';
import { listen } from '../bridge/event';

interface SavedConfigLike {
  dependencies: { id: string; name: string; version: string; source?: string; jarPath?: string; groupId?: string; scope?: string; autoChoose?: number | null }[];
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
  /** 「运行程序」参数弹窗点「确定」：以弹窗里确认的键值对编译/提交执行 */
  handleProgramRunConfirm: (items: ProgramParamItem[]) => Promise<void>;
  /** 关闭「运行程序」参数弹窗（放弃本次运行） */
  handleCancelProgramRun: () => void;
  handleCompileDryRun: () => Promise<void>;
  handleCancelExecution: () => Promise<void>;
  handleRunLocal: () => Promise<void>;
  handleLocalRunExecute: (cfg: { mainClass: string; vmArgs: string; programArgs: string }) => Promise<void>;
  handleCancelLocalRun: () => void;
  pendingLocalRun: PendingLocalRun | null;
  /** 待确认的「运行程序」参数（非空时显示参数弹窗） */
  pendingProgramRun: PendingProgramRun | null;
  isRunning: boolean;
  isCompiling: boolean;
  executionHistory: ExecutionRecord[];
  currentResults: ExecutionRecord[];
  runningLogs: string;
}

/** 本地运行待确认状态：打开模态框，编译推迟到用户点「运行」之后 */
interface PendingLocalRun {
  /** 默认程序参数（预填） */
  defaultArgs: string;
  /** 默认主类（预填，取自当前文件：包名.文件名/类名） */
  defaultMainClass: string;
}

/** 远程「运行程序」待确认状态：先弹程序运行参数框，用户点「确定」后才编译/提交 */
interface PendingProgramRun {
  /** 预填的键值对（取自当前文件「配置参数 → 配置程序参数」），弹窗里逐行可编辑 */
  defaultParams: ProgramParamItem[];
  /** 从 SQL 正文识别到的 `${day}` 参数名，弹窗并成空白行预填 */
  extractedKeys: string[];
  /** 代码头 `@程序参数` 的声明原文（未声明为空串），弹窗提示出处用 */
  programArgsHint: string;
  /** 触发时选中的代码片段（有选区时只跑选区）；未选中为 undefined = 整个文件 */
  selectedCode?: string;
}

/** 根据源码与文件名推断默认主类（编译前预填模态框用） */
function buildDefaultMainClass(code: string, fileName: string): string {
  const pkgMatch = code.match(/^\s*package\s+([\w.]+)/m);
  const pkg = pkgMatch ? pkgMatch[1] : '';
  const cls = (fileName || '').replace(/\.[^.]+$/, '');
  if (!cls) return '';
  return pkg ? `${pkg}.${cls}` : cls;
}

/** 将用户输入的参数字符串按空白拆分为命令行参数（忽略引号包裹内容，简单实现） */
function splitArgs(raw: string): string[] {
  const s = (raw ?? '').trim();
  if (!s) return [];
  return s.split(/\s+/).filter(Boolean);
}

const EXT_TO_CODE_TYPE: Record<string, string> = { sql: 'sql', java: 'java', scala: 'scala', py: 'python' };

// 引擎 → 程序类型，用于回填 jarDependencyCatalogs 的 programType（后端 @NotBlank）
const ENGINE_TO_PROGRAM_TYPE: Record<string, string> = {
  spark: 'SPARK', flink: 'FLINK', flink_stream: 'FLINK', kyuubi: 'SPARK',
  hive: 'HIVE', java: 'JAVA', scala: 'SCALA', python: 'PYTHON', mr: 'MAPREDUCE',
};

/**
 * 将前端依赖项映射为后端 DevJarDependency 对象结构（jarDependencyCatalogs 不再传坐标字符串）。
 * Java/Scala 只透传 source=custom 的自定义 jar；其余（SQL/Python）透传全部命名依赖。
 */
const toJarDependencyCatalogs = (
  deps: SavedConfigLike['dependencies'],
  options: { onlyCustom: boolean; engineType?: string },
): { jarName: string; artifactId: string; version?: string; source?: string; jarPath?: string; groupId?: string; scope?: string; programType?: string }[] => {
  const programType = ENGINE_TO_PROGRAM_TYPE[(options.engineType || '').trim().toLowerCase()];
  return deps
    .filter(d => d.name && (!options.onlyCustom || d.source === 'custom'))
    .map(d => ({
      jarName: d.name,
      artifactId: d.name,
      version: d.version,
      source: d.source,
      jarPath: d.jarPath,
      groupId: d.groupId,
      scope: d.scope,
      ...(programType ? { programType } : {}),
    }));
};

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

// ─── 执行历史持久化（统一走 features/execHistory，落盘到主进程磁盘） ──

const HISTORY_STORAGE_KEY = 'dataforge_execution_history';

interface SerializedRecord {
  id: string;
  time: string; // ISO
  filePath: string;
  engineType: string;
  codeType: string;
  result: CodeExecutionResult | null;
  sqlSnippet?: string;
}

/** 把磁盘中的原始记录还原成领域对象（ISO 字符串 → Date） */
function reviveRecord(raw: unknown): ExecutionRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as SerializedRecord;
  if (typeof r.id !== 'string') return null;
  return { ...r, time: new Date(r.time) };
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
  /** 本地运行待确认配置（空=不显示模态框）；编译成功后待用户确认运行参数 */
  const [pendingLocalRun, setPendingLocalRun] = useState<PendingLocalRun | null>(null);
  /** 「运行程序」待确认参数（空=不显示参数弹窗） */
  const [pendingProgramRun, setPendingProgramRun] = useState<PendingProgramRun | null>(null);
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

  // 首次加载 / 切换 host+用户+项目时：从统一历史库恢复对应作用域的历史
  useEffect(() => {
    let cancelled = false;
    void ensureHistoryStore().then(() => {
      if (cancelled) return;
      const stored = readHistory(historyStorageKeyRef.current, reviveRecord);
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
          writeHistory(historyStorageKeyRef.current, accumulatedHistoryRef.current);
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

  /**
   * 真正执行「运行程序」：校验 → 编译（Java/Scala）/ 组装任务 → 提交后端。
   *
   * @param runParamsOverride 运行前参数弹窗确认的内容（所见即所发，覆盖已保存的
   *        「配置程序参数」）；不传时回退到已保存配置。
   */
  const runProgram = useCallback(async (
    selectedCode: string | undefined,
    runParamsOverride?: Record<string, unknown>,
  ) => {
    const service = serviceRef.current;
    if (!service || service.isActive()) return;

    // 清空执行结果标签页
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
      filePath && projectCwd ? toRelativePath(filePath, projectCwd) : undefined,
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
    // 数据源从文件头解析（Java/Scala 同样可能有 @数据源 代码头）
    const resolvedDataSource = resolveDataSource(content, header);

    const fileParams = savedConfigParams[filePath];
    // 程序参数：用户在运行前弹窗里确认的内容优先（非空对象即以其为准，不与其合并 ——
    // 弹窗是所见即所发，用户删掉的参数不应被「已保存值」悄悄补回来）；
    // 没有弹窗（runParamsOverride 为 undefined）时回退到「配置参数 → 配置程序参数」。
    const runParams: Record<string, unknown> = {};
    if (runParamsOverride) {
      Object.assign(runParams, runParamsOverride);
    } else {
      (fileParams?.programParams || []).forEach(p => { if (p.key) runParams[p.key] = p.value; });
    }
    const computeResources: Record<string, unknown> = {};
    (fileParams?.taskParams || []).forEach(p => { if (p.key) computeResources[p.key] = p.value; });

    // 公共参数：jarDependencyCatalogs 传后端 DevJarDependency 对象数组（非坐标字符串数组）
    const commonParams = {
      jarDependencyCatalogs: toJarDependencyCatalogs(
        fileParams?.dependencies ? fileParams.dependencies.filter(d => d.name) : [],
        { onlyCustom: isJavaOrScala, engineType },
      ),
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
          datasources: resolvedDataSource ? [resolvedDataSource] : undefined,
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

  /**
   * 「运行程序」入口：不直接执行，先弹「程序运行参数」框（键值对逐行编辑），
   * 用户点「确定」后才运行。
   *
   * 预填当前文件「配置参数 → 配置程序参数」里已保存的键值对。打开弹窗即清空上一次的
   * 执行结果，避免用户在确认参数期间把残留结果误判成本次运行（口径与「本地运行」一致）。
   *
   * 同时提取程序参数名交给弹窗并成空白行 —— 来源是代码头 `@程序参数` 与 SQL 正文的 `${day}`
   * 变量，只给名字不给取值，取值由用户在弹窗里填。提取的是**即将执行的内容**：选中执行时
   * 看选区，否则看整个文件，与真正下发的内容同源。
   */
  const handleRunProgram = useCallback(async (selectedCode?: string) => {
    const service = serviceRef.current;
    if (!service || service.isActive()) return;

    const { filePath, codeType } = getFileInfo();
    const content = selectedCode || currentContent;
    const { keys, programArgs } = extractProgramParams(content, codeType);

    setCurrentResults([]);
    setRunningLogs('请确认程序运行参数后点击「确定」，确认后将开始执行。');
    setPendingProgramRun({
      defaultParams: savedConfigParams[filePath]?.programParams ?? [],
      extractedKeys: keys,
      programArgsHint: programArgs,
      selectedCode,
    });
  }, [currentContent, getFileInfo, savedConfigParams]);

  /** 参数弹窗点「确定」：把确认后的键值对换算成 runParams 后交给 runProgram */
  const handleProgramRunConfirm = useCallback(async (items: ProgramParamItem[]) => {
    const selectedCode = pendingProgramRun?.selectedCode;
    setPendingProgramRun(null);
    await runProgram(selectedCode, paramsFromItems(items));
  }, [pendingProgramRun, runProgram]);

  const handleCancelProgramRun = useCallback(() => {
    setPendingProgramRun(null);
  }, []);

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

    const relativePath = toRelativePath(filePath, projectCwd);

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

  // 本地运行监听器清理函数引用（每次本地运行前取消上一次的订阅，避免泄漏）
  const localRunCleanupRef = useRef<(() => void) | null>(null);

  // 本地运行（仅 Java / Scala）：校验后弹出运行配置模态框，编译推迟到确认后
  const handleRunLocal = useCallback(async () => {
    const { filePath, fileName, codeType } = getFileInfo();
    if (codeType !== 'java' && codeType !== 'scala') {
      setRunningLogs('本地运行仅支持 Java / Scala 文件');
      return;
    }
    const content = currentContent;
    if (!content.trim()) { setRunningLogs('代码内容为空，无法本地运行'); return; }
    if (!config.javaHome) { setRunningLogs('JAVA_HOME 未配置，请在设置页面配置 JAVA_HOME'); return; }

    // 清理上一次本地运行的监听与残留配置
    if (localRunCleanupRef.current) { localRunCleanupRef.current(); localRunCleanupRef.current = null; }
    setPendingLocalRun(null);

    // 用「配置的程序参数」预填模态框（--key value）
    const defaultArgs = (savedConfigParams[filePath]?.programParams || [])
      .map(p => (p.key ? `--${p.key} ${p.value ?? ''}`.trim() : ''))
      .filter(Boolean)
      .join(' ');

    // 发起本地运行即清空上次的执行结果与运行日志，避免结果面板残留上一次内容
    setCurrentResults([]);
    setRunningLogs('请确认运行参数后点击「运行」，确认后将自动编译并在本地执行。');
    setPendingLocalRun({ defaultArgs, defaultMainClass: buildDefaultMainClass(content, fileName) });
  }, [currentContent, getFileInfo, savedConfigParams, config]);

  // 本地运行（用户确认后）：先编译再用配置的 VM 参数/程序参数执行，
  // 运行过程通过「执行结果」面板（currentResults）实时展示
  const handleLocalRunExecute = useCallback(async (cfg: { mainClass: string; vmArgs: string; programArgs: string }) => {
    const { fileName, filePath, codeType } = getFileInfo();
    setPendingLocalRun(null);
    // 本地运行期间置为运行中：使执行结果面板走 busy 分支（显示 RUNNING + 实时日志），
    // 结束后才显示最终 SUCCESS/FAILED，避免编译前就误显示 FAILED。
    setIsRunning(true);

    const execId = generateId().toString();
    const startTime = Date.now();
    let out = '正在编译并准备本地运行...\n';
    setCurrentResults([]);
    setRunningLogs('');

    const pendingRecord: ExecutionRecord = {
      id: execId, time: new Date(), filePath,
      engineType: 'spark', codeType,
      result: {
        success: false, executionId: execId, status: 'RUNNING',
        outputLog: out, errorMessage: null, affectedRows: null, resultData: null,
        startTime: new Date(startTime).toISOString(), endTime: null, durationMs: null,
      },
      sqlSnippet: fileName,
    };
    setCurrentResults([pendingRecord]);
    setExecutionHistory(prev => [pendingRecord, ...prev]);

    // 实时追加一行到当前执行结果，并同步到运行日志区域
    const appendOutput = (text: string) => {
      out = out + text;
      setCurrentResults(prev => prev.map(e => e.id === execId
        ? ({ ...e, result: e.result ? { ...e.result, outputLog: out } : e.result }) : e));
      setRunningLogs(prev => prev + text);
    };

    // 结束本次本地运行，写入最终结果
    const finalizeLocal = (status: 'SUCCESS' | 'FAILED', success: boolean, errorMessage: string | null) => {
      setIsRunning(false);
      const finalResult: CodeExecutionResult = {
        success, executionId: execId, status,
        outputLog: out, errorMessage, affectedRows: null, resultData: null,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString(), durationMs: Date.now() - startTime,
      };
      setCurrentResults(prev => prev.map(e => e.id === execId ? { ...e, result: finalResult } : e));
      setExecutionHistory(prev => prev.map(e => e.id === execId ? { ...e, result: finalResult } : e));
    };

    // 1) 确认后编译，得到产物 jar 与默认主类
    let jarPath: string;
    let compileMainClass: string;
    try {
      const compileResult = await unifiedCompile({
        projectId: project.id,
        projectCode: project.projectCode || undefined,
        filePath,
        codeContent: currentContent,
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
      if (!compileResult || !compileResult.success) {
        appendOutput(`\n本地编译失败：${compileResult?.error || compileResult?.output || '未知错误'}\n`);
        finalizeLocal('FAILED', false, String(compileResult?.error || compileResult?.output || '编译失败'));
        return;
      }
      if (!compileResult.jarPath) {
        appendOutput(`\n编译成功但未生成 JAR：${compileResult.output || '(无输出)'}\n`);
        finalizeLocal('FAILED', false, '编译成功但未生成 JAR');
        return;
      }
      jarPath = compileResult.jarPath;
      // 兜底：编译服务提取主类失败时回退到文件名（与远程运行逻辑一致）
      compileMainClass = `${compileResult.packageName}.${compileResult.className || fileName.replace(/\.[^.]+$/, '')}`;
    } catch (e) {
      appendOutput(`\n本地编译出错：${e instanceof Error ? e.message : String(e)}\n`);
      finalizeLocal('FAILED', false, e instanceof Error ? e.message : String(e));
      return;
    }

    const mainClass = cfg.mainClass.trim() || compileMainClass;
    const args = splitArgs(cfg.programArgs);
    const vmArgs = splitArgs(cfg.vmArgs);

    appendOutput(`编译完成，启动本地进程：java ${vmArgs.join(' ')} -cp <classpath> ${mainClass} ${args.join(' ')}\n`);

    let sessionId: string | null = null;
    const cleanupFns: (() => void)[] = [];

    const rmLog = await listen<{ sessionId: string; text: string }>('local-run-log', (ev) => {
      const p = ev.payload;
      // sessionId 尚未就绪（invoke 返回值前）时也放行：快速失败的 JVM 可能会在
      // invoke 返回前就把异常栈写到 stderr，若在此处按 sessionId 严格过滤会被丢弃。
      if (sessionId && p.sessionId !== sessionId) return;
      appendOutput(p.text);
    });
    cleanupFns.push(rmLog);

    const rmExit = await listen<{ sessionId: string; code: number }>('local-run-exit', (ev) => {
      const p = ev.payload;
      if (sessionId && p.sessionId !== sessionId) return;
      appendOutput(`\n[本地运行] 进程退出，退出码 ${p.code}${p.code === 0 ? '（成功）' : '（失败）'}\n`);
      finalizeLocal(p.code === 0 ? 'SUCCESS' : 'FAILED', p.code === 0, p.code === 0 ? null : `进程退出码 ${p.code}，详见上方运行日志`);
    });
    cleanupFns.push(rmExit);

    const rmStatus = await listen<{ type: string; sessionId?: string; message: string }>('local-run-status', (ev) => {
      const p = ev.payload;
      // status 事件可能不带 sessionId（如依赖 classpath 解析告警），始终展示；
      // 带 sessionId 的仅在 sessionId 已就绪且不匹配主进程时丢弃。
      if (sessionId && p.sessionId && p.sessionId !== sessionId) return;
      appendOutput(`\n[本地运行] ${p.type === 'error' ? '错误' : '提示'}: ${p.message}\n`);
    });
    cleanupFns.push(rmStatus);

    localRunCleanupRef.current = () => { cleanupFns.forEach(fn => fn()); localRunCleanupRef.current = null; };

    try {
      const res = await invoke<{ sessionId: string }>('run_local_java', {
        javaHome: config.javaHome,
        mavenHome: config.mavenHome || '',
        jarPath,
        mainClass,
        args,
        vmArgs,
      });
      sessionId = res.sessionId;
    } catch (e) {
      appendOutput(`\n启动本地进程失败：${e instanceof Error ? e.message : String(e)}\n`);
      finalizeLocal('FAILED', false, e instanceof Error ? e.message : String(e));
      localRunCleanupRef.current?.();
    }
  }, [currentContent, getFileInfo, savedConfigParams, config, projectCwd, project, projectDependencies]);

  const handleCancelLocalRun = useCallback(() => {
    if (localRunCleanupRef.current) { localRunCleanupRef.current(); localRunCleanupRef.current = null; }
    setPendingLocalRun(null);
  }, []);

  return {
    handleRunProgram,
    handleProgramRunConfirm,
    handleCancelProgramRun,
    handleCompileDryRun,
    handleCancelExecution,
    handleRunLocal,
    handleLocalRunExecute,
    handleCancelLocalRun,
    pendingLocalRun,
    pendingProgramRun,
    isRunning,
    isCompiling,
    executionHistory,
    currentResults,
    runningLogs,
  };
}
