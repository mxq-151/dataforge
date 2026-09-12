import type { DSTaskType, DSWorkflowTaskNode, DSWorkflowEdge, DSWorkflowGlobalParam, DSLocalParam, DSDependentTaskParams } from '../types/dolphinscheduler';
import { getDefaultTaskParams, ExecutionType, Priority, TASK_CATEGORIES, TASK_TYPE_LABELS } from '../types/dolphinscheduler';
import { parseFileHeader } from './index';
import { toRelativePath, normalizePath } from './pathUtils';

function extractCodePackage(code: string): string {
  const match = code.match(/^\s*package\s+([\w.]+)\s*;?\s*$/m);
  return match ? match[1] : '';
}

function extractCodeClassName(code: string, ext: string): string {
  if (ext === 'scala') {
    const match = code.match(/^\s*(?:object|class)\s+(\w+)/m);
    return match ? match[1] : '';
  } else {
    const match = code.match(/^\s*(?:public\s+)?(?:class|interface|enum)\s+(\w+)/m);
    return match ? match[1] : '';
  }
}

function inferMainClass(code: string, ext: string): string {
  const pkg = extractCodePackage(code);
  const cls = extractCodeClassName(code, ext);
  if (cls) return pkg ? `${pkg}.${cls}` : cls;
  return '';
}

/** 从代码正文中提取 YARN 作业名称（Spark/Flink/SQL/Hive/MR 等提交到 YARN 的任务）。
 * 支持的常见写法：
 *  - Spark/Scala/Java: SparkSession.builder.appName("xxx") / .setAppName("xxx")
 *  - PySpark: .appName("xxx") / spark.appName = "xxx"
 *  - spark-submit 参数: --conf spark.app.name=xxx / --name xxx
 *  - Flink/Scala/Java/PyFlink: env.execute("xxx") / env.executeAsync("xxx") / .setJobName("xxx")
 *  - Flink 配置/CLI: pipeline.name=xxx / -Dyarn.application.name=xxx / -ynm xxx
 *  - SQL/Hive/Spark-SQL/MR: set mapreduce.job.name=xxx / set tez.job.name=xxx
 *                           / set hive.query.name=xxx / set spark.app.name=xxx / set yarn.application.name=xxx
 * 返回 null 表示代码中未显式设置 YARN 作业名称。
 */
