/**
 * df-stores 读写（主进程侧）。渲染层 Store 桥会把数据写入
 * app.getPath('userData')/df-stores/<file>.json，主进程从同一位置读取，
 * 保证 opencode 服务读取的配置与前端看到的一致。
 *
 * 本文件是凭据落盘的**唯一咽喉**：渲染层、sidecar 配置、编译服务读配置
 * 全部经 `readStoreJSON` / `writeStoreJSON`（走 df:store:read|write 通道），
 * 所以在这里加信封，等于给所有写入路径一次性加密（计划书风险 R6）。
 *
 * 加密实现用 Electron 的 safeStorage：macOS 落 Keychain、Windows 落 DPAPI、
 * Linux 落 libsecret/kwallet 后端，密钥不随文件走 —— 备份、云盘同步、
 * 整目录拷贝带走的都只是密文。
 *
 * 兼容与降级：
 *   - 旧明文文件原样读出，下次写入时自动升级为密文信封（无需迁移脚本）；
 *   - safeStorage 不可用（典型是无 keyring 的 Linux 容器）：沿用明文并告警一次，
 *     不做「假加密」——写进去解不开等于静默丢配置；
 *   - 密钥可用但加密失败：fail-close 置空，绝不明文落盘。
 */
import { app, safeStorage } from 'electron';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  decryptSensitiveValues,
  encryptSensitiveValues,
  stripCredentials,
  type CipherPort,
} from './credentialVault';

export function dfStoresDir(): string {
  return path.join(app.getPath('userData'), 'df-stores');
}

/** 密钥可用性只信「true」：应用未就绪时可能短暂返回 false，缓存 false 会让整轮运行降级 */
let keychainReady = false;

const safeStorageCipher: CipherPort = {
  available: () => {
    if (keychainReady) return true;
    try {
      keychainReady = safeStorage.isEncryptionAvailable();
    } catch {
      keychainReady = false;
    }
    return keychainReady;
  },
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (cipherText) => safeStorage.decryptString(Buffer.from(cipherText, 'base64')),
};

/** 每个告警只打一次，避免每次读写都刷屏 */
const warned = new Set<string>();
function warnOnce(tag: string, message: string): void {
  if (warned.has(tag)) return;
  warned.add(tag);
  console.warn(`[store] ${message}`);
}

/** 读取 store JSON 文件；不存在或非法返回 {}。 */
export async function readStoreJSON<T = unknown>(file: string): Promise<T> {
  const name = path.basename(file);
  const fp = path.join(dfStoresDir(), name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(fp, 'utf8'));
  } catch {
    return {} as T;
  }

  const { data, failures } = decryptSensitiveValues(parsed, safeStorageCipher);
  if (failures.length > 0) {
    warnOnce(
      `decrypt:${name}`,
      `${name} 中有 ${failures.length} 个凭据字段无法解密（${failures.join(', ')}），已按未配置处理。` +
        `常见原因：换了机器、系统钥匙串被重置，或该文件来自其它环境。`,
    );
  }
  return (data ?? {}) as T;
}

/** 原子写入 store JSON 文件（唯一临时名 + rename，避免并发写入互相覆盖 tmp 导致 ENOENT）。 */
export async function writeStoreJSON(file: string, data: unknown): Promise<void> {
  const name = path.basename(file);
  if (!safeStorageCipher.available()) {
    warnOnce(
      'plaintext',
      '当前系统无可用的系统钥匙串（safeStorage 不可用），凭据将以明文落盘。' +
        'Linux 上通常需要安装 libsecret 或 kwallet 并保证会话内有密钥环服务。',
    );
  }

  const { data: payload, failures } = encryptSensitiveValues(data ?? {}, safeStorageCipher);
  if (failures.length > 0) {
    warnOnce(
      `encrypt:${name}`,
      `${name} 中有 ${failures.length} 个凭据字段加密失败（${failures.join(', ')}），已置空以避免明文落盘。`,
    );
  }

  const dir = dfStoresDir();
  await fsp.mkdir(dir, { recursive: true });
  const fp = path.join(dir, name);
  const tmp = `${fp}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(payload ?? {}), 'utf8');
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

/**
 * 导出诊断配置：枚举 df-stores 下全部 JSON，凭据字段替换为 `***` 后返回。
 *
 * 供用户把配置发给支持人员排查问题 —— 没有这一步，「导出配置」就是一次
 * 静默的凭据外发。剥离在**主进程**完成，明文凭据不经过渲染层、不进导出物。
 */
export async function exportSanitizedStores(): Promise<Record<string, unknown>> {
  let names: string[] = [];
  try {
    names = (await fsp.readdir(dfStoresDir())).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const name of names) {
    out[name] = stripCredentials(await readStoreJSON(name));
  }
  return out;
}
