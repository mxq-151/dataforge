import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Play, Plus, Sliders, Trash2, Wand2, X } from 'lucide-react';
import {
  createParamRow,
  findDuplicateKeys,
  findRowsMissingKey,
  mergeExtractedKeys,
  paramsFromItems,
  toParamRows,
} from '../../utils/programArgs';
import type { ProgramParamItem } from '../../utils/programArgs';
import './ProgramRunModal.css';

interface ProgramRunModalProps {
  /** 预填的程序参数（取自当前文件「配置参数 → 配置程序参数」），逐行可编辑 */
  defaultParams: ProgramParamItem[];
  /** 从 SQL 正文与代码头 `@程序参数` 识别到的参数名，打开时并成空白行预填 */
  extractedKeys?: string[];
  /** 代码头 `@程序参数` 的声明原文（未声明为空串），用于提示出处 */
  programArgsHint?: string;
  open: boolean;
  /**
   * 用户点「确定」：回传确认后的键值对行（所见即所发），由调用方换算成 runParams。
   * 只影响本次执行，不回写「配置参数」。
   */
  onConfirm: (items: ProgramParamItem[]) => void;
  onCancel: () => void;
}

/**
 * 「运行程序」前的程序运行参数确认框（键值对形式）。
 *
 * 远程执行接口只收键值对（runParams），这里就用键值对逐行编辑，形态与
 * 「配置参数 → 配置程序参数」一致，避免「文本要按什么规矩写」的额外心智负担。
 * 打开时把**代码头 `@程序参数` 声明的与 SQL 正文里的 `${day}` 变量名**并成空白行
 * （见 extractProgramParams），用户不必自己去数；只提取名字不提取取值，取值始终由用户填
 * （时间类参数在调度侧由 DolphinScheduler 用内置时间变量解析）。
 *
 * 两类**会被丢弃/被覆盖**的情况必须显式提示，不能静默：
 *   - 只填了值没填参数名的行（整行被忽略）
 *   - 参数名重复（后出现的取值生效）
 */