export function extractYarnJobName(code: string): string | null {
  const patterns: RegExp[] = [
    // 1. .setAppName("x") / .appName("x")（Spark builder）
    /\.(?:setAppName|appName)\s*\(\s*["']([^"']+)["']\s*\)/,
    // 2. spark.conf.set("spark.app.name", "x") / .set("spark.app.name","x")
    /\.(?:conf\.)?set\s*\(\s*["']spark\.app\.name["']\s*,\s*["']([^"']+)["']\s*\)/,
    // 3. Flink 作业名: env.execute("x") / env.executeAsync("x") / .setJobName("x")
    //    仅匹配环境对象（env/tEnv/tableEnv/...），避免命中 jdbc statement.execute("SELECT...") 等
    /\b(?:env|tEnv|tableEnv|streamEnv|executionEnv|tableEnvironment|sEnv|senv)\s*\.\s*(?:execute(?:Async)?|setJobName)\s*\(\s*["']([^"']+)["']\s*\)/,
    // 4. spark-submit 参数: --conf spark.app.name=x
    /--conf\s+spark\.app\.name\s*=\s*["']?([^"'\s]+)/,
    // 5. spark-submit / flink run 参数: --name x
    /(?:^|\s)--name\s+["']?([^"'\s]+)/,
    // 6. Flink on YARN: -Dyarn.application.name=x / -ynm x
    /-Dyarn\.application\.name\s*=\s*["']?([^"'\s]+)/,
    /(?:^|\s)-ynm\s+["']?([^"'\s]+)/,
    // 7. 配置式赋值: spark.app.name = "x"
    /spark\.app\.name\s*[:=]\s*["']([^"']+)["']/,
    // 8. PySpark 属性式: spark.appName = "x" / .appName = "x"
    /\.?\bappName\s*[:=]\s*["']([^"']+)["']/,
    // 9. SQL/Hive/Spark-SQL/MR 中以 set 形式声明作业名（行首 set）
    /(?:^|\n)\s*set\s+(?:spark\.app\.name|mapreduce\.job\.name|mapred\.job\.name|tez\.job\.name|hive\.query\.name|yarn\.application\.name|pipeline\.name)\s*=\s*["']?([^"';]+)\s*["']?\s*;?/i,
    // 10. Flink pipeline.name 赋值（属性/配置）
    /pipeline\.name\s*[:=]\s*["']?([^"'\s]+)/,
  ];
  for (const re of patterns) {
    const m = code.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

export interface YarnJobNameValidation {
  valid: boolean;
  message: string;
  yarnJobName: string | null;
  fileName: string;
}

/** 校验代码中设置的 YARN 作业名称是否与文件名（不含扩展名）一致。
 * 仅当代码显式设置了 YARN 作业名称时才进行比对；未设置则视为无需校验（valid=true）。
 */
export function validateYarnJobName(
  code: string,
  fileName: string,
): YarnJobNameValidation {
  const fileStem = fileName.replace(/\.[^.]+$/, '');
  const yarnJobName = extractYarnJobName(code);

  if (!yarnJobName) {
    return { valid: true, message: '', yarnJobName: null, fileName: fileStem };
  }

  if (yarnJobName === fileStem) {
    return { valid: true, message: '', yarnJobName, fileName: fileStem };
  }

  return {
    valid: false,
    message: `代码中设置的 YARN 作业名称「${yarnJobName}」与文件名「${fileStem}」不一致，请修改其中之一使两者保持一致后再运行/提交`,
    yarnJobName,
    fileName: fileStem,
  };
}

export interface CodeFileMapping {
  recommendedTaskType: DSTaskType;
  recommendationReason: string;
  taskType: DSTaskType;
  taskName: string;
  workflowName: string;
  taskParams: Record<string, unknown>;
  description: string;
  filePath: string;
  relativePath: string;
  dirPath: string;
  dataSource: string | null;
  dataDependencies: string[];
  /** 代码头 @依赖 声明的前置任务依赖（{调度项目}.{前置任务名称}，前置任务名称不含文件扩展名） */
  headerDependencies: HeaderDependency[];
}

/**
 * 代码头 @依赖 的前置任务引用。
 * 格式：{调度项目}.{前置任务名称}，多个用英文逗号分隔。
 */
export interface HeaderDependency {
  /** 调度项目（也即项目编码） */
  projectCode: string;
  /** 前置任务名称（不含文件扩展名） */
  taskName: string;
}

/**
 * 解析代码头 @依赖 的值（逗号分隔的 {调度项目}.{前置任务名称}）。
 * - 空值、"无"、非法项会被忽略；同一 {调度项目}.{任务名称} 只保留一次。
 */
export function parseDependencyHeader(value: string | null | undefined): HeaderDependency[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed || trimmed === '无') return [];
  const deps: HeaderDependency[] = [];
  const seen = new Set<string>();
  for (const raw of trimmed.split(',')) {
    const token = raw.trim();
    if (!token || token === '无') continue;
    const dotIdx = token.indexOf('.');
    const projectCode = dotIdx >= 0 ? token.slice(0, dotIdx).trim() : '';
    const taskName = dotIdx >= 0 ? token.slice(dotIdx + 1).trim() : token.trim();
    if (!taskName) continue;
    const key = `${projectCode}.${taskName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deps.push({ projectCode, taskName });
  }
  return deps;
}

/** 已解析并确认存在的前置任务（对应调度项目内的某个工作流任务） */
export interface ResolvedDependency {
  /** 调度项目 code（数值） */
  projectCode: number;
  /** 前置任务所在工作流定义 code */
  definitionCode: number;
  /** 前置任务节点 code */
  taskCode: number;
  /** 前置任务名称 */
  taskName: string;
  /** 展示用 label：{调度项目}.{前置任务名称} */
  label: string;
}

/**
 * 将自定义 jar 依赖拼接为 --jars 参数值（多个以逗号连接）。
 * - 有 basePath：`basePath(尾斜杠判断) + jarPath(去前导斜杠)`（后端 SparkExecutionStrategy 语义）。
 * - 无 basePath（旧兼容）：jarPath 以 .jar 结尾视为完整文件路径直接使用；否则 jarPath(去尾斜杠) + '/' + (jarName||name)。
 * - 忽略无 jarPath 或无处名的条目。
 */
export function buildJarsArg(
  deps: { jarPath?: string; basePath?: string; jarName?: string; name?: string }[],
): string {
  const args: string[] = [];
  for (const d of deps) {
    if (!d.jarPath || !d.jarPath.trim()) continue;

    if (d.basePath) {
      const base = d.basePath.endsWith('/') ? d.basePath : `${d.basePath}/`;
      const path = d.jarPath.replace(/^\/+/, '');
      args.push(`${base}${path}`);
      continue;
    }

    if (d.jarPath.toLowerCase().endsWith('.jar')) {
      args.push(d.jarPath);
      continue;
    }
    const file = (d.jarName || d.name || '').trim();
    if (!file) continue;
    const dir = d.jarPath.endsWith('/') ? d.jarPath.replace(/\/+$/, '') : d.jarPath;
    args.push(`${dir}/${file}`);
  }
  return args.join(',');
}

/**
 * 根据已解析的前置任务构建一个 DEPENDENT 任务节点，用于设置跨工作流的前置依赖。
 * 生成的节点参数为 AND 关系、任一前置失败则失败、每 10s 轮询。DolphinScheduler 据此
 * 在运行前等待所有引用任务成功完成。
 */
export function buildDependentTaskNode(
  deps: ResolvedDependency[],
  code: number,
  x?: number,
  y?: number,
  name?: string,
): DSWorkflowTaskNode {
  const taskParams: DSDependentTaskParams = {
    dependence: {
      relation: 'AND',
      dependTaskList: [
        {
          relation: 'AND',
          dependItemList: deps.map(d => ({
            projectCode: d.projectCode,
            definitionCode: d.definitionCode,
            depTaskCode: d.taskCode,
            cycle: 'day',
            dateValue: 'today',
          })),
        },
      ],
      failurePolicy: 'DEPENDENT_FAILURE_FAILURE',
      // 扩展字段（DS 允许额外字段）
      checkInterval: 10,
      failureWaitingTime: 0,
    },
  };
  return {
    code,
    name: name ?? '前置依赖',
    taskType: 'DEPENDENT',
    description: `等待前置任务完成: ${deps.map(d => d.label).join(', ')}`,
    taskParams: JSON.stringify(taskParams),
    flag: 'YES',
    taskPriority: Priority.MEDIUM,
    workerGroup: 'default',
    environmentCode: -1,
    failRetryTimes: 0,
    failRetryInterval: 1,
    timeoutFlag: 'CLOSE',
    timeout: 0,
    delayTime: 0,
    x: x ?? 100,
    y: y ?? 100,
  };
}

/** 任务专属前置依赖（DEPENDENT）节点名：前置依赖_{任务名}，与旧版共享节点「前置依赖」区分 */
export function dependentNodeName(taskName: string): string {
  return `前置依赖_${sanitizeDsName(taskName)}`;
}

/**
 * 依赖关系重建上下文：提交调度时以「工作流全量节点/边 + 本地代码头 @依赖」为唯一事实来源，
 * 重建工作流内各任务的依赖关系。任务是一个个提交的、没有全局视角，因此每次提交都拉取
 * 工作流当前全量节点与依赖边，与本地文件代码头声明的依赖对比后整体重建，避免：
 * - 新任务被无条件串行连接到工作流最后一个任务（A->B、C->D 变成 A->B->C->D）；
 * - 多个任务共享同一个「前置依赖」DEPENDENT 节点导致依赖被后提交的任务覆盖；
 * - 提交无依赖任务时误删其他任务仍在使用的前置依赖节点。
 */
export interface WorkflowDependencyReconcileContext {
  /** 工作流节点（已包含本次提交的主任务：同名原地替换或新追加） */
  nodes: DSWorkflowTaskNode[];
  /** 工作流现有边 */
  edges: DSWorkflowEdge[];
  /** 本地代码文件头 @依赖：sanitizeDsName(任务名) -> 依赖声明（本次提交文件以编辑器实时内容为准） */
  localHeaderDeps: Map<string, HeaderDependency[]>;
  /** 本次提交任务名（sanitizeDsName 后）：重建时优先处理，便于配合网格槽位安排 */
  mainTaskName: string;
  /** 已解析的前置依赖（label -> 解析结果），通常为本次提交任务已校验通过的 @依赖 */
  resolvedLabels: Map<string, ResolvedDependency>;
  /** 按需解析其余跨工作流/跨项目前置任务：传入待解析 label 集合，返回 label -> 解析结果 */
  resolveExternalDeps: (labels: Set<string>) => Promise<Map<string, ResolvedDependency>>;
  /** 分配新节点 code（须大于工作流现有全部 code） */
  allocateCode: () => number;
  /** 分配新节点网格槽位坐标 */
  nextSlot: () => { x: number; y: number };
}

export interface WorkflowDependencyReconcileResult {
  nodes: DSWorkflowTaskNode[];
  edges: DSWorkflowEdge[];
  /** 重建过程中的告警（前置任务不存在、自依赖等），不阻断提交 */
  warnings: string[];
  /** 重建摘要：每个被重建任务的直接前置（同工作流边）与专属前置依赖节点 */
  rebuilt: { taskName: string; directFrom: string[]; dependentNode: string | null }[];
}

/**
 * 按本地代码头 @依赖 重建工作流依赖关系：
 * 1. 找出工作流中与本地文件同名的任务节点（含本次提交任务）作为重建目标；
 * 2. 每个目标的依赖声明解析为两类——
 *    a. 同工作流前置任务：直接建立 源任务 -> 目标任务 的边；
 *    b. 跨工作流/跨项目前置任务：建立/复用目标任务专属的 DEPENDENT 节点（前置依赖_{任务名}）；
 * 3. 丢弃重建目标的全部原有入边（含旧的串行边、共享前置依赖节点的边），按上述期望重建；
 * 4. 工作流中与本地文件不匹配的任务（用户手工维护等）保持原有边不变；
 * 5. 清理不再被任何任务引用的孤儿 DEPENDENT 节点（含旧版共享「前置依赖」节点）。
 */
export async function reconcileWorkflowDependencies(
  ctx: WorkflowDependencyReconcileContext,
): Promise<WorkflowDependencyReconcileResult> {
  const warnings: string[] = [];
  let nodes: DSWorkflowTaskNode[] = ctx.nodes.map(n => ({ ...n }));

  const nameOf = (n: DSWorkflowTaskNode) => sanitizeDsName(n.name);
  const labelOf = (d: HeaderDependency) => [d.projectCode, d.taskName].filter(Boolean).join('.');

  // 重建目标：非 DEPENDENT 且存在同名本地代码文件的任务节点；本次提交任务排在最前
  const targets = nodes
    .filter(n => n.taskType !== 'DEPENDENT' && ctx.localHeaderDeps.has(nameOf(n)))
    .sort((a, b) => {
      if (nameOf(a) === ctx.mainTaskName) return -1;
      if (nameOf(b) === ctx.mainTaskName) return 1;
      return 0;
    });
  const targetCodes = new Set(targets.map(t => t.code));

  const nodeByName = new Map<string, DSWorkflowTaskNode>();
  for (const n of nodes) {
    if (!nodeByName.has(nameOf(n))) nodeByName.set(nameOf(n), n);
  }

  // 计算每个目标的期望依赖：同工作流直接前置 + 待解析的跨工作流依赖
  interface Desired {
    node: DSWorkflowTaskNode;
    directSources: DSWorkflowTaskNode[];
    externals: HeaderDependency[];
  }
  const desiredList: Desired[] = [];
  const unresolvedLabels = new Set<string>();
  for (const t of targets) {
    const deps = ctx.localHeaderDeps.get(nameOf(t)) || [];
    const directSources: DSWorkflowTaskNode[] = [];
    const externals: HeaderDependency[] = [];
    for (const dep of deps) {
      const src = nodeByName.get(sanitizeDsName(dep.taskName));
      if (src && src.taskType !== 'DEPENDENT') {
        if (src.code === t.code) {
          warnings.push(`任务「${t.name}」的代码头 @依赖 声明了自身，已忽略该依赖`);
        } else {
          directSources.push(src);
        }
      } else {
        externals.push(dep);
        unresolvedLabels.add(labelOf(dep));
      }
    }
    desiredList.push({ node: t, directSources, externals });
  }

  // 解析跨工作流依赖：优先复用已解析结果，其余按需调用外部解析器
  const resolutions = new Map(ctx.resolvedLabels);
  const missingLabels = [...unresolvedLabels].filter(l => !resolutions.has(l));
  if (missingLabels.length > 0) {
    try {
      const external = await ctx.resolveExternalDeps(new Set(missingLabels));
      external.forEach((v, k) => resolutions.set(k, v));
    } catch { /* 解析失败时按未找到处理 */ }
  }

  // 每个目标 upsert 专属 DEPENDENT 节点（无跨工作流依赖时移除旧专属节点）
  const rebuilt: WorkflowDependencyReconcileResult['rebuilt'] = [];
  const depNodeByTarget = new Map<number, DSWorkflowTaskNode | null>();
  for (const d of desiredList) {
    const extRes: ResolvedDependency[] = [];
    for (const dep of d.externals) {
      const hit = resolutions.get(labelOf(dep));
      if (hit) {
        extRes.push(hit);
      } else {
        warnings.push(`任务「${d.node.name}」的前置任务「${labelOf(dep)}」在调度项目中不存在，未建立该依赖`);
      }
    }

    let depNode: DSWorkflowTaskNode | null = null;
    const dn = dependentNodeName(d.node.name);
    if (extRes.length > 0) {
      const existingIdx = nodes.findIndex(n => n.taskType === 'DEPENDENT' && nameOf(n) === dn);
      if (existingIdx >= 0) {
        // 复用既有专属节点：保留 code/坐标/版本，仅替换依赖内容
        const old = nodes[existingIdx];
        depNode = { ...buildDependentTaskNode(extRes, old.code, old.x, old.y, dn), id: old.id, version: old.version };
        nodes[existingIdx] = depNode;
      } else {
        const pos = ctx.nextSlot();
        depNode = buildDependentTaskNode(extRes, ctx.allocateCode(), pos.x, pos.y, dn);
        nodes.push(depNode);
      }
    } else {
      // 无跨工作流依赖：移除该任务残留的专属前置依赖节点
      nodes = nodes.filter(n => !(n.taskType === 'DEPENDENT' && nameOf(n) === dn));
    }
    depNodeByTarget.set(d.node.code, depNode);
    rebuilt.push({
      taskName: d.node.name,
      directFrom: d.directSources.map(s => s.name),
      dependentNode: depNode ? depNode.name : null,
    });
  }

  // 重建边：丢弃重建目标的全部原有入边（旧串行边/共享前置依赖边/过期依赖边），
  // 未重建任务的边原样保留（保留 conditionType/conditionParams 等既有属性），并剔除悬空边
  const finalEdges: DSWorkflowEdge[] = [];
  const seenEdge = new Set<string>();
  const pushEdge = (base: DSWorkflowEdge) => {
    const key = `${base.sourceCode}->${base.targetCode}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    finalEdges.push(base);
  };
  const nodeCodes = new Set(nodes.map(n => n.code));
  for (const e of ctx.edges) {
    if (targetCodes.has(e.targetCode)) continue;
    if (!nodeCodes.has(e.sourceCode) || !nodeCodes.has(e.targetCode)) continue;
    pushEdge(e);
  }
  for (const d of desiredList) {
    for (const s of d.directSources) {
      pushEdge({ id: `e_${s.code}_${d.node.code}`, sourceCode: s.code, targetCode: d.node.code });
    }
    const depNode = depNodeByTarget.get(d.node.code);
    if (depNode) {
      pushEdge({ id: `e_${depNode.code}_${d.node.code}`, sourceCode: depNode.code, targetCode: d.node.code });
    }
  }

  // 清理孤儿 DEPENDENT 节点：重建后不再有任何出边（含旧版共享「前置依赖」节点）
  const sourcesSet = new Set(finalEdges.map(e => e.sourceCode));
  const orphanCodes = new Set(
    nodes.filter(n => n.taskType === 'DEPENDENT' && !sourcesSet.has(n.code)).map(n => n.code),
  );
  if (orphanCodes.size > 0) {
    nodes = nodes.filter(n => !orphanCodes.has(n.code));
  }

  return { nodes, edges: finalEdges, warnings, rebuilt };
}

/**
 * 检测工作流依赖关系中的环（按节点 code 深度优先搜索）。
 * 返回构成环的任务名路径（如 ['A', 'B', 'A']），无环时返回 null。
 */
export function findDependencyCycle(
  nodes: DSWorkflowTaskNode[],
  edges: DSWorkflowEdge[],
): string[] | null {
  const adj = new Map<number, number[]>();
  for (const e of edges) {
    if (!adj.has(e.sourceCode)) adj.set(e.sourceCode, []);
    adj.get(e.sourceCode)!.push(e.targetCode);
  }
  const nameByCode = new Map<number, string>(nodes.map(n => [n.code, n.name] as const));
  const color = new Map<number, 0 | 1 | 2>();
  const path: number[] = [];

  const dfs = (u: number): number[] | null => {
    color.set(u, 1);
    path.push(u);
    for (const v of adj.get(u) || []) {
      const c = color.get(v) ?? 0;
      if (c === 1) {
        const start = path.indexOf(v);
        return [...path.slice(start), v];
      }
      if (c === 0) {
        const cycle = dfs(v);
        if (cycle) return cycle;
      }
    }
    color.set(u, 2);
    path.pop();
    return null;
  };

  for (const n of nodes) {
    if ((color.get(n.code) ?? 0) === 0) {
      const cycle = dfs(n.code);
      if (cycle) {
        return cycle.map(c => nameByCode.get(c) || String(c));
      }
    }
  }
  return null;
}

/** 工作流 DAG 节点分层布局常量：横向间距 450 / 纵向间距 260，均大于节点尺寸（约 270x110），保证节点不紧挨。 */
export const GRID_START_X = 300;
export const GRID_START_Y = 140;
export const GRID_GAP_X = 450;
export const GRID_GAP_Y = 260;

/**
 * 按工作流依赖关系对节点做分层布局（自左向右 = 自前向后的数据流）：
 * 以「最长路径」为每个节点计算层号，凡存在依赖边 前置任务 -> 后置任务
 * （含「前置依赖_任务名」DEPENDENT 节点 -> 目标任务），前置任务所在层恒小于后置任务所在层，
 * 从而保证任一前置节点（含前置依赖节点）总在对应的依赖节点左侧。
 * - x = 起始X + 层号 * 横向间距，因此相邻层节点自动保持最小横向间距；
 * - 同一层内按原 y 排序后自上而下均匀放置，纵向间距固定，避免同层多个节点重叠/紧挨。
 * 该函数就地修改传入 nodes 的 x / y。
 */
export function layoutWorkflowByDependency(
  nodes: DSWorkflowTaskNode[],
  edges: DSWorkflowEdge[],
): void {
  if (nodes.length === 0) return;

  // 前驱邻接表（按边 源->目标 构建，用于计算每个节点的最深依赖层）
  const pred = new Map<number, number[]>();
  for (const n of nodes) pred.set(n.code, []);
  for (const e of edges) {
    if (pred.has(e.sourceCode) && pred.has(e.targetCode)) {
      pred.get(e.targetCode)!.push(e.sourceCode);
    }
  }

  const layerMemo = new Map<number, number>();
  // 环保护：依赖成环时 layerOf 会沿前驱无限递归（栈溢出）。遇到正在计算中的节点直接
  // 返回 0 截断这一支；无环输入（唯一受支持的输入）下行为与之前完全一致。
  const inProgress = new Set<number>();
  const layerOf = (code: number): number => {
    const cached = layerMemo.get(code);
    if (cached !== undefined) return cached;
    if (inProgress.has(code)) return 0;
    inProgress.add(code);
    let l = 0;
    for (const p of pred.get(code) || []) l = Math.max(l, layerOf(p) + 1);
    inProgress.delete(code);
    layerMemo.set(code, l);
    return l;
  };

  const byLayer = new Map<number, DSWorkflowTaskNode[]>();
  for (const n of nodes) {
    const l = layerOf(n.code);
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(n);
  }

  for (const [l, group] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = group.slice().sort((a, b) => a.y - b.y || a.x - b.x || a.code - b.code);
    const x = GRID_START_X + l * GRID_GAP_X;
    sorted.forEach((n, i) => {
      n.x = x;
      n.y = GRID_START_Y + i * GRID_GAP_Y;
    });
  }
}

export interface SavedConfig {
  dependencies: { id: string; name: string; version: string; source?: string; jarPath?: string; groupId?: string; scope?: string; autoChoose?: number | null; basePath?: string }[];
  programParams: { id: string; key: string; value: string }[];
  taskParams: { id: string; key: string; value: string }[];
}

const EXT_TO_TASK_TYPE: Record<string, DSTaskType> = {
  sql: 'SQL',
  py: 'PYTHON',
  sh: 'SHELL',
  bash: 'SHELL',
};

const ENGINE_REQUIRED_EXTS = new Set(['java', 'scala']);

const ENGINE_TO_TASK_TYPE: Record<string, DSTaskType> = {
  mysql: 'SQL',
  postgresql: 'SQL',
  hive: 'SQL',
  kyuubi: 'SQL',
  clickhouse: 'SQL',
  doris: 'SQL',
  starrocks: 'SQL',
  presto: 'SQL',
  trino: 'SQL',
  spark: 'SPARK',
  flink: 'FLINK',
  flink_stream: 'FLINK_STREAM',
  mr: 'MR',
  mapreduce: 'MR',
  python: 'PYTHON',
  shell: 'SHELL',
  java: 'JAVA',
  procedure: 'PROCEDURE',
  http: 'HTTP',
  datax: 'DATAX',
  sqoop: 'SQOOP',
  seatunnel: 'SEATUNNEL',
  hivecli: 'HIVECLI',
  dinky: 'DINKY',
  linkis: 'LINKIS',
};

export interface TaskTypeRecommendation {
  taskType: DSTaskType;
  reason: string;
}

function getRecommendedTaskType(fileName: string, codeContent: string): TaskTypeRecommendation {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const header = parseFileHeader(codeContent);

  if (ENGINE_REQUIRED_EXTS.has(ext)) {
    if (header?.engine) {
      const engineLower = header.engine.toLowerCase();
      if (ENGINE_TO_TASK_TYPE[engineLower]) {
        return {
          taskType: ENGINE_TO_TASK_TYPE[engineLower],
          reason: `根据 @引擎:${header.engine} 推荐`,
        };
      }
    }
    return {
      taskType: 'SPARK',
      reason: `${ext.toUpperCase()} 文件未声明 @引擎，默认推荐 SPARK（请在代码头添加 @引擎: spark/flink/mr 等指定运行引擎）`,
    };
  }

  const extTaskType: DSTaskType = EXT_TO_TASK_TYPE[ext] || 'SHELL';

  if (header?.engine) {
    const engineLower = header.engine.toLowerCase();
    if (ENGINE_TO_TASK_TYPE[engineLower]) {
      return {
        taskType: ENGINE_TO_TASK_TYPE[engineLower],
        reason: `根据 @引擎:${header.engine} 推荐`,
      };
    }
  }

  return {
    taskType: extTaskType,
    reason: `根据文件扩展名 .${ext} 推荐`,
  };
}

export function getAvailableTaskTypes(): { value: DSTaskType; label: string; category: string }[] {
  const result: { value: DSTaskType; label: string; category: string }[] = [];
  for (const cat of TASK_CATEGORIES) {
    for (const t of cat.tasks) {
      result.push({ value: t, label: TASK_TYPE_LABELS[t], category: cat.label });
    }
  }
  return result;
}

export function mapCodeFileToTask(
  fileName: string,
  codeContent: string,
  filePath?: string,
  rootPath?: string,
  savedConfig?: SavedConfig | null,
  overrideTaskType?: DSTaskType,
): CodeFileMapping {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const header = parseFileHeader(codeContent);
  const recommendation = getRecommendedTaskType(fileName, codeContent);
  const recommendedTaskType = recommendation.taskType;
  const taskType = overrideTaskType || recommendedTaskType;

  const relativePath = getRelativePath(filePath, rootPath);
  const dirPath = getDirectoryPath(relativePath);
  // 任务名称只取文件名部分（不含目录、不含扩展名），作为调度任务节点名；
  // 工作流名称取目录路径，斜杠/反斜杠统一替换为下划线，保证 DS 名称合法
  const taskName = fileName.replace(/\.[^.]+$/, '');
  const workflowName = (dirPath || fileName.replace(/\.[^.]+$/, '')).replace(/[/\\]/g, '_');

  const baseParams = getDefaultTaskParams(taskType);
  const codeBody = stripFileHeader(codeContent);

  switch (taskType) {
    case 'SQL': {
      const sqlType = detectSqlType(codeBody);
      baseParams.sql = codeBody;
      baseParams.sqlType = sqlType;
      baseParams.type = mapEngineToDatasourceType(header?.engine || '');
      break;
    }
    case 'PYTHON': {
      baseParams.rawScript = codeBody;
      applyRuntimeParams(baseParams, savedConfig, 'PYTHON');
      break;
    }
    case 'SHELL': {
      baseParams.rawScript = codeBody;
      applyRuntimeParams(baseParams, savedConfig, 'SHELL');
      break;
    }
    case 'SPARK': {
      baseParams.rawScript = codeBody;
      const inferredMainClass = inferMainClass(codeContent, ext);
      if (inferredMainClass) {
        baseParams.mainClass = inferredMainClass;
        baseParams.appName = inferredMainClass;
      }
      if (ext === 'scala') {
        baseParams.programType = 'SCALA';
        baseParams.sqlExecutionType = 'SCRIPT';
      } else if (ext === 'py') {
        baseParams.programType = 'PYTHON';
      } else if (ext === 'sql') {
        baseParams.programType = 'SQL';
        baseParams.sqlExecutionType = 'SCRIPT';
      } else if (ext === 'java') {
        baseParams.programType = 'JAVA';
      } else {
        baseParams.programType = 'SCALA';
      }
      applyRuntimeParams(baseParams, savedConfig, 'SPARK');
      break;
    }
    case 'FLINK': {
      baseParams.rawScript = codeBody;
      const inferredMainClass = inferMainClass(codeContent, ext);
      if (inferredMainClass) {
        baseParams.mainClass = inferredMainClass;
        baseParams.appName = inferredMainClass;
      }
      if (ext === 'java') {
        baseParams.programType = 'JAVA';
      } else if (ext === 'py') {
        baseParams.programType = 'PYTHON';
      } else if (ext === 'sql') {
        baseParams.programType = 'SQL';
      } else if (ext === 'scala') {
        baseParams.programType = 'SCALA';
      } else {
        baseParams.programType = 'JAVA';
      }
      applyRuntimeParams(baseParams, savedConfig, 'FLINK');
      break;
    }
    case 'FLINK_STREAM': {
      baseParams.rawScript = codeBody;
      const inferredMainClass = inferMainClass(codeContent, ext);
      if (inferredMainClass) {
        baseParams.mainClass = inferredMainClass;
        baseParams.appName = inferredMainClass;
      }
      if (ext === 'java') {
        baseParams.programType = 'JAVA';
      } else if (ext === 'py') {
        baseParams.programType = 'PYTHON';
      } else if (ext === 'scala') {
        baseParams.programType = 'SCALA';
      } else {
        baseParams.programType = 'JAVA';
      }
      applyRuntimeParams(baseParams, savedConfig, 'FLINK_STREAM');
      break;
    }
    case 'MR': {
      const inferredMainClass = inferMainClass(codeContent, ext);
      if (inferredMainClass) {
        baseParams.mainClass = inferredMainClass;
        baseParams.appName = inferredMainClass;
      }
      if (ext === 'java') {
        baseParams.programType = 'JAVA';
      } else if (ext === 'scala') {
        baseParams.programType = 'SCALA';
      } else if (ext === 'py') {
        baseParams.programType = 'PYTHON';
      } else {
        baseParams.programType = 'JAVA';
      }
      applyRuntimeParams(baseParams, savedConfig, 'MR');
      break;
    }
    case 'JAVA': {
      const inferredMainClass = inferMainClass(codeContent, ext);
      if (inferredMainClass) baseParams.mainClass = inferredMainClass;
      applyRuntimeParams(baseParams, savedConfig, 'JAVA');
      break;
    }
    case 'HIVECLI': {
      baseParams.hiveSql = codeBody;
      baseParams.hiveCliTaskExecutionType = 'SCRIPT';
      break;
    }
    default: {
      if ('rawScript' in baseParams) {
        (baseParams as Record<string, unknown>).rawScript = codeBody;
      }
      applyRuntimeParams(baseParams, savedConfig, taskType);
      break;
    }
  }

  const dataDependencies = extractDataDependencies(codeContent, header);
  const headerDependencies = parseDependencyHeader(header?.dependency);

  return {
    recommendedTaskType,
    recommendationReason: recommendation.reason,
    taskType,
    taskName,
    workflowName,
    taskParams: baseParams,
    description: header?.remark || `从开发助手提交: ${relativePath || fileName}`,
    filePath: filePath || fileName,
    relativePath,
    dirPath,
    dataSource: header?.dataSource || null,
    dataDependencies,
    headerDependencies,
  };
}

function applyRuntimeParams(
  taskParams: Record<string, unknown>,
  savedConfig: SavedConfig | null | undefined,
  taskType: DSTaskType | string,
) {
  if (!savedConfig) return;

  const localParams: DSLocalParam[] = [];
  for (const p of savedConfig.programParams) {
    if (p.key) {
      localParams.push({
        prop: p.key,
        direct: 'IN',
        type: 'VARCHAR',
        value: p.value,
      });
    }
  }

  if (localParams.length > 0) {
    const existing = (taskParams.localParams as DSLocalParam[]) || [];
    taskParams.localParams = [...existing, ...localParams];
  }

  if (taskType === 'SPARK' || taskType === 'FLINK') {
    for (const p of savedConfig.taskParams) {
      if (!p.key) continue;
      const keyLower = p.key.toLowerCase();
      if (keyLower.includes('driver') && keyLower.includes('memory') && taskType === 'SPARK') {
        taskParams.driverMemory = p.value;
      } else if (keyLower.includes('executor') && keyLower.includes('memory') && taskType === 'SPARK') {
        taskParams.executorMemory = p.value;
      } else if (keyLower.includes('executor') && keyLower.includes('cores') && taskType === 'SPARK') {
        taskParams.executorCores = Number(p.value) || 2;
      } else if (keyLower.includes('num') && keyLower.includes('executor') && taskType === 'SPARK') {
        taskParams.numExecutors = Number(p.value) || 2;
      } else if (keyLower.includes('parallelism') && taskType === 'FLINK') {
        taskParams.parallelism = Number(p.value) || 1;
      } else if (keyLower.includes('jobmanager') && keyLower.includes('memory') && taskType === 'FLINK') {
        taskParams.jobManagerMemory = p.value;
      } else if (keyLower.includes('taskmanager') && keyLower.includes('memory') && taskType === 'FLINK') {
        taskParams.taskManagerMemory = p.value;
      } else if (keyLower.includes('deploy') && keyLower.includes('mode')) {
        taskParams.deployMode = p.value;
      } else if (keyLower.includes('queue') || keyLower.includes('yarnqueue')) {
        if (taskType === 'SPARK') taskParams.yarnQueue = p.value;
        else if (taskType === 'FLINK') taskParams.yarnQueue = p.value;
      }
    }
  }

  // --jars 不在本函数注入：避免进入提交弹窗「其他参数」输入框，改由 SubmitToSchedulerModal 提交时 buildJarsArg 动态拼接。
  // 依赖（jarDependencyCatalogs）也不应回填到 Spark 任务的 resourceList，提交时仅由 buildJarsArg 生成 --jars 与 classpath 相关参数。
}

function extractDataDependencies(codeContent: string, header: ReturnType<typeof parseFileHeader>): string[] {
  const deps = new Set<string>();

  if (header?.dataSource) {
    deps.add(header.dataSource);
  }

  const dsMatch = codeContent.match(/(?:--|\/\/|#)\s*@数据源[:\s=]+(\S+)/i);
  if (dsMatch) deps.add(dsMatch[1]);

  const useMatches = codeContent.matchAll(/(?:use|@use)\s+(\w+)/gi);
  for (const m of useMatches) {
    if (m[1]) deps.add(m[1]);
  }

  const fromMatches = codeContent.matchAll(/\bfrom\s+(\w+)/gi);
  for (const m of fromMatches) {
    if (m[1] && !['select', 'where', 'dual'].includes(m[1].toLowerCase())) {
      deps.add(m[1]);
    }
  }

  const insertMatches = codeContent.matchAll(/\binsert\s+into\s+(\w+)/gi);
  for (const m of insertMatches) {
    if (m[1]) deps.add(m[1]);
  }

  return Array.from(deps);
}

function getRelativePath(filePath?: string, rootPath?: string): string {
  if (!filePath) return '';
  if (!rootPath) return filePath.split(/[/\\]/).pop() || filePath;
  // 忽略分隔符差异：跳转打开的 Tab 路径是 Windows 本地形式（C:\a\b.java），
  // 而 rootPath 由 joinPath 拼成（C:/a）。直接 startsWith 会取不到相对路径。
  return toRelativePath(filePath, rootPath);
}

function getDirectoryPath(relativePath: string): string {
  if (!relativePath) return '';
  const lastSlash = Math.max(relativePath.lastIndexOf('/'), relativePath.lastIndexOf('\\'));
  if (lastSlash <= 0) return '';
  return relativePath.substring(0, lastSlash);
}

function stripFileHeader(content: string): string {
  const lines = content.split('\n');
  const codeLines: string[] = [];
  let headerEnded = false;

  for (const line of lines) {
    if (!headerEnded) {
      const trimmed = line.trim();
      if (
        trimmed.startsWith('--') ||
        trimmed.startsWith('//') ||
        trimmed.startsWith('#')
      ) {
        if (trimmed.match(/@\S+:/)) {
          continue;
        }
      }
      headerEnded = true;
    }
    if (headerEnded) {
      codeLines.push(line);
    }
  }

  return codeLines.join('\n').trim();
}

function detectSqlType(sql: string): '0' | '1' {
  const upper = sql.trim().toUpperCase();
  if (
    upper.startsWith('SELECT') ||
    upper.startsWith('WITH') ||
    upper.startsWith('SHOW') ||
    upper.startsWith('DESC') ||
    upper.startsWith('EXPLAIN')
  ) {
    return '0';
  }
  return '1';
}

function mapEngineToDatasourceType(engine: string): string {
  const map: Record<string, string> = {
    mysql: 'MYSQL',
    postgresql: 'POSTGRESQL',
    hive: 'HIVE',
    kyuubi: 'HIVE',
    clickhouse: 'CLICKHOUSE',
    doris: 'MYSQL',
    starrocks: 'MYSQL',
    presto: 'PRESTO',
    trino: 'PRESTO',
    oracle: 'ORACLE',
    sqlserver: 'SQLSERVER',
    db2: 'DB2',
  };
  return map[engine.toLowerCase()] || 'MYSQL';
}

export function buildWorkflowFromCodeFile(
  mapping: CodeFileMapping,
  workflowDescription: string,
): {
  name: string;
  description: string;
  executionType: ExecutionType;
  timeout: number;
  globalParams: DSWorkflowGlobalParam[];
  nodes: DSWorkflowTaskNode[];
  edges: DSWorkflowEdge[];
} {
  const taskCode = Date.now();

  const node: DSWorkflowTaskNode = {
    code: taskCode,
    name: sanitizeDsName(mapping.taskName),
    taskType: mapping.taskType,
    description: mapping.description,
    taskParams: JSON.stringify(mapping.taskParams),
    flag: 'YES',
    taskPriority: Priority.MEDIUM,
    workerGroup: 'default',
    environmentCode: -1,
    failRetryTimes: 0,
    failRetryInterval: 1,
    timeoutFlag: 'CLOSE',
    timeout: 0,
    delayTime: 0,
    // 与工作流 DAG 网格布局一致的起始坐标（横向间距 450 / 纵向间距 260），保证节点不紧挨
    x: 300,
    y: 140,
  };

  return {
    name: sanitizeDsName(mapping.workflowName),
    description: workflowDescription,
    executionType: ExecutionType.PARALLEL,
    timeout: 0,
    globalParams: [],
    nodes: [node],
    edges: [],
  };
}

/** 「文件夹 → 工作流」的输入：一个代码文件及其正文（正文由调用方读取，便于并发与失败重试） */
export interface FolderCodeFileInput {
  /** 文件绝对路径（用于推导项目内相对目录与任务名） */
  filePath: string;
  /** 文件正文 */
  content: string;
}

/** 本文件夹内无法解析的前置依赖：跨项目，或目标任务不在本文件夹内，DAG 中不连边，仅作提示 */
export interface UnresolvedFolderDependency {
  /** 声明该依赖的任务名（不含扩展名） */
  from: string;
  /** @依赖 中声明的调度项目（可能为空，表示同项目） */
  projectCode: string;
  /** 前置任务名称（不含扩展名） */
  taskName: string;
}

export interface BuildWorkflowFromFolderResult {
  /** 工作流名称：文件夹的项目内相对路径，分隔符转下划线后净化；为空（文件夹即项目根）时回退 'workflow' */
  name: string;
  nodes: DSWorkflowTaskNode[];
  edges: DSWorkflowEdge[];
  /** 每个代码文件任务声明的代码头 @依赖：sanitizeDsName(任务名) -> 依赖声明列表。
   * 保存前依赖重建（reconcileWorkflowDependencies）以它为事实来源，把同文件夹依赖直接连边、
   * 把跨文件夹/跨项目依赖解析为专属 DEPENDENT「前置依赖」节点。key 与任务节点名的 sanitize 口径一致。 */
  headerDeps: Map<string, HeaderDependency[]>;
  /** 未在本文件夹内找到的前置依赖（外部依赖），供界面提示 */
  unresolved: UnresolvedFolderDependency[];
  /** 依赖成环时返回环上的任务名，正常为 null */
  cycle: string[] | null;
}

/**
 * 按「文件夹下的代码文件」构建一份工作流草稿（节点 + 依赖边）。
 *
 * 用途：文件浏览器右键文件夹「提交调度」时，不需要左侧任务节点类型面板 ——
 * 每个代码文件生成一个任务节点，节点间的依赖边取自各文件代码头声明的 @依赖，
 * 仅当被依赖的任务名**也在本文件夹内**时才连线；跨项目或不在本批次的依赖记入
 * `unresolved` 由界面提示（不静默丢失，也不擅自连到别的节点上）。
 *
 * 最后按依赖分层布局（`layoutWorkflowByDependency`），保证前置节点恒在后置节点左侧。
 */
export function buildWorkflowFromFolder(
  files: FolderCodeFileInput[],
  options?: { rootPath?: string; folderPath?: string; projectCode?: string },
): BuildWorkflowFromFolderResult {
  const rootPath = options?.rootPath;
  const projectCode = (options?.projectCode || '').trim();

  // 节点 code 以同一基准 + 下标派生：同一次构建内唯一，且结果可复现
  const codeBase = Date.now();
  const nodes: DSWorkflowTaskNode[] = [];
  const codeByName = new Map<string, number>();
  const built: { mapping: CodeFileMapping; code: number }[] = [];

  files.forEach((file, index) => {
    const fileName = file.filePath.split(/[/\\]/).pop() || file.filePath;
    const mapping = mapCodeFileToTask(fileName, file.content, file.filePath, rootPath);
    const code = codeBase + index;

    nodes.push({
      code,
      name: sanitizeDsName(mapping.taskName),
      taskType: mapping.taskType,
      description: mapping.description,
      taskParams: JSON.stringify(mapping.taskParams),
      flag: 'YES',
      taskPriority: Priority.MEDIUM,
      workerGroup: 'default',
      environmentCode: -1,
      failRetryTimes: 0,
      failRetryInterval: 1,
      timeoutFlag: 'CLOSE',
      timeout: 0,
      delayTime: 0,
      // 先给布局起点，最终坐标由 layoutWorkflowByDependency 统一计算
      x: GRID_START_X,
      y: GRID_START_Y,
    });
    // 不同子目录下的同名文件：以先出现者为准，避免依赖边指向不确定的节点
    if (!codeByName.has(mapping.taskName)) codeByName.set(mapping.taskName, code);
    built.push({ mapping, code });
  });

  const edges: DSWorkflowEdge[] = [];
  const unresolved: UnresolvedFolderDependency[] = [];
  const seenEdge = new Set<string>();

  for (const { mapping, code } of built) {
    for (const dep of mapping.headerDependencies) {
      const depProject = (dep.projectCode || '').trim();
      // 跨项目的依赖不属于本工作流；projectCode 为空或与当前项目编码一致时视为同项目
      const sameProject = !depProject || !projectCode || depProject === projectCode;
      const sourceCode = sameProject ? codeByName.get(dep.taskName) : undefined;
      if (sourceCode === undefined) {
        unresolved.push({ from: mapping.taskName, projectCode: depProject, taskName: dep.taskName });
        continue;
      }
      // 自依赖（文件在自己的 @依赖 里写了自己）：不连边，也不作为待解析的外部依赖
      // ——否则会被解析成指向自身的「前置依赖」节点，形成环且无意义
      if (sourceCode === code) continue;
      const key = `edge_${sourceCode}_${code}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push({ id: key, sourceCode, targetCode: code });
    }
  }

  const name = deriveFolderWorkflowName(options?.folderPath, rootPath);

  // 每个代码文件任务的代码头 @依赖：key 用 sanitizeDsName(任务名)，与任务节点名的 sanitize 口径一致，
  // 供保存前 reconcileWorkflowDependencies 重建依赖（同文件夹连边 / 跨文件夹、跨项目生成前置依赖节点）
  const headerDeps = new Map<string, HeaderDependency[]>();
  for (const { mapping } of built) {
    const key = sanitizeDsName(mapping.taskName);
    if (key && !headerDeps.has(key)) headerDeps.set(key, mapping.headerDependencies);
  }

  const cycle = findDependencyCycle(nodes, edges);
  if (cycle) {
    // 有环时分层布局无意义（层号无解），退化为网格排布，交由用户在画布上删掉多余的边
    layoutByGrid(nodes);
  } else {
    layoutWorkflowByDependency(nodes, edges);
  }

  return {
    name,
    nodes,
    edges,
    headerDeps,
    unresolved,
    cycle,
  };
}

/**
 * 由「右键的文件夹」推导工作流名称，规范与单文件提交调度严格一致
 * （见 `mapCodeFileToTask`：取**项目内相对目录**，分隔符统一转下划线）。
 * - 与单文件一样**不做 sanitizeDsName**：清洗只发生在真正提交给调度系统时
 *   （`SubmitToSchedulerModal` / `FolderSubmitScheduleModal.handleSave`），
 *   这样界面上显示的名称与单文件一致（否则含特殊字符的目录名两边显示会不同）。
 * - 项目根目录（相对路径为空）、或文件夹不在项目目录之下（`toRelativePath` 会回退成
 *   绝对路径）时，退化为该文件夹自身的名字，避免把整条绝对路径变成工作流名
 *   （这是「名称不对且带斜杠」的根因：推导基准与单文件不同时会拿到绝对路径）。
 * - 都取不到时回退 'workflow'。
 */
export function deriveFolderWorkflowName(folderPath?: string, rootPath?: string): string {
  const folderName = folderPath
    ? (normalizePath(folderPath).replace(/\/+$/, '').split('/').filter(Boolean).pop() || '')
    : '';
  if (!folderPath) return folderName || 'workflow';

  const rel = toRelativePath(folderPath, rootPath);
  const isAbsolute = /^([a-zA-Z]:)?[/\\]/.test(rel);
  const base = (!rel || isAbsolute) ? folderName : rel;
  return base.replace(/[/\\]/g, '_') || 'workflow';
}

/** 成环时的兜底布局：每行 3 列依次排布（间距沿用 DAG 布局常量，保证节点不紧挨） */
function layoutByGrid(nodes: DSWorkflowTaskNode[]): void {
  const COLS = 3;
  nodes.forEach((node, index) => {
    node.x = GRID_START_X + (index % COLS) * GRID_GAP_X;
    node.y = GRID_START_Y + Math.floor(index / COLS) * GRID_GAP_Y;
  });
}

export function sanitizeDsName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_\u4e00-\u9fa5\-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 200);
}

/**
 * 判断某文件是否属于「编译生成主 Jar 包」的任务类型。
 * 与单文件提交调度（SubmitToSchedulerModal.isCompilableTask）的判定保持一致：
 * 仅 Java / Scala 文件，且映射为需要主 Jar 包的引擎任务类型（SPARK / FLINK /
 * FLINK_STREAM / MR / JAVA）。SQL / PYTHON / SHELL 等脚本型任务不参与编译。
 */
export function isCompilableFile(fileName: string, taskType: DSTaskType): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return ['java', 'scala'].includes(ext) &&
    ['SPARK', 'FLINK', 'FLINK_STREAM', 'MR', 'JAVA'].includes(taskType);
}

/**
 * 由代码文件绝对路径列表构建「任务名(净化后) -> 文件绝对路径」映射。
 * 任务名取文件名（不含扩展名）经 sanitizeDsName 后的结果，与 buildWorkflowFromFolder
 * 生成任务节点名的口径一致；同名文件以先出现者为准（同样对齐 buildWorkflowFromFolder
 * 的 codeByName 语义）。用于「文件夹提交调度」编译阶段按节点名反查源文件。
 */
export function buildTaskNameToFilePathMap(filePaths: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of filePaths) {
    const fileName = p.split(/[/\\]/).pop() || p;
    const taskName = sanitizeDsName(fileName.replace(/\.[^.]+$/, ''));
    if (!taskName) continue;
    if (!map.has(taskName)) map.set(taskName, p);
  }
  return map;
}

// 工作流名称的「版本后缀」（`{名称}_v{N}`，按同前缀工作流的定时调度状态自动递增）已移除：
// 现在由提交调度的「环境」单选决定名称后缀（`{名称}_prod` / `_gray` / `_test`），
// 见 utils/deployEnv.ts 与 SubmitToSchedulerModal.

export interface ValidationError {
  field: string;
  message: string;
}

export function validateSubmission(
  mapping: CodeFileMapping | null,
  selectedProjectCode: number | null,
  workflowName: string,
  selectedWorkflowCode: number | null,
  isRealApi: boolean,
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!isRealApi) {
    errors.push({ field: 'api', message: '当前使用 Mock API，请在设置中配置 DolphinScheduler 连接信息' });
  }

  if (!mapping) {
    errors.push({ field: 'mapping', message: '无法解析代码文件映射' });
    return errors;
  }

  if (!selectedProjectCode) {
    errors.push({ field: 'project', message: '请选择目标项目' });
  }

  if (!selectedWorkflowCode && !workflowName.trim()) {
    errors.push({ field: 'workflowName', message: '请输入工作流名称' });
  }

  if (workflowName.length > 200) {
    errors.push({ field: 'workflowName', message: '工作流名称不能超过200个字符' });
  }

  if (!mapping.taskName.trim()) {
    errors.push({ field: 'taskName', message: '任务名称不能为空' });
  }

  if (mapping.taskName.length > 200) {
    errors.push({ field: 'taskName', message: '任务名称不能超过200个字符' });
  }

  const taskParams = mapping.taskParams;

  switch (mapping.taskType) {
    case 'SQL': {
      if (!taskParams.sql || !(taskParams.sql as string).trim()) {
        errors.push({ field: 'taskParams', message: 'SQL 任务必须有 SQL 内容' });
      }
      if (!taskParams.type) {
        errors.push({ field: 'taskParams', message: 'SQL 任务必须指定数据源类型' });
      }
      break;
    }
    case 'PYTHON':
    case 'SHELL': {
      if (!taskParams.rawScript || !(taskParams.rawScript as string).trim()) {
        errors.push({ field: 'taskParams', message: `${mapping.taskType} 任务必须有脚本内容` });
      }
      break;
    }
    case 'SPARK': {
      if (!taskParams.rawScript || !(taskParams.rawScript as string).trim()) {
        errors.push({ field: 'taskParams', message: 'Spark 任务必须有脚本内容' });
      }
      if (!taskParams.programType) {
        errors.push({ field: 'taskParams', message: 'Spark 任务必须指定程序类型' });
      }
      break;
    }
    case 'FLINK': {
      if (!taskParams.rawScript || !(taskParams.rawScript as string).trim()) {
        errors.push({ field: 'taskParams', message: 'Flink 任务必须有脚本内容' });
      }
      if (!taskParams.programType) {
        errors.push({ field: 'taskParams', message: 'Flink 任务必须指定程序类型' });
      }
      break;
    }
    case 'JAVA': {
      if (!taskParams.mainClass) {
        errors.push({ field: 'taskParams', message: 'Java 任务必须指定主类' });
      }
      break;
    }
    case 'HTTP': {
      if (!taskParams.url) {
        errors.push({ field: 'taskParams', message: 'HTTP 任务必须指定 URL' });
      }
      break;
    }
    case 'DATAX': {
      if (!taskParams.customConfig && !taskParams.json) {
        if (!taskParams.sql) {
          errors.push({ field: 'taskParams', message: 'DataX 任务必须配置 SQL 或自定义 JSON' });
        }
      }
      break;
    }
  }

  return errors;
}
