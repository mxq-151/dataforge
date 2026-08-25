import { useState, useCallback, useEffect, useRef } from 'react';
import {
  fetchProjectDependencyConfig,
  saveProjectDependencyConfig,
  type ProjectDependencyItem,
  type ProjectDependencyConfig,
} from '../api/projectDependency';

export interface ProjectDependencyState {
  /** 当前加载到的项目级依赖（后端未配置时为 []） */
  dependencies: ProjectDependencyItem[];
  /** 是否正在加载 */
  loading: boolean;
  /** 是否正在保存 */
  saving: boolean;
  /** 最近一次错误信息（后端未部署导致的 404 等视为可降级错误，不计入 error） */
  error: string | null;
  /** 重新从后端拉取项目级依赖 */
  reload: () => Promise<void>;
  /** 保存项目级依赖到后端 */
  save: (deps: ProjectDependencyItem[]) => Promise<boolean>;
}

/**
 * 管理「开发助手模块」中某个项目的项目级依赖配置。
 *
 * 数据来自后端 /params 接口（以项目编码作为 filePath 的项目级配置）：
 *   GET/POST /api/development/project/{id}/params?filePath={projectCode}
 * 若后端尚未部署该接口（返回非 200 / 网络错误），则本 hook 降级为空依赖，
 * 不阻断开发助手模块的其它功能（编译/悬停回退为逐文件依赖）。
 *
 * @param projectId   项目 ID
 * @param projectCode 项目编码（作为后端 filePath 使用，必填，否则保存会报「文件路径不能为空」）
 */
const useProjectDependencyConfig = (
  projectId?: number | string,
  projectCode?: string
): ProjectDependencyState => {
  const [dependencies, setDependencies] = useState<ProjectDependencyItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 避免快速切换项目时旧请求的响应覆盖新项目状态
  const projectIdRef = useRef<string | number | undefined>(projectId);
  projectIdRef.current = projectId;
  const projectCodeRef = useRef<string | undefined>(projectCode);
  projectCodeRef.current = projectCode;

  const reload = useCallback(async () => {
    const pid = projectIdRef.current;
    const code = projectCodeRef.current;
    if (pid == null || pid === '') {
      setDependencies([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const json = await fetchProjectDependencyConfig(Number(pid), code);
      if (json.code !== 200 || !json.data) {
        // 后端返回业务错误（如接口未部署的统一错误码）：降级为空，不抛出异常
        setDependencies([]);
        return;
      }
      const deps = json.data.dependencies || [];
      // 防止旧项目响应覆盖新项目
      if (String(projectIdRef.current) !== String(pid)) return;
      setDependencies(deps);
    } catch {
      // 网络错误 / 404（后端接口尚未部署）：优雅降级，视为无项目级依赖
      if (String(projectIdRef.current) === String(pid)) {
        setDependencies([]);
      }
    } finally {
      if (String(projectIdRef.current) === String(pid)) {
        setLoading(false);
      }
    }
  }, []);

  const save = useCallback(
    async (deps: ProjectDependencyItem[]): Promise<boolean> => {
      const pid = projectIdRef.current;
      const code = projectCodeRef.current;
      if (pid == null || pid === '') return false;
      if (!code) {
        setError('保存失败：缺少项目编码（filePath）');
        return false;
      }
      setSaving(true);
      setError(null);
      try {
        const body: ProjectDependencyConfig = { dependencies: deps };
        const json = await saveProjectDependencyConfig(Number(pid), code, body);
        if (json.code !== 200) {
          throw new Error(json.message || '保存项目级依赖失败');
        }
        if (String(projectIdRef.current) === String(pid)) {
          setDependencies(deps);
        }
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : '保存项目级依赖失败';
        setError(msg);
        return false;
      } finally {
        if (String(projectIdRef.current) === String(pid)) {
          setSaving(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    void reload();
  }, [reload, projectId, projectCode]);

  return { dependencies, loading, saving, error, reload, save };
};

export default useProjectDependencyConfig;
