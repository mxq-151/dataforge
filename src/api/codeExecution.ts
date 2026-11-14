import { getApiHost, getAuthToken } from './index';
import { bearerHeader, ensureOk } from './httpCore';
import type { ApiResponse } from './types';
import type { DevJarDependency } from './devProject';

export interface CodeExecutionRequest {
  codeContent?: string;
  codeType: string;
  engineType: string;
  datasources?: string[];
  /** 后端为 DevJarDependency 对象数组，非坐标字符串列表 */
  jarDependencyCatalogs?: DevJarDependency[];
  mainClass?: string;
  fileName?: string;
  uploadedJarPath?: string;
  runParams?: Record<string, unknown>;
  computeResources?: Record<string, unknown>;
  remark?: string;
}

export interface CodeExecutionResult {
  success: boolean;
  executionId: string;
  status: 'SUCCESS' | 'RUNNING' | 'FAILED';
  outputLog: string;
  errorMessage: string | null;
  affectedRows: number | null;
  resultData: string | null;
  columns?: string[];
  rows?: string[][];
  startTime: string | null;
  endTime: string | null;
  durationMs: number | null;
}

const DATASOURCE_ENGINE_MAP: Record<string, string> = {
  mysql: 'mysql',
  postgresql: 'postgresql',
  oracle: 'oracle',
  sqlserver: 'sqlserver',
  hive: 'hive',
  kyuubi: 'kyuubi',
  clickhouse: 'clickhouse',
  doris: 'doris',
  starrocks: 'starrocks',
  presto: 'presto',
  trino: 'trino',
  db2: 'db2',
  oceanbase: 'oceanbase',
  tidb: 'tidb',
  dm: 'dm',
  kingbase: 'kingbase',
  opengauss: 'opengauss',
  gaussdb: 'gaussdb',
};

export const getEngineTypeByDatasourceType = (datasourceType?: string): string => {
  if (!datasourceType) return 'mysql';

  const normalizedType = datasourceType.toLowerCase().trim();

  if (DATASOURCE_ENGINE_MAP[normalizedType]) {
    return DATASOURCE_ENGINE_MAP[normalizedType];
  }

  if (normalizedType.includes('mysql')) return 'mysql';
  if (normalizedType.includes('postgres') || normalizedType.includes('pg')) return 'postgresql';
  if (normalizedType.includes('oracle')) return 'oracle';
  if (normalizedType.includes('sqlserver') || normalizedType.includes('mssql')) return 'sqlserver';
  if (normalizedType.includes('hive')) return 'hive';
  if (normalizedType.includes('kyuubi')) return 'kyuubi';
  if (normalizedType.includes('clickhouse') || normalizedType.includes('ch')) return 'clickhouse';
  if (normalizedType.includes('doris')) return 'doris';
  if (normalizedType.includes('starrocks') || normalizedType.includes('sr')) return 'starrocks';
  if (normalizedType.includes('presto')) return 'presto';
  if (normalizedType.includes('trino')) return 'trino';
  if (normalizedType.includes('db2') || normalizedType.includes('informix')) return 'db2';
  if (normalizedType.includes('oceanbase') || normalizedType.includes('ob')) return 'oceanbase';
  if (normalizedType.includes('tidb')) return 'tidb';
  if (normalizedType.includes('dameng') || normalizedType.includes('dm')) return 'dm';
  if (normalizedType.includes('kingbase') || normalizedType.includes('kingbasees') || normalizedType.includes('gbasedbt')) return 'kingbase';
  if (normalizedType.includes('opengauss') || normalizedType.includes('gauss')) return 'opengauss';

  console.warn(`[codeExecution] 未知的 datasourceType: ${datasourceType}，使用默认引擎 mysql`);
  return 'mysql';
};

