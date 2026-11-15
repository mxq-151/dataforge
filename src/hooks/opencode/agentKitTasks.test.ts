/**
 * agentKitTasks.test.ts — AgentKit 入口映射与发送前产物校验
 *
 * 路由本身（session.command 是否带 command/agent）由 useOpencodeChat.test.ts 断言；
 * 这里只覆盖「任务类型 → command/agent」映射，以及需求文档缺失时的引导文案。
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
  it('四个任务类型分别映射到正确的 command/agent', () => {
    expect(resolveAgentKitTask(AGENTKIT_TASK_IDS.REQ_DOC)).toMatchObject({
      command: 'write-req',
      agent: 'doc-orchestrator',
    });
    expect(resolveAgentKitTask(AGENTKIT_TASK_IDS.DW_DEV)).toMatchObject({
      command: 'dw-dev',
      agent: 'dw-orchestrator',
    });
    expect(resolveAgentKitTask(AGENTKIT_TASK_IDS.ANALYSIS)).toMatchObject({
      command: 'ana-analyze',
      agent: 'ana-orchestrator',
    });
    expect(resolveAgentKitTask(AGENTKIT_TASK_IDS.DIAG)).toMatchObject({
      command: 'diag-task',
      agent: 'diag-orchestrator',
    });
  });

  it('已下线的经典任务类型与空值不进入 AgentKit 路由', () => {
    expect(resolveAgentKitTask('BUSINESS_REQUESTER')).toBeUndefined();
    expect(resolveAgentKitTask('DATA_WAREHOUSE_DEV')).toBeUndefined();
    expect(resolveAgentKitTask('DATA_ANALYST')).toBeUndefined();
    expect(resolveAgentKitTask('')).toBeUndefined();
    expect(resolveAgentKitTask(null)).toBeUndefined();
  });
});

describe('validateAgentKitTaskInput', () => {
  it('需求编写只要求业务名，并去掉误填的产物后缀', async () => {
    const result = await validateAgentKitTaskInput(AGENTKIT_TASKS[AGENTKIT_TASK_IDS.REQ_DOC], '订单域_开发需求.md', '/ws');
    expect(result).toEqual({ ok: true, args: '订单域' });
    expect(fsMock).not.toHaveBeenCalled();
  });

  it('业务名包含路径分隔符时拒绝', async () => {
    const result = await validateAgentKitTaskInput(AGENTKIT_TASKS[AGENTKIT_TASK_IDS.DW_DEV], '../订单域', '/ws');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('路径分隔符');
  });

  it('数仓开发缺少需求文档时给出引导与候选业务名', async () => {
    fsMock.mockResolvedValueOnce([
      { name: '订单域_开发需求.md', isFile: true },
      { name: '库存域_开发需求.md', isFile: true },
    ]);
    const result = await validateAgentKitTaskInput(AGENTKIT_TASKS[AGENTKIT_TASK_IDS.DW_DEV], '用户域', '/ws');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('未找到 docs/用户域_开发需求.md');
      expect(result.message).toContain('请先选择「需求编写」');
      expect(result.message).toContain('订单域');
    }
  });

  it('数仓开发在需求文档存在时放行', async () => {
    fsMock.mockResolvedValueOnce([{ name: '订单域_开发需求.md', isFile: true }]);
    const result = await validateAgentKitTaskInput(AGENTKIT_TASKS[AGENTKIT_TASK_IDS.DW_DEV], '订单域', '/ws');
    expect(result).toEqual({ ok: true, args: '订单域' });
  });

  it('数据分析不依赖工作区产物，直接放行', async () => {
    const result = await validateAgentKitTaskInput(AGENTKIT_TASKS[AGENTKIT_TASK_IDS.ANALYSIS], '订单表最近 7 天分区是否完整', '/ws');
    expect(result).toEqual({ ok: true, args: '订单表最近 7 天分区是否完整' });
    expect(fsMock).not.toHaveBeenCalled();
  });
});
