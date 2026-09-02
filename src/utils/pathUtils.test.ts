import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isWindows,
  toNativePath,
  pathKey,
  samePath,
  isPathUnder,
  toRelativePath,
} from './pathUtils';

/**
 * 跨平台路径工具。
 *
 * 同一文件在应用里可能以多种形式出现：
 *   - 文件树（joinPath 拼接 + '/' 分隔）：C:/Users/mxq/code/P/src/P/Main.java
 *   - 定义跳转（LSP file:// URI 解码后经 toNativePath 归一化）：C:\Users\mxq\code\P\src\P\Main.java
 *   - 后端 / git 命令行输出：盘符大小写与分隔符都不保证
 * 这些工具保证「比较」与「取相对路径」不受分隔符与盘符大小写影响。
 */

const setUserAgent = (ua: string) => {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
};

describe('pathUtils', () => {
  let realUa: string;
  beforeEach(() => {
    realUa = window.navigator.userAgent;
  });
  afterEach(() => {
    setUserAgent(realUa);
  });

  describe('Windows', () => {
    beforeEach(() => {
      setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    });

    it('isWindows 识别 Windows', () => {
      expect(isWindows()).toBe(true);
    });

    it('toNativePath 统一分隔符并把盘符转大写', () => {
      expect(toNativePath('c:/Users/mxq/a.java')).toBe('C:\\Users\\mxq\\a.java');
      expect(toNativePath('C:\\Users\\mxq\\a.java')).toBe('C:\\Users\\mxq\\a.java');
      expect(toNativePath('C:/Users//mxq///a.java')).toBe('C:\\Users\\mxq\\a.java');
    });

    it('toNativePath 不碰带 scheme 的 URI', () => {
      expect(toNativePath('jdt://contents/java.base/java.lang/String.class')).toBe(
        'jdt://contents/java.base/java.lang/String.class',
      );
      expect(toNativePath('file:///C:/a/b.java')).toBe('file:///C:/a/b.java');
    });

    it('samePath 忽略分隔符与盘符大小写', () => {
      expect(samePath('C:/Users/mxq/a.java', 'C:\\Users\\mxq\\a.java')).toBe(true);
      expect(samePath('c:/users/mxq/a.java', 'C:\\Users\\MXQ\\a.java')).toBe(true);
      expect(samePath('C:/Users/mxq/a.java', 'C:/Users/mxq/b.java')).toBe(false);
      expect(samePath(undefined, 'C:/a')).toBe(false);
    });

    it('isPathUnder 忽略分隔符差异（删除目录时关闭其下所有 Tab）', () => {
      expect(isPathUnder('C:\\Users\\mxq\\code\\P\\src\\P\\a.java', 'C:/Users/mxq/code/P')).toBe(true);
      expect(isPathUnder('C:\\Users\\mxq\\code\\Q\\a.java', 'C:/Users/mxq/code/P')).toBe(false);
    });

    it('toRelativePath 在混合分隔符下也能剥离前缀', () => {
      expect(toRelativePath('C:\\Users\\mxq\\code\\P\\src\\P\\a.java', 'C:/Users/mxq/code/P')).toBe(
        'src/P/a.java',
      );
      expect(toRelativePath('C:/Users/mxq/code/P', 'C:/Users/mxq/code/P')).toBe('');
    });

    it('toRelativePath 不在前缀下时返回统一成 / 分隔的绝对路径', () => {
      expect(toRelativePath('D:\\Other\\A.java', 'C:/Users/mxq/code/P')).toBe('D:/Other/A.java');
    });

    it('pathKey 用于集合去重（AI 变更路径 vs Tab 路径）', () => {
      expect(pathKey('C:\\Users\\A.java')).toBe(pathKey('c:/users/a.java'));
    });
  });

  describe('POSIX', () => {
    beforeEach(() => {
      setUserAgent('Mozilla/5.0 (X11; Linux x86_64)');
    });

    it('isWindows 为 false', () => {
      expect(isWindows()).toBe(false);
    });

    it('toNativePath 保持 / 分隔且区分大小写', () => {
      expect(toNativePath('/Users/mxq/a.java')).toBe('/Users/mxq/a.java');
      expect(toNativePath('/Users\\mxq/a.java')).toBe('/Users/mxq/a.java');
    });

    it('samePath 区分大小写', () => {
      expect(samePath('/Users/a.java', '/users/a.java')).toBe(false);
      expect(samePath('/Users/a.java', '/Users\\a.java')).toBe(true);
    });

    it('toRelativePath 剥离前缀', () => {
      expect(toRelativePath('/home/mxq/code/P/src/a.java', '/home/mxq/code/P')).toBe('src/a.java');
    });
  });
});
