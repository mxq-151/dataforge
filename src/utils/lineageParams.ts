/**
 * 数据血缘（OpenLineage）参数的**唯一拼装处**。
 *
 * 为什么单独成模块：血缘参数与 `--jars`、用户手填的「其他参数」挤在同一个
 * `taskParams.others` 字段里，两个提交入口（单文件 `SubmitToSchedulerModal` /
 * 文件夹 `FolderSubmitScheduleModal`）本应拼出同样的东西。此前逻辑内联在单文件入口里，
 * 文件夹入口整条漏掉 ⇒ 生产环境批量提交出来的 Spark 任务没有血缘。
 * 抽到这里共用后，**「什么时候注入」只有一处实现**，两个入口不会再走岔。
 *
 * 两道闸门，顺序固定（先环境、后文件）：
 * 1. **环境硬闸门**：只有生产环境注入（`deployEnv.ts::shouldInjectLineage`）。
 *    灰度 / 测试是验证性提交，注入会让正式血缘图上出现只在测试跑过的临时节点；
 *    文件级配置**不能在非生产环境把它打开**。
 * 2. **文件级开关**：生产环境下按任务关闭（`lineage.enabled=false`）。
 *    未配置视为开启，保持既有默认注入行为（向后兼容）。
 */
import { shouldInjectLineage, type DeployEnv } from './deployEnv';

/** 血缘管理的参数 key 前缀：文件配置（「配置参数」弹窗）里以 `lineage.` 开头的项 */
export const LINEAGE_PARAM_PREFIX = 'lineage.';

/** 血缘开关项 key */
export const LINEAGE_ENABLED_KEY = `${LINEAGE_PARAM_PREFIX}enabled`;

/** Transport URL 覆盖项 key（不配则用设置页的全局值） */
export const LINEAGE_TRANSPORT_URL_KEY = `${LINEAGE_PARAM_PREFIX}transportUrl`;

/** 命名空间覆盖项 key（不配则用项目编码） */
export const LINEAGE_NAMESPACE_KEY = `${LINEAGE_PARAM_PREFIX}namespace`;

/** 是否是血缘保留参数（这类项不从弹窗的「任务参数」列表里回显，由血缘区块单独承载） */
export const isLineageParamKey = (key: string): boolean =>
  (key || '').startsWith(LINEAGE_PARAM_PREFIX);

export interface LineageParamItem {
  key: string;
  value: string;
}

/**
 * 从文件配置的 taskParams 里挑出血缘保留参数，得到 `{ 'lineage.enabled': 'false', ... }`。
 * 非血缘项一概忽略 —— 调用方自己负责其余参数的取舍。
 */
export function extractLineageParams(
  params?: LineageParamItem[] | null,
): Record<string, string> {
  const cfg: Record<string, string> = {};
  (params || []).forEach(p => {
    if (p && p.key && isLineageParamKey(p.key)) cfg[p.key] = p.value;
  });
  return cfg;
}

export interface BuildOpenLineageArgsOptions {
  /** 本次提交选中的部署环境（决定是否注入） */
  env: DeployEnv;
  /** 项目编码：命名空间的默认值 */
  projectCode?: string;
  /** 设置页的全局 OpenLineage Transport URL：文件级未覆盖时用它 */
  globalTransportUrl?: string;
  /** 文件级血缘配置（`extractLineageParams` 的结果；文件无配置就传空） */
  fileLineage?: Record<string, string> | null;
  /** 任务是否对血缘采集开放（目前只有 SPARK 适用）。false 直接返回空 */
  taskTypeSupportsLineage?: boolean;
}

/**
 * 拼出要附加到 `taskParams.others` 末尾的 OpenLineage 参数。
 *
 * **返回空数组表示本次不注入**，调用方据此决定是否改写 `others`（空数组时不要写，
 * 免得把用户原有内容覆盖成空串）。
 */
export function buildOpenLineageArgs(opts: BuildOpenLineageArgsOptions): string[] {
  // 闸门 1：非生产环境一律不注入。环境是硬闸门，文件级配置无法在这里翻盘。
  if (!shouldInjectLineage(opts.env)) return [];
  if (opts.taskTypeSupportsLineage === false) return [];

  const fileLineage = opts.fileLineage || {};
  // 闸门 2：生产环境下按任务关闭。未配置（undefined）视为开启，保持默认注入行为。
  if (fileLineage[LINEAGE_ENABLED_KEY] === 'false') return [];

  const args = [
    '--conf spark.extraListeners=io.openlineage.spark.agent.OpenLineageSparkListener',
    '--conf spark.openlineage.transport.type=http',
  ];

  const transportUrl = fileLineage[LINEAGE_TRANSPORT_URL_KEY] || opts.globalTransportUrl;
  if (transportUrl) {
    args.push(`--conf spark.openlineage.transport.url=${transportUrl}`);
  }

  const namespace = fileLineage[LINEAGE_NAMESPACE_KEY] || opts.projectCode;
  if (namespace) {
    args.push(`--conf spark.openlineage.namespace=${namespace}`);
  }

  return args;
}
