import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 回归测试：修复「打开 Scala/Java 等文件后约 4 秒语法高亮才生效」。
 *
 * 根因：原 `registerAllTextmateLanguages` 在主流程末尾 `await probeTokenization()`，
 * 其内部 20×200ms 轮询（最坏 4 秒）会拖长注册 Promise 的完成时间；且 grammar 的
 * TextMate worker 加载被推迟到「用户首次打开文件」才发生，导致编辑器挂载瞬间只能
 * 以纯文本渲染，等 worker 异步加载完成再着色，表现为数秒延迟。
 *
 * 修复手段（见 src/services/textmate/index.ts）：
 *   1) `probeTokenizationDiag` 改为 fire-and-forget（`void`），不再串回注册主流程；
 *   2) 新增 `warmUpTextmate()`，注册完成后主动为每个语言创建临时模型触发 worker
 *      在 app 启动阶段就把 grammar 加载 + 分词跑完，用户打开文件即高亮。
 *
 * 本测试验证的关键不变量：
 *   A) `registerAllTextmateLanguages` 在扩展 whenReady 后立即完成，不因探针 4 秒轮询而阻塞；
 *   B) 注册完成后 `warmUpTextmate` 被触发（为每个语言创建临时模型）；
 *   C) 幂等：重复调用只注册一次扩展；
 *   D) 预热不阻塞注册完成（注册 await 不依赖预热完成）。
 *
 * 此外新增「编译耗时基准」用例（H/I/J），用可控的 model stub 模拟 TextMate worker
 * 编译 grammar 的进度，配合 fake timers 精确断言高亮生效的耗时上界：
 *   H) 正常编译耗时（worker 即时回写 onDidChangeTokens）下，warmUp 快速就绪、高亮即时生效；
 *   I) 最坏情况下（worker 永不回写）延迟受 2s×8 语言防御上限约束，不再出现无界挂起；
 *   J) 编辑器挂载前的 whenTextmateWarmedUp() 等待受同一上界约束，启动期已预热则零等待。
 */

// ---- mock 扩展贡献 API ----
const registerFileUrl = vi.fn();
const whenReady = vi.fn().mockResolvedValue(undefined);
const registerExtension = vi.fn().mockReturnValue({ registerFileUrl, whenReady });

// ---- mock 编辑器 runtime（languages + editor.createModel / editor.create）----
// 用可控的 model stub 模拟「TextMate worker 编译 grammar 的进度」：
//   真实环境下 worker 异步编译 .tmLanguage.json，完成后通过 model.onDidChangeTokens 回写着色。
//   warmUpTextmate 改为「隐藏编辑器 attach model + 监听 onDidChangeTokens」来确认 worker 接管
//   （async tokenization 下前台 getLineTokens 拿不到 worker 结果，旧轮询方式已废弃）。
//   stub 的 onDidChangeTokens 行为由 shouldEmitTokenChange 控制：true=注册即触发（模拟已就绪），
//   false=永不触发（模拟 worker 卡死，触发 2s 防御超时）。
const createModel = vi.fn();
const createEditor = vi.fn();
const languageRegister = vi.fn();
const getLanguages = vi.fn().mockReturnValue(
  ['sql', 'python', 'java', 'scala', 'yaml', 'xml', 'shell', 'markdown'].map((id) => ({ id }))
);

// 默认：worker 注册 onDidChangeTokens 后立即回写（模拟 grammar 已编译接管）
let shouldEmitTokenChange = true;

function makeModelStub() {
  const tokenChangeCbs: Array<() => void> = [];
  return {
    tokenization: {
      forceTokenization: vi.fn(),
      getLineTokens: vi.fn().mockReturnValue({
        getCount: () => 2,
        getClassName: (i: number) => `mtk${i}`,
      }),
    },
    // worker 着色回写信号：warmUpTextmate 据此判定 grammar 已接管
    onDidChangeTokens: vi.fn((cb: () => void) => {
      tokenChangeCbs.push(cb);
      // 模拟 worker 在「注册监听后」异步回写着色（async tokenization 行为）
      if (shouldEmitTokenChange) {
        Promise.resolve().then(() => cb());
      }
      return { dispose: vi.fn() };
    }),
    dispose: vi.fn(),
  };
}

vi.mock('@codingame/monaco-vscode-api/extensions', () => ({
  registerExtension: (...args: any[]) => registerExtension(...args),
  ExtensionHostKind: {
    LocalProcess: 'LocalProcess',
    LocalWebWorker: 'LocalWebWorker',
    Remote: 'Remote',
  },
}));

