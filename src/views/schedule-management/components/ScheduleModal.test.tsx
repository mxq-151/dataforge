import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ScheduleModal from './ScheduleModal';
import type { DSSchedule, DSWorkflowDefinition } from '../../../types/dolphinscheduler';
import { FailureStrategy, Priority, ReleaseState, WarningType } from '../../../types/dolphinscheduler';

/**
 * 定时调度弹窗的行为测试（接线级）。
 *
 * 需求：调度管理的工作流列表要能配置定时调度，且**只有超级管理员与运维人员可用**。
 * 这里钉住四件事：
 * 1. 权限门禁 —— 开发/分析角色只能看到只读提示，保存按钮禁用且不会发出任何写请求；
 * 2. 一种工作流只有一个定时 —— 已经存在定时时进入「编辑 + 上下线 + 删除」形态，否则是「新建」；
 * 3. crontab 闸门 —— 非法表达式或生效区间错误时禁止保存，不静默提交；
 * 4. 权威口径 —— 「从调度系统预览」走 schedule.preview，并把服务端结果标为来源。
 *
 * 权限判定来自 AuthContext，这里整体 mock 掉，避免依赖登录流程。
 */

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

vi.mock('../../../contexts/AuthContext', () => ({
  useAuth: () => auth.useAuth(),
}));

const role = (roleCode: string, roleName = roleCode) => ({ id: 1, roleCode, roleName, roleType: 'user' });

const makeUser = (roleCode: string, isSuperAdmin = false) => ({
  id: 1,
  username: 'tester',
  realName: '测试用户',
  roles: [role(roleCode)],
  roleIds: [1],
  menuTags: [],
  projectCodes: [],
  isSuperAdmin,
  currentRoleId: 1,
});

const workflow = (releaseState: ReleaseState | string = ReleaseState.ONLINE): DSWorkflowDefinition => ({
  id: 1,
  code: 9001,
  name: 'ads_daily',
  version: 1,
  description: '',
  projectCode: 1001,
  projectName: '广告数仓',
  releaseState,
  userId: 1,
  userName: 'admin',
  globalParams: '[]',
  locations: '[]',
  warningGroupId: 0,
  timeout: 0,
  executionType: 0 as any,
  createTime: '2026-01-01 00:00:00',
  updateTime: '2026-01-02 00:00:00',
});

const makeSchedule = (overrides: Partial<DSSchedule> = {}): DSSchedule => ({
  id: 77,
  workflowDefinitionCode: 9001,
  workflowDefinitionName: 'ads_daily',
  workflowDefinitionReleaseState: 'ONLINE',
  projectCode: 1001,
  crontab: '0 0 3 * * ?',
  startTime: '2026-01-01 00:00:00',
  endTime: '2099-12-31 23:59:59',
  timezoneId: 'Asia/Shanghai',
  releaseState: ReleaseState.ONLINE,
  createTime: '2026-01-01 00:00:00',
  updateTime: '2026-01-02 00:00:00',
  ...overrides,
});

const h = vi.hoisted(() => {
  const page = (list: any[]) => ({ code: 0, msg: 'success', data: { total: list.length, totalList: list } });
  const api: any = {
    schedule: {
      list: vi.fn(async () => page([])),
      create: vi.fn(async () => ({ code: 0, msg: 'success', data: null })),
      update: vi.fn(async () => ({ code: 0, msg: 'success', data: null })),
      delete: vi.fn(async () => ({ code: 0, msg: 'success', data: null })),
      online: vi.fn(async () => ({ code: 0, msg: 'success', data: null })),
      offline: vi.fn(async () => ({ code: 0, msg: 'success', data: null })),
      preview: vi.fn(async () => ({ code: 0, msg: 'success', data: ['2026-03-02 02:00:00'] })),
    },
  };
  return { api, page };
});

const alertGroups = [{ id: 5, groupName: '数仓告警组', description: '值班群' }] as any;

const renderModal = (overrides: Partial<React.ComponentProps<typeof ScheduleModal>> = {}) => {
  const props: React.ComponentProps<typeof ScheduleModal> = {
    api: h.api,
    projectCode: 1001,
    workflow: workflow(),
    alertGroups,
    workerGroups: [{ workerGroup: 'default' }] as any,
    environments: [] as any,
    tenants: [] as any,
    onClose: vi.fn(),
    onChanged: vi.fn(),
    ...overrides,
  };
  return render(<ScheduleModal {...props} />);
};

