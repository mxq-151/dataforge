/**
 * @tauri-apps/api/app 兼容垫片。
 * 原代码动态 import 该模块仅用于「是否为桌面宿主」探测，导出即可。
 */
export async function getName(): Promise<string> {
  return 'dataforge';
}

export async function getVersion(): Promise<string> {
  return '0.1.0';
}