import { generateId } from '../utils';
import {
  executeCode, cancelExecution, submitCode, submitCodeWithJar,
  pollUntilComplete, shouldUseAsyncExecution,
} from '../api/codeExecution';
import type { CodeExecutionResult, CodeExecutionRequest } from '../api/codeExecution';

// ─── 类型定义 ────────────────────────────────────────────────

export type TaskStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
export type TaskSetStatus = 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PARTIAL' | 'CANCELLED';

/** 单个任务的配置，由调用方在提交前组装 */
export interface TaskDefinition {
  code: string;
  codeType: string;
  engineType: string;
  datasources?: string[];
  jarDependencyCatalogs?: string[];
  runParams?: Record<string, unknown>;
  computeResources?: Record<string, unknown>;
  remark?: string;
  /** 用于 UI 展示的代码片段 */
  sqlSnippet?: string;
  /** 是否在结果列表中隐藏（如 USE/SET 语句） */
  hidden?: boolean;
  /** Java/Scala JAR 提交所需数据 */
  jarData?: Uint8Array;
  jarFileName?: string;
  mainClass?: string;
  fileName?: string;
  uploadedJarPath?: string;
}

/** 任务集中单个任务的运行时状态 */
export interface TaskItem {
  id: string;
  definition: TaskDefinition;
  status: TaskStatus;
  result: CodeExecutionResult | null;
  /** 前端轮询/取消使用的 executionId */
  executionId: string | null;
  /** 用于 UI 展示的任务索引 */
  index: number;
}

/** 任务集 */
export interface TaskSet {
  id: string;
  tasks: TaskItem[];
  status: TaskSetStatus;
  /** 当前正在执行的任务索引，-1 表示未开始或已完成 */
  currentTaskIndex: number;
  /** 累积日志 */
  logs: string;
}

type Subscriber = (taskSet: TaskSet) => void;

// ─── 任务执行服务 ────────────────────────────────────────────

export class TaskExecutionService {
  private taskSet: TaskSet | null = null;
  private abortController: AbortController | null = null;
  private subscribers = new Set<Subscriber>();
  private logUpdateCallback: ((logs: string) => void) | null = null;
  private isExecuting = false;

  /**
   * 提交任务集并开始顺序执行
   * @returns 任务集 ID
   */
  submitTaskSet(tasks: TaskDefinition[], onLogUpdate?: (logs: string) => void): string {
    // 先停止已有任务集
    this.stopInternal(false);

    const taskSetId = generateId().toString();
    const taskItems: TaskItem[] = tasks.map((def, index) => ({
      id: generateId().toString(),
      definition: def,
      status: 'PENDING' as TaskStatus,
      result: null,
      executionId: null,
      index,
    }));

    this.taskSet = {
      id: taskSetId,
      tasks: taskItems,
      status: 'RUNNING',
      currentTaskIndex: -1,
      logs: '',
    };

    this.abortController = new AbortController();
    this.logUpdateCallback = onLogUpdate ?? null;
    this.isExecuting = true;
    this.notify();

    // 异步执行，不阻塞调用方
    this.executeAllTasks().catch(() => {});

    return taskSetId;
  }

  /** 停止当前任务集（外部调用入口） */
  stop(): void {
    this.stopInternal(true);
  }

  /** 获取当前任务集快照 */
  getTaskSet(): TaskSet | null {
    return this.taskSet ? this.snapshotTaskSet() : null;
  }

  /** 当前任务集是否处于运行状态 */
  isActive(): boolean {
    return this.isExecuting;
  }

  /** 获取当前正在执行的任务的 executionId（用于向后端取消） */
  getCurrentExecutionId(): string | null {
    if (!this.taskSet) return null;
    const current = this.taskSet.tasks[this.taskSet.currentTaskIndex];
    return current?.executionId ?? null;
  }

  /** 订阅任务集状态变更，返回取消订阅函数 */
  subscribe(callback: Subscriber): () => void {
    this.subscribers.add(callback);
    return () => { this.subscribers.delete(callback); };
  }

