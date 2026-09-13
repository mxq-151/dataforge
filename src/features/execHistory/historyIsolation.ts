/**
 * 执行历史隔离工具
 *
 * 客户端持久化存储需按「后端host + 用户 + 项目编码」维度隔离，
 * 避免不同后端 / 用户 / 项目之间执行历史互相串扰。
 */
// 从 session 而非 api 读取 host：本模块属于执行历史域，不应反向依赖 api 层
import { getApiHost } from '../../session';
import { hostToDirName } from '../../utils/pathUtils';

/**
 * 构建按「后端host + 用户 + 项目编码」维度隔离的存储键。
 * @param baseKey   模块历史存储键前缀（如 dataforge_execution_history）
 * @param username  当前登录用户名（来自后端用户信息）
 * @param projectCode 项目编码；平台级模块（如数据探索）无项目维度时传 null
 */
export function buildScopedStorageKey(baseKey: string, username: string, projectCode?: string | null): string {
  const hostDir = hostToDirName(getApiHost() || '');
  const parts = [baseKey, hostDir, username || 'unknown-user'];
  if (projectCode) parts.push(projectCode);
  return parts.join('::');
}