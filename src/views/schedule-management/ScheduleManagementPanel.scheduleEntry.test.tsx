import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import ScheduleManagementPanel from './ScheduleManagementPanel';

/**
 * 「定时」入口的角色门禁（需求级断言：定时功能只有超级管理员和运维人员能使用）。
 *
 * 这里从整个调度管理面板的最外层渲染，走到项目详情页的工作流列表，只断言入口按钮这一层：
 * - 超管 / 运维工程师：按钮可用，点击打开定时弹窗；
 * - 其它角色：按钮禁用、标题说明原因，点击不会打开弹窗。
 *
 * 门禁的后半段（弹窗内部的二次防御与提交载荷）由 ScheduleModal.test.tsx 覆盖。
 */

const h = vi.hoisted(() => {
  const page = (list: any[]) => ({ code: 0, data: { total: list.length, totalList: list } });

  const defs = [
    {
      id: 1,
      code: 9001,
      name: 'ads_daily',
      version: 1,
      description: '每天跑',
      projectCode: 1001,
      projectName: '广告数仓',
      releaseState: 1,
      userId: 1,
      userName: 'admin',
      globalParams: '[]',
      locations: '[]',
      warningGroupId: 0,
      timeout: 0,
      executionType: 0,
      createTime: '2026-01-01 00:00:00',
      updateTime: '2026-01-02 00:00:00',
    },
  ];

  const api: any = {
    project: {
      list: vi.fn(async () =>
        page([
          { id: 1001, code: 1001, name: '广告数仓', description: '', userId: 1, userName: 'admin', createTime: '', updateTime: '' },
        ]),
      ),
    },
    workflowDefinition: {
      list: vi.fn(async () => page(defs)),
      detail: vi.fn(async () => ({ code: 0, data: {} })),
    },
    workflowInstance: { list: vi.fn(async () => page([])) },
    taskInstance: { list: vi.fn(async () => page([])) },
    environment: { list: vi.fn(async () => page([])) },
    alertGroup: { list: vi.fn(async () => page([])) },
    workerGroup: { list: vi.fn(async () => page([])) },
    tenant: { list: vi.fn(async () => page([])) },
    schedule: {
      list: vi.fn(async () => page([])),
      preview: vi.fn(async () => ({ code: 0, msg: 'success', data: [] })),
      create: vi.fn(async () => ({ code: 0, msg: 'success', data: null })),
      update: vi.fn(async () => ({ code: 0, msg: 'success', data: null })),
      delete: vi.fn(async () => ({ code: 0, msg: 'success', data: null })),
      online: vi.fn(async () => ({ code: 0, msg: 'success', data: null })),
      offline: vi.fn(async () => ({ code: 0, msg: 'success', data: null })),
    },
  };

  return { api, page, defs };
});

vi.mock('../../contexts/DolphinSchedulerContext', () => ({
  useDolphinSchedulerApi: () => ({ api: h.api, isRealApi: false }),
  DolphinSchedulerProvider: ({ children }: any) => children,
}));

const auth = vi.hoisted(() => {
  let user: any = null;
  return {
    __setUser: (u: any) => { user = u; },
    useAuth: () => ({
      user,
      authenticated: !!user,
      loading: false,
      login: vi.fn(),
      logout: vi.fn(),
      switchRole: vi.fn(),
    }),
  };
});

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => auth.useAuth(),
}));

const makeUser = (roleCode: string, isSuperAdmin = false) => ({
  id: 1,
  username: 'tester',
  realName: '测试用户',
  roles: [{ id: 1, roleCode, roleName: roleCode, roleType: 'user' }],
  roleIds: [1],
  menuTags: [],
  projectCodes: [],
  isSuperAdmin,
  currentRoleId: 1,
});

/** 进入唯一项目的详情页，停在「工作流定义」子 Tab */
async function enterProjectAndWait() {
  const { container } = render(<ScheduleManagementPanel />);
  await waitFor(() => expect(screen.getByText('广告数仓')).toBeTruthy());

  const activePage = container.querySelector('.sm-tab-page--active') as HTMLElement;
  fireEvent.click(within(activePage).getByText('广告数仓'));

  await waitFor(() => expect(h.api.workflowDefinition.list).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByText('ads_daily')).toBeTruthy());
  return container;
}

/** 取工作流行里的「定时」按钮 */
function scheduleButton(): HTMLButtonElement {
  const row = screen.getByText('ads_daily').closest('tr') as HTMLElement;
  return within(row).getByTitle(/定时/).closest('button') as HTMLButtonElement;
}

beforeEach(() => {
  auth.__setUser(makeUser('SUPER_ADMIN', true));
  vi.clearAllMocks();
});

describe('「定时」入口的角色门禁', () => {
  it('超级管理员：按钮可用，点击打开定时弹窗', async () => {
    await enterProjectAndWait();

    const btn = scheduleButton();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('title')).toBe('定时');

    fireEvent.click(btn);

    // 弹窗打开后先拉该工作流的定时
    await waitFor(() => expect(h.api.schedule.list).toHaveBeenCalledWith(1001, expect.objectContaining({ workflowDefinitionCode: 9001 })));
    expect(screen.getByText('定时调度')).toBeTruthy();
    expect(screen.getByText('未配置定时')).toBeTruthy();
  });

  it('运维工程师：按钮可用，点击打开定时弹窗', async () => {
    auth.__setUser(makeUser('OPS_ENGINEER'));
    await enterProjectAndWait();

    const btn = scheduleButton();
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText('定时调度')).toBeTruthy());
  });

  it('开发工程师：按钮禁用并说明原因，点击不打开弹窗', async () => {
    auth.__setUser(makeUser('DATA_DEV_ENGINEER'));
    await enterProjectAndWait();

    const btn = scheduleButton();
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('title')).toBe('无定时调度权限（仅超级管理员与运维人员）');

    fireEvent.click(btn);
    expect(screen.queryByText('定时调度')).toBeNull();
    expect(h.api.schedule.list).not.toHaveBeenCalled();
  });

  it('数据分析师：按钮同样禁用', async () => {
    auth.__setUser(makeUser('DATA_ANALYST'));
    await enterProjectAndWait();

    const btn = scheduleButton();
    expect(btn.disabled).toBe(true);
    expect(screen.queryByText('定时调度')).toBeNull();
  });

  it('定时门禁不外溢：同一行的编辑/删除按钮不受定时权限影响', async () => {
    // 工作流处于下线态时，编辑器与删除按钮本身可用（它们只受上线状态约束，不受角色影响）；
    // 用这一点确认「定时」按钮的禁用是独立判定，没有连坐整行操作
    h.api.workflowDefinition.list.mockResolvedValue(
      h.page(h.defs.map(d => ({ ...d, releaseState: 0 }))),
    );
    auth.__setUser(makeUser('DATA_DEV_ENGINEER'));
    await enterProjectAndWait();

    const row = screen.getByText('ads_daily').closest('tr') as HTMLElement;
    expect((within(row).getByTitle('编辑') as HTMLButtonElement).disabled).toBe(false);
    expect((within(row).getByTitle('删除') as HTMLButtonElement).disabled).toBe(false);
    // 同一行里唯独「定时」被拦下
    expect(scheduleButton().disabled).toBe(true);
  });
});
