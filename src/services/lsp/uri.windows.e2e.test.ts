import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pathToUri, uriToPath, uriKey, isFileUri } from './uri';
import { toNativePath, samePath } from '../../utils/pathUtils';

// isWindows() 读 navigator.userAgent，伪造 Windows 平台（同 uri.test.ts 做法）
const setUserAgent = (ua: string) => {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
};

/**
 * Windows 下 LSP 服务器可能返回的各种 file URI 变体端到端测试。
 * 验证「跳转打开的文件路径」在 Windows 上是否被正确归一化为本地形式（C:\a\b.java）。
 */
describe('Windows 跳转链路端到端（uri 变体 → 本地路径 → 同文件判定）', () => {
  let realUa: string;
  beforeEach(() => {
    realUa = window.navigator.userAgent;
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
  });
  afterEach(() => {
    setUserAgent(realUa);
  });

  const variants: Array<[string, string]> = [
    ['标准三斜杠 file:///C:/Users/mxq/code/proj/src/A.java', 'file:///C:/Users/mxq/code/proj/src/A.java'],
    ['小写盘符 file:///c:/...', 'file:///c:/Users/mxq/code/proj/src/A.java'],
    ['百分号编码盘符 file:///c%3A/...', 'file:///c%3A/Users/mxq/code/proj/src/A.java'],
    ['百分号编码空格', 'file:///C:/Users/mxq/my%20code/A.java'],
    ['单斜杠 file:/C:/...（java.io.File.toURI() 输出）', 'file:/C:/Users/mxq/code/proj/src/A.java'],
    ['无斜杠 file:C:/...（个别实现）', 'file:C:/Users/mxq/code/proj/src/A.java'],
    ['双斜杠盘符 file://C:/...（盘符被误当 authority）', 'file://C:/Users/mxq/code/proj/src/A.java'],
  ];

  it.each(variants)('%s → 转成本地路径', (_name, uri) => {
    const p = uriToPath(uri);
    const expected = uri.includes('my%20code')
      ? 'C:\\Users\\mxq\\my code\\A.java'
      : 'C:\\Users\\mxq\\code\\proj\\src\\A.java';
    expect(p).toBe(expected);
  });

  it.each(variants)('%s → 与标准形式 uriKey 一致（不会重复开 Tab）', (_name, uri) => {
    const canonical = uri.includes('my%20code')
      ? 'file:///C:/Users/mxq/my%20code/A.java'
      : 'file:///C:/Users/mxq/code/proj/src/A.java';
    expect(uriKey(uri)).toBe(uriKey(canonical));
  });

  it('definitionOpener 分支判断：单斜杠/无斜杠 file: 不会落进「不支持的目标」', () => {
    // DevAssistantView 用 isFileUri 路由 file scheme：
    // 单斜杠形式若不被识别会被 toast「不支持的定义跳转目标」。
    expect(isFileUri('file:/C:/Users/mxq/a.java')).toBe(true);
    expect(isFileUri('file:C:/Users/mxq/a.java')).toBe(true);
    expect(isFileUri('file:///C:/Users/mxq/a.java')).toBe(true);
    expect(isFileUri('jdt://contents/x')).toBe(false);
    expect(isFileUri('metals:readonly/x.scala')).toBe(false);
    expect(isFileUri('C:\\Users\\mxq\\a.java')).toBe(false);
  });

  it('跳转后的 Tab 路径与文件树路径（/ 拼接）判定为同一文件', () => {
    const jumpPath = uriToPath('file:///C:/Users/mxq/code/proj/src/A.java');
    const treePath = 'C:/Users/mxq/code/proj/src/A.java';
    expect(samePath(jumpPath, treePath)).toBe(true);
  });

  it('pathToUri 对 Windows 本地路径生成 Monaco 可解析的 URI', () => {
    const uri = pathToUri('C:\\Users\\mxq\\code\\proj\\src\\A.java');
    expect(uri.startsWith('file:///')).toBe(true);
    // 往返稳定
    expect(uriToPath(uri)).toBe('C:\\Users\\mxq\\code\\proj\\src\\A.java');
  });

  it('toNativePath 不破坏带 scheme 的字符串', () => {
    expect(toNativePath('file:///C:/a/b.java')).toBe('file:///C:/a/b.java');
    expect(toNativePath('jdt://contents/java.base/java.lang/String.class?x=1'))
      .toBe('jdt://contents/java.base/java.lang/String.class?x=1');
  });

  it('pathToUri 把畸形 file URI 重建为标准形式（Metals 原始 URI 不受影响）', () => {
    expect(pathToUri('file://C:/a/b.java')).toBe('file:///C:/a/b.java');
    expect(pathToUri('file:/C:/a/b.java')).toBe('file:///C:/a/b.java');
    expect(pathToUri('file:C:/a/b.java')).toBe('file:///C:/a/b.java');
    // Metals 依赖源码 Tab 的原始 URI 必须原样保留（服务器靠它识别只读文档）
    const metalsUri = 'file:///C:/Users/mxq/.metals/readonly/com/foo/Bar.scala';
    expect(pathToUri(metalsUri)).toBe(metalsUri);
    // UNC 形式原样保留
    expect(pathToUri('file://server/share/a.java')).toBe('file://server/share/a.java');
  });
});
