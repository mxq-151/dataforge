import { describe, it, expect } from 'vitest';
import {
  LINEAGE_ENABLED_KEY, LINEAGE_NAMESPACE_KEY, LINEAGE_PARAM_PREFIX, LINEAGE_TRANSPORT_URL_KEY,
  buildOpenLineageArgs, extractLineageParams, isLineageParamKey,
} from './lineageParams';

/**
 * 数据血缘（OpenLineage）参数的拼装口径 —— 单文件与文件夹两个提交入口共用的唯一实现。
 *
 * 两道闸门：① 环境硬闸门（只有生产注入，非生产下文件级配置也无法打开）；
 * ② 生产环境下的文件级开关（lineage.enabled=false 关闭，未配置视为开启）。
 * 这里把闸门优先级、取值来源与参数顺序全部钉住。
 */

describe('lineageParams — 血缘保留参数的识别与提取', () => {
  it('只认 lineage. 前缀', () => {
    expect(isLineageParamKey(LINEAGE_ENABLED_KEY)).toBe(true);
    expect(isLineageParamKey(LINEAGE_TRANSPORT_URL_KEY)).toBe(true);
    expect(isLineageParamKey(LINEAGE_NAMESPACE_KEY)).toBe(true);
    expect(isLineageParamKey('driverMemory')).toBe(false);
    expect(isLineageParamKey('lineage')).toBe(false);
    expect(isLineageParamKey('')).toBe(false);
  });

  it('前缀常量与 key 常量一致（避免前缀改了 key 没跟着改）', () => {
    expect(LINEAGE_ENABLED_KEY).toBe(`${LINEAGE_PARAM_PREFIX}enabled`);
    expect(LINEAGE_TRANSPORT_URL_KEY).toBe(`${LINEAGE_PARAM_PREFIX}transportUrl`);
    expect(LINEAGE_NAMESPACE_KEY).toBe(`${LINEAGE_PARAM_PREFIX}namespace`);
  });

  it('从文件配置的 taskParams 里只挑出血缘项，其余原样忽略', () => {
    const cfg = extractLineageParams([
      { key: 'driverMemory', value: '2g' },
      { key: LINEAGE_ENABLED_KEY, value: 'false' },
      { key: 'numExecutors', value: '4' },
      { key: LINEAGE_TRANSPORT_URL_KEY, value: 'http://ol:5000' },
    ]);

    expect(cfg).toEqual({
      [LINEAGE_ENABLED_KEY]: 'false',
      [LINEAGE_TRANSPORT_URL_KEY]: 'http://ol:5000',
    });
  });

  it('空配置 / null 输入返回空对象（文件没配过血缘时的常态）', () => {
    expect(extractLineageParams([])).toEqual({});
    expect(extractLineageParams(null)).toEqual({});
    expect(extractLineageParams(undefined)).toEqual({});
  });
});

describe('lineageParams — 环境硬闸门：只有生产环境注入', () => {
  it('测试 / 灰度环境返回空数组，且不带任何 spark.openlineage 参数', () => {
    for (const env of ['test', 'gray'] as const) {
      expect(buildOpenLineageArgs({ env, projectCode: 'demo', globalTransportUrl: 'http://ol:5000' }))
        .toEqual([]);
    }
  });

  it('非生产环境下文件级 lineage.enabled=true 也打不开（环境优先，配置翻不了盘）', () => {
    expect(buildOpenLineageArgs({
      env: 'test',
      projectCode: 'demo',
      fileLineage: { [LINEAGE_ENABLED_KEY]: 'true' },
    })).toEqual([]);
  });

  it('非生产环境下连 transportUrl 覆盖也无效', () => {
    expect(buildOpenLineageArgs({
      env: 'gray',
      projectCode: 'demo',
      fileLineage: { [LINEAGE_TRANSPORT_URL_KEY]: 'http://ol:5000' },
    })).toEqual([]);
  });
});

describe('lineageParams — 生产环境：注入内容与取值来源', () => {
  it('默认三项 + transport.url + namespace，顺序固定且各占一个 --conf', () => {
    const args = buildOpenLineageArgs({
      env: 'prod',
      projectCode: 'demo',
      globalTransportUrl: 'http://ol:5000',
    });

    expect(args).toEqual([
      '--conf spark.extraListeners=io.openlineage.spark.agent.OpenLineageSparkListener',
      '--conf spark.openlineage.transport.type=http',
      '--conf spark.openlineage.transport.url=http://ol:5000',
      '--conf spark.openlineage.namespace=demo',
    ]);
  });

  it('transport.url 取文件级优先、其次设置页全局值', () => {
    const withFile = buildOpenLineageArgs({
      env: 'prod',
      projectCode: 'demo',
      globalTransportUrl: 'http://global:5000',
      fileLineage: { [LINEAGE_TRANSPORT_URL_KEY]: 'http://file:5000' },
    });
    const withGlobal = buildOpenLineageArgs({
      env: 'prod',
      projectCode: 'demo',
      globalTransportUrl: 'http://global:5000',
      fileLineage: { [LINEAGE_TRANSPORT_URL_KEY]: '' },
    });

    expect(withFile).toContain('--conf spark.openlineage.transport.url=http://file:5000');
    expect(withGlobal).toContain('--conf spark.openlineage.transport.url=http://global:5000');
  });

  it('namespace 取文件级优先、其次项目编码', () => {
    expect(buildOpenLineageArgs({
      env: 'prod',
      projectCode: 'demo',
      fileLineage: { [LINEAGE_NAMESPACE_KEY]: 'custom_ns' },
    })).toContain('--conf spark.openlineage.namespace=custom_ns');
  });

  it('缺 transportUrl 时该项不出现（其余照常），缺项目编码时命名空间也不出现', () => {
    const noUrl = buildOpenLineageArgs({ env: 'prod', projectCode: 'demo' });
    expect(noUrl).not.toContain('--conf spark.openlineage.transport.url=');
    expect(noUrl).toHaveLength(3);

    const bare = buildOpenLineageArgs({ env: 'prod' });
    expect(bare).toHaveLength(2);
  });

  it('taskTypeSupportsLineage=false（非 SPARK 任务）直接不注入', () => {
    expect(buildOpenLineageArgs({
      env: 'prod', projectCode: 'demo', taskTypeSupportsLineage: false,
    })).toEqual([]);
  });
});

describe('lineageParams — 生产环境下的文件级开关', () => {
  it('lineage.enabled=false 关闭注入（未配置视为开启，保持默认行为）', () => {
    expect(buildOpenLineageArgs({
      env: 'prod',
      projectCode: 'demo',
      fileLineage: { [LINEAGE_ENABLED_KEY]: 'false' },
    })).toEqual([]);
  });

  it('lineage.enabled=true / 未配置 / 取值非 false 均照常注入', () => {
    const cases: (Record<string, string> | null | undefined)[] = [
      { [LINEAGE_ENABLED_KEY]: 'true' },
      {},
      null,
      undefined,
      { [LINEAGE_ENABLED_KEY]: 'yes' },
    ];
    cases.forEach(fileLineage => {
      expect(buildOpenLineageArgs({ env: 'prod', projectCode: 'demo', fileLineage })).toHaveLength(3);
    });
  });
});
