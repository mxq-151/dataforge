import { request } from './index';
import type { ApiResponse } from './types';
import type { ProgramParamsVO } from './devProject';

/**
 * 项目级依赖配置（开发助手模块）。
 *
 * 复用「逐文件配置」的 /params 接口。后端要求 filePath 非空，
 * 项目级配置以「项目编码」作为 filePath 来标识（区别于逐文件具体路径）。
 *   GET /api/development/project/{projectId}/params?filePath={projectCode}
 *   PUT /api/development/project/{projectId}/params  (body.filePath = projectCode, upsert)
 * 后端返回的 jarDependencyCatalogs 为 DevJarDependency 对象数组（不再只是坐标字符串），
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

// 后端 params 接口返回的是 DevJarDependency 对象数组，
// 这里把它映射成前端使用的带 id 的依赖项结构。
const toConfig = (vo?: ProgramParamsVO): ProjectDependencyConfig => ({
  dependencies: (vo?.jarDependencyCatalogs || []).map((dep, i) => ({
    id: `proj_dep_${i}`,
    name: dep.artifactId || dep.jarName || '',
    version: dep.version || '',
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
  // 后端 DevProjectController 仅暴露 PUT upsert（旧 POST 已移除）
  request<ApiResponse<null>>(`/api/development/project/${projectId}/params`, {
    method: 'PUT',
    body: JSON.stringify({
      projectId,
      // 项目级配置以项目编码作为 filePath（后端要求 filePath 非空）
      filePath: projectCode ?? '',
      engine: '',
      datasources: [],
      // 后端 jarDependencyCatalogs 为 DevJarDependency 对象数组
      jarDependencyCatalogs: body.dependencies.filter((d) => d.name).map((d) => ({
        jarName: d.name,
        artifactId: d.name,
        version: d.version,
        source: d.source,
      })),
      runParams: {},
      computeResources: {},
      remark: '',
    }),
  });
