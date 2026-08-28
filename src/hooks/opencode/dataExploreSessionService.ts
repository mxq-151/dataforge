/**
 * dataExploreSessionService — 数据探索「会话 = 独立工作目录」的路径计算与目录管理。
 *
 * 解耦约定：所有 individual/ 相关的路径（baseDir、时间戳子目录、user_{user}.sql、
 * 默认内容）都在模块层（构建/App 组装处）计算完成，再通过 DataExploreSessionService
 * 注入 useOpencodeClient。通用 opencode client hook 不再感知 individual/ 目录结构，
 * 也不直接读写文件系统。
 */
import { initFileSystemAPI } from '../useFileSystem';
import { joinPath } from '../../utils/pathUtils';

/** 一个数据探索会话的工作目录与其中 SQL 文件 */
export interface DeSessionDir {
  /** individual/{timestamp} 完整目录路径 */
  dir: string;
  /** {dir}/user_{username}.sql 文件路径 */
  filePath: string;
}

/** 新建会话目录时写入的默认 SQL 内容 */
export const DE_DEFAULT_SQL = '-- 输入 SQL 查询语句\nSELECT * FROM users LIMIT 10;';

/** 计算数据探索 individual/ 基础目录；缺少宿主/用户名时返回 null */
export function buildDeBaseDir(baseWorkspace?: string, username?: string): string | null {
  if (!baseWorkspace || !username) return null;
  return joinPath(baseWorkspace, username, 'individual');
}

/**
 * 数据探索会话目录服务：模块层算好 baseDir 后构造，交给 useOpencodeClient 使用。
 * 内部自行访问文件系统，对调用方隐藏 individual/ 目录结构细节。
 */
export interface DataExploreSessionService {
  /** individual/ 基础目录（modulier 层计算传入） */
  baseDir: string | null;
  /** 扫描 individual/ 下所有时间戳会话目录（最新在前） */
  listDirs: () => Promise<DeSessionDir[]>;
  /** 新建时间戳会话目录并写入默认 SQL（创建失败返回 null） */
  createDir: () => Promise<DeSessionDir | null>;
  /** 删除会话目录（目录不存在时忽略） */
  removeDir: (dir: string) => Promise<void>;
}

export function createDeSessionService(
  baseDir: string | null,
  username: string,
): DataExploreSessionService {
  const fileName = `user_${username || 'user'}.sql`;
  return {
    baseDir,
    async listDirs() {
      if (!baseDir) return [];
      try {
        const api = await initFileSystemAPI();
        const entries = await api.readDir(baseDir);
        const list: DeSessionDir[] = [];
        for (const e of entries) {
          if (!e.isDirectory || !e.name || !/^\d+$/.test(e.name)) continue;
          const dir = joinPath(baseDir, e.name);
          list.push({ dir, filePath: joinPath(dir, fileName) });
        }
        return list.sort((a, b) => b.dir.localeCompare(a.dir));
      } catch {
        return [];
      }
    },
    async createDir() {
      if (!baseDir) return null;
      const dir = joinPath(baseDir, String(Date.now()));
      const filePath = joinPath(dir, fileName);
      try {
        const api = await initFileSystemAPI();
        await api.createDir(dir);
        if (!(await api.exists(filePath))) {
          await api.writeFile(filePath, new TextEncoder().encode(DE_DEFAULT_SQL));
        }
      } catch (err) {
        console.error('[dataExploreSessionService] 创建会话目录失败:', err);
        return null;
      }
      return { dir, filePath };
    },
    async removeDir(dir) {
      try {
        const api = await initFileSystemAPI();
        await api.removeDir(dir);
      } catch (err) {
        console.warn('[dataExploreSessionService] 删除会话目录失败:', err);
      }
    },
  };
}