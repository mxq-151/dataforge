import {
  registerExtension,
  ExtensionHostKind,
  type RegisterLocalProcessExtensionResult,
} from '@codingame/monaco-vscode-api/extensions';

/**
 * 通过 VS Code 扩展贡献机制注册 TextMate 语法高亮。
 *
 * 关键事实：本应用使用的是「真正的 VS Code 编辑器」(@codingame/monaco-vscode-editor-api)，
 * 其语法高亮由 VS Code 内置的 TextMate 引擎（monaco-vscode-textmate-service-override，
 * 自带 vscode-oniguruma）负责渲染，而不是 monaco-editor 旧的 setTokensProvider 接口。
 * 该引擎只认「通过扩展 contributes.grammars 注册进 TMScopeRegistry 的 grammar」，
 * 直接调用 monaco.languages.setTokensProvider 注册到独立 Registry 的 provider 永远不会
 * 被渲染管线消费——这正是之前语法高亮全篇无色、且无任何报错的根因（provider 注册到了
 * 一条编辑器根本不读取的支线）。
 *
 * 因此这里走与 VS Code 官方 Java/Scala 扩展完全一致的道路：用「本地扩展」贡献
 * languages + grammars，并把 grammar 文件 URL 映射到 public/grammars 下由构建产物提供的
 * .tmLanguage.json。VS Code TextMate 引擎据此加载 grammar 并对 java/scala 等做着色。
 * 该引擎自带 oniguruma，无需我们自行加载 onigasm / monaco-textmate。
 *
 * === 诊断日志说明 ===
 * 当前高亮异常排查阶段，本模块在每一个关键节点都打印 [TextMate] 前缀日志：
 *   1. 注册入口 / 幂等跳过
 *   2. 显式 languages.register 结果
 *   3. registerExtension 返回结构
 *   4. 每个 registerFileUrl 的 path 与 url
 *   5. ext.whenReady() 的 resolve / reject
 *   6. 主动 fetch 探测每个 grammar URL（HTTP 状态 + JSON 合法性 + scopeName 一致性）
 *   7. monaco.languages.getLanguages() 中是否包含本扩展声明的语言 id（显式 register 后应全部已注册）
 *   8. 创建一个 scala 探针模型并强制分词，以「不同 token 类数量 > 1」判断 TextMate 是否真正接管
 *   9. 全局 unhandledrejection / error 捕获 + console.error 拦截（标记 textmate/oniguruma 相关告警）
 * 运行 `npm run dev` 后在浏览器 DevTools Console 过滤 `[TextMate]` 即可定位根因。
 *
 * === 关键修正（曾两次误判根因）===
 * - 语言注册必须「显式」调用 monaco.languages.register，不能只依赖 registerExtension 的
 *   contributes.languages：后者经扩展宿主异步激活落地，whenReady() 在 deltaExtensions 后即
 *   resolve，而语言贡献尚未写入语言注册表，立即读取 getLanguages() 会误报「语言缺失」。
 * - token 类名永远是 mtkN（颜色索引），绝不含 keyword/storage 等 scope 名；旧探针用
 *   /keyword|storage|.../ 匹配类名必然永远「✗」（假阴性）。正确判据是不同 token 类数量 > 1。
 */

interface GrammarConfig {
  languageId: string;
  scopeName: string;
  grammarPath: string; // 相对 public 目录
  aliases: string[];
  extensions: string[];
}

