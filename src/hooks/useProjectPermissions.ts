import { useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';

/**
 * 调度项目权限类型（与后端 DataAccessPermissionService 常量一致）：
 * 1=读取、2=编辑、3=删除。
 */
export const PROJECT_PERM_READ = 1;
export const PROJECT_PERM_EDIT = 2;
export const PROJECT_PERM_DELETE = 3;

export interface ProjectPermissionsState {
  /**
   * 当前用户对各项目的最大权限类型，key 为项目编码（开发项目编码，与调度项目名称一致）。
   * 未出现在登录信息里的项目不在映射中（视为无编辑/删除权限）；用户未登录时为 null。
   */
  permissionByCode: ReadonlyMap<string, number> | null;
  /** 登录信息就绪后即为 false（权限来自登录信息，无需再发请求） */
  loading: boolean;
}

/**
 * 获取当前用户在调度项目上的权限映射。
 *
 * 数据直接来自登录信息接口（/system/auth/info）返回的 projectCodes：
 * 后端已按用户所属全部角色对同一项目取最大权限类型并附带项目编码，因此这里只做一次映射。
 * 调度项目与开发项目通过「调度项目名称 === 开发项目编码」关联（与提交调度时的匹配规则一致）。
 * 超级管理员由各消费模块通过 user.isSuperAdmin 放行，此处不额外处理。
 */
const useProjectPermissions = (): ProjectPermissionsState => {
  const { user } = useAuth();

  const permissionByCode = useMemo(() => {
    if (!user) return null;
    const map = new Map<string, number>();
    for (const pc of user.projectCodes ?? []) {
      if (pc.projectCode) map.set(pc.projectCode, pc.permissionType);
    }
    return map;
  }, [user]);

  return { permissionByCode, loading: !user };
};

export { useProjectPermissions };
export default useProjectPermissions;
