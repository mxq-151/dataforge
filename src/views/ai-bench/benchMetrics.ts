/**
 * AI 流式渲染性能基准 — 指标采集器
 *
 * 目标：把「智能体回复内容较长时界面不流畅」量化成可前后对比的数字，
 * 同时证明优化不会影响其它模块（Monaco 代码编辑框）。
 *
 * 采集四类指标：
 * 1. 主线程阻塞抖动（heartbeat）：固定 8ms 的定时器，记录每次实际触发间隔。
 *    主线程被长任务占满时，定时器会延迟触发 —— 延迟量 = 主线程阻塞时长。
 *    这是「界面卡不卡」最直接的度量，且与是否有真实渲染无关。
 * 2. 长任务（longtask）：PerformanceObserver 采集 >50ms 的任务。
 * 3. React 提交耗时（Profiler 提交回调）：直接度量组件树的渲染开销，
 *    按子树（AI 时间线 / 编辑器）分别统计，用于证明编辑器子树是否被波及。
 * 4. 编辑器输入延迟：流式期间以固定节奏向 Monaco 输入字符，
 *    记录「预定时刻 → 实际执行时刻」的延迟，反映用户敲键盘的手感。
 */

/** 心跳定时器间隔（ms）：越小越敏感，8ms 在 Chromium 下不会被 clamp */
const HEARTBEAT_MS = 8;

export interface BenchConfig {
  /** 本次模拟回复的总字符数 */
  totalChars: number;
  /** 每个 delta 事件携带的字符数 */
  chunkChars: number;
  /** delta 事件间隔（ms） */
  intervalMs: number;
  /** 是否在流式期间模拟编辑器输入 */
  typing?: boolean;
  /** 标签（用于报告） */
  label?: string;
}

export interface PercentileStats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** 累计阻塞/耗时（ms） */
  total: number;
}

export interface CommitStats extends PercentileStats {
  /** 超过 16.7ms（一帧）的提交数 */
  overFrame: number;
}

export interface BenchResult {
  label: string;
  config: BenchConfig;
  /** 从第一个 delta 发出到全部文本上屏的总时长 */
  wallMs: number;
  /** 事件流发完的时长 */
  emitMs: number;
  /** 最终文本长度（校验渲染是否完整） */
  renderedChars: number;
  heartbeat: PercentileStats & { blockedMs: number; over50ms: number };
  longTask: { count: number; totalMs: number; maxMs: number };
  frames: { count: number; fps: number; p95Ms: number; longFrames: number };
  commits: Record<string, CommitStats>;
  editorTyping: PercentileStats;
  memoryMB: { before: number; after: number; delta: number };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function stats(samples: number[]): PercentileStats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted.length ? sorted[sorted.length - 1] : 0),
    total: round(samples.reduce((a, b) => a + b, 0)),
  };
}

type CommitRecord = { id: string; duration: number };

/**
 * 单次采集会话。
 *
 * 使用方式：
 *   const c = new BenchCollector();
 *   c.start();          // 开始采集
 *   ... 触发流式 ...
 *   const r = c.finish({...});  // 结束并出报告
 */
export class BenchCollector {
  private heartbeatSamples: number[] = [];
  private frameSamples: number[] = [];
  private commits: CommitRecord[] = [];
  private editorLatencies: number[] = [];
  private longTasks: number[] = [];
  private typing = 0;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private rafHandle: number | null = null;
  private observer: PerformanceObserver | null = null;
  private startedAt = 0;
  private lastHeartbeat = 0;
  private lastFrame = 0;
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.heartbeatSamples = [];
    this.frameSamples = [];
    this.commits = [];
    this.editorLatencies = [];
    this.longTasks = [];
    this.typing = 0;
    this.startedAt = performance.now();
    this.lastHeartbeat = this.startedAt;
    this.lastFrame = this.startedAt;

    this.heartbeatTimer = setInterval(() => {
      const now = performance.now();
      this.heartbeatSamples.push(now - this.lastHeartbeat);
      this.lastHeartbeat = now;
    }, HEARTBEAT_MS);

