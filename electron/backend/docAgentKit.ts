/**
 * 需求文档 agent 套件（agentkit/req-doc）的运行时物化。
 *
 * opencode 只从 `<cwd>/.opencode/{tool,plugin,agent,command}` 加载工具、插件与
 * agent/command 定义，且工具必须是真实文件（注册表按 glob 扫描后动态 import）。
 * 所以「随 DataForge 分发」= 安装包内放一份只读副本（Resources/docagent），
 * 应用启动时把它物化进用户工作区。
 *
 * 物化策略（全部围绕「不破坏用户工作区」）：
 * 1. 只写 manifest 里列出的文件，路径必须是相对路径且不得越出 .opencode；
 * 2. 绝不删除清单外的文件；清单内的旧文件（套件升级后已移除）只有在
 *    内容仍等于当初写入的 sha256（即用户没改过）时才删除，否则保留并告警；
 * 3. 版本号或任一文件 sha256 不匹配才重写，正常情况下第二次启动零写入；
 * 4. 每个文件 tmp → rename 原子替换，state 最后写；中途失败下次启动自动重试；
 * 5. 失败不阻塞 opencode 启动，由调用方降级并告知用户（套件不可用，其余功能正常）。
 *
 * 本文件不 import electron，便于直接单测（见 docAgentKit.test.ts）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const KIT_NAME = 'req-doc';
const OC_DIR = '.opencode';
/** 相对「物化目标目录」的默认状态目录：工作区为 `<cwd>/.opencode`，用户级为 `~/.dataforge/agents`。 */
const DEFAULT_STATE_DIR = '.docagent';

/**
 * 随包分发的两套 agentkit。
 *
 * 两套共用 `~/.dataforge/agents`，所以状态目录必须分开：否则后物化的那套会用自己的
 * managed 清单覆盖前一套，升级清理时会把另一套的文件当「旧文件」删掉。
 * dirName 与 `resources/<dirName>` / `extraResources.to` 一一对应。
 */
export const AGENT_KITS = [
  { kit: 'req-doc', dirName: 'docagent', stateDir: '.docagent' },
  { kit: 'dw-dev', dirName: 'dwagent', stateDir: '.dwagent' },
] as const;

export type AgentKitId = (typeof AGENT_KITS)[number]['kit'];

export function agentKit(id: AgentKitId): (typeof AGENT_KITS)[number] {
  const found = AGENT_KITS.find((item) => item.kit === id);
  if (!found) throw new Error(`未知 agentkit：${id}`);
  return found;
}


export interface KitManifestFile {
  path: string;
  sha256: string;
  size: number;
}

export interface KitManifest {
  kit: string;
  kitVersion: string;
  builtAt: string;
  files: KitManifestFile[];
}

/** 记录「我们写过哪些文件、写的是什么」，用于升级清理与防篡改比对。 */
export interface KitState {
  kit: string;
  kitVersion: string;
  appVersion: string;
  materializedAt: string;
  files: Record<string, string>;
  /** 用户改写并保留的模板文件（相对路径） */
  overrides?: string[];
}

export interface MaterializeResult {
  ok: boolean;
  reason?: 'source-missing' | 'manifest-invalid' | 'io-error';
  kitVersion?: string;
  /** 本次新写入或版本升级导致的重写 */
  updated: string[];
  /** 用户改过但被套件版本覆盖回来的文件 */
  repaired: string[];
  /** 套件已移除、且内容未被用户改动的旧文件 */
  removed: string[];
  /** 套件已移除、但用户改过因而保留的文件 */
  kept: string[];
  /** 用户改写且被保留的模板文件（agent/command） */
  overrides: string[];
  warnings: string[];
  message?: string;
}

function sha256(buffer: Buffer | string): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hashFile(file: string): string | null {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeAtomic(file: string, content: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** 清单里的相对路径必须留在 .opencode 内，防止被篡改的 manifest 写到工作区外。 */
function safeRelative(rel: string): string | null {
  if (!rel || path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel)) return null;
  const normalized = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized === '.') return null;
  return normalized;
}

export function readKitManifest(sourceDir: string): KitManifest | null {
  const manifest = readJson<KitManifest>(path.join(sourceDir, 'manifest.json'));
  if (!manifest || !Array.isArray(manifest.files) || !manifest.kitVersion) return null;
  return manifest;
}

export function readKitState(targetDir: string, stateDir = DEFAULT_STATE_DIR): KitState | null {
  return readJson<KitState>(path.join(targetDir, stateDir, 'state.json'));
}

export interface MaterializeOptions {
  appVersion?: string;
  /** 本套件独占的状态目录（相对 targetDir），默认 `.docagent`；dw-dev 用 `.dwagent`。 */
  stateDir?: string;
  /**
   * 这些前缀下的文件允许用户自定义：内容被用户改过时保留用户版本（记入 overrides 并告警），
   * 不覆盖。代码类（tool/plugin）永远强制同步——被改过的 guard 等于关掉了写盘闸。
   */
  respectUserEdits?: string[];
}

