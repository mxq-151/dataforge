/**
 * 平台精确识别：明确区分「裸 Linux」与「WSL」(Windows Subsystem for Linux)。
 *
 * process.platform 只反映主进程运行在哪个 OS（win32 / darwin / linux），无法区分
 * 同样是 'linux' 时究竟是原生 Linux 发行版还是 WSL。WSL 内核会向外暴露特定标记：
 *   - /proc/version  形如 "... microsoft-standard-WSL2 ..."（含 WSL 字样）
 *   - os.release()   形如 "5.15.xx.x-microsoft-standard-WSL2"
 * 通过探测这两处即可判断。
 */
import * as os from 'node:os';
import * as fs from 'node:fs';

/** 判断当前是否为 WSL 环境（仅当 process.platform === 'linux' 时有意义）。 */
export function detectWsl(): boolean {
  if (process.platform !== 'linux') return false;

  // /proc/version 是 WSL 最可靠的标记来源
  try {
    const procVersion = fs.readFileSync('/proc/version', 'utf8');
    if (/microsoft|wsl2?/i.test(procVersion)) return true;
  } catch {
    /* 读取失败则尝试 os.release() */
  }

  // os.release() 在 WSL2 下返回形如 x.y.z-microsoft-standard-WSL2
  try {
    if (/microsoft.*wsl|wsl.*microsoft/i.test(os.release())) return true;
  } catch {
    /* 忽略 */
  }

  return false;
}

export type RuntimeId = 'windows' | 'macos' | 'wsl' | 'linux';

/** 返回精确的运行环境标识：windows / macos / wsl / linux（裸 Linux）。 */
export function runtimeId(): RuntimeId {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    case 'linux':
      return detectWsl() ? 'wsl' : 'linux';
    default:
      return process.platform as RuntimeId;
  }
}