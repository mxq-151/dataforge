/**
 * ToolRegistry — 工具注册表
 *
 * 对齐 opencode 桌面版 ToolRegistry（message-part.tsx 1314-1334 行）。
 * 提供 register/get 接口，ToolPartDisplay 根据 tool name 查表分发到对应渲染器。
 * 未注册的工具回退到 GenericTool。
 */

import type React from 'react';

// ── ToolProps：所有工具渲染器接收的统一 props ──────────────────

export interface ToolProps {
  /** 工具名称（如 bash/edit/write/task 等） */
  tool: string;
  /** ToolPart.state.input — 工具输入参数 */
  input: Record<string, unknown>;
  /** ToolPart.state.metadata — 工具元数据（filediff/sessionId 等） */
  metadata: Record<string, unknown>;
  /** ToolPart.state.output — 工具输出（completed 时有值） */
  output?: string;
  /** ToolPart.state.status — pending/running/completed/error */
  status?: string;
  /** 是否隐藏详情（仅显示 trigger，不渲染展开内容） */
  hideDetails?: boolean;
  /** 默认是否展开 */
  defaultOpen?: boolean;
  /** 受控展开状态 */
  open?: boolean;
  /** 展开状态变化回调 */
  onOpenChange?: (open: boolean) => void;
  /** 延迟挂载（重 DOM 工具首屏按帧挂载） */
  defer?: boolean;
}

export type ToolComponent = React.FC<ToolProps>;

// ── 注册表 ─────────────────────────────────────────────────────

const registry: Record<string, ToolComponent> = {};

/** 注册工具渲染器 */
export function registerTool(name: string, render: ToolComponent): void {
  registry[name] = render;
}

/** 获取工具渲染器（未注册返回 undefined） */
export function getTool(name: string): ToolComponent | undefined {
  return registry[name];
}

/** ToolRegistry 对象（对齐桌面版 API） */
export const ToolRegistry = {
  register: registerTool,
  render: getTool,
};
