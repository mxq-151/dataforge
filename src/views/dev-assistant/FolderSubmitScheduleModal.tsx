import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Loader2, AlertTriangle, Info, RefreshCw, Send, FolderKanban } from 'lucide-react';
import type {
  DolphinSchedulerApi, DSProject, DSWorkerGroup, DSEnvironment,
} from '../../types/dolphinscheduler';
import { ReleaseState, ExecutionType, type DSWorkflowGlobalParam, type DSWorkflowTaskNode, type DSWorkflowEdge } from '../../types/dolphinscheduler';
import WorkflowDefinitionEditor from '../schedule-management/components/WorkflowDefinitionEditor';
import {
  buildWorkflowFromFolder, sanitizeDsName, isCompilableFile, buildTaskNameToFilePathMap,
  reconcileWorkflowDependencies, layoutWorkflowByDependency, findDependencyCycle,
  deriveFolderWorkflowName,
  GRID_START_X, GRID_START_Y, GRID_GAP_X, GRID_GAP_Y,
  type BuildWorkflowFromFolderResult, type ResolvedDependency, type HeaderDependency,
} from '../../utils/schedulerMapping';
import { toRelativePath, splitPath } from '../../utils/pathUtils';
import { unifiedCompile, type CompileConfig } from '../../services/unifiedCompile';
import { readFile } from '../../bridge/fs';
import { useToast } from '../../components/Toast';
import useDevProjectConfig from '../../hooks/useDevProjectConfig';
import DeployEnvRadio from './DeployEnvRadio';
import { DEFAULT_DEPLOY_ENV, shouldInjectLineage, withDeployEnvSuffix, type DeployEnv } from '../../utils/deployEnv';
import { buildOpenLineageArgs, extractLineageParams } from '../../utils/lineageParams';
import { applyAppNameToNodes } from '../../utils/appName';
// 内嵌的是调度模块的工作流定义编辑器，它复用了该模块的 sm-* 基础样式
// （保存工作流弹窗 sm-modal / 按钮 sm-btn 等，定义在 ScheduleManagementPanel.css 中）。
// 开发助手视图不在调度模块的样式链路里，这里显式引入，否则保存弹窗会失去样式。
import '../schedule-management/ScheduleManagementPanel.css';
import './FolderSubmitScheduleModal.css';

/** 工作流定义编辑器 onSave 的载荷（与 WorkflowDefinitionEditorProps.onSave 对齐） */
interface WorkflowSavePayload {
  name: string;
  description: string;
  executionType: ExecutionType;
  timeout: number;
  globalParams: DSWorkflowGlobalParam[];
  nodes: DSWorkflowTaskNode[];
  edges: DSWorkflowEdge[];
  release: boolean;
}

export interface FolderSubmitScheduleModalProps {
  visible: boolean;
  /** 右键的文件夹绝对路径 */
  folderPath: string;
  /** 该文件夹下全部代码文件绝对路径（由 ExplorerPanel 递归收集，与「配置参数」同源） */
  codeFilePaths: string[];
  /** 项目目录（首包目录），用于推导项目内相对路径 */
  rootPath?: string;
  /** 项目编码：同时作为调度项目名称用于匹配 DS 项目 */
  projectCode?: string;
  /** 读取文件内容（逐文件解析代码头以生成任务节点；编译阶段也用于读取最新磁盘内容） */
  readFileContent?: (filePath: string) => Promise<string>;
  /** 调度 API；为 null 表示调度系统不可用 */
  dsApi: DolphinSchedulerApi | null;
  /** 是否为真实调度环境（仅用于界面提示） */
  isRealApi?: boolean;
  /** 编译环境配置：保存前对 Java/Scala 代码文件编译生成主 Jar 包（与单文件提交调度一致） */
  compileConfig?: CompileConfig | null;
  /** 开发项目 ID：编译时用于按文件拉取依赖配置（unifiedCompile.projectId），
   *  生产环境提交时也用它按文件读取血缘配置（lineage.*） */
  devProjectId?: number;
  /** 全局 OpenLineage Transport URL（来自设置页）：生产环境提交时注入 spark.openlineage.transport.url */
  openlineageTransportUrl?: string;
  /** 提交成功后的回调（携带工作流名称），供父组件刷新等 */
  onSuccess?: (workflowName: string) => void;
  onClose: () => void;
}

type DraftPhase = 'loading' | 'ready' | 'error';

interface EditorMeta {
  workflowDefinitions?: { code: number; name: string }[];
  workerGroups?: DSWorkerGroup[];
  environments?: DSEnvironment[];
}

