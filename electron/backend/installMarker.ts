/**
 * 安装标记 —— 「协议同意」与「本次安装」的绑定关系（纯逻辑层，零 Electron 依赖）。
 *
 * ## 为什么标记不能写在应用包里（旧实现 = `app.getAppPath()/.df-install-token`）
 *
 * 打包配置里 `asar: false`，所以打包后 `app.getAppPath()` 就是
 * `DataForge.app/Contents/Resources/app`。首启同意协议时往那里**新增一个文件**，
 * 会让代码签名的密封资源清单（`Contents/_CodeSignature/CodeResources`，含 800+ 条
 * `Resources/app/` 记录）多出一项：
 *
 *     codesign --verify --deep --strict /Applications/DataForge.app
 *     → a sealed resource is missing or invalid
 *       file added: …/Contents/Resources/app/.df-install-token
 *
 * 签名因此永久失效。macOS 只有在「发起钥匙串访问的进程能通过代码签名校验，且满足
 * 钥匙串条目的 ACL」时才静默放行；签名失效后每次调用 Electron `safeStorage`
 * （`df-stores/*.json` 里的 `{"$dfenc":"v1"}` 凭据）都会弹
 * 「请输入"登录"钥匙串密码」，且点「始终允许」也留不住。
 *
 * ⇒ **标记只能落在应用包之外（userData）**。本模块只描述「读写什么、怎么判定」，
 * 真实 fs 由调用方注入，因此可以在 node 环境下穷举测试。
 *
 * ## 「重装即需重新同意」怎么保持
 *
 * 标记搬进 userData 后，重装不会再让它消失，于是改为比对**安装指纹**：
 * 应用包根目录的 `(inode, 创建时间)`。重装 / 拖拽替换安装包 ⇒ 新目录 ⇒ 指纹变化
 * ⇒ 视为「本次安装尚未同意」，强制重新同意；同一次安装内反复启动则复用既有标记。
 * 指纹只在**打包态**参与判定（`bundleRoot` 传 null 即关闭），否则 dev 与打包态共用
 * userData 时会来回被判成重装。
 *
 * 兼容：旧实现写在包内的标记文件只**读**不写（读不会破坏密封清单），读到即迁移到
 * userData；此后老装机不会再被要求重新同意一次。
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

/** 标记文件版本。结构变更时递增，旧版本一律视为不可信 */
export const MARKER_VERSION = 1;

/** 标记文件名（位于 userData，应用包之外） */
export const MARKER_FILE_NAME = 'install-marker.json';

/** 旧实现的标记文件名（位于应用包内 `app.getAppPath()` 下，只读兼容） */
export const LEGACY_MARKER_FILE_NAME = '.df-install-token';

export interface MarkerStat {
  ino: number;
  birthtimeMs: number;
}

/** 注入的 fs 端口：测试用内存实现，生产用 node:fs/promises */
export interface MarkerFsPort {
  readFile(p: string): Promise<string>;
  writeFile(p: string, data: string): Promise<void>;
  mkdir(p: string): Promise<void>;
  stat(p: string): Promise<MarkerStat>;
}

export interface MarkerPaths {
  /** 新标记文件（userData 内） */
  markerFile: string;
  /** 旧标记文件（应用包内），仅用于读取迁移 */
  legacyFile: string;
  /**
   * 应用包根目录，用于计算安装指纹；传 null = 本次运行不参与指纹判定。
   *
   * 开发态必须传 null：dev（`Electron.app`）与打包态（`DataForge.app`）共用同一份
   * userData，若两边都写指纹，交替运行会被反复判成「重装」而每次弹协议页。
   * 写入方不写指纹时，读取侧因指纹不可得而保守放行，两种运行方式互不打扰。
   */
  bundleRoot: string | null;
}

interface MarkerRecord {
  version?: number;
  token?: string;
  fingerprint?: string;
}

/**
 * 安装指纹：`<inode>:<创建时间>`。
 *
 * 取应用包根目录的目录元数据而非内容哈希——重装后目录必是新的 inode，
 * 且不必读取整个包（几百 MB）。拿不到元数据时返回 null，调用方保守放行
 * （见 `readInstallMarker` 的注释），避免因权限/只读之类的问题反复骚扰用户。
 */
export const fingerprintOf = (st: MarkerStat): string =>
  `${Math.trunc(st.ino)}:${Math.trunc(st.birthtimeMs)}`;