export function ProgramRunModal({
  open,
  defaultParams,
  extractedKeys,
  programArgsHint,
  onConfirm,
  onCancel,
}: ProgramRunModalProps) {
  const [rows, setRows] = useState<ProgramParamItem[]>(() => toParamRows(defaultParams));
  /** 需要自动聚焦的行 id：新增行 / 首次打开时用，命中后由 ref 回调消费掉 */
  const focusRowIdRef = useRef<string | null>(null);
  /**
   * 预填值走 ref 读取：复位只发生在「打开」这一刻，不受父组件重渲染的数组 identity 影响
   * （父组件传的是 `?? []`，每次渲染都是新数组，写进依赖会把用户改动抹掉）。
   */
  const defaultsRef = useRef({ defaultParams, extractedKeys });
  defaultsRef.current = { defaultParams, extractedKeys };

  const extracted = extractedKeys ?? [];

  // 每次打开都回到「已保存参数 + 代码识别到的参数名」的预填值，避免上次改了一半的临时内容
  // 泄漏到下一次运行；两者都为空时给一行空白，省得用户要先点「添加参数」
  useEffect(() => {
    if (!open) return;
    const { defaultParams: saved, extractedKeys: keys } = defaultsRef.current;
    const merged = mergeExtractedKeys(toParamRows(saved), keys);
    const next = merged.length > 0 ? merged : [createParamRow()];
    focusRowIdRef.current = next[0].id ?? null;
    setRows(next);
  }, [open]);

  const { count, missingKeyIndexes, duplicateKeys } = useMemo(() => {
    const params = paramsFromItems(rows);
    return {
      count: Object.keys(params).length,
      missingKeyIndexes: findRowsMissingKey(rows),
      duplicateKeys: findDuplicateKeys(rows),
    };
  }, [rows]);

  const warnings = useMemo(() => {
    const list: string[] = [];
    if (missingKeyIndexes.length > 0) {
      list.push(`第 ${missingKeyIndexes.map(i => i + 1).join('、')} 行未填参数名，将被忽略`);
    }
    if (duplicateKeys.length > 0) {
      list.push(`参数名重复：${duplicateKeys.join('、')}（后出现的取值生效）`);
    }
    return list;
  }, [missingKeyIndexes, duplicateKeys]);

  /** 当前行里还缺哪些「代码识别到的参数名」——决定「从代码提取」按钮的可用性 */
  const missingExtractedKeys = useMemo(() => {
    const present = new Set(rows.map(row => (row.key ?? '').trim()).filter(Boolean));
    return extracted.filter(key => !present.has(key));
  }, [rows, extracted]);

  if (!open) return null;

  const updateRow = (id: string | undefined, field: 'key' | 'value', value: string) => {
    setRows(prev => prev.map(row => (row.id === id ? { ...row, [field]: value } : row)));
  };

  const addRow = () => {
    const row = createParamRow();
    focusRowIdRef.current = row.id ?? null;
    setRows(prev => [...prev, row]);
  };

  /** 把代码识别到、当前缺失的参数名补成空白行（用户误删后一键找回） */
  const addExtractedRows = () => {
    if (missingExtractedKeys.length === 0) return;
    setRows(prev => mergeExtractedKeys(prev, extracted));
  };

  const removeRow = (id: string | undefined) => {
    setRows(prev => prev.filter(row => row.id !== id));
  };

  const handleRowKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); onConfirm(rows); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };

  /**
   * 首次打开 / 新增行时把焦点落到目标行的「参数名」输入框。
   * 必须按行 id 比对：ref 回调每次渲染都会重跑，不做比对的话先渲染的行会抢走焦点。
   */
  const captureFocus = (rowId: string | undefined) => (el: HTMLInputElement | null) => {
    if (!el || focusRowIdRef.current !== rowId) return;
    el.focus();
    focusRowIdRef.current = null;
  };

  return (
    <div className="program-run-overlay" onClick={onCancel}>
      <div
        className="program-run-modal"
        role="dialog"
        aria-modal="true"
        aria-label="程序运行参数"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="program-run__header">
          <div className="program-run__title">
            <Sliders size={18} />
            <span>程序运行参数</span>
          </div>
          <button
            className="program-run__close"
            data-testid="program-run-close"
            onMouseDown={(e) => { e.preventDefault(); onCancel(); }}
          >
            <X size={16} />
          </button>
        </header>

        <div className="program-run__body">
          <div className="program-run__list-header">
            <span className="program-run__label">程序参数</span>
            <div className="program-run__list-actions">
              {extracted.length > 0 && (
                <button
                  className="program-run__add-btn"
                  data-testid="program-run-extract"
                  title={`代码中识别到的参数：${extracted.join('、')}`}
                  disabled={missingExtractedKeys.length === 0}
                  onClick={addExtractedRows}
                >
                  <Wand2 size={13} />
                  <span>从代码提取</span>
                </button>
              )}
              <button
                className="program-run__add-btn"
                data-testid="program-run-add"
                onClick={addRow}
              >
                <Plus size={13} />
                <span>添加参数</span>
              </button>
            </div>
          </div>

          <div className="program-run__rows">
            {rows.map((row, index) => (
              <div className="program-run__row" key={row.id}>
                <input
                  className="program-run__input program-run__input--key"
                  data-testid={`program-run-key-${index}`}
                  ref={captureFocus(row.id)}
                  placeholder="参数名"
                  value={row.key}
                  onChange={(e) => updateRow(row.id, 'key', e.target.value)}
                  onKeyDown={handleRowKeyDown}
                  spellCheck={false}
                  autoComplete="off"
                />
                <input
                  className="program-run__input program-run__input--value"
                  data-testid={`program-run-value-${index}`}
                  placeholder="参数值"
                  value={row.value}
                  onChange={(e) => updateRow(row.id, 'value', e.target.value)}
                  onKeyDown={handleRowKeyDown}
                  spellCheck={false}
                  autoComplete="off"
                />
                <button
                  className="program-run__remove"
                  data-testid={`program-run-remove-${index}`}
                  title="删除该参数"
                  onClick={() => removeRow(row.id)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {rows.length === 0 && (
              <div className="program-run__empty">暂无程序参数，点「添加参数」新增</div>
            )}
          </div>

          {extracted.length > 0 && (
            <div className="program-run__source" data-testid="program-run-extracted">
              已识别 {extracted.length} 个程序参数：{extracted.join('、')}
              {programArgsHint ? `（代码头 @程序参数：${programArgsHint}）` : ''}
            </div>
          )}

          <div className="program-run__hint">
            逐行填写参数名与参数值；参数值可留空（按空字符串下发）。未填参数名的行不会下发。
          </div>

          {warnings.length > 0 && (
            <div className="program-run__warning" data-testid="program-run-warning">
              <AlertTriangle size={14} />
              <span>
                {warnings.map((text, i) => (
                  <span className="program-run__warning-line" key={i}>
                    {i > 0 ? '；' : ''}{text}
                  </span>
                ))}
              </span>
            </div>
          )}

          <div className="program-run__status" data-testid="program-run-status">
            {count > 0
              ? `将下发 ${count} 个程序参数`
              : '未填写程序参数，本次执行不附带程序参数'}
          </div>
        </div>

        <footer className="program-run__footer">
          <button
            className="program-run__btn program-run__btn--ghost"
            data-testid="program-run-cancel"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            className="program-run__btn program-run__btn--primary"
            data-testid="program-run-confirm"
            onClick={() => onConfirm(rows)}
          >
            <Play size={14} />
            <span>确定</span>
          </button>
        </footer>
      </div>
    </div>
  );
}

export default ProgramRunModal;
