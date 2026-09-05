/**
 * 合成 OpenCode SSE 事件流的假客户端
 *
 * 目的：让性能基准跑在**真实的生产代码路径**上 —— 复用 useOpencodeEvents 的
 * 事件处理（delta 累积 / 合并刷新 / 消息投影），而不是另写一套模拟渲染逻辑。
 * 这样优化前后测到的差异，就等价于真实场景下的差异。
 *
 * 只实现 useOpencodeEvents.subscribe() 实际用到的一个方法：
 *   client.global.event() → { stream: AsyncIterable<{ directory, payload }> }
 */

/** 可被外部 push 的异步可迭代事件队列 */
class EventQueue implements AsyncIterable<{ directory: string | null; payload: unknown }> {
  private items: { directory: string | null; payload: unknown }[] = [];
  private waiter: ((r: IteratorResult<{ directory: string | null; payload: unknown }>) => void) | null = null;
  private closed = false;

  push(payload: unknown): void {
    const value = { directory: null as string | null, payload };
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value, done: false });
    } else {
      this.items.push(value);
    }
  }

  next(): Promise<IteratorResult<{ directory: string | null; payload: unknown }>> {
    if (this.items.length > 0) {
      return Promise.resolve({ value: this.items.shift()!, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<{ directory: string | null; payload: unknown }> {
    return this;
  }
}

export interface SyntheticClient {
  /** 传给 useOpencodeEvents.subscribe 的假客户端 */
  client: unknown;
  push: (payload: unknown) => void;
  close: () => void;
}

export function createSyntheticEventClient(): SyntheticClient {
  const queue = new EventQueue();
  return {
    client: {
      global: {
        event: async () => ({ stream: queue }),
      },
    },
    push: (payload: unknown) => queue.push(payload),
    close: () => queue.close(),
  };
}

// ── 合成回复文本 ───────────────────────────────────────────────
// 结构贴近真实智能体回复：段落 + 列表 + 代码块 + 表格 + 标题，
// 这样 markdown 解析开销才具有代表性（纯文本会严重低估真实成本）。

const PARAGRAPH_SENTENCES = [
  '本次改动的核心是把流式文本的渲染路径从「全量重解析」改为「分块增量渲染」。',
  '实现上，我们将已经稳定的内容块缓存起来，只让最后一个仍在增长的块参与重新解析。',
  '这样单帧的解析与协调开销就从与总长度成正比，降为与尾部块长度成正比。',
  '为了保证语义正确，分块只在围栏代码块之外的空行边界进行，并且会跳过列表续接的场景。',
  '另外我们解耦了流式文本与全局消息状态的更新频率，避免每帧都触发整棵组件树重渲染。',
];

const LIST_ITEMS = [
  '降低主线程阻塞时长，保证编辑器输入始终跟手',
  '避免长回复时 Markdown 的重复解析与协调开销',
  '移除时间线投影中的 O(n²) 查找',
  '保证 Monaco 编辑器子树在流式期间不被无关状态更新波及',
  '保持既有交互与视觉表现完全不变',
];

const CODE_SNIPPET = [
  'public Result execute(Context ctx) {',
  '  final List<Row> rows = ctx.source().fetch();',
  '  for (Row row : rows) {',
  '    row.normalize();',
  '    if (row.isValid()) {',
  '      sink.collect(row);',
  '    }',
  '  }',
  '  return Result.ok(sink.size());',
  '}',
].join('\n');

/** 生成一段接近真实分布的长回复文本 */
export function generateReplyText(totalChars: number): string {
  const chunks: string[] = [];
  let size = 0;
  let i = 0;
  while (size < totalChars) {
    const section = i % 4;
    let piece: string;
    if (section === 0) {
      piece = `## 小节 ${Math.floor(i / 4) + 1}：实现说明\n\n${PARAGRAPH_SENTENCES[i % PARAGRAPH_SENTENCES.length]}\n\n`;
    } else if (section === 1) {
      piece = LIST_ITEMS.map((t) => `- ${t}`).join('\n') + '\n\n';
    } else if (section === 2) {
      piece = '```java\n' + CODE_SNIPPET + '\n```\n\n';
    } else {
      piece =
        '| 指标 | 优化前 | 优化后 | 变化 |\n| --- | --- | --- | --- |\n' +
        `| 主线程阻塞 | 1200 ms | 220 ms | -81% |\n| 长任务数 | ${18 + i} | ${2 + (i % 3)} | 显著下降 |\n` +
        `| 编辑器输入延迟 p95 | 46 ms | 9 ms | -80% |\n\n`;
    }
    chunks.push(piece);
    size += piece.length;
    i++;
  }
  return chunks.join('').slice(0, totalChars);
}
