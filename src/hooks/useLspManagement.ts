import { useEffect, useCallback, useRef, useState } from 'react';
import { invoke } from '../bridge/ipc';
import { listen } from '../bridge/event';
import type { LanguageClientWrapper } from 'monaco-languageclient/lcwrapper';
import {
  createLanguageClient,
  registerHeadlessHandlers,
  registerJavaClassFileProvider,
  registerMetalsSourceProvider,
  type LspLanguageId,
  type LspClientStatus,
} from '../services/lsp';
import { fetchDependencyList } from '../api/dependency';
import { ensurePomReady, clearPomCache } from '../services/ensurePomReady';
import type { DependencyItemLite } from '../utils/dependencyMerge';

interface UseLspManagementParams {
  javaHome?: string;
  workspaceRoot?: string;
  mavenHome?: string;
  mavenGroupId?: string;
  mavenArtifactId?: string;
  scalaVersion?: string;
  /** 设置页 POM 模板，透传给 ensurePomReady 生成与设置一致的 LSP pom */
  pomTemplate?: string;
  /** 项目级依赖（默认依赖集合），用于驱动 LSP classpath（悬停提示） */
  projectDependencies?: DependencyItemLite[];
  /** 项目 ID / 编码 / 根路径：用于把「项目级依赖配置」并入 LSP 的 pom（与编译一致） */
  projectId?: number;
  projectCode?: string;
  rootPath?: string;
  /** 项目源码目录（透传给 ensurePomReady，作为 pom <sourceDirectory> 与 bloop sourceDir） */
  sourceDir?: string;
  /** 覆盖 bloop 输出目录（透传给 ensurePomReady） */
  bloopConfigDirectory?: string;
  /** 是否在 bloop 导出时下载依赖源码（透传给 ensurePomReady） */
  bloopDownloadSources?: boolean;
}

interface WsStartResult {
  client_id: number;
  ws_url: string;
}

interface StartedLsp {
  wrapper: LanguageClientWrapper;
  clientId: number;
}

/**
 * 使用官方 monaco-languageclient（LanguageClientWrapper）管理 Java(JDT.LS) 与
 * Scala(Metals) 的语言客户端生命周期。
 *
 * 与自研客户端不同：
 * - 文档同步（didOpen/didChange/didClose）、能力协商、以及 hover/定义/补全/诊断等
 *   Monaco provider 的注册，全部由 LanguageClientWrapper（即 vscode-languageclient）
 *   根据服务器能力自动完成，无需手写映射。
 * - 我们只负责「按需启动 / 切换时保活 / 卸载时销毁」以及「JDT.LS 依赖库变更通知」。
 */
