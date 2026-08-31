/**
 * 基于 monaco-languageclient（即 vscode-languageclient 的 Web 移植）的官方 LSP client。
 *
 * 这是 VS Code 使用的同一套 LanguageClient 实现，因此 hover / 定义跳转 / 声明跳转 /
 * 补全 / 签名帮助 / 诊断 / 格式化 等全部由客户端根据服务器能力自动注册到 Monaco，
 * 与 VS Code 行为完全一致。我们不再自研任何 JSON-RPC、provider 映射或能力协商逻辑。
 *
 * 与语言服务器的传输使用 WebSocket（由 Electron 主进程把 JVM 子进程的 stdio 透传为
 * ws://127.0.0.1:<port>），这正是 monaco-languageclient 的标准连接范式。
 */
import * as vscode from 'vscode';
import { invoke } from '../../bridge/ipc';
import { LogLevel } from '@codingame/monaco-vscode-api';
import {
  LanguageClientWrapper,
  type LanguageClientConfig,
} from 'monaco-languageclient/lcwrapper';
import type { MonacoLanguageClient } from 'monaco-languageclient';
import type { BaseLanguageClient, Middleware } from 'vscode-languageclient';
import { stabilizeIncompleteResult, hoverIsComplete, hoverContentLen } from './stabilizeHover';

export type LspLanguageId = 'java' | 'scala';

export type LspClientStatus = 'disconnected' | 'starting' | 'running' | 'error';

/**
 * JDT.LS / Metals 的 initializationOptions。
 * 与 VS Code 官方扩展（Red Hat Java / Scala(Metals)）发送的内容保持一致，
 * 确保语言服务器以「与 VS Code 相同」的方式初始化。
 */
const JAVA_INITIALIZATION_OPTIONS = {
  settings: {
    java: {
      autobuild: { enabled: true },
      import: { maven: { enabled: true }, gradle: { enabled: false } },
      maven: {
        // 导入 Maven 项目时自动下载 sources jar（JDT.LS 默认 false，与 VS Code Java 插件一致）。
        // 开启后，纯 Java 写的第三方库（Guava / Jackson / commons 等，sources.jar 内是 .java）
        // 跳转能显示原始 .java 源码而非反编译。需重新导入（重启或切工作区）才生效。
        //
        // 注意：对 Scala 写的库（如 Spark，sources.jar 内是 .scala）本设置无效——JDT（Java LSP）
        // 的 ClassFile.getBuffer() 只认 .java 源文件，读不到 .scala，这类类跳转永远只能
        // FernFlower 反编译。想看 Scala 库源码须用 Scala（Metals）视角跳转。这是 Java 生态
        // 固有限制，VS Code 的 Red Hat Java 插件对 SparkSession 同样只显示反编译。
        downloadSources: true,
      },
      project: {
        // 源码根统一为工作区内的 src（Maven sourceDirectory）
        sourcePaths: ['src'],
        referencedLibraries: [],
      },
      completion: { filteredTypes: [] },
    },
  },
  bundles: [],
  // 声明客户端支持 jdt:// 类文件内容（java/classFileContents 自定义请求）。
  // JDT.LS 对二进制目标（JDK / 第三方 JAR 里的符号）的 textDocument/definition
  // 以此为开关：未声明时 NavigateToDefinitionHandler 直接返回空数组（悬停不受影响，
  // 因为 hover 不走这个门槛）——这正是「悬停正常、跳转为 count=0」的根因。
  // 声明后 definition 会返回 jdt://contents/... 虚拟文档 URI，由导航中间件交给
  // React 层以只读 Tab 打开（readJavaClassFileContent 负责取回源码/反编译结果）。
  extendedClientCapabilities: {
    classFileContentsSupport: true,
  },
};

const SCALA_INITIALIZATION_OPTIONS = {
  javaHome: null,
  mavenSupport: true,
  sbtVersion: null,
  metricEnabled: false,
  decorationProvider: false,
  inlineDecorationProvider: false,
  debuggingProvider: false,
  didFocusProvider: false,
  executeClientCommandProvider: true,
  inputBoxProvider: false,
  quickPickProvider: false,
  doctorProvider: 'html',
  statusProvider: 'html',
  isHttpEnabled: false,
  superMethodLensesEnabled: false,
  showInferredType: true,
  showImplicitArguments: false,
  showImplicitConversionsAndClasses: false,
};

/**
 * 创建一个语言客户端包装器（尚未启动）。
 * @param languageId 'java' | 'scala'
 * @param wsUrl Electron 主进程提供的语言服务器 WebSocket 地址
 * @param workspaceRoot 工作区根目录（作为 LSP rootUri / workspaceFolder）
 */
