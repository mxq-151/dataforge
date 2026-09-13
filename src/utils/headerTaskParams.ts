/**
 * 「提交调度」任务节点参数 ← 代码头声明 的唯一换算口径。
 *
 * 背景：代码头用三个字段声明参数（见 hooks/opencode/opencodeInstructions.ts「代码头格式规范」）：
 *   - `@程序参数` 业务入参（这次要算什么）
 *   - `@资源参数` 算力与资源归属（这次给多少资源）
 *   - `@任务参数` 提交与引擎侧配置（这个任务怎么提交）
 * 前两者之外的第三个消费者就是「提交调度」：同一份声明必须同时驱动
 *   1) 「运行程序」弹窗（utils/programArgs.ts::extractProgramParams，只取参数名）
 *   2) 调度任务节点的 taskParams（本模块）
 * 两个消费面口径一致，避免「提示词写了、提交时不认」的静默漂移。
 *
 * 换算原则：
 *   - **代码头取值即真实值**（不是示例值）：直接写进节点对应字段，由本模块负责归一化
 *     （`--num-executors` → numExecutors、`-p` → parallelism、`--deploy-mode yarn-cluster`
 *     → deployMode 'cluster'）。
 *   - 映射不到具体字段的声明**原样进「其他参数(others)」**，保持声明顺序，不猜测、不丢弃。
 *   - 由其它机制自动生成的字段（主 Jar、应用名称）代码头声明一律不覆盖，但**必须回报**
 *     （`unmapped`，界面显式提示），不允许静默吞掉。
 *   - 本任务类型没有可承载字段时（SQL / HIVECLI / DATAX 等）返回 supported=false，
 *     声明全部进 `unmapped`，由界面告知用户去「配置参数 → 配置任务参数」维护。
 *
 * 优先级：代码头 > 「配置参数」已保存值 > 引擎默认值 > 「提交调度」记住的上次取值。
 * 本模块只负责把代码头声明算出来；覆盖顺序由 schedulerMapping.mapCodeFileToTask 与
 * SubmitToSchedulerModal 负责落地。
 */

import { parseFileHeader } from './fileHeader';
import { paramFlagName } from './programArgs';

/** 参数名合法性：与代码头参数声明、runParams 的口径一致 */
const PARAM_NAME_PATTERN = /^[A-Za-z_][\w.\-]*$/;

/** 代码头里表示「没有该类参数」的占位值 */
const NONE_VALUE = '无';

/** 代码头里的一条参数声明（flag 可自带 `=取值`，也可后跟一个取值 token） */
export interface HeaderArgToken {
  /** 原始 flag（含前导 `-`/`--`），如 `--driver-memory` */
  flag: string;
  /** 归一化参数名（去前缀、去 `=取值`），如 `driver-memory` */
  name: string;
  /** 取值；无取值时为空串 */
  value: string;
}

/** 一条声明的换算结果，供界面显示「哪些参数来自代码头」 */
export interface HeaderParamHit {
  /** 声明出自代码头的哪个字段 */
  from: 'program' | 'resource' | 'task';
  /** 原始声明片段（含取值），如 `--driver-memory 2g` */
  raw: string;
  /** 落到的节点参数名；无处安置时为 null */
  key: string | null;
  /** 写进节点的取值；未落盘时为 null */
  value: string | number | null;
  /** 未落到具体字段时的去向说明（界面提示用，不静默） */
  note?: string;
}

export interface HeaderTaskParamDerivation {
  /** 本任务类型是否有可承载代码头声明的字段（false 时 params 必为空） */
  supported: boolean;
  /** 可直接并入节点 taskParams 的参数（键名与「提交调度」弹窗的配置项同名） */
  params: Record<string, unknown>;
  /** 逐条明细：已写入节点的声明 */
  applied: HeaderParamHit[];
  /** 逐条明细：未能写入节点的声明（必须在界面告知） */
  unmapped: HeaderParamHit[];
}

