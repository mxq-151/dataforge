import { describe, it, expect } from 'vitest';
import {
  PLATFORM_ADMIN_ROLE_NAMES,
  DATA_DEV_ENGINEER_ROLE_NAMES,
  hasPlatformAdminRole,
  hasDataDevEngineerRole,
  canManageSchedule,
  canSubmitSchedule,
  canSubmitProdSchedule,
  SCHEDULE_ROLE_DENIED_MESSAGE,
  PROD_SCHEDULE_ROLE_DENIED_MESSAGE,
} from './roleAccess';

/**
 * 「超级管理员 + 运维人员」准入判定的边界测试。
 *
 * 定时调度只对这两类角色开放，判定错一个角色码就等于把定时功能暴露给了所有人，
 * 因此这里把每个角色码、大小写变体、空值都钉成用例。
 */

const role = (roleCode: string) => ({ roleCode, roleName: roleCode });

describe('hasPlatformAdminRole', () => {
  it('识别超级管理员的全部写法', () => {
    for (const code of ['ROLE_ADMIN', 'ADMIN', 'SUPER_ADMIN', '超级管理员']) {
      expect(hasPlatformAdminRole([role(code)]), code).toBe(true);
    }
  });

  it('识别运维人员的全部写法', () => {
    for (const code of ['ROLE_OPS_ENGINEER', 'OPS_ENGINEER', '运维工程师']) {
      expect(hasPlatformAdminRole([role(code)]), code).toBe(true);
    }
  });

  it('大小写不敏感（英文角色码）', () => {
    expect(hasPlatformAdminRole([role('ops_engineer')])).toBe(true);
    expect(hasPlatformAdminRole([role('super_admin')])).toBe(true);
  });

  it('多角色时任一命中即通过', () => {
    expect(hasPlatformAdminRole([role('DATA_DEV_ENGINEER'), role('OPS_ENGINEER')])).toBe(true);
  });

  it('其它角色一律不通过', () => {
    for (const code of ['DATA_DEV_ENGINEER', 'DATA_ANALYST', 'VISITOR', '数据开发工程师']) {
      expect(hasPlatformAdminRole([role(code)]), code).toBe(false);
    }
  });

  it('空值 / 空数组 / 缺失 roleCode 都返回 false', () => {
    expect(hasPlatformAdminRole(null)).toBe(false);
    expect(hasPlatformAdminRole(undefined)).toBe(false);
    expect(hasPlatformAdminRole([])).toBe(false);
    expect(hasPlatformAdminRole([{ roleCode: '' }])).toBe(false);
    expect(hasPlatformAdminRole([{ roleCode: null }])).toBe(false);
    expect(hasPlatformAdminRole([{}])).toBe(false);
  });

  it('不把角色名 / 描述当角色码匹配，避免误放行', () => {
    // roleName 里出现「管理员」不代表 roleCode 是管理员
    expect(hasPlatformAdminRole([{ roleCode: 'DATA_DEV_ENGINEER', roleName: '超级管理员' }])).toBe(false);
  });

  it('常量清单覆盖超管与运维两组角色码', () => {
    expect(PLATFORM_ADMIN_ROLE_NAMES).toContain('SUPER_ADMIN');
    expect(PLATFORM_ADMIN_ROLE_NAMES).toContain('OPS_ENGINEER');
  });
});

describe('canManageSchedule', () => {
  it('超管标记为真时放行（即使角色列表为空）', () => {
    expect(canManageSchedule({ isSuperAdmin: true, roles: [] })).toBe(true);
  });

  it('运维人员靠角色放行', () => {
    expect(canManageSchedule({ isSuperAdmin: false, roles: [role('OPS_ENGINEER')] })).toBe(true);
  });

  it('普通开发 / 数据分析角色被拒绝', () => {
    expect(canManageSchedule({ isSuperAdmin: false, roles: [role('DATA_DEV_ENGINEER')] })).toBe(false);
    expect(canManageSchedule({ isSuperAdmin: false, roles: [role('DATA_ANALYST')] })).toBe(false);
  });

  it('未登录（null/undefined）被拒绝', () => {
    expect(canManageSchedule(null)).toBe(false);
    expect(canManageSchedule(undefined)).toBe(false);
  });

  it('只有 isSuperAdmin 为假且角色缺失时才算拒绝', () => {
    expect(canManageSchedule({ isSuperAdmin: false })).toBe(false);
  });
});

