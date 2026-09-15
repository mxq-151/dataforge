/**
 * 文件系统桥：操作走主进程 Node fs。
 * 二进制数据以 base64 传输（IPC 结构化克隆无法传 Uint8Array 的 TypedArray 原型）。
 */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  children?: DirEntry[];
}

function u8ToBase64(u8: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToU8(b64: string): Uint8Array {
  const binary = atob(b64);
  const u8 = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i);
  return u8;
}

export async function readDir(path: string): Promise<DirEntry[]> {
  return window.dataforge.fs('readDir', { path }) as Promise<DirEntry[]>;
}

/** 目录占用统计结果；`truncated` 为真表示达到 maxEntries 上限，结果为下界 */
export interface DirUsage {
  bytes: number;
  files: number;
  truncated: boolean;
}

/**
 * 递归统计目录占用（软链不跟随）。
 * 用于回收站按容量上限清理；统计失败或目录消失返回全 0，不抛错。
 */
export async function dirUsage(path: string, maxEntries = 20000): Promise<DirUsage> {
  try {
    return (await window.dataforge.fs('du', { path, maxEntries })) as DirUsage;
  } catch {
    return { bytes: 0, files: 0, truncated: false };
  }
}

export async function readFile(path: string): Promise<Uint8Array> {
  const b64 = (await window.dataforge.fs('readFile', { path })) as string;
  return base64ToU8(b64);
}

export async function writeFile(path: string, data: Uint8Array): Promise<void> {
  await window.dataforge.fs('writeFile', { path, data: u8ToBase64(data) });
}

export async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
  await window.dataforge.fs('mkdir', { path, recursive: options?.recursive ?? false });
}

export async function exists(path: string): Promise<boolean> {
  return window.dataforge.fs('exists', { path }) as Promise<boolean>;
}

export async function remove(path: string, options?: { recursive?: boolean }): Promise<void> {
  await window.dataforge.fs('remove', { path, recursive: options?.recursive ?? false });
}

export async function rename(oldPath: string, newPath: string): Promise<void> {
  await window.dataforge.fs('rename', { oldPath, newPath });
}

/** 复制文件或目录（目录递归复制），src 保持不动，内容写至 dest */
export async function copy(src: string, dest: string): Promise<void> {
  await window.dataforge.fs('copy', { src, dest });
}

/**
 * 创建/修复软链 linkPath -> target（幂等）。
 *
 * - target 是数据真身，必须是真实目录；若它当前是软链（如翻转方向前的旧悬空链接），
 *   主进程会先解除再重建为真实目录。
 * - linkPath 已是指向 target 的软链：跳过；指向别处：解除后重建；
 *   已是普通目录/文件：视为数据目录，保留不覆盖。
 */
export async function symlink(linkPath: string, target: string): Promise<void> {
  await window.dataforge.fs('symlink', { linkPath, target });
}
