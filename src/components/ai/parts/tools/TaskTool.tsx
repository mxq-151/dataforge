/**
 * TaskTool — 子智能体任务卡片（内联折叠展示）
 *
 * 子代理的思考 / 工具执行 / 结论通过 task 卡片原地展开查看，不再跳转到子会话：
 * - 折叠态：只显示 agent 名 + 任务描述（running 时带 spinner）
 * - 展开态：读取子会话消息，按时间顺序渲染 reasoning / 工具卡片 / 文本结论
 * - 任务仍在运行时按固定间隔轮询刷新（子代理消息不进入主会话事件流）
 *
 * childSessionId：优先 metadata.sessionId；缺失时 taskSession 回退匹配。
 */

import React, { useEffect, useMemo, useState } from 'react';
import BasicTool, { GenericTool } from '../BasicTool';
import TextShimmer from '../TextShimmer';
import TextPartDisplay from '../TextPartDisplay';
import ReasoningPartDisplay from '../ReasoningPartDisplay';
import { ToolRegistry } from '../ToolRegistry';
import { renderable } from '../../timeline/projection';
import { usePartsData } from '../PartsDataContext';
import type { ToolProps } from '../ToolRegistry';
import type { MessageEntry, Part, Session } from '../../../../types/opencode-backend';

// ── agent tone：4 个固定 tone + 12 色 hash palette ─────────────

const AGENT_TONES: Record<string, string> = {
  ask: '#58a6ff',
  build: '#3fb950',
  docs: '#d2a8ff',
  plan: '#f0883e',
};

const PALETTE = [
  '#58a6ff', '#3fb950', '#d2a8ff', '#f0883e',
  '#f85149', '#79c0ff', '#56d364', '#bc8cff',
  '#ffa657', '#ff7b72', '#7ee787', '#a5d6ff',
];

function agentTone(agent: string): string {
  const key = agent.toLowerCase();
  if (key in AGENT_TONES) return AGENT_TONES[key];
  // hash 到 12 色 palette
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/** Agent 名称首字母大写 */
function capitalizeAgent(name: string): string {
  if (!name) return 'Sub-Agent';
  return name[0].toUpperCase() + name.slice(1);
}

// ── taskSession：sessionId 缺失时回退匹配 ─────────────────────

/**
 * 在 sessions 列表中按 parentID + description + @agent 匹配最新子 session。
 * 对齐桌面版 taskSession（message-part.tsx 497-512 行）。
 */
function taskSession(
  input: Record<string, unknown>,
  currentSessionID: string | undefined,
  sessions: Session[] | undefined,
): string | undefined {
  if (!currentSessionID || !sessions?.length) return undefined;
  const description =
    typeof input.description === 'string' && input.description ? input.description : '';
  const agentRaw = typeof input.subagent_type === 'string' ? input.subagent_type : '';
  const agent = agentRaw ? capitalizeAgent(agentRaw) : '';

  return sessions
    .filter((s) => s.parentID === currentSessionID && !s.time?.archived)
    .filter((s) => (description ? s.title.startsWith(description) : true))
    .filter((s) => (agent ? s.title.includes(`@${agent}`) : true))
    .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))[0]?.id;
}

// ── 子代理对话：运行中的刷新间隔 ───────────────────────────────
// 子代理消息不会进入主会话的 SSE 消息状态（已按 sessionID 过滤），
// 展开期间用定时拉取保证「思考 / 工具执行 / 结论」能持续可见。
const SUBAGENT_REFRESH_MS = 1000;

// ── 子代理对话正文 ─────────────────────────────────────────────

interface SubagentTranscriptProps {
  sessionID: string;
  /** 子代理是否仍在运行（运行中才轮询刷新） */
  running: boolean;
}

/** 从 tool part 提取渲染器所需的 props（与 ToolPartDisplay 的取值口径一致） */
function toolPartProps(part: Part): ToolProps {
  const toolPart = part as any;
  const state = toolPart.state ?? {};
  return {
    tool: toolPart.tool,
    input: (state.input ?? {}) as Record<string, unknown>,
    metadata: (state.metadata ?? {}) as Record<string, unknown>,
    output: typeof state.output === 'string' ? state.output : undefined,
    status: state.status ?? 'pending',
    defaultOpen: false,
  };
}

