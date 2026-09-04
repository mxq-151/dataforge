/**
 * 画布自动布局配置弹窗（从 dolphinscheduler-ui 的 dag-auto-layout-modal.tsx 移植，改用 dataforge 的 sm-modal 样式）。
 */
import React from 'react';
import { LayoutGrid, GitBranch } from 'lucide-react';
import { LAYOUT_TYPE } from './useGraphAutoLayout';
import type { LayoutConfig } from './useGraphAutoLayout';

interface DagAutoLayoutModalProps {
  visible: boolean;
  formValue: LayoutConfig;
  onChange: (value: LayoutConfig) => void;
  onConfirm: () => void;
  onClose: () => void;
}

const DagAutoLayoutModal: React.FC<DagAutoLayoutModalProps> = ({
  visible,
  formValue,
  onChange,
  onConfirm,
  onClose,
}) => {
  if (!visible) return null;

  const isGrid = formValue.type === LAYOUT_TYPE.GRID;

  return (
    <div className="sm-modal-overlay" onClick={onClose}>
      <div className="sm-modal sm-modal--layout" onClick={(e) => e.stopPropagation()}>
        <div className="sm-modal__header">
          <LayoutGrid size={18} />
          <span>画布自动布局</span>
        </div>
        <div className="sm-modal__body">
          <div className="sm-modal__field">
            <label>布局类型</label>
            <div className="sm-modal__radio-group">
              <label className="sm-modal__radio">
                <input
                  type="radio"
                  name="layoutType"
                  value={LAYOUT_TYPE.GRID}
                  checked={isGrid}
                  onChange={() => onChange({ ...formValue, type: LAYOUT_TYPE.GRID })}
                />
                <span>网格布局</span>
              </label>
              <label className="sm-modal__radio">
                <input
                  type="radio"
                  name="layoutType"
                  value={LAYOUT_TYPE.DAGRE}
                  checked={formValue.type === LAYOUT_TYPE.DAGRE}
                  onChange={() => onChange({ ...formValue, type: LAYOUT_TYPE.DAGRE })}
                />
                <span>Dagre 布局</span>
              </label>
            </div>
          </div>
          {isGrid ? (
            <>
              <div className="sm-modal__row">
                <div className="sm-modal__field sm-modal__field--half">
                  <label>行数</label>
                  <input
                    type="number"
                    min={0}
                    value={formValue.rows}
                    onChange={(e) =>
                      onChange({ ...formValue, rows: parseInt(e.target.value) || 0 })
                    }
                  />
                </div>
                <div className="sm-modal__field sm-modal__field--half">
                  <label>列数</label>
                  <input
                    type="number"
                    min={0}
                    value={formValue.cols}
                    onChange={(e) =>
                      onChange({ ...formValue, cols: parseInt(e.target.value) || 0 })
                    }
                  />
                </div>
              </div>
              <div className="sm-modal__field">
                <label>间距</label>
                <input
                  type="number"
                  min={0}
                  value={formValue.padding}
                  onChange={(e) =>
                    onChange({ ...formValue, padding: parseInt(e.target.value) || 0 })
                  }
                />
              </div>
            </>
          ) : (
            <div className="sm-modal__row">
              <div className="sm-modal__field sm-modal__field--half">
                <label>层级间距</label>
                <input
                  type="number"
                  min={0}
                  value={formValue.ranksep}
                  onChange={(e) =>
                    onChange({ ...formValue, ranksep: parseInt(e.target.value) || 0 })
                  }
                />
              </div>
              <div className="sm-modal__field sm-modal__field--half">
                <label>节点间距</label>
                <input
                  type="number"
                  min={0}
                  value={formValue.nodesep}
                  onChange={(e) =>
                    onChange({ ...formValue, nodesep: parseInt(e.target.value) || 0 })
                  }
                />
              </div>
            </div>
          )}
          <div className="sm-modal__field">
            <label className="sm-modal__hint">
              <GitBranch size={12} /> 自动布局会重排画布上的所有节点
            </label>
          </div>
        </div>
        <div className="sm-modal__footer">
          <button className="sm-btn sm-btn--secondary" onClick={onClose}>
            取消
          </button>
          <button className="sm-btn sm-btn--primary" onClick={onConfirm}>
            应用
          </button>
        </div>
      </div>
    </div>
  );
};

export default DagAutoLayoutModal;
