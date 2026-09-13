// 单调自增序号，保证同一毫秒内多次调用 generateId 也能生成唯一 ID
let _idCounter = 0;

/**
 * 生成唯一 ID（数字）。
 * 采用「时间戳 + 单调自增小数位」组合：若仅用 Date.now() + Math.random()，
 * 在当前时间戳量级（≈1.7e12）下浮点精度 ULP 约 2^-12，同一毫秒内两次调用
 * 的随机小数可能舍入到同一个值，产生重复 ID 并导致 React 列表 key 重复告警。
 */
export const generateId = (): number => {
  _idCounter = (_idCounter + 1) % 1000;
  return Date.now() + _idCounter / 1000;
};

type SupportedLang = 'sql' | 'java' | 'scala' | 'python';

const getSupportedLang = (filename: string): SupportedLang | null => {
  const ext = filename.split('.').pop()?.toLowerCase();
  const extMap: Record<string, SupportedLang> = {
    sql: 'sql',
    java: 'java',
    scala: 'scala',
    py: 'python',
  };
  return extMap[ext || ''] || null;
};

/**
 * 代码头字段与书写顺序，所有支持的语言共用同一套。
 *
 * 代码头是机器解析契约（见 parseFileHeader），@引擎 与 @数据源 决定调度侧的
 * 任务类型与数据依赖，缺一不可：例如未声明 @引擎 的 .java 会被默认判为 SPARK 任务。
 * 因此这里不做按语言裁剪，任何语言新建文件都给出完整字段，避免再次出现
 * 「SQL 有引擎、Java 没有引擎」这类漂移。
 *
 * 自 v2 起代码头统一使用块注释（/* ... *\/）逐行书写，不再支持行注释（-- // #）。
 * 自 v3 起原 `@用法` 拆分为 `@程序参数`（程序自身入参）与 `@任务参数`（引擎与资源参数）
 * 两个字段，无该类参数时写「无」；自 v4 起再把「资源」从 `@任务参数` 中单列为
 * `@资源参数`（任务运行所需的算力与资源归属：并行度/内存/核数/slot/队列），
 * `@任务参数` 只保留提交与引擎侧参数。`@用法` 仅保留解析兼容（旧文件仍能识别），
 * 新模板不再生成。
 */
const HEADER_FIELDS = ['备注', '数仓', '引擎', '依赖', '程序参数', '资源参数', '任务参数', '数据源'] as const;

export const generateFileHeader = (filePath: string, _rootPath?: string): string => {
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  const lang = getSupportedLang(fileName);

  if (!lang) return '';

  const lines = [
    '/*',
    ...HEADER_FIELDS.map(field => ` * @${field}: `),
    ' */',
  ];

  return lines.join('\n');
};

export interface FileHeaderInfo {
  language: string;
  filePath: string;
  remark: string;
  warehouse?: string;
  engine?: string;
  dependency?: string;
  /**
   * 旧格式（v2）`@用法` 原文 —— 仅保留解析兼容：老文件里「程序参数」「资源参数」与「任务参数」
   * 混写在这一个字段里（见 utils/programArgs.ts 的引擎参数表）。新文件应使用
   * programArgs / resourceArgs / taskArgs。
   */
  usage?: string;
  /** 程序自身运行入参（v3 `@程序参数` 原文），如 `--day 20260501 -checkpoint 60000`；无则「无」 */
  programArgs?: string;
  /**
   * 任务运行所需的资源（v4 `@资源参数` 原文），如 `--num-executors 4 -yjm 1024`、
   * `-p 4 --queue root.default`；无则「无」。由调度侧落到任务配置的资源字段，不下发 runParams。
   */
  resourceArgs?: string;
  /** 除资源外的提交与引擎侧参数（`@任务参数` 原文），如 `--master yarn --deploy-mode cluster`；无则「无」 */
  taskArgs?: string;
  dataSource?: string;
  /**
   * 代码头注释风格。
   * - 'block'：块注释（/* ... *\/）书写，符合 v2 规范
   * - 'line'：旧式行注释（-- // #）书写，不符合规范
   * - 'none'：识别到注释但未匹配到任何 @字段
   */
  style: 'block' | 'line' | 'none';
}