const SubagentTranscript: React.FC<SubagentTranscriptProps> = ({ sessionID, running }) => {
  const { loadSessionMessages } = usePartsData();
  const [entries, setEntries] = useState<MessageEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const load = async () => {
      try {
        const result = await loadSessionMessages?.(sessionID);
        if (cancelled) return;
        if (result) {
          setEntries(result);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    };

    void load();
    if (running) timer = setInterval(() => { void load(); }, SUBAGENT_REFRESH_MS);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [sessionID, running, loadSessionMessages]);

  // 只展示子代理自己的输出：跳过主会话注入的任务 prompt（user 消息）
  const assistantEntries = useMemo(
    () => (entries ?? []).filter((entry) => entry.info.role === 'assistant'),
    [entries],
  );

  if (failed && !entries) {
    return <div className="ai-panel__subagent-transcript-empty">子代理对话读取失败</div>;
  }

  if (!entries) {
    return <div className="ai-panel__subagent-transcript-empty">正在读取子代理对话...</div>;
  }

  if (assistantEntries.length === 0) {
    return (
      <div className="ai-panel__subagent-transcript-empty">
        {running ? '子代理正在执行，等待输出...' : '子代理没有输出内容'}
      </div>
    );
  }

  return (
    <div className="ai-panel__subagent-transcript">
      {assistantEntries.map((entry) => {
        const parts = entry.parts.filter((part) => {
          if (!renderable(part)) return false;
          // 压缩标记不属于子代理对话内容
          return part.type === 'text' || part.type === 'reasoning' || part.type === 'tool';
        });
        if (parts.length === 0) return null;

        return (
          <div className="ai-panel__subagent-transcript-message" key={entry.info.id}>
            {parts.map((part) => {
              if (part.type === 'text') {
                return <TextPartDisplay key={part.id} part={part} message={entry.info} />;
              }
              if (part.type === 'reasoning') {
                return <ReasoningPartDisplay key={part.id} part={part} message={entry.info} />;
              }
              const Renderer = ToolRegistry.render((part as any).tool) ?? GenericTool;
              return <Renderer key={part.id} {...toolPartProps(part)} />;
            })}
          </div>
        );
      })}
    </div>
  );
};

// ── TaskTool 组件 ─────────────────────────────────────────────

const TaskTool: React.FC<ToolProps> = ({ input, metadata, status, open, onOpenChange }) => {
  const { loadSessionMessages, currentSessionID, sessions } = usePartsData();

  const subagentType = String(input.subagent_type ?? input.agent ?? 'sub-agent');
  const description = String(input.description ?? '');
  const isBackground = metadata.background === true;

  const isRunning = status === 'pending' || status === 'running';
  const agentName = capitalizeAgent(subagentType);
  const tone = agentTone(subagentType);

  // childSessionId：优先 metadata.sessionId；缺失时回退匹配
  const childSessionId = useMemo(() => {
    const value = metadata.sessionId;
    if (typeof value === 'string' && value) return value;
    return taskSession(input, currentSessionID, sessions);
  }, [metadata.sessionId, input, currentSessionID, sessions]);

  // 副标题：优先 description，否则 childSessionId；background 追加标记
  const subtitle = useMemo(() => {
    const value = description || childSessionId || '';
    if (!value) return undefined;
    if (isBackground) return `${value} (background)`;
    return value;
  }, [description, childSessionId, isBackground]);

  // 构建 trigger 内容（自定义 JSX，非 TriggerTitle）
  const triggerContent = (
    <div className="ai-panel__basic-tool-info">
      <div className="ai-panel__basic-tool-info-main">
        <span className="ai-panel__type-badge ai-panel__type-badge--tool">子代理</span>
        {isRunning && (
          <span className="ai-panel__task-tool-spinner" style={{ color: tone }} aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="ai-panel__tool-icon--running">
              <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
              <path d="M6 2a4 4 0 0 1 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <animateTransform attributeName="transform" type="rotate" from="0 6 6" to="360 6 6" dur="1s" repeatCount="indefinite" />
              </path>
            </svg>
          </span>
        )}
        <span className="ai-panel__basic-tool-title" style={{ color: tone }}>
          <TextShimmer text={agentName} active={isRunning} />
        </span>
        {subtitle && !isRunning && (
          <span className="ai-panel__basic-tool-subtitle">{subtitle}</span>
        )}
      </div>
    </div>
  );

  // 无子会话（拿不到 childSessionId）或没有读取能力时不提供展开
  const expandable = !!(childSessionId && loadSessionMessages);

  return (
    <BasicTool
      status={status}
      allowPendingToggle
      open={open}
      onOpenChange={onOpenChange}
      trigger={triggerContent}
      className="ai-panel__basic-tool--sub-agent"
    >
      {expandable ? (
        <SubagentTranscript sessionID={childSessionId!} running={isRunning} />
      ) : null}
    </BasicTool>
  );
};

export default React.memo(TaskTool);
