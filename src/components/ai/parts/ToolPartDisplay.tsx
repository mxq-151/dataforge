/**
 * ToolPartDisplay — 工具 part 分发
 *
 * 对齐 opencode 桌面版 ToolPartDisplay（message-part.tsx 1372-1461 行）。
 *
 * 职责：
 * 1. todowrite → return null（HIDDEN_TOOLS，renderable 已过滤，此处双保险）
 * 2. question pending/running → 不渲染（双保险）
 * 3. error 状态 → ToolErrorCard（question dismissed 特殊文案；task 带 subtitle/href）
 * 4. "fake pending" 修正（持久化会话回显时状态可能滞后）
 * 5. ToolRegistry.render(tool) ?? GenericTool 兜底
 *
 * 模块加载时注册所有内置工具渲染器。
 */

import React, { useMemo } from 'react';
import type { ToolPart, Message, Part } from '../../../types/opencode-backend';
import { ToolRegistry } from './ToolRegistry';
import { GenericTool } from './BasicTool';
import ToolErrorCard from './ToolErrorCard';
import type { ToolProps } from './ToolRegistry';

// ── 工具组件 ───────────────────────────────────────────────────
import BashTool from './tools/BashTool';
import FileEditTool from './tools/FileEditTool';
import WebFetchTool from './tools/WebFetchTool';
import WebSearchTool from './tools/WebSearchTool';
import QuestionTool from './tools/QuestionTool';
import SkillTool from './tools/SkillTool';
import TaskTool from './tools/TaskTool';

// ── 模块加载时注册所有内置工具 ─────────────────────────────────

let registered = false;
function ensureRegistered(): void {
  if (registered) return;
  registered = true;
  ToolRegistry.register('bash', BashTool);
  ToolRegistry.register('edit', FileEditTool);
  ToolRegistry.register('write', FileEditTool);
  ToolRegistry.register('apply_patch', FileEditTool);
  ToolRegistry.register('webfetch', WebFetchTool);
  ToolRegistry.register('websearch', WebSearchTool);
  ToolRegistry.register('question', QuestionTool);
  ToolRegistry.register('skill', SkillTool);
  ToolRegistry.register('task', TaskTool);
}
ensureRegistered();

// ── MessagePartProps：统一 part props（对齐桌面版） ────────────

export interface MessagePartProps {
  part: Part;
  message: Message;
  /** 默认展开 */
  defaultOpen?: boolean;
  /** 受控展开状态 */
  toolOpen?: boolean;
  /** 展开状态变化回调 */
  onToolOpenChange?: (open: boolean) => void;
  /** 当前需显示复制按钮的 assistant text part ID */
  showAssistantCopyPartID?: string | null;
  /** 当前 turn 的耗时（ms），用于 text meta */
  turnDurationMs?: number;
}

// ── 从 ToolPart.state 提取字段（兼容 v2 判别联合） ─────────────

interface ToolStateFields {
  status: string;
  input: Record<string, unknown>;
  metadata: Record<string, unknown>;
  output?: string;
  error?: string;
  hasEndTime: boolean;
  hasTitle: boolean;
}

/**
 * 解包 Effect-TS 通用错误包装。
 * SDK 在 tool 执行失败时常常返回形如
 *   "An error occurred in Effect.tryPromise:\n<真实错误>"
 * 的包装文本。这里提取并返回真实的错误信息；非该格式则原样返回。
 */
function unwrapEffectError(message: string): string {
  const prefix = 'An error occurred in Effect.tryPromise';
  // 兼容 "An error occurred in Effect.tryPromise:" 与 "...Effect.tryPromise\n" 等变体
  const idx = message.indexOf(prefix);
  if (idx < 0) return message;
  const rest = message.slice(idx + prefix.length).replace(/^[:\s]+/, '').trim();
  return rest || message;
}

/**
 * 从 ToolStateError.error 提取字符串错误信息。
 *
 * 同一字段在两条数据路径中形态不同：
 * - SSE 事件（message.part.updated）：ToolStateError.error 为 string
 * - session API（session.messages()）：实际返回 SessionMessageToolStateError，
 *   error 为 SessionErrorUnknown = { type: "unknown"; message: string } 对象
 *   （SDK 静态类型在此处与运行时不一致，对象形态会被 TS 类型吞掉）。
 *
 * 这里同时处理两种形态，避免历史会话回显时错误信息被丢弃。
 */
