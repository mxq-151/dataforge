import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WorkflowDefinitionEditor from './WorkflowDefinitionEditor';
import { ToastProvider } from '../../../components/Toast';
import { Priority, type DSWorkflowTaskNode } from '../../../types/dolphinscheduler';

/**
 * 「保存工作流」前的任务节点参数校验闸门 + 工具栏「校验」按钮（接线级测试）。
 *
 * 需求：保存工作流前先校验全部任务节点参数，有任一不通过就不允许保存；
 * 工具栏需提供常驻的「校验」入口，可主动校验并查看结果。
 * 这里钉住编辑器上的四处接线：
 * 1. 点「保存」→ 先校验，不通过只弹校验报告，**保存弹窗不出现、onSave 不被调用**；
 * 2. 校验通过 → 正常弹保存弹窗，确认后 onSave 拿到全部节点；
 * 3. 工具栏「校验」按钮 → 通过给轻提示，不通过打开报告（带失败任务数徽标）；
 * 4. 只读模式下不渲染保存按钮与校验按钮。
 *
 * 画布被替换为桩组件：编辑器内部是 @antv/x6 画布（`new Graph()` 需要 SVG 的
 * getCTM，jsdom 下直接抛错，全仓无任何测试渲染 x6）。桩掉画布后 graphRef 恒为 null，
 * 编辑器回退到 existingNodes 派生的 nodes state —— 正是保存闸门读取的数据源。
 */
vi.mock('../dag/DagCanvas', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="dag-canvas">{children}</div>
  ),
}));

const node = (overrides: Partial<DSWorkflowTaskNode> & { name: string }): DSWorkflowTaskNode => ({
  code: 1,
  taskType: 'SHELL',
  description: '',
  taskParams: JSON.stringify({ rawScript: 'echo hi', localParams: [] }),
  flag: 'YES',
  taskPriority: Priority.MEDIUM,
  workerGroup: 'default',
  environmentCode: -1,
  failRetryTimes: 0,
  failRetryInterval: 1,
  timeoutFlag: 'CLOSE',
  timeout: 0,
  delayTime: 0,
  x: 0,
  y: 0,
  ...overrides,
});

// 编辑器内部用到 useToast，必须包在 ToastProvider 里
const renderEditor = (nodes: DSWorkflowTaskNode[], onSave = vi.fn()) => {
  render(
    <ToastProvider>
      <WorkflowDefinitionEditor
        workflowName="demo_wf"
        description=""
        existingNodes={nodes}
        existingEdges={[]}
        onSave={onSave}
        onClose={() => {}}
      />
    </ToastProvider>
  );
  return onSave;
};

const validateButton = () => screen.getByTestId('wf-toolbar-validate');