const LINE_HEADER_PATTERN = /^\s*(?:--|\/\/|#)\s*@(\S+):\s*(.*)$/;

function parseHeaderField(key: string, value: string, info: FileHeaderInfo): void {
  switch (key) {
    case '语言': info.language = value; break;
    case '文件': info.filePath = value; break;
    case '备注': info.remark = value; break;
    case '数仓': info.warehouse = value; break;
    case '引擎': info.engine = value; break;
    case '依赖': info.dependency = value; break;
    // 旧格式（v2）单字段写法，仅为兼容老文件保留
    case '用法': info.usage = value; break;
    // v3：原 `@用法` 拆成的两个字段；v4：`@资源参数` 从 `@任务参数` 中单列
    case '程序参数': info.programArgs = value; break;
    case '资源参数': info.resourceArgs = value; break;
    case '任务参数': info.taskArgs = value; break;
    case '数据源': info.dataSource = value; break;
  }
}

/**
 * 解析文件头代码头。自 v2 起代码头必须使用块注释（/* ... *\/）逐行书写，
 * 解析器优先按块注释扫描；仅当未出现块注释时才回退按旧式行注释扫描（用于兼容
 * 识别旧文件，并在校验阶段提示不符合规范）。
 * 两种情况都会标注 style 供调用方区分，遇首个真实代码行即终止。
 */
export const parseFileHeader = (content: string): FileHeaderInfo | null => {
  const info: FileHeaderInfo = {
    language: '',
    filePath: '',
    remark: '',
    warehouse: '',
    engine: '',
    dependency: '',
    usage: '',
    programArgs: '',
    resourceArgs: '',
    taskArgs: '',
    dataSource: '',
    style: 'none',
  };

  let foundAny = false;
  const lines = content.split('\n');

  // 跳过开头 BOM 与空行
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].replace(/^\uFEFF/, '').trim();
    if (t) break;
    i++;
  }
  if (i >= lines.length) return null;

  const firstTrimmed = lines[i].replace(/^\uFEFF/, '').trim();

  if (firstTrimmed.startsWith('/*')) {
    // ── 块注释代码头（新规范） ──
    info.style = 'block';
    for (; i < lines.length; i++) {
      let line = lines[i].replace(/^\uFEFF/, '').trim();
      // 先定位行尾结束符 */（在剥离行首 * 之前判断，避免破坏结束符形态）
      const closeIdx = line.indexOf('*/');
      const hadClose = closeIdx !== -1;
      if (hadClose) line = line.slice(0, closeIdx);
      // 剥离块注释起始符 /*（含 /**）或行内前缀 *
      line = line.replace(/^\/\*+\*?/, '');
      line = line.replace(/^\*\*?/, '');

      const match = line.match(/^\s*@(\S+):\s*(.*)$/);
      if (match) {
        foundAny = true;
        parseHeaderField(match[1], match[2].trim(), info);
      }

      if (hadClose) break;
    }
  } else {
    // ── 旧式行注释代码头（仅识别，用于校验提示） ──
    for (; i < lines.length; i++) {
      const trimmed = lines[i].replace(/^\uFEFF/, '').trim();
      if (!trimmed) continue;
      // 只扫描行注释构成的代码头区，遇到首个真实代码行即终止
      if (!/^(?:--|\/\/|#)/.test(trimmed)) break;
      info.style = 'line';

      const match = lines[i].match(LINE_HEADER_PATTERN);
      if (!match) continue;
      foundAny = true;
      parseHeaderField(match[1], match[2], info);
    }
  }

  return foundAny ? info : (info.style === 'none' ? null : info);
};

export interface HeaderValidationResult {
  valid: boolean;
  message: string;
  missingFields: string[];
  packageErrors: string[];
}

function extractPackageName(code: string): string | null {
  const match = code.match(/^\s*package\s+([\w.]+)\s*;?\s*$/m);
  return match ? match[1] : null;
}

function extractClassName(code: string, ext: string): string | null {
  if (ext === 'scala') {
    const match = code.match(/^\s*(?:object|class)\s+(\w+)/m);
    return match ? match[1] : null;
  } else if (ext === 'java') {
    const match = code.match(/^\s*(?:public\s+)?(?:class|interface|enum)\s+(\w+)/m);
    return match ? match[1] : null;
  }
  return null;
}

export const validateFileHeader = (content: string, fileName?: string, relativePath?: string, projectCode?: string): HeaderValidationResult => {
  const missingFields: string[] = [];
  const packageErrors: string[] = [];
  const ext = fileName?.split('.').pop()?.toLowerCase() || '';
  const isSql = ext === 'sql';
  const isJavaOrScala = ext === 'java' || ext === 'scala';
  const isPython = ext === 'py';

  // 代码头规范（v2）：必须使用块注释（/* ... */）书写。检测到行注释代码头（-- // #）即视为不合规，
  // 在进入后续字段/包校验前直接拦截并提示用户。
  const header = parseFileHeader(content);
  if ((isSql || isJavaOrScala || isPython) && header && header.style === 'line') {
    packageErrors.push('代码头不符合规范：应使用块注释（/* ... */）逐行书写，当前检测到行注释（-- // #）书写');
    return {
      valid: false,
      message: `文件规范校验失败: ${packageErrors.join('；')}`,
      missingFields,
      packageErrors,
    };
  }

  if (!isSql && !isJavaOrScala && !isPython) {
    return { valid: true, message: '', missingFields: [], packageErrors: [] };
  }

  if (isSql) {
    return { valid: true, message: '', missingFields: [], packageErrors: [] };
  }

  if (isJavaOrScala) {
    const fileStem = fileName?.replace(/\.[^.]+$/, '') || '';

    const declaredPackage = extractPackageName(content);
    if (!declaredPackage) {
      packageErrors.push('代码缺少 package 声明');
    } else if (projectCode && relativePath) {
      const dirPart = relativePath.includes('/')
        ? relativePath.substring(0, relativePath.lastIndexOf('/')).replace(/\//g, '.')
        : '';
      const expectedPackagePrefix = dirPart ? `${projectCode}.${dirPart}` : projectCode;
      if (!declaredPackage.startsWith(expectedPackagePrefix)) {
        packageErrors.push(`包声明 "${declaredPackage}" 应以 "${expectedPackagePrefix}" 开头（项目编码.目录路径）`);
      }
    }

    const declaredClassName = extractClassName(content, ext);
    if (declaredClassName && fileStem && declaredClassName !== fileStem) {
      packageErrors.push(`主程序类名 "${declaredClassName}" 与文件名 "${fileStem}" 不一致`);
    }
  }

  if (missingFields.length > 0) {
    return {
      valid: false,
      message: `代码头文件不合规，缺少必填字段: ${missingFields.join('、')}`,
      missingFields,
      packageErrors,
    };
  }

  if (packageErrors.length > 0) {
    return {
      valid: false,
      message: `文件规范校验失败: ${packageErrors.join('；')}`,
      missingFields,
      packageErrors,
    };
  }

  return { valid: true, message: '', missingFields: [], packageErrors: [] };
};

interface ParamItem {
  id: string;
  key: string;
  value: string;
}

const ENGINE_DEFAULT_TASK_PARAMS: Record<string, ParamItem[]> = {
  kyuubi: [
    { id: '_eng_ky_1', key: 'engine', value: 'kyuubi' },
    { id: '_eng_ky_2', key: 'kyuubi.url', value: '' },
    { id: '_eng_ky_3', key: 'kyuubi.user', value: '' },
    { id: '_eng_ky_4', key: 'queue.name', value: 'default' },
    { id: '_eng_ky_5', key: 'spark.executor.cores', value: '2' },
    { id: '_eng_ky_6', key: 'spark.executor.memory', value: '4g' },
    { id: '_eng_ky_7', key: 'spark.executor.instances', value: '2' },
    { id: '_eng_ky_8', key: 'spark.driver.memory', value: '2g' },
  ],
  spark: [
    { id: '_eng_sp_2', key: 'deploy.mode', value: 'client' },
    { id: '_eng_sp_3', key: 'spark.executor.cores', value: '1' },
    { id: '_eng_sp_4', key: 'spark.executor.memory', value: '4g' },
    { id: '_eng_sp_5', key: 'spark.executor.instances', value: '2' },
    { id: '_eng_sp_6', key: 'spark.driver.memory', value: '2g' },
    { id: '_eng_sp_7', key: 'spark.sql.shuffle.partitions', value: '200' },
    { id: '_eng_sp_8', key: 'spark.dynamicAllocation.enabled', value: 'true' },
  ],
  flink: [
    { id: '_eng_fl_1', key: 'parallelism.default', value: '4' },
    { id: '_eng_fl_2', key: 'jobmanager.memory.process.size', value: '1600m' },
    { id: '_eng_fl_3', key: 'taskmanager.memory.process.size', value: '1728m' },
    { id: '_eng_fl_4', key: 'taskmanager.numberOfTaskSlots', value: '1' },
    { id: '_eng_fl_5', key: 'restart-strategy.type', value: 'fixed-delay' },
    { id: '_eng_fl_6', key: 'restart-strategy.fixed-delay.attempts', value: '3' },
  ],
};

export const getEngineDefaultTaskParams = (engine: string): ParamItem[] | null => {
  return ENGINE_DEFAULT_TASK_PARAMS[engine.trim().toLowerCase()] || null;
};