/** 节点参数里的一个落点 */
interface ParamSlot {
  /** 节点参数名（须与「提交调度」弹窗 TASK_TYPE_PARAMS_CONFIG 的 key 一致） */
  key: string;
  /** 归一化方式：number 转数值、select 按 options 收敛、text 原样 */
  type: 'text' | 'number' | 'select';
  /** select 类字段的合法取值（用于把 `yarn-cluster` 收敛成 `cluster`） */
  options?: string[];
}

interface TaskTypeSpec {
  /** 承载「映射不到字段」的自由文本字段；null=无可承载字段（进 unmapped） */
  fallback: string | null;
  /** 承载 `@程序参数` 原文的字段（本类型的「主参数」）；null=没有该字段 */
  mainArgsKey: string | null;
  /** flag 裸名（小写）→ 节点参数 */
  slots: Record<string, ParamSlot>;
  /** 由代码/其它机制自动生成、代码头声明不得覆盖的 flag（值=原因，界面照原样提示） */
  autoManaged?: Record<string, string>;
}

const SPARK_SPEC: TaskTypeSpec = {
  fallback: 'others',
  mainArgsKey: 'mainArgs',
  slots: {
    'num-executors': { key: 'numExecutors', type: 'number' },
    'driver-memory': { key: 'driverMemory', type: 'text' },
    'driver-cores': { key: 'driverCores', type: 'number' },
    'executor-memory': { key: 'executorMemory', type: 'text' },
    'executor-cores': { key: 'executorCores', type: 'number' },
    queue: { key: 'yarnQueue', type: 'text' },
    'deploy-mode': { key: 'deployMode', type: 'select', options: ['cluster', 'client', 'local'] },
    class: { key: 'mainClass', type: 'text' },
  },
  autoManaged: {
    jars: '--jars 由「配置参数 → 依赖」自动拼装，代码头声明未采用',
    files: '--files 由依赖与调度资源中心下发，代码头声明未采用',
    archives: '--archives 由依赖与调度资源中心下发，代码头声明未采用',
    name: '应用名称由「项目.工作流.任务」自动生成，代码头声明未采用',
    'main-jar': '主 Jar 由编译产物自动填入，代码头声明未采用',
  },
};

/**
 * flink run / flink run-application 的选项名 → 节点参数。
 * 只收敛「确定唯一去向」的项；`-d`（分离提交）、`-Dyarn.*`（动态配置）等一律原样进「其他参数」。
 */
const FLINK_SLOTS: Record<string, ParamSlot> = {
  p: { key: 'parallelism', type: 'number' },
  parallelism: { key: 'parallelism', type: 'number' },
  yjm: { key: 'jobManagerMemory', type: 'text' },
  ytm: { key: 'taskManagerMemory', type: 'text' },
  ys: { key: 'slot', type: 'number' },
  yn: { key: 'taskManager', type: 'number' },
  yqu: { key: 'yarnQueue', type: 'text' },
  queue: { key: 'yarnQueue', type: 'text' },
  m: { key: 'deployMode', type: 'select', options: ['cluster', 'application', 'local'] },
  c: { key: 'mainClass', type: 'text' },
  class: { key: 'mainClass', type: 'text' },
  'job-classname': { key: 'mainClass', type: 'text' },
};

const FLINK_AUTO_MANAGED: Record<string, string> = {
  j: '主 Jar 由编译产物自动填入，代码头声明未采用',
  jarfile: '主 Jar 由编译产物自动填入，代码头声明未采用',
  yarnname: '应用名称由「项目.工作流.任务」自动生成，代码头声明未采用',
};

/** 任务类型 → 换算规则。未列出的类型没有可承载代码头声明的字段（supported=false）。 */
const TASK_TYPE_SPECS: Record<string, TaskTypeSpec> = {
  SPARK: SPARK_SPEC,
  FLINK: {
    fallback: 'others',
    mainArgsKey: 'mainArgs',
    slots: FLINK_SLOTS,
    autoManaged: FLINK_AUTO_MANAGED,
  },
  // Flink Stream 节点没有「其他参数 / 主参数」字段，未映射声明只能回报给用户
  FLINK_STREAM: {
    fallback: null,
    mainArgsKey: null,
    slots: { ...FLINK_SLOTS },
    autoManaged: FLINK_AUTO_MANAGED,
  },
  MR: {
    fallback: 'others',
    mainArgsKey: 'mainArgs',
    slots: {
      queue: { key: 'yarnQueue', type: 'text' },
      class: { key: 'mainClass', type: 'text' },
    },
  },
  JAVA: {
    fallback: null,
    mainArgsKey: 'mainArgs',
    slots: { class: { key: 'mainClass', type: 'text' } },
  },
};

