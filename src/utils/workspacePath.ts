import { homeDir } from '../bridge/path';
import { isWindows as checkIsWindows } from './pathUtils';

/**
 * 平台默认工作区（$HOME/.dataforge）解析。
 *
 * 原定义在 hooks/useFileSystem.ts，但它是不依赖 React 的纯函数（仅带进程内缓存），
 * 放在 hooks 层会让 services/contexts 为取一个路径而反向依赖 hooks 层。
 * 迁到 utils 供各层共用，useFileSystem 仍 re-export 以保持既有引用可用。
 */

const getPlatformFallbackWorkspace = (): string => {
  const isWin = checkIsWindows();
  const isMac = navigator.platform?.includes('Mac') || navigator.userAgent.includes('Mac');

  if (isWin) {
    return 'C:\\Users\\.dataforge';
  }

  if (isMac) {
    return '/Users/.dataforge';
  }

  return '/home/.dataforge';
};

/** 无法解析用户主目录时的平台兜底工作区路径 */
export const DEFAULT_WORKSPACE = getPlatformFallbackWorkspace();

let cachedWorkspace: string | null = null;

export const getPlatformDefaultWorkspace = async (): Promise<string> => {
  if (cachedWorkspace) {
    return cachedWorkspace;
  }

  try {
    const home = await homeDir();
    const separator = home.includes('\\') ? '\\' : '/';
    cachedWorkspace = `${home}${separator}.dataforge`;
    return cachedWorkspace;
  } catch (error) {
    console.warn('[FS] 无法获取用户主目录，使用回退方案:', error);
    cachedWorkspace = DEFAULT_WORKSPACE;
    return cachedWorkspace;
  }
};
