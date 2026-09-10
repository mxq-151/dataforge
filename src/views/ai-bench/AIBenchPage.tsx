/**
 * AIBenchPage — 智能体对话流式渲染性能基准页
 *
 * 免登录访问（App.tsx 中 ?page=ai-bench 路由），用于量化：
 * 1. 长回复流式渲染时的主线程阻塞 / 长任务 / 掉帧情况
 * 2. AI 时间线子树与 Monaco 编辑器子树各自的 React 提交次数与耗时
 * 3. 流式期间 Monaco 的输入延迟（证明优化不会影响其它模块）
 *
 * 关键设计：基准跑在**真实生产代码路径**上 ——
 * 用合成事件客户端喂给真实的 useOpencodeEvents，再由真实的
 * MessageTimeline / TextPartDisplay / PacedMarkdown 渲染。
 */

import React, { Profiler, useCallback, useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import EditorArea from '../../components/editor/EditorArea';
import MessageTimeline from '../../components/ai/timeline/MessageTimeline';
import { useOpencodeEvents } from '../../hooks/opencode/useOpencodeEvents';
import type { LogEntry } from '../../types/opencode-backend';
import type { StatusBarInfo, Tab } from '../../types';
import {
  BenchCollector,
  readMemoryMB,
  nextFrames,
  sleep,
  type BenchConfig,
  type BenchResult,
} from './benchMetrics';
import {
  createSyntheticEventClient,
  generateReplyText,
  buildPreloadTurns,
  type SyntheticClient,
} from './syntheticClient';
import './AIBenchPage.css';

const SESSION_ID = 'bench-session';
const USER_MESSAGE_ID = 'msg-user-1';
const USER_PART_ID = 'prt-user-1';
const ASSISTANT_MESSAGE_ID = 'msg-assistant-1';
const ASSISTANT_PART_ID = 'prt-assistant-1';
const USER_TEXT = '请详细说明本次性能优化的实现方案与收益';

/** 编辑器输入模拟间隔（ms） */
const TYPING_INTERVAL_MS = 25;
/** 编辑器内容超过该长度后重置，避免输入本身越来越慢污染测量 */
const TYPING_RESET_AT = 3000;

const EMPTY_TODOS: never[] = [];
const EMPTY_FILE_CHANGES: never[] = [];

const DEFAULT_CONFIGS: Record<string, BenchConfig> = {
  // 中等长度回复（约 8K 字符，常见的详细回答）
  medium: { totalChars: 8000, chunkChars: 40, intervalMs: 16, typing: true, label: 'medium-8k' },
  // 长回复（约 24K 字符，明显卡顿的场景）
  long: { totalChars: 24000, chunkChars: 40, intervalMs: 16, typing: true, label: 'long-24k' },
  // 长对话：预置 40 轮历史（约 320 个 part）后再流式输出 16K 字符。
  // 用于度量「对话已经很长」时，每帧的时间线投影 + 查找表开销。
  conversation: {
    totalChars: 16000,
    chunkChars: 40,
    intervalMs: 16,
    typing: false,
    preloadTurns: 40,
    label: 'conv-40t-16k',
  },
};

const statusInfo: StatusBarInfo = {
  line: 1,
  column: 1,
  encoding: 'UTF-8',
  spaces: 2,
  eol: '\n',
};

const BenchProfiler: React.FC<{
  id: string;
  collectorRef: React.MutableRefObject<BenchCollector | null>;
  children: React.ReactNode;
}> = ({ id, collectorRef, children }) => {
  const onRender = useCallback<React.ProfilerOnRenderCallback>(
    (_id, _phase, actualDuration) => {
      collectorRef.current?.recordCommit(id, actualDuration);
    },
    [id, collectorRef],
  );
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
};

const AIBenchPage: React.FC = () => {
  const addLog = useCallback((_entry: LogEntry) => {
    // 基准页不展示日志，静默丢弃（保持与生产一致的调用路径但不产生额外开销）
  }, []);
  const sentUserInputsRef = useRef<Set<string>>(new Set([USER_TEXT]));
  const events = useOpencodeEvents(addLog, { sentUserInputsRef });
  const { messages, busy, retry, readPartText, subscribePartText, subscribe, resetState } = events;

  const collectorRef = useRef<BenchCollector | null>(null);
  const syntheticRef = useRef<SyntheticClient | null>(null);
  const editorRef = useRef<any>(null);
  const typingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [running, setRunning] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);

  const pushLog = useCallback((line: string) => {
    setLogLines((prev) => [...prev.slice(-40), line]);
  }, []);

  // ── 订阅合成事件流 ──
  useEffect(() => {
    const synthetic = createSyntheticEventClient();
    syntheticRef.current = synthetic;
    const unsubscribe = subscribe(synthetic.client as never, null);
    return () => {
      unsubscribe();
      synthetic.close();
      syntheticRef.current = null;
    };
  }, [subscribe]);

  // 编辑器 Tab（EditorArea 需要）
  const [tabs] = useState<Tab[]>([
    { id: 'bench-tab', name: 'Bench.scala', path: '/bench/Bench.scala', isModified: false },
  ]);
  const [activeTabId] = useState<string>('bench-tab');
  const [editorValue, setEditorValue] = useState(
    Array.from({ length: 60 }, (_, i) => `  val metric${i} = compute(${i}) // benchmark editor content`).join('\n'),
  );
  const handleEditorChange = useCallback((value: string) => setEditorValue(value), []);
  const handleTabSelect = useCallback(() => {}, []);
  const handleTabClose = useCallback(() => {}, []);

  // ── 编辑器输入延迟探针 ──
  const startTyping = useCallback(() => {
    if (typingTimerRef.current) return;
    let ideal = performance.now() + TYPING_INTERVAL_MS;
    typingTimerRef.current = setInterval(() => {
      const now = performance.now();
      const latency = now - ideal;
      while (ideal <= now) ideal += TYPING_INTERVAL_MS;
      const collector = collectorRef.current;
      if (!collector?.isRunning) return;
      collector.recordEditorLatency(latency);
      collector.markTyping();
      const ed = editorRef.current;
      if (!ed) return;
      const model = ed.getModel?.();
      if (model && model.getValueLength() > TYPING_RESET_AT) {
        model.setValue('');
      }
      ed.trigger?.('bench', 'type', { text: 'a' });
    }, TYPING_INTERVAL_MS);
  }, []);

  const stopTyping = useCallback(() => {
    if (typingTimerRef.current) {
      clearInterval(typingTimerRef.current);
      typingTimerRef.current = null;
    }
  }, []);

  useEffect(() => stopTyping, [stopTyping]);

  /** 等待流式内容停止增长（说明打字机已追平并上屏） */
  const waitForSettled = useCallback(async (maxMs: number): Promise<void> => {
    const read = () =>
      document.querySelector(`[data-timeline-part-id="${ASSISTANT_PART_ID}"]`)?.textContent?.length ?? 0;
    let last = -1;
    let stable = 0;
    const deadline = performance.now() + maxMs;
    while (performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      const current = read();
      if (current === last && current > 0) {
        stable++;
        if (stable >= 3) return;
      } else {
        stable = 0;
      }
      last = current;
    }
  }, []);

  const runOnce = useCallback(
    async (config: BenchConfig): Promise<BenchResult> => {
      const push = syntheticRef.current?.push;
      if (!push) throw new Error('合成事件客户端尚未就绪');

      resetState();
      sentUserInputsRef.current = new Set([USER_TEXT]);
      await nextFrames(4);

      // ── 预置历史轮次（不计入采集窗口）──
      // 「对话已经很长」的场景：先灌入 N 轮 user/assistant 往返，
      // 等 React 把历史渲染稳定后再开始采集，这样测到的是
      // 「长历史 + 新回复流式」的每帧成本，而不是历史本身的构建成本。
      if (config.preloadTurns && config.preloadTurns > 0) {
        const turns = buildPreloadTurns(config.preloadTurns);
        const now = Date.now();
        for (const turn of turns) {
          push({
            type: 'message.updated',
            properties: {
              info: {
                id: turn.userMessageID,
                sessionID: SESSION_ID,
                role: 'user',
                time: { created: now },
              },
            },
          });
          push({
            type: 'message.part.updated',
            properties: {
              part: {
                id: turn.userPartID,
                messageID: turn.userMessageID,
                sessionID: SESSION_ID,
                type: 'text',
                text: turn.userText,
              },
            },
          });
          push({
            type: 'message.updated',
            properties: {
              info: {
                id: turn.assistantMessageID,
                sessionID: SESSION_ID,
                parentID: turn.userMessageID,
                role: 'assistant',
                modelID: 'bench-model',
                agent: 'bench',
                time: { created: now, completed: now + 1 },
              },
            },
          });
          for (const p of turn.parts) {
            push({
              type: 'message.part.updated',
              properties: {
                part: {
                  id: p.id,
                  messageID: turn.assistantMessageID,
                  sessionID: SESSION_ID,
                  type: p.type,
                  ...(p.text !== undefined ? { text: p.text } : {}),
                  ...(p.tool !== undefined ? { tool: p.tool, state: { status: 'completed', input: {}, output: '' } } : {}),
                },
              },
            });
          }
        }
        // 预置消息注册为「已确认真实用户输入」，避免被内部消息过滤器移除
        sentUserInputsRef.current = new Set([USER_TEXT, ...turns.map((t) => t.userText)]);
        // 等历史完成渲染与投影，再进入采集窗口
        await sleep(1200);
        await nextFrames(4);
      }

      const fullText = generateReplyText(config.totalChars);
      const collector = new BenchCollector();
      collectorRef.current = collector;
      editorRef.current?.getModel?.()?.setValue('');
      const memBefore = readMemoryMB();

      collector.start();
      if (config.typing) startTyping();
      const t0 = performance.now();

      // ── 会话开始 ──
      push({
        type: 'session.status',
        properties: { sessionID: SESSION_ID, status: { type: 'busy' } },
      });
      push({
        type: 'message.updated',
        properties: {
          info: {
            id: USER_MESSAGE_ID,
            sessionID: SESSION_ID,
            role: 'user',
            time: { created: Date.now() },
          },
        },
      });
      push({
        type: 'message.part.updated',
        properties: {
          part: {
            id: USER_PART_ID,
            messageID: USER_MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'text',
            text: USER_TEXT,
          },
        },
      });
      push({
        type: 'message.updated',
        properties: {
          info: {
            id: ASSISTANT_MESSAGE_ID,
            sessionID: SESSION_ID,
            parentID: USER_MESSAGE_ID,
            role: 'assistant',
            modelID: 'bench-model',
            agent: 'bench',
            time: { created: Date.now() },
          },
        },
      });
      push({
        type: 'message.part.updated',
        properties: {
          part: {
            id: ASSISTANT_PART_ID,
            messageID: ASSISTANT_MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'text',
            text: '',
          },
        },
      });

      // ── 逐块推送 delta ──
      let sent = 0;
      await new Promise<void>((resolve) => {
        const emit = () => {
          const chunk = fullText.slice(sent, sent + config.chunkChars);
          sent += chunk.length;
          push({
            type: 'message.part.delta',
            properties: {
              sessionID: SESSION_ID,
              messageID: ASSISTANT_MESSAGE_ID,
              partID: ASSISTANT_PART_ID,
              field: 'text',
              delta: chunk,
            },
          });
          if (sent < fullText.length) setTimeout(emit, config.intervalMs);
          else resolve();
        };
        setTimeout(emit, 0);
      });
      const emitMs = performance.now() - t0;

      // ── 流结束：全量 part.updated + 消息完成 + idle ──
      push({
        type: 'message.part.updated',
        properties: {
          part: {
            id: ASSISTANT_PART_ID,
            messageID: ASSISTANT_MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'text',
            text: fullText,
          },
        },
      });
      push({
        type: 'message.updated',
        properties: {
          info: {
            id: ASSISTANT_MESSAGE_ID,
            sessionID: SESSION_ID,
            parentID: USER_MESSAGE_ID,
            role: 'assistant',
            modelID: 'bench-model',
            agent: 'bench',
            time: { created: Date.now() - 1000, completed: Date.now() },
          },
        },
      });
      push({
        type: 'session.status',
        properties: { sessionID: SESSION_ID, status: { type: 'idle' } },
      });

      await waitForSettled(20000);
      const wallMs = performance.now() - t0;

      stopTyping();
      const renderedChars =
        document.querySelector(`[data-timeline-part-id="${ASSISTANT_PART_ID}"]`)?.textContent?.length ?? 0;
      const result = collector.finish({
        label: config.label ?? 'custom',
        config,
        emitMs,
        wallMs,
        renderedChars,
        memoryBeforeMB: memBefore,
      });
      collectorRef.current = null;
      return result;
    },
    [resetState, startTyping, stopTyping, waitForSettled],
  );

  // ── 对外暴露基准入口（供 CDP 脚本调用）──
  useEffect(() => {
    const api = {
      ready: true,
      run: async (config?: Partial<BenchConfig> & { preset?: string }) => {
        setRunning(true);
        try {
          const preset = config?.preset && DEFAULT_CONFIGS[config.preset];
          const merged: BenchConfig = { ...DEFAULT_CONFIGS.medium, ...preset, ...config };
          merged.label = merged.label ?? config?.preset ?? `${merged.totalChars}chars`;
          const result = await runOnce(merged);
          pushLog(`[${merged.label}] 完成：wall=${result.wallMs}ms 阻塞=${result.heartbeat.blockedMs}ms 长任务=${result.longTask.count}`);
          return result;
        } finally {
          setRunning(false);
        }
      },
      /** 空闲基线：不产生任何流式更新时的主线程抖动，用于扣除环境噪声 */
      idleBaseline: async (ms = 2000) => {
        const collector = new BenchCollector();
        collectorRef.current = collector;
        collector.start();
        if (!typingTimerRef.current) startTyping();
        await new Promise((r) => setTimeout(r, ms));
        stopTyping();
        const result = collector.finish({
          label: 'idle',
          config: { totalChars: 0, chunkChars: 0, intervalMs: 0, label: 'idle' },
          emitMs: 0,
          wallMs: ms,
          renderedChars: 0,
          memoryBeforeMB: readMemoryMB(),
        });
        collectorRef.current = null;
        return result;
      },
      isRunning: () => running,
    };
    (window as unknown as Record<string, unknown>).__AI_BENCH__ = api;
    return () => {
      delete (window as unknown as Record<string, unknown>).__AI_BENCH__;
    };
  }, [runOnce, startTyping, stopTyping, pushLog, running]);

  return (
    <div className="ai-bench-page">
      <div className="ai-bench-page__side">
        <div className="ai-bench-page__title">
          智能体对话（真实 MessageTimeline + useOpencodeEvents）
          <span className={`ai-bench-page__dot ${running ? 'is-running' : ''}`} />
        </div>
        <BenchProfiler id="ai-timeline" collectorRef={collectorRef}>
          <MessageTimeline
            messages={messages}
            status={busy ? (retry ? 'retry' : 'busy') : 'idle'}
            retry={retry}
            readPartText={readPartText}
            subscribePartText={subscribePartText}
            currentSessionID={SESSION_ID}
            sessions={[]}
            todos={EMPTY_TODOS}
            fileChanges={EMPTY_FILE_CHANGES}
          />
        </BenchProfiler>
      </div>

      <div className="ai-bench-page__side ai-bench-page__side--editor">
        <div className="ai-bench-page__title">Monaco（EditorArea + 输入延迟探针）</div>
        <BenchProfiler id="editor-area" collectorRef={collectorRef}>
          <EditorArea
            tabs={tabs}
            activeTabId={activeTabId}
            onTabSelect={handleTabSelect}
            onTabClose={handleTabClose}
            value={editorValue}
            onChange={handleEditorChange}
            statusInfo={statusInfo}
            language="scala"
          />
        </BenchProfiler>
        <div className="ai-bench-page__typing-probe">
          <Editor
            height="140px"
            defaultLanguage="scala"
            value="// 输入延迟探针：流式期间以 25ms 节奏向此编辑器输入字符"
            onMount={(editor) => {
              editorRef.current = editor;
            }}
            options={{ minimap: { enabled: false }, lineNumbers: 'off', fontSize: 11 }}
          />
        </div>
        <div className="ai-bench-page__log">
          {logLines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
          {logLines.length === 0 && <div className="ai-bench-page__log-hint">等待 CDP 调用 window.__AI_BENCH__.run()</div>}
        </div>
      </div>
    </div>
  );
};

export default AIBenchPage;