function extractError(raw: unknown): string | undefined {
  if (typeof raw === 'string' && raw.trim()) return unwrapEffectError(raw);
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const msg = typeof obj.message === 'string' ? obj.message : undefined;
    if (msg && msg.trim()) return unwrapEffectError(msg);
    const type = typeof obj.type === 'string' ? obj.type : undefined;
    if (type && type.trim()) return type;
  }
  return undefined;
}

function extractStateFields(part: ToolPart): ToolStateFields {
  const state = part.state as any;
  return {
    status: state?.status ?? 'pending',
    input: (state?.input ?? {}) as Record<string, unknown>,
    metadata: (state?.metadata ?? {}) as Record<string, unknown>,
    output: typeof state?.output === 'string' ? state.output : undefined,
    error: extractError(state?.error),
    hasEndTime: !!state?.time?.end,
    hasTitle: typeof state?.title === 'string',
  };
}

/** websearch provider 标签 */
function webSearchProviderLabel(provider: unknown): string | undefined {
  if (provider === 'parallel') return 'Parallel Web Search';
  if (provider === 'exa') return 'Exa Web Search';
  if (typeof provider === 'string') return 'Web Search';
  return undefined;
}

// ── ToolPartDisplay 组件 ───────────────────────────────────────

const ToolPartDisplay: React.FC<MessagePartProps> = ({ part, defaultOpen, toolOpen, onToolOpenChange }) => {
  const toolPart = part as ToolPart;

  // 双保险：todowrite 不渲染
  if (toolPart.tool === 'todowrite') return null;

  const fields = useMemo(() => extractStateFields(toolPart), [toolPart]);

  // "fake pending" 修正：持久化会话回显时 status 可能滞后
  let status = fields.status;
  if (status === 'pending' || status === 'running') {
    if (fields.output || (fields.hasEndTime && fields.hasTitle)) {
      status = 'completed';
    }
  }

  // 双保险：question pending/running 不渲染
  if (toolPart.tool === 'question' && (status === 'pending' || status === 'running')) {
    return null;
  }

  // error 状态 → 无条件渲染 ToolErrorCard（兜底 'Unknown error'）
  // 不要求 fields.error 非空：session API 路径下 error 可能是对象形态被旧逻辑丢弃，
  // extractError 已统一处理；即便完全缺失，ToolErrorCard 也会以 'Unknown error' 兜底。
  if (status === 'error') {
    const errorText = fields.error;
    const cleaned = errorText ? errorText.replace('Error: ', '') : '';

    // question dismissed 特殊文案
    if (toolPart.tool === 'question' && cleaned.includes('dismissed this question')) {
      return (
        <div className="ai-panel__question-dismissed">
          <span>Dismissed</span>
        </div>
      );
    }

    // task error 带 subtitle（description 或 sessionId）
    let errorSubtitle: string | undefined;
    if (toolPart.tool === 'task') {
      const description =
        typeof fields.input.description === 'string' && fields.input.description
          ? fields.input.description
          : undefined;
      const sessionId =
        typeof fields.metadata.sessionId === 'string' ? fields.metadata.sessionId : undefined;
      errorSubtitle = description ?? sessionId;
    }

    return (
      <ToolErrorCard
        tool={toolPart.tool}
        error={errorText}
        title={
          toolPart.tool === 'websearch'
            ? webSearchProviderLabel(fields.metadata.provider)
            : undefined
        }
        subtitle={errorSubtitle}
        defaultOpen={defaultOpen}
      />
    );
  }

  // 正常分发：ToolRegistry.render(tool) ?? GenericTool
  const Renderer = ToolRegistry.render(toolPart.tool) ?? GenericTool;

  const toolProps: ToolProps = {
    tool: toolPart.tool,
    input: fields.input,
    metadata: fields.metadata,
    output: fields.output,
    status,
    defaultOpen,
    open: onToolOpenChange ? toolOpen : undefined,
    onOpenChange: onToolOpenChange,
  };

  return (
    <div className="ai-panel__tool-part-wrapper" data-timeline-part-id={toolPart.id}>
      <Renderer {...toolProps} />
    </div>
  );
};

export default React.memo(ToolPartDisplay);
