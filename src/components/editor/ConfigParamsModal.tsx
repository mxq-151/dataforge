import React, { useState, useEffect, useMemo } from 'react';
import { X, Package, Sliders, ClipboardList, Plus, Trash2, RefreshCw, ChevronDown, ChevronRight, Check, Save } from 'lucide-react';
import useDependencyList from '../../hooks/useDependencyList';
import type { DependencyRecord } from '../../api/dependency';
import useDevProjectConfig from '../../hooks/useDevProjectConfig';
import { parseFileHeader, getEngineDefaultTaskParams, validateFileHeader } from '../../utils';
import { useToast } from '../Toast';
import './ConfigParamsModal.css';

type TabKey = 'dependencies' | 'programParams' | 'taskParams';

interface DependencyItem {
  id: string;
  name: string;
  version: string;
  source?: string;
  /** 自定义 jar 相对 basePath 的路径（含文件名），透传到 /params 保存与 --jars 注入 */
  jarPath?: string;
  groupId?: string;
  scope?: string;
  autoChoose?: number | null;
  /** 依赖 jar 的 basePath（后端回填），--jars 路径由 basePath + jarPath 组成 */
  basePath?: string;
}

interface ParamItem {
  id: string;
  key: string;
  value: string;
}

/** 血缘管理保留的任务参数 key（存于 computeResources，提交调度时注入 spark.openlineage.*） */
const LINEAGE_ENABLED_KEY = 'lineage.enabled';

interface LineageConfig {
  enabled: boolean;
}

const isLineageKey = (key: string) => key.startsWith('lineage.');

const extractLineageFromParams = (params: ParamItem[]): LineageConfig => {
  const item = params.find(p => p.key === LINEAGE_ENABLED_KEY);
  return { enabled: item ? item.value !== 'false' : true };
};

/** 合并引擎基础参数与已保存的用户任务参数：基础参数缺失时自动补齐，保留用户自定义与已保存取值 */
const mergeWithBaseParams = (savedUserParams: ParamItem[], engine: string): ParamItem[] => {
  const defaults = getEngineDefaultTaskParams(engine);
  if (!defaults) return savedUserParams;
  const savedKeys = new Set(savedUserParams.map(p => p.key));
  const missingBase = defaults
    .filter(d => !savedKeys.has(d.key))
    .map(d => ({ ...d, id: `eng_${d.id}` }));
  return [...missingBase, ...savedUserParams];
};

interface ConfigParamsModalProps {
  visible: boolean;
  onClose: () => void;
  dependencies?: DependencyItem[];
  programParams?: ParamItem[];
  taskParams?: ParamItem[];
  fileContent?: string;
  filePath?: string;
  rootPath?: string;
  projectId?: number;
  /** 项目编码：血缘命名空间默认值（只读展示） */
  projectCode?: string;
  /** 全局 OpenLineage Transport URL（来自设置页）：血缘 Transport URL 默认值（只读展示） */
  openlineageTransportUrl?: string;
  onSave?: (data: {
    dependencies: DependencyItem[];
    programParams: ParamItem[];
    taskParams: ParamItem[];
  }) => void;
}

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'dependencies', label: '配置依赖', icon: <Package size={14} /> },
  { key: 'programParams', label: '配置程序参数', icon: <Sliders size={14} /> },
  { key: 'taskParams', label: '配置任务参数', icon: <ClipboardList size={14} /> },
];

const ENGINE_TO_PROGRAM_TYPE: Record<string, string> = {
  spark: 'SPARK',
  flink: 'FLINK',
  flink_stream: 'FLINK',
  kyuubi: 'SPARK',
  hive: 'HIVE',
  java: 'JAVA',
  scala: 'SCALA',
  python: 'PYTHON',
  mr: 'MAPREDUCE',
};

const resolveProgramTypeFromFile = (fileContent?: string, filePath?: string): string | undefined => {
  const header = fileContent ? parseFileHeader(fileContent) : null;
  const engine = header?.engine?.trim().toLowerCase() || '';
  if (engine && ENGINE_TO_PROGRAM_TYPE[engine]) {
    return ENGINE_TO_PROGRAM_TYPE[engine];
  }
  if (filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    if (ext === 'scala') return 'SCALA';
    if (ext === 'java') return 'JAVA';
    if (ext === 'py') return 'PYTHON';
  }
  return undefined;
};

