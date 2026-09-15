import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { X, Package, Sliders, ClipboardList, Plus, Trash2, RefreshCw, ChevronDown, ChevronRight, Check, Save, Files } from 'lucide-react';
import useDependencyList from '../../hooks/useDependencyList';
import type { DependencyRecord } from '../../api/dependency';
import useDevProjectConfig from '../../hooks/useDevProjectConfig';
import { parseFileHeader, validateFileHeader } from '../../utils/fileHeader';
import { getEngineDefaultTaskParams } from '../../utils/programArgs';
// 血缘保留参数的 key 前缀 / 开关名 / 判别函数唯一定义在这里，与提交侧（注入 spark.openlineage.*）
// 共用同一份，避免两边各写一份写法走岔
import { LINEAGE_ENABLED_KEY, isLineageParamKey as isLineageKey } from '../../utils/lineageParams';
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

interface LineageConfig {
  enabled: boolean;
}

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
  /**
   * 保存成功后的回调。单文件模式不带第二参；批量模式逐文件回调，
   * 第二参为该次保存对应的文件绝对路径（供父组件按路径刷新内存态配置）。
   */
  onSave?: (data: {
    dependencies: DependencyItem[];
    programParams: ParamItem[];
    taskParams: ParamItem[];
  }, filePath?: string) => void;
  /**
   * 批量模式：把弹窗里这一份配置原样写入这些文件。
   *
   * 由「文件浏览器 → 右键文件夹 → 配置参数」传入该文件夹下的全部代码文件，
   * 因此这些文件最终拿到完全相同的依赖 / 程序参数 / 任务参数。
   *
   * 非空即进入批量模式，与单文件的差异有三：
   * 1. 不读取任何目标文件已有的配置做回填，一律从空配置起步
   *    （否则会退化成「用第一个文件的配置覆盖其余文件」）；
   * 2. 弹窗内列出全部目标文件（展示为「项目编码 / 项目目录相对路径」），**默认全选**，
   *    用户可逐个取消勾选，**未勾选的文件不会被写入**；
   * 3. 保存时只对「已勾选」的文件逐个 upsert，而不是只写 filePath 指向的那一个。
   */
  targetPaths?: string[];
  /**
   * 批量模式下读取文件内容，用于按代码头（@引擎）逐文件推断引擎。
   *
   * 引擎决定依赖的 programType（后端 @NotBlank）与任务参数的默认值，
   * 同一文件夹下可能存在不同引擎的代码文件（如 .sql 与 .py），
   * 故必须逐文件解析而非取单一值。缺省时引擎按空处理。
   */
  readFileContent?: (filePath: string) => Promise<string>;
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

/**
 * 文件相对**项目目录**（rootPath）的路径。
 *
 * 与 handleSave 里的落库路径是同一段逻辑（抽出来复用），保证两者口径一致：
 * 列表展示在此基础上再加一级项目编码，见 toDisplayFilePath。
 * rootPath 未提供、或文件不在 rootPath 下时原样返回。
 */
const toProjectRelativePath = (filePath: string, rootPath?: string): string => {
  if (rootPath && filePath.startsWith(rootPath)) {
    const rest = filePath.slice(rootPath.length).replace(/^[/\\]+/, '');
    // 文件恰好就是项目目录自身时退化，不做无意义的空串展示
    if (rest) return rest;
  }
  return filePath;
};

/**
 * 目标文件列表里的展示路径：`{项目编码}/{项目根目录相对路径}`。
 *
 * 为什么补上项目编码这一段：文件浏览器的根目录是**首包目录** `code/{pc}/src/{pc}`，
 * 而仓库视角（git 工作树 `{repoRoot}/{projectCode}` 即软链到该目录）下文件的全路径
 * 正是从项目编码开始。补上这一级便于一眼看出文件归属。
 *
 * 注意这只是**展示**口径：落库仍用 toProjectRelativePath（DB 行本身带 projectId，
 * 不重复携带项目编码），与既有单文件入口的存储口径保持一致。
 */
