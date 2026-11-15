/**
 * agentKitTasks.test.ts — AgentKit 入口映射与发送前产物校验
 *
 * 路由本身（session.command 是否带 command/agent）由 useOpencodeChat.test.ts 断言；
 * 这里只覆盖「任务类型 → command/agent」映射，以及需求文档/设计文档缺失时的引导文案。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AGENTKIT_TASK_IDS,
  AGENTKIT_TASKS,
  resolveAgentKitTask,
  validateAgentKitTaskInput,
} from './agentKitTasks';

const fsMock = vi.fn();

beforeEach(() => {
  fsMock.mockReset();
  (window as unknown as { dataforge: { fs: typeof fsMock } }).dataforge = { fs: fsMock };
});

afterEach(() => {
  delete (window as unknown as { dataforge?: unknown }).dataforge;
});

describe('resolveAgentKitTask', () => {
  it('三个 AgentKit 任务类型分别映射到正确的 command/agent', () => {
    expect(resolveAgentKitTask(AGENTKIT_TASK_IDS.REQ_DOC)).toMatchObject({
      command: 'write-req',
      agent: 'doc-orchestrator',
    });
    expect(resolveAgentKitTask(AGENTKIT_TASK_IDS.DW_DESIGN)).toMatchObject({
      command: 'dw-design',
      agent: 'dw-orchestrator',
    });
    expect(resolveAgentKitTask(AGENTKIT_TASK_IDS.DW_CODE)).toMatchObject({
      command: 'dw-code',
      agent: 'dw-orchestrator',
    });
  });

  it('旧任务类型与空值不进入 AgentKit 路由', () => {
    expect(resolveAgentKitTask('BUSINESS_REQUESTER')).toBeUndefined();
    expect(resolveAgentKitTask('DATA_WAREHOUSE_DEV')).toBeUndefined();
    expect(resolveAgentKitTask('DATA_ANALYST')).toBeUndefined();
    expect(resolveAgentKitTask('')).toBeUndefined();
    expect(resolveAgentKitTask(null)).toBeUndefined();
  });
});

describe('validateAgentKitTaskInput', () => {
  it('需求文档编写只要求业务名，并去掉误填的产物后缀', async () => {
    const result = await validateAgentKitTaskInput(AGENTKIT_TASKS[AGENTKIT_TASK_IDS.REQ_DOC], '订单域_开发需求.md', '/ws');
    expect(result).toEqual({ ok: true, args: '订单域' });
    expect(fsMock).not.toHaveBeenCalled();
  });

  it('业务名包含路径分隔符时拒绝', async () => {
    const result = await validateAgentKitTaskInput(AGENTKIT_TASKS[AGENTKIT_TASK_IDS.DW_DESIGN], '../订单域', '/ws');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('路径分隔符');
  });

  it('数仓设计缺少需求文档时给出引导与候选业务名', async () => {
    fsMock.mockResolvedValueOnce([
      { name: '订单域_开发需求.md', isFile: true },
      { name: '库存域_开发需求.md', isFile: true },
    ]);
    const result = await validateAgentKitTaskInput(AGENTKIT_TASKS[AGENTKIT_TASK_IDS.DW_DESIGN], '用户域', '/ws');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('未找到 docs/用户域_开发需求.md');
      expect(result.message).toContain('请先选择「需求文档编写」');
      expect(result.message).toContain('订单域');
    }
  });

  it('数仓设计在需求文档存在时放行', async () => {
    fsMock.mockResolvedValueOnce([{ name: '订单域_开发需求.md', isFile: true }]);
    const result = await validateAgentKitTaskInput(AGENTKIT_TASKS[AGENTKIT_TASK_IDS.DW_DESIGN], '订单域', '/ws');
    expect(result).toEqual({ ok: true, args: '订单域' });
  });

  it('代码开发缺少设计文档时引导先做数仓设计', async () => {
    fsMock.mockResolvedValueOnce([{ name: '订单域_开发需求.md', isFile: true }]);
    const result = await validateAgentKitTaskInput(AGENTKIT_TASKS[AGENTKIT_TASK_IDS.DW_CODE], '订单域', '/ws');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('请先完成「数仓设计」');
  });

  it('代码开发在设计文档存在但 trace 缺失时提示设计未定稿', async () => {
    fsMock
      .mockResolvedValueOnce([{ name: '订单域_数仓设计.md', isFile: true }])
      .mockRejectedValueOnce(new Error('ENOENT'));
    const result = await validateAgentKitTaskInput(AGENTKIT_TASKS[AGENTKIT_TASK_IDS.DW_CODE], '订单域', '/ws');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('.dw/trace.json');
  });

  it('代码开发在设计文档与 trace 都存在时放行', async () => {
    fsMock
      .mockResolvedValueOnce([{ name: '订单域_数仓设计.md', isFile: true }])
      .mockResolvedValueOnce('{}');
    const result = await validateAgentKitTaskInput(AGENTKIT_TASKS[AGENTKIT_TASK_IDS.DW_CODE], '订单域', '/ws');
    expect(result).toEqual({ ok: true, args: '订单域' });
  });
});