    const tick = () => {
      const now = performance.now();
      this.frameSamples.push(now - this.lastFrame);
      this.lastFrame = now;
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);

    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longTasks.push(entry.duration);
        }
      });
      this.observer.observe({ type: 'longtask', buffered: false });
    } catch {
      // 浏览器不支持 longtask（如部分 headless 场景）时静默降级
      this.observer = null;
    }
  }

  /** React <Profiler onRender> 回调：记录每次提交的实际耗时 */
  recordCommit = (id: string, actualDuration: number): void => {
    if (this.running) this.commits.push({ id, duration: actualDuration });
  };

  /**
   * 记录一次编辑器输入延迟：调用方在定时器回调里执行编辑操作，
   * 传入「预定执行时刻」与「实际执行时刻」的差值。
   */
  recordEditorLatency = (latencyMs: number): void => {
    if (this.running) this.editorLatencies.push(latencyMs);
  };

  /** 编辑器输入次数（用于核对模拟输入是否真的跑了） */
  markTyping(): void {
    this.typing++;
  }

  /** 是否处于采集窗口内（供外部探针判断要不要记录） */
  get isRunning(): boolean {
    return this.running;
  }

  finish(opts: {
    label: string;
    config: BenchConfig;
    emitMs: number;
    wallMs: number;
    renderedChars: number;
    memoryBeforeMB: number;
  }): BenchResult {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    try {
      this.observer?.disconnect();
    } catch {
      /* ignore */
    }
    this.running = false;

    // 心跳：间隔减去理论间隔 = 主线程被阻塞的时长
    const blocked = this.heartbeatSamples.map((d) => Math.max(0, d - HEARTBEAT_MS));
    const heartbeat = stats(this.heartbeatSamples);
    const blockedMs = round(blocked.reduce((a, b) => a + b, 0));

    // 提交：按子树聚合
    const commitStats: Record<string, CommitStats> = {};
    const byId = new Map<string, number[]>();
    for (const c of this.commits) {
      const list = byId.get(c.id);
      if (list) list.push(c.duration);
      else byId.set(c.id, [c.duration]);
    }
    for (const [id, durations] of byId) {
      const s = stats(durations);
      commitStats[id] = { ...s, overFrame: durations.filter((d) => d > 16.7).length };
    }

    const elapsedSec = (performance.now() - this.startedAt) / 1000;
    const frames = this.frameSamples;
    const frameSorted = [...frames].sort((a, b) => a - b);

    const memAfter = readMemoryMB();

    return {
      label: opts.label,
      config: opts.config,
      wallMs: round(opts.wallMs),
      emitMs: round(opts.emitMs),
      renderedChars: opts.renderedChars,
      heartbeat: {
        ...heartbeat,
        blockedMs,
        over50ms: this.heartbeatSamples.filter((d) => d > 50).length,
      },
      longTask: {
        count: this.longTasks.length,
        totalMs: round(this.longTasks.reduce((a, b) => a + b, 0)),
        maxMs: round(this.longTasks.length ? Math.max(...this.longTasks) : 0),
      },
      frames: {
        count: frames.length,
        fps: round(elapsedSec > 0 ? frames.length / elapsedSec : 0),
        p95Ms: round(percentile(frameSorted, 95)),
        longFrames: frames.filter((d) => d > 33).length,
      },
      commits: commitStats,
      editorTyping: { ...stats(this.editorLatencies), count: this.typing },
      memoryMB: {
        before: round(opts.memoryBeforeMB),
        after: round(memAfter),
        delta: round(memAfter - opts.memoryBeforeMB),
      },
    };
  }
}

export function readMemoryMB(): number {
  const perf = performance as unknown as { memory?: { usedJSHeapSize: number } };
  if (!perf.memory) return 0;
  return perf.memory.usedJSHeapSize / 1024 / 1024;
}

/** 等待 n 个动画帧（让 React 提交与浏览器布局都落定） */
export function nextFrames(n = 2): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const step = () => {
      left--;
      if (left <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const HEARTBEAT_INTERVAL_MS = HEARTBEAT_MS;