export function createLanguageClient(
  languageId: LspLanguageId,
  wsUrl: string,
  workspaceRoot: string
): LanguageClientWrapper {
  const initializationOptions =
    languageId === 'java' ? JAVA_INITIALIZATION_OPTIONS : SCALA_INITIALIZATION_OPTIONS;

  // 文档选择器：file:// 覆盖工作区文件和 Metals 提取到磁盘的依赖源码（.metals/readonly/）。
  // Java 的 jdt:// 虚拟文档需单独声明（JDT.LS 用 jdt:// scheme 返回类文件）。
  //
  // 注意：不要给 Scala 加 metals: scheme！实测 Metals 服务器在 headless 模式下不识别
  // metals:// 虚拟文档，didOpen 会让服务器返回 Internal error，连带把后续 file:// 的
  // definition/hover 请求也搞坏。jar 源码只读 Tab 内的悬停/跳转能力暂不支持（只读查看）。
  const documentSelector: Array<{ scheme: string; language: string }> = [
    { language: languageId, scheme: 'file' },
  ];
  if (languageId === 'java') {
    documentSelector.push({ language: 'java', scheme: 'jdt' });
  }

  const config: LanguageClientConfig = {
    languageId,
    logLevel: LogLevel.Debug,
    connection: {
      options: {
        $type: 'WebSocketUrl',
        url: wsUrl,
        startOptions: {
          onCall: (client?: BaseLanguageClient) => {
            console.log(`[LSP:${languageId}] languageClient.start() 已调用，client=`, client ? '已创建' : '未创建');
          },
        },
        stopOptions: {
          onCall: (client?: BaseLanguageClient) => {
            console.log(`[LSP:${languageId}] languageClient.stop() 被触发，client=`, client ? '存在' : '不存在');
          },
        },
      },
    },
    clientOptions: {
      documentSelector,
      workspaceFolder: {
        index: 0,
        name: 'workspace',
        uri: vscode.Uri.file(workspaceRoot),
      },
      initializationOptions,
      // 导航中间件：拦截 definition / typeDefinition / implementation / declaration /
      // references 的返回结果，区分「同文件内目标」（编辑器原地 reveal）与「外部目标」
      // （交给 React 层 definitionOpener 以新 Tab 打开）。Java 与 Scala 均挂载：
      // - Scala(Metals)：依赖源码位于 .metals/readonly/（file://），需预热内存缓存
      // - Java(JDT.LS)：项目内其它文件为 file://，JDK / 第三方库为 jdt:// 虚拟文档，
      //   二者都无法在单编辑器架构下由 EditorService 渲染，必须由 React 层接管。
      middleware: createNavigationMiddleware(languageId),
    },
  };

  return new LanguageClientWrapper(config);
}

/**
 * 注册 Metals 在无头环境下的「自动应答」处理器。
 *
 * Metals 在导入/构建等交互中会向客户端发起 window/showMessageRequest、
 * metals/quickPick、metals/inputBox 等请求并等待 UI 响应。桌面端无交互 UI 时，
 * 这里模拟「用户点了默认选项」，等价于原先 Rust 端的自动应答逻辑，保证索引/导入
 * 流程不被阻塞。
 *
 * 必须在客户端 start() 之后、服务器可能发起请求之前调用。
 */
export function registerHeadlessHandlers(client: MonacoLanguageClient): void {
  client.onRequest('window/showMessageRequest', (params: any) => {
    const actions: any[] = params?.actions ?? [];
    const importAction = actions.find((a) => /import/i.test(a?.title ?? ''));
    return importAction ?? actions[0] ?? null;
  });

  client.onRequest('metals/quickPick', (params: any) => {
    const items: any[] = params?.items ?? [];
    if (items.length === 1) return { id: items[0]?.id };
    const mavenItem = items.find((i) => /maven/i.test(i?.label ?? ''));
    return { id: (mavenItem ?? items[0])?.id ?? null };
  });

  client.onRequest('metals/inputBox', () => null);
}

/**
 * 注册 JDT.LS 的 `jdt://` 类文件内容提供器。
 *
 * JDT.LS 对 JDK / 第三方库的类定义返回的是 `jdt://` 协议的 Location（而非可直读
 * 的 file://）。这与 VS Code 的 Red Hat Java 扩展面临的问题一致：编辑器无法仅凭
 * `jdt://` URI 打开源码。Red Hat 扩展的做法是注册一个 `jdt` 方案的
 * TextDocumentContentProvider，当编辑器要打开 `jdt://` 位置时，向 JDT.LS 发
 * `java/classFileContents` 请求取回（源码附件或反编译出的）源码并显示为只读虚拟文档。
 *
 * 这里用完全相同的机制：通过 vscode.workspace.registerTextDocumentContentProvider 注册
 * `jdt` 方案提供器，编辑器「定义跳转」打开 jdt:// 位置时即回调此提供器拿源码。
 *
 * 仅注册一次（Java 客户端可能随工作区切换重启），用模块级开关守护。
 */
let javaClassFileProviderRegistered = false;
// 始终指向「当前」Java 语言客户端。客户端的生命周期随工作区切换会重建，
// 这里用模块级引用保存最新实例，避免内容提供器持有已 dispose 的陈旧客户端。
let currentJavaClient: MonacoLanguageClient | null = null;

