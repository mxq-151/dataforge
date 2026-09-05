/**
 * PacedMarkdown — 打字机流式 Markdown 渲染（分块增量渲染版）
 *
 * 对齐 opencode 桌面版 createPacedValue + PacedMarkdown（message-part.tsx 191-286 行）。
 *
 * 核心机制：
 * - TEXT_RENDER_PACE_MS = 32：每步间隔 32ms
 * - TEXT_RENDER_IMMEDIATE = 512：剩余 ≤512 字符时一次性同步（不打字）
 * - step(size)：按剩余长度分级步长（2/4/8/最多512）
 * - next(text, start)：在步长后 8 字符内找断词符号对齐（snap-to-punctuation）
 *
 * 性能优化（分块增量渲染）：
 * 原实现每次打字机步进都用 ReactMarkdown 重新解析**整段**文本，长回复下是
 * O(n²) 的重复解析（8k 字符回复会被重新解析数百次）。本实现将文本拆成：
 * - 稳定前缀（stableText）：已越过安全边界的部分，用 useMemo 缓存，
 *   只在「跨越段落边界」时才重新解析，其余步进直接复用上一次的 React 元素。
 * - 活动尾部（activeText）：最后一段仍在增长的部分，每步重解析，但只几百字符。
 *
 * 这样单步的解析开销从「与总长度成正比」降为「与尾部段落长度成正比」，
 * 消除长回复下 Markdown 重复解析导致的卡顿。
 *
 * 分块边界：优先在不处于围栏代码块（``` / ~~~）内的**空行（段落）**末尾拆分，
 * 使段落/列表/表格整体固化、避免破坏代码块语法高亮；活动尾部过长时退化为换行边界。
 * 流式结束后由 TextPartDisplay 用完整 GFM 重新渲染，最终形态与优化前完全一致。
 *
 * SolidJS → React 适配：
 * - createSignal → useState
 * - createEffect → useEffect [text, streaming]
 * - 闭包变量 shown/timeout → useRef（避免异步回调中的陈旧闭包）
 * - onCleanup → useEffect cleanup return
 * - getValue() accessor → textRef.current（run 回调中读取最新值）
 */

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
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

// ── findStableSplit(text)：定位稳定前缀的安全拆分点 ─────────────
//
// 返回稳定前缀的结束位置（字节偏移）。规则（按优先级）：
// 1. 优先在**空行边界**（段落结束处的空行之后）拆分：段落/列表/表格等完整块
//    被整体固化，既不破坏围栏代码块的语法高亮，也避免把列表拆成多个 <ul>；
// 2. 若空行边界过远（活动尾部超过 MAX_ACTIVE_CHARS，例如超长列表/连续段落），
//    退化为**普通换行边界**，把尾部每次重解析的成本限制在常量级；
// 3. 围栏代码块（``` / ~~~）内的行、以及文本最后一个（仍在增长的）行永不拆分。
//
// 返回值 0 表示没有安全边界（例如纯单行文本或尚未出现换行），此时整段文本都作为活动尾部。

export const MAX_ACTIVE_CHARS = 1500;

export function findStableSplit(text: string): number {
  let lastParaSplit = 0; // 最后一个空行边界（段落结束）
  let lastLineSplit = 0; // 最后一个普通换行边界
  // fence: 当前是否处于未闭合的围栏代码块内，以及围栏开启标记（字符 + 最少长度）
  let fence: { char: string; min: number } | null = null;
  let lineStart = 0;
  const len = text.length;

  for (let i = 0; i <= len; i++) {
    if (i !== len && text[i] !== '\n') continue;
    // 处理 text.slice(lineStart, i) 这一行（不含换行符）
    const line = text.slice(lineStart, i);
    const trimmed = line.replace(/^[ \t]+/, '');

    if (fence === null) {
      const opener = /^(`{3,}|~{3,})/.exec(trimmed);
      if (opener) {
        fence = { char: opener[1][0], min: opener[1].length };
      } else if (i < len) {
        // 完整行且不在围栏内：普通换行边界始终可用
        lastLineSplit = i + 1;
        // 空行（仅空白）表示前一段落结束，可作为段落边界
        if (trimmed.trim().length === 0) {
          lastParaSplit = i + 1;
        }
      }
    } else {
      const closer = /^(`{3,}|~{3,})/.exec(trimmed);
      if (closer && closer[1][0] === fence.char && closer[1].length >= fence.min) {
        fence = null;
      }
      // 围栏内行不更新任何边界
    }

    lineStart = i + 1;
  }

  // 优先空行边界；若活动尾部过长，退化为普通换行边界以限制重解析成本
  if (lastParaSplit > 0 && text.length - lastParaSplit <= MAX_ACTIVE_CHARS) {
    return lastParaSplit;
  }
  return lastLineSplit;
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

  // 拆分稳定前缀 / 活动尾部（useMemo 依赖 pacedText，字符串比较按值，跨步进不变时保持引用）
  const { stableText, activeText } = useMemo(() => {
    if (!pacedText) return { stableText: '', activeText: '' };
    const split = findStableSplit(pacedText);
    return {
      stableText: split > 0 ? pacedText.slice(0, split) : '',
      activeText: split > 0 ? pacedText.slice(split) : pacedText,
    };
  }, [pacedText]);

  // 稳定前缀的 ReactMarkdown 元素：仅在稳定前缀内容变化（跨越换行边界）时重新解析。
  // 复用同一元素引用时 React 会直接跳过该子树的协调，避免每步全量重解析。
  const stableElement = useMemo(
    () => (stableText ? <ReactMarkdown components={markdownComponents}>{stableText}</ReactMarkdown> : null),
    [stableText],
  );

  if (!pacedText) return null;

  return (
    <div className={`ai-panel__markdown ${className}`.trim()} key={cacheKey}>
      {stableElement}
      {activeText ? <ReactMarkdown components={markdownComponents}>{activeText}</ReactMarkdown> : null}
    </div>
  );
};

export default React.memo(PacedMarkdown);