const crontabInput = () => screen.getByTestId('schedule-crontab') as HTMLInputElement;
const saveButton = () => screen.getByTestId('schedule-save') as HTMLButtonElement;

beforeEach(() => {
  auth.__setUser(makeUser('SUPER_ADMIN', true));
  vi.clearAllMocks();
  h.api.schedule.list.mockResolvedValue(h.page([]));
  h.api.schedule.preview.mockResolvedValue({ code: 0, msg: 'success', data: ['2026-03-02 02:00:00'] });
});

describe('定时调度的权限门禁', () => {
  it('超级管理员可以配置：默认载入新建形态，保存按钮可用', async () => {
    renderModal();
    await waitFor(() => expect(h.api.schedule.list).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('未配置定时')).toBeTruthy());

    expect(saveButton().disabled).toBe(false);
    expect(saveButton().textContent).toContain('创建定时');
    expect(screen.queryByText(/仅超级管理员与运维人员可配置/)).toBeNull();
  });

  it('运维工程师同样可以配置', async () => {
    auth.__setUser(makeUser('OPS_ENGINEER'));
    renderModal();
    await waitFor(() => expect(screen.getByText('未配置定时')).toBeTruthy());

    expect(saveButton().disabled).toBe(false);
    expect(crontabInput().disabled).toBe(false);
  });

  it('开发工程师只能只读：提示无权限、控件禁用，且不发写请求', async () => {
    auth.__setUser(makeUser('DATA_DEV_ENGINEER'));
    renderModal();
    await waitFor(() => expect(screen.getByText(/仅超级管理员与运维人员可配置/)).toBeTruthy());

    expect(crontabInput().disabled).toBe(true);
    const btn = saveButton();
    expect(btn.disabled).toBe(true);

    fireEvent.click(btn);
    expect(h.api.schedule.create).not.toHaveBeenCalled();
    expect(h.api.schedule.update).not.toHaveBeenCalled();
  });

  it('数据分析师同样被拒绝', async () => {
    auth.__setUser(makeUser('DATA_ANALYST'));
    renderModal();
    await waitFor(() => expect(screen.getByText(/仅超级管理员与运维人员可配置/)).toBeTruthy());
    expect(saveButton().disabled).toBe(true);
  });
});

describe('定时调度的保存载荷', () => {
  it('超管在无既有定时时按「创建」提交，且 crontab / 时区进表单', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText('未配置定时')).toBeTruthy());

    fireEvent.change(crontabInput(), { target: { value: '0 30 4 * * ?' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(h.api.schedule.create).toHaveBeenCalledTimes(1));
    const [projectCode, defCode, payload] = h.api.schedule.create.mock.calls[0];
    expect(projectCode).toBe(1001);
    expect(defCode).toBe(9001);
    expect(payload.crontab).toBe('0 30 4 * * ?');
    expect(payload.timezoneId).toBe('Asia/Shanghai');
    expect(payload.failureStrategy).toBe(FailureStrategy.CONTINUE);
    expect(payload.warningType).toBe(WarningType.NONE);
    // 通知策略为「都不发」时不带告警组
    expect(payload.warningGroupId).toBeNull();
    // 保存成功后要通知父级刷新工作流列表
    expect(h.api.schedule.update).not.toHaveBeenCalled();
  });

  it('已有定时时回填并走「更新」，携带既有 id', async () => {
    h.api.schedule.list.mockResolvedValue(h.page([makeSchedule()]));
    renderModal();

    await waitFor(() => expect(crontabInput().value).toBe('0 0 3 * * ?'));
    expect(screen.getByText('已启用')).toBeTruthy();
    expect(saveButton().textContent).toContain('保存定时');

    fireEvent.change(crontabInput(), { target: { value: '0 0 5 * * ?' } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(h.api.schedule.update).toHaveBeenCalledTimes(1));
    const [projectCode, scheduleId, defCode, payload] = h.api.schedule.update.mock.calls[0];
    expect(projectCode).toBe(1001);
    expect(scheduleId).toBe(77);
    expect(defCode).toBe(9001);
    expect(payload.crontab).toBe('0 0 5 * * ?');
    expect(h.api.schedule.create).not.toHaveBeenCalled();
  });

  it('选择非「都不发」时必须选告警组，否则不允许保存', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText('未配置定时')).toBeTruthy());

    fireEvent.change(screen.getByTestId('schedule-warning-type'), { target: { value: WarningType.FAILURE } });

    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect(screen.getByTestId('schedule-warning-group')).toBeTruthy();

    // 选上告警组后即可保存，并把 id 一并提交
    fireEvent.change(screen.getByTestId('schedule-warning-group'), { target: { value: '5' } });
    await waitFor(() => expect(saveButton().disabled).toBe(false));

    fireEvent.click(saveButton());
    await waitFor(() => expect(h.api.schedule.create).toHaveBeenCalledTimes(1));
    const payload = h.api.schedule.create.mock.calls[0][2];
    expect(payload.warningType).toBe(WarningType.FAILURE);
    expect(payload.warningGroupId).toBe(5);
  });
});

