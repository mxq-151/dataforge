import React, { useState, useEffect } from 'react';
import { X, Package, Plus, Trash2, RefreshCw, ChevronDown, ChevronRight, Check, Save } from 'lucide-react';
import useDependencyList from '../../hooks/useDependencyList';
import type { DependencyRecord } from '../../api/dependency';
import type { ProjectDependencyItem } from '../../api/projectDependency';
import { useToast } from '../../components/Toast';
import '../../components/editor/ConfigParamsModal.css';

interface ProjectDependencyModalProps {
  visible: boolean;
  onClose: () => void;
  projectId?: number | string;
  /** 当前项目级依赖（用于回填勾选） */
  dependencies?: ProjectDependencyItem[];
  /** 保存回调，deps 为合并后的完整项目级依赖列表 */
  onSave: (deps: ProjectDependencyItem[]) => void;
}

interface DepRow {
  id: string;
  name: string;
  version: string;
  source?: string;
}

const ProjectDependencyModal: React.FC<ProjectDependencyModalProps> = ({
  visible,
  onClose,
  dependencies = [],
  onSave,
}) => {
  const [deps, setDeps] = useState<DepRow[]>([]);
  const [selectedDepIds, setSelectedDepIds] = useState<Set<number>>(new Set());
  const [expandedProgramTypes, setExpandedProgramTypes] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const { groups, records, loading: depLoading, error: depError, fetchDependencies } = useDependencyList();
  const toast = useToast();

  useEffect(() => {
    if (visible) fetchDependencies();
  }, [visible, fetchDependencies]);

  // 打开时回填当前项目级依赖
  useEffect(() => {
    if (!visible) return;
    if (dependencies.length > 0) {
      setDeps(dependencies.map(d => ({ id: d.id, name: d.name, version: d.version, source: d.source })));
    } else {
      setDeps([]);
    }
    setSelectedDepIds(new Set());
  }, [visible, dependencies]);

  // 拉到目录后，根据已选 deps + autoChoose 还原勾选态
  useEffect(() => {
    if (!visible || records.length === 0) return;
    const depNames = new Set(deps.map(d => d.name));
    const matchedIds = records.filter(r => depNames.has(r.artifactId)).map(r => r.id);
    const autoChooseIds = records.filter(r => r.autoChoose === 1).map(r => r.id);
    const allIds = new Set<number>([...matchedIds, ...autoChooseIds]);
    if (allIds.size > 0) setSelectedDepIds(allIds);

    if (autoChooseIds.length > 0) {
      setDeps(prev => {
        const existingNames = new Set(prev.map(d => d.name));
        const next = [...prev];
        records
          .filter(r => r.autoChoose === 1 && !existingNames.has(r.artifactId))
          .forEach(r => {
            next.push({ id: `dep_auto_${r.id}`, name: r.artifactId, version: r.version, source: r.source });
          });
        return next;
      });
    }
  }, [visible, records]);

  useEffect(() => {
    if (!visible || groups.length === 0) return;
    setExpandedProgramTypes(prev => {
      const next = new Set(prev);
      groups.forEach(g => {
        const hasAutoChoose = g.items.some(item => item.autoChoose === 1);
        if (hasAutoChoose) next.add(g.programType);
      });
      return next;
    });
  }, [visible, groups]);

  if (!visible) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleSave = () => {
    setSaving(true);
    try {
      onSave(deps.map(d => ({ id: d.id, name: d.name, version: d.version, source: d.source })));
      toast.info('项目级依赖已保存');
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const toggleProgramType = (programType: string) => {
    setExpandedProgramTypes(prev => {
      const next = new Set(prev);
      if (next.has(programType)) next.delete(programType);
      else next.add(programType);
      return next;
    });
  };

  const toggleSelectDep = (record: DependencyRecord) => {
    if (record.autoChoose === 1) return;
    setSelectedDepIds(prev => {
      const next = new Set(prev);
      if (next.has(record.id)) {
        next.delete(record.id);
        setDeps(d => d.filter(dep => dep.name !== record.artifactId));
      } else {
        next.add(record.id);
        setDeps(d => [
          ...d.filter(dep => dep.name !== record.artifactId),
          { id: `dep_api_${record.id}`, name: record.artifactId, version: record.version, source: record.source },
        ]);
      }
      return next;
    });
  };

  const selectCategoryAll = (items: DependencyRecord[]) => {
    setSelectedDepIds(prev => {
      const next = new Set(prev);
      const newDeps = [...deps];
      items.forEach(item => {
        next.add(item.id);
        if (!newDeps.find(d => d.name === item.artifactId)) {
          newDeps.push({ id: `dep_api_${item.id}`, name: item.artifactId, version: item.version, source: item.source });
        }
      });
      setDeps(newDeps);
      return next;
    });
  };

  const addDependency = () => {
    setDeps(prev => [...prev, { id: `dep_manual_${Date.now()}`, name: '', version: '' }]);
  };

  const removeDependency = (id: string) => {
    setDeps(prev => prev.filter(d => d.id !== id));
    setSelectedDepIds(prev => {
      const next = new Set(prev);
      const rec = records.find(r => `dep_api_${r.id}` === id || `dep_auto_${r.id}` === id);
      if (rec) next.delete(rec.id);
      return next;
    });
  };

  const updateDependency = (id: string, field: 'name' | 'version', val: string) =>
    setDeps(prev => prev.map(d => (d.id === id ? { ...d, [field]: val } : d)));

  return (
    <div className="config-params-overlay" onClick={handleOverlayClick}>
      <div className="config-params-modal">
        <header className="config-params__header">
          <div className="config-params__title">
            <Package size={18} />
            <span>项目依赖配置</span>
          </div>
          <button className="config-params__close" onMouseDown={(e) => { e.preventDefault(); onClose(); }}>
            <X size={16} />
          </button>
        </header>

        <div className="config-params__body">
          <section className="config-params__section">
            <div className="config-params__list-header">
              <span className="config-params__list-title">
                依赖列表
                <span className="config-params__engine-filter-hint">项目级（作用于编译与悬停提示）</span>
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="config-params__add-btn config-params__refresh-btn" onClick={() => fetchDependencies()} disabled={depLoading}>
                  <RefreshCw size={13} className={depLoading ? 'config-params__spinner' : ''} />
                  <span>{depLoading ? '加载中...' : '刷新'}</span>
                </button>
                <button className="config-params__add-btn" onClick={addDependency}>
                  <Plus size={13} />
                  <span>手动添加</span>
                </button>
              </div>
            </div>

            {depError && <div className="config-params__error">{depError}</div>}

            {/* 已选依赖（含手动添加） */}
            {deps.length > 0 && (
              <div className="config-params__kv-list" style={{ marginBottom: 12 }}>
                {deps.map(dep => (
                  <div key={dep.id} className="config-params__kv-row">
                    <input
                      className="config-params__input config-params__input--key"
                      placeholder="依赖坐标(artifactId)"
                      value={dep.name}
                      onChange={e => updateDependency(dep.id, 'name', e.target.value)}
                    />
                    <input
                      className="config-params__input config-params__input--value"
                      placeholder="版本"
                      value={dep.version}
                      onChange={e => updateDependency(dep.id, 'version', e.target.value)}
                    />
                    <button className="config-params__remove-btn" onClick={() => removeDependency(dep.id)}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="config-params__dep-catalog">
              {groups.map(group => (
                <div key={group.programType} className="config-params__cat-group">
                  <button className="config-params__cat-header" onClick={() => toggleProgramType(group.programType)}>
                    {expandedProgramTypes.has(group.programType) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span className="config-params__cat-name">{group.programType}</span>
                    <span className="config-params__cat-count">{group.items.length}</span>
                    <button
                      className="config-params__cat-select-all"
                      onClick={(e) => { e.stopPropagation(); selectCategoryAll(group.items); }}
                    >全选</button>
                  </button>
                  {expandedProgramTypes.has(group.programType) && (
                    <div className="config-params__cat-items">
                      {group.items.map(item => (
                        <label
                          key={item.id}
                          className={`config-params__cat-item ${selectedDepIds.has(item.id) ? 'config-params__cat-item--checked' : ''} ${item.autoChoose === 1 ? 'config-params__cat-item--auto' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={selectedDepIds.has(item.id)}
                            onChange={() => toggleSelectDep(item)}
                            disabled={item.autoChoose === 1}
                          />
                          <div className="config-params__cat-item-info">
                            <span className="config-params__cat-item-name">{item.artifactId}</span>
                            <span className="config-params__cat-item-ver">v{item.version}</span>
                            {item.autoChoose === 1 && <span className="config-params__auto-badge">自动</span>}
                          </div>
                          {selectedDepIds.has(item.id) && <Check size={12} className="config-params__cat-check" />}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {!depLoading && groups.length === 0 && !depError && (
                <div className="config-params__empty">暂无可选依赖，点击刷新按钮获取列表</div>
              )}
            </div>
          </section>
        </div>

        <footer className="config-params__footer">
          <button className="config-params__btn config-params__btn--cancel" onMouseDown={(e) => { e.preventDefault(); onClose(); }}>
            取消
          </button>
          <button
            className="config-params__btn config-params__btn--save"
            onMouseDown={(e) => { e.preventDefault(); handleSave(); }}
            disabled={saving}
          >
            {saving ? <Save size={13} className="config-params__spinner" /> : null}
            <span>{saving ? '保存中...' : '保存'}</span>
          </button>
        </footer>
      </div>
    </div>
  );
};

export default ProjectDependencyModal;
