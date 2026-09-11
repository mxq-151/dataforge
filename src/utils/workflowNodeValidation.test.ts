import { describe, it, expect } from 'vitest';
import { validateWorkflowNodes } from './workflowNodeValidation';
import { Priority, getDefaultTaskParams } from '../types/dolphinscheduler';
import type { DSTaskType, DSWorkflowTaskNode } from '../types/dolphinscheduler';

/**
 * 保存工作流前的任务节点参数校验。
 *
 * 这条路径服务于「工作流定义」编辑器与开发助手「提交调度」模态框：
 * 两者都内嵌 WorkflowDefinitionEditor，保存前必须逐个节点校验，
 * 任一节点不通过就不允许保存。这里钉住四类容易出错的行为：
 * 1. 通用项（任务名空/重名、taskParams 非法 JSON、超时告警时间）；
 * 2. 各任务类型的必填参数（含 DATAX/CHUNJUN/SEATUNNEL/LINKIS 的条件必填）；
 * 3. 结构型参数（依赖组、条件分支、开关分支）；
 * 4. 自定义参数行的参数名。
 */

/** 构造任务节点：默认给一个合法 SHELL 节点，按需覆盖 */
function makeNode(overrides: Partial<DSWorkflowTaskNode> & { name: string }): DSWorkflowTaskNode {
  return {
    code: 1000 + Math.abs(hash(overrides.name)),
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
  } as DSWorkflowTaskNode;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** 构造指定任务类型的节点：以 getDefaultTaskParams 为底，再按需覆盖参数 */
function makeTypedNode(
  name: string,
  taskType: DSTaskType,
  params: Record<string, unknown> = {},
  overrides: Partial<DSWorkflowTaskNode> = {},
): DSWorkflowTaskNode {
  return makeNode({
    name,
    taskType,
    taskParams: JSON.stringify({ ...getDefaultTaskParams(taskType), ...params }),
    ...overrides,
  });
}

const messagesOf = (result: ReturnType<typeof validateWorkflowNodes>, taskName: string) =>
  result.failedNodes.find(n => n.taskName === taskName)?.messages ?? [];

describe('validateWorkflowNodes - 通用校验', () => {
  it('全部节点合法时通过，issues 与 failedNodes 均为空', () => {
    const result = validateWorkflowNodes([
      makeTypedNode('a_shell', 'SHELL', { rawScript: 'echo 1' }),
      makeTypedNode('b_sql', 'SQL', { sql: 'select 1' }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.failedNodes).toEqual([]);
  });

  it('任务名称为空时报错（展示名兜底为「任务#code」）', () => {
    const result = validateWorkflowNodes([makeNode({ name: '   ' })]);
    expect(result.ok).toBe(false);
    expect(result.issues.map(i => i.message)).toContain('任务名称不能为空');
    expect(result.failedNodes[0].taskName).toMatch(/^任务#\d+$/);
  });

  it('同一工作流内任务名重复时报错（两个节点都报）', () => {
    const result = validateWorkflowNodes([
      makeTypedNode('dup', 'SHELL', { rawScript: 'a' }),
      makeTypedNode('dup', 'SHELL', { rawScript: 'b' }),
    ]);
    expect(result.ok).toBe(false);
    expect(messagesOf(result, 'dup').filter(m => m.includes('重复'))).toHaveLength(2);
  });

  it('taskParams 不是合法 JSON 时报错', () => {
    const result = validateWorkflowNodes([makeNode({ name: 'broken', taskParams: '{oops' })]);
    expect(result.ok).toBe(false);
    expect(messagesOf(result, 'broken').some(m => m.includes('不是合法的 JSON'))).toBe(true);
  });

  it('taskParams 为空串时报错', () => {
    const result = validateWorkflowNodes([makeNode({ name: 'empty', taskParams: '' })]);
    expect(messagesOf(result, 'empty')).toContain('任务参数为空，请先打开任务配置补全');
  });

  it('开启超时告警但超时时间为 0 时报错；关闭时不校验', () => {
    const opened = validateWorkflowNodes([
      makeTypedNode('t1', 'SHELL', { rawScript: 'echo' }, { timeoutFlag: 'OPEN', timeout: 0 }),
    ]);
    expect(messagesOf(opened, 't1')).toContain('已开启超时告警，超时时间必须大于 0 分钟');

    const closed = validateWorkflowNodes([
      makeTypedNode('t2', 'SHELL', { rawScript: 'echo' }, { timeoutFlag: 'CLOSE', timeout: 0 }),
    ]);
    expect(closed.ok).toBe(true);
  });

  it('自定义参数行为空时报错（含 paramScript / kubeflowParameters）', () => {
    const result = validateWorkflowNodes([
      makeTypedNode('lp', 'SHELL', { rawScript: 'echo', localParams: [{ prop: '', value: 'v' }] }),
      makeTypedNode('ps', 'LINKIS', { useCustom: true, rawScript: 'select 1', paramScript: [{ prop: '  ' }] }),
    ]);
    expect(messagesOf(result, 'lp')).toContain('自定义参数第 1 行缺少参数名');
    expect(messagesOf(result, 'ps')).toContain('自定义参数第 1 行缺少参数名');
  });
});

describe('validateWorkflowNodes - 各任务类型必填参数', () => {
  it('SHELL / PYTHON / SQL / PROCEDURE / JUPYTER / REMOTESHELL 缺脚本类参数时报错', () => {
    const cases: [DSTaskType, Record<string, unknown>, string][] = [
      ['SHELL', { rawScript: '' }, '请填写脚本'],
      ['PYTHON', { rawScript: '   ' }, '请填写脚本'],
      ['SQL', { sql: '' }, '请填写SQL语句'],
      ['PROCEDURE', { method: '' }, '请填写存储过程语句'],
      ['JUPYTER', { rawScript: '' }, '请填写脚本'],
      ['REMOTESHELL', { rawScript: '' }, '请填写脚本'],
    ];
    for (const [taskType, params, expected] of cases) {
      const result = validateWorkflowNodes([makeTypedNode('n', taskType, params)]);
      expect(result.ok, `${taskType} 应当校验失败`).toBe(false);
      expect(messagesOf(result, 'n')).toContain(expected);
    }
  });

  it('HTTP / GRPC 缺少请求地址时报错，ZEPPELIN 缺 Note ID 也报错', () => {
    expect(messagesOf(validateWorkflowNodes([makeTypedNode('h', 'HTTP', { url: '' })]), 'h'))
      .toContain('请填写请求地址');
    expect(messagesOf(validateWorkflowNodes([makeTypedNode('g', 'GRPC', { url: '' })]), 'g'))
      .toContain('请填写请求地址');
    expect(messagesOf(validateWorkflowNodes([makeTypedNode('z', 'ZEPPELIN', { restEndpoint: 'http://a', noteId: '' })]), 'z'))
      .toContain('请填写Note ID');
  });

  it('K8S 缺命名空间/镜像、OPENMLDB 缺 ZooKeeper/SQL 时报错', () => {
    const k8s = validateWorkflowNodes([makeTypedNode('k', 'K8S', { namespace: '', image: '' })]);
    expect(messagesOf(k8s, 'k')).toEqual(['请填写命名空间', '请填写镜像地址']);

    const openmldb = validateWorkflowNodes([makeTypedNode('o', 'OPENMLDB', { zk: '', sql: '' })]);
    expect(messagesOf(openmldb, 'o')).toEqual(['请填写ZooKeeper地址', '请填写SQL语句']);
  });

  it('SUB_PROCESS 未选择子工作流（0）时报错', () => {
    const result = validateWorkflowNodes([makeTypedNode('sub', 'SUB_PROCESS', { workflowDefinitionCode: 0 })]);
    expect(messagesOf(result, 'sub')).toContain('请选择子工作流');

    const ok = validateWorkflowNodes([makeTypedNode('sub', 'SUB_PROCESS', { workflowDefinitionCode: 123 })]);
    expect(ok.ok).toBe(true);
  });

  it('DINKY 的任务 ID 为 0 时报错，>0 时通过', () => {
    expect(messagesOf(validateWorkflowNodes([makeTypedNode('d', 'DINKY', { dinkyTaskId: 0 })]), 'd'))
      .toContain('请选择Dinky任务ID');
    expect(validateWorkflowNodes([makeTypedNode('d', 'DINKY', { dinkyTaskId: 42 })]).ok).toBe(true);
  });

  it('DMS / DATASYNC / DATA_FACTORY / KUBEFLOW / ALIYUN 的必填项', () => {
    const cases: [DSTaskType, Record<string, unknown>, string][] = [
      ['DMS', { dmsTaskId: '' }, '请填写DMS任务ID'],
      ['DATASYNC', { datasyncTaskId: '' }, '请填写DataSync任务ID'],
      ['DATA_FACTORY', { factoryName: '' }, '请填写工厂名称'],
      ['KUBEFLOW', { kubeflowPipelineYaml: '' }, '请填写Pipeline YAML'],
      ['ALIYUN_SERVERLESS_SPARK', { restEndpoint: '' }, '请填写RestEndpoint'],
    ];
    for (const [taskType, params, expected] of cases) {
      const result = validateWorkflowNodes([makeTypedNode('n', taskType, params)]);
      expect(messagesOf(result, 'n'), `${taskType}`).toContain(expected);
    }
  });

  it('HIVECLI 缺 HiveSQL 时报错', () => {
    expect(messagesOf(validateWorkflowNodes([makeTypedNode('hv', 'HIVECLI', { hiveSql: '' })]), 'hv'))
      .toContain('请填写HiveSQL');
  });

  it('DATAX：自定义 JSON 模式只校验 json，非自定义模式校验 sql + targetTable', () => {
    const custom = validateWorkflowNodes([makeTypedNode('dx', 'DATAX', { customConfig: true, json: '' })]);
    expect(messagesOf(custom, 'dx')).toEqual(['请填写JSON模板']);

    const normal = validateWorkflowNodes([makeTypedNode('dx', 'DATAX', { customConfig: false, sql: '', targetTable: '' })]);
    expect(messagesOf(normal, 'dx')).toEqual(['请填写SQL抽取语句', '请填写目标表名']);

    const ok = validateWorkflowNodes([makeTypedNode('dx', 'DATAX', { customConfig: false, sql: 'select 1', targetTable: 't' })]);
    expect(ok.ok).toBe(true);
  });

  it('FLINK：仅 SQL 程序类型才要求 SQL 脚本', () => {
    const scala = validateWorkflowNodes([makeTypedNode('fk', 'FLINK', { programType: 'SCALA', rawScript: '' })]);
    expect(scala.ok).toBe(true);

    const sql = validateWorkflowNodes([makeTypedNode('fk', 'FLINK', { programType: 'SQL', rawScript: '' })]);
    expect(messagesOf(sql, 'fk')).toContain('请填写SQL脚本');
  });

  it('mainJar（主 Jar 包）不参与校验：它是编译后自动回填的派生值', () => {
    // SPARK / FLINK / MR 的非 SQL 模式与 JAVA 都靠「编译 → 上传 jar → 回填 mainJar」，
    // 回填前 mainJar 必然为空 —— 若在此校验，文件夹提交调度在编译回填前就存不了。
    const result = validateWorkflowNodes([
      makeTypedNode('sp', 'SPARK', { programType: 'SCALA', mainJar: '' }),
      makeTypedNode('fk', 'FLINK', { programType: 'SCALA', mainJar: '' }),
      makeTypedNode('mr', 'MR', { programType: 'SCALA', mainJar: '' }),
      makeTypedNode('jv', 'JAVA', { mainJar: '' }),
    ]);
    const allMessages = result.failedNodes.flatMap(n => n.messages);
    expect(allMessages).not.toContain('请填写主Jar包');
    expect(allMessages).not.toContain('请填写主程序包');
    expect(result.ok).toBe(true);
  });

  it('SEATUNNEL / CHUNJUN / LINKIS：勾选自定义模式后才校验对应参数', () => {
    const stOff = validateWorkflowNodes([makeTypedNode('st', 'SEATUNNEL', { useCustom: false, rawScript: '' })]);
    expect(stOff.ok).toBe(true);
    const stOn = validateWorkflowNodes([makeTypedNode('st', 'SEATUNNEL', { useCustom: true, rawScript: '' })]);
    expect(messagesOf(stOn, 'st')).toContain('请填写SeaTunnel配置(HOCON)');

    const cjOff = validateWorkflowNodes([makeTypedNode('cj', 'CHUNJUN', { customConfig: false, json: '' })]);
    expect(cjOff.ok).toBe(true);
    const cjOn = validateWorkflowNodes([makeTypedNode('cj', 'CHUNJUN', { customConfig: true, json: '' })]);
    expect(messagesOf(cjOn, 'cj')).toContain('请填写JSON配置');

    const lkOff = validateWorkflowNodes([makeTypedNode('lk', 'LINKIS', { useCustom: false, rawScript: '' })]);
    expect(lkOff.ok).toBe(true);
    const lkOn = validateWorkflowNodes([makeTypedNode('lk', 'LINKIS', { useCustom: true, rawScript: '' })]);
    expect(messagesOf(lkOn, 'lk')).toContain('请填写脚本');
  });

  it('FLINK_STREAM 表单无必填标记，空参数不阻断', () => {
    const result = validateWorkflowNodes([makeTypedNode('fs', 'FLINK_STREAM', { rawScript: '' })]);
    expect(result.ok).toBe(true);
  });
});

describe('validateWorkflowNodes - 结构型参数', () => {
  it('DEPENDENT：依赖组为空时报错', () => {
    const result = validateWorkflowNodes([
      makeTypedNode('dep', 'DEPENDENT', { dependence: { relation: 'AND', dependTaskList: [], failurePolicy: 'DEPENDENT_FAILURE_FAILURE', checkInterval: 10, failureWaitingTime: 0 } }),
    ]);
    expect(messagesOf(result, 'dep')).toEqual(['请至少添加一个依赖组']);
  });

  it('DEPENDENT：依赖项缺项目/工作流/任务/周期时逐条报错', () => {
    const result = validateWorkflowNodes([
      makeTypedNode('dep', 'DEPENDENT', {
        dependence: {
          relation: 'AND',
          dependTaskList: [{ relation: 'AND', dependItemList: [{ projectCode: 0, definitionCode: 0, depTaskCode: 0, cycle: '', dateValue: 'today' }] }],
          failurePolicy: 'DEPENDENT_FAILURE_FAILURE',
          checkInterval: 10,
          failureWaitingTime: 0,
        },
      }),
    ]);
    const messages = messagesOf(result, 'dep');
    expect(messages).toContain('依赖组 1 第 1 个依赖项未选择项目');
    expect(messages).toContain('依赖组 1 第 1 个依赖项未选择工作流');
    expect(messages).toContain('依赖组 1 第 1 个依赖项未选择任务');
    expect(messages).toContain('依赖组 1 第 1 个依赖项未选择时间周期');
  });

  it('DEPENDENT：依赖项完整时通过（与 buildDependentTaskNode 产物一致）', () => {
    const result = validateWorkflowNodes([
      makeTypedNode('dep', 'DEPENDENT', {
        dependence: {
          relation: 'AND',
          dependTaskList: [{ relation: 'AND', dependItemList: [{ projectCode: 1, definitionCode: 2, depTaskCode: 3, cycle: 'day', dateValue: 'today' }] }],
          failurePolicy: 'DEPENDENT_FAILURE_FAILURE',
          checkInterval: 10,
          failureWaitingTime: 0,
        },
      }),
    ]);
    expect(result.ok).toBe(true);
  });

  it('CONDITIONS：前置条件为空或未选择前置任务时报错', () => {
    const empty = validateWorkflowNodes([makeTypedNode('cd', 'CONDITIONS', { dependTaskList: [] })]);
    expect(messagesOf(empty, 'cd')).toEqual(['请至少添加一个前置任务检查条件']);

    const unset = validateWorkflowNodes([makeTypedNode('cd', 'CONDITIONS', { dependTaskList: [{ depTaskCode: 0, status: 'SUCCESS' }] })]);
    expect(messagesOf(unset, 'cd')).toEqual(['第 1 个前置条件未选择前置任务']);
  });

  it('SWITCH：分支为空、条件表达式为空、未选分支任务时分别报错', () => {
    const empty = validateWorkflowNodes([makeTypedNode('sw', 'SWITCH', { switchResult: { dependTaskList: [], nextNode: null } })]);
    expect(messagesOf(empty, 'sw')).toEqual(['请至少添加一个条件分支']);

    const bad = validateWorkflowNodes([
      makeTypedNode('sw', 'SWITCH', { switchResult: { dependTaskList: [{ condition: '', nextNode: null }], nextNode: null } }),
    ]);
    expect(messagesOf(bad, 'sw')).toEqual(['条件 1 未填写条件表达式', '条件 1 未选择分支任务']);
  });

  it('SWITCH：条件与分支任务齐备时通过（默认分支可为空）', () => {
    const result = validateWorkflowNodes([
      makeTypedNode('sw', 'SWITCH', { switchResult: { dependTaskList: [{ condition: '${x} == 1', nextNode: 222 }], nextNode: null } }),
    ]);
    expect(result.ok).toBe(true);
  });
});

describe('validateWorkflowNodes - 聚合结果', () => {
  it('failedNodes 按节点聚合，并带任务类型中文名', () => {
    const result = validateWorkflowNodes([
      makeTypedNode('a', 'SQL', { sql: '' }),
      makeTypedNode('b', 'K8S', { namespace: '', image: '' }),
      makeTypedNode('c', 'SHELL', { rawScript: 'echo ok' }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.failedNodes.map(n => n.taskName)).toEqual(['a', 'b']);
    expect(result.failedNodes[0].taskTypeLabel).toBe('SQL');
    expect(result.failedNodes[1].taskTypeLabel).toBe('Kubernetes');
    // 合法节点不进入失败列表
    expect(result.failedNodes.some(n => n.taskName === 'c')).toBe(false);
    // issues 与 failedNodes 一致
    expect(result.issues.length).toBe(result.failedNodes.reduce((sum, n) => sum + n.messages.length, 0));
  });
});
