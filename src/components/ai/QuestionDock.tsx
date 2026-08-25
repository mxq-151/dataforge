/**
 * QuestionDock — 提问 inline dock
 *
 * 对齐 opencode 桌面版 SessionQuestionDock（session-question-dock.tsx）。
 * 渲染在 composer 栈内 ChatInput 上方，blocked 时 ChatInput 隐藏。
 *
 * 功能（简化版，对齐桌面版核心数据模型）：
 * - 多问题顺序导航（进度指示 + 上一题/下一题，最后一题显示"提交"）
 * - 选项选择：multiple → checkbox 多选，否则 → radio 单选
 * - "其他"选项：每个问题末尾始终展示"其他"，选中后展开自定义输入 textarea
 * - 提交：onSubmit(requestId, answers) 调用 client.question.reply
 * - 取消：onReject(requestId) 调用 client.question.reject
 * - 键盘：Escape 取消，Cmd/Ctrl+Enter 下一题/提交
 *
 * 省略项（相对桌面版）：resize observer / sessionStorage cache / Home/End 键盘导航
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { HelpCircle, X } from 'lucide-react';
import type { ModalRequest, QuestionInfoLocal } from '../../types/opencode-backend';

interface QuestionDockProps {
  modal: ModalRequest;
  onSubmit: (requestId: string, answers: string[][]) => void;
  onReject: (requestId: string) => void;
}

/** "其他"选项内部标记，提交时替换为用户自定义文本 */
const OTHER_MARKER = '__other__';

