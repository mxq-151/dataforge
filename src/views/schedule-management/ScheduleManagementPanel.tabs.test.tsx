import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import ScheduleManagementPanel from './ScheduleManagementPanel';

/**
 * 调度管理多标签页的行为测试。
 *
 * 这里不接后端，用 vi.mock 把 DolphinSchedulerContext 换成本地的假 api；
 * 断言只围绕标签页这一层：入口是不是项目列表、新建/切换/关闭/同项目复用/删除回退是否符合预期。
 * 标签页用 CSS 显隐切换，jsdom 不加载样式表，因此所有标签页在 DOM 里都存在且「可见」，
 * 查询一律按 .sm-tab-page 容器收窄作用域，避免跨标签页误命中。
 */

const h = vi.hoisted(() => {
  let projects: any[] = [];

  const page = (list: any[]) => ({ code: 0, data: { total: list.length, totalList: list } });

  const api: any = {
    project: {
      list: vi.fn(async () => page(projects)),
      create: vi.fn(async () => ({ code: 0, data: {} })),
      update: vi.fn(async () => ({ code: 0, data: {} })),
      delete: vi.fn(async () => ({ code: 0, data: {} })),
    },
    workflowDefinition: {
      list: vi.fn(async () => page([])),
      detail: vi.fn(async () => ({ code: 0, data: {} })),
      create: vi.fn(async () => ({ code: 0, data: {} })),
      createWithTasks: vi.fn(async () => ({ code: 0, data: {} })),
      update: vi.fn(async () => ({ code: 0, data: {} })),
      delete: vi.fn(async () => ({ code: 0, data: {} })),
      release: vi.fn(async () => ({ code: 0, data: {} })),
      trigger: vi.fn(async () => ({ code: 0, data: {} })),
    },
    workflowInstance: {
      list: vi.fn(async () => page([])),
      detail: vi.fn(async () => ({ code: 0, data: {} })),
      execute: vi.fn(async () => ({ code: 0, data: {} })),
    },
    taskInstance: {
      list: vi.fn(async () => page([])),
      log: vi.fn(async () => ({ code: 0, data: { message: 'log' } })),
      forceSuccess: vi.fn(async () => ({ code: 0, data: {} })),
    },
    environment: { list: vi.fn(async () => page([])) },
    alertGroup: { list: vi.fn(async () => page([])) },
    workerGroup: { list: vi.fn(async () => page([])) },
    // ProjectDetailView 挂载即拉租户，缺这一项会让每个用例都往 stderr 里刷一条
    // 「Cannot read properties of undefined」——噪音会掩盖真正的问题，因此补上桩
    tenant: { list: vi.fn(async () => page([])) },
  };

  return {
    api,
    setProjects: (list: any[]) => { projects = list; },
  };
});

vi.mock('../../contexts/DolphinSchedulerContext', () => ({
  useDolphinSchedulerApi: () => ({ api: h.api, isRealApi: false }),
  DolphinSchedulerProvider: ({ children }: any) => children,
}));

// 当前登录用户（默认超管，保证既有用例的删除/编辑按钮可用）
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

const makeUser = (isSuperAdmin: boolean, projectCodes: { projectCode: string; permissionType: number }[] = []) => ({
  id: isSuperAdmin ? 1 : 2,
  username: isSuperAdmin ? 'admin' : 'test',
  realName: isSuperAdmin ? '管理员' : '测试用户',
  roles: isSuperAdmin
    ? [{ id: 1, roleCode: 'SUPER_ADMIN', roleName: '超级管理员' }]
    : [{ id: 2, roleCode: 'DATA_DEV_ENGINEER', roleName: '数据开发工程师' }],
  roleIds: isSuperAdmin ? [1] : [2],
  menuTags: [],
  projectCodes,
  isSuperAdmin,
  currentRoleId: isSuperAdmin ? 1 : 2,
});

const makeProject = (code: number, name: string) => ({
  id: code,
  code,
  name,
  description: `${name} 描述`,
  userId: 1,
  userName: 'admin',
  createTime: '2026-01-01 00:00:00',
  updateTime: '2026-01-02 00:00:00',
});

const P1 = makeProject(1001, '广告数仓');
const P2 = makeProject(1002, '用户画像');

const tabEls = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>('.sm-tab'));
const tabLabels = (c: HTMLElement) =>
  Array.from(c.querySelectorAll<HTMLElement>('.sm-tab__label')).map(el => el.textContent);
const activeTabLabel = (c: HTMLElement) =>
  c.querySelector<HTMLElement>('.sm-tab--active .sm-tab__label')?.textContent ?? null;
const pages = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>('.sm-tab-page'));
const activePage = (c: HTMLElement) =>
  c.querySelector<HTMLElement>('.sm-tab-page--active') as HTMLElement;

const click = (el: HTMLElement) => fireEvent.click(el);