/** 安全解析任务参数 JSON（非法/空时回退空对象），回填 mainJar 前调用 */
function safeParseTaskParams(taskParams: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(taskParams || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** @依赖 声明的展示/索引 label：{调度项目}.{任务名}（无项目时仅任务名） */
function depLabelOf(dep: { projectCode?: string; taskName: string }): string {
  return [dep.projectCode, dep.taskName].filter(Boolean).join('.');
}

/**
 * 为一次依赖重建（reconcileWorkflowDependencies）准备 code / 网格槽位分配器。
 * 新节点 code 从现有最大 code + 1 递增；槽位沿用现有节点数之后的序号，
 * 保证新生成的「前置依赖」节点不会与已有节点坐标重叠。
 */
function makeReconcileAllocators(nodes: DSWorkflowTaskNode[]): {
  allocateCode: () => number;
  nextSlot: () => { x: number; y: number };
} {
  let nextCode = (nodes.length ? Math.max(...nodes.map(n => n.code)) : 0) + 1;
  const usedSlots = new Set<number>(nodes.map((_, i) => i));
  let slotCursor = nodes.length;
  return {
    allocateCode: () => nextCode++,
    nextSlot: () => {
      while (usedSlots.has(slotCursor)) slotCursor++;
      const slot = slotCursor;
      usedSlots.add(slot);
      slotCursor++;
      return {
        x: GRID_START_X + (slot % 3) * GRID_GAP_X,
        y: GRID_START_Y + Math.floor(slot / 3) * GRID_GAP_Y,
      };
    },
  };
}

/** 文件的项目内相对目录（与 mapCodeFileToTask 里 dirPath 的口径一致） */
function dirPathOf(filePath: string, rootPath?: string): string {
  const rel = rootPath ? toRelativePath(filePath, rootPath) : filePath;
  const lastSlash = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'));
  return lastSlash <= 0 ? '' : rel.substring(0, lastSlash);
}

interface UploadJarOptions {
  dsApi: DolphinSchedulerApi;
  projectCode?: string;
  /** 文件的项目内相对目录（用于组织资源中心目录层级） */
  dirPath: string;
  /** 本地编译产物 jar 的绝对路径 */
  jarPath: string;
  /** 源文件名（含扩展名），用于生成上传文件名 */
  fileName: string;
}

/**
 * 把编译产物 jar 上传到调度资源中心，返回资源路径（供回填 mainJar）。
 * 目录层级与单文件提交调度一致：{baseDir}/{projectCode}/{dirPath...}/{fileName}_{timestamp}.jar。
 * 失败返回 null（由调用方汇总为「编译成功但上传失败」）。
 */
async function uploadJarToResource(opts: UploadJarOptions): Promise<string | null> {
  try {
    const jarUint8Array = await readFile(opts.jarPath);
    // readFile 返回 Uint8Array<ArrayBufferLike>，复制一份保证底层为 ArrayBuffer，才能进 Blob
    const jarBytes = new Uint8Array(jarUint8Array);
    const jarBlob = new Blob([jarBytes], { type: 'application/java-archive' });

    const codeFileBaseName = opts.fileName.replace(/\.[^.]+$/, '');
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const uploadFileName = `${codeFileBaseName}_${ts}.jar`;

    let baseDir = '/';
    try {
      const baseDirRes = await opts.dsApi.resource.queryBaseDir('FILE');
      if (baseDirRes.code === 0 && baseDirRes.data) baseDir = baseDirRes.data;
    } catch { /* 用默认根目录 */ }

    const dirSegments: string[] = [];
    if (opts.projectCode) dirSegments.push(opts.projectCode);
    if (opts.dirPath) dirSegments.push(...splitPath(opts.dirPath));

    const currentDir = baseDir;
    const p = `/${dirSegments.join('/')}`;
    try {
      await opts.dsApi.resource.createDir({
        type: 'FILE',
        name: p,
        currentDir,
        description: `Auto-created for project ${opts.projectCode || ''}`,
      });
    } catch (e) {
      console.log('[FolderSubmitScheduleModal] Directory may already exist:', p, e);
    }

    const jarFile = new File([jarBlob], uploadFileName, { type: 'application/java-archive' });
    const uploadRes = await opts.dsApi.resource.upload({
      type: 'FILE',
      name: uploadFileName,
      file: jarFile,
      currentDir: currentDir + p,
    });

    if (uploadRes.code === 0) {
      const segs: string[] = [];
      if (opts.projectCode) segs.push(opts.projectCode);
      if (opts.dirPath) segs.push(opts.dirPath);
      segs.push(uploadFileName);
      return [baseDir.replace(/\/+$/, ''), ...segs].join('/');
    }
    console.warn('[FolderSubmitScheduleModal] JAR upload failed:', uploadRes.msg);
    return null;
  } catch (e) {
    console.warn('[FolderSubmitScheduleModal] JAR upload error:', e);
    return null;
  }
}

/**
 * 文件夹「提交调度」模态框。
 *
 * 内容与「工作流定义」一致（工具栏 + DAG 画布 + 保存弹窗），但：
 * - **不显示左侧任务节点类型面板** —— 节点按该文件夹下的代码文件自动生成
 *   （每个代码文件一个任务节点，节点间依赖取自各文件代码头声明的 @依赖）；
 * - **不提供「运行」** —— 只做保存（在 DolphinScheduler 创建/更新工作流，可勾选上线）。
 *
 * 保存目标项目按「调度项目名称 === 开发项目编码」匹配（与提交调度既有规则一致）。
 */
const FolderSubmitScheduleModal: React.FC<FolderSubmitScheduleModalProps> = ({
  visible,
  folderPath,
  codeFilePaths,
  rootPath,
  projectCode,
  readFileContent,
  dsApi,
  isRealApi,
  compileConfig,
  devProjectId,
  openlineageTransportUrl,
  onSuccess,
  onClose,
}) => {
  const toast = useToast();
  // 按文件读取已保存的血缘配置（lineage.*）：仅在「本次确实要注入」时才会调用，见 applyLineageParamsToSparkNodes
  const { fetchByFilePath } = useDevProjectConfig();

  const [phase, setPhase] = useState<DraftPhase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<BuildWorkflowFromFolderResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingLabel, setSavingLabel] = useState('正在提交到调度系统…');
  // 部署环境：默认「测试」，拼在工作流名称末尾决定提交到调度系统的名称
  const [deployEnv, setDeployEnv] = useState<DeployEnv>(DEFAULT_DEPLOY_ENV);
  // 正在解析跨工作流/跨项目前置依赖（草稿生成后的异步阶段）
  const [depResolving, setDepResolving] = useState(false);

  const [project, setProject] = useState<DSProject | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [meta, setMeta] = useState<EditorMeta>({});
  // 全量调度项目列表：解析跨项目 @依赖 时按「调度项目名称」反查项目 code
  const [projectList, setProjectList] = useState<DSProject[]>([]);

  // 目标文件集合的稳定指纹：父组件每次渲染都可能重建数组，直接进依赖会反复重跑
  const filesKey = useMemo(() => codeFilePaths.join('|'), [codeFilePaths]);
  // 任务名(净化) -> 源文件绝对路径：编译阶段按节点名反查源文件（与 buildWorkflowFromFolder 口径一致）
  const filePathByTaskName = useMemo(
    () => buildTaskNameToFilePathMap(codeFilePaths),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filesKey],
  );
  // 在途读取/探测的失效序号：关闭弹窗或目标变化后，晚到的响应一律丢弃
  const loadSeqRef = useRef(0);
  const dsSeqRef = useRef(0);
  // 已解析的跨工作流前置依赖（label -> 任务引用）：草稿阶段解析一次，保存时复用，避免重复扫描调度项目
  const resolvedDepsRef = useRef<Map<string, ResolvedDependency>>(new Map());
  // 已做过依赖重建的 draft 对象引用：setDraft 产生新对象后会再次触发重建 effect，用它防重入
  const reconciledForRef = useRef<BuildWorkflowFromFolderResult | null>(null);

  /** 展示用路径：项目编码 + 项目内相对路径（与「配置参数」的目标列表同一口径） */
  const displayPath = useMemo(() => {
    const rel = rootPath ? toRelativePath(folderPath, rootPath) : folderPath;
    const pc = (projectCode || '').trim();
    return pc && rel ? `${pc}/${rel}` : rel || folderPath;
  }, [folderPath, rootPath, projectCode]);

  // ---------- 读取代码文件并生成工作流草稿 ----------
  useEffect(() => {
    const seq = ++loadSeqRef.current;
    if (!visible) return;

    if (codeFilePaths.length === 0) {
      setPhase('error');
      setDraft(null);
      setError('该文件夹下没有可提交调度的代码文件（仅支持 Scala / SQL / Java / Python）');
      return;
    }
    if (!readFileContent) {
      setPhase('error');
      setDraft(null);
      setError('缺少文件读取能力，无法解析代码文件生成任务节点');
      return;
    }

    setPhase('loading');
    setError(null);
    setDraft(null);
    setDepResolving(false);
    resolvedDepsRef.current = new Map();
    reconciledForRef.current = null;

    (async () => {
      try {
        // 并发读取全部目标文件；数量与顺序同 codeFilePaths 一一对应
        const contents = await Promise.all(codeFilePaths.map(p => readFileContent(p)));
        if (seq !== loadSeqRef.current) return;
        const files = codeFilePaths.map((p, i) => ({ filePath: p, content: contents[i] ?? '' }));
        setDraft(buildWorkflowFromFolder(files, { rootPath, folderPath, projectCode }));
        setPhase('ready');
      } catch (e) {
        if (seq !== loadSeqRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhase('error');
      }
    })();

    return () => { loadSeqRef.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, filesKey, readFileContent, rootPath, folderPath, projectCode]);

  // ---------- 解析目标调度项目 + 编辑器所需的只读上下文 ----------
  useEffect(() => {
    const seq = ++dsSeqRef.current;
    setProject(null);
    setProjectError(null);
    setMeta({});
    if (!visible || !dsApi) return;

    (async () => {
      try {
        const res = await dsApi.project.list({ pageNo: 1, pageSize: 200 });
        if (seq !== dsSeqRef.current) return;
        const list = res.data?.totalList ?? [];
        setProjectList(list);
        const matched = projectCode ? list.find(p => p.name === projectCode) : undefined;
        if (!matched) {
          setProjectError(
            projectCode
              ? `未找到名称与项目编码「${projectCode}」一致的调度项目，无法提交`
              : '缺少项目编码，无法定位调度项目'
          );
          return;
        }
        setProject(matched);

        // 编辑器内双击节点配置任务时需要这些只读上下文；任一失败都不阻断提交
        const [wfRes, wgRes, envRes] = await Promise.allSettled([
          dsApi.workflowDefinition.list(matched.code, { pageNo: 1, pageSize: 200 }),
          dsApi.workerGroup.list(matched.code, { pageNo: 1, pageSize: 200 }),
          dsApi.environment.list({ pageNo: 1, pageSize: 200 }),
        ]);
        if (seq !== dsSeqRef.current) return;

        const wfList = wfRes.status === 'fulfilled' && wfRes.value.code === 0
          ? wfRes.value.data?.totalList ?? []
          : [];
        const wgList = wgRes.status === 'fulfilled' && wgRes.value.code === 0
          ? wgRes.value.data?.totalList ?? []
          : [];
        const envList = envRes.status === 'fulfilled' && envRes.value.code === 0
          ? envRes.value.data?.totalList ?? []
          : [];

        setMeta({
          workflowDefinitions: wfList.length > 0 ? wfList.map(d => ({ code: d.code, name: d.name })) : undefined,
          workerGroups: wgList.length > 0 ? wgList : undefined,
          environments: envList.length > 0 ? envList : undefined,
        });
      } catch (e) {
        if (seq !== dsSeqRef.current) return;
        setProjectError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => { dsSeqRef.current++; };
  }, [visible, dsApi, projectCode]);

  // ---------- 解析外部前置依赖（跨文件夹 / 跨项目的 @依赖） ----------
  /**
   * 扫描指定项目集合中的全部工作流任务节点，建立 taskName(净化后) ->
   * { 项目code, 工作流code, 任务code } 索引（同名只取首个）。
   * 与单文件提交调度（SubmitToSchedulerModal.buildProjectTaskIndex）口径一致。
   */
  const buildProjectTaskIndex = useCallback(
    async (scanProjectCodes: Set<number>): Promise<Map<string, { projectCode: number; definitionCode: number; taskCode: number }>> => {
      const byName = new Map<string, { projectCode: number; definitionCode: number; taskCode: number }>();
      if (!dsApi) return byName;
      for (const scanCode of scanProjectCodes) {
        try {
          // 分页拉取项目内全部工作流，避免目标任务所在工作流在第一页之外被漏检
          const pageSize = 100;
          for (let page = 1; ; page++) {
            const wfRes = await dsApi.workflowDefinition.list(scanCode, { pageNo: page, pageSize });
            const defs = wfRes.code === 0 && wfRes.data?.totalList ? wfRes.data.totalList : [];
            for (const def of defs) {
              try {
                const dRes = await dsApi.workflowDefinition.detail(scanCode, def.code);
                if (dRes.code === 0 && dRes.data) {
                  for (const node of dRes.data.taskNodes) {
                    const san = sanitizeDsName(node.name);
                    if (san && !byName.has(san)) {
                      byName.set(san, { projectCode: scanCode, definitionCode: def.code, taskCode: node.code });
                    }
                  }
                }
              } catch { /* 单个工作流查询失败则跳过 */ }
            }
            if (defs.length < pageSize) break;
          }
        } catch { /* 项目扫描失败则跳过 */ }
      }
      return byName;
    },
    [dsApi],
  );

  /**
   * 按需解析跨工作流/跨项目前置任务（供依赖关系重建使用）：
   * 输入待解析的 @依赖 label 集合（{调度项目}.{前置任务名称}），返回 label -> 解析结果。
   */
  const resolveExternalDeps = useCallback(
    async (labels: Set<string>): Promise<Map<string, ResolvedDependency>> => {
      const result = new Map<string, ResolvedDependency>();
      if (!dsApi || labels.size === 0) return result;

      const deps: HeaderDependency[] = [...labels].map(label => {
        const dotIdx = label.indexOf('.');
        return dotIdx >= 0
          ? { projectCode: label.slice(0, dotIdx), taskName: label.slice(dotIdx + 1) }
          : { projectCode: '', taskName: label };
      });

      // 需要扫描的项目集合：目标项目 + 各依赖声明中指定的 {调度项目}
      const scanProjectCodes = new Set<number>();
      if (project) scanProjectCodes.add(project.code);
      for (const dep of deps) {
        const matched = dep.projectCode ? projectList.find(p => p.name === dep.projectCode) : null;
        if (matched?.code != null) scanProjectCodes.add(matched.code);
      }

      const byName = await buildProjectTaskIndex(scanProjectCodes);
      for (const dep of deps) {
        const label = [dep.projectCode, dep.taskName].filter(Boolean).join('.');
        const hit = byName.get(sanitizeDsName(dep.taskName));
        if (hit) {
          result.set(label, { projectCode: hit.projectCode, definitionCode: hit.definitionCode, taskCode: hit.taskCode, taskName: dep.taskName, label });
        }
      }
      return result;
    },
    [dsApi, project, projectList, buildProjectTaskIndex],
  );

  // ---------- 草稿生成后：自动配置跨工作流/跨项目前置依赖 ----------
  /**
   * `buildWorkflowFromFolder` 只连「同文件夹内」的依赖边，跨文件夹/跨项目的 @依赖 记在
   * `unresolved` 里。这里在草稿落地后立刻解析它们在调度系统中的实际任务，
   * 用 reconcileWorkflowDependencies 生成专属的「前置依赖_{任务名}」DEPENDENT 节点并连边，
   * 让用户在画布上**直接看到**自动配置好的依赖关系（而不是等保存时才悄悄生成）。
   * 解析不到的（调度系统中确实不存在该任务）才保留在 unresolved 供界面提示。
   */
  useEffect(() => {
    if (!visible || !draft || !project || !dsApi) return;
    // 同一次 draft 只重建一次：重建后 setDraft 产生新对象会再次触发本 effect
    if (reconciledForRef.current === draft) return;
    reconciledForRef.current = draft;

    const externalLabels = new Set(draft.unresolved.map(u => depLabelOf(u)));
    if (externalLabels.size === 0) return;

    let cancelled = false;
    setDepResolving(true);
    (async () => {
      try {
        const resolved = await resolveExternalDeps(externalLabels);
        if (cancelled) return;
        resolved.forEach((v, k) => resolvedDepsRef.current.set(k, v));

        const alloc = makeReconcileAllocators(draft.nodes);
        const recon = await reconcileWorkflowDependencies({
          nodes: draft.nodes,
          edges: draft.edges,
          localHeaderDeps: draft.headerDeps,
          // 文件夹场景没有单一「主任务」，传空即可（reconcile 仅用它给重建目标排序）
          mainTaskName: '',
          resolvedLabels: resolvedDepsRef.current,
          // 已解析过的 label 直接命中，未命中的再走一次真实解析（避免重复全量扫描）
          resolveExternalDeps: async (labels) => {
            const cached = new Map<string, ResolvedDependency>();
            const missing = new Set<string>();
            labels.forEach(l => {
              const hit = resolvedDepsRef.current.get(l);
              if (hit) cached.set(l, hit); else missing.add(l);
            });
            if (missing.size > 0) {
              const extra = await resolveExternalDeps(missing);
              extra.forEach((v, k) => {
                cached.set(k, v);
                resolvedDepsRef.current.set(k, v);
              });
            }
            return cached;
          },
          allocateCode: alloc.allocateCode,
          nextSlot: alloc.nextSlot,
        });
        if (cancelled) return;
        recon.warnings.forEach(w => console.warn('[FolderSubmitScheduleModal] 依赖重建:', w));

        // 仅在调度系统中也没找到的才算「未自动配置」
        const stillUnresolved = draft.unresolved.filter(u => !resolvedDepsRef.current.has(depLabelOf(u)));
        const cycle = findDependencyCycle(recon.nodes, recon.edges);
        // 有环时分层布局无意义，保留 reconcile 分配的网格坐标交由用户在画布上处理
        if (!cycle) layoutWorkflowByDependency(recon.nodes, recon.edges);

        const next: BuildWorkflowFromFolderResult = {
          ...draft,
          nodes: recon.nodes,
          edges: recon.edges,
          unresolved: stillUnresolved,
          cycle,
        };
        reconciledForRef.current = next;
        setDraft(next);
      } catch (e) {
        if (!cancelled) {
          console.warn('[FolderSubmitScheduleModal] 前置依赖自动配置失败:', e);
        }
      } finally {
        if (!cancelled) setDepResolving(false);
      }
    })();

    return () => { cancelled = true; };
  }, [visible, draft, project, dsApi, resolveExternalDeps]);

  // ---------- 保存前：编译可编译节点并回填主 Jar 包 ----------
  /**
   * 对 nodes 中「Java/Scala 且映射为需要主 Jar 包的任务类型」的节点逐个：
   * 读取最新磁盘内容 → unifiedCompile 编译 → 上传 jar 到调度资源中心 → 回填 taskParams.mainJar。
   * 与单文件提交调度（SubmitToSchedulerModal）的「编译 → 上传 → 回填」链路保持一致。
   * 返回回填后的节点副本 + 失败原因列表（调用方据此阻止保存）。
   */
  const compileAndFillMainJars = useCallback(async (
    nodes: DSWorkflowTaskNode[],
  ): Promise<{ nodes: DSWorkflowTaskNode[]; errors: string[] }> => {
    const errors: string[] = [];
    // 浅拷贝，避免修改编辑器传入的节点对象
    const result = nodes.map(n => ({ ...n }));

    if (!dsApi) {
      return { nodes: result, errors: ['调度系统不可用，无法上传编译产物'] };
    }

    for (const node of result) {
      const filePath = filePathByTaskName.get(sanitizeDsName(node.name));
      // 用户在画布上改名导致反查不到源文件，或该节点不是代码文件生成（理论上不会出现）——跳过
      if (!filePath) continue;
      const fileName = filePath.split(/[/\\]/).pop() || filePath;
      if (!isCompilableFile(fileName, node.taskType)) continue;

      if (!compileConfig?.javaHome) {
        errors.push(`「${node.name}」：JAVA_HOME 未配置，无法编译 Java/Scala 代码，请在设置中配置`);
        continue;
      }
      if (!readFileContent) {
        errors.push(`「${node.name}」：缺少文件读取能力，无法编译`);
        continue;
      }

      try {
        const codeContent = await readFileContent(filePath);
        const compileResult = await unifiedCompile({
          projectId: devProjectId || 0,
          projectCode: projectCode || undefined,
          filePath,
          codeContent,
          rootPath: rootPath || undefined,
          envConfig: compileConfig,
          savedConfig: null,
        });

        if (!compileResult.success) {
          errors.push(`「${node.name}」：编译失败: ${compileResult.error || compileResult.output || '未知错误'}`);
          continue;
        }

        const resourcePath = await uploadJarToResource({
          dsApi,
          projectCode,
          dirPath: dirPathOf(filePath, rootPath),
          jarPath: compileResult.jarPath,
          fileName,
        });
        if (!resourcePath) {
          errors.push(`「${node.name}」：编译成功，但 Jar 包上传到调度资源中心失败`);
          continue;
        }

        const params = safeParseTaskParams(node.taskParams);
        params.mainJar = resourcePath;
        node.taskParams = JSON.stringify(params);
      } catch (e) {
        errors.push(`「${node.name}」：编译异常: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return { nodes: result, errors };
  }, [dsApi, filePathByTaskName, compileConfig, devProjectId, projectCode, rootPath, readFileContent]);

  // ---------- 保存前：为 SPARK 节点注入数据血缘参数（仅生产环境） ----------
  /**
   * 血缘参数（`spark.openlineage.*`）的拼装与两道闸门都在 `utils/lineageParams.ts`，
   * 与单文件提交调度**共用同一份实现**。文件夹入口的差别只在配置来源：
   * 这里没有逐文件配置的内存态，所以只在「本环境确实要注入」（生产）时，
   * 才按文件去后端查一次 `lineage.*`；查不到（未配置 / 后端不可用）按「未显式关闭」处理，
   * 用设置页的全局值注入 —— 与单文件入口的兜底口径一致。
   *
   * 非生产环境直接原样返回：一个请求都不发，也不改写任何节点的「其他参数」。
   */
  const applyLineageParamsToSparkNodes = useCallback(async (
    nodes: DSWorkflowTaskNode[],
  ): Promise<DSWorkflowTaskNode[]> => {
    if (!shouldInjectLineage(deployEnv)) return nodes;

    const result = nodes.map(n => ({ ...n }));
    for (const node of result) {
      if (node.taskType !== 'SPARK') continue;

      const filePath = filePathByTaskName.get(sanitizeDsName(node.name));
      let fileLineage: Record<string, string> = {};
      if (filePath && devProjectId) {
        // 后端按 (project_id, 项目内相对路径) 联合键存储，路径口径与「配置参数」弹窗一致
        const loaded = await fetchByFilePath(devProjectId, toRelativePath(filePath, rootPath));
        fileLineage = extractLineageParams(loaded?.taskParams);
      }

      const args = buildOpenLineageArgs({
        env: deployEnv,
        projectCode,
        globalTransportUrl: openlineageTransportUrl,
        fileLineage,
      });
      // 空数组 = 本次不注入（文件级 lineage.enabled=false）：此时不碰 others，
      // 免得把用户的「其他参数」覆盖成空串
      if (args.length === 0) continue;

      // 与单文件提交调度同口径：拼成单行追加在「其他参数」末尾，用户已有命令保持不变
      const params = safeParseTaskParams(node.taskParams);
      const existing = ((params.others as string) || '').replace(/\r?\n/g, ' ').trim();
      params.others = existing ? `${existing} ${args.join(' ')}` : args.join(' ');
      node.taskParams = JSON.stringify(params);
    }
    return result;
  }, [
    deployEnv, filePathByTaskName, devProjectId, rootPath, projectCode,
    openlineageTransportUrl, fetchByFilePath,
  ]);

  // ---------- 保存（创建或更新调度工作流） ----------
  const handleSave = useCallback(async (data: WorkflowSavePayload) => {
    if (!dsApi) {
      toast.error('调度系统不可用，无法提交');
      return;
    }
    if (!project) {
      toast.error(projectError || '未定位到调度项目，无法提交');
      return;
    }

    const name = sanitizeDsName(data.name);
    setSaving(true);
    setSavingLabel('正在编译代码…');
    try {
      // 1. 编译可编译节点并回填主 Jar 包；有任一失败即阻止保存（与单文件提交调度一致）
      const { nodes: compiledNodes, errors } = await compileAndFillMainJars(data.nodes);
      if (errors.length > 0) {
        errors.slice(0, 5).forEach(m => toast.error(m));
        if (errors.length > 5) toast.error(`另有 ${errors.length - 5} 个文件未通过编译，请修正后重试`);
        return;
      }

      // 2. 为 SPARK 节点注入数据血缘参数（仅生产环境；非生产一个请求都不发）
      const lineageNodes = await applyLineageParamsToSparkNodes(compiledNodes);

      // 3. 依赖重建：解析代码头 @依赖，同工作流依赖直接连边，
      //    跨文件夹/跨项目依赖自动生成专属「前置依赖」DEPENDENT 节点（与单文件提交调度一致）
      const headerDeps = draft?.headerDeps ?? new Map<string, HeaderDependency[]>();
      const alloc = makeReconcileAllocators(compiledNodes);
      const recon = await reconcileWorkflowDependencies({
        nodes: lineageNodes,
        edges: data.edges,
        localHeaderDeps: headerDeps,
        // 文件夹场景没有单一「主任务」，传空即可（reconcile 仅用它给重建目标排序）
        mainTaskName: '',
        // 复用草稿阶段已解析的结果，未命中的再按需解析
        resolvedLabels: resolvedDepsRef.current,
        resolveExternalDeps: async (labels) => {
          const cached = new Map<string, ResolvedDependency>();
          const missing = new Set<string>();
          labels.forEach(l => {
            const hit = resolvedDepsRef.current.get(l);
            if (hit) cached.set(l, hit); else missing.add(l);
          });
          if (missing.size > 0) {
            const extra = await resolveExternalDeps(missing);
            extra.forEach((v, k) => {
              cached.set(k, v);
              resolvedDepsRef.current.set(k, v);
            });
          }
          return cached;
        },
        allocateCode: alloc.allocateCode,
        nextSlot: alloc.nextSlot,
      });
      recon.warnings.forEach(w => console.warn('[FolderSubmitScheduleModal] 依赖重建:', w));

      // 重建后校验依赖图无环，避免代码头声明了循环依赖导致整次保存失败
      const cycle = findDependencyCycle(recon.nodes, recon.edges);
      if (cycle) {
        toast.error(`依赖关系存在环（${cycle.join(' -> ')}），无法保存，请在画布上修正`);
        return;
      }

      // 任务节点的「应用名称」统一为 {项目}.{工作流}.{任务}，其中工作流名取**最终提交名**
      // （可能刚在保存弹窗里被改过）——保证即使没打开过任务配置弹窗，提交的值也与工作流基本信息一致
      const finalNodes = applyAppNameToNodes(recon.nodes, { project: projectLabel, workflow: name });

      // 提交前按依赖关系分层布局：前置节点（含 DEPENDENT 前置依赖节点）总在依赖节点左侧
      layoutWorkflowByDependency(finalNodes, recon.edges);

      // 4. 用回填了 mainJar、注入了血缘参数且重建了依赖的节点/边提交
      setSavingLabel('正在提交到调度系统…');
      const payload = { ...data, nodes: finalNodes, edges: recon.edges };
      const { release, ...rest } = payload;

      const listRes = await dsApi.workflowDefinition.list(project.code, {
        pageNo: 1, pageSize: 100, searchVal: name,
      });
      const existing = listRes.code === 0
        ? (listRes.data?.totalList ?? []).find(w => w.name === name)
        : undefined;

      if (existing) {
        const res = await dsApi.workflowDefinition.update(project.code, existing.code, { ...rest, name, release });
        if (res.code !== 0) throw new Error(res.msg || '更新工作流失败');
        toast.info(`已更新调度工作流「${name}」`);
      } else {
        const res = await dsApi.workflowDefinition.createWithTasks(project.code, { ...rest, name });
        if (res.code !== 0) throw new Error(res.msg || '创建工作流失败');
        if (release) {
          // 创建接口不支持直接指定上线状态，创建后按名称回查再上线
          const after = await dsApi.workflowDefinition.list(project.code, {
            pageNo: 1, pageSize: 100, searchVal: name,
          });
          const created = (after.data?.totalList ?? []).find(w => w.name === name);
          if (created) {
            const rel = await dsApi.workflowDefinition.release(project.code, created.code, ReleaseState.ONLINE);
            if (rel.code !== 0) throw new Error(rel.msg || '工作流已创建，但上线失败');
          }
        }
        toast.info(`已创建调度工作流「${name}」`);
      }
      onSuccess?.(name);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
      setSavingLabel('正在提交到调度系统…');
    }
  }, [dsApi, project, projectError, toast, onSuccess, onClose, compileAndFillMainJars, applyLineageParamsToSparkNodes, draft, resolveExternalDeps]);

  if (!visible) return null;

  const fileCount = codeFilePaths.length;
  // 画布上由跨工作流 @依赖 自动生成的「前置依赖」DEPENDENT 节点，用于向用户说明自动配置结果
  const dependentNodes = draft?.nodes.filter(n => n.taskType === 'DEPENDENT') ?? [];

  // 头部标题：「调度项目名称（= 项目编码）」+「工作流名称」。
  // 工作流名取草稿名（与真正提交给调度系统的名称同规范），草稿未就绪时按同一函数先行推导，
  // 避免头部先闪一段相对路径再变成工作流名；末尾再拼上环境后缀（生产/灰度/测试），
  // 该值就是最终提交给调度系统的名称（编辑器保存弹窗的默认名也用它）。
  const projectLabel = (project?.name || projectCode || '').trim();
  const baseWorkflowName = draft?.name || deriveFolderWorkflowName(folderPath, rootPath);
  const workflowLabel = withDeployEnvSuffix(baseWorkflowName, deployEnv);
  const headerTitle = `${projectLabel ? `${projectLabel} ` : ''}工作流名称：${workflowLabel}`;
  // 节点数：草稿就绪后按画布上真实任务节点数（含自动生成的「前置依赖」节点），
  // 尚未就绪时退回代码文件数（此时每个文件恰好对应一个待生成的节点）
  const nodeCount = draft ? draft.nodes.length : fileCount;

  return (
    <div className="folder-submit-schedule__overlay" onClick={onClose}>
      <div
        className="folder-submit-schedule__panel"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="提交调度"
      >
        <div className="folder-submit-schedule__header">
          <div className="folder-submit-schedule__title">
            <Send size={16} />
            <span>提交调度</span>
            {!isRealApi && <span className="folder-submit-schedule__badge">模拟环境</span>}
          </div>
          {/* 副标题：「调度项目名称 + 工作流名称」；完整文件夹路径收进 title 提示。
              环境单选紧跟在名称之后：它决定的就是名称末尾的后缀，贴在一起因果关系最直观 */}
          <div className="folder-submit-schedule__subtitle" title={folderPath}>
            <FolderKanban size={13} />
            <span className="folder-submit-schedule__path" title={headerTitle}>{headerTitle}</span>
            <DeployEnvRadio
              value={deployEnv}
              onChange={setDeployEnv}
              hint={
                shouldInjectLineage(deployEnv)
                  ? `工作流名称将以 _${deployEnv} 结尾，提交时注入数据血缘参数`
                  : `工作流名称将以 _${deployEnv} 结尾，不注入数据血缘参数`
              }
            />
            {nodeCount > 0 && (
              <span className="folder-submit-schedule__count">{nodeCount} 个任务节点</span>
            )}
          </div>
          <button className="folder-submit-schedule__close" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        {projectError && (
          <div className="folder-submit-schedule__notice folder-submit-schedule__notice--error">
            <AlertTriangle size={14} />
            <span>{projectError}</span>
          </div>
        )}

        {phase === 'loading' && (
          <div className="folder-submit-schedule__state">
            <Loader2 size={22} className="folder-submit-schedule__spin" />
            <span>正在读取 {fileCount} 个代码文件并生成任务节点…</span>
          </div>
        )}

        {phase === 'error' && (
          <div className="folder-submit-schedule__state folder-submit-schedule__state--error">
            <AlertTriangle size={22} />
            <span>{error}</span>
            <button className="folder-submit-schedule__retry" onClick={onClose}>
              <RefreshCw size={13} /> 关闭
            </button>
          </div>
        )}

        {phase === 'ready' && draft && (
          <>
            {draft.cycle && draft.cycle.length > 0 && (
              <div className="folder-submit-schedule__notice folder-submit-schedule__notice--error">
                <AlertTriangle size={14} />
                <span>
                  代码头声明的依赖存在环：{draft.cycle.join(' → ')}。可在画布上删除多余的连线后再保存。
                </span>
              </div>
            )}

            {depResolving && (
              <div className="folder-submit-schedule__notice folder-submit-schedule__notice--info">
                <Loader2 size={14} className="folder-submit-schedule__spin" />
                <span>正在解析跨工作流前置依赖并自动配置「前置依赖」节点…</span>
              </div>
            )}

            {!depResolving && dependentNodes.length > 0 && (
              <div className="folder-submit-schedule__notice folder-submit-schedule__notice--info">
                <Info size={14} />
                <span>
                  已为 {dependentNodes.length} 个跨工作流前置依赖自动生成「前置依赖」任务节点并建立连线：
                  {dependentNodes.map(n => n.name).join('、')}
                </span>
              </div>
            )}

            {!depResolving && draft.unresolved.length > 0 && (
              <div className="folder-submit-schedule__notice folder-submit-schedule__notice--error">
                <AlertTriangle size={14} />
                <span>
                  以下前置依赖在调度系统中未找到对应任务，未能自动配置（保存后该依赖不会被建立）：
                  {draft.unresolved
                    .slice(0, 5)
                    .map(u => `${u.projectCode ? `${u.projectCode}.` : ''}${u.taskName}（被 ${u.from} 依赖）`)
                    .join('；')}
                  {draft.unresolved.length > 5 ? ` 等 ${draft.unresolved.length} 项` : ''}
                </span>
              </div>
            )}

            <div className="folder-submit-schedule__editor">
              <WorkflowDefinitionEditor
                key={`${filesKey}-${draft.nodes.length}`}
                // 名称含环境后缀：保存弹窗据此预填，保存时直接按该名称 create / update
                workflowName={workflowLabel}
                description={`由文件夹 ${displayPath} 下的代码文件生成`}
                existingNodes={draft.nodes}
                existingEdges={draft.edges}
                // 不显示左侧「任务节点」类型面板：节点已按代码文件自动生成
                showTaskTypeSidebar={false}
                // 名称已在弹窗头部展示（项目名称 + 工作流名称），编辑器工具栏不再重复
                hideToolbarHeader
                // 任务节点的「应用名称」按 {项目}.{工作流}.{任务} 自动生成（只读），与头部名称同源
                appNameContext={{ project: projectLabel, workflow: workflowLabel }}
                workflowDefinitions={meta.workflowDefinitions}
                workerGroups={meta.workerGroups}
                environments={meta.environments}
                api={dsApi ?? undefined}
                onSave={handleSave}
                // 不传 onTrigger：本入口只做保存，不提供「运行」
                onClose={onClose}
              />
            </div>

            {saving && (
              <div className="folder-submit-schedule__saving">
                <Loader2 size={16} className="folder-submit-schedule__spin" />
                <span>{savingLabel}</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default FolderSubmitScheduleModal;