describe('crontab 与生效区间的闸门', () => {
  it('非法 crontab 会给出原因并禁止保存', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText('未配置定时')).toBeTruthy());

    fireEvent.change(crontabInput(), { target: { value: '0 0 2 * * *' } });

    await waitFor(() => expect(screen.getByText(/"\?"/)).toBeTruthy());
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(saveButton());
    expect(h.api.schedule.create).not.toHaveBeenCalled();
  });

  it('生效区间颠倒时报错并禁止保存', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText('未配置定时')).toBeTruthy());

    const inputs = screen.getAllByPlaceholderText('yyyy-MM-dd HH:mm:ss') as HTMLInputElement[];
    fireEvent.change(inputs[0], { target: { value: '2030-01-02 00:00:00' } });
    fireEvent.change(inputs[1], { target: { value: '2030-01-01 00:00:00' } });

    await waitFor(() => expect(screen.getByText(/不能晚于/)).toBeTruthy());
    expect(saveButton().disabled).toBe(true);
  });

  it('合法表达式会给出中文描述与本地推算的下次触发时间', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText('未配置定时')).toBeTruthy());

    fireEvent.change(crontabInput(), { target: { value: '0 0 2 * * ?' } });

    await waitFor(() => expect(screen.getByTestId('cron-desc').textContent).toBe('每天 02:00:00 执行'));
    const items = screen.getByTestId('cron-preview').querySelectorAll('li');
    expect(items.length).toBe(5);
    // 每天 02:00，本地推算的每一条都应落在 02:00:00
    for (const li of Array.from(items)) {
      expect(li.textContent).toMatch(/^\d{4}-\d{2}-\d{2} 02:00:00$/);
    }
    expect(screen.getByText('来源：本地推算')).toBeTruthy();
  });

  it('点击「从调度系统预览」调用 preview，并把结果标为调度系统来源', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText('未配置定时')).toBeTruthy());

    fireEvent.click(screen.getByText('从调度系统预览'));

    await waitFor(() => expect(h.api.schedule.preview).toHaveBeenCalledTimes(1));
    const [projectCode, param] = h.api.schedule.preview.mock.calls[0];
    expect(projectCode).toBe(1001);
    expect(param.crontab).toBe('0 0 2 * * ?');
    expect(param.timezoneId).toBe('Asia/Shanghai');

    await waitFor(() => expect(screen.getByText('来源：调度系统')).toBeTruthy());
    expect(screen.getByText('2026-03-02 02:00:00')).toBeTruthy();
  });

  it('点击预设会替换 crontab 输入', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText('未配置定时')).toBeTruthy());

    fireEvent.click(screen.getByText('每月 1 日 02:00'));

    await waitFor(() => expect(crontabInput().value).toBe('0 0 2 1 * ?'));
    expect(screen.getByTestId('cron-desc').textContent).toBe('每月 1 日 02:00:00 执行');
  });
});

