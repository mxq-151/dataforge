/**
 * ChatInput — 对话输入区域
 *
 * 包含 textarea、发送/中断按钮、LLM 选择、任务类型选择
 * 支持 @ 触发库表/文件自动补全
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Send, StopCircle } from 'lucide-react';
import AutoCompleteDropdown from './AutoCompleteDropdown';
import LLMSelector from './LLMSelector';
import useAutoCompleteData, { AutoCompleteItem } from '../../hooks/opencode/useAutoCompleteData';
import type { FileNode } from '../../types';
import type { LLMModelConfig } from '../../types/opencode-backend';

interface ChatInputProps {
  busy: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  /** 文件树（仅开发助手模块传入，用于文件名补全） */
  fileTree?: FileNode[];
  /** LLM 模型列表 */
  llmModels: LLMModelConfig[];
  /** 当前选中的 LLM 模型 ID */
  selectedLLMId: string | null;
  /** 切换 LLM 模型 */
  onLLMChange: (m: LLMModelConfig | null) => void;
  /** LLM 选择器是否禁用 */
  llmDisabled: boolean;
  /** 任务类型（覆盖角色，决定系统指令） */
  taskType: string;
  /** 切换任务类型 */
  onTaskTypeChange: (t: string) => void;
  /** 模块 ID（决定任务类型下拉框选项） */
  moduleId: string;
  /** 工作空间路径（用于文件补全时截取相对路径显示） */
  workspacePath?: string;
  /** 预填文本（仅当输入框为空时回显，如回滚对话时回显用户消息），nonce 变化触发 */
  prefill?: { text: string; nonce: number };
}

const ChatInput: React.FC<ChatInputProps> = ({ busy, onSend, onInterrupt, fileTree, llmModels, selectedLLMId, onLLMChange, llmDisabled, taskType, onTaskTypeChange, moduleId, workspacePath, prefill }) => {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 预填：仅当输入框为空时回显文本（nonce 变化触发，跳过初始 nonce=0）
  useEffect(() => {
    if (!prefill || prefill.nonce === 0) return;
    setValue(prev => (prev.trim() !== '' ? prev : prefill.text));
  }, [prefill?.nonce]);

  // 自动补全状态
  const allItems = useAutoCompleteData(fileTree, workspacePath);
  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [autocompleteItems, setAutocompleteItems] = useState<AutoCompleteItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  /** @ 触发位置（光标在文本中的索引） */
  const triggerPosRef = useRef<number>(-1);

  // 自动调整 textarea 高度
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [value]);

  /** 检测当前光标位置是否处于 @ 触发状态，返回触发关键词 */
  const detectTrigger = useCallback((text: string, cursorPos: number): string | null => {
    // 从光标位置向前查找最近的 @
    let atPos = -1;
    for (let i = cursorPos - 1; i >= 0; i--) {
      const ch = text[i];
      if (ch === '@') {
        atPos = i;
        break;
      }
      // 遇到空格或换行则终止（@ 后不能有空格）
      if (ch === ' ' || ch === '\n' || ch === '\t') break;
    }
    if (atPos === -1) return null;
    // 提取 @ 后的关键词
    const keyword = text.substring(atPos + 1, cursorPos);
    // 关键词中不能有空格
    if (/\s/.test(keyword)) return null;
    triggerPosRef.current = atPos;
    return keyword;
  }, []);

  /** 根据关键词过滤候选项 */
  const filterItems = useCallback((keyword: string): AutoCompleteItem[] => {
    const lower = keyword.toLowerCase();
    let matched = allItems.filter(item =>
      item.label.toLowerCase().startsWith(lower) ||
      item.insertText.toLowerCase().includes(lower) ||
      (item.detail && item.detail.toLowerCase().includes(lower))
    );
    // 去重：表用 库名.表名 区分；文件用完整路径区分；其他按 kind+insertText
    const seen = new Set<string>();
    matched = matched.filter(item => {
      const key = `${item.kind}:${item.insertText}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // 限制最多 50 条
    return matched.slice(0, 50);
  }, [allItems]);

  /** 处理输入变化，检测是否需要弹出自动补全 */
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value;
    const cursorPos = e.target.selectionStart ?? newText.length;
    setValue(newText);

    const keyword = detectTrigger(newText, cursorPos);
    if (keyword !== null) {
      const filtered = filterItems(keyword);
      setAutocompleteItems(filtered);
      setSelectedIndex(0);
      setAutocompleteOpen(true);
    } else {
      setAutocompleteOpen(false);
      triggerPosRef.current = -1;
    }
  }, [detectTrigger, filterItems]);

  /** 选中某个补全项，替换文本中的 @关键词 为补全文本 */
  const handleSelect = useCallback((item: AutoCompleteItem) => {
    const el = textareaRef.current;
    if (!el || triggerPosRef.current < 0) return;
    const before = value.substring(0, triggerPosRef.current);
    const after = value.substring(el.selectionStart ?? value.length);
    const newValue = before + item.insertText + after;
    setValue(newValue);
    setAutocompleteOpen(false);
    triggerPosRef.current = -1;
    // 聚焦并设置光标到插入文本后
    requestAnimationFrame(() => {
      const pos = before.length + item.insertText.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }, [value]);

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    onSend(trimmed);
    setValue('');
    setAutocompleteOpen(false);
  }, [value, busy, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // 自动补全打开时，拦截方向键和回车
    if (autocompleteOpen && autocompleteItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % autocompleteItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + autocompleteItems.length) % autocompleteItems.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSelect(autocompleteItems[selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAutocompleteOpen(false);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [autocompleteOpen, autocompleteItems, selectedIndex, handleSelect, handleSend]);

  return (
    <div className="ai-panel__input-area">
      <div className="ai-panel__input-row">
        <textarea
          ref={textareaRef}
          className="ai-panel__input"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="输入你的问题... (输入 @ 触发库表/文件补全)"
          rows={1}
          disabled={busy}
        />
        {autocompleteOpen && (
          <AutoCompleteDropdown
            items={autocompleteItems}
            selectedIndex={selectedIndex}
            onSelect={handleSelect}
            onHover={setSelectedIndex}
          />
        )}
      </div>
      <div className="ai-panel__input-toolbar">
        <LLMSelector
          models={llmModels}
          selectedId={selectedLLMId}
          onChange={onLLMChange}
          disabled={llmDisabled}
        />
        <select
          className="ai-panel__task-type-select"
          value={taskType}
          onChange={e => onTaskTypeChange(e.target.value)}
          title="任务类型"
        >
          {moduleId === 'data-explore' ? (
            <>
              <option value="DATA_ANALYST">数据分析</option>
              <option value="SUPER_ADMIN">运维管理</option>
            </>
          ) : (
            <>
              <option value="BUSINESS_REQUESTER">需求编写</option>
              <option value="DATA_ARCHITECT">数仓设计</option>
              <option value="DATA_DEV_ENGINEER">数据开发</option>
            </>
          )}
        </select>
        {busy ? (
          <button
            className="ai-panel__btn ai-panel__btn--stop"
            onClick={onInterrupt}
            title="停止生成"
          >
            <StopCircle size={18} />
          </button>
        ) : (
          <button
            className="ai-panel__btn ai-panel__btn--send"
            onClick={handleSend}
            disabled={!value.trim()}
            title="发送"
          >
            <Send size={18} />
          </button>
        )}
      </div>
    </div>
  );
};

export default React.memo(ChatInput);
