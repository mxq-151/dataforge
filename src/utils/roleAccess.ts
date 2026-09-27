/**
 * 平台级角色的统一判定入口。
 *
 * 「超级管理员 + 运维人员」这一组合在多个模块里都是「平台管理类操作」的准入条件：
 * - 开发助手的项目管理（`dev-assistant/ProjectList`）
 * - 调度管理的定时调度配置（`schedule-management`）
 * - 提交调度的**生产环境**准入（`SubmitToSchedulerModal` / `FolderSubmitScheduleModal`）
 *
 * 「数据开发工程师」则决定代码编辑与**灰度 / 测试环境**的提交调度准入。
 *
 * 角色码以前在各模块各写一份字符串数组，容易漂移；这里收敛为唯一真源。
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

/**
 * 数据开发工程师的角色码（同一角色同样有带/不带 `ROLE_` 前缀与中文名三种写法）。
 *
 * 这份名单原先内联在 `dev-assistant/DevAssistantView`（代码文件编辑权限），
 * 提交调度的灰度/测试准入复用同一份，避免两处漂移。
 */
export const DATA_DEV_ENGINEER_ROLE_NAMES = [
  'ROLE_DATA_DEV_ENGINEER',
  'DATA_DEV_ENGINEER',
  '数据开发工程师',
];

/** 角色码是否命中名单（英文角色码大小写无关；中文不受 toUpperCase 影响，比较结果不变） */
function matchesAnyRoleCode(
  roles: { roleCode?: string | null }[] | null | undefined,
  allowed: readonly string[],
): boolean {
  if (!roles || roles.length === 0) return false;
  return roles.some(role => {
    const code = role?.roleCode;
    if (!code) return false;
    return allowed.some(name => {
      if (code === name) return true;
      try {
        return code.toUpperCase() === name.toUpperCase();
      } catch {
        return false;
      }
    });
  });
}

/** 判定一个用户是否拥有平台管理角色（超级管理员 或 运维人员）。 */
export function hasPlatformAdminRole(
  roles: { roleCode?: string | null }[] | null | undefined,
): boolean {
  return matchesAnyRoleCode(roles, PLATFORM_ADMIN_ROLE_NAMES);
}

/** 判定一个用户是否为数据开发工程师。 */
export function hasDataDevEngineerRole(
  roles: { roleCode?: string | null }[] | null | undefined,
): boolean {
  return matchesAnyRoleCode(roles, DATA_DEV_ENGINEER_ROLE_NAMES);
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

/** 提交调度准入判定所接受的最小用户信息 */
export interface ScheduleRoleUser {
  roles?: { roleCode?: string | null }[] | null;
  isSuperAdmin?: boolean;
}

/**
 * 提交调度（灰度 / 测试环境）的准入判定：数据开发工程师、运维人员、超级管理员可发起。
 *
 * 灰度 / 测试是数据开发的日常验证环境，数据开发工程师自己就能发起；
 * 其余角色（如数据分析师、业务需求方）没有提交调度的职责，一并拦截。
 */
export function canSubmitSchedule(user: ScheduleRoleUser | null | undefined): boolean {
  if (!user) return false;
  return hasDataDevEngineerRole(user.roles) || canManageSchedule(user);
}

/**
 * 提交调度**生产环境**的准入判定：仅运维人员与超级管理员可发起。
 *
 * 口径与 `canManageSchedule` 一致（超管天然拥有全部平台权限）。
 * 生产环境的工作流会真实跑在生产集群上，数据开发工程师只能提交灰度 / 测试，
 * 上生产由运维工程师发起（前端拦截 + 提示，后端仍需对端点独立校验）。
 */
export function canSubmitProdSchedule(user: ScheduleRoleUser | null | undefined): boolean {
  return canManageSchedule(user);
}

/**
 * 提交调度被角色拦截时的提示文案。
 *
 * 放在判定同一出口（而非各弹窗各写一份），保证单文件 / 文件夹两个提交入口
 * 给出的说法一字不差，用户在不同入口看到的是同一套准入口径。
 */
export const SCHEDULE_ROLE_DENIED_MESSAGE =
  '当前角色无权提交调度：灰度/测试环境需「数据开发工程师」角色，如确需提交请联系管理员申请';

/** 生产环境被角色拦截时的提示文案（超管与运维工程师放行） */
export const PROD_SCHEDULE_ROLE_DENIED_MESSAGE =
  '生产环境提交调度仅「运维工程师」可发起（超级管理员同样放行），请改为提交灰度或测试环境';