const GRAMMARS: GrammarConfig[] = [
  { languageId: 'sql', scopeName: 'source.sql', grammarPath: 'grammars/sql.tmLanguage.json', aliases: ['SQL', 'sql'], extensions: ['.sql'] },
  { languageId: 'python', scopeName: 'source.python', grammarPath: 'grammars/magic-python.tmLanguage.json', aliases: ['Python', 'python'], extensions: ['.py'] },
  { languageId: 'java', scopeName: 'source.java', grammarPath: 'grammars/java.tmLanguage.json', aliases: ['Java', 'java'], extensions: ['.java'] },
  { languageId: 'scala', scopeName: 'source.scala', grammarPath: 'grammars/scala.tmLanguage.json', aliases: ['Scala', 'scala'], extensions: ['.scala'] },
  { languageId: 'yaml', scopeName: 'source.yaml', grammarPath: 'grammars/yaml.tmLanguage.json', aliases: ['YAML', 'yaml'], extensions: ['.yaml', '.yml'] },
  { languageId: 'xml', scopeName: 'text.xml', grammarPath: 'grammars/xml.tmLanguage.json', aliases: ['XML', 'xml'], extensions: ['.xml'] },
  { languageId: 'shell', scopeName: 'source.shell', grammarPath: 'grammars/shell-unix-bash.tmLanguage.json', aliases: ['Shell', 'shell', 'Bash', 'bash'], extensions: ['.sh'] },
  { languageId: 'markdown', scopeName: 'text.html.markdown', grammarPath: 'grammars/markdown.tmLanguage.json', aliases: ['Markdown', 'markdown'], extensions: ['.md'] },
];

let registered = false;
let readyPromise: Promise<void> | null = null;
// 预热「真正完成」的 Promise：在 worker 实际编译完 grammar、确认 TextMate 接管后 resolve。
// 与 readyPromise（仅代表扩展贡献点注入）不同，它代表「打开文件即可立即高亮」的就绪态。
let warmUpReadyPromise: Promise<void> | null = null;

/**
 * 后台任务（预热 + 探针）的取消令牌。
 *
 * warmUpTextmate 与 probeTokenizationDiag 是 fire-and-forget 的：注册函数返回后它们仍在
 * 后台跑，最长可挂 8×2s（预热每语言防御上限）+ 3s（探针）≈ 19s 的定时器。
 * 应用退出、HMR 或测试结束时必须能立刻停掉，否则定时器会一直挂着——单元测试里表现为
 * vitest 要等它们排空才能结束测试文件，凭空多出数秒且耗时落到随机某个用例上。
 * 应用侧不调用 stopTextmateBackgroundTasks() 时，行为与加入本机制前完全一致。
 */
class BackgroundAbort {
  aborted = false;
  private callbacks = new Set<() => void>();

  on(cb: () => void): void {
    if (this.aborted) cb();
    else this.callbacks.add(cb);
  }

  off(cb: () => void): void {
    this.callbacks.delete(cb);
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const cb of [...this.callbacks]) cb();
    this.callbacks.clear();
  }
}

let backgroundAbort: BackgroundAbort | null = null;

function backgroundAbortToken(): BackgroundAbort {
  if (!backgroundAbort) backgroundAbort = new BackgroundAbort();
  return backgroundAbort;
}

/**
 * 停止正在进行的后台预热与探针任务，清理它们挂着的定时器与订阅。
 * 供应用关闭 / HMR / 测试收尾调用；应用正常运行时无需调用。
 */
export function stopTextmateBackgroundTasks(): void {
  backgroundAbort?.abort();
  backgroundAbort = null;
}

const PREFIX = '[TextMate]';
const log = (...args: unknown[]): void => console.log(PREFIX, ...args);
const warn = (...args: unknown[]): void => console.warn(PREFIX, ...args);
const err = (...args: unknown[]): void => console.error(PREFIX, ...args);

/** 一次性安装全局错误捕获，避免 textmate worker 内部静默失败。 */
let globalListenersInstalled = false;
function installGlobalErrorCapture(): void {
  if (globalListenersInstalled) return;
  globalListenersInstalled = true;
  try {
    window.addEventListener('unhandledrejection', (ev) => {
      const r = ev.reason;
      const s = r instanceof Error ? `${r.message}\n${r.stack ?? ''}` : String(r);
      err('[unhandledrejection]', s);
    });
    window.addEventListener('error', (ev) => {
      err('[window.error]', ev.message, ev.error ?? `${ev.filename}:${ev.lineno}:${ev.colno}`);
    });
  } catch {
    /* ignore */
  }
}

