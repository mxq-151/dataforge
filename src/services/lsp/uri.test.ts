import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pathToUri, uriToPath, uriKey } from './uri';

/**
 * 定义跳转路径的 Windows 适配。
 *
 * LSP 服务器返回的 file:// URI 在 Windows 上有三种常见形态，且互不相等：
 *   file:///C:/Users/x/.java
 *   file:///c:/Users/x/.java      （盘符小写）
 *   file:///c%3A/Users/x/.java    （盘符小写 + 冒号百分号编码，VS Code / JDT.LS 常见）
 * 旧实现先匹配盘符正则再解码，遇到第三种会在路径前留下一个 `/`，导致跳转目标
 * 与文件树里的路径对不上（重复开 Tab、树不高亮、git / 编译取不到相对路径）。
 */

// isWindows() 读 navigator.userAgent，这里按需伪造平台，避免依赖真实运行环境
const setUserAgent = (ua: string) => {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
};

const originalUa = () => window.navigator.userAgent;

describe('uriToPath / pathToUri', () => {
  let realUa: string;
  beforeEach(() => {
    realUa = originalUa();
  });
  afterEach(() => {
    setUserAgent(realUa);
    vi.restoreAllMocks();
  });

  describe('Windows', () => {
    beforeEach(() => {
      setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    });

    it('转成 Windows 本地路径（反斜杠 + 盘符大写）', () => {
      expect(uriToPath('file:///C:/Users/mxq/.dataforge/a.java')).toBe(
        'C:\\Users\\mxq\\.dataforge\\a.java',
      );
    });

    it('盘符小写时归一化，指向同一文件', () => {
      expect(uriToPath('file:///c:/Users/mxq/a.java')).toBe('C:\\Users\\mxq\\a.java');
    });

    it('冒号被百分号编码（file:///c%3A/...）也能正确解析（先解码再剥盘符）', () => {
      expect(uriToPath('file:///c%3A/Users/mxq/a.java')).toBe('C:\\Users\\mxq\\a.java');
    });

    it('三种写法的 uriKey 相同 —— 同文件跳转不会被误判成外部目标', () => {
      const a = uriKey('file:///C:/Users/mxq/a.java');
      const b = uriKey('file:///c:/Users/mxq/a.java');
      const c = uriKey('file:///c%3A/Users/mxq/a.java');
      expect(a).toBe(b);
      expect(b).toBe(c);
    });

    it('含空格/中文的百分号编码路径能还原', () => {
      expect(uriToPath('file:///C:/Users/mxq/my%20code/%E6%B5%8B%E8%AF%95.scala')).toBe(
        'C:\\Users\\mxq\\my code\\测试.scala',
      );
    });

    it('Metals 依赖源码（.metals/readonly）路径同样转成本地形式', () => {
      const p = uriToPath(
        'file:///C:/Users/mxq/.metals/readonly/dependencies/spark-core_2.13-3.5.0-sources.jar/org/apache/spark/SparkContext.scala',
      );
      expect(p.startsWith('C:\\Users\\mxq\\.metals\\readonly\\')).toBe(true);
      expect(p.endsWith('\\SparkContext.scala')).toBe(true);
    });

    it('UNC（file://server/share/...）保留前导双分隔符', () => {
      expect(uriToPath('file://server/share/a.java')).toBe('\\\\server\\share\\a.java');
    });

    it('非法百分号转义不抛异常（坏字符不至于中断整条跳转链路）', () => {
      expect(() => uriToPath('file:///C:/a%ZZb/c.java')).not.toThrow();
    });

    it('非 file:// scheme 原样返回（jdt:// 虚拟文档）', () => {
      const jdt = 'jdt://contents/java.base/java.lang/String.class?=p';
      expect(uriToPath(jdt)).toBe(jdt);
    });

    it('pathToUri 把本地路径还原成 file:// URI', () => {
      expect(pathToUri('C:\\Users\\mxq\\a.java')).toBe('file:///C:/Users/mxq/a.java');
    });

    it('uriToPath → pathToUri 往返稳定', () => {
      const p = 'C:\\Users\\mxq\\code\\P\\src\\P\\Main.java';
      expect(uriToPath(pathToUri(p))).toBe(p);
    });
  });

  describe('macOS / Linux', () => {
    beforeEach(() => {
      setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    });

    it('保持 POSIX 绝对路径', () => {
      expect(uriToPath('file:///Users/mxq/.dataforge/a.java')).toBe('/Users/mxq/.dataforge/a.java');
    });

    it('百分号编码还原', () => {
      expect(uriToPath('file:///Users/mxq/my%20code/a.java')).toBe('/Users/mxq/my code/a.java');
    });

    it('pathToUri 生成标准 file:// URI', () => {
      expect(pathToUri('/Users/mxq/a.java')).toBe('file:///Users/mxq/a.java');
    });
  });
});
