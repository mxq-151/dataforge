/**
 * 导出诊断配置（凭据已剥离）。
 *
 * 用户把配置发给支持人员排查问题时，最自然的做法就是「把配置文件发过来」——
 * 而 df-stores 里躺着大模型 API Key、后端令牌、调度令牌。若导出的是原始文件，
 * 这一步就是一次静默的凭据外发（计划书风险 R6 的待补项）。
 *
 * 因此导出的入口固定在主进程：渲染层拿到的就已经是剥离后的快照
 * （见 electron/backend/store.ts::exportSanitizedStores），明文凭据既不经过
 * 渲染层内存，也不会出现在导出物里。
 */

export interface ConfigExportSummary {
  /** 落盘的下载文件名 */
  filename: string;
  /** 导出包含的 Store 文件数 */
  storeCount: number;
}

/** 非 Electron 环境（纯浏览器调试）没有该桥，调用方据此隐藏入口 */
export const canExportConfig = (): boolean =>
  typeof window !== 'undefined' && typeof window.dataforge?.storeExport === 'function';

const pad = (n: number): string => String(n).padStart(2, '0');

/** 文件名带时间戳，便于同一用户多次导出的文件不互相覆盖 */
export const buildConfigExportFilename = (d: Date = new Date()): string =>
  `dataforge-diagnostic-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
  `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;

/**
 * 组装并下载诊断配置。
 * 失败时抛错，由调用方决定提示文案——静默失败会让用户以为「已经导出了」。
 */
export async function exportDiagnosticConfig(): Promise<ConfigExportSummary> {
  const bridge = window.dataforge;
  if (!bridge?.storeExport) {
    throw new Error('当前环境不支持导出配置');
  }

  const [stores, meta] = await Promise.all([
    bridge.storeExport(),
    bridge.systemInfo().catch(() => ({ os_version: '', dataforge_version: '' })),
  ]);

  const filename = buildConfigExportFilename();
  const payload = {
    exportedAt: new Date().toISOString(),
    dataforge_version: meta.dataforge_version || '',
    os_version: meta.os_version || '',
    note: '本文件由「设置 → 诊断配置导出」生成。凭据类字段（API Key、令牌、口令）已在导出前替换为 ***，可安全发送给他人排查问题。',
    stores: stores ?? {},
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }

  return { filename, storeCount: Object.keys(payload.stores).length };
}
