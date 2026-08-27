/**
 * 一次性初始化「真正的 VS Code 编辑器」运行环境。
 *
 * 使用 monaco-languageclient 官方依赖的 @codingame/monaco-vscode-editor-api
 * （即 VS Code 的编辑器源码）与 @codingame/monaco-vscode-api（vscode 模块垫片），
 * 通过 MonacoVscodeApiWrapper 完成初始化——这与 VS Code 自身的编辑器/扩展
 * 运行时完全一致，monaco-languageclient 的 LanguageClient 也依赖这套运行时。
 *
 * 该初始化必须在应用生命周期内只执行一次。
 */
import * as monaco from '@codingame/monaco-vscode-editor-api';
import {
  MonacoVscodeApiWrapper,
  type MonacoVscodeApiConfig,
} from 'monaco-languageclient/vscodeApiWrapper';
import { useWorkerFactory, Worker } from 'monaco-languageclient/workerFactory';

// 显式加载 gotoSymbol 编辑器贡献（VS Code 同款 Go To Definition / References 等）。
// @codingame/monaco-vscode-editor-api 是可摇树的 edcore 发行版，默认不包含这些贡献，
// 不导入则 editor.action.revealDefinition / editor.action.goToReferences 等命令未注册，
// 导致 F12、右键「跳转到定义」无响应（editor.getAction(...) 返回 undefined）。
// 这两个模块在 import 阶段仅做 registerAction2 / registerEditorContribution，不会实例化
// 重型服务，故用顶层静态 import 保证在任何编辑器创建前完成注册。
import '@codingame/monaco-vscode-api/vscode/vs/editor/contrib/gotoSymbol/browser/goToCommands';
import '@codingame/monaco-vscode-api/vscode/vs/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition';
// 重命名符号（F2 / 右键「重命名符号」）：注册 RenameController 与 editor.action.rename。
// @codingame/monaco-vscode-editor-api 是可摇树的 edcore 发行版，默认不包含该贡献，
// 不导入则 F2 / editor.action.rename 命令未注册，重命名 UI（内联输入框 + 引用高亮）无法弹出。
// rename.js 内部会连带导入 renameWidget.js，后者通过 registerCss 注入 renameWidget.css，
// 无需单独引入样式。LSP 的 renameProvider 由 monaco-languageclient（vscode-languageclient 的
// RenameFeature）按服务器能力自动注册，此处只负责补齐编辑器侧的重命名控制器。
import '@codingame/monaco-vscode-api/vscode/vs/editor/contrib/rename/browser/rename';
// 补全列表（SuggestController / SuggestWidget）：edcore 发行版默认同样不包含 suggest
// 贡献。不导入则 SuggestController 永远不会被 registerEditorContribution 注册——
// LSP 的 completionProvider 照常由 monaco-languageclient 注册（服务器有返回），
// 但编辑器内没有任何组件消费它，表现为「悬停提示正常、自动补全弹窗完全不出现」，
// Ctrl+Space（editor.action.triggerSuggest）也无响应。
// suggestController.js 内部会连带导入 suggestWidget.js（通过 registerCss 注入样式）
// 与 snippetController2.js（snippet 格式的 insertText 展开依赖它）。
import '@codingame/monaco-vscode-api/vscode/vs/editor/contrib/suggest/browser/suggestController';

let started: Promise<typeof monaco> | null = null;

/**
 * 自定义 Monaco worker 工厂（editorWorkerService / TextMateWorker / extensionHostWorkerMain）。
 *
 * 为什么不能直接用 monaco-languageclient 的 configureDefaultWorkerFactory：
 * 它内部在 node_modules/monaco-languageclient/lib/worker/index.js 里用
 * `new Worker(new URL('@codingame/...', import.meta.url), ...)` 声明 worker 路径。
 * Vite 依赖预打包（rolldown）阶段会把这种「裸模块名」的 URL 字符串错误重写成不存在的相对路径
 * （../../monaco-languageclient/lib/worker/@codingame/...），于是 dev 模式下 worker 请求 404：
 *   Failed to fetch dynamically imported module:
 *   .../node_modules/monaco-languageclient/lib/worker/@codingame/.../editor.worker.js?worker_file&type=module?worker_file=&type=module
 *
 * 改在应用源码里声明相同的 URL 即可修复：应用源码不参与依赖预打包，Vite 的
 * worker-import-meta-url 插件会正确把 `@codingame/...` 裸模块说明符解析到
 * node_modules 下的真实文件，dev 模式下 worker 能正常加载。
 *
 * 注意：这里的 `Worker` 是从 monaco-languageclient/workerFactory 导入的「URL/options 描述类」，
 * 不是浏览器全局 Worker——useWorkerFactory 通过它拿到每个 worker 的 url 与 options 注册进
 * MonacoEnvironment（getWorkerUrl / getWorkerOptions）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function configureMonacoWorkers(logger?: any): void {
  useWorkerFactory({
    logger,
    workerLoaders: {
      editorWorkerService: () =>
        new Worker(
          new URL('@codingame/monaco-vscode-editor-api/esm/vs/editor/editor.worker.js', import.meta.url),
          { type: 'module' }
        ),
      extensionHostWorkerMain: () =>
        new Worker(new URL('@codingame/monaco-vscode-api/workers/extensionHost.worker', import.meta.url), {
          type: 'module',
        }),
      TextMateWorker: () =>
        new Worker(
          new URL('@codingame/monaco-vscode-textmate-service-override/worker', import.meta.url),
          { type: 'module' }
        ),
    },
  });
}

/**
 * 启动 VS Code 编辑器运行时（幂等）。
 * 返回 codingame 的 monaco 命名空间，可直接交给 @monaco-editor/react 的 loader。
 */