export function registerJavaClassFileProvider(javaClient: MonacoLanguageClient): void {
  // 先刷新引用：即便提供器已注册过（重启场景），也要换成最新客户端
  currentJavaClient = javaClient;

  if (javaClassFileProviderRegistered) return;
  javaClassFileProviderRegistered = true;

  vscode.workspace.registerTextDocumentContentProvider('jdt', {
    provideTextDocumentContent: async (uri: vscode.Uri) => {
      if (!currentJavaClient) return '';
      try {
        // JDT.LS 自定义请求 java/classFileContents：参数类型是 TextDocumentIdentifier（对象
        // { uri: string }），不是裸字符串。服务端签名：
        //   CompletableFuture<String> classFileContents(org.eclipse.lsp4j.TextDocumentIdentifier)
        // 传裸串时 LSP4J 的 MessageJsonHandler.parseParams 无法把 JSON string 反序列化为对象，
        // 报 "Message could not be parsed."。这里与 VS Code Java 扩展 providerDispatcher.ts 的
        // createJDTContentProvider 保持一致：sendRequest(ClassFileContentsRequest.type, { uri }).
        const content = await currentJavaClient.sendRequest('java/classFileContents', {
          uri: uri.toString(),
        });
        return (content as string) ?? '';
      } catch (e) {
        console.warn('[LSP] 获取 JDT 类文件源码失败:', e);
        return '';
      }
    },
  });

  // jdt:// URI 没有 .java 后缀，VS Code 无法据此推断语言 → 默认按 plaintext 打开、
  // 既不高亮也容易被误认为「没反应」。这里在文档打开后强制设为 java，保证跳转后
  // 的 JDK / 第三方库源码以 Java 语法高亮显示，与 Red Hat Java 扩展行为一致。
  vscode.workspace.onDidOpenTextDocument((doc) => {
    if (doc.uri.scheme === 'jdt' && doc.languageId !== 'java') {
      // Thenable 无 .catch，用 .then 的 rejected 回调兜底
      vscode.languages.setTextDocumentLanguage(doc, 'java').then(undefined, () => undefined);
    }
  });
}

/**
 * 读取 jdt:// 类文件的源码内容（源码附件或反编译结果）。
 * 供 React 层在「定义跳转到 JDK / 第三方库」时以只读 Tab 打开（与 Red Hat Java
 * 扩展的 class file 查看体验一致）。内部复用 currentJavaClient，随工作区切换自动指向最新客户端。
 *
 * 结果按 URI 缓存在前端：JDT.LS 的反编译/源码取回对同一类是幂等的，缓存后重复跳转零延迟，
 * 也避免首次跳转后再次跳到同一类时重复触发（可能很慢的）反编译请求。
 */
const javaClassFileCache = new Map<string, string>();

export async function readJavaClassFileContent(uri: string): Promise<string> {
  const cached = javaClassFileCache.get(uri);
  if (cached !== undefined) {
    return cached;
  }
  if (!currentJavaClient) {
    throw new Error('Java 语言客户端未就绪（JDT.LS 尚未启动）');
  }
  // 参数必须是 { uri }（TextDocumentIdentifier），不能传裸字符串——见上方 provideTextDocumentContent 的注释。
  const content = await currentJavaClient.sendRequest('java/classFileContents', { uri });
  const text = (content as string) ?? '';
  invoke('trace_log', {
    msg: `[jdt] classFileContents uri=${uri} 返回长度=${text.length}`,
  }).catch(() => undefined);
  javaClassFileCache.set(uri, text);
  return text;
}

/** 清空 jdt 类源码缓存（工作区/JDK 切换后调用，避免拿到陈旧反编译结果）。 */
export function clearJavaClassFileCache(): void {
  javaClassFileCache.clear();
}

// ---------------------------------------------------------------------------
// Metals 依赖源码跳转支持
// ---------------------------------------------------------------------------

/**
 * 判断 URI 是否指向 Metals 的虚拟只读路径（依赖 JAR 内的源码）。
 *
 * Metals 对依赖库（如 spark-sql）的定义返回 `file://` URI，路径形如：
 *   /Users/.../.metals/readonly/dependencies/spark-sql-api_2.13-4.1.1-sources.jar/org/apache/spark/sql/SparkSession.scala
 * 该路径中 `.jar` 之后的部分是 JAR 内部路径，磁盘上不存在该文件。
 */
function isMetalsReadonlyUri(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && uri.path.includes('/.metals/readonly/');
}

/**
 * 预热 Metals 依赖源码的内存缓存。
 *
 * 调用 `read_metals_source`：该命令从 JAR 内**纯内存**读取源码
 * （不再提取/写盘到磁盘），并缓存在主进程内存中。此处的预热只是提前触发一次读取，
 * 使后续定义跳转打开 Tab 时可直接命中缓存、零延迟。真正的「打开」由
 * createMetalsMiddleware 把外部目标交给 registerDefinitionOpener（React 层以新 Tab 形式打开）。
 */
async function warmMetalsSourceCache(uri: vscode.Uri): Promise<void> {
  if (!isMetalsReadonlyUri(uri)) return;
  const filePath = decodeURIComponent(uri.fsPath);
  try {
    console.log(`[LSP:scala] 预热依赖源码内存缓存: ${filePath}`);
    await invoke<string>('read_metals_source', { path: filePath });
    console.log(`[LSP:scala] 依赖源码已就绪（内存）`);
  } catch (e) {
    console.warn(`[LSP:scala] 预热依赖源码失败:`, e);
  }
}

/**
 * 处理 LSP Location / DefinitionLink 结果：对指向 .metals/readonly/ 的 URI，
 * 预热其源码的内存缓存（便于后续通过 read_metals_source 直接命中缓存读取，纯内存、不落盘）。
 *
 * 本应用是「单编辑器 + Tab」体系：VS Code EditorService 打开的外部文档无法渲染在
 * React 的 <Editor> 中，因此不能依赖 file:// 改写或 content provider 让编辑器自行打开。
 * 这里只负责预热内存缓存，真正的「打开」由 createMetalsMiddleware 把外部目标交给
 * registerDefinitionOpener（React 层以新 Tab 形式打开）。
 */
async function processMetalsLocation(loc: any): Promise<any> {
  if (!loc) return loc;

  const extract = async (uriField: 'uri' | 'targetUri'): Promise<void> => {
    const raw = loc[uriField];
    if (!raw) return;
    const uri: vscode.Uri = typeof raw === 'string' ? vscode.Uri.parse(raw) : raw;
    if (isMetalsReadonlyUri(uri)) {
      await warmMetalsSourceCache(uri);
    }
  };

  await extract('uri');
  await extract('targetUri');
  return loc;
}

