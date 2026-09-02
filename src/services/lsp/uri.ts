/**
 * 文件路径 <-> file:// URI 互转工具。
 * 与 VS Code / LSP 规范一致：文档 URI 使用 file:// 方案。
 *
 * Windows 适配要点（定义跳转路径错乱的根因）：
 * - LSP 服务器（JDT.LS / Metals）返回的 URI 盘符常为小写，且冒号可能被百分号编码
 *   （file:///c%3A/Users/...），VS Code 侧又可能给出 file:///C:/Users/...；
 * - Java 的 File.toURI() 输出单斜杠形式（file:/C:/...），部分 LSP 代码路径会原样返回；
 * - 未解码就匹配盘符正则会失配，导致路径前面多一个 `/`、盘符大小写与本地不一致，
 *   同一文件被判断成两个不同路径（重复开 Tab、文件树不高亮）。
 * 因此这里先解码再剥离盘符前导斜杠，并由 toNativePath 统一成本地形式（Windows → `C:\...`）。
 */
import { pathKey, toNativePath } from '../../utils/pathUtils';

export function pathToUri(filePath: string): string {
  if (filePath.startsWith('file:')) {
    // file://C:/...（盘符被误当 authority 的畸形形式）→ 解析后按标准形式重建
    if (/^file:\/\/[A-Za-z]:(\/|$)/.test(filePath)) {
      return pathToUri(uriToPath(filePath));
    }
    // 标准 file:///path（空 authority）与 file://server/share（UNC）原样保留——
    // Metals 依赖源码 Tab 保留服务器返回的原始 URI 才能被识别，不能重建。
    if (filePath.startsWith('file:///') || /^file:\/\/[^/]/.test(filePath)) {
      return filePath;
    }
    // 其它非标准形式（file:/C:/...、file:C:/...）→ 解析成本地路径后按标准形式重建
    const p = uriToPath(filePath);
    return p === filePath ? filePath : pathToUri(p);
  }
  // 已是其它 scheme（如 jdt:、metals:），原样返回，避免被错误地加上 file:// 前缀
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(filePath)) return filePath;
  const normalized = filePath.replace(/\\/g, '/');
  return `file://${normalized.startsWith('/') ? '' : '/'}${normalized}`;
}

/** 是否为 file scheme URI（file:、file:/、file://、file:/// 均算；jdt:/metals: 等不算） */
export function isFileUri(uri: string): boolean {
  return uri.startsWith('file:');
}

export function uriToPath(uri: string): string {
  if (!uri.startsWith('file:')) return uri;

  // 剥掉 'file:' 后统计前导斜杠数量，兼容 RFC 8089 的全部合法形式：
  //   file:///C:/a/b（空 authority，Windows 盘符）   file:///Users/x/a（POSIX）
  //   file://server/share/a（UNC）                    file:/C:/a/b（单斜杠，Java File.toURI()）
  //   file:C:/a/b（无斜杠，个别实现）                 file://C:/a/b（盘符被误当 authority）
  let rest = uri.slice('file:'.length);
  let slashes = 0;
  while (rest.startsWith('/')) {
    slashes++;
    rest = rest.slice(1);
  }

  let body = rest;
  try {
    body = decodeURIComponent(body);
  } catch {
    // 含非法百分号转义时退回原始串，避免整条跳转链路因一个坏字符中断
  }

  const isDrive = /^[A-Za-z]:/.test(body);
  // 恰两个斜杠且后面不是盘符 → authority 是主机名，即 UNC 路径
  const isUnc = slashes === 2 && !isDrive;

  let out: string;
  if (isUnc) {
    out = `//${body}`;
  } else if (isDrive) {
    // Windows 盘符：'C:/a/b' → 'C:/a/b'（盘符大小写由 toNativePath 统一）
    out = body;
  } else if (slashes > 0) {
    // POSIX 绝对路径：'///Users/x/a'、'/Users/x/a' → '/Users/x/a'
    out = `/${body}`;
  } else {
    // 无斜杠非盘符：罕见的相对形式，原样返回
    out = body;
  }

  // Windows → C:\a\b.txt；POSIX → /a/b.txt
  return toNativePath(out);
}

/**
 * URI 比较键：判断两个 URI 是否指向同一文档。
 *
 * 同一次跳转里，Monaco 文档 URI 与 LSP 返回的 Location URI 可能在「盘符大小写」「冒号是否
 * 百分号编码」「分隔符」「斜杠数量（file:/ vs file:///）」上不同，字符串直接相等会误判成
 * 跨文件（表现为当前文件被重复开成新 Tab）。
 */
export function uriKey(uri: string): string {
  if (!uri.startsWith('file:')) return uri;
  return `file://${pathKey(uriToPath(uri))}`;
}