/**
 * 解析应用包根目录（用于取指纹）。
 *
 * macOS：`…/Foo.app/Contents/MacOS/Foo` → `…/Foo.app`（上溯两级，须以 `.app` 结尾）。
 * Windows / Linux：没有包概念，取可执行文件所在目录（即安装目录）。
 *
 * 只在打包态用到（dev 传 `bundleRoot: null`，见 `MarkerPaths`）。
 */
export function resolveBundleRoot(execPath: string, platform: NodeJS.Platform = process.platform): string {
  const execDir = path.dirname(execPath);
  if (platform === 'darwin' && path.basename(path.dirname(execDir)) === 'Contents') {
    const bundle = path.resolve(execDir, '..', '..');
    if (path.extname(bundle) === '.app') return bundle;
  }
  return execDir;
}

async function readFingerprint(fs: MarkerFsPort, bundleRoot: string | null): Promise<string | null> {
  if (!bundleRoot) return null;
  try {
    return fingerprintOf(await fs.stat(bundleRoot));
  } catch {
    return null;
  }
}

/**
 * 读标记文件。返回 null 表示「无法识别为本次安装的标记」，字段缺失按未知处理。
 *
 * 容忍两种历史形态：本模块的 JSON、以及被写成裸 token 的纯文本（手工写入或过渡期）。
 */
async function readMarkerFile(fs: MarkerFsPort, file: string): Promise<MarkerRecord | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file);
  } catch {
    return null;
  }
  const text = raw.trim();
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 解析不出 JSON（旧式裸 token、手工写入）→ 按 token 处理（指纹未知 → 读取侧保守放行）
    return { token: text };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const rec = parsed as MarkerRecord;
  const token = typeof rec.token === 'string' ? rec.token : '';
  if (!token) return null;
  // 缺 version = 过渡期写入的形态，容忍；写了别的版本 = 结构不兼容，一律重新同意（fail-close）
  if (typeof rec.version === 'number' && rec.version !== MARKER_VERSION) return null;
  return {
    token,
    fingerprint: typeof rec.fingerprint === 'string' ? rec.fingerprint : undefined,
  };
}

async function writeMarkerFile(
  fs: MarkerFsPort,
  paths: MarkerPaths,
  token: string,
  fingerprint: string | null,
): Promise<void> {
  await fs.mkdir(path.dirname(paths.markerFile));
  const record: MarkerRecord = { version: MARKER_VERSION, token, fingerprint: fingerprint ?? undefined };
  await fs.writeFile(paths.markerFile, JSON.stringify(record));
}

/**
 * 读出「本次安装」的同意标记 token；无标记 / 属于上一次安装 → null（渲染层据此要求重新同意）。
 *
 * 判定顺序：
 *   1. userData 标记存在 → 指纹一致（或双方指纹至少一方不可得）即复用；**指纹明确不一致
 *      即视为重装**（返回 null，等待用户重新同意后被 `writeInstallMarker` 覆盖）。
 *   2. userData 无标记 → 尝试读旧实现的包内标记（只读），读到则迁移到 userData 后返回。
 *   3. 都没有 → null。
 */
export async function readInstallMarker(fs: MarkerFsPort, paths: MarkerPaths): Promise<string | null> {
  const fingerprint = await readFingerprint(fs, paths.bundleRoot);

  const stored = await readMarkerFile(fs, paths.markerFile);
  if (stored?.token) {
    // 保守放行：拿不到当前指纹时（只读卷、stat 失败）不做「重装」判定，
    // 否则会在异常环境下把每次启动都变成协议确认页。
    if (fingerprint && stored.fingerprint && stored.fingerprint !== fingerprint) return null;
    return stored.token;
  }

  const legacy = await readMarkerFile(fs, paths.legacyFile);
  if (!legacy?.token) return null;
  try {
    await writeMarkerFile(fs, paths, legacy.token, fingerprint);
  } catch {
    // 迁移失败不影响本次判定：仍按「已同意」放行，下次启动会再试
  }
  return legacy.token;
}

/**
 * 写入本次安装的同意标记，返回生成的 token；写入失败返回 null（调用方降级）。
 *
 * **只写 `paths.markerFile`（userData）**，绝不触碰应用包——这是签名密封不被破坏的前提，
 * 有单测把这条不变量钉死。
 */
export async function writeInstallMarker(fs: MarkerFsPort, paths: MarkerPaths): Promise<string | null> {
  const token = randomUUID();
  try {
    await writeMarkerFile(fs, paths, token, await readFingerprint(fs, paths.bundleRoot));
    return token;
  } catch {
    return null;
  }
}
