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
import { configureDefaultWorkerFactory } from 'monaco-languageclient/workerFactory';

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

let started: Promise<typeof monaco> | null = null;

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
      monacoWorkerFactory: configureDefaultWorkerFactory,
    };

    const apiWrapper = new MonacoVscodeApiWrapper(config);
    console.log('[bootstrapVscode] 开始 MonacoVscodeApiWrapper.start()，$type=extended（将自动注册 textmate + languages + theme service override）');
    await apiWrapper.start();
    console.log('[bootstrapVscode] MonacoVscodeApiWrapper.start() 完成 —— VS Code 编辑器运行时就绪');

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
