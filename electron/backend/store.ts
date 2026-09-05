/**
 * df-stores 读写（主进程侧）。渲染层 Store 桥会把数据写入
 * app.getPath('userData')/df-stores/<file>.json，主进程从同一位置读取，
 * 保证 opencode 服务读取的配置与前端看到的一致。
 */
import { app } from 'electron';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export function dfStoresDir(): string {
  return path.join(app.getPath('userData'), 'df-stores');
}

/** 读取 store JSON 文件；不存在或非法返回 {}。 */
export async function readStoreJSON<T = unknown>(file: string): Promise<T> {
  const fp = path.join(dfStoresDir(), path.basename(file));
  try {
    return JSON.parse(await fsp.readFile(fp, 'utf8')) as T;
  } catch {
    return {} as T;
  }
}

/** 原子写入 store JSON 文件（唯一临时名 + rename，避免并发写入互相覆盖 tmp 导致 ENOENT）。 */
export async function writeStoreJSON(file: string, data: unknown): Promise<void> {
  const dir = dfStoresDir();
  await fsp.mkdir(dir, { recursive: true });
  const fp = path.join(dir, path.basename(file));
  const tmp = `${fp}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data ?? {}), 'utf8');
  // Windows 下目标文件可能被杀软/其他进程短暂占用导致 rename 报 EPERM，重试几次再放弃
  for (let i = 0; i < 5; i++) {
    try {
      await fsp.rename(tmp, fp);
      return;
    } catch (err) {
      if (i === 4) throw err;
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
}