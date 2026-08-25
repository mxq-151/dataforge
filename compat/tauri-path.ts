/**
 * @tauri-apps/api/path 兼容垫片（当前仅使用 homeDir）。
 */
export async function homeDir(): Promise<string> {
  return window.dataforge.homeDir();
}