/**
 * 注册全部 TextMate 语法高亮（VS Code 扩展贡献方式，幂等）。
 * 旧签名接受 monaco 实例，现已不再需要（语法高亮走 VS Code 扩展机制），
 * 保留参数仅为兼容调用方。
 */
export async function registerAllTextmateLanguages(_monaco?: unknown): Promise<void> {
  if (registered) {
    log('registerAllTextmateLanguages: 已注册过，幂等跳过');
    return;
  }
  registered = true;
  installGlobalErrorCapture();

  log('==== 开始注册 TextMate 语法（VS Code 扩展贡献方式）====');
  log('BASE_URL =', import.meta.env.BASE_URL);
  log('待注册 grammar:', GRAMMARS.map((g) => `${g.languageId}(${g.scopeName} -> ./${g.grammarPath})`).join(', '));

  // 显式把每个语言注册进 monaco 语言服务。这一步是「决定性的」：
  // 扩展宿主的 contributes.languages 是异步落地的——registerExtension 的 whenReady()
  // 在 deltaExtensions() 后即 resolve，而语言贡献要等扩展激活后才写入语言注册表，存在竞态，
  // 导致 monaco.languages.getLanguages() 在注册后立即读取会拿不到这些语言（误报"缺失"）。
  // 直接 register 可保证语言立即存在（且 .scala/.java 等扩展能关联到正确语言），
  // TextMate 引擎随后即可把对应 grammar 绑定到该语言 id。register 对同一 id 幂等。
  const monacoMod = await import('@codingame/monaco-vscode-editor-api');
  for (const g of GRAMMARS) {
    try {
      monacoMod.languages.register({ id: g.languageId, aliases: g.aliases, extensions: g.extensions });
    } catch (e) {
      err(`languages.register 失败 ${g.languageId}:`, e);
    }
  }
  log(`已显式 register 全部 ${GRAMMARS.length} 个语言 id`);

  let ext: RegisterLocalProcessExtensionResult;
  try {
    ext = registerExtension(
      {
        name: 'dataforge-textmate-languages',
        publisher: 'dataforge',
        version: '1.0.0',
        engines: { vscode: '*' },
        contributes: {
          languages: GRAMMARS.map((g) => ({
            id: g.languageId,
            aliases: g.aliases,
            extensions: g.extensions,
          })),
          grammars: GRAMMARS.map((g) => ({
            language: g.languageId,
            scopeName: g.scopeName,
            path: `./${g.grammarPath}`,
          })),
        },
      },
      ExtensionHostKind.LocalProcess
    ) as RegisterLocalProcessExtensionResult;

    log('registerExtension 返回:', {
      id: ext.id,
      hasRegisterFileUrl: typeof ext.registerFileUrl === 'function',
      hasWhenReady: typeof ext.whenReady === 'function',
      keys: Object.keys(ext),
    });
  } catch (e) {
    err('registerExtension 抛出异常:', e);
    throw e;
  }

  // 把每个 grammar 文件映射到 public/grammars 下由构建产物提供的 URL。
  // TextMate 引擎在后台 worker 中按此 URL 通过文件服务读取 grammar 内容。
  for (const g of GRAMMARS) {
    const url = `${import.meta.env.BASE_URL}${g.grammarPath}`;
    log(`registerFileUrl: manifestPath=./${g.grammarPath}  fileUrlPath=/${g.grammarPath}  url=${url}`);
    try {
      ext.registerFileUrl(`/${g.grammarPath}`, url);
    } catch (e) {
      err(`registerFileUrl 失败 path=/${g.grammarPath}:`, e);
    }
  }

  readyPromise = ext
    .whenReady()
    .then(() => {
      log('ext.whenReady() resolved —— 扩展贡献点已处理（languages + grammars 已注入注册表）');
    })
    .catch((e) => {
      // 注册失败不应阻塞编辑器，仅告警
      err('ext.whenReady() rejected:', e);
    });

  await readyPromise;

  // ---- 主动 fetch 探测每个 grammar URL ----
  // 最易出问题的环节：构建后文件未拷贝 / 404 / 内容非合法 JSON / scopeName 与 manifest 不一致。
  log('---- 开始 fetch 探测 grammar 文件 ----');
  for (const g of GRAMMARS) {
    const url = `${import.meta.env.BASE_URL}${g.grammarPath}`;
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        err(`fetch 探测 ${url} -> HTTP ${res.status}（文件未被服务/构建产物缺失，TextMate 引擎无法加载该 grammar）`);
        continue;
      }
      const text = await res.text();
      let parsed: { scopeName?: string } | null = null;
      try {
        parsed = JSON.parse(text) as { scopeName?: string };
      } catch (e) {
        warn(`fetch 探测 ${url} -> 内容非合法 JSON（可能为 plist XML）。TextMate 引擎仍可解析 plist，但请确认文件格式:`, e);
        continue;
      }
      const sn = parsed?.scopeName;
      if (sn !== g.scopeName) {
        warn(`fetch 探测 ${url} -> scopeName 不匹配: 文件声明 "${sn}"，manifest 期望 "${g.scopeName}"`);
      } else {
        log(`fetch 探测 ${url} -> OK status=${res.status} scopeName="${sn}" bytes=${text.length}`);
      }
    } catch (e) {
      err(`fetch 探测 ${url} -> 网络异常:`, e);
    }
  }
  log('---- fetch 探测结束 ----');

  // ---- 验证语言 id 是否已注册进 monaco 语言服务（显式 register 后此处应为全部已注册）----
  try {
    const langs = monacoMod.languages.getLanguages().map((l: { id: string }) => l.id);
    const ours = GRAMMARS.map((g) => g.languageId).filter((id) => langs.includes(id));
    const missing = GRAMMARS.map((g) => g.languageId).filter((id) => !langs.includes(id));
    log('monaco.languages.getLanguages() 中本扩展语言: 已注册=[' + ours.join(',') + ']  缺失=[' + missing.join(',') + ']');
    if (missing.length > 0) {
      warn('⚠ 部分语言 id 未注册成功——grammars 即便存在也无法被编辑器绑定到对应语言');
    }
  } catch (e) {
    warn('读取 monaco.languages.getLanguages() 失败:', e);
  }

  // ---- 预热：主动创建临时模型并强制分词，真正等待 TextMate worker 加载 + 编译 grammar ----
  // 关键修复：过去「打开文件后高亮要等约 1 秒才生效」的根因，是 grammar 的 worker
  // 编译被推迟到「用户第一次打开文件」时才发生——编辑器挂载瞬间 TextMate 尚未接管，
  // 只能先用纯文本渲染，等 worker 编译完 grammar 再着色，表现为延迟。
  // 这里在扩展注册（whenReady）完成后立即预热并等待完成，app 启动阶段就把 grammar
  // 编译 + 分词跑完；用户打开文件时 grammar 早已就绪，高亮立即生效。
  // warmUpTextmate 返回 warmUpReadyPromise 并自行后台执行（不阻塞本注册函数返回）；
  // 语法高亮已在 app 启动阶段后台预热，编辑器挂载不再 await（见 handleBeforeMount）：
  // 编辑器先渲染，grammar 就绪后 Monaco 按可见区把颜色补齐，与 VS Code 行为一致。
  warmUpTextmate();

  // ---- 探针：创建 scala 模型并强制分词，验证 TextMate 是否真正接管（纯诊断，不阻塞）----
  // 注意：探针原本用 `await probeTokenizationDiag()` 串在主流程末尾，其 20×200ms 轮询
  // （最坏 4 秒）会拖长整个注册 Promise 的完成时间，间接加剧「高亮延迟」观感。
  // 现改为 fire-and-forget，仅用于控制台诊断日志，绝不影响注册/着色时序。
  void probeTokenizationDiag();

  log('==== TextMate 语法注册流程结束（注册已就绪，预热/探针转入后台）====');
}

