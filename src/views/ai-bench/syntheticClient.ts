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

// ── 预置历史轮次 ───────────────────────────────────────────────
//
// 模拟「对话已经很长」的会话：预置 n 轮 user/assistant 往返，
// 每轮 assistant 含 text / reasoning / tool 各若干 part。
// 这些消息只用于构建历史，不参与流式，因此其渲染成本由
// 虚拟化承担，而**投影 + 查找表**的成本与历史规模成正比，
// 正是长对话下每帧 CPU 的主要来源。

export interface PreloadTurn {
  userMessageID: string;
  userPartID: string;
  assistantMessageID: string;
  partIDs: string[];
  userText: string;
  parts: Array<{ id: string; type: 'text' | 'reasoning' | 'tool'; text?: string; tool?: string }>;
}

const PRELOAD_TEXT = [
  '我先确认一下当前目录下的文件结构，再决定从哪里改。',
  '已经把相关的调用链梳理清楚了，接下来按最小改动原则实施。',
  '这一步的改动验证通过了，继续处理下一个问题点。',
  '发现一处边界条件没有覆盖，这里补上对应的判断。',
];

export function buildPreloadTurns(count: number): PreloadTurn[] {
  const turns: PreloadTurn[] = [];
  for (let i = 0; i < count; i++) {
    const uid = `bench-user-${i}`;
    const aid = `bench-assistant-${i}`;
    const partIDs: string[] = [];
    const parts: PreloadTurn['parts'] = [];

    const reasoningID = `bench-reason-${i}`;
    partIDs.push(reasoningID);
    parts.push({
      id: reasoningID,
      type: 'reasoning',
      text: `分析第 ${i + 1} 个问题点：需要确认输入参数的类型与取值范围，` +
        `并检查下游调用是否依赖默认行为。`,
    });

    const toolID = `bench-tool-${i}`;
    partIDs.push(toolID);
    parts.push({ id: toolID, type: 'tool', tool: 'read' });

    const textID = `bench-text-${i}`;
    partIDs.push(textID);
    parts.push({
      id: textID,
      type: 'text',
      text: `${PRELOAD_TEXT[i % PRELOAD_TEXT.length]}\n\n` +
        `- 影响范围：模块 ${i % 7}\n- 回归风险：低\n- 验证方式：单元测试 + 手工冒烟\n`,
    });

    turns.push({
      userMessageID: uid,
      userPartID: `bench-user-part-${i}`,
      assistantMessageID: aid,
      partIDs,
      userText: `请处理第 ${i + 1} 个优化点`,
      parts,
    });
  }
  return turns;
}

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
