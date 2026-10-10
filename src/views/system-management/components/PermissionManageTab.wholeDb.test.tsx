import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import PermissionManageTab from './PermissionManageTab';
import { ToastProvider } from '../../../components/Toast';

/**
 * 库表授权「整库」交互测试。
 *
 * 背景：后端 `sys_table_permission.table_names` 存 `*` 即代表「该库全部表」，
 * 匹配语义在 `DataAccessPermissionService.matchesTablePermission`。
 * 这里只验证前端有没有把这条路径接对：
 *   ① 勾「全部表（整库授权）」后提交，落库的 tableNames 就是 `['*']`；
 *   ② 切到需要逐表配置的权限范围时，整库开关被禁用且选择被清空（`*` 配不出列/行规则）；
 *   ③ 列表把 `*` 显示成「全部表」而不是一个 `*` 标签；
 *   ④ 编辑已有整库记录时正确回显勾选态（不被按表名反查的逻辑清空）。
 */

const h = vi.hoisted(() => {
  const tableRows = [
    {
      id: 1,
      permissionName: 'test_db读写权限',
      datasourceName: 'test_datasource',
      databaseName: 'test_db',
      tableNames: ['*'],
      permissionScope: 1,
      canSelect: 1,
      canInsert: 1,
      canUpdate: 1,
      canDelete: 1,
      canExport: 1,
      description: 'test用户对test_db的全部表读写权限',
      roleIds: [3],
      roleNames: ['数据开发'],
    },
  ];
  return { tableRows };
});

vi.mock('../../../api/systemPermission', () => ({
  systemPermissionApi: {
    getMenuTree: vi.fn(async () => ({ code: 200, data: [] })),
    getBinds: vi.fn(async () => ({ code: 200, data: [] })),
    getFilePermissionList: vi.fn(async () => ({ code: 200, data: { records: [], total: 0 } })),
    getTablePermissionList: vi.fn(async () => ({
      code: 200,
      data: { records: h.tableRows, total: h.tableRows.length },
    })),
    saveTablePermission: vi.fn(async () => ({ code: 200, data: {} })),
    updateTablePermission: vi.fn(async () => ({ code: 200, data: {} })),
    deleteTablePermission: vi.fn(async () => ({ code: 200, data: null })),
  },
}));

vi.mock('../../../api/systemProjectPermission', () => ({
  projectPermissionApi: {
    getByRoleId: vi.fn(async () => ({ code: 200, data: [] })),
    getByProjectId: vi.fn(async () => ({ code: 200, data: [] })),
  },
  PROJECT_PERM_TYPE_MAP: { 1: '读取', 2: '编辑', 3: '删除' },
  PROJECT_PERM_TYPE_TAG_MAP: { 1: 'info', 2: 'warning', 3: 'danger' },
}));

vi.mock('../../../api/systemRole', () => ({
  systemRoleApi: {
    getAllRoles: vi.fn(async () => ({
      code: 200,
      data: [{ id: 3, roleName: '数据开发', roleCode: 'ROLE_DEV' }],
    })),
  },
}));

vi.mock('../../../api/datasource', () => ({
  fetchAllDataSources: vi.fn(async () => ({
    code: 200,
    data: [{ id: 1, datasourceName: 'test_datasource' }],
  })),
  fetchTablesByDataSourceId: vi.fn(async () => ({
    code: 200,
    data: {
      records: [
        { id: 11, tableName: 'ods_user', databaseName: 'test_db', tableType: 'TABLE', storageEngine: 'POSTGRESQL' },
        { id: 12, tableName: 'ods_order', databaseName: 'test_db', tableType: 'TABLE', storageEngine: 'POSTGRESQL' },
      ],
      total: 2,
    },
  })),
  fetchTableColumns: vi.fn(async () => ({ code: 200, data: [] })),
}));

vi.mock('../../../api/fileExplorer', () => ({
  fileExplorerApi: {
    getAllStorages: vi.fn(async () => ({ code: 200, data: [] })),
    getStorageTypeOptions: vi.fn(async () => ({ code: 200, data: [] })),
  },
}));

vi.mock('../../../api/devProject', () => ({
  fetchProjectList: vi.fn(async () => ({ code: 200, data: { records: [], total: 0 } })),
}));

import { systemPermissionApi } from '../../../api/systemPermission';

/** 打开「库表权限」页签。 */
async function openTableTab() {
  render(
    <ToastProvider>
      <PermissionManageTab />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /库表权限/ }));
  await screen.findByText('test_db读写权限');
}