// 定义跳转结果交由 React 层以「新 Tab」形式打开的回调。
// 因为本应用是「单编辑器 + Tab」体系，VS Code EditorService 打开的外部文档无处渲染，
// 所以由 React 层接管：依赖源码（.metals/readonly）通过主进程读取并新建只读 Tab，
// 项目内文件则走现有的 handleFileSelect 打开为普通 Tab。
type DefinitionOpener = (locations: Array<{ uri: string; range?: any }>) => void;
let definitionOpener: DefinitionOpener | null = null;

export function registerDefinitionOpener(fn: DefinitionOpener | null): void {
  definitionOpener = fn;
}

/**
 * 创建语言客户端的「导航」中间件（Java / Scala 通用）。
 *
 * 拦截 definition / typeDefinition / implementation / declaration 的返回结果：
 * - 预热内存缓存（processMetalsLocation，仅对 .metals/readonly/ 的 Scala 依赖源码生效）
 * - 区分「同文件内目标」（交给编辑器在当前文档 reveal）与「外部目标」
 *   （交给 registerDefinitionOpener 以 Tab 形式打开）。这样既能保留同文件内的
 *   跳转高亮，又能让跨文件（项目内其它文件、JDK / 第三方 JAR 源码）跳转在
 *   本应用的 Tab 体系中可见。
 * references 仅预热缓存并返回原始结果，由 VS Code 的 peek 控件展示。
 */