  /** 销毁服务 */
  destroy(): void {
    this.stopInternal(true);
    this.subscribers.clear();
    this.logUpdateCallback = null;
  }

  // ─── 内部实现 ──────────────────────────────────────────────

  private stopInternal(cancelBackend: boolean): void {
    if (!this.taskSet || (!this.isExecuting && this.taskSet.status !== 'RUNNING')) return;

    this.abortController?.abort();

    if (this.taskSet) {
      for (const task of this.taskSet.tasks) {
        if (task.status === 'PENDING' || task.status === 'RUNNING') {
          task.status = 'CANCELLED';
          if (!task.result) {
            task.result = makeFailResult(task.id, '任务已取消');
          }
        }
      }
      this.taskSet.status = 'CANCELLED';
    }

    if (cancelBackend) {
      this.cancelBackendExecutions();
    }

    this.isExecuting = false;
    this.abortController = null;
    this.notify();
  }

  private async executeAllTasks(): Promise<void> {
    if (!this.taskSet || !this.abortController) return;

    const { tasks } = this.taskSet;
    let hasFailure = false;

    for (let i = 0; i < tasks.length; i++) {
      if (this.abortController.signal.aborted) break;

      const task = tasks[i];
      this.taskSet.currentTaskIndex = i;
      task.status = 'RUNNING';
      this.notify();

      const snippet = task.definition.sqlSnippet || task.definition.code.slice(0, 80);
      const prefix = tasks.length > 1 ? `[任务 ${i + 1}/${tasks.length}] ` : '';
      this.updateLogs(`${prefix}正在执行: ${snippet}...`);

      try {
        const result = await this.executeSingleTask(task);
        task.result = result;

        if (!result.success) {
          task.status = 'FAILED';
          hasFailure = true;
          this.updateLogs(`${prefix}执行失败: ${result.errorMessage || '未知错误'}`);
          this.notify();
          break; // 遇错停止后续任务
        }

        task.status = 'SUCCESS';
        this.updateLogs(`${prefix}执行完成 (${result.durationMs ?? 0}ms)`);
        this.notify();
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') break;

        task.status = 'FAILED';
        task.result = makeFailResult(
          task.id,
          error instanceof Error ? error.message : String(error),
        );
        hasFailure = true;
        this.updateLogs(`${prefix}执行失败: ${error instanceof Error ? error.message : String(error)}`);
        this.notify();
        break;
      }
    }

    // 汇总任务集状态
    if (this.taskSet) {
      if (this.abortController?.signal.aborted) {
        this.taskSet.status = 'CANCELLED';
      } else if (hasFailure) {
        this.taskSet.status = tasks.some(t => t.status === 'SUCCESS') ? 'PARTIAL' : 'FAILED';
      } else {
        this.taskSet.status = 'COMPLETED';
      }
    }

    this.isExecuting = false;
    this.abortController = null;

    // 添加汇总日志
    if (tasks.length > 1 && this.taskSet) {
      const summary = hasFailure
        ? `\n\n--- 执行结束 ---\n共 ${tasks.length} 个任务，因错误停止`
        : `\n\n--- 全部执行完成 ---\n共 ${tasks.length} 个任务执行完毕`;
      this.taskSet.logs += summary;
      this.logUpdateCallback?.(this.taskSet.logs);
    }

    this.notify();
  }

