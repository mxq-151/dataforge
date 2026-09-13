import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useProgramRunner } from './useProgramRunner';

/**
 * 「运行程序」改为**先弹程序运行参数框（键值对）、点确定后再执行**的接线测试。
 *
 * 这里只钉住钩子的行为契约（不点确定就不能执行、确定后下发的 runParams
 * 来自弹窗里确认的键值对而不是已保存配置），编译/执行本身由被 mock 的服务承担。
 */
const mocks = vi.hoisted(() => ({
  submitTaskSet: vi.fn(() => 'taskset-1'),
  unifiedCompile: vi.fn(),
}));

vi.mock('../services/taskExecutionService', () => ({
  TaskExecutionService: class {
    subscribe() { return () => {}; }
    isActive() { return false; }
    getCurrentExecutionId() { return null; }
    submitTaskSet(tasks: unknown) { return mocks.submitTaskSet(tasks); }
    stop() { /* noop */ }
    destroy() { /* noop */ }
  },
}));

vi.mock('../services/unifiedCompile', () => ({
  unifiedCompile: (...args: unknown[]) => mocks.unifiedCompile(...args),
}));

/** 合法代码头（v2 块注释规范）的 SQL 内容：走 kyuubi 逐句执行分支，无需编译 */
const SQL_CONTENT = ['/*', ' * @引擎: kyuubi', ' */', 'select 1;'].join('\n');
const SQL_PATH = '/proj/TEST/code/ods/a.sql';

type RunnerParams = Parameters<typeof useProgramRunner>[0];

const buildProps = (overrides: Partial<RunnerParams> = {}): RunnerParams => ({
  project: { id: 1, projectCode: 'TEST' },
  username: 'tester',
  config: {},
  projectCwd: '/proj',
  readFile: vi.fn(async () => new Uint8Array()),
  tabs: [{ id: 't1', name: 'a.sql', path: SQL_PATH }],
  activeTabId: 't1',
  currentContent: SQL_CONTENT,
  savedConfigParams: {
    [SQL_PATH]: {
      dependencies: [],
      programParams: [{ id: 'p1', key: 'env', value: 'prod' }],
      taskParams: [],
    },
  },
  editorAreaRef: { current: null },
  ...overrides,
} as unknown as RunnerParams);