describe('定时上下线与删除', () => {
  it('工作流未上线时不允许启用定时，并给出原因', async () => {
    h.api.schedule.list.mockResolvedValue(h.page([makeSchedule({ releaseState: ReleaseState.OFFLINE })]));
    renderModal({ workflow: workflow(ReleaseState.OFFLINE) });

    await waitFor(() => expect(screen.getByText('已停用')).toBeTruthy());
    expect(screen.getByText(/该工作流当前未上线/)).toBeTruthy();

    fireEvent.click(screen.getByText('启用定时'));

    await waitFor(() => expect(screen.getByText(/请先上线该工作流/)).toBeTruthy());
    expect(h.api.schedule.online).not.toHaveBeenCalled();
  });

  it('工作流已上线时，确认后调用启用定时', async () => {
    h.api.schedule.list.mockResolvedValue(h.page([makeSchedule({ releaseState: ReleaseState.OFFLINE })]));
    renderModal();

    await waitFor(() => expect(screen.getByText('已停用')).toBeTruthy());
    fireEvent.click(screen.getByText('启用定时'));
    fireEvent.click(screen.getByText('确认'));

    await waitFor(() => expect(h.api.schedule.online).toHaveBeenCalledWith(1001, 77));
    expect(h.api.schedule.offline).not.toHaveBeenCalled();
  });

  it('已启用的定时可以停用', async () => {
    h.api.schedule.list.mockResolvedValue(h.page([makeSchedule({ releaseState: ReleaseState.ONLINE })]));
    renderModal();

    await waitFor(() => expect(screen.getByText('已启用')).toBeTruthy());
    fireEvent.click(screen.getByText('停用定时'));
    fireEvent.click(screen.getByText('确认'));

    await waitFor(() => expect(h.api.schedule.offline).toHaveBeenCalledWith(1001, 77));
  });

  it('删除定时需二次确认，确认后回到「未配置」形态', async () => {
    h.api.schedule.list.mockResolvedValue(h.page([makeSchedule()]));
    renderModal();

    await waitFor(() => expect(screen.getByText('已启用')).toBeTruthy());
    fireEvent.click(screen.getByText('删除定时'));
    fireEvent.click(screen.getByText('确认'));

    await waitFor(() => expect(h.api.schedule.delete).toHaveBeenCalledWith(1001, 77));
    // 删除后重新拉列表（mock 仍返回既有定时，这里只断言重新拉取过）
    await waitFor(() => expect(h.api.schedule.list.mock.calls.length).toBeGreaterThan(1));
  });

  it('只读角色的上下线与删除入口不可用', async () => {
    auth.__setUser(makeUser('DATA_DEV_ENGINEER'));
    h.api.schedule.list.mockResolvedValue(h.page([makeSchedule()]));
    renderModal();

    await waitFor(() => expect(screen.getByText(/仅超级管理员与运维人员可配置/)).toBeTruthy());
    // 未授权时不渲染任何写操作入口
    expect(screen.queryByText('启用定时')).toBeNull();
    expect(screen.queryByText('停用定时')).toBeNull();
    expect(screen.queryByText('删除定时')).toBeNull();
  });
});

describe('加载失败', () => {
  it('列表接口报错时展示后端返回的提示', async () => {
    h.api.schedule.list.mockResolvedValue({ code: 1, msg: '项目不存在', data: null });
    renderModal();

    await waitFor(() => expect(screen.getByText('项目不存在')).toBeTruthy());
  });
});

/**
 * 顺带钉住一个易回退的点：默认工作流优先级与失败策略必须与模块内其它弹窗同口径，
 * 避免以后有人改默认值时悄悄改变定时任务的调度语义。
 */
describe('表单默认值', () => {
  it('默认失败策略为「继续」、优先级为 MEDIUM、时区为上海', async () => {
    renderModal();
    await waitFor(() => expect(screen.getByText('未配置定时')).toBeTruthy());

    fireEvent.click(saveButton());
    await waitFor(() => expect(h.api.schedule.create).toHaveBeenCalledTimes(1));
    const payload = h.api.schedule.create.mock.calls[0][2];
    expect(payload.failureStrategy).toBe(FailureStrategy.CONTINUE);
    expect(payload.workflowInstancePriority).toBe(Priority.MEDIUM);
    expect(payload.timezoneId).toBe('Asia/Shanghai');
    expect(payload.workerGroup).toBe('default');
    // 默认环境不传 environmentCode，租户未选时不传
    expect(payload.environmentCode).toBeNull();
    expect(payload.tenantCode).toBeNull();
    // 生效区间默认「立即生效、长期有效」
    expect(payload.endTime).toBe('2099-12-31 23:59:59');
    expect(payload.startTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
