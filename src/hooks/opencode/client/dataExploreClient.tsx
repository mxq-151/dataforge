/**
 * client/dataExploreClient.tsx — 数据探索智能体的 opencode client
 *
 * ── 工作空间模型：会话 = 独立工作目录 ──
 * 每个会话对应一个 individual/{timestamp} 独立目录，目录里的 user_{user}.sql 就是该
 * 会话的工作文件。会话与其工作目录的映射持久化在 localStorage，理由是它被 useRef
 * 当作初始值**同步**读取 —— 改成异步加载会让首帧恢复会话目录时拿到空映射，导致已建立
 * 的「会话 ↔ 目录」关联丢失；且它是不含凭据的小体积元数据，迁移到磁盘存储没有安全或
 * 容量收益。
 *
 * 由这套模型派生出四件开发助手不需要做的事，全部落在这个文件的策略钩子里：
 *   1. 首发消息 / 点「新建会话」时：先建 individual/{ts} 目录并切过去，否则 session.create
 *      会把会话建在 individual/ 基础目录下；
 *   2. 续聊已有会话时：把连接切回该会话的目录（切目录会清空会话态，随后要恢复 sessionId）；
 *   3. 会话创建成功后：登记 会话ID → 目录 映射（删除会话时才能连带清理目录）；
 *   4. 删除会话时：撤映射 → 删目录 → 删服务端会话，并同步关闭对应编辑器标签页。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { buildScopedStorageKey } from '../../../features/execHistory';
import { joinPath } from '../../../utils/pathUtils';
import { removeSessionHistoryEntry } from '../sessionHistoryStore';
import type { DataExploreSessionService } from '../dataExploreSessionService';
import { OpencodeClientContext } from './context';
import { useOpencodeClientCore } from './useOpencodeClientCore';
import { useOpencodeClientActions, useOpencodeClientValue } from './useOpencodeClientActions';
import type { WorkspaceContext, WorkspaceStrategy } from './workspace';
import {
  DATA_EXPLORE_MODULE_ID,
  DEFAULT_TASK_TYPE_BY_MODULE,
  type OpencodeClientProviderProps,
  type TaskRecord,
} from './types';

/** 数据探索「会话 ↔ 工作目录」映射的存储 key 前缀（按 host+user 隔离） */
const DE_DIR_MAP_KEY = 'dataforge_dataexplore_sessiondirs';

/** 读取「会话ID → 独立工作目录」映射（按 host+user 隔离键） */
function loadDeDirMap(key: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** 持久化「会话ID → 独立工作目录」映射 */
function saveDeDirMap(key: string, map: Record<string, string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    // localStorage 不可用时静默忽略
  }
}

export interface UseDataExploreWorkspaceOptions {
  /** 公共运行时上下文（策略只在异步回调里读它的最新值） */
  ctxRef: MutableRefObject<WorkspaceContext>;
  /** 会话目录服务（各模块算好 individual/ 路径后注入） */
  service?: DataExploreSessionService | null;
  username?: string;
  /**
   * 连接状态：策略里唯一的**响应式**输入。
   * 其余输入都从 ctxRef 读（异步回调里取值），因此不参与渲染依赖。
   */
  connected: boolean;
  /** 任务列表（用于派生「任务 → SQL 文件」下拉数据） */
  tasks: TaskRecord[];
}

/**
 * 数据探索的工作空间策略：会话 = 独立时间戳工作目录（会话即编辑器标签页）。
 */