export function useLspManagement({
  javaHome,
  workspaceRoot,
  mavenHome,
  mavenGroupId,
  mavenArtifactId,
  scalaVersion,
  pomTemplate,
  projectDependencies,
  projectId,
  projectCode,
  rootPath,
  sourceDir,
  bloopConfigDirectory,
  bloopDownloadSources,
}: UseLspManagementParams) {
  const javaWrapperRef = useRef<LanguageClientWrapper | null>(null);
  const scalaWrapperRef = useRef<LanguageClientWrapper | null>(null);
  // 后端 LspWsManager 为每个 start_* 返回唯一 client_id；必须用它显式 stop，
  // 否则 JVM 不会被回收，且 JDT.LS 的 -data 工作区锁（按 workspace_root 派生）一直被占用，
  // 下一次 start 会因抢不到锁而启动失败（表现为「只成功一回，之后都失败」）。
  const javaClientIdRef = useRef<number | null>(null);
  const scalaClientIdRef = useRef<number | null>(null);
  // 防止并发重复启动（StrictMode 双调用 / 快速重入）导致同时拉起多个 JVM 抢同一把锁
  const javaStartingRef = useRef(false);
  const scalaStartingRef = useRef(false);
  // 记录当前客户端是用哪个工作区 / JDK 启动的，工作区变化时需先停后启
  const startedWorkspaceRef = useRef<string | undefined>(undefined);
  const startedJavaHomeRef = useRef<string | undefined>(undefined);
  const [javaStatus, setJavaStatus] = useState<LspClientStatus>('disconnected');
  const [scalaStatus, setScalaStatus] = useState<LspClientStatus>('disconnected');

  // 显式停止某个语言客户端：优先调用后端 stop_*（按 client_id 回收 JVM 并释放 -data 锁），
  // 兜底再 dispose 前端 wrapper。两者都做，确保无论后端 WS 是否被前端正常关闭，JVM 都能被回收。
  const stopLanguage = useCallback(async (languageId: LspLanguageId) => {
    const idRef = languageId === 'java' ? javaClientIdRef : scalaClientIdRef;
    const wrapperRef = languageId === 'java' ? javaWrapperRef : scalaWrapperRef;
    // 先快照本次要停止的实例，避免与并发的重新启动竞争（重新启动会替换 ref）
    const clientId = idRef.current;
    const wrapper = wrapperRef.current;
    try {
      if (clientId != null) {
        const cmd = languageId === 'java' ? 'stop_java_lsp_ws' : 'stop_scala_lsp_ws';
        await invoke(cmd, { clientId });
      }
    } catch (e) {
      console.warn(`[LSP] stop_${languageId}(client_id=${clientId}) 失败:`, e);
    } finally {
      // 仅当 ref 仍指向本次停止的实例时才清空，避免误清空并发重新启动产生的新实例
      if (idRef.current === clientId) idRef.current = null;
      if (wrapperRef.current === wrapper) wrapperRef.current = null;
    }
    try {
      await wrapper?.dispose();
    } catch {
      /* ignore */
    }
  }, []);

  const startWrapper = useCallback(
    async (languageId: LspLanguageId, res: WsStartResult): Promise<StartedLsp> => {
      if (!javaHome || !workspaceRoot) {
        throw new Error('javaHome / workspaceRoot 未配置');
      }
      // ⚠️ 不要在此做 WebSocket 探测！后端 run_bridge 只 accept 一次连接，
      // 连接关闭后会 kill_child（杀死 JVM）。探测会消耗唯一连接 → Metals 被杀 →
      // wrapper.start() 的 WebSocket 触发 onerror → "Websocket connection failed"。
      // 直接交给 wrapper.start() 建立连接即可。

      const wrapper = createLanguageClient(languageId, res.ws_url, workspaceRoot);
      console.log(`[LSP:${languageId}] LanguageClientWrapper 已创建，准备 start()`);
      try {
        await wrapper.start();
        console.log(`[LSP:${languageId}] LanguageClientWrapper.start() 成功`);
      } catch (e: any) {
        // monaco-languageclient 的错误对象是 { message, error }，error 可能是字符串
        // "No error was provided"。这里把完整对象打印出来便于定位。
        console.error(`[LSP:${languageId}] LanguageClientWrapper.start() 失败:`, e);
        console.error(`[LSP:${languageId}] 失败详情: message=${e?.message}, error=`, e?.error);
        throw e;
      }

      const client = wrapper.getLanguageClient();
      if (client) registerHeadlessHandlers(client);
      // 注册 jdt:// 类文件内容提供器（仅 Java），让「定义跳转」到 JDK / 第三方库时
      // 能向 JDT.LS 取回源码并显示。全局只注册一次，这里只对 Java 客户端调用。
      if (languageId === 'java' && client) registerJavaClassFileProvider(client);
      // 注册 metals: 依赖源码内容提供器（仅 Scala），让「定义跳转」到 Spark 等
      // 依赖库的源码时能向 Metals 取回源码并显示。全局只注册一次。
      if (languageId === 'scala' && client) registerMetalsSourceProvider(client);

      return { wrapper, clientId: res.client_id };
    },
    [workspaceRoot]
  );

  // 进入项目即启动：项目配置就绪（javaHome / workspaceRoot 可用）即启动对应语言客户端，
  // 不再依赖打开具体的 .java/.scala 文件——这样悬停提示 / 补全 / 跳转在打开文件前就已就绪。
  //
  // 关键修复（解决「只成功一回，之后都失败」）：
  // 1) 用 javaStartingRef / scalaStartingRef 防止并发重复启动（严格模式下 effect 会双调用），
  //    避免同一时刻拉起多个 JVM 抢 JDT.LS 的 -data 工作区锁。
  // 2) 销毁时调用后端 stop_* 显式回收 JVM 并释放 -data 锁；否则下一次 start 会因抢不到锁而失败。
  // 3) 工作区 / JDK 变化时，先停掉用旧工作区启动的客户端，再重新拉起，避免新旧 JVM 锁冲突。
  useEffect(() => {
    if (!javaHome || !workspaceRoot) return;

    const launch = async (languageId: LspLanguageId) => {
      const startingRef = languageId === 'java' ? javaStartingRef : scalaStartingRef;
      const setStatus = languageId === 'java' ? setJavaStatus : setScalaStatus;
      if (!javaHome || !workspaceRoot) return;
      if (startingRef.current) return; // 已在启动中，避免并发拉起多个 JVM 抢同一把锁
      startingRef.current = true;
      setStatus('starting');
      // 捕获 Metals 真实 stderr 与退出事件，避免“启动中”成为信息黑洞
      const stderrLines: string[] = [];
      const unlisteners: Array<() => void> = [];
      let exited = false;
      try {
        // 确保 Maven 工程（pom.xml / bloop）就绪，并把「项目级依赖」并入 pom，
        // 使 LSP 的类路径与编译路径一致（否则 spark-sql 等类无法在编辑器内跳转）。
        await ensurePomReady(javaHome, mavenHome || '', workspaceRoot, {
          mavenGroupId,
          mavenArtifactId,
          scalaVersion,
          pomTemplate,
          projectId,
          projectCode,
          rootPath,
          sourceDir,
          bloopConfigDirectory,
          bloopDownloadSources,
        });

        const cmd = languageId === 'java' ? 'start_java_lsp_ws' : 'start_scala_lsp_ws';
        console.log(`[LSP:${languageId}] 调用主进程命令 ${cmd}，javaHome=${javaHome}, workspaceRoot=${workspaceRoot}`);
        const res = await invoke<WsStartResult>(cmd, { javaHome, workspaceRoot });
        console.log(`[LSP:${languageId}] 主进程返回 ws_url=${res.ws_url}, client_id=${res.client_id}`);

        // 监听 Metals 进程退出（带最后 N 行 stderr）：进程死亡时立即翻转错误，
        // 而不是让 wrapper.start() 永远阻塞在等待 initialize 响应上。
        try {
          const u1 = await listen<{ stderrTail?: string[] }>(`lsp-exit-${res.client_id}`, (e) => {
            exited = true;
            const tail = e.payload?.stderrTail ?? [];
            console.error(
              `[LSP:${languageId}] Metals 进程已退出，最后日志：\n${tail.slice(-15).join('\n') || '(无日志)'}`
            );
          });
          unlisteners.push(u1);
        } catch {
          /* 纯浏览器环境下 listen 会失败，忽略 */
        }
        // 实时转发 Metals stderr 到控制台，便于确认它是在导入 spark 工程还是已崩溃。
        try {
          const u2 = await listen<string>(`lsp-stderr-${res.client_id}`, (e) => {
            const line = typeof e.payload === 'string' ? e.payload : String(e.payload ?? '');
            stderrLines.push(line);
            if (stderrLines.length > 300) stderrLines.shift();
            console.log(`[LSP:${languageId}] server: ${line}`);
          });
          unlisteners.push(u2);
        } catch {
          /* 忽略 */
        }

        // 看门狗：180s 内仍未就绪 → 翻转错误（可能 Metals 正在首次导入 spark 工程，
        // 也可能已挂死），并附上最近日志，避免 UI 永久卡在“启动中”。
        const watchdog = setTimeout(() => {
          if (!exited) {
            const hint = stderrLines.slice(-12).join('\n');
            console.warn(
              `[LSP:${languageId}] 启动超过 180s 仍未就绪。` +
                (hint
                  ? `\n最近日志：\n${hint}`
                  : '\n（无任何 Metals 日志，可能进程未启动或已静默退出）')
            );
            setStatus('error');
          }
        }, 180_000);

        try {
          const { wrapper, clientId } = await startWrapper(languageId, res);
          if (languageId === 'java') {
            javaWrapperRef.current = wrapper;
            javaClientIdRef.current = clientId;
          } else {
            scalaWrapperRef.current = wrapper;
            scalaClientIdRef.current = clientId;
          }
          startedWorkspaceRef.current = workspaceRoot;
          startedJavaHomeRef.current = javaHome;
          setStatus('running');
        } finally {
          clearTimeout(watchdog);
          unlisteners.forEach((u) => u());
        }
      } catch (e) {
        console.warn(`[LSP] ${languageId === 'java' ? 'Java (JDT.LS)' : 'Scala (Metals)'} 启动失败:`, e);
        setStatus('error');
      } finally {
        startingRef.current = false;
      }
    };

    // 已存在的客户端是用不同工作区 / JDK 启动的 → 先停后启，释放旧的 -data 锁
    const needsRestart =
      (javaWrapperRef.current || scalaWrapperRef.current) &&
      (startedWorkspaceRef.current !== workspaceRoot || startedJavaHomeRef.current !== javaHome);
    if (needsRestart) {
      setJavaStatus('disconnected');
      setScalaStatus('disconnected');
      // stopLanguage 内部会按捕获到的旧 clientId 回收 JVM；这里同步清空 wrapper ref，
      // 使下方 launch 能重新拉起（stopLanguage 是异步的，不会立即清 ref）。
      void stopLanguage('java');
      void stopLanguage('scala');
      javaWrapperRef.current = null;
      scalaWrapperRef.current = null;
    }

    if (!javaWrapperRef.current) launch('java');
    // Scala 仅在项目配置了 scalaVersion（即 Scala 工程）时启动，避免纯 Java 工程无谓拉起 Metals
    if (scalaVersion && !scalaWrapperRef.current) launch('scala');
  }, [javaHome, workspaceRoot, scalaVersion, pomTemplate, startWrapper]);

  // 卸载时显式停止两个语言客户端：调用后端 stop_* 回收 JVM（释放 -data 锁），再 dispose 前端 wrapper。
  useEffect(() => {
    return () => {
      startedWorkspaceRef.current = undefined;
      startedJavaHomeRef.current = undefined;
      void stopLanguage('java');
      void stopLanguage('scala');
    };
  }, [stopLanguage]);

  /**
   * 通知 JDT.LS 引用库（jar）变更，使其能索引第三方依赖中的类（如 spark-sql 里的 SaveMode）。
   *
   * 通过 workspace/didChangeConfiguration 传递 java.project.referencedLibraries，
   * 与 VS Code Java 扩展更新依赖的方式一致。
   *
   * 关键：默认（不传 depNames）引用「依赖目录中所有带本地路径的 jar」——
   * 因为编译能找到 SaveMode 是因为 Maven 做了传递依赖解析，而 referencedLibraries
   * 不会做传递解析，只挂显式给到的 jar。若只挂「用户选中的依赖」，则 spark-sql
   * （常被 spark-core 通过传递依赖带出、未必被显式选中）不会进入类路径，导致其中
   * 的类无法跳转。引用全部可用 jar 可最大化导航可用性（与 pom.xml 已含全量目录一致）。
   */
  const updateLspClasspath = useCallback(
    async (depNames?: string[]) => {
      const client = javaWrapperRef.current?.getLanguageClient();
      if (!client) {
        console.warn('[useLspManagement] 更新 LSP classpath 跳过：JDT.LS 尚未就绪');
        return;
      }
      try {
        const records = (await fetchDependencyList())?.data?.records ?? [];
        const autoChooseNames = new Set(
          records.filter((d: any) => d.autoChoose === 1).map((d: any) => d.artifactId)
        );
        let filtered = records;
        if (depNames && depNames.length > 0) {
          filtered = records.filter(
            (d: any) =>
              depNames.includes(d.artifactId) ||
              depNames.includes(d.jarName) ||
              autoChooseNames.has(d.artifactId)
          );
        }
        const jarPaths: string[] = filtered
          .map((d: any) => d.jarPath)
          .filter((p: string): p is string => !!p && p.length > 0);

        // 诊断日志：确认 spark 等可能被引用的 jar 是否进入了 JDT.LS 类路径
        // 注意：此处只针对 JDT.LS（.java 文件）。.scala 文件的类路径来自 Maven/bloop
        // 工程（ensurePomReady 生成的 pom + mvn bloop:install），由 Metals 使用，
        // 不经过这条 referencedLibraries 推送，因此「spark 相关 0 个」对 .scala 文件
        // 是正常的、不影响其跳转——Spark 是否已就绪请看下一个 Rust 端 [LSP] 诊断日志。
        const sparkJars = jarPaths.filter((p) => /spark/i.test(p));
        console.log(
          `[useLspManagement] 推送 JDT.LS classpath：共 ${jarPaths.length} 个 jar（来自 ${filtered.length} 条依赖记录），其中 spark 相关 ${sparkJars.length} 个（仅影响 .java 文件）`,
          sparkJars.slice(0, 10)
        );
        if (sparkJars.length === 0) {
          // 仅为信息提示（非错误）：本地 jarPath 目录里没有 spark 记录。
          // 这只影响 JDT.LS / .java 文件；.scala 文件的 Spark 类路径由 Rust 端
          // coursier(maven-local) + mvn bloop:install 解析，请看 [LSP] 诊断日志。
          console.info(
            '[useLspManagement] 本地 jarPath 目录中无 spark-sql 记录（仅影响 .java / JDT.LS；' +
              '.scala 由 Metals 处理，Spark 是否就绪看 Rust 端 [LSP] 诊断日志）'
          );
        }

        await client.sendNotification('workspace/didChangeConfiguration', {
          settings: {
            java: {
              project: {
                referencedLibraries: jarPaths.length > 0 ? { include: jarPaths } : [],
              },
            },
          },
        });
      } catch (e) {
        console.warn('[useLspManagement] 更新 LSP classpath 失败:', e);
      }
    },
    []
  );

  /**
   * 重新生成 LSP 工作区的 pom / .bloop（并入最新的项目级依赖），并刷新 classpath。
   * 用于「项目依赖变更后即时生效」，避免必须重启应用。
   */
  const regeneratePom = useCallback(async () => {
    if (!javaHome || !workspaceRoot) return;
    try {
      clearPomCache();
      await ensurePomReady(javaHome, mavenHome || '', workspaceRoot, {
        mavenGroupId,
        mavenArtifactId,
        scalaVersion,
        pomTemplate,
        projectId,
        projectCode,
        rootPath,
        sourceDir,
        bloopConfigDirectory,
        bloopDownloadSources,
      });
      await updateLspClasspath();
    } catch (e) {
      console.warn('[useLspManagement] 重新生成 pom / 刷新 classpath 失败:', e);
    }
  }, [
    javaHome,
    workspaceRoot,
    mavenHome,
    mavenGroupId,
    mavenArtifactId,
    scalaVersion,
    pomTemplate,
    projectId,
    projectCode,
    rootPath,
    sourceDir,
    bloopConfigDirectory,
    bloopDownloadSources,
    updateLspClasspath,
  ]);

  /**
   * Java LSP 就绪后，立即推送「完整类路径」（引用依赖目录中所有带本地路径的 jar），
   * 使第三方依赖中的类（如 spark-sql 的 SaveMode）可被跳转/悬停解析。
   * 不依赖「是否配置了项目级依赖」——只要 JDT.LS 就绪就推送全量，避免只挂显式选中项
   * 导致传递依赖里的类无法跳转。项目级依赖变化时也重新推送一次。
   */
  useEffect(() => {
    if (javaStatus !== 'running') return;
    updateLspClasspath().catch(() => {});
  }, [javaStatus, projectDependencies, updateLspClasspath]);

  // 项目级依赖内容变化（如通过「项目依赖」弹窗新增 spark-sql）且 LSP 已启动 →
  // 重新生成 pom（并入新依赖）并刷新 classpath，使改动即时生效。
  const projectDepSigRef = useRef<string>('');
  useEffect(() => {
    const sig = JSON.stringify(projectDependencies || []);
    if (sig === projectDepSigRef.current) return;
    projectDepSigRef.current = sig;
    if (javaWrapperRef.current || scalaWrapperRef.current) {
      void regeneratePom();
    }
  }, [projectDependencies, regeneratePom]);

  return {
    lspStatus: javaStatus,
    scalaLspStatus: scalaStatus,
    updateLspClasspath,
  };
}