/**
 * 把套件物化到 `<targetDir>`（targetDir 下就是 agent/ tool/ plugin/ command/）。
 * 工作区作用域传 `<cwd>/.opencode`，用户作用域传 `~/.dataforge/agents`。
 */
export function materializeKitInto(
  sourceDir: string,
  targetDir: string,
  opts: MaterializeOptions = {},
): MaterializeResult {
  const result: MaterializeResult = {
    ok: true,
    updated: [],
    repaired: [],
    removed: [],
    kept: [],
    overrides: [],
    warnings: [],
  };

  if (!fs.existsSync(path.join(sourceDir, 'manifest.json'))) {
    return { ...result, ok: false, reason: 'source-missing', message: `套件副本不存在：${sourceDir}` };
  }
  const manifest = readKitManifest(sourceDir);
  if (!manifest) {
    return { ...result, ok: false, reason: 'manifest-invalid', message: `套件清单无效：${sourceDir}` };
  }
  result.kitVersion = manifest.kitVersion;

  const state = readKitState(targetDir, opts.stateDir ?? DEFAULT_STATE_DIR);
  const nextFiles: Record<string, string> = {};
  const respect = opts.respectUserEdits ?? [];
  // 安装包内的 fs/ 与工作区 .opencode 子树一一对应
  const payloadDir = path.join(sourceDir, 'fs');

  try {
    for (const entry of manifest.files) {
      const rel = safeRelative(entry.path);
      if (!rel) {
        result.warnings.push(`忽略非法路径：${entry.path}`);
        continue;
      }
      const source = path.join(payloadDir, rel);
      if (!fs.existsSync(source)) {
        result.warnings.push(`清单文件缺失：${rel}`);
        continue;
      }
      const content = fs.readFileSync(source);
      const target = path.join(targetDir, rel);
      const currentHash = hashFile(target);
      const previousHash = state?.files?.[rel];

      // 内容已一致就不写，避免每次启动都改 mtime（增量更新时间戳会误导用户）
      if (currentHash === entry.sha256) {
        nextFiles[rel] = entry.sha256;
        continue;
      }
      const editedByUser = Boolean(previousHash && previousHash !== currentHash);
      // 模板类（agent/command）在用户作用域下尊重用户改动：保留 + 记录，不覆盖
      if (editedByUser && respect.some((prefix) => rel.startsWith(prefix))) {
        result.overrides.push(rel);
        nextFiles[rel] = entry.sha256;
        result.warnings.push(`已保留用户改写的 ${rel}（与随包版本不同，升级不会覆盖）`);
        continue;
      }
      // 其余（含 tool/plugin）强制同步：被改过就修复并单独标记
      if (editedByUser) {
        result.repaired.push(rel);
      } else {
        result.updated.push(rel);
      }
      writeAtomic(target, content);
      nextFiles[rel] = entry.sha256;
    }

    // 套件升级后消失的文件：只清理「当初由我们写入且至今未被改动」的那些
    const managed = manifest.files.map((file) => safeRelative(file.path)).filter(Boolean) as string[];
    for (const [rel, recordedHash] of Object.entries(state?.files ?? {})) {
      const safe = safeRelative(rel);
      if (!safe || managed.includes(safe)) continue;
      const target = path.join(targetDir, safe);
      const currentHash = hashFile(target);
      if (currentHash === null) continue;
      if (currentHash === recordedHash) {
        try {
          fs.rmSync(target, { force: true });
          result.removed.push(safe);
        } catch {
          result.warnings.push(`旧文件删除失败：${safe}`);
        }
      } else {
        result.kept.push(safe);
        result.warnings.push(`旧文件已被用户修改，保留：${safe}`);
      }
    }

    writeAtomic(
      path.join(targetDir, opts.stateDir ?? DEFAULT_STATE_DIR, 'state.json'),
      `${JSON.stringify(
        {
          kit: manifest.kit,
          kitVersion: manifest.kitVersion,
          appVersion: opts.appVersion ?? '',
          materializedAt: new Date().toISOString(),
          files: nextFiles,
          overrides: result.overrides,
        } satisfies KitState,
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    return {
      ...result,
      ok: false,
      reason: 'io-error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return result;
}

/** 工作区作用域：物化到 `<cwd>/.opencode`（代码类强制同步）。 */
export function materializeDocAgentKit(
  sourceDir: string,
  cwd: string,
  opts: MaterializeOptions = {},
): MaterializeResult {
  return materializeKitInto(sourceDir, path.join(cwd, OC_DIR), opts);
}

// ── 用户作用域（~/.dataforge/agents） ────────────────────────────────────

/** `~/.dataforge/agents`：多工作区共用的一份。 */
export function resolveUserKitDir(homeDir: string): string {
  return path.join(homeDir, '.dataforge', 'agents');
}

/**
 * 让 opencode 扫到用户级套件目录。
 *
 * opencode 的 `ConfigPaths.directories()` 固定输出：
 *   [ Global.Path.config, <cwd→worktree 的 .opencode>, ~/.opencode, OPENCODE_CONFIG_DIR ]
 * 其中 `~/.opencode` 与项目 `.opencode` 用同一套 loader（agent/command 递归 glob、
 * tool/plugin 顶层 glob，均 `symlink: true` 会跟随软链）。所以只需把 `~/.opencode`
 * 指向 `~/.dataforge/agents`，四类产物就都能被扫到，且不动 `~/.config/opencode`。
 *
 * 注意：dataforge 已经把 OPENCODE_CONFIG_DIR 设成 cwd，不能再用它指向用户目录。
 */
export type KitLinkResult = {
  method: 'root-link' | 'sub-links' | 'already' | 'none';
  linkPath: string;
  conflicts: string[];
  message?: string;
};

export function ensureUserKitLink(homeDir: string, kitDir: string): KitLinkResult {
  const linkPath = path.join(homeDir, '.opencode');
  const conflicts: string[] = [];

  // 已是指向 kitDir 的软链：直接复用
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const current = fs.readlinkSync(linkPath);
      const resolved = path.resolve(homeDir, current);
      if (resolved === path.resolve(kitDir)) return { method: 'already', linkPath, conflicts };
      conflicts.push(`${linkPath} 已指向 ${current}`);
      return { method: 'none', linkPath, conflicts };
    }
    // 真实目录：不接管，改为在内部逐个链接四类子目录（只补不删）
    if (stat.isDirectory()) {
      let linked = 0;
      for (const sub of ['agent', 'tool', 'plugin', 'command']) {
        const target = path.join(kitDir, sub);
        const link = path.join(linkPath, sub);
        try {
          if (!fs.existsSync(link)) {
            fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
            linked += 1;
          } else {
            conflicts.push(`${link} 已存在，跳过`);
          }
        } catch (error) {
          conflicts.push(`${link} 链接失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { method: linked > 0 ? 'sub-links' : 'none', linkPath, conflicts };
    }
  } catch {
    // 不存在：走创建分支
  }

  try {
    fs.symlinkSync(kitDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return { method: 'root-link', linkPath, conflicts };
  } catch (error) {
    return {
      method: 'none',
      linkPath,
      conflicts,
      message: `创建 ${linkPath} 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 用户作用域物化 + 建立链接。
 * agent/command 尊重用户改写；tool/plugin 强制同步（guard 被改等于关掉写盘闸）。
 */
export function materializeUserKit(
  sourceDir: string,
  homeDir: string,
  opts: MaterializeOptions = {},
): { materialized: MaterializeResult; link: KitLinkResult } {
  const kitDir = resolveUserKitDir(homeDir);
  const materialized = materializeKitInto(sourceDir, kitDir, {
    ...opts,
    respectUserEdits: ['agent/', 'command/'],
  });
  if (!materialized.ok) return { materialized, link: { method: 'none', linkPath: '', conflicts: [] } };
  return { materialized, link: ensureUserKitLink(homeDir, kitDir) };
}

/**
 * 迁移：清掉旧版「按工作区物化」留下的副本，否则同名工具会从两处各注册一次。
 * 只删当初由我们写入、且内容未变的文件。返回被删的相对路径。
 */
export function cleanupWorkspaceKit(cwd: string, stateDir = DEFAULT_STATE_DIR): string[] {
  const ocDir = path.join(cwd, OC_DIR);
  const state = readKitState(ocDir, stateDir);
  if (!state) return [];
  const removed: string[] = [];
  for (const [rel, recordedHash] of Object.entries(state.files ?? {})) {
    const safe = safeRelative(rel);
    if (!safe) continue;
    const target = path.join(ocDir, safe);
    if (hashFile(target) !== recordedHash) continue;
    try {
      fs.rmSync(target, { force: true });
      removed.push(safe);
    } catch {
      /* 忽略：下次启动重试 */
    }
  }
  fs.rmSync(path.join(ocDir, stateDir), { recursive: true, force: true });
  return removed;
}

/**
 * 解析安装包内套件副本路径。
 * 与 resolveOpencodeBin / sandboxProfilePath 保持同一套「打包 vs 开发」判定。
 */
export function resolveKitSourceDir(
  packaged: boolean,
  appPath: string,
  resourcesPath: string,
  dirName: string,
): string {
  return packaged ? path.join(resourcesPath, dirName) : path.join(appPath, 'resources', dirName);
}

/** kit1 兼容入口；两套共用时优先用 resolveKitSourceDir。 */
export function resolveDocAgentSourceDir(packaged: boolean, appPath: string, resourcesPath: string): string {
  return resolveKitSourceDir(packaged, appPath, resourcesPath, 'docagent');
}
