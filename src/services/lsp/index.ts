/**
 * LSP 模块统一入口。
 *
 * 现在统一使用 monaco-languageclient（即 vscode-languageclient 的 Web 移植，
 * VS Code 使用的同一套 LanguageClient 实现），不再自研 LSP client。
 * 通过 WebSocket 与 Electron 主进程启动的 JDT.LS (Java) / Metals (Scala) 通信。
 */
export {
  createLanguageClient,
  registerHeadlessHandlers,
  registerJavaClassFileProvider,
  registerMetalsSourceProvider,
  registerDefinitionOpener,
  readJavaClassFileContent,
  clearJavaClassFileCache,
  type LspLanguageId,
  type LspClientStatus,
} from './languageClient';

export { ensureVscodeApiStarted } from './bootstrapVscode';

export { pathToUri, uriToPath, uriKey, isFileUri } from './uri';
