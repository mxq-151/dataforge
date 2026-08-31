export const generateId = (): number => {
  return Date.now() + Math.random();
};

type SupportedLang = 'sql' | 'java' | 'scala' | 'python';

const COMMENT_PREFIX: Record<SupportedLang, string> = {
  sql: '-- ',
  java: '// ',
  scala: '// ',
  python: '# ',
};

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
 */
const HEADER_FIELDS = ['备注', '数仓', '引擎', '用法', '数据源'] as const;

export const generateFileHeader = (filePath: string, _rootPath?: string): string => {
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  const lang = getSupportedLang(fileName);

  if (!lang) return '';

  const prefix = COMMENT_PREFIX[lang];
  const lines = HEADER_FIELDS.map(field => `${prefix}@${field}: `);

  lines.push('');

  return lines.join('\n');
};

export interface FileHeaderInfo {
  language: string;
  filePath: string;
  remark: string;
  warehouse?: string;
  engine?: string;
  usage?: string;
  dataSource?: string;
}

const HEADER_PATTERN = /^\s*(?:--|\/\/|#)\s*@(\S+):\s*(.*)$/;

export const parseFileHeader = (content: string): FileHeaderInfo | null => {
  const info: FileHeaderInfo = {
    language: '',
    filePath: '',
    remark: '',
    warehouse: '',
    engine: '',
    usage: '',
    dataSource: '',
  };

  let foundAny = false;
  const lines = content.split('\n');

  for (const line of lines) {
    // 容忍 BOM 与代码头前/中的空行，不终止解析
    const trimmed = line.replace(/^\uFEFF/, '').trim();
    if (!trimmed) continue;

    // 只扫描行注释（-- // #）构成的文件头注释区；遇到首个真实代码行即终止，
    // 避免把正文后续出现的 @字段 注释误收入代码头
    if (!/^(?:--|\/\/|#)/.test(trimmed)) break;

    const match = line.match(HEADER_PATTERN);
    if (!match) continue;

    foundAny = true;
    const [, key, value] = match;
    switch (key) {
      case '语言': info.language = value; break;
      case '文件': info.filePath = value; break;
      case '备注': info.remark = value; break;
      case '数仓': info.warehouse = value; break;
      case '引擎': info.engine = value; break;
      case '用法': info.usage = value; break;
      case '数据源': info.dataSource = value; break;
    }
  }

  return foundAny ? info : null;
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
