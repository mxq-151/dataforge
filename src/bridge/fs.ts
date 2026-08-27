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
