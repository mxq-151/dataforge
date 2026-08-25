/**
 * AutoCompleteDropdown — 自动补全下拉列表
 *
 * 在输入框上方显示匹配的候选项，支持键盘上下选择和回车确认。
 */

import React, { useRef, useEffect } from 'react';
import { Table2, Columns3, FileText } from 'lucide-react';
import type { AutoCompleteItem } from '../../hooks/opencode/useAutoCompleteData';

interface AutoCompleteDropdownProps {
  items: AutoCompleteItem[];
  selectedIndex: number;
  onSelect: (item: AutoCompleteItem) => void;
  onHover: (index: number) => void;
}

const KIND_ICON = {
  table: Table2,
  column: Columns3,
  file: FileText,
};

const KIND_COLOR = {
  table: '#4ec9b0',
  column: '#9cdcfe',
  file: '#dcdcaa',
};

const AutoCompleteDropdown: React.FC<AutoCompleteDropdownProps> = ({
  items,
  selectedIndex,
  onSelect,
  onHover,
}) => {
  const listRef = useRef<HTMLDivElement>(null);

  // 滚动到选中项
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (items.length === 0) {
    return (
      <div className="ai-panel__autocomplete ai-panel__autocomplete--empty">
        <span>无匹配项</span>
      </div>
    );
  }

  return (
    <div className="ai-panel__autocomplete" ref={listRef}>
      {items.map((item, index) => {
        const Icon = KIND_ICON[item.kind];
        const color = KIND_COLOR[item.kind];
        return (
          <div
            key={`${item.kind}-${item.label}-${index}`}
            className={`ai-panel__autocomplete-item ${index === selectedIndex ? 'ai-panel__autocomplete-item--active' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); onSelect(item); }}
            onMouseEnter={() => onHover(index)}
          >
            <Icon size={12} style={{ color, flexShrink: 0 }} />
            <span className="ai-panel__autocomplete-label" style={{ color }}>
              {item.label}
            </span>
            {item.detail && (
              <span className="ai-panel__autocomplete-detail">
                {item.detail}
              </span>
            )}
            <span className="ai-panel__autocomplete-kind">
              {item.kind === 'table' ? '表' : item.kind === 'column' ? '列' : '文件'}
            </span>
          </div>
        );
      })}
    </div>
  );
};

export default React.memo(AutoCompleteDropdown);