function createNavigationMiddleware(languageId: LspLanguageId): Middleware {
  const handleNavigation = async (result: any, document: any): Promise<any> => {
    if (!result) return result;
    const items = Array.isArray(result) ? result : [result];
    // 注意：不在此处 await 预热（processMetalsLocation）。
    // 预热会同步读取 JAR 源码（首次很慢），若放在跳转 Tab 创建之前会显著拖慢「第一次跳转」。
    // 改为：opener 自身按需读取并命中 Rust 端内存缓存（read_metals_source 已缓存），
    // 后续重复跳转同样命中缓存。这里仅做轻量的同文件/外部目标分流。
    const docUri = document?.uri
      ? typeof document.uri === 'string'
        ? document.uri
        : document.uri.toString()
      : '';

    const sameFile: any[] = [];
    const external: Array<{ uri: string; range?: any }> = [];

    for (const loc of items) {
      const rawUri = loc?.uri ?? loc?.targetUri;
      if (!rawUri) continue;
      const uriStr = typeof rawUri === 'string' ? rawUri : rawUri.toString();
      const range = loc?.range ?? loc?.targetRange;
      if (docUri && uriStr === docUri) {
        sameFile.push(loc);
      } else {
        external.push({ uri: uriStr, range });
      }
    }

    if (definitionOpener && external.length) {
      // 不 await：避免阻塞编辑器；Tab 随后由 React 层打开
      invoke('trace_log', {
        msg: `[nav:${languageId}] 外部目标=${external.length} 首个=${external[0]?.uri} opener=${!!definitionOpener}`,
      }).catch(() => undefined);
      definitionOpener(external);
    } else if (external.length && !definitionOpener) {
      console.warn(`[LSP:${languageId}] definitionOpener 未注册！跨文件跳转无法以 Tab 形式打开。`);
    }

    // 仅把同文件内的目标交回编辑器（在当前文档内 reveal），
    // 外部目标已交给 React Tab 体系，避免 EditorService 打开不可见编辑器。
    if (sameFile.length === 0) return null;
    return Array.isArray(result) ? sameFile : sameFile[0];
  };

  // ========== 并发去重 + 短期结果缓存 ==========
  // 日志显示同一跳转 provider 被调用两次（F12/Ctrl+Click 双触发或重复点击），
  // 把 1.1s 的服务端往返翻倍成 ~2.2s。这里对同一 (method,doc,pos) 的在途请求
  // 复用同一个 Promise，并对「只读/虚拟源码目标」缓存 60s（项目内 file:// 不缓存，
  // 避免编辑后跳到陈旧位置）。重复跳到同一依赖符号 → 命中缓存零延迟。
  const inflight = new Map<string, Promise<any>>();
  const resultCache = new Map<string, { t: number; result: any }>();
  const RESULT_TTL = 60_000;

  const isReadonlyResult = (result: any): boolean => {
    const items = Array.isArray(result) ? result : [result];
    return items.some((loc: any) => {
      const raw = loc?.uri ?? loc?.targetUri;
      const s = typeof raw === 'string' ? raw : raw?.toString?.();
      return typeof s === 'string' && (
        s.includes('/.metals/readonly/') || s.startsWith('jdt:') || s.startsWith('metals:')
      );
    });
  };

  const dedupedProvide = async (
    method: string,
    document: any,
    position: any,
    token: any,
    next: any,
  ): Promise<any> => {
    const docKey = document?.uri
      ? (typeof document.uri === 'string' ? document.uri : document.uri.toString?.() ?? '')
      : '';
    const key = `${method}|${docKey}#${position.line}:${position.character}`;

    // 短期缓存命中（仅只读目标）→ 跳过服务端往返，仍走 handleNavigation（切 Tab/定位）
    const cached = resultCache.get(key);
    if (cached && Date.now() - cached.t < RESULT_TTL) {
      return handleNavigation(cached.result, document);
    }

    // 并发去重：同一 (method,doc,pos) 的在途请求复用，避免重复触发时打两次服务端
    const existing = inflight.get(key);
    if (existing) {
      return existing;
    }

    const p = (async () => {
      let result: any;
      try {
        result = await next(document, position, token);
      } catch (e) {
        invoke('trace_log', {
          msg: `[nav:${languageId}] ${method} 请求抛错: ${String((e as Error)?.message ?? e)}`,
        }).catch(() => undefined);
        throw e;
      }
      // 结果摘要：null / 条数 / 首个 URI（用于区分「服务器没返回」与「返回了无法路由的目标」）
      const cnt = Array.isArray(result) ? result.length : result ? 1 : 0;
      const firstUri = (() => {
        const it = Array.isArray(result) ? result[0] : result;
        const raw = it?.uri ?? it?.targetUri;
        return typeof raw === 'string' ? raw : raw?.toString?.();
      })();
      invoke('trace_log', {
        msg: `[nav:${languageId}] ${method} line=${position.line}:${position.character} 结果=${result === null ? 'null' : result === undefined ? 'undefined' : `count=${cnt}`} first=${firstUri ?? '(无)'}`,
      }).catch(() => undefined);
      if (isReadonlyResult(result)) {
        resultCache.set(key, { t: Date.now(), result });
      }
      return handleNavigation(result, document);
    })();
    inflight.set(key, p);
    try {
      return await p;
    } finally {
      inflight.delete(key);
    }
  };

  return {
    provideDefinition: async (document, position, token, next) =>
      dedupedProvide('definition', document, position, token, next),
    provideTypeDefinition: async (document, position, token, next) =>
      dedupedProvide('typeDefinition', document, position, token, next),
    provideImplementation: async (document, position, token, next) =>
      dedupedProvide('implementation', document, position, token, next),
    provideDeclaration: async (document, position, token, next) =>
      dedupedProvide('declaration', document, position, token, next),
    provideReferences: async (document, position, context, token, next) => {
      const result = await next(document, position, context, token);
      if (result) {
        const items = Array.isArray(result) ? result : [result];
        await Promise.all(items.map(processMetalsLocation));
      }
      return result;
    },
    // ========== Hover 稳定化（仅 Scala / Metals）==========
    // 背景：Metals 的 hover 有两层惰性——PC 冷启动 + scaladoc 异步解压。首次 hover
    // 某符号时通常只返回类型签名（如 "object org.apache.spark.sql.SparkSession"），
    // scaladoc 异步解析完后再请求才返回带文档的完整结果。后台预热虽能覆盖常用符号，
    // 但无法覆盖文件中所有符号，用户 hover 预热未覆盖的符号时仍会拿到不完整内容。
    //
    // 此处做同步重试稳定化：首次 hover 拿到内容较短（< 60 字符，疑似只有类型签名，即
    // 可能处于 PC 冷启动 / scaladoc 解压窗口）时，按递增退避再次请求。
    //
    // 关键设计（2026-08-27 重构，对齐 VS Code 源码）：
    //   完全绕过 vscode-languageclient 的 HoverFeature（即不调用 next），直接调用
    //   client.sendRequest('textDocument/hover') + protocol2CodeConverter.asHover()。
    //
    //   原因：vscode-languageclient 的 hover.js 在响应返回后检查
    //   token.isCancellationRequested，若手势已取消（鼠标移动/新手势开始）则丢弃结果
    //   返回 null，并对已取消 token 的请求补发 $/cancelRequest（可能打断 Metals 的
    //   scaladoc 解压）。而 VS Code 源码的 executeProvider（getHover.ts:27-34）在
    //   provider 返回后只检查结果有效性（isValid），不检查 token 取消。直接调用
    //   sendRequest 不涉及 token，与 VS Code 行为一致。
    //
    // 退避时长权衡（2026-08-26 调优）：
    //   - 早期版本用 [400,800,1600,3200]ms + settleTime=5000，冷符号最多等 ~6s。
    //     这对「无 scaladoc 的本地 val/var」极不友好——它们的类型签名就是最终内容，
    //     不会增长，却要空等 6s（settleTime 门槛未过不允许提前退出）。
    //   - 现改为 [300,600,1000,1500]ms + settleTime=1000：累计上限 ~3.4s，稳定短内容
    //     在越过 1s settle 窗口后连续两次无增长即退出（实测 ~1.9s）。
    //   - settleTime=1000 仍足以跨过 PC 冷启动常见的亚秒级平台期（内容短暂停滞几百 ms
    //     后继续增长）；Spark 依赖 scaladoc 的多秒级解压本就不在此覆盖——由后台预热
    //     （registerScalaHoverWarmup 三波错峰 + 4/8/12s 重试）与悬停失败后的
    //     scheduleHoverPositionWarmup 后台补拉负责。
    //   - 已温符号（首次即完整）零额外延迟直接返回；内容仍在增长就继续等，拿到完整结果
    //     即提前结束。
    // 不做结果缓存：每次 hover 都实时向 Metals 请求（Metals 温热后转手返回完整内容，
    // 零额外延迟），保证提示始终与服务端最新状态一致。
    // ========== Completion 日志 ==========
    // 打印 completion 请求/响应的 item 数量与触发方式，便于排查「补全不显示」类问题：
    // 响应 items=0 说明服务端未返回（如 Metals 版本 bug）；items>0 但弹窗不显示则问题
    // 在 Monaco 渲染侧（SuggestController / widget CSS）。
    provideCompletionItem: async (document, position, context, token, next) => {
      const t0 = performance.now();
      try {
        const result = await next(document, position, context, token);
        const items = Array.isArray(result) ? result : result?.items ?? [];
        console.log(
          `[LSP:${languageId}] Completion(${context?.triggerKind}${
            context?.triggerCharacter ? ` '${context.triggerCharacter}'` : ''
          }) @${position.line}:${position.character}: ` +
            `${items.length} 项, ${Math.round(performance.now() - t0)}ms`,
        );
        return result;
      } catch (e) {
        console.error(`[LSP:${languageId}] Completion 异常:`, e);
        throw e;
      }
    },
    provideHover: languageId === 'java'
      ? async (document, position, token, next) => {
          const result = await next(document, position, token);
          const text = typeof result?.contents === 'string'
            ? result.contents
            : JSON.stringify(result?.contents ?? null);
          invoke('trace_log', {
            msg: `[nav:java] hover line=${position.line}:${position.character} len=${text?.length ?? 0} 摘要=${text?.slice(0, 120) ?? '(null)'}`,
          }).catch(() => undefined);
          return result;
        }
      : languageId === 'scala'
      ? async (document, position, token, next) => {
          const client = currentMetalsClient;
          // Metals 客户端未就绪时，fallback 到 vscode-languageclient 默认 provider
          if (!client) {
            return next(document, position, token);
          }

          const uri = document?.uri
            ? (typeof document.uri === 'string' ? document.uri : document.uri.toString?.() ?? '')
            : '';
          const params = {
            textDocument: { uri },
            position: { line: position.line, character: position.character },
          };

          // 直接调用 client.sendRequest，绕过 vscode-languageclient 的 HoverFeature。
          // 不涉及 token，结果只要有效就返回，与 VS Code 的 executeProvider 行为一致。
          const rawRequest = async (): Promise<any> => {
            try {
              return await client.sendRequest('textDocument/hover', params);
            } catch (e) {
              console.warn('[LSP:scala] hover 请求失败:', e);
              return null;
            }
          };

          // 首次请求；已完整则零额外延迟返回（已温符号），否则进入稳定化重试。
          const initial = await rawRequest();

          const lspResult = await stabilizeIncompleteResult(
            initial,
            rawRequest,
            hoverContentLen,
            hoverIsComplete,
            [300, 600, 1000, 1500],
            2,       // noProgressLim：连续 2 次无增长（且过 settle）才提前结束
            1000,    // settleTime(ms)：未过此窗口不因无增长提前退出，跨 PC 平台期
          );

          // 仍未拿到完整内容 → 后台延迟补拉该位置（0/4s/8s/12s，最多 3 次），
          // 直接向 Metals 请求把该符号的 scaladoc 焐热。打开文件的三波预热只覆盖前 15
          // 个大写符号；预热未覆盖的符号首次悬停失败后若不补拉，Metals 可能一直未就绪，
          // 用户再次悬停也拿不到文档（表现为「永远只有类型签名」）。补拉成功后，用户
          // 下次悬停同一符号即可立即拿到完整内容。
          if (lspResult && !hoverIsComplete(lspResult)) {
            scheduleHoverPositionWarmup(uri, position);
          }

          // LSP Hover → vscode.Hover 协议转换（同步，由 protocol2CodeConverter 完成）
          if (!lspResult) return null;
          try {
            return client.protocol2CodeConverter.asHover(lspResult);
          } catch (e) {
            console.warn('[LSP:scala] hover 协议转换失败:', e);
            return null;
          }
        }
      : undefined,
  };
}