describe('WorkflowDefinitionEditor - 保存前参数校验闸门', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('校验不通过时点击保存：只弹校验报告，保存弹窗不出现且 onSave 不被调用', () => {
    const onSave = renderEditor([
      node({ code: 11, name: 'ods_order', taskType: 'SQL', taskParams: JSON.stringify({ sql: '', localParams: [] }) }),
    ]);

    fireEvent.click(screen.getByText('保存'));

    expect(screen.getByText('任务参数校验未通过')).toBeTruthy();
    expect(screen.getByText('ods_order')).toBeTruthy();
    expect(screen.getByText('请填写SQL语句')).toBeTruthy();
    // 保存弹窗（含「确认保存」）没有被打开，提交更没有发生
    expect(screen.queryByText('保存工作流')).toBeNull();
    expect(screen.queryByText('确认保存')).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('校验通过时正常打开保存弹窗，确认后 onSave 拿到全部节点', () => {
    const onSave = renderEditor([
      node({ code: 11, name: 'a_shell', taskParams: JSON.stringify({ rawScript: 'echo 1', localParams: [] }) }),
      node({ code: 12, name: 'b_sql', taskType: 'SQL', taskParams: JSON.stringify({ sql: 'select 1', localParams: [] }) }),
    ]);

    fireEvent.click(screen.getByText('保存'));

    expect(screen.queryByText('任务参数校验未通过')).toBeNull();
    expect(screen.getByText('保存工作流')).toBeTruthy();

    fireEvent.click(screen.getByText('确认保存'));
    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0][0];
    expect(payload.name).toBe('demo_wf');
    expect(payload.nodes.map((n: DSWorkflowTaskNode) => n.name)).toEqual(['a_shell', 'b_sql']);
  });

  it('工具栏常驻「校验」按钮，全部通过时点击给出通过提示、不弹报告', () => {
    renderEditor([
      node({ code: 11, name: 'a_shell', taskParams: JSON.stringify({ rawScript: 'echo', localParams: [] }) }),
      node({ code: 12, name: 'b_sql', taskType: 'SQL', taskParams: JSON.stringify({ sql: 'select 1', localParams: [] }) }),
    ]);

    const btn = validateButton();
    expect(btn.textContent).toContain('校验');
    expect(btn.className).not.toContain('wf-toolbar__validate--warn');

    fireEvent.click(btn);

    expect(screen.getByText('校验通过：2 个任务节点参数完整')).toBeTruthy();
    expect(screen.queryByText('任务参数校验未通过')).toBeNull();
  });

  it('存在待完善任务时「校验」按钮转为警示态并带数量徽标，点击打开报告', () => {
    renderEditor([
      node({ code: 11, name: 'bad_sql', taskType: 'SQL', taskParams: JSON.stringify({ sql: '', localParams: [] }) }),
      node({ code: 12, name: 'ok_shell', taskParams: JSON.stringify({ rawScript: 'echo', localParams: [] }) }),
    ]);

    const btn = validateButton();
    expect(btn.className).toContain('wf-toolbar__validate--warn');
    expect(btn.textContent).toContain('校验');
    expect(btn.textContent).toContain('1'); // 徽标显示失败任务数

    fireEvent.click(btn);
    expect(screen.getByText('任务参数校验未通过')).toBeTruthy();
    // 只列失败节点
    expect(screen.getByText('bad_sql')).toBeTruthy();
    expect(screen.queryByText('ok_shell')).toBeNull();
  });

  it('校验报告里的「定位」按钮可点击且不抛错（画布被桩掉时为空操作）', () => {
    renderEditor([
      node({ code: 11, name: 'bad_sql', taskType: 'SQL', taskParams: JSON.stringify({ sql: '', localParams: [] }) }),
    ]);

    fireEvent.click(screen.getByText('保存'));
    fireEvent.click(screen.getByText('定位'));

    // 定位后报告关闭
    expect(screen.queryByText('任务参数校验未通过')).toBeNull();
  });

  it('只读模式下不渲染保存按钮与校验按钮', () => {
    render(
      <ToastProvider>
        <WorkflowDefinitionEditor
          workflowName="demo_wf"
          description=""
          existingNodes={[node({ code: 11, name: 'bad_sql', taskType: 'SQL', taskParams: JSON.stringify({ sql: '', localParams: [] }) })]}
          existingEdges={[]}
          readonly
          onSave={vi.fn()}
          onClose={() => {}}
        />
      </ToastProvider>
    );
    expect(screen.queryByText('保存')).toBeNull();
    expect(screen.queryByTestId('wf-toolbar-validate')).toBeNull();
  });

  it('默认在工具栏左侧显示返回按钮与工作流名称', () => {
    renderEditor([node({ code: 11, name: 'a_shell' })]);

    expect(screen.getByTitle('返回')).toBeTruthy();
    expect(screen.getByText('demo_wf')).toBeTruthy();
  });

  it('hideToolbarHeader：去掉返回按钮与工作流名称（外层弹窗已展示名称），其余工具栏不受影响', () => {
    render(
      <ToastProvider>
        <WorkflowDefinitionEditor
          workflowName="demo_wf"
          description=""
          existingNodes={[node({ code: 11, name: 'a_shell' })]}
          existingEdges={[]}
          hideToolbarHeader
          onSave={vi.fn()}
          onClose={() => {}}
        />
      </ToastProvider>
    );

    expect(screen.queryByTitle('返回')).toBeNull();
    expect(screen.queryByText('demo_wf')).toBeNull();
    // 左侧占位仍在（保持 space-between 三段布局），缩放/校验/保存照常
    expect(screen.getByTestId('wf-toolbar-left')).toBeTruthy();
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.getByTestId('wf-toolbar-validate')).toBeTruthy();
    expect(screen.getByText('保存')).toBeTruthy();
  });

  it('hideToolbarValidate：不渲染工具栏「校验」按钮，但保存前的参数校验闸门仍然生效', () => {
    const onSave = vi.fn();
    render(
      <ToastProvider>
        <WorkflowDefinitionEditor
          workflowName="demo_wf"
          description=""
          existingNodes={[
            node({ code: 11, name: 'bad_sql', taskType: 'SQL', taskParams: JSON.stringify({ sql: '', localParams: [] }) }),
          ]}
          existingEdges={[]}
          hideToolbarValidate
          onSave={onSave}
          onClose={() => {}}
        />
      </ToastProvider>
    );

    // 按钮没了，保存仍在
    expect(screen.queryByTestId('wf-toolbar-validate')).toBeNull();
    expect(screen.queryByText('校验')).toBeNull();
    expect(screen.getByText('保存')).toBeTruthy();

    // 去掉的只是手动入口：点保存仍会被闸门拦下，onSave 不被调用
    fireEvent.click(screen.getByText('保存'));
    expect(screen.getByText('任务参数校验未通过')).toBeTruthy();
    expect(screen.queryByText('保存工作流')).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });
});
