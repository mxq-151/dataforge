import { describe, it, expect, vi, beforeEach } from 'vitest';

// 验证「java/classFileContents 请求参数必须是 { uri } 对象（TextDocumentIdentifier）」。
//
// 根因：JDT.LS 该请求的服务端签名是
//   CompletableFuture<String> classFileContents(org.eclipse.lsp4j.TextDocumentIdentifier)
// 若客户端把 jdt:// URI 当裸字符串传过去，LSP4J 的 MessageJsonHandler.parseParams 无法把
// JSON string 反序列化为对象，返回错误 "Message could not be parsed."（这正是跳第三方 JAR
// 时 Tab 里显示的报错）。VS Code Java 扩展（providerDispatcher.ts 的 createJDTContentProvider）
// 传的是 { uri: uri.toString() }，本测试锁住同样的参数形状，防止回退成裸串。

// languageClient.ts 顶部的运行时依赖在 vitest/jsdom 下无法或无需真实加载，这里全部 mock，
// 只聚焦 readJavaClassFileContent / registerJavaClassFileProvider 的请求参数形状。
vi.mock('vscode', () => ({
  Uri: {
    file: () => ({}),
    parse: () => ({}),
  },
  workspace: {
    registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
    onDidOpenTextDocument: () => ({ dispose: () => {} }),
    textDocuments: [],
  },
  languages: {
    setTextDocumentLanguage: () => ({ then: () => {} }),
  },
}));

vi.mock('../../bridge/ipc', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@codingame/monaco-vscode-api', () => ({
  LogLevel: { Debug: 0, Error: 1, Warning: 2, Info: 3, Trace: 4 },
}));

vi.mock('monaco-languageclient/lcwrapper', () => ({
  LanguageClientWrapper: class {},
}));

// 每个用例重新加载模块，绕过模块级的 currentJavaClient / javaClassFileCache 状态残留
async function load() {
  vi.resetModules();
  return import('./languageClient');
}

describe('readJavaClassFileContent（jdt:// 类源码取回）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('以 { uri } 对象（而非裸字符串）作为 java/classFileContents 的参数', async () => {
    const { registerJavaClassFileProvider, readJavaClassFileContent } = await load();
    const sendRequest = vi.fn().mockResolvedValue('public class SparkSession {}');
    // 通过注册提供器把「当前 Java 客户端」注入模块（registerJavaClassFileProvider 会更新 currentJavaClient）
    registerJavaClassFileProvider({ sendRequest } as any);

    const uri = 'jdt://contents/spark-sql_2.12-3.5.0.jar/org.apache.spark.sql/SparkSession.class?=myproj';
    const out = await readJavaClassFileContent(uri);

    // 关键断言：第二个参数是对象 { uri }，绝不是裸字符串（裸串正是 "Message could not be parsed." 的成因）
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendRequest).toHaveBeenCalledWith('java/classFileContents', { uri });
    expect(sendRequest.mock.calls[0][1]).not.toBe(uri); // 排除「直接传字符串」的回归
    expect(typeof sendRequest.mock.calls[0][1]).toBe('object');
    expect(out).toBe('public class SparkSession {}');
  });

  it('结果按 URI 缓存，重复跳转同一类不再发第二次请求', async () => {
    const { registerJavaClassFileProvider, readJavaClassFileContent } = await load();
    const sendRequest = vi.fn().mockResolvedValue('public class SparkSession {}');
    registerJavaClassFileProvider({ sendRequest } as any);

    const uri = 'jdt://contents/a.jar/x/Y.class?=p';
    await readJavaClassFileContent(uri);
    await readJavaClassFileContent(uri);

    expect(sendRequest).toHaveBeenCalledTimes(1);
  });

  it('客户端未就绪时抛明确错误（而非静默返回空）', async () => {
    const { readJavaClassFileContent } = await load();
    // 不注入任何客户端，currentJavaClient 为 null
    await expect(readJavaClassFileContent('jdt://contents/a.jar/x/Y.class')).rejects.toThrow(
      'Java 语言客户端未就绪',
    );
  });

  it('服务端返回 null（无源码附件且反编译失败）→ 返回空串且仍缓存', async () => {
    const { registerJavaClassFileProvider, readJavaClassFileContent } = await load();
    const sendRequest = vi.fn().mockResolvedValue(null);
    registerJavaClassFileProvider({ sendRequest } as any);

    const uri = 'jdt://contents/a.jar/x/Y.class?=p';
    const out = await readJavaClassFileContent(uri);
    expect(out).toBe('');
    // 空结果也入缓存，避免同一类重复触发（可能很慢的）反编译请求
    await readJavaClassFileContent(uri);
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });
});
