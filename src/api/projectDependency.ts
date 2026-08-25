import { request } from './index';
import type { ApiResponse } from './types';
import type { ProgramParamsVO } from './devProject';

/**
 * 项目级依赖配置（开发助手模块）。
 *
 * 复用「逐文件配置」的 /params 接口。后端要求 filePath 非空，
 * 项目级配置以「项目编码」作为 filePath 来标识（区别于逐文件具体路径）。
 *   GET  /api/development/project/{projectId}/params?filePath={projectCode}
 *   POST /api/development/project/{projectId}/params  (body.filePath = projectCode)
 * 后端返回的是 jarDependencyCatalogs（依赖坐标字符串列表），
 * 这里在边界处映射成前端使用的带 id 的依赖项结构。
 *
 * 后端未部署该接口（返回非 200 / 网络错误）时，调用方应优雅降级
 * （视为无项目级依赖，仅保留逐文件行为）。
 */
export interface ProjectDependencyItem {
  id: string;
  /** 依赖坐标（artifactId），编译与 LSP classpath 均按此匹配 */
  name: string;
  version: string;
  /** 依赖来源（如 custom / system），仅用于展示与回填 */
  source?: string;
}

export interface ProjectDependencyConfig {
  dependencies: ProjectDependencyItem[];
}

// 后端 params 接口返回的是 jarDependencyCatalogs: string[]（仅坐标），
// 这里把它映射成前端使用的带 id 的依赖项结构。
const toConfig = (vo?: ProgramParamsVO): ProjectDependencyConfig => ({
  dependencies: (vo?.jarDependencyCatalogs || []).map((name, i) => ({
    id: `proj_dep_${i}`,
    name,
    version: '',
  })),
});

export const fetchProjectDependencyConfig = async (
  projectId: number,
  projectCode?: string
): Promise<ApiResponse<ProjectDependencyConfig>> => {
  try {
    const res = await request<ApiResponse<ProgramParamsVO>>(
      `/api/development/project/${projectId}/params`,
      // 项目级配置以项目编码作为 filePath（后端要求 filePath 非空）
      { params: { filePath: projectCode ?? '' }, suppressError: true }
    );
    if (res && res.code === 200 && res.data) {
      return { ...res, data: toConfig(res.data) };
    }
    // 业务错误码：降级为空依赖
    return { code: res?.code ?? 200, message: res?.message ?? 'ok', data: { dependencies: [] } };
  } catch {
    // 网络错误 / 404（后端接口尚未部署）：优雅降级，视为无项目级依赖
    return { code: 200, message: 'ok', data: { dependencies: [] } };
  }
};

export const saveProjectDependencyConfig = (
  projectId: number,
  projectCode: string,
  body: ProjectDependencyConfig
) =>
  request<ApiResponse<null>>(`/api/development/project/${projectId}/params`, {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      // 项目级配置以项目编码作为 filePath（后端要求 filePath 非空）
      filePath: projectCode ?? '',
      engine: '',
      datasources: [],
      jarDependencyCatalogs: body.dependencies.filter((d) => d.name).map((d) => d.name),
      runParams: {},
      computeResources: {},
      remark: '',
    }),
  });
