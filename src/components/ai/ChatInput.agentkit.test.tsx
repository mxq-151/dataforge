/**
 * ChatInput.agentkit.test.tsx — AgentKit 入口的 UI 证据
 *
 * 只验证入口层：下拉里存在三个 AgentKit 工作流、发送时把业务名交给上层，
 * 以及产物缺失时拦在 UI 并给出引导。真正的 command/agent 请求体断言见
 * useOpencodeChat.test.ts。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ChatInput from './ChatInput';

// ChatInput 的默认实现会读 DataSourceContext；入口测试只关心任务路由，补全数据置空即可。
vi.mock('../../hooks/opencode/useAutoCompleteData', () => ({
  default: () => [],
}));

const fsMock = vi.fn();

function renderInput(overrides: Partial<React.ComponentProps<typeof ChatInput>> = {}) {
  const onSend = vi.fn();
  render(
    <ChatInput
      busy={false}
      onSend={onSend}
      onInterrupt={vi.fn()}
      llmModels={[]}
      selectedLLMId={null}
      onLLMChange={vi.fn()}
      llmDisabled={false}
      taskType="AGENTKIT_REQ_DOC"
      onTaskTypeChange={vi.fn()}
      moduleId="dev-assistant"
      workspacePath="/ws"
      {...overrides}
    />,
  );
  return { onSend };
}

beforeEach(() => {
  fsMock.mockReset();
  (window as unknown as { dataforge: { fs: typeof fsMock } }).dataforge = { fs: fsMock };
});

afterEach(() => {
  delete (window as unknown as { dataforge?: unknown }).dataforge;
});

describe('ChatInput AgentKit 入口', () => {
  it('开发助手下拉包含三个 AgentKit 工作流', () => {
    renderInput();
    expect(screen.getByRole('option', { name: '需求文档编写' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '数仓设计' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '数据处理代码开发' })).toBeTruthy();
  });

  it('需求文档编写发送业务名，并提示当前路由目标', async () => {
    const { onSend } = renderInput();
    expect(screen.getByText(/doc-orchestrator · \/write-req/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '订单域' } });
    fireEvent.click(screen.getByTitle('发送'));

    await waitFor(() => expect(onSend).toHaveBeenCalledWith('订单域'));
  });

  it('数仓设计缺少需求文档时不发送，并给出可操作的引导', async () => {
    fsMock.mockResolvedValueOnce([{ name: '库存域_开发需求.md', isFile: true }]);
    const { onSend } = renderInput({ taskType: 'AGENTKIT_DW_DESIGN' });

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '订单域' } });
    fireEvent.click(screen.getByTitle('发送'));

    await waitFor(() => expect(screen.getByText(/未找到 docs\/订单域_开发需求\.md/)).toBeTruthy());
    expect(onSend).not.toHaveBeenCalled();
    // 输入内容保留，用户可改名后直接重发
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('订单域');
  });
});