let metalsSourceProviderRegistered = false;
// 始终指向「当前」Metals 语言客户端（客户端可能随工作区切换重建）。
let currentMetalsClient: MonacoLanguageClient | null = null;

// hover 预热是否已注册（监听器全局一次）
let hoverWarmupRegistered = false;
// 记录已预热过的文档 URI，避免重复预热（用户切 Tab 来回切同一文件时）
const warmupDoneUris = new Set<string>();

// 对指定位置发送一次 hover 请求，返回是否附带文档（长度 > 60）。
// 与 provideHover 的 hoverIsComplete 不同：这里判定的是协议层原始结果（string / 数组 /
// MarkupContent），供预热与后台补拉共用。
const sendHover = (client: MonacoLanguageClient, uri: string, pos: { line: number; character: number }) =>
  client
    .sendRequest('textDocument/hover', {
      textDocument: { uri },
      position: { line: pos.line, character: pos.character },
    })
    .then(
      (r: any) => {
        const hasDoc = r?.contents && (typeof r.contents === 'string'
          ? r.contents.length > 60
          : Array.isArray(r.contents)
            ? r.contents.some((c: any) => (typeof c === 'string' ? c : c?.value)?.length > 60)
            : r.contents?.value?.length > 60);
        return hasDoc;
      },
      () => false,
    );

// 对单个符号做带重试的预热：首次失败后按 [4s, 8s, 12s] 递增间隔重试，
// 最多 3 次。覆盖 Metals scaladoc 异步解析较慢的情况。
const warmupSymbolWithRetry = (
  client: MonacoLanguageClient,
  uri: string,
  pos: { line: number; character: number },
  attempt = 0,
) => {
  const delays = [0, 4000, 8000, 12000];
  const delay = delays[attempt] ?? 0;
  setTimeout(() => {
    // 客户端可能已被替换（工作区切换），取最新引用
    const c = currentMetalsClient;
    if (!c || c !== client) return;
    sendHover(c, uri, pos).then((hasDoc) => {
      if (hasDoc) return; // 拿到文档，停止重试
      if (attempt < 3) {
        warmupSymbolWithRetry(client, uri, pos, attempt + 1);
      }
    });
  }, delay);
};