const clickTab = (c: HTMLElement, index: number) => click(tabEls(c)[index]);

const newTab = (c: HTMLElement) => click(c.querySelector('.sm-tabbar__new') as HTMLElement);

/** 在当前激活的标签页里点项目名进入项目 */
const enterProject = (c: HTMLElement, name: string) => {
  click(within(activePage(c)).getByText(name));
};

beforeEach(() => {
  h.setProjects([P1, P2]);
  auth.__setUser(makeUser(true));
  vi.clearAllMocks();
});

describe('调度管理多标签页', () => {
  it('默认打开一个以项目列表为入口的标签页', async () => {
    const { container } = render(<ScheduleManagementPanel />);

    await waitFor(() => expect(h.api.project.list).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('广告数仓')).toBeTruthy());

    expect(tabLabels(container)).toEqual(['项目列表']);
    expect(activeTabLabel(container)).toBe('项目列表');
    expect(pages(container).length).toBe(1);
  });

  it('新建标签页后每个标签页都从项目列表开始，各自独立加载', async () => {
    const { container } = render(<ScheduleManagementPanel />);
    await waitFor(() => expect(screen.getByText('广告数仓')).toBeTruthy());

    newTab(container);

    await waitFor(() => expect(tabLabels(container)).toEqual(['项目列表', '项目列表']));
    expect(pages(container).length).toBe(2);
    expect(activeTabLabel(container)).toBe('项目列表');
    // 两个标签页各自拉了一次项目列表
    await waitFor(() => expect(h.api.project.list).toHaveBeenCalledTimes(2));
  });

  it('进入项目后标签标题变为项目名，其它标签页不受影响', async () => {
    const { container } = render(<ScheduleManagementPanel />);
    await waitFor(() => expect(screen.getByText('广告数仓')).toBeTruthy());

    newTab(container);
    await waitFor(() => expect(pages(container).length).toBe(2));

    // 在第二个标签页里进入「用户画像」
    enterProject(container, '用户画像');

    await waitFor(() => expect(tabLabels(container)).toEqual(['项目列表', '用户画像']));
    expect(activeTabLabel(container)).toBe('用户画像');
    // 第一个标签页仍停在项目列表
    expect(within(pages(container)[0]).getByText('广告数仓')).toBeTruthy();
    // 详情页按标签页所属项目拉数据
    await waitFor(() =>
      expect(h.api.workflowDefinition.list).toHaveBeenCalledWith(1002, expect.objectContaining({ pageNo: 1 })),
    );
  });

  it('同一个项目不会开第二个标签页，而是激活已打开的那个', async () => {
    const { container } = render(<ScheduleManagementPanel />);
    await waitFor(() => expect(screen.getByText('广告数仓')).toBeTruthy());

    enterProject(container, '广告数仓');
    await waitFor(() => expect(activeTabLabel(container)).toBe('广告数仓'));

    // 新建一个停在项目列表的标签页，在里面再次进入同一个项目
    newTab(container);
    await waitFor(() => expect(tabLabels(container)).toEqual(['广告数仓', '项目列表']));

    enterProject(container, '广告数仓');

    // 不新增第三个标签页，而是切回已经打开该项目的第一个标签页
    await waitFor(() => expect(activeTabLabel(container)).toBe('广告数仓'));
    expect(tabLabels(container)).toEqual(['广告数仓', '项目列表']);
    expect(activePage(container)).toBe(pages(container)[0]);
  });

  it('项目详情页点返回项目列表后，标签标题恢复为入口名称', async () => {
    const { container } = render(<ScheduleManagementPanel />);
    await waitFor(() => expect(screen.getByText('广告数仓')).toBeTruthy());

    enterProject(container, '广告数仓');
    await waitFor(() => expect(activeTabLabel(container)).toBe('广告数仓'));

    click(within(activePage(container)).getByText('返回项目列表'));

    await waitFor(() => expect(activeTabLabel(container)).toBe('项目列表'));
    expect(tabLabels(container)).toEqual(['项目列表']);
    // 退回入口后项目列表仍可正常使用
    expect(within(activePage(container)).getByText('广告数仓')).toBeTruthy();
  });

  it('关闭当前标签页后激活相邻标签页，关闭最后一个时保留一个并退回项目列表', async () => {
    const { container } = render(<ScheduleManagementPanel />);
    await waitFor(() => expect(screen.getByText('广告数仓')).toBeTruthy());

    enterProject(container, '广告数仓');
    await waitFor(() => expect(activeTabLabel(container)).toBe('广告数仓'));

    newTab(container);
    await waitFor(() => expect(tabLabels(container)).toEqual(['广告数仓', '项目列表']));

    // 关掉当前激活的第二个标签页 -> 激活左侧邻居
    click(container.querySelectorAll<HTMLElement>('.sm-tab__close')[1]);
    await waitFor(() => expect(tabLabels(container)).toEqual(['广告数仓']));
    expect(activeTabLabel(container)).toBe('广告数仓');

    // 只剩一个标签页时点关闭：不消失，而是重置回项目列表
    click(container.querySelectorAll<HTMLElement>('.sm-tab__close')[0]);
    await waitFor(() => expect(activeTabLabel(container)).toBe('项目列表'));
    expect(tabLabels(container)).toEqual(['项目列表']);
  });

  it('删除项目后，停在该项目的标签页退回项目列表', async () => {
    const { container } = render(<ScheduleManagementPanel />);
    await waitFor(() => expect(screen.getByText('广告数仓')).toBeTruthy());

    enterProject(container, '广告数仓');
    await waitFor(() => expect(activeTabLabel(container)).toBe('广告数仓'));

    // 新开一个停在项目列表的标签页，在那里删除该项目
    newTab(container);
    await waitFor(() => expect(tabLabels(container)).toEqual(['广告数仓', '项目列表']));

    const row = within(activePage(container)).getByText('广告数仓').closest('tr') as HTMLElement;
    click(within(row).getByTitle('删除'));
    click(screen.getByText('确认'));

    await waitFor(() => expect(h.api.project.delete).toHaveBeenCalledWith(1001));
    // 被删项目的标签页回到入口，另一个标签页保持在项目列表
    await waitFor(() => expect(tabLabels(container)).toEqual(['项目列表', '项目列表']));
  });

  it('非超管且仅拥有「可编辑」权限时，删除按钮禁用且不会调用删除接口', async () => {
    // 调度项目名称「广告数仓」对应开发项目编码，登录信息里该用户权限为「可编辑」(2) <「可删除」(3)
    auth.__setUser(makeUser(false, [{ projectCode: '广告数仓', permissionType: 2 }]));

    const { container } = render(<ScheduleManagementPanel />);
    await waitFor(() => expect(screen.getByText('广告数仓')).toBeTruthy());

    const row = within(activePage(container)).getByText('广告数仓').closest('tr') as HTMLElement;
    // 删除按钮为禁用态（标题为「无删除权限」）
    const deleteBtn = within(row).getByTitle('无删除权限') as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(true);
    // 编辑按钮仍可用（可编辑权限满足）
    expect((within(row).getByTitle('编辑') as HTMLButtonElement).disabled).toBe(false);

    click(deleteBtn);
    expect(h.api.project.delete).not.toHaveBeenCalled();
  });

  it('搜索框输入不立即请求，回车或点搜索按钮才生效', async () => {
    const { container } = render(<ScheduleManagementPanel />);
    await waitFor(() => expect(screen.getByText('广告数仓')).toBeTruthy());
    const callsAfterMount = h.api.project.list.mock.calls.length;

    const input = within(activePage(container)).getByPlaceholderText('搜索项目...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '广告' } });
    await waitFor(() => expect(input.value).toBe('广告'));
    // 逐字输入不应触发请求
    expect(h.api.project.list.mock.calls.length).toBe(callsAfterMount);
    expect(h.api.project.list).not.toHaveBeenCalledWith(expect.objectContaining({ searchVal: '广告' }));

    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(h.api.project.list).toHaveBeenCalledWith(expect.objectContaining({ searchVal: '广告' })),
    );

    // 搜索按钮同样能触发（搜索词没变时也要再发一次请求）
    const callsAfterEnter = h.api.project.list.mock.calls.length;
    click(within(activePage(container)).getByTitle('搜索（回车）'));
    await waitFor(() => expect(h.api.project.list.mock.calls.length).toBe(callsAfterEnter + 1));
  });

  it('切换标签页只切换激活项，不重建页面也不额外请求', async () => {
    const { container } = render(<ScheduleManagementPanel />);
    await waitFor(() => expect(screen.getByText('广告数仓')).toBeTruthy());

    newTab(container);
    await waitFor(() => expect(pages(container).length).toBe(2));

    // 在第二个标签页的搜索框里输入内容（该状态只属于这个标签页）
    const searchInput = within(pages(container)[1]).getByPlaceholderText('搜索项目...');
    fireEvent.change(searchInput, { target: { value: '画像' } });
    await waitFor(() => expect((searchInput as HTMLInputElement).value).toBe('画像'));
    const callsAfterSearch = h.api.project.list.mock.calls.length;

    clickTab(container, 0);
    expect(activePage(container)).toBe(pages(container)[0]);
    clickTab(container, 1);
    expect(activePage(container)).toBe(pages(container)[1]);

    // 没有新的项目列表请求，说明是显隐切换而非重新挂载
    expect(h.api.project.list.mock.calls.length).toBe(callsAfterSearch);
    expect((within(activePage(container)).getByPlaceholderText('搜索项目...') as HTMLInputElement).value)
      .toBe('画像');
  });
});