describe('useProgramRunner — 运行程序前的参数确认', () => {
  beforeEach(() => {
    mocks.submitTaskSet.mockClear();
    mocks.unifiedCompile.mockClear();
  });

  it('点击「运行程序」只弹参数框，不直接执行', async () => {
    const props = buildProps();
    const { result } = renderHook(() => useProgramRunner(props));

    await act(async () => { await result.current.handleRunProgram(); });

    expect(mocks.submitTaskSet).not.toHaveBeenCalled();
    expect(mocks.unifiedCompile).not.toHaveBeenCalled();
    expect(result.current.pendingProgramRun).toEqual({
      defaultParams: [{ id: 'p1', key: 'env', value: 'prod' }],
      extractedKeys: [],
      taskParamKeys: [],
      programArgsHint: '',
      taskArgsHint: '',
      usageHint: '',
      selectedCode: undefined,
    });
  });

  it('用当前文件已保存的「配置程序参数」预填（按文件路径取值）', async () => {
    const otherPath = '/proj/TEST/code/dwd/b.sql';
    const props = buildProps({
      tabs: [{ id: 't2', name: 'b.sql', path: otherPath }],
      activeTabId: 't2',
      savedConfigParams: {
        [SQL_PATH]: { dependencies: [], programParams: [{ id: 'p1', key: 'env', value: 'prod' }], taskParams: [] },
        [otherPath]: { dependencies: [], programParams: [{ id: 'p2', key: 'env', value: 'stage' }], taskParams: [] },
      },
    });
    const { result } = renderHook(() => useProgramRunner(props));

    await act(async () => { await result.current.handleRunProgram(); });

    expect(result.current.pendingProgramRun?.defaultParams).toEqual([{ id: 'p2', key: 'env', value: 'stage' }]);
  });

  it('取消后不执行，且清掉待确认状态', async () => {
    const props = buildProps();
    const { result } = renderHook(() => useProgramRunner(props));

    await act(async () => { await result.current.handleRunProgram(); });
    act(() => { result.current.handleCancelProgramRun(); });

    expect(result.current.pendingProgramRun).toBeNull();
    expect(mocks.submitTaskSet).not.toHaveBeenCalled();
  });

  it('点「确定」后执行，runParams 取弹窗确认的键值对（覆盖已保存值）', async () => {
    const props = buildProps();
    const { result } = renderHook(() => useProgramRunner(props));

    await act(async () => { await result.current.handleRunProgram(); });
    await act(async () => {
      await result.current.handleProgramRunConfirm([
        { key: 'env', value: 'gray' },
        { key: 'dry-run', value: 'true' },
      ]);
    });

    expect(result.current.pendingProgramRun).toBeNull();
    expect(mocks.submitTaskSet).toHaveBeenCalledTimes(1);
    const tasks = mocks.submitTaskSet.mock.calls[0][0] as { runParams?: Record<string, unknown> }[];
    // 弹窗里的 env=gray 覆盖已保存的 env=prod
    expect(tasks[0].runParams).toEqual({ env: 'gray', 'dry-run': 'true' });
  });

  it('参数名为空的行整行丢弃（有值也不下发）', async () => {
    const props = buildProps();
    const { result } = renderHook(() => useProgramRunner(props));

    await act(async () => { await result.current.handleRunProgram(); });
    await act(async () => {
      await result.current.handleProgramRunConfirm([
        { key: '', value: 'orphan' },
        { key: 'env', value: 'prod' },
      ]);
    });

    const tasks = mocks.submitTaskSet.mock.calls[0][0] as { runParams?: Record<string, unknown> }[];
    expect(tasks[0].runParams).toEqual({ env: 'prod' });
  });

  it('删光参数后点「确定」→ 不下发 runParams（所见即所发，不回落已保存值）', async () => {
    const props = buildProps();
    const { result } = renderHook(() => useProgramRunner(props));

    await act(async () => { await result.current.handleRunProgram(); });
    await act(async () => { await result.current.handleProgramRunConfirm([]); });

    expect(mocks.submitTaskSet).toHaveBeenCalledTimes(1);
    const tasks = mocks.submitTaskSet.mock.calls[0][0] as { runParams?: Record<string, unknown> }[];
    expect(tasks[0].runParams).toBeUndefined();
  });

  it('SQL：从正文 ${var} 与代码头 @程序参数 提取程序参数名（只给名字，取值留空）', async () => {
    const content = [
      '/*',
      ' * @引擎: kyuubi',
      ' * @程序参数: --day 20260501',
      ' * @任务参数: 无',
      ' */',
      "insert overwrite table t partition(dt = '${day}')",
      "select 1 from s where dt = '${day}' and city = '${city}'",
    ].join('\n');
    const props = buildProps({ currentContent: content });
    const { result } = renderHook(() => useProgramRunner(props));

    await act(async () => { await result.current.handleRunProgram(); });

    // 代码头 @程序参数 的 day 在前，正文新增的 city 在后；两者都不带取值
    expect(result.current.pendingProgramRun?.extractedKeys).toEqual(['day', 'city']);
    expect(result.current.pendingProgramRun?.programArgsHint).toBe('--day 20260501');
    expect(result.current.pendingProgramRun?.taskArgsHint).toBe('无');
    expect(result.current.pendingProgramRun?.taskParamKeys).toEqual([]);
  });

  it('Java：旧格式 @用法 下参数名只来自代码头，正文里的 ${} 不算', async () => {
    const content = [
      '/*',
      ' * @引擎: spark',
      ' * @用法: --day 20260501 -checkpoint 60000',
      ' */',
      'package TEST.java.ods;',
      'class Test { String tpl = "${notAParam}"; }',
    ].join('\n');
    const props = buildProps({
      tabs: [{ id: 'j1', name: 'Test.java', path: '/proj/TEST/code/ods/Test.java' }],
      activeTabId: 'j1',
      currentContent: content,
    });
    const { result } = renderHook(() => useProgramRunner(props));

    await act(async () => { await result.current.handleRunProgram(); });

    expect(result.current.pendingProgramRun?.extractedKeys).toEqual(['day', 'checkpoint']);
  });

  it('旧格式 @用法：提交框架参数仍被剔到 taskParamKeys，只把程序参数交给弹窗', async () => {
    const content = [
      '/*',
      ' * @引擎: spark',
      ' * @用法: --master yarn --deploy-mode cluster --class com.x.Y --num-executors 4 --driver-memory 2g --day 20260501',
      ' */',
      'package TEST.scala.ods;',
      'object Test {}',
    ].join('\n');
    const props = buildProps({
      tabs: [{ id: 's1', name: 'Test.scala', path: '/proj/TEST/code/ods/Test.scala' }],
      activeTabId: 's1',
      currentContent: content,
    });
    const { result } = renderHook(() => useProgramRunner(props));

    await act(async () => { await result.current.handleRunProgram(); });

    expect(result.current.pendingProgramRun?.extractedKeys).toEqual(['day']);
    expect(result.current.pendingProgramRun?.taskParamKeys).toEqual([
      '--master', '--deploy-mode', '--class', '--num-executors', '--driver-memory',
    ]);
    expect(result.current.pendingProgramRun?.usageHint).toContain('--master yarn');
  });

  it('新格式 @任务参数：显式声明的引擎参数进 taskParamKeys，不进预填行', async () => {
    const content = [
      '/*',
      ' * @引擎: spark',
      ' * @程序参数: --day 20260501 -checkpoint 60000',
      ' * @任务参数: --num-executors 4 --driver-memory 2g',
      ' */',
      'package TEST.scala.ods;',
      'object Test {}',
    ].join('\n');
    const props = buildProps({
      tabs: [{ id: 's1', name: 'Test.scala', path: '/proj/TEST/code/ods/Test.scala' }],
      activeTabId: 's1',
      currentContent: content,
    });
    const { result } = renderHook(() => useProgramRunner(props));

    await act(async () => { await result.current.handleRunProgram(); });

    expect(result.current.pendingProgramRun?.extractedKeys).toEqual(['day', 'checkpoint']);
    expect(result.current.pendingProgramRun?.taskParamKeys).toEqual(['--num-executors', '--driver-memory']);
    expect(result.current.pendingProgramRun?.programArgsHint).toBe('--day 20260501 -checkpoint 60000');
    expect(result.current.pendingProgramRun?.taskArgsHint).toBe('--num-executors 4 --driver-memory 2g');
    expect(result.current.pendingProgramRun?.usageHint).toBe('');
  });

  it('带选区触发时，按选区内容提取参数（不是整个文件）', async () => {
    const props = buildProps();
    const { result } = renderHook(() => useProgramRunner(props));

    await act(async () => {
      await result.current.handleRunProgram("select 2 from t where dt = '${day}'");
    });

    expect(result.current.pendingProgramRun?.extractedKeys).toEqual(['day']);
  });

  it('带选区触发时，确定后仍只执行选区内容', async () => {
    const props = buildProps();
    const { result } = renderHook(() => useProgramRunner(props));

    await act(async () => { await result.current.handleRunProgram('select 2;'); });
    expect(result.current.pendingProgramRun?.selectedCode).toBe('select 2;');

    await act(async () => {
      await result.current.handleProgramRunConfirm([{ key: 'env', value: 'test' }]);
    });
    const tasks = mocks.submitTaskSet.mock.calls[0][0] as { code: string }[];
    expect(tasks[0].code).toBe('select 2;');
  });
});