// 用户悬停过但未拿到完整文档的位置 → 上次安排后台补拉的时间戳。
// 冷却 60s（补拉链 0/4s/8s/12s 最长 ~24s，60s 保证链结束后可再次安排），
// 既覆盖「很久之后再悬停仍失败」的场景，又避免无文档符号被无限补拉。
const hoverPositionWarmupAt = new Map<string, number>();
const HOVER_WARMUP_COOLDOWN = 60_000;

/**
 * 对用户悬停过但未拿到完整内容的位置安排后台补拉（带 60s 冷却去重）。
 * 由 provideHover 在返回不完整结果时调用：三波文件级预热只覆盖前 15 个符号，
 * 预热未覆盖的符号靠这里兜底，保证用户再次悬停时 Metals 已焐热、能拿到完整文档。
 */
function scheduleHoverPositionWarmup(uri: string, pos: { line: number; character: number }): void {
  const client = currentMetalsClient;
  if (!client) return;
  const key = `${uri}#${pos.line}:${pos.character}`;
  const last = hoverPositionWarmupAt.get(key);
  if (last !== undefined && Date.now() - last < HOVER_WARMUP_COOLDOWN) return;
  hoverPositionWarmupAt.set(key, Date.now());
  warmupSymbolWithRetry(client, uri, pos, 0);
}

/**
 * 注册 hover 预热（仅 Scala / Metals）。
 *
 * 背景：Metals 的悬停由进程内 Presentation Compiler（PC）提供，存在两层惰性：
 *   1) PC 冷启动：每个构建目标（build target）首次 hover 时才启动，需加载完整类路径（Spark 规模数秒）
 *   2) scaladoc 加载：首次请求某符号时 Metals 才从 -sources.jar 解压解析 scaladoc，首次请求通常只返回类型签名
 *      （"object org.apache.spark.sql.SparkSession"），等 Metals 异步解析完 scaladoc 后再次请求才返回带文档的完整结果。
 *
 * 这会导致「同一符号悬停提示内容有时不一样」：用户首次 hover 拿到类型签名，预热完成后再次 hover
 * 拿到完整文档。预热的目标是在用户 hover 之前把常用符号的文档缓存到 Metals 内存中。
 *
 * 预热策略（三波错峰 + 失败重试）：
 *   - 第 1 波（didOpen 后 ~2s）：对文件里首个大写类名发 hover，目的是"踢醒" PC 启动 + 触发 scaladoc 解压
 *   - 第 2 波（didOpen 后 ~6s）：对前 15 个大写类名依次发 hover，此时 PC 与 scaladoc 应已就绪，真正把常用符号的
 *     文档缓存到 Metals 内存中，用户随后悬停即可秒回完整内容。
 *   - 第 3 波（第 2 波后）：对第 2 波中 hasDoc=false 的符号做延迟重试（最多 3 次，间隔递增 4s/8s/12s），
 *     覆盖 Metals 异步解析较慢的符号，确保最终所有预热符号都拿到完整文档。
 *
 * 两波之间的延迟给 Metals 留足时间完成初始导入与源码解析。仅对工作区源码文件预热，跳过量
 * 子/只读依赖源码（.metals/readonly/），避免在依赖源码 tab 里触发额外请求。
 */
function registerScalaHoverWarmup(): void {
  if (hoverWarmupRegistered) return;
  hoverWarmupRegistered = true;

  // 从文档中提取前 N 个大写开头的标识符（类/对象/trait 名）位置
  const findSymbolPositions = (doc: any, maxCount: number) => {
    const text: string = doc.getText?.() ?? '';
    const positions: { line: number; character: number }[] = [];
    const seen = new Set<string>();
    const re = /\b([A-Z][A-Za-z0-9_]*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null && positions.length < maxCount) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      try {
        const pos = doc.positionAt(m.index);
        positions.push({ line: pos.line, character: pos.character });
      } catch {
        /* ignore */
      }
    }
    return positions;
  };

  const scheduleWarmup = (doc: any) => {
    if (!doc || doc.languageId !== 'scala') return;
    const uriStr = doc.uri?.toString?.() ?? '';
    if (!uriStr || doc.uri?.scheme !== 'file') return;
    // 跳过热依赖只读源码（.metals/readonly/）——这些是 Metals 自己生成的虚拟路径，不需要预热
    if (uriStr.includes('/.metals/readonly/')) return;
    if (warmupDoneUris.has(uriStr)) return;
    warmupDoneUris.add(uriStr);

    const client = currentMetalsClient;
    if (!client) return;

    // 扩大符号覆盖数：从 5 提升到 15，覆盖文件中绝大多数类/对象/trait 名，
    // 避免用户 hover 第 6 个及之后的符号时仍拿到不完整内容
    const positions = findSymbolPositions(doc, 15);
    if (positions.length === 0) return;

    // 第 1 波：2 秒后发第一个符号，踢醒 PC 并触发 scaladoc 加载
    setTimeout(() => {
      // 客户端可能已被替换（工作区切换），取最新引用
      const c = currentMetalsClient;
      if (!c || c !== client) return;
      sendHover(c, uriStr, positions[0]).then((hasDoc) => {
        console.log(`[LSP:scala] hover 预热第1波完成: ${uriStr}, hasDoc=${hasDoc}`);
        // 第 1 波未拿到文档也属正常（PC 冷启动中），不在此重试，交给第 2 波处理
      });
    }, 2000);

    // 第 2 波：6 秒后依次发前 15 个符号，此时 scaladoc 应已解析完成，真正把文档缓存住。
    // 对其中 hasDoc=false 的符号，交给第 3 波做延迟重试。
    setTimeout(() => {
      const c = currentMetalsClient;
      if (!c || c !== client) return;
      // 顺序发送（间隔 300ms），避免并发请求让 Metals 队列拥塞
      let chain = Promise.resolve();
      const failedPositions: { line: number; character: number }[] = [];
      positions.forEach((pos, i) => {
        chain = chain.then(() =>
          sendHover(c, uriStr, pos).then((ok) => {
            if (!ok) failedPositions.push(pos);
            if (i === positions.length - 1) {
              console.log(
                `[LSP:scala] hover 预热第2波完成: ${uriStr}, 符号数=${positions.length}, 失败=${failedPositions.length}`,
              );
              // 第 3 波：对第 2 波未拿到文档的符号做延迟重试（内部按 4s/8s/12s 递增，
              // 最多 3 次），覆盖 Metals scaladoc 异步解析较慢的符号
              failedPositions.forEach((p) => warmupSymbolWithRetry(c, uriStr, p, 0));
            }
            return new Promise((res) => setTimeout(res, 300));
          }),
        );
      });
    }, 6000);
  };

  // LSP 就绪前已打开的文档 + 之后每次打开的文档
  (vscode.workspace.textDocuments ?? []).forEach(scheduleWarmup);
  vscode.workspace.onDidOpenTextDocument(scheduleWarmup);
}

