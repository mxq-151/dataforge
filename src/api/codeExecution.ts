import { getApiHost, getAuthToken } from './index';
import type { ApiResponse } from './types';

export interface CodeExecutionRequest {
  codeContent?: string;
  codeType: string;
  engineType: string;
  datasources?: string[];
  jarDependencyCatalogs?: string[];
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

  const headers: Record<string, string> = { ...extraHeaders };
  const token = await getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    body: formData,
    headers,
    signal,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
};

export const cancelExecution = async (executionId: string): Promise<ApiResponse<boolean>> => {
  const url = `${getApiHost()}/api/development/execution/cancel?executionId=${encodeURIComponent(executionId)}`;

  const headers: Record<string, string> = {};
  const token = await getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
};

export const submitCode = async (body: CodeExecutionRequest, signal?: AbortSignal, extraHeaders?: Record<string, string>): Promise<ApiResponse<CodeExecutionResult>> => {
  const formData = new FormData();

  const requestBlob = new Blob([JSON.stringify(body)], { type: 'application/json' });
  formData.append('request', requestBlob, 'request.json');

  const url = `${getApiHost()}/api/development/execution/submit`;

  const headers: Record<string, string> = { ...extraHeaders };
  const token = await getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    body: formData,
    headers,
    signal,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
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

  const headers: Record<string, string> = {};
  const token = await getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    body: formData,
    headers,
    signal,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
};

const getExecutionResult = async (executionId: string, signal?: AbortSignal, extraHeaders?: Record<string, string>): Promise<ApiResponse<CodeExecutionResult>> => {
  const url = `${getApiHost()}/api/development/execution/result/${encodeURIComponent(executionId)}`;

  const headers: Record<string, string> = { ...extraHeaders };
  const token = await getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
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

  const headers: Record<string, string> = { ...extraHeaders };
  const token = await getAuthToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
};

const DDL_KEYWORDS = [
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'GRANT', 'REVOKE', 'COMMENT',
];

// 会话级语句：执行时间极短、无结果集，应走同步执行
const SESSION_KEYWORDS = [
  'USE', 'SET',
];

const isDdlStatement = (sql: string): boolean => {
  const cleanedSql = sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();

  if (!cleanedSql) return false;

  const firstKeyword = cleanedSql.split(/\s+/)[0]?.toUpperCase() || '';
  return DDL_KEYWORDS.includes(firstKeyword);
};

const isSessionStatement = (sql: string): boolean => {
  const cleanedSql = sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();

  if (!cleanedSql) return false;

  const firstKeyword = cleanedSql.split(/\s+/)[0]?.toUpperCase() || '';
  return SESSION_KEYWORDS.includes(firstKeyword);
};

export const shouldUseAsyncExecution = (codeType: string, codeContent?: string, engineType?: string): boolean => {
  if (codeType === 'java' || codeType === 'scala') {
    return true;
  }

  if (codeType === 'sql' && codeContent && !isDdlStatement(codeContent) && !isSessionStatement(codeContent)) {
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