  private async executeSingleTask(task: TaskItem): Promise<CodeExecutionResult> {
    const def = task.definition;
    const signal = this.abortController!.signal;

    // ── Java/Scala JAR 提交路径 ──
    if (def.jarData) {
      const submitRes = await submitCodeWithJar(
        {
          codeType: def.codeType,
          engineType: def.engineType,
          mainClass: def.mainClass || '',
          fileName: def.fileName || '',
          uploadedJarPath: def.uploadedJarPath || '',
          jarDependencyCatalogs: def.jarDependencyCatalogs,
          runParams: def.runParams,
          computeResources: def.computeResources,
          remark: def.remark || '',
        },
        def.jarData,
        def.jarFileName || '',
        signal,
      );

      if (submitRes.code !== 200 || !submitRes.data) {
        throw new Error(submitRes.message || '提交任务失败');
      }

      task.executionId = submitRes.data.executionId;
      this.notify();

      const pollResult = await pollUntilComplete(
        submitRes.data.executionId,
        (logs) => this.updateLogs(logs),
        signal,
      );

      const result = pollResult.result;
      if (pollResult.logs && (!result.outputLog || pollResult.logs.length > result.outputLog.length)) {
        result.outputLog = pollResult.logs;
      }
      return result;
    }

    // ── SQL / Python 代码执行路径 ──
    const body: CodeExecutionRequest = {
      codeContent: def.code,
      codeType: def.codeType,
      engineType: def.engineType,
      datasources: def.datasources,
      jarDependencyCatalogs: def.jarDependencyCatalogs,
      runParams: def.runParams,
      computeResources: def.computeResources,
      remark: def.remark || '',
    };

    const useAsync = shouldUseAsyncExecution(def.codeType, def.code, def.engineType);

    if (useAsync) {
      // 异步提交 + 轮询
      const submitRes = await submitCode(body, signal);
      if (submitRes.code !== 200 || !submitRes.data) {
        throw new Error(submitRes.message || '提交任务失败');
      }

      task.executionId = submitRes.data.executionId;
      this.notify();

      // 先更新中间状态
      const submitted = submitRes.data;
      const pollResult = await pollUntilComplete(
        submitted.executionId,
        (logs) => this.updateLogs(logs),
        signal,
      );

      const result = pollResult.result;
      if (pollResult.logs && (!result.outputLog || pollResult.logs.length > result.outputLog.length)) {
        result.outputLog = pollResult.logs;
      }
      return result;
    } else {
      // 同步执行
      const res = await executeCode(body, signal);
      if (res.code !== 200 || !res.data) {
        throw new Error(res.message || '执行失败');
      }
      task.executionId = res.data.executionId;
      this.notify();
      return res.data;
    }
  }

  private async cancelBackendExecutions(): Promise<void> {
    if (!this.taskSet) return;
    const ids = this.taskSet.tasks
      .filter(t => t.executionId)
      .map(t => t.executionId!);
    await Promise.allSettled(ids.map(id => cancelExecution(id).catch(() => {})));
  }

  private updateLogs(newLogs: string): void {
    if (this.taskSet) {
      this.taskSet.logs = newLogs;
    }
    this.logUpdateCallback?.(newLogs);
  }

  private notify(): void {
    const snapshot = this.snapshotTaskSet();
    if (!snapshot) return;
    this.subscribers.forEach(cb => {
      try { cb(snapshot); } catch { /* 忽略订阅者异常 */ }
    });
  }

  private snapshotTaskSet(): TaskSet | null {
    if (!this.taskSet) return null;
    return {
      ...this.taskSet,
      tasks: this.taskSet.tasks.map(t => ({ ...t })),
    };
  }
}

// ─── 工具函数 ────────────────────────────────────────────────

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
      if (ch === '*' && nextCh === '/') { i++; inBlockComment = false; }
      continue;
    }
    if (inSingleQuote) {
      current += ch;
      if (ch === "'" && nextCh === "'") { current += nextCh; i++; }
      else if (ch === "'") { inSingleQuote = false; }
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
    if (ch === '/' && nextCh === '*') { inBlockComment = true; i++; continue; }
    if (ch === "'") { inSingleQuote = true; current += ch; continue; }
    if (ch === '"') { inDoubleQuote = true; current += ch; continue; }
    if (ch === ';') {
      current += ch;
      const trimmed = current.trim();
      if (trimmed.length > 0 && !/^(--|\/\*)/.test(trimmed)) statements.push(trimmed);
      current = '';
      continue;
    }
    current += ch;
  }

  const remaining = current.trim();
  if (remaining.length > 0 && !/^(--|\/\*)/.test(remaining)) statements.push(remaining);
  return statements;
}

function makeFailResult(execId: string, message: string): CodeExecutionResult {
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