export const parseSQLResultData = (resultData: string | null): {
  columns: string[];
  rows: string[][];
  rowCount: number;
} | null => {
  if (!resultData) return null;

  try {
    const parsed = JSON.parse(resultData);

    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        return { columns: [], rows: [], rowCount: 0 };
      }

      const firstRow = parsed[0];
      if (typeof firstRow === 'object' && firstRow !== null && !Array.isArray(firstRow)) {
        const columns = Object.keys(firstRow);
        const rows = parsed.map((row: Record<string, unknown>) =>
          columns.map(col => String(row[col] ?? ''))
        );
        return { columns, rows, rowCount: rows.length };
      }

      if (Array.isArray(firstRow)) {
        const columns = firstRow.map((_: unknown, idx: number) => `column_${idx + 1}`);
        const rows = parsed.map((row: unknown[]) =>
          row.map(cell => String(cell ?? ''))
        );
        return { columns, rows, rowCount: rows.length };
      }
    }

    if (parsed.columns && Array.isArray(parsed.columns) && parsed.rows && Array.isArray(parsed.rows)) {
      return {
        columns: parsed.columns,
        rows: parsed.rows.map((row: unknown[]) => row.map(cell => String(cell ?? ''))),
        rowCount: parsed.rows.length,
      };
    }

    console.warn('[codeExecution] 无法解析结果数据格式:', typeof parsed);
    return null;
  } catch (error) {
    console.error('[codeExecution] 解析 SQL 结果数据失败:', error);
    return null;
  }
};

export const executeCode = async (body: CodeExecutionRequest, signal?: AbortSignal, extraHeaders?: Record<string, string>): Promise<ApiResponse<CodeExecutionResult>> => {
  const formData = new FormData();

  const requestBlob = new Blob([JSON.stringify(body)], { type: 'application/json' });
  formData.append('request', requestBlob, 'request.json');

  const url = `${getApiHost()}/api/development/execution/execute`;

  const headers = bearerHeader(await getAuthToken(), extraHeaders);

  const res = await fetch(url, {
    method: 'POST',
    body: formData,
    headers,
    signal,
  });

  ensureOk(res);
  return res.json();
};

export const cancelExecution = async (executionId: string): Promise<ApiResponse<boolean>> => {
  const url = `${getApiHost()}/api/development/execution/cancel?executionId=${encodeURIComponent(executionId)}`;

  const headers = bearerHeader(await getAuthToken());

  const res = await fetch(url, {
    method: 'POST',
    headers,
  });

  ensureOk(res);
  return res.json();
};

export const submitCode = async (body: CodeExecutionRequest, signal?: AbortSignal, extraHeaders?: Record<string, string>): Promise<ApiResponse<CodeExecutionResult>> => {
  const formData = new FormData();

  const requestBlob = new Blob([JSON.stringify(body)], { type: 'application/json' });
  formData.append('request', requestBlob, 'request.json');

  const url = `${getApiHost()}/api/development/execution/submit`;

  const headers = bearerHeader(await getAuthToken(), extraHeaders);

  const res = await fetch(url, {
    method: 'POST',
    body: formData,
    headers,
    signal,
  });

  ensureOk(res);
  return res.json();
};

export const submitCodeWithJar = async (
  request: CodeExecutionRequest,
  jarData: Uint8Array,
  jarFileName: string,
  signal?: AbortSignal
): Promise<ApiResponse<CodeExecutionResult>> => {
  const formData = new FormData();

  const requestBlob = new Blob([JSON.stringify(request)], { type: 'application/json' });
  formData.append('request', requestBlob, 'request.json');

  const jarFile = new File([jarData as unknown as BlobPart], jarFileName, { type: 'application/java-archive' });
  formData.append('file', jarFile);

  const url = `${getApiHost()}/api/development/execution/submit`;

  const headers = bearerHeader(await getAuthToken());

  const res = await fetch(url, {
    method: 'POST',
    body: formData,
    headers,
    signal,
  });

  ensureOk(res);
  return res.json();
};

const getExecutionResult = async (executionId: string, signal?: AbortSignal, extraHeaders?: Record<string, string>): Promise<ApiResponse<CodeExecutionResult>> => {
  const url = `${getApiHost()}/api/development/execution/result/${encodeURIComponent(executionId)}`;

  const headers = bearerHeader(await getAuthToken(), extraHeaders);

  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal,
  });

  ensureOk(res);
  return res.json();
};

interface ExecutionLogsResult {
  executionId: string;
  status: string;
  logs: string[];
  offset: number;
  nextOffset: number;
  totalCount: number;
  isComplete: boolean;
}

