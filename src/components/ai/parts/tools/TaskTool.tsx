/**
 * TaskTool — 子智能体任务卡片（完全对齐桌面版，跳转模式）
 *
 * 对齐 opencode 桌面版 task 渲染器（message-part.tsx 1797-1880 行）。
 *
 * 行为（与桌面版一致）：
 * - hideDetails={true}（写死，不展开任何内容）
 * - 点击左键：navigateToSession(childSessionId) 跳转当前视图到子 session
 * - Cmd/Ctrl/Shift/Alt/中键：走 triggerHref（<a target=_blank>）新窗口打开
 * - childSessionId：优先 metadata.sessionId；缺失时 taskSession 回退匹配
 *
 * trigger 结构：spinner(running) + agent 名(tone 色) + description(+background 标记) + 外跳图标
 *
 * 不再加载子 session 消息、不再内联展开、不再递归 MessageTimeline。
 */

import React, { useMemo, useCallback } from 'react';
import BasicTool from '../BasicTool';
import TextShimmer from '../TextShimmer';
import { usePartsData } from '../PartsDataContext';
import type { ToolProps } from '../ToolRegistry';
import type { Session } from '../../../../types/opencode-backend';

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

// ── TaskTool 组件 ─────────────────────────────────────────────

const TaskTool: React.FC<ToolProps> = ({ input, metadata, status }) => {
  const { navigateToSession, sessionHref, currentSessionID, sessions } = usePartsData();

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

  // triggerHref：用于 Cmd/中键新窗口
  const href = useMemo(() => {
    if (!childSessionId) return undefined;
    return sessionHref?.(childSessionId);
  }, [childSessionId, sessionHref]);

  const clickable = !!(childSessionId && (navigateToSession || href));

  // 左键 SPA 跳转；修饰键放行默认行为（新窗口）
  const onTriggerClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (!navigateToSession) return;
      // 非左键或带修饰键 → 放行（走 <a> 默认新窗口）
      if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (!childSessionId) return;
      e.preventDefault();
      navigateToSession(childSessionId);
    },
    [navigateToSession, childSessionId],
  );

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
      {clickable && (
        <span className="ai-panel__task-tool-action" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M4 4h4v4M8 4L3.5 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )}
    </div>
  );

  return (
    <BasicTool
      status={status}
      hideDetails
      trigger={triggerContent}
      triggerHref={href}
      clickable={clickable}
      onTriggerClick={onTriggerClick}
      className="ai-panel__basic-tool--sub-agent"
    />
  );
};

export default React.memo(TaskTool);
