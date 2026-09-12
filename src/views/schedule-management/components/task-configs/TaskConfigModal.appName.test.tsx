import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TaskConfigModal from './TaskConfigModal';
import type { DSWorkflowTaskNode } from '../../../../types/dolphinscheduler';

/**
 * 任务配置弹窗里「应用名称」的自动填充。
 *
 * 需求：提交入口（单文件 / 文件夹提交调度）打开任务节点时，应用名称只读，值恒为
 * `{项目}.{工作流}.{任务}`，随「任务名称」实时变化；调度管理不传上下文时保持原样可编辑。
 */

const sparkNode = (over: Partial<DSWorkflowTaskNode> = {}): DSWorkflowTaskNode => ({
  code: 1,
  name: 'ods_ecom_customer',
  taskType: 'SPARK',
  description: '',
  taskParams: JSON.stringify({
    programType: 'SCALA',
    mainClass: 'com.demo.Ods',
    mainJar: '',
    rawScript: 'object Ods {}',
    appName: '从代码推导的旧值',
    localParams: [],
    resourceList: [],
  }),
  flag: 'YES',
  taskPriority: 'MEDIUM' as DSWorkflowTaskNode['taskPriority'],
  workerGroup: 'default',
  environmentCode: -1,
  failRetryTimes: 0,
  failRetryInterval: 1,
  timeoutFlag: 'CLOSE',
  timeout: 0,
  delayTime: 0,
  x: 0,
  y: 0,
  ...over,
});

const ctx = { project: 'demo', workflow: 'demo_test' };

const renderModal = (props: Partial<React.ComponentProps<typeof TaskConfigModal>> = {}) => {
  const onSave = vi.fn();
  const task = props.task ?? sparkNode();
  const utils = render(
    <TaskConfigModal
      task={task}
      allNodes={[task]}
      edges={[]}
      onSave={onSave}
      onClose={vi.fn()}
      {...props}
    />
  );
  return { ...utils, onSave };
};

const taskNameInput = () => screen.getByPlaceholderText('请输入任务名称') as HTMLInputElement;
const appNameInput = () => screen.getByTestId('task-app-name') as HTMLInputElement;

describe('TaskConfigModal — 应用名称按 {project}.{workflow}.{task} 自动生成', () => {
  it('传了上下文：应用名称只读，值为 项目.工作流.任务', () => {
    renderModal({ appNameContext: ctx });

    const input = appNameInput();
    expect(input.value).toBe('demo.demo_test.ods_ecom_customer');
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(true);
    // 覆盖掉从代码推导的旧值，且给出说明
    expect(document.body.textContent).toContain('由「项目.工作流.任务」自动生成');
  });

  it('「不允许手改」：改名后应用名称跟着变（而不是保留用户输入）', () => {
    renderModal({ appNameContext: ctx });

    fireEvent.change(taskNameInput(), { target: { value: 'ods_orders' } });
    expect(taskNameInput().value).toBe('ods_orders');
    expect(appNameInput().value).toBe('demo.demo_test.ods_orders');
  });

  it('确认保存：写入 taskParams 的应用名称与展示值一致', () => {
    const { onSave } = renderModal({ appNameContext: ctx });

    fireEvent.change(taskNameInput(), { target: { value: 'ods_orders' } });
    fireEvent.click(screen.getByText('确认'));

    expect(onSave).toHaveBeenCalledTimes(1);
    const [saved] = onSave.mock.calls[0];
    const params = JSON.parse(saved.taskParams);
    expect(saved.name).toBe('ods_orders');
    expect(params.appName).toBe('demo.demo_test.ods_orders');
    // 其他参数不受影响
    expect(params.mainClass).toBe('com.demo.Ods');
  });

  it('没有「应用名称」项的任务类型不受影响（SQL 节点不写入 appName）', () => {
    const sql = sparkNode({
      taskType: 'SQL',
      taskParams: JSON.stringify({
        sql: 'select 1', type: 'MYSQL', sqlType: '0', displayRows: 10, connParams: '',
        preStatements: [], postStatements: [], localParams: [], resourceList: [],
      }),
    });
    const { onSave } = renderModal({ task: sql, allNodes: [sql], appNameContext: ctx });

    expect(screen.queryByTestId('task-app-name')).toBeNull();
    fireEvent.click(screen.getByText('确认'));
    const [saved] = onSave.mock.calls[0];
    expect(JSON.parse(saved.taskParams).appName).toBeUndefined();
  });

  it('不传上下文（调度管理入口）：应用名称保持可编辑、沿用历史值', () => {
    const { onSave } = renderModal();

    expect(screen.queryByTestId('task-app-name')).toBeNull();
    const editable = screen.getByDisplayValue('从代码推导的旧值') as HTMLInputElement;
    expect(editable.readOnly).toBe(false);

    fireEvent.change(editable, { target: { value: '手工改的名字' } });
    fireEvent.click(screen.getByText('确认'));

    const [saved] = onSave.mock.calls[0];
    expect(JSON.parse(saved.taskParams).appName).toBe('手工改的名字');
  });
});
