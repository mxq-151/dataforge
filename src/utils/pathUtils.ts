/**
 * 跨平台路径工具函数
 *
 * 统一处理 Windows（\）和 Unix（/）路径分隔符差异。
 * 所有文件路径操作应使用这些函数替代 .split('/') 或 .split('\\')。
 */

/** 检测当前平台是否为 Windows */
export const isWindows = (): boolean => {
  return navigator.userAgent.includes('Windows');
};

/** 将路径中的反斜杠替换为正斜杠（规范化路径分隔符） */
export const normalizePath = (path: string): string => {
  return path.replace(/\\/g, '/');
};

/**
 * 带 scheme 前缀的字符串不是磁盘路径，不能做分隔符/盘符转换。
 * - scheme 至少两个字母后跟 : 或 :/ 或 ://（jdt://、metals:、https://、file: 任意斜杠数）
 * - 单字母 + ':' 是 Windows 盘符（C:/a/b），不算 scheme，必须继续转换
 */
const HAS_SCHEME = /^(?:file:|[a-zA-Z]{2,}[a-zA-Z0-9+.-]*:\/{0,2})/;

/**
 * 转成当前平台的本地路径形式：
 * - Windows：`\` 分隔、盘符大写（c:/a/b.txt → C:\a\b.txt）
 * - 其它平台：`/` 分隔
 *
 * 用于把「外部来源」的路径（LSP file:// URI 解码结果、后端/命令行返回等）统一成与本机
 * 文件系统一致的表示。否则同一文件会因分隔符或盘符大小写不同被当成两个文件：
 * 定义跳转重复开 Tab、文件浏览器不高亮、git / 编译按路径取配置时取不到。
 *
 * 带 scheme 的字符串（file://、jdt://、metals://）原样返回。
 */
export const toNativePath = (path: string): string => {
  if (!path || HAS_SCHEME.test(path)) return path;

  let p = normalizePath(path);
  // UNC（\\server\share\...）的前导双分隔符必须保留
  const isUnc = p.startsWith('//');
  p = p.replace(/\/{2,}/g, '/');

  if (!isWindows()) return p;

  p = p.replace(/\//g, '\\');
  if (isUnc) p = `\\${p}`;
  return p.replace(/^([A-Za-z]):/, (_m, drive) => `${drive.toUpperCase()}:`);
};

/**
 * 路径比较键：统一分隔符、去尾部斜杠；Windows 再忽略大小写（盘符/目录名大小写不敏感）。
 * 只用于比较，不要用于展示。
 */
export const pathKey = (path: string): string => {
  const key = normalizePath(path).replace(/\/+$/, '');
  return isWindows() ? key.toLowerCase() : key;
};

/** 两个路径是否指向同一文件/目录（忽略分隔符差异；Windows 再忽略大小写） */
export const samePath = (a?: string | null, b?: string | null): boolean => {
  if (!a || !b) return false;
  return pathKey(a) === pathKey(b);
};

/** fullPath 是否位于 rootPath 之下（含自身），忽略分隔符差异 */
export const isPathUnder = (fullPath: string, rootPath: string): boolean => {
  if (!fullPath || !rootPath) return false;
  const full = pathKey(fullPath);
  const root = pathKey(rootPath).replace(/\/+$/, '');
  if (!root) return false;
  return full === root || full.startsWith(`${root}/`);
};

/**
 * 剥离 rootPath 前缀得到相对路径（`/` 分隔，便于传给 git / 后端），忽略两侧的分隔符差异。
 * 不在 rootPath 之下时返回统一成 `/` 分隔的 fullPath（保留原始大小写）。
 */
export const toRelativePath = (fullPath: string, rootPath?: string): string => {
  if (!rootPath) return fullPath;
  const full = normalizePath(fullPath).replace(/\/+$/, '');
  const root = normalizePath(rootPath).replace(/\/+$/, '');
  if (!root) return full;

  const fullKey = isWindows() ? full.toLowerCase() : full;
  const rootKey = isWindows() ? root.toLowerCase() : root;
  if (fullKey === rootKey) return '';
  if (fullKey.startsWith(`${rootKey}/`)) return full.slice(root.length + 1);
  return full;
};

/** 按 / 和 \ 分割路径，返回各段 */
export const splitPath = (path: string): string[] => {
  return normalizePath(path).split('/').filter(Boolean);
};

/** 从路径中提取文件名（如 /foo/bar.txt → bar.txt） */
export const getBaseName = (path: string): string => {
  const parts = splitPath(path);
  return parts[parts.length - 1] || path;
};

/** 从路径中提取目录部分（如 /foo/bar.txt → /foo） */
export const getDirName = (path: string): string => {
  const normalized = normalizePath(path).replace(/\/+$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return lastSlash === 0 ? '/' : '.';
  return normalized.substring(0, lastSlash);
};

/** 拼接多个路径段，使用 / 连接（适合 API 调用和显示） */
export const joinPath = (...parts: string[]): string => {
  return parts
    .map(p => normalizePath(p).replace(/\/+$/, ''))
    .filter(p => p)
    .join('/');
};

/** 去除路径末尾的 / 或 \ */
export const trimTrailingSlash = (path: string): string => {
  return path.replace(/[\\/]+$/, '');
};

/** 将后端地址（如 http://localhost:8080）转换为安全的目录名（如 localhost_8080） */
export const hostToDirName = (host: string): string => {
  let h = (host || '').trim();
  if (!h) return 'default';
  // 去掉协议前缀
  h = h.replace(/^https?:\/\//i, '');
  // 去掉路径 / 查询 / 锚点
  h = h.split(/[/?#]/)[0];
  // 替换非法文件名字符
  h = h.replace(/[^a-zA-Z0-9._-]/g, '_');
  return h || 'default';
};
