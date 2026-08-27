/**
 * 路径桥。
 */
export async function homeDir(): Promise<string> {
  return window.dataforge.homeDir();
}

export async function tempDir(): Promise<string> {
  return window.dataforge.tempDir();
}
