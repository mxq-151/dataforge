import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkflowValidationModal } from './WorkflowDefinitionEditor';
import type { WorkflowNodeValidationResult } from '../../../utils/workflowNodeValidation';

/**
 * 「保存工作流」前的任务参数校验报告弹窗。
 *
 * 保存被拦下后用它告诉用户「哪些任务的哪些参数需要修正」，并提供跳回画布定位节点。
 * 这里钉住三件事：失败任务与错误明细要完整展示、定位按钮回传正确的节点 code、
 * 关闭入口（知道了 / 遮罩 / 内容区不误关）。
 *
 * 只单独渲染这个弹窗：编辑器整体依赖 @antv/x6 画布，jsdom 下不可渲染，无法覆盖。
 */

const result: WorkflowNodeValidationResult = {
  ok: false,
  issues: [
    { taskCode: 101, taskName: 'ods_order', taskType: 'SQL', field: 'sql', message: '请填写SQL语句' },
    { taskCode: 202, taskName: 'demo_k8s', taskType: 'K8S', field: 'namespace', message: '请填写命名空间' },
    { taskCode: 202, taskName: 'demo_k8s', taskType: 'K8S', field: 'image', message: '请填写镜像地址' },
  ],
  failedNodes: [
    { taskCode: 101, taskName: 'ods_order', taskType: 'SQL', taskTypeLabel: 'SQL', messages: ['请填写SQL语句'] },
    {
      taskCode: 202,
      taskName: 'demo_k8s',
      taskType: 'K8S',
      taskTypeLabel: 'Kubernetes',
      messages: ['请填写命名空间', '请填写镜像地址'],
    },
  ],
};

describe('WorkflowValidationModal', () => {
  it('展示失败任务、任务类型与逐条错误提示', () => {
    render(<WorkflowValidationModal result={result} onLocate={() => {}} onClose={() => {}} />);

    expect(screen.getByText('任务参数校验未通过')).toBeTruthy();
    // 概览：2 个任务、3 项参数
    expect(screen.getByText(/共 2 个任务、3 项参数需要修正/)).toBeTruthy();

    expect(screen.getByText('ods_order')).toBeTruthy();
    expect(screen.getByText('demo_k8s')).toBeTruthy();
    expect(screen.getAllByText('SQL')).toHaveLength(1);
    expect(screen.getByText('Kubernetes')).toBeTruthy();

    expect(screen.getByText('请填写SQL语句')).toBeTruthy();
    expect(screen.getByText('请填写命名空间')).toBeTruthy();
    expect(screen.getByText('请填写镜像地址')).toBeTruthy();
  });

  it('点击「定位」回传对应任务的 code', () => {
    const onLocate = vi.fn();
    render(<WorkflowValidationModal result={result} onLocate={onLocate} onClose={() => {}} />);

    const locateButtons = screen.getAllByText('定位');
    expect(locateButtons).toHaveLength(2);

    fireEvent.click(locateButtons[0]);
    expect(onLocate).toHaveBeenCalledWith(101);
    fireEvent.click(locateButtons[1]);
    expect(onLocate).toHaveBeenCalledWith(202);
  });

  it('「知道了」与遮罩点击关闭，点击弹窗内容不关闭', () => {
    const onClose = vi.fn();
    const { container } = render(<WorkflowValidationModal result={result} onLocate={() => {}} onClose={onClose} />);

    fireEvent.click(screen.getByText('任务参数校验未通过'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('知道了'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(container.querySelector('.sm-modal-overlay')!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('没有「忽略并保存」这类放行入口', () => {
    render(<WorkflowValidationModal result={result} onLocate={() => {}} onClose={() => {}} />);
    expect(screen.queryByText(/忽略/)).toBeNull();
    expect(screen.queryByText(/仍然保存/)).toBeNull();
  });
});
