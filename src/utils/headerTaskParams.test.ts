/**
 * 「提交调度」节点参数 ← 代码头声明 的换算口径（utils/headerTaskParams.ts）。
 *
 * 锁定的是「同一份代码头声明同时驱动两个消费面」这件事：
 *   - 「运行程序」弹窗只取**参数名**（utils/programArgs.ts）
 *   - 调度任务节点取**取值**并落到对应字段（本模块）
 * 因此这里逐条断言：映射表命中的项落到哪个节点参数、映射不到的项去哪（不许静默丢弃）、
 * 以及本任务类型没有承载字段时的回报（supported=false + unmapped）。
 */

import { describe, it, expect } from 'vitest';
import {
  parseHeaderArgTokens,
  deriveTaskParamsFromHeader,
  taskTypeSupportsHeaderParams,
  appliedHeaderParamKeys,
} from './headerTaskParams';

/** 组装一段代码头（块注释，逐行 * @键: 值） */
const headerOf = (fields: Record<string, string>): string =>
  ['/*', ...Object.entries(fields).map(([k, v]) => ` * @${k}: ${v}`), ' */', 'select 1;'].join('\n');

describe('parseHeaderArgTokens — 声明切成 flag/取值', () => {
  it('空格分隔的取值、=取值、结尾无取值都能正确识别', () => {
    expect(parseHeaderArgTokens('--day 20260501 -checkpoint 60000')).toEqual([
      { flag: '--day', name: 'day', value: '20260501' },
      { flag: '-checkpoint', name: 'checkpoint', value: '60000' },
    ]);
    expect(parseHeaderArgTokens('--env=prod')).toEqual([
      { flag: '--env=prod', name: 'env', value: 'prod' },
    ]);
    expect(parseHeaderArgTokens('--num-executors')).toEqual([
      { flag: '--num-executors', name: 'num-executors', value: '' },
    ]);
  });

  it('负数是取值（--offset -1），不是下一个 flag', () => {
    expect(parseHeaderArgTokens('--offset -1 --day 20260501')).toEqual([
      { flag: '--offset', name: 'offset', value: '-1' },
      { flag: '--day', name: 'day', value: '20260501' },
    ]);
  });

  it('「无」与空声明 → 无 token', () => {
    expect(parseHeaderArgTokens('无')).toEqual([]);
    expect(parseHeaderArgTokens('')).toEqual([]);
    expect(parseHeaderArgTokens(undefined)).toEqual([]);
  });
});

describe('deriveTaskParamsFromHeader — SPARK', () => {
  const content = headerOf({
    引擎: 'spark',
    程序参数: '--day 20260501',
    资源参数: '--num-executors 4 --driver-memory 2g --executor-cores 2 --queue root.default',
    任务参数: '--master yarn --deploy-mode cluster --class com.demo.OdsLoad',
  });

  it('资源/任务参数按真实取值落到对应节点字段', () => {
    const { supported, params } = deriveTaskParamsFromHeader(content, 'SPARK');
    expect(supported).toBe(true);
    expect(params).toMatchObject({
      numExecutors: 4,
      driverMemory: '2g',
      executorCores: 2,
      yarnQueue: 'root.default',
      deployMode: 'cluster',
      mainClass: 'com.demo.OdsLoad',
    });
  });

  it('@程序参数 的取值写进节点「主参数」(mainArgs)', () => {
    expect(deriveTaskParamsFromHeader(content, 'SPARK').params.mainArgs).toBe('--day 20260501');
  });

  it('映射不到字段的声明原样进「其他参数」，不丢也不猜', () => {
    // --master 在节点参数里没有对应字段，只能原样进 others
    expect(deriveTaskParamsFromHeader(content, 'SPARK').params.others).toBe('--master yarn');
  });

  it('--deploy-mode 支持 yarn-cluster / yarn-application 形态的收敛', () => {
    const yarnCluster = headerOf({ 任务参数: '--deploy-mode yarn-cluster' });
    expect(deriveTaskParamsFromHeader(yarnCluster, 'SPARK').params.deployMode).toBe('cluster');
    const bogus = headerOf({ 任务参数: '--deploy-mode whatever' });
    const { params, unmapped } = deriveTaskParamsFromHeader(bogus, 'SPARK');
    // 收敛不了就原样进 others（而不是塞一个 DS 认不出的取值）
    expect(params.deployMode).toBeUndefined();
    expect(params.others).toBe('--deploy-mode whatever');
    expect(unmapped).toEqual([]);
  });

  it('由系统自动生成的字段（--jars / --name）代码头声明不生效，但必须回报', () => {
    const { params, unmapped } = deriveTaskParamsFromHeader(
      headerOf({ 资源参数: '--jars a.jar --name myjob --num-executors 4' }),
      'SPARK',
    );
    expect(params.numExecutors).toBe(4);
    expect(params.others).toBeUndefined();
    expect(unmapped.map(h => h.raw)).toEqual(['--jars a.jar', '--name myjob']);
    for (const hit of unmapped) expect(hit.note).toContain('自动');
  });

  it('数字类字段取值非数字时不写入节点', () => {
    const { params, unmapped } = deriveTaskParamsFromHeader(
      headerOf({ 资源参数: '--num-executors abc' }),
      'SPARK',
    );
    expect(params.numExecutors).toBeUndefined();
    // SPARK 有「其他参数」兜底 → 原样保留
    expect(params.others).toBe('--num-executors abc');
    expect(unmapped).toEqual([]);
  });

  it('声明缺取值时回报（不写入节点）', () => {
    const { params, unmapped } = deriveTaskParamsFromHeader(
      headerOf({ 资源参数: '--num-executors' }),
      'SPARK',
    );
    expect(params.numExecutors).toBeUndefined();
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0].note).toContain('缺少取值');
  });
});