const getExecutionLogs = async (
  executionId: string,
  offset: number = 0,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<ApiResponse<ExecutionLogsResult>> => {
  const url = `${getApiHost()}/api/development/execution/logs/${encodeURIComponent(executionId)}?offset=${offset}`;

  const headers = bearerHeader(await getAuthToken(), extraHeaders);

  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal,
  });

  ensureOk(res);
  return res.json();
};

// 同步执行语句：DDL 与元数据查询、会话语句。
// 这类语句执行时间短，且 SHOW/DESC 等需要立即拿到结果集；走异步提交 + 轮询
// 只会增加延迟，甚至出现「执行成功但结果不展示」。
const SYNC_KEYWORDS = [
  // DDL
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'COMMENT',
  // 元数据查询
  'SHOW', 'DESC', 'DESCRIBE',
  // 会话级语句
  'USE', 'SET',
];

/** 判断单条语句是否应同步执行（按首个关键字识别 DDL / 元数据查询 / 会话语句） */
const isSyncStatement = (statement: string): boolean => {
  const cleanedSql = statement
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();

  if (!cleanedSql) return false;

  const firstKeyword = cleanedSql.split(/\s+/)[0]?.toUpperCase() || '';
  return SYNC_KEYWORDS.includes(firstKeyword);
};

/** 将 SQL 文本按分号拆分为独立语句，正确处理注释和字符串内的分号 */
export function parseSqlStatements(sql: string): string[] {
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

export const shouldUseAsyncExecution = (codeType: string, codeContent?: string, engineType?: string): boolean => {
  if (codeType === 'java' || codeType === 'scala') {
    return true;
  }

  if (codeType === 'sql' && codeContent) {
    // 单条 DDL / SHOW / DESC / USE / SET 同步执行；多语句脚本（如 Spark 整段提交）与
    // 其余查询走异步提交 + 轮询，避免长任务阻塞请求。
    const statements = parseSqlStatements(codeContent);
    if (statements.length === 1 && isSyncStatement(statements[0])) {
      return false;
    }
    return true;
  }

  if (engineType && (engineType.toLowerCase() === 'spark' || engineType.toLowerCase() === 'flink')) {
    return true;
  }

  return false;
};

export interface AsyncPollResult {
  result: CodeExecutionResult;
  logs: string;
}

export const pollUntilComplete = async (
  executionId: string,
  onLogUpdate?: (logs: string) => void,
  signal?: AbortSignal,
  pollIntervalMs: number = 1500,
  maxPolls: number = 600000,
  extraHeaders?: Record<string, string>,
): Promise<AsyncPollResult> => {
  let logsOffset = 0;
  let accumulatedLogs = '';

  for (let i = 0; i < maxPolls; i++) {
    if (signal?.aborted) {
      throw new DOMException('轮询已取消', 'AbortError');
    }

    try {
      const [resultRes, logsRes] = await Promise.all([
        getExecutionResult(executionId, signal, extraHeaders),
        getExecutionLogs(executionId, logsOffset, signal, extraHeaders),
      ]);

      if (resultRes.code !== 200 || !resultRes.data) {
        throw new Error(resultRes.message || '获取执行结果失败');
      }

      if (logsRes.code === 200 && logsRes.data) {
        const logData = logsRes.data;
        if (logData.logs && logData.logs.length > 0) {
          const logText = logData.logs.join('\n');
          accumulatedLogs += (accumulatedLogs ? '\n' : '') + logText;
          // 用 setTimeout 打破 React 18 自动批处理，让日志增量及时更新到 UI
          setTimeout(() => onLogUpdate?.(accumulatedLogs), 0);
        }
        if (logData.nextOffset !== undefined && logData.nextOffset > logsOffset) {
          logsOffset = logData.nextOffset;
        }
      }

      const result = resultRes.data;
      if (result.status !== 'RUNNING') {
        return { result, logs: accumulatedLogs };
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      console.warn(`[pollUntilComplete] 轮询异常:`, e);
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, pollIntervalMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('轮询已取消', 'AbortError'));
      }, { once: true });
    });
  }

  throw new Error(`任务执行超时 (${executionId})：已轮询 ${maxPolls} 次仍未完成`);
};