/**
 * 把代码头的参数声明切成 `{ flag, name, value }`。
 *
 * 取值规则（与程序参数声明的写法一致）：
 *   - `--env=prod`       → flag `--env=prod`、取值 `prod`
 *   - `--driver-memory 2g` → flag `--driver-memory`、取值 `2g`
 *   - 取值本身是负数（`--offset -1`）时仍算取值
 *   - 结尾没有取值的 flag 取值记为空串（由调用方决定是否回报「缺取值」）
 */
export function parseHeaderArgTokens(declaration: string | null | undefined): HeaderArgToken[] {
  const tokens = (declaration || '').trim().split(/\s+/).filter(Boolean);
  const out: HeaderArgToken[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('-') || token === '-' || token === '--') continue;
    const name = paramFlagName(token);
    if (!PARAM_NAME_PATTERN.test(name)) continue;

    const eq = token.indexOf('=');
    if (eq >= 0) {
      out.push({ flag: token, name, value: token.slice(eq + 1) });
      continue;
    }

    const next = tokens[i + 1];
    if (next !== undefined && (!next.startsWith('-') || /^-\d/.test(next))) {
      out.push({ flag: token, name, value: next });
      i += 1;
    } else {
      out.push({ flag: token, name, value: '' });
    }
  }
  return out;
}

/** 声明片段原文：`--driver-memory 2g`（flag 自带取值时不再重复拼接，如 `-Dyarn.name=x`） */
function rawOf(token: HeaderArgToken): string {
  if (token.flag.includes('=')) return token.flag;
  return token.value ? `${token.flag} ${token.value}` : token.flag;
}

/**
 * select 类字段的取值收敛：`yarn-cluster` / `yarn-application` / `cluster` 都能落到合法取值上。
 * 收敛不了时返回 null，由调用方把该声明原样送去「其他参数」，不猜。
 */
function normalizeSelectValue(value: string, options: string[]): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  const exact = options.find(option => option.toLowerCase() === v);
  if (exact) return exact;
  // yarn-cluster → cluster；yarn-application → application
  return options.find(option => v.endsWith(option.toLowerCase())) || null;
}

/** 是否「声明了但没有内容」（空 / 无） */
function isEmptyDeclaration(text: string | null | undefined): boolean {
  const trimmed = (text || '').trim();
  return !trimmed || trimmed === NONE_VALUE;
}

/**
 * 把代码头声明换算成调度任务节点参数。
 *
 * @param codeContent 文件正文（含代码头）
 * @param taskType    调度任务类型（DSTaskType，如 SPARK / FLINK / SQL）
 */
