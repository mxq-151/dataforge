import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { homedir } from 'node:os';
import {
  parseDependencyHeader,
  reconcileWorkflowDependencies,
  findDependencyCycle,
  sanitizeDsName,
  buildDependentTaskNode,
  dependentNodeName,
  type ResolvedDependency,
  type HeaderDependency,
} from './schedulerMapping';
import { parseFileHeader } from './fileHeader';
import type { DSWorkflowTaskNode, DSWorkflowEdge, DSWorkflowGlobalParam } from '../types/dolphinscheduler';

/**
 * 模拟「用户乱序提交调度」验证脚本（临时文件）：
 * 以 ~/.dataforge/<host>/code/test_project/src/test_project 为本地项目（host 随部署环境自动探测），
 * 完整模拟 SubmitToSchedulerModal.handleSubmit 的提交流程。
 *
 * 与真实调度服务对齐的接口闭环：
 * - 每次提交前调用 workflowDefinition.list（按名定位工作流）
 * - 已存在的工作流：调用 workflowDefinition.detail 获取「最新工作流定义」
 *   （服务端返回深拷贝快照，客户端不持有共享引用），基于最新快照重建依赖，
 *   再调用 workflowDefinition.update 整体提交
 * - 不存在的工作流：调用 workflowDefinition.createWithTasks 新建
 * - 服务端对提交的 DAG 做校验（节点 code 唯一、边两端节点必须存在），
 *   校验失败返回 { code: 1 }，客户端据此拒绝提交（验证依赖构建的真实可提交性）
 *
 * 多个随机乱序 + 完全逆序提交后，断言最终依赖图与代码头 @依赖 声明完全一致，
 * 且每种提交顺序的结果完全一致，并输出最终依赖关系图。
 */
/** 定位本地 test_project：.dataforge/<host>/code/test_project/src/test_project。
 *  host 目录随部署环境而异（localhost_8082 / 192.168.1.110_8082 等），逐个探测取第一个命中；
 *  都未命中时回退默认 host，让测试以 ENOENT 形式失败（与未修改前行为一致）。 */
function resolveProjectRoot(): string {
  const base = join(homedir(), '.dataforge');
  const defaultRoot = join(base, 'localhost_8082', 'code', 'test_project', 'src', 'test_project');
  if (!existsSync(base)) return defaultRoot;
  for (const host of readdirSync(base)) {
    const candidate = join(base, host, 'code', 'test_project', 'src', 'test_project');
    if (existsSync(candidate)) return candidate;
  }
  return defaultRoot;
}
const PROJECT_ROOT = resolveProjectRoot();
const PROJECT_CODE = 9527;

// —— 与 SubmitToSchedulerModal 中一致的工具（网格布局/节点构造） ——
const GRID_COLS = 3;
const GRID_GAP_X = 450;
const GRID_GAP_Y = 260;
const GRID_START_X = 300;
const GRID_START_Y = 140;
function gridPos(index: number): { x: number; y: number } {
  return {
    x: GRID_START_X + (index % GRID_COLS) * GRID_GAP_X,
    y: GRID_START_Y + Math.floor(index / GRID_COLS) * GRID_GAP_Y,
  };
}

function mkTaskNode(code: number, name: string): DSWorkflowTaskNode {
  return {
    code,
    name,
    taskType: 'SPARK',
    description: '',
    taskParams: '{}',
    flag: 'YES',
    taskPriority: 'MEDIUM',
    workerGroup: 'default',
    environmentCode: -1,
    failRetryTimes: 0,
    failRetryInterval: 1,
    timeoutFlag: 'CLOSE',
    timeout: 0,
    delayTime: 0,
    x: 100,
    y: 100,
  };
}

// —— 本地文件扫描（与 scanLocalHeaderDependencies 相同规则） ——
interface LocalFile {
  taskName: string;         // sanitizeDsName(文件名去扩展名)
  rawTaskName: string;
  workflowName: string;     // 与 mapCodeFileToTask 相同：目录路径斜杠替换为下划线
  deps: HeaderDependency[];
  relativePath: string;
}

function walkFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 10) return out;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || ['node_modules', 'target', 'dist', 'build'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkFiles(full, depth + 1, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function scanLocalFiles(root: string): LocalFile[] {
  const CODE_EXTS = new Set(['sql', 'hql', 'py', 'sh', 'bash', 'java', 'scala']);
  const files: LocalFile[] = [];
  for (const full of walkFiles(root)) {
    const ext = basename(full).includes('.') ? basename(full).split('.').pop()! : '';
    if (!CODE_EXTS.has(ext)) continue;
    // 统一为 '/' 分隔：Windows 下 relative() 返回 '\' 分隔路径，会破坏 ads/code/ 前缀过滤与目录切分
    const rel = relative(root, full).replace(/\\/g, '/');
    const rawTaskName = basename(full).replace(/\.[^.]+$/, '');
    const dirPath = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const header = parseFileHeader(readFileSync(full, 'utf-8'));
    files.push({
      taskName: sanitizeDsName(rawTaskName),
      rawTaskName,
      workflowName: sanitizeDsName((dirPath || rawTaskName).replace(/[/\\]/g, '_')),
      deps: parseDependencyHeader(header?.dependency),
      relativePath: rel,
    });
  }
  return files;
}

// ================= 模拟 DolphinScheduler 调度服务端 =================
// 用 SimSchedulerApi 模拟真实 DS 接口的「请求 → 响应」闭环：
// 服务端持久化完整工作流定义（含版本），客户端每次提交前必须 detail 拉最新快照，
// 提交走 createWithTasks / update 整体保存，服务端对 DAG 做合法性校验。
type ApiResponse<T = unknown> = { code: number; msg: string; data?: T };

interface ServerWorkflow {
  code: number;
  name: string;
  executionType: string;
  timeout: number;
  globalParams: DSWorkflowGlobalParam[];
  nodes: DSWorkflowTaskNode[];
  edges: DSWorkflowEdge[];
  version: number;
}

class SimSchedulerApi {
  private workflows = new Map<number, ServerWorkflow>();
  private wfSeq = 100000;
  private versionSeq = 1;
  /** 接口调用统计：证明「每次更新提交前都 detail 拉取了最新定义」 */
  readonly stats = { listCalls: 0, detailCalls: 0, updateCalls: 0, createCalls: 0 };

  private deep<T>(v: T): T {
    return JSON.parse(JSON.stringify(v));
  }

  /** 服务端 DAG 合法性校验（模拟真实 DS 后端校验）：节点 code 唯一、边两端节点必须存在 */
  private validateDag(nodes: DSWorkflowTaskNode[], edges: DSWorkflowEdge[]): string | null {
    const codes = new Set<number>();
    for (const n of nodes) {
      if (codes.has(n.code)) return `节点 code 重复: ${n.code}`;
      codes.add(n.code);
    }
    for (const e of edges) {
      if (!codes.has(e.sourceCode)) return `边 ${e.sourceCode}->${e.targetCode} 源节点不存在`;
      if (!codes.has(e.targetCode)) return `边 ${e.sourceCode}->${e.targetCode} 目标节点不存在`;
    }
    return null;
  }

  /** workflowDefinition.list：按名称定位工作流（新建后用于反查 code） */
  list(params: { searchVal?: string }): ApiResponse<{ totalList: { code: number; name: string; version: number; releaseState: string }[] }> {
    this.stats.listCalls++;
    const totalList = [...this.workflows.values()]
      .filter(w => !params.searchVal || w.name.includes(params.searchVal))
      .map(w => ({ code: w.code, name: w.name, version: w.version, releaseState: 'OFFLINE' as const }));
    return { code: 0, msg: 'success', data: { totalList } };
  }

  /**
   * workflowDefinition.detail：返回「最新工作流定义」。
   * 关键语义：返回深拷贝快照（模拟服务端 JSON 响应反序列化边界），
   * 客户端在快照上重建依赖、再整体 update 提交；若基于过期引用重建会丢数据。
   */
  detail(projectCode: number, code: number): ApiResponse<{
    workflowDefinition: { id: number; code: number; name: string; version: number; executionType: string; timeout: number };
    taskNodes: DSWorkflowTaskNode[];
    edges: DSWorkflowEdge[];
    globalParams: DSWorkflowGlobalParam[];
  }> {
    this.stats.detailCalls++;
    const wf = this.workflows.get(code);
    if (!wf) return { code: 1, msg: '工作流不存在' };
    return {
      code: 0,
      msg: 'success',
      data: {
        workflowDefinition: { id: 1, code: wf.code, name: wf.name, version: wf.version, executionType: wf.executionType, timeout: wf.timeout },
        taskNodes: this.deep(wf.nodes),
        edges: this.deep(wf.edges),
        globalParams: this.deep(wf.globalParams),
      },
    };
  }

  /** workflowDefinition.createWithTasks：新建工作流（整体保存 DAG，分配新 code） */
  createWithTasks(projectCode: number, data: {
    name: string;
    executionType: string;
    timeout: number;
    globalParams: DSWorkflowGlobalParam[];
    nodes: DSWorkflowTaskNode[];
    edges: DSWorkflowEdge[];
  }): ApiResponse<{ code: number }> {
    this.stats.createCalls++;
    const err = this.validateDag(data.nodes, data.edges);
    if (err) return { code: 1, msg: `服务端拒绝创建「${data.name}」: ${err}` };
    const code = this.wfSeq++;
    this.workflows.set(code, {
      code,
      name: data.name,
      executionType: data.executionType,
      timeout: data.timeout,
      globalParams: this.deep(data.globalParams),
      nodes: this.deep(data.nodes),
      edges: this.deep(data.edges),
      version: this.versionSeq++,
    });
    return { code: 0, msg: 'success', data: { code } };
  }

  /** workflowDefinition.update：整体保存工作流 DAG，版本 +1 */
  update(projectCode: number, code: number, payload: {
    name: string;
    executionType: string;
    timeout: number;
    globalParams: DSWorkflowGlobalParam[];
    nodes: DSWorkflowTaskNode[];
    edges: DSWorkflowEdge[];
  }): ApiResponse {
    this.stats.updateCalls++;
    const wf = this.workflows.get(code);
    if (!wf) return { code: 1, msg: '工作流不存在' };
    const err = this.validateDag(payload.nodes, payload.edges);
    if (err) return { code: 1, msg: `服务端拒绝更新「${wf.name}」: ${err}` };
    wf.name = payload.name;
    wf.executionType = payload.executionType;
    wf.timeout = payload.timeout;
    wf.globalParams = this.deep(payload.globalParams);
    wf.nodes = this.deep(payload.nodes);
    wf.edges = this.deep(payload.edges);
    wf.version = this.versionSeq++;
    return { code: 0, msg: 'success' };
  }

  /** 服务端当前全部工作流（测试/渲染/项目级索引用，即「从服务端查回来的最新定义」） */
  listAll(): Map<string, ServerWorkflow> {
    const byName = new Map<string, ServerWorkflow>();
    for (const wf of this.workflows.values()) byName.set(wf.name, wf);
    return byName;
  }
}

function labelOf(d: HeaderDependency): string {
  return [d.projectCode, d.taskName].filter(Boolean).join('.');
}

/** 项目级任务索引（模拟 buildProjectTaskIndex：扫描项目内全部工作流） */
function buildIndex(api: SimSchedulerApi): Map<string, { projectCode: number; definitionCode: number; taskCode: number }> {
  const byName = new Map<string, { projectCode: number; definitionCode: number; taskCode: number }>();
  for (const wf of api.listAll().values()) {
    for (const n of wf.nodes) {
      const san = sanitizeDsName(n.name);
      if (san && !byName.has(san)) {
        byName.set(san, { projectCode: PROJECT_CODE, definitionCode: wf.code, taskCode: n.code });
      }
    }
  }
  return byName;
}

/** 提交单个任务到模拟调度服务。返回被阻塞的缺失依赖（为空表示提交成功） */
async function submitFile(
  file: LocalFile,
  api: SimSchedulerApi,
  localDeps: Map<string, HeaderDependency[]>,
  codeAlloc: () => number,
): Promise<string[]> {
  const index = buildIndex(api);

  // 提交前校验：@依赖 声明的前置任务必须已存在（模拟 scanHeaderDependencyTasks + 阻断逻辑）
  const resolvedDeps: ResolvedDependency[] = [];
  const missing: string[] = [];
  for (const dep of file.deps) {
    const label = labelOf(dep);
    const hit = index.get(sanitizeDsName(dep.taskName));
    if (hit) {
      resolvedDeps.push({ projectCode: hit.projectCode, definitionCode: hit.definitionCode, taskCode: hit.taskCode, taskName: dep.taskName, label });
    } else {
      missing.push(label);
    }
  }
  if (missing.length > 0) return missing;

  // 定位工作流（真实流程：提交前先 list 当前工作流）
  const listRes = api.list({ searchVal: file.workflowName });
  const created = listRes.data?.totalList?.[0];

  if (!created) {
    // ===== 新建工作流分支（与 handleSubmit 新建路径一致：createWithTasks） =====
    const mainNode = mkTaskNode(codeAlloc(), file.taskName);
    mainNode.x = gridPos(1).x;
    mainNode.y = gridPos(1).y;
    const nodes: DSWorkflowTaskNode[] = [mainNode];
    const edges: DSWorkflowEdge[] = [];
    if (resolvedDeps.length > 0) {
      const depNode = buildDependentTaskNode(resolvedDeps, codeAlloc(), gridPos(0).x, gridPos(0).y, dependentNodeName(mainNode.name));
      nodes.unshift(depNode);
      edges.push({ id: `e_${depNode.code}_${mainNode.code}`, sourceCode: depNode.code, targetCode: mainNode.code });
    }
    const createRes = api.createWithTasks(PROJECT_CODE, {
      name: file.workflowName,
      executionType: 'PARALLEL',
      timeout: 0,
      globalParams: [],
      nodes,
      edges,
    });
    if (createRes.code !== 0) {
      throw new Error(`[${file.taskName}] 创建失败: ${createRes.msg}`);
    }
    return [];
  }

  // ===== 更新已有工作流分支 =====
  // 关键：每次提交前调用 detail 获取「最新工作流定义」（深拷贝快照），而非本地缓存
  const detailRes = api.detail(PROJECT_CODE, created.code);
  if (detailRes.code !== 0) throw new Error(`[${file.taskName}] 获取工作流定义失败: ${detailRes.msg}`);
  const taskNodes = detailRes.data!.taskNodes;
  const edges = detailRes.data!.edges;
  const workflowDefinition = detailRes.data!.workflowDefinition;

  const sanitizedTaskName = file.taskName;
  const existingIndex = taskNodes.findIndex(n => sanitizeDsName(n.name) === sanitizedTaskName);
  // 真实代码用 Date.now()（全局单调、项目内唯一）分配新任务 code；模拟用全局自增序列等价近似。
  // 关键语义：主任务 code 与 reconcile 新建的 DEPENDENT 节点 code 必须来自同一全局序列，
  // 否则跨提交撞号会导致 DEPENDENT 节点的 depTaskCode 引用错乱。
  const taskCode = existingIndex >= 0 ? taskNodes[existingIndex].code : codeAlloc();

  const willHaveOwnDepNode = existingIndex < 0 && resolvedDeps.some(r =>
    sanitizedTaskName !== sanitizeDsName(r.taskName)
    && !taskNodes.some(n => n.taskType !== 'DEPENDENT' && sanitizeDsName(n.name) === sanitizeDsName(r.taskName)),
  );
  const mainSlot = existingIndex < 0 ? taskNodes.length + (willHaveOwnDepNode ? 1 : 0) : -1;
  const usedSlots = new Set<number>(mainSlot >= 0 ? [mainSlot] : []);
  let slotCursor = taskNodes.length;
  const nextSlot = () => {
    while (usedSlots.has(slotCursor)) slotCursor++;
    const slot = slotCursor;
    usedSlots.add(slot);
    slotCursor++;
    return gridPos(slot);
  };

  const newNode = mkTaskNode(taskCode, sanitizedTaskName);
  if (existingIndex >= 0) {
    newNode.x = taskNodes[existingIndex].x;
    newNode.y = taskNodes[existingIndex].y;
  } else {
    newNode.x = gridPos(mainSlot).x;
    newNode.y = gridPos(mainSlot).y;
  }

  const nodesAfterMain = existingIndex >= 0
    ? taskNodes.map((n, i) => (i === existingIndex ? newNode : n))
    : [...taskNodes, newNode];

  const resolvedLabels = new Map<string, ResolvedDependency>();
  resolvedDeps.forEach(r => resolvedLabels.set(r.label, r));

  const recon = await reconcileWorkflowDependencies({
    nodes: nodesAfterMain,
    edges,
    localHeaderDeps: localDeps,
    mainTaskName: sanitizedTaskName,
    resolvedLabels,
    // 模拟 resolveExternalDeps：按项目级索引（从服务端查回的全部工作流）解析
    resolveExternalDeps: async (labels: Set<string>) => {
      const idx = buildIndex(api);
      const result = new Map<string, ResolvedDependency>();
      for (const label of labels) {
        const dot = label.indexOf('.');
        const taskName = dot >= 0 ? label.slice(dot + 1) : label;
        const hit = idx.get(sanitizeDsName(taskName));
        if (hit) {
          result.set(label, { projectCode: hit.projectCode, definitionCode: hit.definitionCode, taskCode: hit.taskCode, taskName, label });
        }
      }
      return result;
    },
    allocateCode: codeAlloc,
    nextSlot,
  });

  const cycle = findDependencyCycle(recon.nodes, recon.edges);
  expect(cycle, `提交 ${file.taskName} 后出现依赖环: ${cycle?.join(' -> ')}`).toBeNull();
  expect(recon.warnings, `提交 ${file.taskName} 产生告警: ${recon.warnings.join('; ')}`).toEqual([]);

  // 整体提交（与 handleSubmit 的 update 一致：name/executionType/timeout/globalParams/nodes/edges）
  const updateRes = api.update(PROJECT_CODE, created.code, {
    name: workflowDefinition.name,
    executionType: workflowDefinition.executionType,
    timeout: workflowDefinition.timeout,
    globalParams: detailRes.data!.globalParams,
    nodes: recon.nodes,
    edges: recon.edges,
  });
  if (updateRes.code !== 0) {
    throw new Error(`[${file.taskName}] 更新失败: ${updateRes.msg}`);
  }
  return [];
}

/** 一轮乱序提交：随机顺序逐个提交，被阻塞的（前置任务尚未提交）稍后重试 */
async function runSubmissionRound(files: LocalFile[], order: number[], localDeps: Map<string, HeaderDependency[]>, label: string) {
  const api = new SimSchedulerApi();
  let codeSeq = 1;
  const codeAlloc = () => codeSeq++;

  let pending = order.map(i => files[i]);
  const submittedOrder: string[] = [];
  let guard = 0;
  while (pending.length > 0 && guard++ < 200) {
    let progress = false;
    const stillPending: LocalFile[] = [];
    for (const f of pending) {
      const missing = await submitFile(f, api, localDeps, codeAlloc);
      if (missing.length === 0) {
        submittedOrder.push(f.taskName);
        progress = true;
      } else {
        stillPending.push(f);
      }
    }
    pending = stillPending;
    if (!progress) throw new Error(`乱序提交死锁（${label}）：${pending.map(p => p.taskName).join(', ')}`);
  }
  return { api, submittedOrder };
}

/** 输出依赖关系图并返回签名（跨乱序一致性对比用） */
function renderGraph(api: SimSchedulerApi, files: LocalFile[]): string {
  const index = buildIndex(api);
  // 任务 code 项目内全局唯一，直接按 code 建索引（DEPENDENT 节点跨工作流引用 depTaskCode）
  const codeToName = new Map<number, string>();
  for (const [name, hit] of index) codeToName.set(hit.taskCode, name);

  const lines: string[] = [];
  const signatures: string[] = [];
  for (const [wfName, wf] of [...api.listAll().entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`┌─ 工作流 ${wfName}  (v${wf.version})`);
    const incomingByTarget = new Map<number, DSWorkflowEdge[]>();
    for (const e of wf.edges) {
      if (!incomingByTarget.has(e.targetCode)) incomingByTarget.set(e.targetCode, []);
      incomingByTarget.get(e.targetCode)!.push(e);
    }
    for (const node of wf.nodes) {
      if (node.taskType === 'DEPENDENT') {
        const params = JSON.parse(node.taskParams) as { dependence: { dependTaskList: { dependItemList: { depTaskCode: number }[] }[] } };
        const depNames = params.dependence.dependTaskList
          .flatMap(g => g.dependItemList)
          .map(item => codeToName.get(item.depTaskCode) || `code:${item.depTaskCode}`)
          .sort();
        lines.push(`│  ◇ ${node.name}  [DEPENDENT 等待: ${depNames.join(', ')}]`);
        signatures.push(`${wfName}|${node.name}{${depNames.join(',')}}`);
        continue;
      }
      const incoming = incomingByTarget.get(node.code) || [];
      if (incoming.length === 0) {
        lines.push(`│  ● ${node.name}  (无前置依赖)`);
      } else {
        const parts = incoming.map(e => {
          const src = wf.nodes.find(n => n.code === e.sourceCode)!;
          return src.name;
        }).sort();
        lines.push(`│  ● ${node.name}  <- ${parts.join(' + ')}`);
        for (const p of parts) signatures.push(`${wfName}|${p} -> ${node.name}`);
      }
    }
    lines.push('└─');
  }
  // 期望对照：本地代码头声明的依赖
  lines.push('');
  lines.push('==== 代码头 @依赖 声明对照 ====');
  for (const f of files.filter(x => x.deps.length > 0).sort((a, b) => a.taskName.localeCompare(b.taskName))) {
    lines.push(`  ${f.taskName} <- ${f.deps.map(d => d.taskName).sort().join(' + ')}`);
  }
  return lines.join('\n') + '\n====SIG====\n' + signatures.sort().join('\n');
}

describe('乱序提交调度模拟（test_project 真实代码头，模拟 DS 接口闭环）', () => {
  it('detail 接口返回深拷贝最新快照，修改快照不影响服务端存储', () => {
    const api = new SimSchedulerApi();
    api.createWithTasks(PROJECT_CODE, {
      name: 'wf_demo',
      executionType: 'PARALLEL',
      timeout: 0,
      globalParams: [],
      nodes: [mkTaskNode(1, 'A')],
      edges: [],
    });
    const d1 = api.detail(PROJECT_CODE, api.listAll().values().next().value!.code);
    expect(d1.code).toBe(0);
    const snapshot = d1.data!.taskNodes;
    // 深拷贝语义：快照与服务端存储非同一引用，改快照不影响服务端
    snapshot.push(mkTaskNode(99, 'HACK'));
    snapshot[0].name = 'MUTATED';
    const d2 = api.detail(PROJECT_CODE, api.listAll().values().next().value!.code);
    expect(d2.data!.taskNodes).toHaveLength(1);
    expect(d2.data!.taskNodes[0].name).toBe('A');
  });

  it('服务端拒绝重复节点 code / 引用不存在节点的边（验证提交内容真实可落库）', () => {
    const api = new SimSchedulerApi();
    const dup = api.createWithTasks(PROJECT_CODE, {
      name: 'wf_dup',
      executionType: 'PARALLEL',
      timeout: 0,
      globalParams: [],
      nodes: [mkTaskNode(1, 'A'), mkTaskNode(1, 'B')],
      edges: [],
    });
    expect(dup.code).toBe(1);
    const dangling = api.createWithTasks(PROJECT_CODE, {
      name: 'wf_dangling',
      executionType: 'PARALLEL',
      timeout: 0,
      globalParams: [],
      nodes: [mkTaskNode(1, 'A')],
      edges: [{ id: 'e1', sourceCode: 1, targetCode: 999 }],
    });
    expect(dangling.code).toBe(1);
  });

  it('多个乱序 + 完全逆序提交后，最终依赖图与代码头声明完全一致', async () => {
    const allFiles = scanLocalFiles(PROJECT_ROOT);
    // 待提交任务文件：ads/code 下 21 个任务（公共工具类 utils/AdEtlUtils 不独立运行，ddl/文档不提交）
    const taskFiles = allFiles.filter(f =>
      f.relativePath.startsWith('ads/code/') && !f.relativePath.startsWith('ads/code/utils/'));
    expect(taskFiles.length).toBe(21);

    // 本地代码头依赖索引（模拟 scanLocalHeaderDependencies：包含全部代码文件）
    const localDeps = new Map<string, HeaderDependency[]>();
    for (const f of allFiles) {
      if (!localDeps.has(f.taskName)) localDeps.set(f.taskName, f.deps);
    }

    // 可复现随机乱序（多种子）+ 完全逆序
    const mulberry32 = (seed: number) => () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const orders: { label: string; order: number[] }[] = [];
    for (const seed of [42, 2026, 9527, 777, 314159]) {
      const rng = mulberry32(seed);
      const order = taskFiles.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      orders.push({ label: `随机乱序(seed=${seed})`, order });
    }
    orders.push({ label: '完全逆序', order: taskFiles.map((_, i) => taskFiles.length - 1 - i) });
    orders.push({ label: '正序', order: taskFiles.map((_, i) => i) });

    const results: { label: string; api: SimSchedulerApi; submittedOrder: string[] }[] = [];
    for (const { label, order } of orders) {
      const { api, submittedOrder } = await runSubmissionRound(taskFiles, order, localDeps, label);
      results.push({ label, api, submittedOrder });
    }

    // ===== 验证 1：接口闭环 — 每次更新提交前都 detail 拉取最新工作流定义 =====
    for (const { label, api } of results) {
      const updateCount = api.stats.updateCalls;
      // 21 次提交：新建 N 个工作流走 create，其余走 update；每次 update 前必然 detail 一次
      expect(api.stats.detailCalls, `[${label}] 更新提交次数=${updateCount} 但 detail 调用=${api.stats.detailCalls}`)
        .toBe(updateCount);
      expect(api.stats.listCalls, `[${label}] list 调用次数`).toBe(21);
      expect(api.stats.createCalls + updateCount, `[${label}] create+update 提交次数`).toBe(21);
    }

    // ===== 验证 2：每个工作流内每个任务的有效前置 == 代码头 @依赖 声明 =====
    const expectedDeps = new Map(taskFiles.map(f => [f.taskName, f.deps.map(d => sanitizeDsName(d.taskName)).sort()]));
    for (const { label, api } of results) {
      const index = buildIndex(api);
      const codeToTaskName = new Map<number, string>();
      for (const [name, hit] of index) codeToTaskName.set(hit.taskCode, name);
      for (const [wfName, wf] of api.listAll()) {
        const incomingByTarget = new Map<number, DSWorkflowEdge[]>();
        for (const e of wf.edges) {
          if (!incomingByTarget.has(e.targetCode)) incomingByTarget.set(e.targetCode, []);
          incomingByTarget.get(e.targetCode)!.push(e);
        }
        for (const node of wf.nodes) {
          if (node.taskType === 'DEPENDENT') continue;
          const incoming = incomingByTarget.get(node.code) || [];
          const effective: string[] = [];
          for (const e of incoming) {
            const src = wf.nodes.find(n => n.code === e.sourceCode)!;
            if (src.taskType === 'DEPENDENT') {
              const params = JSON.parse(src.taskParams) as { dependence: { dependTaskList: { dependItemList: { depTaskCode: number }[] }[] } };
              for (const item of params.dependence.dependTaskList.flatMap(g => g.dependItemList)) {
                effective.push(codeToTaskName.get(item.depTaskCode) || `code:${item.depTaskCode}`);
              }
            } else {
              effective.push(sanitizeDsName(src.name));
            }
          }
          expect(
            effective.sort(),
            `[${label}] 工作流 ${wfName} 任务 ${node.name} 的实际前置依赖与代码头声明不符`,
          ).toEqual(expectedDeps.get(sanitizeDsName(node.name)));
        }
        // 无环
        expect(findDependencyCycle(wf.nodes, wf.edges), `[${label}] 工作流 ${wfName} 存在依赖环`).toBeNull();
        // DEPENDENT 节点：命名符合 前置依赖_{任务名}，且恰有一条出边
        for (const node of wf.nodes.filter(n => n.taskType === 'DEPENDENT')) {
          expect(node.name.startsWith('前置依赖_'), `[${label}] 异常 DEPENDENT 节点名 ${node.name}`).toBe(true);
          const outEdges = wf.edges.filter(e => e.sourceCode === node.code);
          expect(outEdges.length, `[${label}] ${node.name} 出边数量`).toBe(1);
          const target = wf.nodes.find(n => n.code === outEdges[0].targetCode)!;
          expect(node.name, `[${label}] ${node.name} 指向的任务不符`).toBe(dependentNodeName(target.name));
        }
      }
      // 21 个任务全部提交到位
      const totalTasks = [...api.listAll().values()].flatMap(wf => wf.nodes.filter(n => n.taskType !== 'DEPENDENT'));
      expect(totalTasks.length, `[${label}] 提交后的任务总数`).toBe(21);
    }

    // ===== 验证 3：所有乱序的最终依赖图完全一致（顺序无关） =====
    const baseline = renderGraph(results[0].api, taskFiles).split('====SIG====')[1];
    for (const { label, api } of results.slice(1)) {
      const sig = renderGraph(api, taskFiles).split('====SIG====')[1];
      expect(sig, `[${label}] 最终依赖图与基线不一致`).toBe(baseline);
    }

    // ===== 输出提交顺序与最终依赖关系图 =====
    console.log('\n########## 乱序提交模拟结果 ##########');
    for (const { label, api, submittedOrder } of results) {
      console.log(`\n[${label}] 实际提交顺序（被阻塞的前置补齐后自动重试）:\n  ${submittedOrder.join(' -> ')}`);
      console.log(`  [接口闭环] list=${api.stats.listCalls} detail=${api.stats.detailCalls} create=${api.stats.createCalls} update=${api.stats.updateCalls}`);
    }
    console.log('\n########## 最终构建的依赖关系图（各乱序结果完全一致） ##########');
    console.log(renderGraph(results[0].api, taskFiles).split('====SIG====')[0]);
  }, 60000);
});
