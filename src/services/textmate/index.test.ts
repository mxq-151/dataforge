import { describe, it, expect, vi, beforeEach } from 'vitest';

// 验证「通过 VS Code 扩展贡献机制注册 TextMate 语法高亮」的接线逻辑。
// 旧实现用 monaco.languages.setTokensProvider 注册到一条扩展编辑器根本不读取的支线，
// 导致 java/scala 全篇无色。新实现走 registerExtension + contributes.grammars，
// 这正是扩展编辑器 TextMate 引擎读取 grammar 的唯一途径。

const registerFileUrl = vi.fn();
const whenReady = vi.fn().mockResolvedValue(undefined);
const registerExtension = vi.fn().mockReturnValue({ registerFileUrl, whenReady });

vi.mock('@codingame/monaco-vscode-api/extensions', () => ({
  registerExtension: (...args: any[]) => registerExtension(...args),
  ExtensionHostKind: {
    LocalProcess: 'LocalProcess',
    LocalWebWorker: 'LocalWebWorker',
    Remote: 'Remote',
  },
}));

// jsdom/vitest 下无法处理该模块链式的 .css 动态 import，mock 掉 editor runtime，
// 让测试聚焦在「扩展贡献 languages+grammars」的接线逻辑上（与 textmateFix.test.ts 一致）。
vi.mock('@codingame/monaco-vscode-editor-api', () => ({
  languages: {
    register: () => {},
    getLanguages: () => [
      { id: 'sql' }, { id: 'python' }, { id: 'java' }, { id: 'scala' },
      { id: 'yaml' }, { id: 'xml' }, { id: 'shell' }, { id: 'markdown' },
    ],
  },
  editor: {
    createModel: () => ({
      tokenization: { forceTokenization: () => {}, getLineTokens: () => ({ getCount: () => 1, getClassName: (i: number) => `mtk${i}` }) },
      dispose: () => {},
    }),
  },
}));

// 每个用例重新加载模块，绕过 app 级的「只注册一次」开关，保证都能真正走到注册逻辑
async function load() {
  vi.resetModules();
  return (await import('../../services/textmate/index')).registerAllTextmateLanguages;
}

describe('registerAllTextmateLanguages (VS Code 扩展贡献方式)', () => {
  beforeEach(() => {
    registerExtension.mockClear();
    registerFileUrl.mockClear();
    whenReady.mockClear();
  });

  it('通过 registerExtension 贡献 languages + grammars（而非 setTokensProvider）', async () => {
    const register = await load();
    await register();

    expect(registerExtension).toHaveBeenCalledTimes(1);
    const [manifest, kind] = registerExtension.mock.calls[0];
    expect(kind).toBe('LocalProcess');

    const langIds = manifest.contributes.languages.map((l: any) => l.id);
    expect(langIds).toContain('java');
    expect(langIds).toContain('scala');

    const grammarScopes = manifest.contributes.grammars.map((g: any) => g.scopeName);
    expect(grammarScopes).toContain('source.java');
    expect(grammarScopes).toContain('source.scala');

    const javaGrammar = manifest.contributes.grammars.find(
      (g: any) => g.scopeName === 'source.java'
    );
    expect(javaGrammar.path).toBe('./grammars/java.tmLanguage.json');
    expect(javaGrammar.language).toBe('java');
  });

  it('为每个 grammar 注册可抓取的 URL（映射到 public/grammars）', async () => {
    const register = await load();
    await register();

    const urls = registerFileUrl.mock.calls.map((c) => c[1]);
    expect(urls.some((u) => u.includes('grammars/java.tmLanguage.json'))).toBe(true);
    expect(urls.some((u) => u.includes('grammars/scala.tmLanguage.json'))).toBe(true);
    expect(urls.every((u) => typeof u === 'string' && u.length > 0)).toBe(true);
  });

  it('等待扩展 whenReady，确保 grammar 被 TextMate 引擎加载', async () => {
    const register = await load();
    await register();
    expect(whenReady).toHaveBeenCalledTimes(1);
  });

  it('幂等：重复调用只注册一次扩展', async () => {
    const register = await load();
    await register();
    await register();
    expect(registerExtension).toHaveBeenCalledTimes(1);
  });
});