const QuestionDock: React.FC<QuestionDockProps> = ({ modal, onSubmit, onReject }) => {
  const questions: QuestionInfoLocal[] = modal.questions ?? [];
  const total = questions.length;
  const [tab, setTab] = useState(0);
  // answers[i] = question i 的选中项 label 数组
  const [answers, setAnswers] = useState<string[][]>(() => questions.map(() => []));
  // customText[i] = question i 的自定义答案文本
  const [customText, setCustomText] = useState<string[]>(() => questions.map(() => ''));
  const submittedRef = useRef(false);

  const current = questions[tab];
  const multi = current?.multiple === true;
  const isLast = tab >= total - 1;

  // 当一个 question 选中/取消选项
  const toggleOption = useCallback((label: string) => {
    setAnswers(prev => {
      const next = [...prev];
      const cur = next[tab] ?? [];
      if (multi) {
        next[tab] = cur.includes(label) ? cur.filter(l => l !== label) : [...cur, label];
      } else {
        next[tab] = cur.includes(label) ? [] : [label];
      }
      return next;
    });
  }, [tab, multi]);

  // 判断选项是否选中
  const isPicked = useCallback((label: string) => {
    return (answers[tab] ?? []).includes(label);
  }, [answers, tab]);

  // 自定义答案文本变化
  const handleCustomChange = useCallback((value: string) => {
    setCustomText(prev => {
      const next = [...prev];
      next[tab] = value;
      return next;
    });
  }, [tab]);

  // 收集最终答案：每个 question 的选中项 + "其他"自定义文本
  const collectAnswers = useCallback((): string[][] => {
    return questions.map((_, i) => {
      const selected = answers[i] ?? [];
      const custom = (customText[i] ?? '').trim();
      const hasOther = selected.includes(OTHER_MARKER);
      const withoutOther = selected.filter(l => l !== OTHER_MARKER);
      if (hasOther) {
        // "其他"被选中：用自定义文本替换标记，无文本则提交"其他"字面量
        return [...withoutOther, custom || '其他'];
      }
      return withoutOther;
    });
  }, [questions, answers, customText]);

  // 提交
  const handleSubmit = useCallback(() => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onSubmit(modal.request_id, collectAnswers());
  }, [modal.request_id, collectAnswers, onSubmit]);

  // 取消
  const handleReject = useCallback(() => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onReject(modal.request_id);
  }, [modal.request_id, onReject]);

  // 下一题 / 提交
  const handleNext = useCallback(() => {
    if (isLast) {
      handleSubmit();
      return;
    }
    setTab(t => Math.min(total - 1, t + 1));
  }, [isLast, total, handleSubmit]);

  // 上一题
  const handleBack = useCallback(() => {
    setTab(t => Math.max(0, t - 1));
  }, []);

  // 键盘快捷键
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleReject();
      return;
    }
    const mod = (e.metaKey || e.ctrlKey) && !e.altKey;
    if (mod && e.key === 'Enter') {
      if (e.repeat) return;
      e.preventDefault();
      handleNext();
    }
  }, [handleReject, handleNext]);

  // 当 modal 变化（新提问请求）时重置状态
  useEffect(() => {
    setTab(0);
    setAnswers(questions.map(() => []));
    setCustomText(questions.map(() => ''));
    submittedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal.request_id]);

  const progress = useMemo(() => `${tab + 1} / ${total}`, [tab, total]);

  if (total === 0 || !current) {
    return null;
  }

  return (
    <div className="ai-panel__dock ai-panel__question-dock" onKeyDown={handleKeyDown} tabIndex={-1}>
      <div className="ai-panel__dock-header">
        <HelpCircle size={16} className="ai-panel__dock-info-icon" />
        <span className="ai-panel__dock-title">AI 提问</span>
        {total > 1 && <span className="ai-panel__question-progress">{progress}</span>}
        <button className="ai-panel__dock-close" onClick={handleReject}>
          <X size={14} />
        </button>
      </div>
      <div className="ai-panel__dock-body">
        <div className="ai-panel__question-header">{current.header}</div>
        <div className="ai-panel__question-text">{current.question}</div>
        <div className="ai-panel__question-options">
          {current.options?.map((opt, idx) => (
            <button
              key={idx}
              type="button"
              className={`ai-panel__question-option ${isPicked(opt.label) ? 'ai-panel__question-option--picked' : ''}`}
              role={multi ? 'checkbox' : 'radio'}
              aria-checked={isPicked(opt.label)}
              onClick={() => toggleOption(opt.label)}
            >
              <span className={`ai-panel__question-option-mark ${multi ? 'ai-panel__question-option-mark--checkbox' : 'ai-panel__question-option-mark--radio'}`}>
                {isPicked(opt.label) && (multi ? '✓' : '●')}
              </span>
              <span className="ai-panel__question-option-main">
                <span className="ai-panel__question-option-label">{opt.label}</span>
                {opt.description && (
                  <span className="ai-panel__question-option-desc">{opt.description}</span>
                )}
              </span>
            </button>
          ))}
          {/* "其他"选项 — 始终展示在最后，选中后展开自定义输入 */}
          <button
            key="other"
            type="button"
            className={`ai-panel__question-option ${isPicked(OTHER_MARKER) ? 'ai-panel__question-option--picked' : ''}`}
            role={multi ? 'checkbox' : 'radio'}
            aria-checked={isPicked(OTHER_MARKER)}
            onClick={() => toggleOption(OTHER_MARKER)}
          >
            <span className={`ai-panel__question-option-mark ${multi ? 'ai-panel__question-option-mark--checkbox' : 'ai-panel__question-option-mark--radio'}`}>
              {isPicked(OTHER_MARKER) && (multi ? '✓' : '●')}
            </span>
            <span className="ai-panel__question-option-main">
              <span className="ai-panel__question-option-label">其他</span>
            </span>
          </button>
        </div>
        {isPicked(OTHER_MARKER) && (
          <div className="ai-panel__question-custom">
            <div className="ai-panel__question-custom-label">其他事项</div>
            <textarea
              className="ai-panel__question-custom-input"
              value={customText[tab] ?? ''}
              onChange={e => handleCustomChange(e.target.value)}
              placeholder="输入你的回答..."
              rows={2}
            />
          </div>
        )}
      </div>
      <div className="ai-panel__dock-footer ai-panel__dock-footer--question">
        <button className="ai-panel__dock-btn ai-panel__dock-btn--deny" onClick={handleReject}>
          取消
        </button>
        <div className="ai-panel__dock-footer-actions">
          {tab > 0 && (
            <button className="ai-panel__dock-btn ai-panel__dock-btn--secondary" onClick={handleBack}>
              上一题
            </button>
          )}
          <button className="ai-panel__dock-btn ai-panel__dock-btn--primary" onClick={handleNext}>
            {isLast ? '提交' : '下一题'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default React.memo(QuestionDock);
