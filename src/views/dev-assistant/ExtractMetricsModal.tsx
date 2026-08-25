import React, { useState, useEffect, useCallback } from 'react';
import { X, Lightbulb, Loader2, Trash2, Check } from 'lucide-react';
import type { IndicatorDTO, IndicatorFieldDTO } from '../../api/indicator';
import { parseFieldSource } from '../../utils/extractMetrics';
import './ExtractMetricsModal.css';

/** 将 IndicatorFieldDTO[] 还原为 "A.B:C,D;E.F:G,H" 格式用于展示 */
function fieldsToSourceString(fields: IndicatorFieldDTO[] | undefined): string {
  if (!fields || fields.length === 0) return '';
  const map = new Map<string, string[]>();
  for (const f of fields) {
    const key = `${f.dbName}.${f.tblName}`;
    const list = map.get(key) || [];
    list.push(f.fieldName);
    map.set(key, list);
  }
  return Array.from(map.entries())
    .map(([table, fields]) => `${table}:${fields.join(',')}`)
    .join(';');
}

/** 取该行首个字段的数据源名称作为展示值（规范中指标库表同属一个数据源） */
function getDatasourceName(fields: IndicatorFieldDTO[] | undefined): string {
  return fields && fields.length > 0 ? fields[0].datasourceName : '';
}

interface ExtractMetricsModalProps {
  visible: boolean;
  indicators: IndicatorDTO[];
  onClose: () => void;
  onSubmit: (indicators: IndicatorDTO[]) => Promise<void>;
}

const ExtractMetricsModal: React.FC<ExtractMetricsModalProps> = ({
  visible,
  indicators,
  onClose,
  onSubmit,
}) => {
  const [rows, setRows] = useState<IndicatorDTO[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // 模态框打开时，用传入的指标初始化可编辑副本
  useEffect(() => {
    if (visible) {
      setRows(indicators.map(ind => ({ ...ind })));
      setSubmitting(false);
    }
  }, [visible, indicators]);

  const updateField = (idx: number, field: keyof IndicatorDTO, value: string) => {
    setRows(prev => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
  };

  const removeRow = (idx: number) => {
    setRows(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = useCallback(async () => {
    // 仅提交指标名非空的行
    const valid = rows
      .map(r => ({ ...r, name: r.name?.trim() || '' }))
      .filter(r => r.name);
    if (valid.length === 0) return;
    setSubmitting(true);
    try {
      await onSubmit(valid);
    } finally {
      setSubmitting(false);
    }
  }, [rows, onSubmit]);

  if (!visible) return null;

  return (
    <div className="extract-metrics-modal__overlay" onClick={onClose}>
      <div className="extract-metrics-modal" onClick={e => e.stopPropagation()}>
        <div className="extract-metrics-modal__header">
          <div className="extract-metrics-modal__title">
            <Lightbulb size={16} />
            <span>提取指标确认</span>
          </div>
          <button className="extract-metrics-modal__close" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="extract-metrics-modal__body">
          <div className="extract-metrics-modal__hint">
            已从文档中提取以下指标，请检查无误后提交。共 {rows.length} 个指标。
          </div>
          <div className="extract-metrics-modal__table-wrapper">
            <table className="extract-metrics-modal__table">
              <thead>
                <tr>
                  <th>指标名</th>
                  <th>主题域</th>
                  <th>指标编码</th>
                  <th>业务定义</th>
                  <th>计算表达式</th>
                  <th>过滤条件</th>
                  <th>字段来源</th>
                  <th>数据源</th>
                  <th className="extract-metrics-modal__col-action"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr key={idx}>
                    <td>
                      <input
                        className="extract-metrics-modal__input"
                        value={row.name}
                        onChange={e => updateField(idx, 'name', e.target.value)}
                        placeholder="必填"
                      />
                    </td>
                    <td>
                      <input
                        className="extract-metrics-modal__input"
                        value={row.topic || ''}
                        onChange={e => updateField(idx, 'topic', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="extract-metrics-modal__input"
                        value={row.code || ''}
                        onChange={e => updateField(idx, 'code', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="extract-metrics-modal__input"
                        value={row.businessDefinition || ''}
                        onChange={e => updateField(idx, 'businessDefinition', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="extract-metrics-modal__input"
                        value={row.calcExpr || ''}
                        onChange={e => updateField(idx, 'calcExpr', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="extract-metrics-modal__input"
                        value={row.defaultFilter || ''}
                        onChange={e => updateField(idx, 'defaultFilter', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="extract-metrics-modal__input"
                        value={fieldsToSourceString(row.fields)}
                        onChange={e => {
                          const parsed = parseFieldSource(
                            e.target.value,
                            getDatasourceName(row.fields),
                          );
                          setRows(prev => prev.map((r, i) => (i === idx ? { ...r, fields: parsed } : r)));
                        }}
                        placeholder="库名.表名:字段1,字段2"
                      />
                    </td>
                    <td>
                      <input
                        className="extract-metrics-modal__input"
                        value={getDatasourceName(row.fields)}
                        onChange={e => {
                          const dsName = e.target.value;
                          setRows(prev => prev.map((r, i) => (i === idx
                            ? { ...r, fields: r.fields?.map(f => ({ ...f, datasourceName: dsName })) }
                            : r)));
                        }}
                        placeholder="数据源"
                      />
                    </td>
                    <td className="extract-metrics-modal__col-action">
                      <button
                        className="extract-metrics-modal__row-del"
                        onClick={() => removeRow(idx)}
                        title="删除该行"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="extract-metrics-modal__empty">
                      没有可提交的指标
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="extract-metrics-modal__footer">
          <button
            className="extract-metrics-modal__btn extract-metrics-modal__btn--secondary"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button
            className="extract-metrics-modal__btn extract-metrics-modal__btn--primary"
            onClick={handleSubmit}
            disabled={submitting || rows.length === 0}
          >
            {submitting ? <Loader2 size={14} className="extract-metrics-modal__spin" /> : <Check size={14} />}
            <span>确认提交</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default ExtractMetricsModal;