const toDisplayFilePath = (
  filePath: string,
  rootPath?: string,
  projectCode?: string
): string => {
  const relative = toProjectRelativePath(filePath, rootPath);
  const pc = projectCode?.trim().replace(/[/\\]+$/, '');
  if (!pc || relative === filePath) return relative;
  return `${pc}/${relative}`;
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
  targetPaths,
  readFileContent,
}) => {
  // 批量目标：仅用 memo 稳定引用，实际依赖用 batchKey（路径集合的字符串指纹），
  // 避免父组件每次渲染传入新数组导致 effect 反复触发
  const batchTargets = useMemo(
    () => (targetPaths && targetPaths.length > 0 ? targetPaths : []),
    [targetPaths]
  );
  const isBatch = batchTargets.length > 0;
  const batchKey = useMemo(() => batchTargets.join('|'), [batchTargets]);
  // 批量模式下逐文件解析出的引擎，下标与 batchTargets 对齐；保存时随各文件写入
  const [batchEngines, setBatchEngines] = useState<string[]>([]);
  // 批量目标的选择态：默认全选，未勾选的文件不参与保存。
  // 这里存「被取消勾选的文件」而非「被选中的文件」——默认态天然就是全选，
  // 也无需在目标集合变化时做初始化数组。弹窗每次打开都会重新挂载，状态不会残留。
  const [excludedBatchPaths, setExcludedBatchPaths] = useState<Set<string>>(new Set());
  // 由引擎默认值补齐（而非用户手填）的任务参数键。
  // 选择变化会重新推导引擎，推导前先摘掉这些键，避免混引擎文件夹里
  // A 引擎的默认值残留在 B 引擎的配置中；用户手填的参数不受影响。
  const injectedBatchKeysRef = useRef<Set<string>>(new Set());
  // 单文件配置拉取的序号：用于丢弃过期响应，见下方加载 effect
  const loadSeqRef = useRef(0);
  const selectedBatchTargets = useMemo(
    () => batchTargets.filter(p => !excludedBatchPaths.has(p)),
    [batchTargets, excludedBatchPaths]
  );
  const selectedBatchSet = useMemo(() => new Set(selectedBatchTargets), [selectedBatchTargets]);
  const selectedBatchCount = selectedBatchTargets.length;
  const allBatchSelected = selectedBatchCount === batchTargets.length;
  // 已勾选目标在 batchTargets 中的下标（batchEngines 与之对齐），作为推导引擎的稳定依赖
  const selectedBatchIdxKey = useMemo(
    () => batchTargets.map((p, i) => (selectedBatchSet.has(p) ? i : -1)).filter(i => i >= 0).join(','),
    [batchTargets, selectedBatchSet]
  );
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

  // 依赖列表的「当前引擎」：单文件模式由文件内容/扩展名推断；
  // 批量模式没有单一文件，改用「全部目标引擎一致」时解析出的引擎（不一致时为 undefined）
  const currentProgramType = useMemo(() => {
    if (isBatch) {
      const eng = engineInfo?.engine?.trim().toLowerCase() || '';
      return eng ? ENGINE_TO_PROGRAM_TYPE[eng] : undefined;
    }
    return resolveProgramTypeFromFile(fileContent, filePath);
  }, [fileContent, filePath, isBatch, engineInfo]);

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
    // 每次拉取分配一个递增序号；响应回来时用它判断自己是否仍是最新的那一次。
    // 避免「先打开的文件响应更慢」——旧响应晚到会把后打开文件的配置覆盖掉
    // （现象就是弹窗内容不刷新/显示成上一个文件的配置）。
    // 关闭弹窗或 filePath/fileContent 变化都会让在途请求立即失效。
    const seq = ++loadSeqRef.current;
    if (!visible) return;

    // 每次打开弹窗或切换文件时，先重置为默认（空）状态，避免残留上一文件的配置
    setDeps(dependencies);
    setProgParams(programParams);
    setTaskParamList(taskParams);
    setLineage(extractLineageFromParams(taskParams));
    setSelectedDepIds(new Set());

    // 批量模式（文件夹右键 → 其下全部代码文件）：不回填任何目标文件的既有配置，
    // 一律从空配置起步，用户在这里填的这一份会被原样下发到每个目标文件。
    // 引擎改为在批量 effect 中逐文件解析，此处不设。
    if (isBatch) {
      setEngineInfo(null);
      return;
    }

    const header = fileContent ? parseFileHeader(fileContent) : null;
    const engine = header?.engine || '';
    setEngineInfo(engine ? { engine, warehouse: header?.warehouse || '' } : null);

    if (filePath) {
      const relativePath = rootPath && filePath.startsWith(rootPath)
        ? filePath.slice(rootPath.length).replace(/^\/+/, '')
        : filePath;
      fetchByFilePath(projectId || 1, relativePath).then(loaded => {
        // 已被更新的拉取（换文件 / 重新打开 / 关闭）取代，丢弃这次结果
        if (seq !== loadSeqRef.current) return;
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
  }, [visible, filePath, fileContent, isBatch]);

  // 批量模式：并发读取**全部**目标文件的代码头，解析各自引擎。
  // 引擎决定依赖的 programType（后端 @NotBlank），必须逐文件准确，保存时按 batchEngines 逐个写入。
  // 这里刻意读全量而不是只读已勾选的：用户可能重新勾回来，避免再次触发 IO。
  useEffect(() => {
    if (!visible || !isBatch) return;

    if (!readFileContent) {
      setBatchEngines(batchTargets.map(() => ''));
      return;
    }

    let cancelled = false;
    Promise.all(
      batchTargets.map(async p => {
        try {
          const content = await readFileContent(p);
          return parseFileHeader(content)?.engine?.trim().toLowerCase() || '';
        } catch {
          return '';
        }
      })
    ).then(engines => {
      if (cancelled) return;
      setBatchEngines(engines);
    });

    return () => { cancelled = true; };
    // batchKey 是 batchTargets 的稳定指纹
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, isBatch, batchKey, readFileContent]);

  // 批量模式：按**当前已勾选**的目标推导统一引擎。
  // 未勾选的文件不会被写入，让它们参与推导反而可能把别的引擎的默认参数带进来。
  // 仅当已勾选目标的引擎完全一致时才补齐该引擎的默认任务参数并展示引擎。
  useEffect(() => {
    if (!visible || !isBatch || batchEngines.length !== batchTargets.length) return;

    const engines = selectedBatchIdxKey
      ? selectedBatchIdxKey.split(',').map(i => batchEngines[Number(i)] || '')
      : [];
    const first = engines[0] || '';
    const uniform = !!first && engines.every(e => e === first);

    setEngineInfo(uniform ? { engine: first, warehouse: '' } : null);
    setTaskParamList(prev => {
      const injected = injectedBatchKeysRef.current;
      const userParams = prev.filter(p => !isLineageKey(p.key) && !injected.has(p.key));
      if (!uniform) {
        // 多引擎 / 无引擎 / 一个都没勾：不套用任何引擎的默认参数
        injectedBatchKeysRef.current = new Set();
        return userParams;
      }
      const merged = mergeWithBaseParams(userParams, first);
      const userKeys = new Set(userParams.map(p => p.key));
      injectedBatchKeysRef.current = new Set(
        merged.filter(p => !userKeys.has(p.key)).map(p => p.key)
      );
      return merged;
    });
  }, [visible, isBatch, batchEngines, batchTargets, selectedBatchIdxKey]);

  /** 勾选 / 取消勾选单个目标文件 */
  const toggleBatchTarget = useCallback((filePath: string) => {
    setExcludedBatchPaths(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  }, []);

  /** 全选 / 全不选 */
  const toggleAllBatchTargets = useCallback(() => {
    setExcludedBatchPaths(prev =>
      prev.size === 0 ? new Set(batchTargets) : new Set()
    );
  }, [batchTargets]);

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
    // 批量模式没有「当前文件」概念，无法对单一文件做代码头规范校验，
    // 各目标文件的合规性由其后各自的编译/提交流程把关
    if (fileContent && !isBatch) {
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
    const payload = {
      dependencies: deps,
      programParams: progParams,
      taskParams: mergedTaskParams,
    };

    // 批量模式：只写「已勾选」的目标文件；单文件模式：只写 filePath
    if (isBatch && selectedBatchCount === 0) {
      toast.error('请至少勾选一个目标文件');
      return;
    }
    const saveTargets = isBatch ? selectedBatchTargets : (filePath ? [filePath] : []);
    // batchEngines 与 batchTargets 下标对齐，按路径取各文件自己的引擎
    const engineByPath = new Map(batchTargets.map((p, i) => [p, batchEngines[i] || '']));

    if (saveTargets.length > 0) {
      setSaving(true);
      const failed: string[] = [];
      try {
        for (const target of saveTargets) {
          const relativePath = toProjectRelativePath(target, rootPath);
          // 批量模式逐文件写各自解析出的引擎；单文件模式沿用当前文件解析/回填的引擎
          const engine = isBatch ? (engineByPath.get(target) || '') : (engineInfo?.engine || '');
          const ok = await saveConfig(projectId || 1, relativePath, { ...payload, engine });
          if (ok) {
            onSave?.(payload, target);
          } else {
            failed.push(target.split(/[/\\]/).pop() || target);
          }
        }
      } catch (e) {
        toast.error(`保存配置出错: ${e instanceof Error ? e.message : String(e)}`);
        return;
      } finally {
        setSaving(false);
      }

      if (failed.length > 0) {
        // 保留弹窗便于重试；已成功的文件走的是幂等 upsert，重试不会产生副作用
        toast.error(isBatch ? `保存配置失败：${failed.join('、')}` : '保存配置失败，请重试');
        return;
      }
      if (isBatch) {
        toast.info(`已为 ${saveTargets.length} 个代码文件保存配置`);
      }    } else {
      onSave?.(payload);
    }

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
            {isBatch && (
              <span className="config-params__batch-badge">
                {allBatchSelected
                  ? `${batchTargets.length} 个文件`
                  : `已选 ${selectedBatchCount} / ${batchTargets.length}`}
              </span>
            )}
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
          {isBatch && (
            <div className="config-params__batch-hint">
              <Files size={14} />
              <div className="config-params__batch-hint-text">
                <span>
                  当前为<strong>批量配置</strong>：保存后下面这一份依赖 / 程序参数 / 任务参数
                  将<strong>原样写入已勾选的 {selectedBatchCount} 个代码文件</strong>，
                  各文件此前的参数会被覆盖；<strong>未勾选的文件不会被改动</strong>。
                </span>
                <div className="config-params__batch-file-panel">
                  <label className="config-params__batch-select-all">
                    <input
                      type="checkbox"
                      checked={allBatchSelected}
                      ref={el => {
                        // 部分勾选时呈现「半选」态，提示点一下会全选
                        if (el) el.indeterminate = !allBatchSelected && selectedBatchCount > 0;
                      }}
                      onChange={toggleAllBatchTargets}
                    />
                    <span>
                      全选（已选 {selectedBatchCount} / {batchTargets.length}）
                    </span>
                  </label>
                  <ul className="config-params__batch-file-list">
                    {batchTargets.map(p => (
                      <li key={p}>
                        <label
                          className="config-params__batch-file-item"
                          title={toDisplayFilePath(p, rootPath, projectCode)}
                        >
                          <input
                            type="checkbox"
                            checked={!excludedBatchPaths.has(p)}
                            onChange={() => toggleBatchTarget(p)}
                          />
                          <span>{toDisplayFilePath(p, rootPath, projectCode)}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}
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
                    启用 OpenLineage 血缘采集（仅生产环境提交 Spark 调度任务时注入 spark.openlineage.* 参数；灰度 / 测试环境不注入）
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
            disabled={saving || (isBatch && selectedBatchCount === 0)}
            title={isBatch && selectedBatchCount === 0 ? '请至少勾选一个目标文件' : undefined}
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