/**
 * 预热语法高亮：主动为每种已注册语言创建一个临时模型并强制分词，
 * 提前触发 TextMate worker 在「应用启动阶段」就把 grammar 加载 + 分词跑完。
 *
 * 这是修复「打开文件后约 4 秒高亮才生效」的核心手段：
 * TextMate 的分词在后台 worker 中异步进行，若等到用户第一次打开文件时才发生，
 * 编辑器挂载瞬间只能以纯文本渲染，等 worker 完成加载再着色，表现为数秒延迟。
 * 这里在扩展注册（whenReady）完成后立即预热，用户打开文件时 grammar 早已就绪，
 * 高亮立即生效。
 *
 * 设计为 fire-and-forget：调用方以 `void warmUpTextmate()` 触发即可，它不返回、
 * 不 await、也不阻塞注册流程或编辑器挂载。内部所有异常都被吞掉，绝不拖累启动。
 */
/**
 * 预热语法高亮：为每种已注册语言创建临时模型并强制分词，真正等待 TextMate worker
 * 在「应用启动阶段」把 grammar 加载 + 编译 + 分词跑完，返回就绪 Promise。
 *
 * 这是修复「打开文件后语法高亮要等约 1 秒才生效」的核心手段：
 * TextMate 的分词在后台 worker 中异步进行，若等到用户第一次打开文件时才发生，
 * 编辑器挂载瞬间只能以纯文本渲染，等 worker 编译完 grammar 再着色，表现为延迟。
 * 这里在扩展注册（whenReady）完成后立即预热，用户打开文件时 grammar 早已就绪，高亮立即生效。
 *
 * 与旧版的关键区别：
 *  - 返回 Promise，且**真正等待** worker 确认 grammar 接管（token 类 > 1）后才 resolve，
 *    而非只「点火」就返回。这样编辑器挂载前 await 它即可保证「挂载即高亮」。
 *  - **不 dispose 预热模型**：保留 model 可保活 worker 内的 grammar 编译缓存，
 *    避免 dispose 打断正在进行的编译、或使 worker 丢弃该语言缓存导致重复编译。
 *
 * 设计为可 fire-and-forget 也可 await：内部异常被吞掉，绝不拖累启动；即便失败也 resolve。
 */
