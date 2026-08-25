/**
 * PacedMarkdown — 打字机流式 Markdown 渲染
 *
 * 对齐 opencode 桌面版 createPacedValue + PacedMarkdown（message-part.tsx 191-286 行）。
 *
 * 核心机制：
 * - TEXT_RENDER_PACE_MS = 24：每步间隔 24ms
 * - TEXT_RENDER_IMMEDIATE = 512：剩余 ≤512 字符时一次性同步（不打字）
 * - step(size)：按剩余长度分级步长（2/4/8/最多256）
 * - next(text, start)：在步长后 8 字符内找断词符号对齐（snap-to-punctuation）
 *
 * SolidJS → React 适配：
 * - createSignal → useState
 * - createEffect → useEffect [text, streaming]
 * - 闭包变量 shown/timeout → useRef（避免异步回调中的陈旧闭包）
 * - onCleanup → useEffect cleanup return
 * - getValue() accessor → textRef.current（run 回调中读取最新值）
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { markdownComponents } from './markdownComponents';

// ── 常量 ──────────────────────────────────────────────────────
// 桌面版（SolidJS）用 24ms / 256 步长，React 下渲染开销更高，
// 调整为 32ms / 512 步长以降低 re-parse 频率，同时保持流畅的打字机效果。
// 流式期间不启用 remarkGfm（表格/删除线等 GFM 语法解析开销大），
// 流式结束后由 TextPartDisplay/ReasoningPartDisplay 用完整 GFM 重新渲染。

const TEXT_RENDER_PACE_MS = 32;
const TEXT_RENDER_IMMEDIATE = 512;
const TEXT_RENDER_SNAP = /[\s.,!?;:)\]。，！？；：、）】」』]/;

// ── step(size)：按剩余长度分级步长 ──────────────────────────────

function step(size: number): number {
  if (size <= 12) return 2;
  if (size <= 48) return 4;
  if (size <= 96) return 8;
  if (size <= 512) return 16;
  return Math.min(512, Math.ceil(size / 4));
}

// ── next(text, start)：snap-to-punctuation 断词对齐 ────────────

function next(text: string, start: number): number {
  const end = Math.min(text.length, start + step(text.length - start));
  const max = Math.min(text.length, end + 8);
  for (let i = end; i < max; i++) {
    if (TEXT_RENDER_SNAP.test(text[i] ?? '')) return i + 1;
  }
  return end;
}

// ── usePacedValue：React 适配的 createPacedValue ───────────────

/**
 * 打字机节奏 hook：流式过程中逐步暴露文本，非流式时全量显示。
 *
 * @param text 完整文本（流式过程中持续增长）
 * @param streaming 是否处于流式状态
 * @returns 当前应显示的文本片段
 */
function usePacedValue(text: string, streaming: boolean): string {
  const [value, setValue] = useState(text);
  // shownRef：当前已显示文本（闭包外可安全读取）
  const shownRef = useRef(text);
  // timeoutRef：当前挂起的 setTimeout 句柄
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // textRef / streamingRef：run 回调中读取最新值的桥接
  const textRef = useRef(text);
  const streamingRef = useRef(streaming);

  // 同步最新 props 到 ref（每次渲染都执行，不触发重渲染）
  textRef.current = text;
  streamingRef.current = streaming;

  const clear = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
    }
  }, []);

  const sync = useCallback((newText: string) => {
    shownRef.current = newText;
    setValue(newText);
  }, []);

  // run：timeout 回调，推进一帧
  const run = useCallback(() => {
    timeoutRef.current = undefined;
    const currentText = textRef.current;
    const live = streamingRef.current;

    if (!live) {
      sync(currentText);
      return;
    }
    const shown = shownRef.current;
    if (!currentText.startsWith(shown) || currentText.length <= shown.length) {
      sync(currentText);
      return;
    }
    if (currentText.length - shown.length <= TEXT_RENDER_IMMEDIATE) {
      sync(currentText);
      return;
    }
    const end = next(currentText, shown.length);
    sync(currentText.slice(0, end));
    if (end < currentText.length) {
      timeoutRef.current = setTimeout(run, TEXT_RENDER_PACE_MS);
    }
  }, [sync]);

  // useEffect 对齐桌面版 createEffect：text/streaming 变化时驱动
  useEffect(() => {
    const currentText = textRef.current;
    const live = streamingRef.current;

    if (!live) {
      clear();
      sync(currentText);
      return;
    }
    const shown = shownRef.current;
    if (!currentText.startsWith(shown) || currentText.length < shown.length) {
      clear();
      sync(currentText);
      return;
    }
    if (currentText.length - shown.length <= TEXT_RENDER_IMMEDIATE) {
      clear();
      sync(currentText);
      return;
    }
    // 已追平或已有 timeout 在排队 → 不重复调度
    if (currentText.length === shown.length || timeoutRef.current) return;
    timeoutRef.current = setTimeout(run, TEXT_RENDER_PACE_MS);

    return () => {
      clear();
    };
  }, [text, streaming, clear, sync, run]);

  return value;
}

// ── PacedMarkdown 组件 ─────────────────────────────────────────

export interface PacedMarkdownProps {
  /** 完整文本（流式过程中持续增长） */
  text: string;
  /** 缓存 key（通常为 part.id，用于 ReactMarkdown 复用） */
  cacheKey: string;
  /** 是否处于流式状态 */
  streaming: boolean;
  /** 额外 className */
  className?: string;
}

const PacedMarkdown: React.FC<PacedMarkdownProps> = ({ text, cacheKey, streaming, className = '' }) => {
  const pacedText = usePacedValue(text, streaming);

  if (!pacedText) return null;

  return (
    <div className={`ai-panel__markdown ${className}`.trim()} key={cacheKey}>
      <ReactMarkdown components={markdownComponents}>{pacedText}</ReactMarkdown>
    </div>
  );
};

export default React.memo(PacedMarkdown);