/** 打开新增弹窗并把数据源 / 数据库 / 权限名称填好（此时授权范围默认「整表」）。 */
async function openAddModalFilled() {
  fireEvent.click(screen.getByRole('button', { name: /新增/ }));
  await screen.findByText('新增库表权限');

  fireEvent.change(screen.getByPlaceholderText('如：订单表只读权限'), {
    target: { value: '整库只读权限' },
  });

  const findSelect = (keyword: string) =>
    Array.from(document.querySelectorAll('select')).find(s => s.textContent?.includes(keyword)) as HTMLSelectElement;

  fireEvent.change(findSelect('请选择数据源'), { target: { value: '1' } });
  await waitFor(() => expect(findSelect('test_db')).toBeTruthy());
  fireEvent.change(findSelect('test_db'), { target: { value: 'test_db' } });
}

/** 「全部表（整库授权）」勾选框 —— label 包着 input，按文案取最近的 label 再取 input。 */
function wholeDbCheckbox(): HTMLInputElement {
  const label = screen.getByText(/全部表（整库授权）/).closest('label') as HTMLLabelElement;
  return label.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

/** 权限范围单选（1 整表 / 2 指定字段 / 3 指定行 / 4 组合）。 */
function scopeRadio(label: string): HTMLInputElement {
  // 列表行里也会渲染「整表」等范围文案，所以按 radio 的 name 收敛范围再比对 label 文本
  const radios = Array.from(
    document.querySelectorAll('input[name="tablePermScope"]'),
  ) as HTMLInputElement[];
  const found = radios.find(r => r.closest('label')?.textContent?.trim() === label);
  if (!found) throw new Error(`未找到权限范围「${label}」`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('库表授权 — 整库授权', () => {
  it('勾选「全部表（整库授权）」后提交，tableNames 落库为 ["*"]', async () => {
    await openTableTab();
    await openAddModalFilled();

    const checkbox = wholeDbCheckbox();
    expect(checkbox.disabled).toBe(false);
    fireEvent.click(checkbox);

    // 逐表选择器被接管，改为展示整库占位文案
    expect(screen.getByText('已选择全部表（整库）')).toBeTruthy();
    expect(screen.getByText('已授权该库全部表，无需逐张勾选。')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '确定' }));

    await waitFor(() => expect(systemPermissionApi.saveTablePermission).toHaveBeenCalledTimes(1));
    const dto = vi.mocked(systemPermissionApi.saveTablePermission).mock.calls[0][0];
    expect(dto.tableNames).toEqual(['*']);
    expect(dto.permissionScope).toBe(1);
    expect(dto.databaseName).toBe('test_db');
  });

  it('切到「指定字段」时禁用整库开关并清空选择，提交被拦下', async () => {
    await openTableTab();
    await openAddModalFilled();

    fireEvent.click(wholeDbCheckbox());
    expect(wholeDbCheckbox().checked).toBe(true);

    fireEvent.click(scopeRadio('指定字段'));

    await waitFor(() => {
      expect(wholeDbCheckbox().checked).toBe(false);
      expect(wholeDbCheckbox().disabled).toBe(true);
    });
    expect(screen.getByText(/需逐张选择库表/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '确定' }));

    // 选择已被清空 → 校验拦下，不会发出保存请求
    expect(systemPermissionApi.saveTablePermission).not.toHaveBeenCalled();
    // 逐表选择器的 placeholder 也叫「请选择库表」，所以按 toast 容器断言提示文案
    await waitFor(() => {
      expect(document.querySelector('.toast__message')?.textContent).toBe('请选择库表');
    });
  });

  it('切回「整表」后整库开关恢复可用', async () => {
    await openTableTab();
    await openAddModalFilled();

    fireEvent.click(scopeRadio('指定字段'));
    await waitFor(() => expect(wholeDbCheckbox().disabled).toBe(true));

    fireEvent.click(scopeRadio('整表'));
    await waitFor(() => expect(wholeDbCheckbox().disabled).toBe(false));
  });

  it('列表把整库记录显示成「全部表」标签，而不是一个 * 标签', async () => {
    await openTableTab();

    expect(screen.getByText('全部表')).toBeTruthy();
    expect(screen.queryByText('*')).toBeNull();
  });

  it('编辑整库记录时回显为已勾选，不被按表名反查的逻辑清空', async () => {
    await openTableTab();

    fireEvent.click(screen.getByRole('button', { name: /编辑/ }));
    await screen.findByText('编辑库表权限');

    await waitFor(() => expect(wholeDbCheckbox().checked).toBe(true));
    expect(wholeDbCheckbox().disabled).toBe(false);
    expect(screen.getByText('已选择全部表（整库）')).toBeTruthy();
  });
});
