import { useState, useCallback } from 'react';
import {
  fetchProjectConfigByFilePath,
  saveProjectConfig as apiSaveProjectConfig,
  updateProjectConfig,
} from '../api/devProject';
import type { ProgramParamsVO, ProgramParamsDTO } from '../api/devProject';

interface DependencyItem {
  id: string;
  name: string;
  version: string;
  source?: string;
}

interface ParamItem {
  id: string;
  key: string;
  value: string;
}

export interface LoadedConfig {
  dependencies: DependencyItem[];
  programParams: ParamItem[];
  taskParams: ParamItem[];
  engine: string;
  warehouse?: string;
}

const mapToLoadedConfig = (vo: ProgramParamsVO): LoadedConfig => ({
  dependencies: (vo.jarDependencyCatalogs || []).map((name, i) => ({
    id: `loaded_dep_${i}`,
    name,
    version: '',
  })),
  programParams: (Object.entries(vo.runParams || {}) as [string, unknown][]).map(([key, val], i) => ({
    id: `loaded_pp_${i}`,
    key,
    value: String(val ?? ''),
  })),
  taskParams: (Object.entries(vo.computeResources || {}) as [string, unknown][]).map(([key, val], i) => ({
    id: `loaded_tp_${i}`,
    key,
    value: String(val ?? ''),
  })),
  engine: vo.engine || '',
});

const useDevProjectConfig = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchByFilePath = useCallback(async (projectId: number, filePath: string): Promise<LoadedConfig | null> => {
    setLoading(true);
    setError(null);
    try {
      const json = await fetchProjectConfigByFilePath(projectId, filePath);
      if (json.code !== 200) throw new Error(json.message || '获取配置失败');
      return mapToLoadedConfig(json.data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '获取配置失败';
      setError(msg);
      console.error('[DevProjectConfig] fetchByFilePath error:', msg);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const saveConfig = useCallback(async (
    projectId: number,
    filePath: string,
    data: {
      dependencies: DependencyItem[];
      programParams: ParamItem[];
      taskParams: ParamItem[];
      engine: string;
    }
  ): Promise<boolean> => {
    setLoading(true);
    setError(null);
    try {
      const runParams: Record<string, unknown> = {};
      data.programParams.forEach(p => { if (p.key) runParams[p.key] = p.value; });

      const computeResources: Record<string, unknown> = {};
      data.taskParams.forEach(p => { if (p.key) computeResources[p.key] = p.value; });

      const body: ProgramParamsDTO = {
        projectId,
        filePath,
        engine: data.engine,
        datasources: [],
        jarDependencyCatalogs: data.dependencies.filter(d => d.name).map(d => d.name),
        runParams,
        computeResources,
        remark: '',
      };

      let exists = false;
      try {
        const json = await fetchProjectConfigByFilePath(projectId, filePath);
        exists = json.code === 200 && json.data != null;
      } catch {
        exists = false;
      }

      const json = exists
        ? await updateProjectConfig(projectId, filePath, body)
        : await apiSaveProjectConfig(projectId, body);

      if (json.code !== 200) throw new Error(json.message || (exists ? '更新失败' : '保存失败'));
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : '保存配置失败';
      setError(msg);
      console.error('[DevProjectConfig] saveConfig error:', msg);
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  return { loading, error, fetchByFilePath, saveConfig };
};

export default useDevProjectConfig;