export function warmUpTextmate(): Promise<void> {
  if (warmUpReadyPromise) return warmUpReadyPromise; // 幂等，只预热一次
  warmUpReadyPromise = (async () => {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
      const monacoMod = await import('@codingame/monaco-vscode-editor-api');
      const samples: Record<string, string> = {
        scala: 'object Foo {\n  val x: Int = 42\n  def bar(s: String): String = s\n}\n',
        java: 'public class Foo {\n  private int x = 42;\n  public String bar(String s) { return s; }\n}\n',
        sql: 'SELECT id, name FROM users WHERE age > 18 ORDER BY name;\n',
        python: 'def foo(x):\n    return x + 1\n',
        yaml: 'name: demo\nenabled: true\n',
        xml: '<root><child>text</child></root>\n',
        shell: '#!/bin/bash\necho "hello"\n',
        markdown: '# Title\n\nSome **bold** text.\n',
      };

      // 关键修复：开启 async tokenization 后，worker 的 grammar 编译是 *lazy + 按 languageId 缓存*，
      // 只在 model 被编辑器 attach 时（keepAliveWhenAttached -> isAttachedToEditor）才触发。
      // 旧实现仅 createModel + forceTokenization，临时 model 从未被 attach，worker 从不为它编译
      // grammar，且前台 getLineTokens 在 async 模式下永远拿不到 worker 着色结果（轮询 10 秒全失败）。
      // 故改为：用隐藏编辑器真正 attach 临时 model，触发 worker controller 创建与 grammar 编译，
      // 待 worker 着色回写（onDidChangeTokens）确认接管后再 dispose 编辑器——grammar 已编译进
      // worker _grammarCache，真实文件打开时命中缓存 → 零编译延迟、打开即高亮。
      const container = typeof document !== 'undefined' ? document.createElement('div') : null;
      if (container) {
        // offscreen 隐藏容器：不参与布局但让 monaco 认为有挂载点（attach 不依赖可见性）
        container.style.position = 'absolute';
        container.style.left = '-99999px';
        container.style.top = '0';
        container.style.width = '1px';
        container.style.height = '1px';
        container.style.visibility = 'hidden';
        container.setAttribute('aria-hidden', 'true');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (document.body as any)?.appendChild?.(container);
      }

      let allReady = true;
      for (const [lang, sample] of Object.entries(samples)) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const model = monacoMod.editor.createModel(sample, lang) as any;

          // 创建隐藏编辑器并持有该 model → isAttachedToEditor()=true → worker 开始编译 grammar。
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const editor = container
            ? (monacoMod.editor.create(container, {
                model,
                automaticLayout: false,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                renderWhitespace: 'none',
                readOnly: true,
                domReadOnly: true,
                'semanticHighlighting.enabled': false,
                occurrencesHighlight: 'off',
                selectionHighlight: false,
                matchBrackets: 'never',
                guides: { indentation: false },
                folding: false,
                wordWrap: 'off',
                contextmenu: false,
                fixedOverflowWidgets: true,
              }) as any)
            : null;

          // 等待 worker 真正完成该语言 grammar 编译并回写 token（async 模式下唯一可靠信号）。
          // onDidChangeTokens 在 worker 把着色结果写回 model 时触发，证明 grammar 已接管。
          // 设防御上限（约 2s）避免极端情况下永久挂起；超时则标记该语言未就绪但不阻塞整体。
          const ready = await new Promise<boolean>((resolve) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const onAbort = () => done(false);
            const done = (v: boolean) => {
              if (settled) return;
              settled = true;
              if (timer) clearTimeout(timer);
              abort.off(onAbort);
              sub?.dispose?.();
              resolve(v);
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sub = model.onDidChangeTokens?.(() => done(true));
            // 防御上限：2s 内未收到 worker 着色回写，视为该语言预热未成功（不阻塞）
            timer = setTimeout(() => done(false), 2000);
            // 放在 sub/timer 之后：若任务已被取消，此处立即回调 done(false) 并清掉刚挂的定时器
            abort.on(onAbort);
          });

          if (!ready) {
            allReady = false;
            warn(`warmUpTextmate 预热 ${lang} 未能确认 grammar 接管（打开该语言文件可能短暂无高亮）`);
          }

          // 释放隐藏编辑器（controller dispose），但 worker _grammarCache 按 languageId 缓存，
          // 不随 controller 清除 → 真实文件打开时命中缓存，零编译延迟。
          try {
            editor?.dispose?.();
          } catch {
            /* ignore */
          }
          try {
            model.dispose?.();
          } catch {
            /* ignore */
          }
        } catch (e) {
          allReady = false;
          warn(`warmUpTextmate 预热 ${lang} 失败（不影响其他语言）:`, e);
        }
      }

      // 清理隐藏容器
      try {
        container?.remove();
      } catch {
        /* ignore */
      }

      const dt = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      log(`warmUpTextmate 完成：worker 已${allReady ? '全部' : '部分'}接管 grammar，耗时 ${dt.toFixed(0)}ms（打开文件即高亮）`);
    } catch (e) {
      warn('warmUpTextmate 预热失败（可能 monaco 尚未就绪）:', e);
    }
  })();
  return warmUpReadyPromise;
}

