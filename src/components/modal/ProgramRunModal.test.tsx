import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ProgramRunModal } from './ProgramRunModal';

/**
 * 「运行程序」参数确认框（键值对形式）的单测。
 *
 * 钉住四件事：
 *  1. 打开时用「配置参数 → 配置程序参数」的值逐行预填，可增删改；
 *  2. 「确定」回传的是**当前行里的内容**（所见即所发），不是已保存的旧值；
 *  3. 会被丢弃 / 被覆盖的两种情况必须显式提示（缺参数名、参数名重复）；
 *  4. 代码头 @程序参数 与 SQL 正文识别到的参数名并成空白行预填，并提示识别来源。
 */
const setup = (props: Partial<React.ComponentProps<typeof ProgramRunModal>> = {}) => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <ProgramRunModal
      open
      defaultParams={[{ id: 'p1', key: 'env', value: 'prod' }]}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel, ...utils };
};

/** 把 onConfirm 收到的行压成 [key, value] 便于断言（忽略行 id） */
const confirmPairs = (onConfirm: ReturnType<typeof vi.fn>) =>
  (onConfirm.mock.calls[0][0] as { key: string; value: string }[]).map(r => [r.key, r.value]);

describe('ProgramRunModal', () => {
  it('open=false 时不渲染', () => {
    const { queryByTestId } = setup({ open: false });
    expect(queryByTestId('program-run-add')).toBeNull();
    expect(queryByTestId('program-run-key-0')).toBeNull();
  });

  it('打开时把已保存的参数逐行预填成键值对', () => {
    const { getByTestId } = setup({
      defaultParams: [
        { id: 'p1', key: 'env', value: 'prod' },
        { id: 'p2', key: 'date', value: '2026-09-12' },
      ],
    });
    expect((getByTestId('program-run-key-0') as HTMLInputElement).value).toBe('env');
    expect((getByTestId('program-run-value-0') as HTMLInputElement).value).toBe('prod');
    expect((getByTestId('program-run-key-1') as HTMLInputElement).value).toBe('date');
    expect((getByTestId('program-run-value-1') as HTMLInputElement).value).toBe('2026-09-12');
  });

  it('没有已保存参数时给一行空白，用户可直接填', () => {
    const { getByTestId } = setup({ defaultParams: [] });
    expect((getByTestId('program-run-key-0') as HTMLInputElement).value).toBe('');
    expect(getByTestId('program-run-status').textContent).toContain('未填写程序参数');
  });

  it('「添加参数」追加一行空白', () => {
    const { getByTestId } = setup();
    fireEvent.click(getByTestId('program-run-add'));
    expect((getByTestId('program-run-key-1') as HTMLInputElement).value).toBe('');
    // 新增行不覆盖已有行
    expect((getByTestId('program-run-key-0') as HTMLInputElement).value).toBe('env');
  });

  it('删除按钮移除对应行；全部删完显示空态', () => {
    const { getByTestId, queryByTestId } = setup({
      defaultParams: [
        { id: 'p1', key: 'env', value: 'prod' },
        { id: 'p2', key: 'date', value: '2026-09-12' },
      ],
    });
    fireEvent.click(getByTestId('program-run-remove-0'));
    expect((getByTestId('program-run-key-0') as HTMLInputElement).value).toBe('date');

    fireEvent.click(getByTestId('program-run-remove-0'));
    expect(queryByTestId('program-run-key-0')).toBeNull();
    expect(queryByTestId('program-run-warning')).toBeNull();
  });

  it('点「确定」回传当前行内容（含用户的改、增、删）', () => {
    const { getByTestId, onConfirm } = setup();
    fireEvent.change(getByTestId('program-run-value-0'), { target: { value: 'gray' } });
    fireEvent.click(getByTestId('program-run-add'));
    fireEvent.change(getByTestId('program-run-key-1'), { target: { value: 'dry-run' } });

    fireEvent.click(getByTestId('program-run-confirm'));
    expect(confirmPairs(onConfirm)).toEqual([['env', 'gray'], ['dry-run', '']]);
  });

  it('删光所有行后点「确定」→ 回传空数组（视为不带程序参数）', () => {
    const { getByTestId, onConfirm } = setup();
    fireEvent.click(getByTestId('program-run-remove-0'));
    fireEvent.click(getByTestId('program-run-confirm'));
    expect(onConfirm).toHaveBeenCalledWith([]);
  });

  it('只填值没填参数名的行会被提示忽略，且不计入下发数量', () => {
    const { getByTestId } = setup({ defaultParams: [{ id: 'p1', key: '', value: 'orphan' }] });
    const warning = getByTestId('program-run-warning');
    expect(warning.textContent).toContain('第 1 行未填参数名');
    expect(warning.textContent).toContain('将被忽略');
    expect(getByTestId('program-run-status').textContent).toContain('未填写程序参数');
  });

  it('参数名重复时提示「后出现的取值生效」，数量按去重后计', () => {
    const { getByTestId } = setup({
      defaultParams: [
        { id: 'p1', key: 'env', value: 'prod' },
        { id: 'p2', key: 'env', value: 'gray' },
      ],
    });
    const warning = getByTestId('program-run-warning');
    expect(warning.textContent).toContain('参数名重复：env');
    expect(warning.textContent).toContain('后出现的取值生效');
    expect(getByTestId('program-run-status').textContent).toContain('将下发 1 个程序参数');
  });

  it('合法参数显示下发数量，无告警', () => {
    const { getByTestId, queryByTestId } = setup({
      defaultParams: [
        { id: 'p1', key: 'env', value: 'prod' },
        { id: 'p2', key: 'dry-run', value: 'true' },
      ],
    });
    expect(getByTestId('program-run-status').textContent).toContain('将下发 2 个程序参数');
    expect(queryByTestId('program-run-warning')).toBeNull();
  });

  it('点「取消」与关闭按钮都只回调 onCancel', () => {
    const cancelByButton = setup();
    fireEvent.click(cancelByButton.getByTestId('program-run-cancel'));
    expect(cancelByButton.onCancel).toHaveBeenCalledTimes(1);
    expect(cancelByButton.onConfirm).not.toHaveBeenCalled();
    cancelByButton.unmount();

    const cancelByClose = setup();
    fireEvent.mouseDown(cancelByClose.getByTestId('program-run-close'));
    expect(cancelByClose.onCancel).toHaveBeenCalledTimes(1);
  });

  it('输入框内 Enter 确定、Escape 取消', () => {
    const enter = setup();
    fireEvent.keyDown(enter.getByTestId('program-run-value-0'), { key: 'Enter' });
    expect(confirmPairs(enter.onConfirm)).toEqual([['env', 'prod']]);
    enter.unmount();

    const escape = setup();
    fireEvent.keyDown(escape.getByTestId('program-run-key-0'), { key: 'Escape' });
    expect(escape.onCancel).toHaveBeenCalledTimes(1);
    expect(escape.onConfirm).not.toHaveBeenCalled();
  });

  it('重新打开时复位为预填值，不残留上次输入', () => {
    const { getByTestId, rerender } = setup();
    fireEvent.change(getByTestId('program-run-key-0'), { target: { value: 'changed' } });
    fireEvent.click(getByTestId('program-run-add'));
    expect((getByTestId('program-run-key-0') as HTMLInputElement).value).toBe('changed');

    const defaultParams = [{ id: 'p1', key: 'env', value: 'prod' }];
    rerender(<ProgramRunModal open={false} defaultParams={defaultParams} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    rerender(<ProgramRunModal open defaultParams={defaultParams} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect((getByTestId('program-run-key-0') as HTMLInputElement).value).toBe('env');
    // 上次新增的行不应残留
    expect(() => getByTestId('program-run-key-1')).toThrow();
  });

  it('从代码识别到的参数名并成空白行预填（已保存参数在前、取值留空）', () => {
    const { getByTestId } = setup({ extractedKeys: ['day', 'city'] });
    expect((getByTestId('program-run-key-0') as HTMLInputElement).value).toBe('env');
    expect((getByTestId('program-run-value-0') as HTMLInputElement).value).toBe('prod');
    expect((getByTestId('program-run-key-1') as HTMLInputElement).value).toBe('day');
    expect((getByTestId('program-run-value-1') as HTMLInputElement).value).toBe('');
    expect((getByTestId('program-run-key-2') as HTMLInputElement).value).toBe('city');
  });

  it('已保存参数里已有的名字不会被重复追加', () => {
    const { queryByTestId } = setup({ extractedKeys: ['env'] });
    expect(queryByTestId('program-run-key-1')).toBeNull();
  });

  it('提示识别到的参数名与代码头 @程序参数 声明原文', () => {
    const { getByTestId } = setup({ extractedKeys: ['day'], programArgsHint: '--day ${day}' });
    const source = getByTestId('program-run-extracted');
    expect(source.textContent).toContain('已识别 1 个程序参数：day');
    expect(source.textContent).toContain('代码头 @程序参数：--day ${day}');
  });

  it('未声明 @程序参数 时只提示参数名，不显示代码头出处', () => {
    const { getByTestId } = setup({ extractedKeys: ['day'] });
    expect(getByTestId('program-run-extracted').textContent).not.toContain('@程序参数');
  });

  it('未识别到参数时不显示提取入口与来源提示', () => {
    const { queryByTestId } = setup({ extractedKeys: [] });
    expect(queryByTestId('program-run-extract')).toBeNull();
    expect(queryByTestId('program-run-extracted')).toBeNull();
  });

  it('「从代码提取」把删掉的行补回来；没有缺失时按钮禁用', () => {
    const { getByTestId } = setup({ defaultParams: [], extractedKeys: ['day', 'city'] });
    const btn = getByTestId('program-run-extract') as HTMLButtonElement;
    // 打开时两个参数已全部预填，无缺失
    expect(btn.disabled).toBe(true);

    fireEvent.click(getByTestId('program-run-remove-0'));
    expect((getByTestId('program-run-key-0') as HTMLInputElement).value).toBe('city');
    expect(btn.disabled).toBe(false);

    fireEvent.click(btn);
    expect((getByTestId('program-run-key-0') as HTMLInputElement).value).toBe('city');
    expect((getByTestId('program-run-key-1') as HTMLInputElement).value).toBe('day');
    expect(btn.disabled).toBe(true);
  });
});