describe('deriveTaskParamsFromHeader — FLINK / FLINK_STREAM', () => {
  it('flink 短选项与 YARN 简写都落到对应字段', () => {
    const content = headerOf({
      引擎: 'flink',
      资源参数: '-p 4 -yjm 1024 -ytm 2048 -ys 2 -yn 3 -yqu root.default',
      任务参数: '-m yarn-cluster -Dyarn.application.name=ods_load',
    });
    const { params } = deriveTaskParamsFromHeader(content, 'FLINK');
    expect(params).toMatchObject({
      parallelism: 4,
      jobManagerMemory: '1024',
      taskManagerMemory: '2048',
      slot: 2,
      taskManager: 3,
      yarnQueue: 'root.default',
      deployMode: 'cluster',
    });
    expect(params.others).toBe('-Dyarn.application.name=ods_load');
  });

  it('flink 的 -c/--class 落到主Class，-d 等原样进「其他参数」', () => {
    const { params } = deriveTaskParamsFromHeader(
      headerOf({ 任务参数: '-c com.demo.OdsLoad -d' }),
      'FLINK',
    );
    expect(params.mainClass).toBe('com.demo.OdsLoad');
    expect(params.others).toBe('-d');
  });

  it('FLINK_STREAM 节点没有「其他参数 / 主参数」字段：未映射声明与程序参数都不静默丢弃', () => {
    const content = headerOf({
      程序参数: '--day 20260501',
      资源参数: '-p 4',
      任务参数: '-Dyarn.application.name=x',
    });
    const { supported, params, unmapped } = deriveTaskParamsFromHeader(content, 'FLINK_STREAM');
    expect(supported).toBe(true);
    expect(params.parallelism).toBe(4);
    expect(params.others).toBeUndefined();
    expect(params.mainArgs).toBeUndefined();
    // 无承载字段的项必须回报；程序参数另有「运行程序」去向，不算漏配
    expect(unmapped.map(h => h.raw)).toEqual(['-Dyarn.application.name=x']);
  });
});

describe('deriveTaskParamsFromHeader — MR / JAVA', () => {
  it('MR：--queue → YARN队列，--class → 主Class，其余进「其他参数」', () => {
    const { params } = deriveTaskParamsFromHeader(
      headerOf({ 资源参数: '--queue root.mr', 任务参数: '--class com.demo.MrJob -Dmapred.job.name=x' }),
      'MR',
    );
    expect(params).toMatchObject({ yarnQueue: 'root.mr', mainClass: 'com.demo.MrJob' });
    expect(params.others).toBe('-Dmapred.job.name=x');
  });

  it('JAVA：--class → 主Class；没有承载字段的声明回报给界面', () => {
    const { params, unmapped } = deriveTaskParamsFromHeader(
      headerOf({ 程序参数: '--env prod', 任务参数: '--class com.demo.Job --queue root.q' }),
      'JAVA',
    );
    expect(params.mainClass).toBe('com.demo.Job');
    expect(params.mainArgs).toBe('--env prod');
    expect(unmapped.map(h => h.raw)).toEqual(['--queue root.q']);
  });
});

describe('deriveTaskParamsFromHeader — 没有承载字段的任务类型（SQL 等）', () => {
  it('SQL：不写节点参数，声明逐条回报（指向「配置参数 → 配置任务参数」）', () => {
    const content = headerOf({
      引擎: 'kyuubi',
      程序参数: '--day 20260501',
      资源参数: '--num-executors 4 --driver-memory 2g --executor-cores 2',
      任务参数: '无',
    });
    const { supported, params, applied, unmapped } = deriveTaskParamsFromHeader(content, 'SQL');

    expect(supported).toBe(false);
    expect(taskTypeSupportsHeaderParams('SQL')).toBe(false);
    expect(params).toEqual({});
    expect(applied).toEqual([]);
    expect(unmapped.map(h => h.raw)).toEqual([
      '--num-executors 4',
      '--driver-memory 2g',
      '--executor-cores 2',
    ]);
    for (const hit of unmapped) expect(hit.note).toContain('配置任务参数');
    // @程序参数 由「运行程序」弹窗消费，属正常去向，不该刷提示
    expect(unmapped.some(hit => hit.from === 'program')).toBe(false);
  });

  it('未声明的字段（缺 @资源参数 / 写「无」）不产生任何提示', () => {
    const { params, unmapped } = deriveTaskParamsFromHeader(
      headerOf({ 引擎: 'kyuubi', 资源参数: '无', 任务参数: '无' }),
      'SQL',
    );
    expect(params).toEqual({});
    expect(unmapped).toEqual([]);
  });
});

describe('appliedHeaderParamKeys', () => {
  it('按写入顺序给出节点参数名（去重；原样进 others 的项只算一次）', () => {
    const { applied } = deriveTaskParamsFromHeader(
      headerOf({
        程序参数: '--day 20260501',
        资源参数: '--num-executors 4 --driver-memory 2g',
        任务参数: '--master yarn --deploy-mode cluster',
      }),
      'SPARK',
    );
    const derivation = { supported: true, params: {}, applied, unmapped: [] };
    expect(appliedHeaderParamKeys(derivation)).toEqual([
      'numExecutors',
      'driverMemory',
      'others',
      'deployMode',
      'mainArgs',
    ]);
  });
});