export function ensureVscodeApiStarted(): Promise<typeof monaco> {
  if (started) return started;

  started = (async () => {
    const config: MonacoVscodeApiConfig = {
      $type: 'extended',
      viewsConfig: {
        $type: 'EditorService',
      },
      userConfiguration: {
        json: JSON.stringify({
          'workbench.colorTheme': 'Default Dark Modern',
          'editor.wordBasedSuggestions': 'off',
          // 关键修复：开启后台异步分词（TextMate 在 worker 线程编译 grammar），
          // 而非前台主线程同步编译。关闭时首次打开 .scala 等文件主线程会被 grammar
          // 同步编译阻塞约 1 秒（即「高亮还是要等一秒」的根因）；开启后分词移到 worker，
          // 主线程零阻塞，且 warmUpTextmate 才能真正把 grammar 预编译进 worker 缓存。
          'editor.experimental.asyncTokenization': true,
          // 自定义主题的 colors 部分改为 VS Code 颜色定制，等价于
          // monaco.editor.defineTheme 的 colors——扩展运行时下 standalone
          // theme service 已被 VS Code ThemeService 取代，defineTheme 不可用。
          'workbench.colorCustomizations': {
            'editor.inactiveSelectionBackground': '#264F78',
            'editor.wordHighlightBackground': '#00000000',
            'editor.wordHighlightStrongBackground': '#00000000',
            'editor.hoverHighlight': '#00000000',
          },
        }),
      },
      monacoWorkerFactory: configureMonacoWorkers,
    };

    const apiWrapper = new MonacoVscodeApiWrapper(config);
    console.log('[bootstrapVscode] 开始 MonacoVscodeApiWrapper.start()，$type=extended（将自动注册 textmate + languages + theme service override）');
    await apiWrapper.start();
    console.log('[bootstrapVscode] MonacoVscodeApiWrapper.start() 完成 —— VS Code 编辑器运行时就绪');

    // ========== SuggestWidget 深度诊断（临时）==========
    // 现象矛盾：suggest-watch 显示 widget 渲染正常（h=252 rows=12）但用户看不到列表。
    // 本诊断区分三种可能：僵尸 widget / 列表透明 / CSS 未注入。
    // 用法：触发补全、弹窗应显示时（或小条可见时）在 Console 执行 dfDiag.deepCheck()
    (window as any).dfDiag = Object.assign((window as any).dfDiag ?? {}, {
      deepCheck: () => {
        const widgets = [...document.querySelectorAll('.suggest-widget')];
        const info: any = { widgetCount: widgets.length, widgets: [] };
        for (const w of widgets) {
          const el = w as HTMLElement;
          const r = el.getBoundingClientRect();
          const tree = el.querySelector('.tree') as HTMLElement | null;
          const cs = tree ? getComputedStyle(tree) : null;
          const rows = el.querySelectorAll('.monaco-list-row');
          const rowCs = rows[0] ? getComputedStyle(rows[0] as HTMLElement) : null;
          (info.widgets as any[]).push({
            className: el.className,
            rect: {
              top: Math.round(r.top), left: Math.round(r.left),
              width: Math.round(r.width), height: Math.round(r.height),
            },
            inlineStyle: el.getAttribute('style')?.slice(0, 120),
            parentCls: el.parentElement?.className,
            tree: tree
              ? {
                  h: tree.offsetHeight,
                  bg: cs!.backgroundColor,
                  color: cs!.color,
                  display: cs!.display,
                  visibility: cs!.visibility,
                  opacity: cs!.opacity,
                  overflow: cs!.overflow,
                }
              : null,
            row0: rowCs
              ? { h: (rows[0] as HTMLElement).offsetHeight, color: rowCs.color, bg: rowCs.backgroundColor }
              : null,
            rowCount: rows.length,
          });
        }
        // VS Code suggest 布局样式是否注入（registerCss → adoptedStyleSheets）
        let suggestSheets = 0;
        for (const s of document.adoptedStyleSheets) {
          try {
            for (const rule of s.cssRules) {
              const sel = (rule as any).selectorText ?? '';
              if (typeof sel === 'string' && sel.includes('suggest-widget')) { suggestSheets++; break; }
            }
          } catch { /* cross-origin */ }
        }
        info.adoptedSheets = document.adoptedStyleSheets.length;
        info.adoptedSheetsWithSuggestRules = suggestSheets;
        return info;
      },
    });

    // 说明：@monaco-editor/react 的 `theme` prop 会在编辑器挂载时调用
    // `monaco.editor.setTheme("Default Dark Modern")`。在扩展运行时下，standalone
    // 主题服务已被 VS Code ThemeService 取代，monaco.editor.defineTheme 内部依赖的
    // standaloneThemeService.defineTheme 为 undefined —— 调用必抛异常，无法再向
    // standalone registry 注册同名主题。因此不再尝试 defineTheme。
    //
    // 深色背景改由两层保障：
    //   1. workbench.colorTheme = 'Default Dark Modern' 让 VS Code ThemeService 应用
    //      主题的 TextMate token color map（语法高亮着色）；
    //   2. EditorArea.css 用 !important 把 .monaco-editor 背景强制为 #1f1f1f，
    //      兜底 setTheme no-op 导致的白底问题。
    // 两者互不冲突，视觉效果与 Default Dark Modern 一致。

    return monaco;
  })();

  return started;
}