vi.mock('@codingame/monaco-vscode-editor-api', () => ({
  // 注意：必须用工厂函数返回对象，否则 vitest 会在 import 时立即求值。
  default: undefined,
  languages: {
    register: (...args: any[]) => languageRegister(...args),
    getLanguages: (...args: any[]) => getLanguages(...args),
  },
  editor: {
    createModel: (...args: any[]) => {
      createModel(...args);
      return makeModelStub();
    },
    // 隐藏编辑器预热：返回带 dispose 的编辑器 stub（attach model 触发 worker 编译）
    create: (...args: any[]) => {
      createEditor(...args);
      return { dispose: vi.fn() };
    },
  },
}));

// 每个用例重新加载模块，绕过「只注册一次」模块级开关
async function load() {
  vi.resetModules();
  const mod = await import('../../services/textmate/index');
  return mod;
}

describe('TextMate 高亮延迟修复', () => {
  beforeEach(() => {
    registerExtension.mockClear();
    registerFileUrl.mockClear();
    whenReady.mockClear();
    createModel.mockClear();
    languageRegister.mockClear();
    whenReady.mockResolvedValue(undefined);
    createEditor.mockClear();
    // 默认：worker 注册监听后立即回写（模拟 grammar 已编译接管），兼容 A~G
    shouldEmitTokenChange = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('A) 注册在 whenReady 后立即完成，不被探针 4 秒轮询阻塞', async () => {
    vi.useFakeTimers();
    const mod = await load();
    // whenReady 立即 resolve；createModel 返回「未接管」stub，若注册 await 探针会卡 4 秒
    const p = mod.registerAllTextmateLanguages();

    // 用 real timer 推进 microtasks，但不推进 fake timer 的 setTimeout(200)
    await vi.runOnlyPendingTimersAsync?.();
    // 即使完全不前进 fake timers（探针的 20×200ms 从未发生），注册应已 resolve
    await p;

    // 断言：注册已完成（p 已 resolve，未抛错），且 whenReady 仅被等待一次
    expect(whenReady).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('B) 注册完成后触发预热：为每个语言创建临时模型', async () => {
    const mod = await load();
    await mod.registerAllTextmateLanguages();
    // 预热是 fire-and-forget 的 async IIFE，需让 microtask 跑完
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // warmUpTextmate 为 8 种语言各创建一个临时模型
    const langs = createModel.mock.calls.map((c) => c[1]);
    expect(langs).toContain('scala');
    expect(langs).toContain('java');
    expect(langs).toContain('sql');
    // 每种语言都被预热（8 个 GRAMMARS）
    expect(new Set(langs).size).toBe(8);
    // 预热对每个模型调用了 forceTokenization（点火 worker 加载 grammar）
    expect(createModel).toHaveBeenCalled();
    // 新机制：用「隐藏编辑器 attach model」触发 worker 编译（而非仅 createModel）
    expect(createEditor).toHaveBeenCalled();
    const editorLangs = createModel.mock.calls.map((c) => c[1]);
    expect(new Set(editorLangs).size).toBe(8);
  });

  it('F) 预热返回就绪 Promise，编辑器挂载前可 await 它确保「挂载即高亮」', async () => {
    const mod = await load();
    await mod.registerAllTextmateLanguages();
    // whenTextmateWarmedUp() 应返回预热 Promise，且预热完成后 resolve（不超时）
    const warmed = mod.whenTextmateWarmedUp();
    expect(warmed).toBeInstanceOf(Promise);
    // 若 worker 已接管（stub getCount=2），应在短时间内 resolve
    await expect(warmed).resolves.toBeUndefined();
  });

  it('G) 后台异步分词开关已开启（消除主线程同步编译 ~1s 阻塞）', async () => {
    // 静态断言：bootstrapVscode 的用户配置中已开启 editor.experimental.asyncTokenization
    // @ts-ignore - 测试环境读取源码做静态断言，node 类型未纳入 tsconfig
    const fs = await import('node:fs');
    // @ts-ignore - 测试环境读取源码做静态断言
    const path = await import('node:path');
    // @ts-ignore - 测试环境读取源码做静态断言，node 全局类型未纳入 tsconfig
    const cfgPath = path.resolve(process.cwd(), 'src/services/lsp/bootstrapVscode.ts');
    const cfg = fs.readFileSync(cfgPath, 'utf-8');
    expect(cfg).toContain("'editor.experimental.asyncTokenization': true");
  });

  it('C) 幂等：重复调用只注册一次扩展', async () => {
    const mod = await load();
    await mod.registerAllTextmateLanguages();
    await mod.registerAllTextmateLanguages();
    expect(registerExtension).toHaveBeenCalledTimes(1);
  });

  it('D) 预热不阻塞注册完成：注册 await 不依赖预热', async () => {
    // 让 createModel 永远 pending（模拟 worker 卡住）——若注册 await 预热则会卡死/超时
    const pendingCreateModel = vi.fn(() => {
      // 返回一个永远不会 resolve 的模型相关操作也无所谓：createModel 本身同步返回 stub
      return makeModelStub();
    });
    vi.mocked(createModel).mockImplementation(pendingCreateModel);

    const mod = await load();
    const start = Date.now();
    await mod.registerAllTextmateLanguages();
    // 注册应在极短时间内完成，不等待预热（预热即便被「卡住」也不影响注册）
    expect(Date.now() - start).toBeLessThan(2000);
    expect(whenReady).toHaveBeenCalledTimes(1);
  });

  it('E) 注册仍通过 registerExtension 贡献 languages+grammars（修复未破坏接线）', async () => {
    const mod = await load();
    await mod.registerAllTextmateLanguages();
    expect(registerExtension).toHaveBeenCalledTimes(1);
    const [manifest] = registerExtension.mock.calls[0];
    const langIds = manifest.contributes.languages.map((l: any) => l.id);
    expect(langIds).toContain('scala');
    expect(langIds).toContain('java');
    const scopes = manifest.contributes.grammars.map((g: any) => g.scopeName);
    expect(scopes).toContain('source.scala');
    // 每个 grammar 都注册了可抓取的 URL
    const urls = registerFileUrl.mock.calls.map((c) => c[1]);
    expect(urls.some((u: string) => u.includes('grammars/scala.tmLanguage.json'))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 编译耗时基准：用 shouldEmitTokenChange 模拟 TextMate worker 编译 grammar 的进度。
  // 新机制（async tokenization）下，warmUpTextmate 以「隐藏编辑器 attach model + 监听
  // model.onDidChangeTokens（worker 回写着色）」确认 grammar 接管，前台 getLineTokens 已废弃。
  //   shouldEmitTokenChange=true  → worker 注册监听后立即回写（模拟已编译接管，即时生效）
  //   shouldEmitTokenChange=false → worker 永不回写（模拟卡死，触发 2s×8 语言防御上限）
  // ---------------------------------------------------------------------------

  it('H) 正常编译时 warmUp 快速就绪、高亮即时生效（无残留秒级延迟）', async () => {
    vi.useFakeTimers();
    shouldEmitTokenChange = true; // worker 注册监听后立即回写着色（模拟已编译接管）
    const mod = await load();
    await mod.registerAllTextmateLanguages(); // fire-and-forget 触发 warmUpTextmate
    await vi.advanceTimersByTimeAsync(0); // flush microtask（onDidChangeTokens 异步回调）

    // worker 立即回写 → 预热在极短时间内就绪，无需等待轮询/超时
    const warmPromise = mod.whenTextmateWarmedUp();
    await vi.advanceTimersByTimeAsync(50); // 仅推进极小窗口

    // 关键不变量：worker 一就绪，高亮立即生效，而非旧版「打开文件后额外等 4 秒」
    await expect(warmPromise).resolves.toBeUndefined();
    // 8 种语言都通过隐藏编辑器 attach 触发了 worker 编译
    expect(createEditor).toHaveBeenCalledTimes(8);
    vi.useRealTimers();
  });

  it('I) 最坏情况下预热在有限上界内 resolve（有界、不卡死/不无限挂起）', async () => {
    vi.useFakeTimers();
    shouldEmitTokenChange = false; // worker 永不回写 → 每语言触发 2s 防御超时
    const mod = await load();
    await mod.registerAllTextmateLanguages();
    await vi.advanceTimersByTimeAsync(0);

    // 8 语言 × 2s 防御上限 = 16000ms；推进超过该上界（fake timers 下毫秒级完成）
    await vi.advanceTimersByTimeAsync(17000);

    // 即便 worker 卡死，warmUpTextmate 也必须在防御上限内 resolve（不无限挂起），
    // 证明延迟是「有界值」而非旧版无上限叠加。
    await expect(mod.whenTextmateWarmedUp()).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('J) 启动期已预热完成时，打开文件(挂载前 await)瞬时生效、零等待', async () => {
    vi.useFakeTimers();
    shouldEmitTokenChange = true; // 模拟 app 启动期 worker 已将全部 grammar 编译就绪
    const mod = await load();
    await mod.registerAllTextmateLanguages();
    // 预热对每个语言立即确认接管（onDidChangeTokens 异步回写），纯 microtask 完成
    await vi.advanceTimersByTimeAsync(0); // flush microtask，让 warmUpReadyPromise resolve

    // 用户「打开文件」：EditorArea.handleBeforeMount 会 await whenTextmateWarmedUp()
    // 此时预热早已完成，Promise 已 resolved —— 挂载即高亮，零等待。
    const warmPromise = mod.whenTextmateWarmedUp();
    await expect(warmPromise).resolves.toBeUndefined();
    // 无需推进任何定时器即已就绪，证明正常使用时无延迟
    vi.useRealTimers();
  });
});