describe('hasDataDevEngineerRole', () => {
  it('识别数据开发工程师的三种写法与大小写变体', () => {
    for (const code of ['ROLE_DATA_DEV_ENGINEER', 'DATA_DEV_ENGINEER', '数据开发工程师', 'data_dev_engineer']) {
      expect(hasDataDevEngineerRole([role(code)]), code).toBe(true);
    }
  });

  it('运维 / 数据分析等其它角色不通过', () => {
    for (const code of ['OPS_ENGINEER', 'DATA_ANALYST', 'VISITOR']) {
      expect(hasDataDevEngineerRole([role(code)]), code).toBe(false);
    }
  });

  it('空值一律不通过', () => {
    expect(hasDataDevEngineerRole(null)).toBe(false);
    expect(hasDataDevEngineerRole([])).toBe(false);
    expect(hasDataDevEngineerRole([{ roleCode: null }])).toBe(false);
  });

  it('常量清单与提交调度灰度/测试准入共用同一份', () => {
    expect(DATA_DEV_ENGINEER_ROLE_NAMES).toContain('ROLE_DATA_DEV_ENGINEER');
  });
});

/**
 * 提交调度的两档准入（用户口径）：
 * · 灰度 / 测试 —— 数据开发工程师、运维工程师、超级管理员可发起；
 * · 生产 —— 仅运维工程师与超级管理员可发起。
 * 白名单之外的角色（如数据分析师）两档都进不去。
 */
describe('canSubmitSchedule（灰度 / 测试准入）', () => {
  it('数据开发工程师可发起', () => {
    expect(canSubmitSchedule({ isSuperAdmin: false, roles: [role('DATA_DEV_ENGINEER')] })).toBe(true);
  });

  it('运维工程师与超管同样可发起（准入口径含平台管理角色）', () => {
    expect(canSubmitSchedule({ isSuperAdmin: false, roles: [role('OPS_ENGINEER')] })).toBe(true);
    expect(canSubmitSchedule({ isSuperAdmin: true, roles: [] })).toBe(true);
  });

  it('白名单之外的角色一律被拒绝', () => {
    for (const code of ['DATA_ANALYST', 'VISITOR', 'BUSINESS_OWNER']) {
      expect(canSubmitSchedule({ isSuperAdmin: false, roles: [role(code)] }), code).toBe(false);
    }
  });

  it('未登录 / 角色缺失被拒绝', () => {
    expect(canSubmitSchedule(null)).toBe(false);
    expect(canSubmitSchedule(undefined)).toBe(false);
    expect(canSubmitSchedule({ isSuperAdmin: false })).toBe(false);
    expect(canSubmitSchedule({ isSuperAdmin: false, roles: [] })).toBe(false);
  });
});

describe('canSubmitProdSchedule（生产准入）', () => {
  it('运维工程师可发起', () => {
    expect(canSubmitProdSchedule({ isSuperAdmin: false, roles: [role('OPS_ENGINEER')] })).toBe(true);
  });

  it('超管一并放行', () => {
    expect(canSubmitProdSchedule({ isSuperAdmin: true, roles: [] })).toBe(true);
    expect(canSubmitProdSchedule({ isSuperAdmin: false, roles: [role('SUPER_ADMIN')] })).toBe(true);
  });

  it('数据开发工程师不能发起生产（这正是与灰度/测试的分界）', () => {
    expect(canSubmitProdSchedule({ isSuperAdmin: false, roles: [role('DATA_DEV_ENGINEER')] })).toBe(false);
  });

  it('未登录 / 其它角色被拒绝', () => {
    expect(canSubmitProdSchedule(null)).toBe(false);
    expect(canSubmitProdSchedule({ isSuperAdmin: false, roles: [role('DATA_ANALYST')] })).toBe(false);
  });
});

describe('角色准入提示文案', () => {
  it('生产拦截文案点名运维工程师，且与灰度/测试文案区分开', () => {
    expect(PROD_SCHEDULE_ROLE_DENIED_MESSAGE).toContain('运维工程师');
    expect(SCHEDULE_ROLE_DENIED_MESSAGE).toContain('数据开发工程师');
    expect(SCHEDULE_ROLE_DENIED_MESSAGE).not.toBe(PROD_SCHEDULE_ROLE_DENIED_MESSAGE);
  });
});