const ConfigParamsModal: React.FC<ConfigParamsModalProps> = ({
  visible,
  onClose,
  dependencies = [],
  programParams = [],
  taskParams = [],
  fileContent,
  filePath,
  rootPath,
  projectId,
  projectCode,
  openlineageTransportUrl,
  onSave,
}) => {
  const [activeTab, setActiveTab] = useState<TabKey>('dependencies');
  const [deps, setDeps] = useState<DependencyItem[]>(dependencies);
  const [progParams, setProgParams] = useState<ParamItem[]>(programParams);
  const [taskParamList, setTaskParamList] = useState<ParamItem[]>(taskParams);
  const [lineage, setLineage] = useState<LineageConfig>(() => extractLineageFromParams(taskParams));
  const [expandedProgramTypes, setExpandedProgramTypes] = useState<Set<string>>(new Set());
  const [selectedDepIds, setSelectedDepIds] = useState<Set<number>>(new Set());
  const [engineInfo, setEngineInfo] = useState<{ engine: string; warehouse: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const { groups, records, loading: depLoading, error: depError, fetchDependencies } = useDependencyList();
  const { loading: _configLoading, fetchByFilePath, saveConfig } = useDevProjectConfig();
  const toast = useToast();

  const currentProgramType = useMemo(
    () => resolveProgramTypeFromFile(fileContent, filePath),
    [fileContent, filePath]
  );

  // 普通任务参数列表不展示血缘管理保留项（lineage.*），仅展示用户自定义参数
  const displayTaskParams = useMemo(
    () => taskParamList.filter(p => !isLineageKey(p.key)),
    [taskParamList]
  );

  useEffect(() => {
    if (visible && activeTab === 'dependencies') {
      fetchDependencies();
    }
  }, [visible, activeTab]);

  useEffect(() => {
    if (!visible) return;

    // 每次打开弹窗或切换文件时，先重置为默认（空）状态，避免残留上一文件的配置
    setDeps(dependencies);
    setProgParams(programParams);
    setTaskParamList(taskParams);
    setLineage(extractLineageFromParams(taskParams));
    setSelectedDepIds(new Set());

    const header = fileContent ? parseFileHeader(fileContent) : null;
    const engine = header?.engine || '';
    setEngineInfo(engine ? { engine, warehouse: header?.warehouse || '' } : null);

    if (filePath) {
      const relativePath = rootPath && filePath.startsWith(rootPath)
        ? filePath.slice(rootPath.length).replace(/^\/+/, '')
        : filePath;
      fetchByFilePath(projectId || 1, relativePath).then(loaded => {
        const effectiveEngine = loaded?.engine || engine;
        if (effectiveEngine) setEngineInfo({ engine: effectiveEngine, warehouse: '' });
        // 用当前文件加载结果完全覆盖状态；即使为空数组也覆盖，确保新文件不残留旧文件配置
        setDeps(loaded?.dependencies || []);
        setProgParams(loaded?.programParams || []);
        const savedAll = loaded?.taskParams || [];
        const savedUser = savedAll.filter(p => !isLineageKey(p.key));
        setLineage(extractLineageFromParams(savedAll));
        setTaskParamList(mergeWithBaseParams(savedUser, effectiveEngine));
      });
    } else if (engine) {
      setTaskParamList(mergeWithBaseParams([], engine));
    }
  }, [visible, filePath, fileContent]);

  useEffect(() => {
    if (!visible || records.length === 0) return;

    const depNames = new Set(deps.map(d => d.name));
    const matchedIds = records
      .filter(r => depNames.has(r.artifactId))
      .map(r => r.id);

    const autoChooseIds = records
      .filter(r => r.autoChoose === 1)
      .map(r => r.id);

    const allIds = new Set([...matchedIds, ...autoChooseIds]);
    if (allIds.size > 0) {
      setSelectedDepIds(allIds);
    }

    if (autoChooseIds.length > 0) {
      setDeps(prev => {
        const existingNames = new Set(prev.map(d => d.name));
        const newDeps = [...prev];
        records
          .filter(r => r.autoChoose === 1 && !existingNames.has(r.artifactId))
          .forEach(r => {
            newDeps.push({
              id: `dep_auto_${r.id}`,
              name: r.artifactId,
              version: r.version,
              source: r.source,
              jarPath: r.jarPath,
              groupId: r.groupId,
              scope: r.scope,
              autoChoose: r.autoChoose,
              basePath: r.basePath,
            });
          });
        return newDeps;
      });
    }
  }, [visible, records]);

  useEffect(() => {
    if (!visible || groups.length === 0) return;

    setExpandedProgramTypes(prev => {
      const next = new Set(prev);
      if (currentProgramType) {
        const matchedGroup = groups.find(g =>
          g.programType.toUpperCase() === currentProgramType.toUpperCase()
        );
        if (matchedGroup) {
          next.add(matchedGroup.programType);
        }
      }
      groups.forEach(g => {
        const hasAutoChoose = g.items.some(item => item.autoChoose === 1);
        if (hasAutoChoose) {
          next.add(g.programType);
        }
      });
      return next;
    });
  }, [visible, groups, currentProgramType]);

  if (!visible) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleSave = async () => {
    if (fileContent) {
      const fileName = filePath?.split(/[/\\]/).pop() || '';
      const headerValidation = validateFileHeader(fileContent, fileName);
      if (!headerValidation.valid) {
        toast.error(headerValidation.message);
        return;
      }
    }

    // 将血缘管理配置合并为保留任务参数（lineage.enabled），普通任务参数列表中不展示这些保留项
    const mergedTaskParams: ParamItem[] = [
      ...taskParamList.filter(p => !isLineageKey(p.key)),
      { id: 'lineage_enabled', key: LINEAGE_ENABLED_KEY, value: lineage.enabled ? 'true' : 'false' },
    ];

    if (filePath) {
      setSaving(true);
      const relativePath = rootPath && filePath.startsWith(rootPath)
        ? filePath.slice(rootPath.length).replace(/^\/+/, '')
        : filePath;
      try {
        const ok = await saveConfig(projectId || 1, relativePath, {
          dependencies: deps,
          programParams: progParams,
          taskParams: mergedTaskParams,
          engine: engineInfo?.engine || '',
        });
        if (!ok) {
          toast.error('保存配置失败，请重试');
          return;
        }
      } catch (e) {
        toast.error(`保存配置出错: ${e instanceof Error ? e.message : String(e)}`);
        return;
      } finally {
        setSaving(false);
      }
    }
    onSave?.({ dependencies: deps, programParams: progParams, taskParams: mergedTaskParams });
    onClose();
  };

  const toggleProgramType = (programType: string) => {
    setExpandedProgramTypes(prev => {
      const next = new Set(prev);
      if (next.has(programType)) next.delete(programType); else next.add(programType);
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
        setDeps(d => [...d.filter(dep => dep.name !== record.artifactId), {
          id: `dep_api_${record.id}`,
          name: record.artifactId,
          version: record.version,
          source: record.source,
          jarPath: record.jarPath,
          groupId: record.groupId,
          scope: record.scope,
          autoChoose: record.autoChoose,
          basePath: record.basePath,
        }]);
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
          newDeps.push({ id: `dep_api_${item.id}`, name: item.artifactId, version: item.version, source: item.source, jarPath: item.jarPath, groupId: item.groupId, scope: item.scope, autoChoose: item.autoChoose, basePath: item.basePath });
        }
      });
      setDeps(newDeps);
      return next;
    });
  };

  const addDependency = () => {
    setDeps(prev => [...prev, { id: `dep_manual_${Date.now()}`, name: '', version: '' }]);
  };

  const addProgramParam = () => {
    setProgParams(prev => [...prev, { id: `pp_${Date.now()}`, key: '', value: '' }]);
  };
  const removeProgramParam = (id: string) => setProgParams(prev => prev.filter(p => p.id !== id));
  const updateProgramParam = (id: string, field: 'key' | 'value', val: string) =>
    setProgParams(prev => prev.map(p => p.id === id ? { ...p, [field]: val } : p));

  const addTaskParam = () => setTaskParamList(prev => [...prev, { id: `tp_${Date.now()}`, key: '', value: '' }]);
  const removeTaskParam = (id: string) => setTaskParamList(prev => prev.filter(p => p.id !== id));
  const updateTaskParam = (id: string, field: 'key' | 'value', val: string) =>
    setTaskParamList(prev => prev.map(p => p.id === id ? { ...p, [field]: val } : p));

  const isCurrentEngineGroup = (programType: string) => {
    if (!currentProgramType) return false;
    return programType.toUpperCase() === currentProgramType.toUpperCase();
  };

  const sortedGroups = [...groups].sort((a, b) => {
    const aIsCurrent = isCurrentEngineGroup(a.programType);
    const bIsCurrent = isCurrentEngineGroup(b.programType);
    if (aIsCurrent && !bIsCurrent) return -1;
    if (!aIsCurrent && bIsCurrent) return 1;
    return 0;
  });

  return (
    <div className="config-params-overlay" onClick={handleOverlayClick}>
      <div className="config-params-modal">
        <header className="config-params__header">
          <div className="config-params__title">
            <Sliders size={18} />
            <span>配置参数</span>
          </div>
          <button className="config-params__close" onMouseDown={(e) => { e.preventDefault(); onClose(); }}>
            <X size={16} />
          </button>
        </header>

        <nav className="config-params__tabs">
          {TABS.map(tab => (
            <button
              key={tab.key}
              className={`config-params__tab ${activeTab === tab.key ? 'config-params__tab--active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>

        <div className="config-params__body">
          {activeTab === 'dependencies' && (
            <section className="config-params__section">
              <div className="config-params__list-header">
                <span className="config-params__list-title">
                  依赖列表
                  {currentProgramType && (
                    <span className="config-params__engine-filter-hint">
                      当前引擎: {currentProgramType}
                    </span>
                  )}
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

              {depError && (
                <div className="config-params__error">{depError}</div>
              )}

              <div className="config-params__dep-catalog">
                {sortedGroups.map(group => {
                  const isCurrent = isCurrentEngineGroup(group.programType);
                  const autoChooseCount = group.items.filter(i => i.autoChoose === 1).length;
                  return (
                    <div key={group.programType} className={`config-params__cat-group ${isCurrent ? 'config-params__cat-group--current' : ''}`}>
                      <button className="config-params__cat-header" onClick={() => toggleProgramType(group.programType)}>
                        {expandedProgramTypes.has(group.programType) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <span className="config-params__cat-name">
                          {group.programType}
                          {isCurrent && <span className="config-params__current-badge">当前</span>}
                        </span>
                        <span className="config-params__cat-count">
                          {group.items.length}
                          {autoChooseCount > 0 && <span className="config-params__auto-count">{autoChooseCount}自动</span>}
                        </span>
                        <button
                          className="config-params__cat-select-all"
                          onClick={(e) => { e.stopPropagation(); selectCategoryAll(group.items); }}
                        >全选</button>
                      </button>
                      {expandedProgramTypes.has(group.programType) && (
                        <div className="config-params__cat-items">
                          {group.items.map(item => (
                            <label key={item.id} className={`config-params__cat-item ${selectedDepIds.has(item.id) ? 'config-params__cat-item--checked' : ''} ${item.autoChoose === 1 ? 'config-params__cat-item--auto' : ''}`}>
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
                  );
                })}
                {!depLoading && groups.length === 0 && !depError && (
                  <div className="config-params__empty">暂无可选依赖，点击刷新按钮获取列表</div>
                )}
              </div>
            </section>
          )}

          {activeTab === 'programParams' && (
            <section className="config-params__section">
              <div className="config-params__list-header">
                <span className="config-params__list-title">程序参数</span>
                <button className="config-params__add-btn" onClick={addProgramParam}>
                  <Plus size={13} /><span>添加</span>
                </button>
              </div>
              <div className="config-params__kv-list">
                {progParams.map(param => (
                  <div key={param.id} className="config-params__kv-row">
                    <input className="config-params__input config-params__input--key" placeholder="参数名" value={param.key}
                      onChange={e => updateProgramParam(param.id, 'key', e.target.value)} />
                    <input className="config-params__input config-params__input--value" placeholder="参数值" value={param.value}
                      onChange={e => updateProgramParam(param.id, 'value', e.target.value)} />
                    <button className="config-params__remove-btn" onClick={() => removeProgramParam(param.id)}><Trash2 size={12} /></button>
                  </div>
                ))}
                {progParams.length === 0 && <div className="config-params__empty">暂无程序参数，点击上方按钮添加</div>}
              </div>
            </section>
          )}

          {activeTab === 'taskParams' && (
            <section className="config-params__section">
              <div className="config-params__list-header">
                <span className="config-params__list-title">任务参数</span>
                <button className="config-params__add-btn" onClick={addTaskParam}>
                  <Plus size={13} /><span>添加</span>
                </button>
              </div>

              {engineInfo && (
                <div className="config-params__engine-info">
                  {engineInfo.engine ? (
                    <>
                      <span className="config-params__engine-label">引擎</span>
                      <span className="config-params__engine-value">{engineInfo.engine}</span>
                    </>
                  ) : null}
                  {engineInfo.warehouse ? (
                    <>
                      <span className="config-params__engine-label">数仓</span>
                      <span className="config-params__engine-value">{engineInfo.warehouse}</span>
                    </>
                  ) : null}
                  {!engineInfo.engine && !engineInfo.warehouse && (
                    <span className="config-params__engine-empty">文件头未配置引擎信息</span>
                  )}
                </div>
              )}

              <div className="config-params__lineage">
                <div className="config-params__list-header">
                  <span className="config-params__list-title">血缘管理</span>
                </div>
                <label className="config-params__lineage-row">
                  <input
                    type="checkbox"
                    className="config-params__lineage-switch"
                    checked={lineage.enabled}
                    onChange={e => setLineage(prev => ({ ...prev, enabled: e.target.checked }))}
                  />
                  <span className="config-params__lineage-hint">
                    启用 OpenLineage 血缘采集（提交 Spark 调度任务时注入 spark.openlineage.* 参数）
                  </span>
                </label>
                <div className="config-params__lineage-row">
                  <span className="config-params__lineage-label">命名空间</span>
                  <input
                    className="config-params__input"
                    value={projectCode || ''}
                    readOnly
                    title="命名空间默认使用项目编码，不可修改"
                  />
                </div>
                <div className="config-params__lineage-row">
                  <span className="config-params__lineage-label">Transport URL</span>
                  <input
                    className="config-params__input"
                    value={openlineageTransportUrl || ''}
                    readOnly
                    placeholder="未配置"
                    title="Transport URL 取自设置页面中的 OpenLineage 配置，不可修改"
                  />
                </div>
              </div>

              <div className="config-params__kv-list">
                {displayTaskParams.map(param => (
                  <div key={param.id} className="config-params__kv-row">
                    <input className="config-params__input config-params__input--key" placeholder="参数名" value={param.key}
                      onChange={e => updateTaskParam(param.id, 'key', e.target.value)} />
                    <input className="config-params__input config-params__input--value" placeholder="参数值" value={param.value}
                      onChange={e => updateTaskParam(param.id, 'value', e.target.value)} />
                    <button className="config-params__remove-btn" onClick={() => removeTaskParam(param.id)}><Trash2 size={12} /></button>
                  </div>
                ))}
                {displayTaskParams.length === 0 && <div className="config-params__empty">暂无任务参数，点击上方按钮添加</div>}
              </div>
            </section>
          )}
        </div>

        <footer className="config-params__footer">
          <button
            className="config-params__btn config-params__btn--cancel"
            onMouseDown={(e) => { e.preventDefault(); onClose(); }}
          >
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

export default ConfigParamsModal;
