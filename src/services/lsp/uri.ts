/**
 * 文件路径 <-> file:// URI 互转工具。
 * 与 VS Code / LSP 规范一致：文档 URI 使用 file:// 方案。
 */

export function pathToUri(filePath: string): string {
  if (filePath.startsWith('file://')) return filePath;
  // 已是其它 scheme（如 metals:），原样返回，避免被错误地加上 file:// 前缀
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(filePath)) return filePath;
  const normalized = filePath.replace(/\\/g, '/');
  return `file://${normalized.startsWith('/') ? '' : '/'}${normalized}`;
}

export function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  return decodeURIComponent(uri.replace('file://', '').replace(/^\/([A-Za-z]:)/, '$1'));
}