/**
 * 切换工作区时清空已预热文档记录（不同项目的同名文件需要重新预热）。
 */
export function resetLspWarmupCache(): void {
  warmupDoneUris.clear();
  hoverPositionWarmupAt.clear();
}

/**
 * 注册 Metals 依赖源码提供器（后备）。
 *
 * 主路径是中间件把外部目标交给 React 层，由 React 以新 Tab 打开：Tab 内容通过主进程命令
 * `read_metals_source` 从 JAR 内**纯内存**读取（不落盘）。此处注册的 `metals:` scheme
 * TextDocumentContentProvider 仅作为后备（若 React 桥接未命中时的降级方案），同样走
 * read_metals_source 内存读取。
 *
 * 仅注册一次（Metals 客户端可能随工作区切换重启），用模块级开关守护。
 */
export function registerMetalsSourceProvider(metalsClient: MonacoLanguageClient): void {
  // 新客户端意味着新 Metals 进程（可能是工作区切换或重启），清空之前的预热记录，让新会话重新预热
  resetLspWarmupCache();
  currentMetalsClient = metalsClient;
  // hover 预热监听器全局一次（内部取 currentMetalsClient），随首个 scala 客户端注册
  registerScalaHoverWarmup();
  console.log('[LSP:scala] registerMetalsSourceProvider 调用, metalsSourceProviderRegistered=', metalsSourceProviderRegistered);

  if (metalsSourceProviderRegistered) return;
  metalsSourceProviderRegistered = true;
  console.log('[LSP:scala] 注册 metals: scheme TextDocumentContentProvider (后备)');

  vscode.workspace.registerTextDocumentContentProvider('metals', {
    provideTextDocumentContent: async (uri: vscode.Uri) => {
      // 把 metals: URI 转回 file:// URI——原始路径指向 .metals/readonly/ 下的虚拟路径
      const fileUri = uri.with({ scheme: 'file' });
      const filePath = decodeURIComponent(fileUri.fsPath);
      console.log(`[LSP:scala] 请求依赖源码: ${filePath}`);

      try {
        // 优先尝试主进程命令 read_metals_source：
        // 它从 JAR 内纯内存读取源码（不落盘），并按完整路径缓存在主进程内存中。
        const content = await invoke<string>('read_metals_source', { path: filePath });
        console.log(`[LSP:scala] 依赖源码获取成功, 长度=${content.length}`);
        return content;
      } catch (ipcErr) {
        console.warn(`[LSP:scala] read_metals_source 失败:`, ipcErr);
        // 后备：尝试 Metals 的 metals/textDocumentContent 请求
        // （某些 Metals 版本可能支持）
        if (currentMetalsClient) {
          try {
            const content = await currentMetalsClient.sendRequest('metals/textDocumentContent', {
              uri: fileUri.toString(),
            });
            const text = (content as string) ?? '';
            console.log(`[LSP:scala] 依赖源码获取成功 (LSP), 长度=${text.length}`);
            return text;
          } catch (lspErr) {
            console.warn('[LSP:scala] metals/textDocumentContent 也失败:', lspErr);
          }
        }
        return `// 无法加载依赖源码: ${filePath}\n// IPC 错误: ${ipcErr}\n// LSP 错误: 请求方法不支持`;
      }
    },
  });

  // metals: URI 没有 .scala 后缀，VS Code 无法据文件名推断语言 → 默认按 plaintext 打开。
  // 这里在文档打开后强制设为 scala，保证跳转后的依赖源码以 Scala 语法高亮显示。
  vscode.workspace.onDidOpenTextDocument((doc) => {
    if (doc.uri.scheme === 'metals' && doc.languageId !== 'scala') {
      vscode.languages.setTextDocumentLanguage(doc, 'scala').then(undefined, () => undefined);
    }
  });
}