export function useDataExploreWorkspace(options: UseDataExploreWorkspaceOptions): WorkspaceStrategy {
  const { ctxRef, service, username, connected, tasks } = options;

  const [dirs, setDirs] = useState<Array<{ dir: string; filePath: string }>>([]);
  const [dirsVersion, setDirsVersion] = useState(0);
  const bumpVersion = useCallback(() => setDirsVersion(v => v + 1), []);

  // 会话ID → 工作目录 映射（持久化，按 host+user 隔离）
  const dirMapKeyRef = useRef<string>(buildScopedStorageKey(DE_DIR_MAP_KEY, username || ''));
  const dirMapRef = useRef<Record<string, string>>(loadDeDirMap(dirMapKeyRef.current));
  // 待关联目录：新建会话后首个形成的 opencode 会话归属该目录
  const pendingDirRef = useRef<string | null>(null);
  // 首次扫描守卫（避免 effect 重复触发）
  const scannedRef = useRef(false);

  /**
   * 首次进入数据探索：不自动打开任何会话文件、不自动创建会话目录、
   * 不自动切换 AI 工作目录，仅显示空白编辑器（可输入 SQL）。
   * 会话的打开/新建及工作目录/会话关联由用户在任务下拉选择或新建会话时兜底处理。
   */
  useEffect(() => {
    if (!connected || scannedRef.current) return;
    scannedRef.current = true;
  }, [connected]);

  /** 把一个新建的会话目录登记进「已打开」列表（最新在前） */
  const registerDir = useCallback((created: { dir: string; filePath: string }) => {
    setDirs(prev => {
      const rest = (prev || []).filter(d => d.dir !== created.dir);
      return [created, ...rest];
    });
    bumpVersion();
  }, [bumpVersion]);

  /**
   * 首发消息且尚无会话时调用：确保 opencode 工作目录已实际落到会话时间戳目录
   * （individual/{ts}），而不能停留在 individual/ 基础目录，否则 session.create
   * 会把新会话建在基础目录下（session.directory = .../individual）。
   *
   * pendingDirRef 可能由「新建会话/首次兜底」提前设置，但其目录切换可能仍在进行中，
   * 因此不把它当作"目录已就绪"信号，而是显式确保 currentDirectory 已指向目标目录。
   */
  const prepareNewSessionDirectory = useCallback(async () => {
    const ctx = ctxRef.current;
    if (!service) return;
    try {
      let targetDir = pendingDirRef.current ?? null;
      if (!targetDir) {
        const created = await service.createDir();
        if (created) {
          targetDir = created.dir;
          pendingDirRef.current = created.dir;
          registerDir(created);
        }
      }
      if (targetDir && targetDir !== ctx.currentDirectory) {
        await ctx.setWorkingDirectory(targetDir);
      }
    } catch (err) {
      console.error('[agent-client] 通过对话新建数据探索目录失败:', err);
    }
  }, [service, ctxRef, registerDir]);

  /** 续聊已有会话：把连接切回该会话的独立工作目录 */
  const ensureSessionDirectory = useCallback(async (sessionId: string) => {
    const ctx = ctxRef.current;
    if (!service) return;
    const mappedDir = dirMapRef.current[sessionId];
    if (mappedDir && mappedDir !== ctx.currentDirectory) {
      await ctx.setWorkingDirectory(mappedDir);
      // setWorkingDirectory 内部会清空当前会话（含子代理标记），这里恢复为当前会话。
      // 数据探索会话均为根会话（无 parentID），因此 parentID 恢复为 null。
      ctx.restoreSession(sessionId);
    }
  }, [service, ctxRef]);

  /** 新建会话 = 新建独立时间戳工作目录并切过去（会话=标签页） */
  const onNewSession = useCallback(async () => {
    const ctx = ctxRef.current;
    if (!service) return;
    try {
      const created = await service.createDir();
      if (!created) return;
      pendingDirRef.current = created.dir;
      await ctx.setWorkingDirectory(created.dir);
      registerDir(created);
    } catch (err) {
      console.error('[agent-client] 新建数据探索会话失败:', err);
    }
  }, [service, ctxRef, registerDir]);

  /** 会话创建成功 → 与当前新建的会话目录关联（用于删除会话时清理目录） */
  const onSessionCreated = useCallback((sessionId: string) => {
    if (!pendingDirRef.current) return;
    dirMapRef.current[sessionId] = pendingDirRef.current;
    pendingDirRef.current = null;
    saveDeDirMap(dirMapKeyRef.current, dirMapRef.current);
  }, []);

  /** 会话被删除 → 撤映射、关标签页、异步清理会话目录（不阻塞 UI） */
  const onSessionDeleted = useCallback((sessionId: string) => {
    const dir = dirMapRef.current[sessionId];
    if (!dir) return;
    delete dirMapRef.current[sessionId];
    saveDeDirMap(dirMapKeyRef.current, dirMapRef.current);
    setDirs(prev => (prev || []).filter(d => d.dir !== dir));
    bumpVersion();
    if (service) {
      void service.removeDir(dir).catch(err => {
        console.warn('[agent-client] 删除数据探索会话目录失败:', err);
      });
    }
  }, [service, bumpVersion]);

  /**
   * 删除数据探索会话（由编辑器标签页按「目录」触发，而非按 sessionId）。
   *
   * 顺序：**本地状态先落地，再动服务端/文件系统**。任务列表来自本地历史，
   * 删除必须立即生效；若把 removeSessionHistoryEntry 放在 await 之后，
   * 一旦 removeDir / session.delete 挂起或抛错，这一行就会永远留在下拉框里。
   */
  const deleteSessionByDir = useCallback(async (dir: string) => {
    const ctx = ctxRef.current;
    let sid: string | null = null;
    for (const [k, v] of Object.entries(dirMapRef.current)) {
      if (v === dir) { sid = k; break; }
    }
    if (sid) {
      delete dirMapRef.current[sid];
      saveDeDirMap(dirMapKeyRef.current, dirMapRef.current);
      // 本地删除 + 立墓碑（后续服务端播种不得复活）
      ctx.setTasks(removeSessionHistoryEntry(ctx.sessionHistoryKey, sid));
    }
    if (sid && sid === ctx.currentSessionId) ctx.clearCurrentSession();
    setDirs(prev => (prev || []).filter(d => d.dir !== dir));
    bumpVersion();
    if (service) {
      void service.removeDir(dir).catch(err => {
        console.warn('[agent-client] 删除数据探索会话目录失败:', err);
      });
    }
    if (sid) ctx.deleteSessionRemote(sid);
  }, [service, ctxRef, bumpVersion]);

  /** 打开/关闭指定目录的文件标签（仅操作编辑器标签，不动 AI 工作目录） */
  const setDirOpen = useCallback((dir: string, open: boolean) => {
    if (!dir) return;
    setDirs(prev => {
      const list = prev || [];
      const exists = list.some(d => d.dir === dir);
      if (open && !exists) {
        const filePath = joinPath(dir, `user_${username || 'user'}.sql`);
        return [{ dir, filePath }, ...list];
      }
      if (!open && exists) {
        return list.filter(d => d.dir !== dir);
      }
      return prev;
    });
    bumpVersion();
  }, [username, bumpVersion]);

  /** 任务下拉勾选 → 打开/关闭该会话文件标签（与 AI 对话无关） */
  const toggleSession = useCallback((sessionId: string) => {
    const dir = dirMapRef.current[sessionId];
    if (!dir) return;
    const currentlyOpen = (dirs || []).some(d => d.dir === dir);
    setDirOpen(dir, !currentlyOpen);
  }, [dirs, setDirOpen]);

  /** 编辑器关标签 → 关闭该目录文件（不删会话/目录） */
  const closeFile = useCallback((dir: string) => {
    setDirOpen(dir, false);
  }, [setDirOpen]);

  /** 任务（用户对话）→ 工作目录 SQL 文件（供下拉勾选展示，仅已关联会话） */
  const taskFiles = useMemo(() => {
    const list: Array<{ sessionId: string; dir: string; filePath: string; title: string }> = [];
    for (const t of tasks) {
      const dir = dirMapRef.current[t.sessionId];
      if (!dir) continue;
      list.push({
        sessionId: t.sessionId,
        dir,
        filePath: joinPath(dir, `user_${username || 'user'}.sql`),
        title: t.title || '新对话',
      });
    }
    return list;
    // dirsVersion 参与依赖：映射表是 ref（变更不触发渲染），它的增删都会 bump 版本号
  }, [tasks, username, dirsVersion]);

  const extras = useMemo(() => ({
    dataExploreDirs: dirs,
    dataExploreDirsVersion: dirsVersion,
    dataExploreDeleteSession: deleteSessionByDir,
    dataExploreTaskFiles: taskFiles,
    dataExploreToggleSession: toggleSession,
    dataExploreCloseFile: closeFile,
  }), [dirs, dirsVersion, deleteSessionByDir, taskFiles, toggleSession, closeFile]);

  return useMemo(() => ({
    moduleId: DATA_EXPLORE_MODULE_ID,
    prepareNewSessionDirectory,
    ensureSessionDirectory,
    onNewSession,
    onSessionCreated,
    onSessionDeleted,
    extras,
  }), [
    prepareNewSessionDirectory, ensureSessionDirectory, onNewSession,
    onSessionCreated, onSessionDeleted, extras,
  ]);
}

export function DataExploreClientProvider({
  children,
  config,
  username,
  moduleId,
  roleType,
  projectId,
  directory,
  dataExploreService,
}: OpencodeClientProviderProps) {
  const core = useOpencodeClientCore({
    config,
    username,
    moduleId,
    roleType,
    projectId,
    directory,
    defaultTaskType: DEFAULT_TASK_TYPE_BY_MODULE[DATA_EXPLORE_MODULE_ID],
  });

  const workspace = useDataExploreWorkspace({
    ctxRef: core.ctxRef,
    service: dataExploreService,
    username,
    connected: core.conn.connected,
    tasks: core.history.tasks,
  });

  const actions = useOpencodeClientActions(core, workspace);
  const value = useOpencodeClientValue(core, workspace, actions);

  return (
    <OpencodeClientContext.Provider value={value}>
      {children}
    </OpencodeClientContext.Provider>
  );
}