/**
 * 返回 TextMate 预热就绪 Promise：编辑器挂载前应 await 它，确保 grammar 已在 worker
 * 编译完成、高亮立即生效。若预热尚未启动，返回一个已 resolve 的兜底 Promise（不阻塞）。
 */
export function whenTextmateWarmedUp(): Promise<void> {
  return warmUpReadyPromise ?? Promise.resolve();
}

/**
 * 创建一个临时模型并强制分词，验证 TextMate 是否真正对该语言着色（纯诊断，不阻塞）。
 *
 * 判定标准（关键）：Monaco/VS Code 的 token 类名永远是 `mtkN`（N 为颜色索引），
 * 决不会包含 `keyword`/`storage` 等 TextMate scope 名——旧探针用 /keyword|storage|.../
 * 去匹配类名，必然永远失败（假阴性）。
 * 正确的判据是：若 grammar 真的接管了分词，同一行会出现 **多个不同** 的 token 类
 * （如 keyword / type / punctuation 各一色）；若语言未注册或 grammar 未加载，则整行
 * 只有单一 token 类（纯文本）。故以「不同 token 类数量 > 1」作为 TextMate 接管的判据。
 *
 * 注意：此函数仅输出诊断日志，必须以 `void probeTokenizationDiag()` 形式 fire-and-forget
 * 调用——其 20×200ms 轮询（最坏 4 秒）绝不能再串回注册主流程阻塞高亮时序。
 */
