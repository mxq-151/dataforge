/* 上报内容与后端 dataforge-stat 的 /api/report 契约一致：
 *   { client_id, os_version, dataforge_version, client_time }
 * - client_id      在用户「同意安装协议」时生成，持久化到 userData（重装不清除），
 *                   重装后本地已有则直接复用，标识唯一安装；
 * - os_version      主进程 process.getSystemVersion()；
 * - dataforge_version  主进程 app.getVersion()（来自 package.json version）;
 * - client_time     客户端本地时间（ISO）。
 *
 * 上报属于非关键路径：任何失败（网络不通、桥缺失、写入失败）都静默降级，不阻塞应用启动。
 */

import { fetch } from '../bridge/http';
import { Store } from '../bridge/store';

/** 上报服务地址（hosts 中 dataforge.org.cn → 本机后端，默认端口 8080） */
const REPORT_URL = 'http://dataforge.org.cn:8080/api/report';

/** 用于持久化 client_id 的 Store 文件名（userData，重装不清除） */
const IDENTITY_STORE = 'report-identity.json';

/** 定时上报间隔：每小时 */
const REPORT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 读取本地唯一 client_id：本地（userData）已有则复用，否则生成新值并持久化。
 * 主要在「同意安装协议」时调用生成；上报时也调用以保证任何入口都兜底可用。
 */
export async function ensureClientId(): Promise<string> {
  try {
    const store = await Store.load(IDENTITY_STORE);
    let id = await store.get<string>('clientId');
    if (!id) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      await store.set('clientId', id);
    }
    return id;
  } catch {
    return '';
  }
}

/** 应用启动上报（fire-and-forget，调用方无需 await） */
export async function reportLaunch(): Promise<void> {
  try {
    if (!window.dataforge) return; // 非 Electron 环境（如纯浏览器调试）跳过
    const [clientId, meta] = await Promise.all([
      ensureClientId(),
      window.dataforge
        .systemInfo()
        .catch(() => ({ os_version: '', dataforge_version: '' })),
    ]);
    await fetch(REPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        os_version: meta.os_version || '',
        dataforge_version: meta.dataforge_version || '',
        client_time: new Date().toISOString(),
      }),
    });
  } catch {
    // 上报失败静默降级，不影响应用启动
  }
}

export default reportLaunch;

/**
 * 启动定时上报：立即上报一次，随后每小时上报一次。
 * fire-and-forget，失败静默；窗口关闭即随渲染层销毁，无需手动清理。
 */
export function startPeriodicReporting(): void {
  void reportLaunch();
  setInterval(() => {
    void reportLaunch();
  }, REPORT_INTERVAL_MS);
}