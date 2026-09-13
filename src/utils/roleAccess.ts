/**
 * 平台级角色的统一判定入口。
 *
 * 「超级管理员 + 运维人员」这一组合在多个模块里都是「平台管理类操作」的准入条件：
 * - 开发助手的项目管理（`dev-assistant/ProjectList`）
 * - 调度管理的定时调度配置（`schedule-management`）
 *
 * 角色码以前在两个模块各写一份字符串数组，容易漂移；这里收敛为唯一真源。
 * 判定只依据**后端返回的角色信息**（roleCode），不以用户名等前端可得信息为依据。
 * 前端判定仅用于 UX（按钮禁用 / 提示），真正的安全边界必须由后端对每个端点独立校验。
 */

/**
 * 允许执行平台管理类操作的角色码。
 *
 * 后端角色编码体系下同一角色存在带/不带 `ROLE_` 前缀两种写法，
 * 中文名作为最后兜底（历史数据或手工建的角色的 roleName 直接落在 roleCode 上）。
 */
export const PLATFORM_ADMIN_ROLE_NAMES = [
  // 超级管理员
  'ROLE_ADMIN',
  'ADMIN',
  'SUPER_ADMIN',
  '超级管理员',
  // 运维人员
  'ROLE_OPS_ENGINEER',
  'OPS_ENGINEER',
  '运维工程师',
];

/** 判定一个用户是否拥有平台管理角色（超级管理员 或 运维人员）。 */
export function hasPlatformAdminRole(
  roles: { roleCode?: string | null }[] | null | undefined,
): boolean {
  if (!roles || roles.length === 0) return false;
  return roles.some(role => {
    const code = role?.roleCode;
    if (!code) return false;
    return PLATFORM_ADMIN_ROLE_NAMES.some(allowed => {
      if (code === allowed) return true;
      // 兜底做大小写无关比较（英文角色码）；中文不受 toUpperCase 影响，比较结果不变
      try {
        return code.toUpperCase() === allowed.toUpperCase();
      } catch {
        return false;
      }
    });
  });
}

/**
 * 定时调度的准入判定：仅超级管理员与运维人员可配置工作流的定时调度。
 *
 * 超管在 `useAuth` 里已被单独标记（`isSuperAdmin`），但该标记本身也是由角色推导出来的，
 * 这里统一走角色判定，避免两条路径给出不一致的结论。
 */
export function canManageSchedule(
  user: { roles?: { roleCode?: string | null }[] | null; isSuperAdmin?: boolean } | null | undefined,
): boolean {
  if (!user) return false;
  return !!user.isSuperAdmin || hasPlatformAdminRole(user.roles);
}