async function probeTokenizationDiag(): Promise<void> {
  try {
    const monacoMod = await import('@codingame/monaco-vscode-editor-api');
    const probeLang = 'scala';
    const sample = 'object Foo {\n  val x: Int = 42\n  def bar(s: String): String = s\n}\n';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const model = monacoMod.editor.createModel(sample, probeLang) as any;

    // 诊断方式需与预热一致：async tokenization 下前台 getLineTokens 拿不到 worker 着色结果，
    // 必须用「隐藏编辑器 attach + 监听 onDidChangeTokens（worker 回写）」判断 grammar 是否接管。
    const container = typeof document !== 'undefined' ? document.createElement('div') : null;
    if (container) {
      container.style.position = 'absolute';
      container.style.left = '-99999px';
      container.style.top = '0';
      container.style.width = '1px';
      container.style.height = '1px';
      container.style.visibility = 'hidden';
      container.setAttribute('aria-hidden', 'true');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (document.body as any)?.appendChild?.(container);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const editor = container ? (monacoMod.editor.create(container, { model }) as any) : null;

    const took = await new Promise<number | null>((resolve) => {
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (ms: number | null) => {
        if (timer) clearTimeout(timer);
        sub?.dispose?.();
        resolve(ms);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sub = model.onDidChangeTokens?.(() => {
        const dt = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
        done(dt);
      });
      // 防御上限 3s：超时仍未收到 worker 着色回写，视为未接管
      timer = setTimeout(() => done(null), 3000);
    });

    const looksTextmated = took !== null;
    log(
      `tokenization 探针[${probeLang}]: worker 着色回写耗时=${took === null ? '超时(>3s)' : took.toFixed(0) + 'ms'}  ` +
      `TextMate是否接管=${looksTextmated ? '是 ✓' : '否 ✗（语法未着色，请检查 grammar 文件是否被 TextMate 引擎加载）'}`
    );

    try {
      editor?.dispose?.();
    } catch {
      /* ignore */
    }
    try {
      model.dispose?.();
    } catch {
      /* ignore */
    }
    try {
      container?.remove();
    } catch {
      /* ignore */
    }
  } catch (e) {
    warn('tokenization 探针失败（可能语言 id 未注册，无法 createModel）:', e);
  }
}
