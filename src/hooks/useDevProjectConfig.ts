import { useState, useCallback } from 'react';
import {
  fetchProjectConfigByFilePath,
  saveProjectConfig as apiSaveProjectConfig,
} from '../api/devProject';
import type { ProgramParamsVO, ProgramParamsDTO } from '../api/devProject';

interface DependencyItem {
  id: string;
  name: string;
  version: string;
  source?: string;
  /** 自定义 jar 相对 basePath 的路径（含文件名），保存到 /params 时透传 jarPath */
  jarPath?: string;
  groupId?: string;
  scope?: string;
  autoChoose?: number | null;
  /** 依赖 jar 的 basePath（后端回填，保存时不传）；--jars 路径由 basePath + jarPath 组成 */
  basePath?: string;
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

// 后端 jarDependencyCatalogs 为对象数组（DevJarDependency），取 artifactId || jarName 作为依赖名；
// vo 可能为 null（后端无记录时 Result.success() 不带 data），按空配置处理
const mapToLoadedConfig = (vo: ProgramParamsVO | null | undefined): LoadedConfig => ({
  dependencies: (vo?.jarDependencyCatalogs || []).map((dep, i) => ({
    id: `loaded_dep_${i}`,
    name: dep.artifactId || dep.jarName || '',
    version: dep.version || '',
    source: dep.source,
    jarPath: dep.jarPath,
    groupId: dep.groupId,
    scope: dep.scope,
    autoChoose: dep.autoChoose,
    basePath: dep.basePath,
  })),
  programParams: (Object.entries(vo?.runParams || {}) as [string, unknown][]).map(([key, val], i) => ({
    id: `loaded_pp_${i}`,
    key,
    value: String(val ?? ''),
  })),
  taskParams: (Object.entries(vo?.computeResources || {}) as [string, unknown][]).map(([key, val], i) => ({
    id: `loaded_tp_${i}`,
    key,
    value: String(val ?? ''),
  })),
  engine: vo?.engine || '',
});

// 引擎 → 程序类型映射（与 ConfigParamsModal 内 ENGINE_TO_PROGRAM_TYPE 保持一致，
// 用于回填 DevJarDependency.programType，后端 DTO 标注 @NotBlank）
const ENGINE_TO_PROGRAM_TYPE: Record<string, string> = {
  spark: 'SPARK',
  flink: 'FLINK',
  flink_stream: 'FLINK',
  kyuubi: 'SPARK',
  hive: 'HIVE',
  java: 'JAVA',
  scala: 'SCALA',
  python: 'PYTHON',
  mr: 'MAPREDUCE',
};

// 统一路径分隔符：Windows 下路径用反斜杠（\），macOS/Linux 用正斜杠（/）。
// 后端按 (project_id, file_path) 联合键存储参数，为避免同一文件在不同平台被识别为
// 不同路径导致项目/程序参数保存与读取不一致，入口处一律归一为正斜杠相对路径。
const toPosixPath = (p: string): string => (p ?? '').trim().replace(/\\/g, '/');

const useDevProjectConfig = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchByFilePath = useCallback(async (projectId: number, filePath: string): Promise<LoadedConfig | null> => {
    setLoading(true);
    setError(null);
    try {
      const json = await fetchProjectConfigByFilePath(projectId, toPosixPath(filePath));
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

      // 后端 jarDependencyCatalogs 现为对象数组（DevJarDependency），
      // jarName/artifactId 均回填依赖名，programType 由引擎推断（engine 为空时省略）
      const programType = ENGINE_TO_PROGRAM_TYPE[data.engine.trim().toLowerCase()];
      const body: ProgramParamsDTO = {
        projectId,
        filePath: toPosixPath(filePath),
        engine: data.engine,
        datasources: [],
        jarDependencyCatalogs: data.dependencies
          .filter(d => d.name)
          .map(d => ({
            jarName: d.name,
            artifactId: d.name,
            version: d.version,
            source: d.source,
            jarPath: d.jarPath,
            groupId: d.groupId,
            scope: d.scope,
            autoChoose: d.autoChoose,
            ...(programType ? { programType } : {}),
          })),
        runParams,
        computeResources,
        remark: '',
      };

      // 后端仅暴露 PUT upsert（按 (project_id, file_path) 原子保存），不再需要先查后写区分新增/更新
      const json = await apiSaveProjectConfig(projectId, body);

      if (json.code !== 200) throw new Error(json.message || '保存失败');
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
