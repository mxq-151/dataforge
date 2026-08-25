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
