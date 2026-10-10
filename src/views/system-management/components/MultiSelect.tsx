import { useState, useRef, useEffect } from 'react';
import { ChevronDown, X, Search } from 'lucide-react';

export interface MultiSelectOption<TValue extends string | number = string | number> {
  value: TValue;
  label: string;
  tag?: string;
  tagColor?: string;
}

interface MultiSelectProps<TValue extends string | number> {
  options: MultiSelectOption<TValue>[];
  selectedValues: TValue[];
  onChange: (values: TValue[]) => void;
  placeholder?: string;
  /** 面板顶部显示「全选 / 清空」。全选只作用于当前搜索过滤后的选项。 */
  enableSelectAll?: boolean;
  /** 禁用后不可展开、不可修改，仅展示已选内容（用于「整库授权」等由其它控件接管选择的场景）。 */
  disabled?: boolean;
}

function MultiSelect<TValue extends string | number = number>(
  {
    options,
    selectedValues,
    onChange,
    placeholder = '请选择',
    enableSelectAll = false,
    disabled = false,
  }: MultiSelectProps<TValue>
) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    };
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  useEffect(() => {
    if (disabled && open) {
      setOpen(false);
      setSearch('');
    }
  }, [disabled, open]);

  const selectedOptions = options.filter(o => selectedValues.includes(o.value));
  const filteredOptions = search
    ? options.filter(o => o.label.toLowerCase().includes(search.toLowerCase()) || o.tag?.toLowerCase().includes(search.toLowerCase()))
    : options;

  const handleToggle = (value: TValue) => {
    if (selectedValues.includes(value)) {
      onChange(selectedValues.filter(v => v !== value));
    } else {
      onChange([...selectedValues, value]);
    }
  };

  const handleRemove = (value: TValue, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(selectedValues.filter(v => v !== value));
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onChange([]);
  };

  /** 全选当前可见（搜索过滤后）的选项；已选项的顺序保持不变，新选项按列表顺序追加。 */
  const handleSelectAll = () => {
    const merged = [...selectedValues];
    for (const opt of filteredOptions) {
      if (!merged.includes(opt.value)) merged.push(opt.value);
    }
    onChange(merged);
  };

  // 保持既有行为：非禁用时即使没有可选项也可展开（内部展示「无匹配项」）
  const expandable = !disabled;

  return (
    <div className="sys-mgmt__multi-select" ref={containerRef}>
      <div
        className={`sys-mgmt__multi-select__control${disabled ? ' sys-mgmt__multi-select__control--disabled' : ''}`}
        onClick={() => { if (expandable) setOpen(!open); }}
      >
        <div className="sys-mgmt__multi-select__tags">
          {selectedOptions.length === 0 ? (
            <span className="sys-mgmt__multi-select__placeholder">{placeholder}</span>
          ) : (
            selectedOptions.map(opt => (
              <span key={opt.value} className="sys-mgmt__multi-select__tag">
                {opt.label}
                {!disabled && (
                  <button className="sys-mgmt__multi-select__tag-remove" onClick={e => handleRemove(opt.value, e)}>
                    <X size={10} />
                  </button>
                )}
              </span>
            ))
          )}
        </div>
        <div className="sys-mgmt__multi-select__actions">
          {!disabled && selectedValues.length > 0 && (
            <button className="sys-mgmt__multi-select__clear" onClick={handleClear}>
              <X size={12} />
            </button>
          )}
          {expandable && (
            <ChevronDown size={14} className={`sys-mgmt__multi-select__arrow ${open ? 'sys-mgmt__multi-select__arrow--open' : ''}`} />
          )}
        </div>
      </div>
      {open && expandable && (
        <div className="sys-mgmt__multi-select__dropdown">
          <div className="sys-mgmt__multi-select__search">
            <Search size={12} />
            <input
              className="sys-mgmt__multi-select__search-input"
              placeholder="搜索..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              autoFocus
            />
          </div>
          {enableSelectAll && (
            <div className="sys-mgmt__multi-select__bulk">
              <button
                type="button"
                className="sys-mgmt__multi-select__bulk-btn"
                onClick={handleSelectAll}
                disabled={filteredOptions.length === 0}
              >
                {search ? '全选筛选结果' : '全选'}
              </button>
              <button
                type="button"
                className="sys-mgmt__multi-select__bulk-btn"
                onClick={() => onChange([])}
                disabled={selectedValues.length === 0}
              >
                清空
              </button>
              <span className="sys-mgmt__multi-select__bulk-count">已选 {selectedValues.length} / {options.length}</span>
            </div>
          )}
          <div className="sys-mgmt__multi-select__options">
            {filteredOptions.length === 0 ? (
              <div className="sys-mgmt__multi-select__empty">无匹配项</div>
            ) : (
              filteredOptions.map(opt => (
                <label key={opt.value} className={`sys-mgmt__multi-select__option ${selectedValues.includes(opt.value) ? 'sys-mgmt__multi-select__option--selected' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selectedValues.includes(opt.value)}
                    onChange={() => handleToggle(opt.value)}
                  />
                  <span className="sys-mgmt__multi-select__option-label">{opt.label}</span>
                  {opt.tag && <span className="sys-mgmt__tag" style={{ marginLeft: 'auto', fontSize: 10, color: opt.tagColor }}>{opt.tag}</span>}
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default MultiSelect;