export function deriveTaskParamsFromHeader(
  codeContent: string,
  taskType: string,
): HeaderTaskParamDerivation {
  const header = parseFileHeader(codeContent ?? '');
  const params: Record<string, unknown> = {};
  const applied: HeaderParamHit[] = [];
  const unmapped: HeaderParamHit[] = [];
  const spec = TASK_TYPE_SPECS[taskType];

  // 没有资源/提交字段的任务类型（SQL / HIVECLI / DATAX / PYTHON / SHELL…）：
  // 声明原样列出，由界面告知用户去「配置参数 → 配置任务参数」维护，不静默丢弃。
  // 注意 `@程序参数` 不在此列 —— 它由「运行程序」弹窗消费，属正常去向。
  if (!spec) {
    const declarations: Array<{ from: 'resource' | 'task'; decl?: string }> = [
      { from: 'resource', decl: header?.resourceArgs },
      { from: 'task', decl: header?.taskArgs },
    ];
    for (const { from, decl } of declarations) {
      if (isEmptyDeclaration(decl)) continue;
      for (const token of parseHeaderArgTokens(decl)) {
        unmapped.push({
          from,
          raw: rawOf(token),
          key: null,
          value: null,
          note: `${taskType} 任务节点没有可承载该声明的字段，请在「配置参数 → 配置任务参数」里维护`,
        });
      }
    }
    return { supported: false, params, applied, unmapped };
  }

  const declarations: Array<{ from: 'resource' | 'task'; decl?: string }> = [
    { from: 'resource', decl: header?.resourceArgs },
    { from: 'task', decl: header?.taskArgs },
  ];

  /** 无处落字段、但有「其他参数」兜底的声明（保持顺序，去重后拼成一行） */
  const fallbackRaw: string[] = [];

  for (const { from, decl } of declarations) {
    if (isEmptyDeclaration(decl)) continue;

    for (const token of parseHeaderArgTokens(decl)) {
      const raw = rawOf(token);
      const autoReason = spec.autoManaged?.[token.name.toLowerCase()];
      if (autoReason) {
        unmapped.push({ from, raw, key: null, value: null, note: autoReason });
        continue;
      }

      const slot = spec.slots[token.name.toLowerCase()];
      if (!slot) {
        if (spec.fallback) {
          fallbackRaw.push(raw);
          applied.push({ from, raw, key: spec.fallback, value: raw });
        } else {
          unmapped.push({
            from,
            raw,
            key: null,
            value: null,
            note: `${taskType} 任务节点没有「其他参数」字段，该声明未随节点下发`,
          });
        }
        continue;
      }

      if (!token.value) {
        unmapped.push({ from, raw, key: null, value: null, note: '声明缺少取值，未写入节点' });
        continue;
      }

      if (slot.type === 'number') {
        const num = Number(token.value);
        if (!Number.isFinite(num)) {
          if (spec.fallback) {
            fallbackRaw.push(raw);
            applied.push({ from, raw, key: spec.fallback, value: raw });
          } else {
            unmapped.push({ from, raw, key: null, value: null, note: `取值「${token.value}」不是数字，未写入节点` });
          }
          continue;
        }
        params[slot.key] = num;
        applied.push({ from, raw, key: slot.key, value: num });
        continue;
      }

      if (slot.type === 'select') {
        const normalized = normalizeSelectValue(token.value, slot.options || []);
        if (!normalized) {
          if (spec.fallback) {
            fallbackRaw.push(raw);
            applied.push({ from, raw, key: spec.fallback, value: raw });
          } else {
            unmapped.push({ from, raw, key: null, value: null, note: `取值「${token.value}」不在 ${slot.key} 的允许范围内，未写入节点` });
          }
          continue;
        }
        params[slot.key] = normalized;
        applied.push({ from, raw, key: slot.key, value: normalized });
        continue;
      }

      params[slot.key] = token.value;
      applied.push({ from, raw, key: slot.key, value: token.value });
    }
  }

  if (spec.fallback && fallbackRaw.length > 0) {
    params[spec.fallback] = [...new Set(fallbackRaw)].join(' ');
  }

  // `@程序参数` 的**取值**进节点「主参数」随任务提交；参数名另有去向（「运行程序」弹窗预填），
  // 因此没有「主参数」字段的类型不算漏配置，不进 unmapped，避免每个 SQL 文件都刷提示。
  const programArgs = (header?.programArgs || '').trim();
  if (spec.mainArgsKey && !isEmptyDeclaration(programArgs)) {
    params[spec.mainArgsKey] = programArgs;
    applied.push({ from: 'program', raw: programArgs, key: spec.mainArgsKey, value: programArgs });
  }

  return { supported: true, params, applied, unmapped };
}

/** 该任务类型是否有可承载代码头声明的字段（供界面决定提示措辞） */
export function taskTypeSupportsHeaderParams(taskType: string): boolean {
  return !!TASK_TYPE_SPECS[taskType];
}

/** 已识别的节点参数名（去重，保持写入顺序），供界面展示「来自代码头的参数」 */
export function appliedHeaderParamKeys(derivation: HeaderTaskParamDerivation): string[] {
  const keys: string[] = [];
  for (const hit of derivation.applied) {
    if (hit.key && !keys.includes(hit.key)) keys.push(hit.key);
  }
  return keys;
}
