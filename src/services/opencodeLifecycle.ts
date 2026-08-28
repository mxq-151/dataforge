import { invoke } from '../bridge/ipc';
import { Store } from '../bridge/store';
import { getPlatformDefaultWorkspace } from '../utils/workspacePath';
import { joinPath, hostToDirName } from '../utils/pathUtils';

/**
 * OpenCode sidecar 生命周期与工作区配置。
 *
 * 原先这段逻辑内联在 AuthContext 的 login()/logout() 里，使「认证」这个关注点
 * 直接持有了 sidecar 进程管理与工作区路径计算。抽出来后，AuthContext 只需表达
 * 「登录成功后启动 / 登出时停止」，不再关心 cwd 怎么算、config 怎么落盘。
 */

/** opencode 配置持久化文件（对应主进程 userData/df-stores/opencode-config.json） */
export const OPENCODE_CONFIG_STORE = 'opencode-config.json';

/**
 * 计算并写入基础工作目录（$HOME/.dataforge/{后端host}/），
 * 使 opencode 服务启动时 cwd 使用新规则（无需用户配置）。
 *
 * 必须在启动 opencode 之前 await 完成：start_opencode_after_login 依赖这里的
 * backendHost 才能算出正确的 DATAFORGE_API_HOST。
 */
export async function syncWorkspaceConfig(backendHost: string): Promise<void> {
  try {
    const home = await getPlatformDefaultWorkspace();
    const base = joinPath(home, hostToDirName(backendHost || ''));
    const store = await Store.load(OPENCODE_CONFIG_STORE);
    const cfg = (await store.get<Record<string, unknown>>('config')) || {};
    await store.set('config', {
      ...cfg,
      cwd: base,
      backendHost: backendHost || cfg.backendHost,
    });
    await store.save();
  } catch {
    // 写入失败不阻塞登录流程
  }
}

/** 登录成功后启动 opencode sidecar；失败仅告警，不阻断调用方流程 */
export async function startOpencodeAfterLogin(backendHost: string): Promise<void> {
  await syncWorkspaceConfig(backendHost);
  try {
    await invoke<string>('start_opencode_after_login');
  } catch (err) {
    // 启动失败不阻塞登录流程，仅打印警告
    console.warn('[opencode] 登录后启动失败:', err);
  }
}

/** 登出时停止 opencode sidecar，清理子进程环境中的凭据 */
export function stopOpencode(): void {
  invoke('stop_opencode').catch(() => {
    /* sidecar 可能未运行，忽略 */
  });
}
