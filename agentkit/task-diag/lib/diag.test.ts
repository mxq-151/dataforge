// @vitest-environment node
/**
 * task-diag 的结构性用例。
 *
 * 覆盖的是「确定性部分」：引擎画像完整性、路由表、作用域票据、channelKey 幂等、
 * 结论钳制、command 预设的取证顺序。
 *
 * 不覆盖、也不应被当成已验证的：真实 Spark / Flink / 各引擎日志源联调。
 * 环境齐了要单独跑一次「真实通道可用性」验证，本文件不能替代它。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ALL_ENGINES,
  ENGINE_AGENT,
  ENGINE_PROFILES,
  channelKeyOf,
  channelRefStatus,
  channelsOf,
  clampVerdict,
  hasEngineAgent,
  levelAtMost,
  profileOf,
} from './constants';
import { assertChannel, assertEngine, buildScope, saveEvidencePack } from './scope';
import { fingerprint, normalizeLine } from './signature';
import type { EvidencePack } from './schema';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const KIT_ROOT = path.resolve(HERE, '..');

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function readFile(relative: string): string {
  return fs.readFileSync(path.join(KIT_ROOT, relative), 'utf8');
}

function sparkScope(available: string[]) {
  return buildScope({
    runId: '20261115T100000-spark-abcd',
    engine: 'spark',
    mode: 'FAILED',
    target: {
      engine: 'spark',
      cluster: 'default',
      deployMode: 'cluster',
      ref: { applicationId: 'application_1_1', appId: 'application_1_1' },
    },
    availableChannelIds: available,
    unavailable: [{ id: 'spark-executor-log', reason: '日志源未配置' }],
    calls: 10,
  });
}

describe('引擎画像', () => {
  it('九个引擎全部登记，且与 ALL_ENGINES 一一对应', () => {
    expect(Object.keys(ENGINE_PROFILES).sort()).toEqual([...ALL_ENGINES].sort());
    expect(Object.keys(ENGINE_AGENT)).toHaveLength(9);
  });

  it('每个引擎都有 agent 文件与两个 command 预设', () => {
    for (const engine of ALL_ENGINES) {
      const profile = ENGINE_PROFILES[engine];
      expect(fs.existsSync(path.join(KIT_ROOT, 'agent', `${profile.agent}.md`))).toBe(true);
      for (const mode of ['failed', 'slow']) {
        const file = path.join(KIT_ROOT, 'command', `diag-${engine}-${mode}.md`);
        expect(fs.existsSync(file), `缺少 ${file}`).toBe(true);
      }
    }
  });

  it('每个 command 都落到编排器，不能直连引擎 subagent', () => {
    const files = fs.readdirSync(path.join(KIT_ROOT, 'command'));
    expect(files).toHaveLength(19);
    for (const file of files) {
      const text = readFile(path.join('command', file));
      expect(text, file).toMatch(/^agent:\s*diag-orchestrator$/m);
    }
  });

  it('降级链只能引用本引擎通道或已知的 runtime/handoff 步骤', () => {
    for (const engine of ALL_ENGINES) {
      const profile = ENGINE_PROFILES[engine];
      const ids = new Set(profile.channels.map(c => c.id));
      for (const step of profile.degradeChain) {
        const ok = ids.has(step) || /^runtime:(snapshot|compare)$/.test(step) || /^handoff:/.test(step);
        expect(ok, `${engine} 的降级链出现未知步骤 ${step}`).toBe(true);
      }
    }
  });

  it('每条缺口都给出 neededInterface，不能只写「缺少能力」', () => {
    for (const engine of ALL_ENGINES) {
      for (const gap of ENGINE_PROFILES[engine].gaps) {
        expect(gap.neededInterface.length, `${engine}/${gap.signal}`).toBeGreaterThan(8);
        expect(gap.neededInterface).not.toBe('（未给出）');
      }
    }
  });

  it('没有指标的引擎不得声称 job/executor 级证据', () => {
    for (const engine of ALL_ENGINES) {
      const profile = ENGINE_PROFILES[engine];
      expect(profile.families.length > 0).toBe(profile.evidenceTier === 'job-executor' || profile.evidenceTier === 'job-vertex-tm');
    }
    expect(ENGINE_PROFILES.doris.evidenceTier).toBe('process-log');
    expect(ENGINE_PROFILES.kafka.evidenceTier).toBe('process-log');
    expect(ENGINE_PROFILES.pulsar.evidenceTier).toBe('process-log');
  });

  it('Hudi 无自有通道，只靠 spark 交接', () => {
    expect(ENGINE_PROFILES.hudi.channels).toHaveLength(0);
    expect(ENGINE_PROFILES.hudi.handoffFrom).toBe('spark');
    expect(ENGINE_PROFILES.hudi.degradeChain).toContain('handoff:spark');
  });

  it('StarRocks 只保留配置层路径，上限 L4', () => {
    expect(ENGINE_PROFILES.starrocks.configOnly).toBe(true);
    expect(ENGINE_PROFILES.starrocks.ceiling).toBe('L4');
    expect(ENGINE_PROFILES.starrocks.channels.length).toBeGreaterThan(0);
  });

  it('未登记类型不路由', () => {
    expect(hasEngineAgent('presto')).toBe(false);
    expect(profileOf('trino')).toBeNull();
    expect(channelsOf('trino')).toEqual([]);
  });

  it('编排器路由表覆盖全部九个引擎', () => {
    const text = readFile('agent/diag-orchestrator.md');
    for (const engine of ALL_ENGINES) {
      expect(text).toContain(`diag-${engine}`);
    }
  });
});

describe('作用域票据', () => {
  it('只授权能力表里可用的通道', () => {
    const scope = sparkScope(['yarn-am']);
    expect(scope.allowedChannels).toHaveLength(1);
    expect(scope.allowedChannels[0].componentId).toBe('spark.driver');
    expect(scope.allowedChannels[0].dataTypeId).toBe('log.task');
    expect(scope.allowedChannels[0].stream).toBe('stdout');
    expect(scope.forbiddenChannels.map(f => f.channelKey)).toContain(
      'spark|spark.executor|cluster|log.service|stderr',
    );
  });

  it('已授权通道放行', () => {
    const scope = sparkScope(['yarn-am']);
    expect(() =>
      assertChannel(scope, {
        serviceType: 'spark',
        componentId: 'spark.driver',
        hostId: 'cluster',
        dataTypeId: 'log.task',
        stream: 'stdout',
      }),
    ).not.toThrow();
  });

  it('跨引擎通道被拒绝（D04），不是「不可用」', () => {
    const scope = sparkScope(['yarn-am']);
    expect(() =>
      assertChannel(scope, {
        serviceType: 'flink',
        componentId: 'flink.jobmanager',
        hostId: 'cluster',
        dataTypeId: 'log.service',
        stream: 'stdout',
      }),
    ).toThrow(/D04_SCOPE_DENIED/);
  });

  it('本引擎但未授权的通道被拒绝（D10）', () => {
    const scope = sparkScope(['yarn-am']);
    expect(() =>
      assertChannel(scope, {
        serviceType: 'spark',
        componentId: 'spark.executor',
        hostId: 'cluster',
        dataTypeId: 'log.service',
        stream: 'stderr',
      }),
    ).toThrow(/D10_CHANNEL_UNAVAILABLE/);
  });

  it('引擎不匹配直接拒绝', () => {
    const scope = sparkScope(['yarn-am']);
    expect(() => assertEngine(scope, 'flink')).toThrow(/D04_SCOPE_DENIED/);
    expect(() => assertEngine(scope, 'spark')).not.toThrow();
  });
});

describe('channelKey 与幂等落盘', () => {
  function pack(step: string): EvidencePack {
    return {
      runId: '20261115T100000-spark-abcd',
      engine: 'spark',
      step,
      fingerprintVersion: 'sig-1',
      scan: { bytes: 100, lines: 10, pages: 1, truncated: false, degraded: false },
      signatures: [],
      metrics: [],
      facts: [],
      gaps: [],
      createdAt: '2026-11-15T10:00:00.000Z',
    };
  }

  it('channelKey 对 ref 键顺序不敏感，对 ref 值与 stream 敏感', () => {
    const base = {
      serviceType: 'spark',
      componentId: 'spark.driver',
      hostId: 'cluster',
      dataTypeId: 'log.task',
      stream: 'stdout',
    };
    const a = channelKeyOf({ ...base, ref: { applicationId: 'x', taskId: 'application_1_2' } });
    const b = channelKeyOf({ ...base, ref: { taskId: 'application_1_2', applicationId: 'x' } });
    const c = channelKeyOf({ ...base, ref: { applicationId: 'y', taskId: 'application_1_2' } });
    const d = channelKeyOf({ ...base, stream: 'stderr', ref: { applicationId: 'x', taskId: 'application_1_2' } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  it('log.task 要求 jobName/jobId，log.service 只要求 refKey', () => {
    const task = { dataTypeId: 'log.task', requiredAnyRefs: ['jobName', 'jobId'] };
    expect(channelRefStatus(task, {}).ok).toBe(false);
    expect(channelRefStatus(task, { jobId: 'a4f1a1a028310ef81f8f912eff920595' }).ok).toBe(true);
    expect(channelRefStatus(task, { applicationId: 'application_1_2' }).ok).toBe(true);
    expect(channelRefStatus(task, {}, 'task-name').ok).toBe(true);

    const service = { dataTypeId: 'log.service', refKey: 'jobId' };
    expect(channelRefStatus(service, {}).ok).toBe(false);
    expect(channelRefStatus(service, { jobId: 'x' }).ok).toBe(true);
  });

  it('同一 dedupeKey 第二次落盘复用原文件，不再写新文件', () => {
    const first = saveEvidencePack(root, '20261115T100000-spark-abcd', 's2-yarn-am', pack('s2-yarn-am'), 'yarn|aggregate|application_master');
    const second = saveEvidencePack(root, '20261115T100000-spark-abcd', 's2-yarn-am', pack('s2-yarn-am'), 'yarn|aggregate|application_master');
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.path).toBe(first.path);

    const dir = path.join(root, '.diag', 'runs', '20261115T100000-spark-abcd', 'evidence');
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it('不同 dedupeKey 落成不同文件', () => {
    const a = saveEvidencePack(root, '20261115T100000-spark-abcd', 's2-yarn-am', pack('s2-yarn-am'), 'key-a');
    const b = saveEvidencePack(root, '20261115T100000-spark-abcd', 's2-yarn-am', pack('s2-yarn-am'), 'key-b');
    expect(a.path).not.toBe(b.path);
  });
});

describe('结论钳制', () => {
  it('UNRESOLVED 一律 L4', () => {
    expect(clampVerdict({ category: 'UNRESOLVED', level: 'L1', confidence: 0.9, ceiling: 'L1' }).level).toBe('L4');
  });

  it('超过引擎上限时下调', () => {
    const result = clampVerdict({ category: 'CODE', level: 'L1', confidence: 0.9, ceiling: 'L3' });
    expect(result.level).toBe('L3');
    expect(result.notes.join()).toContain('上限');
  });

  it('置信度不足时不得停在 L1/L2', () => {
    expect(clampVerdict({ category: 'CODE', level: 'L1', confidence: 0.3, ceiling: 'L1' }).level).toBe('L3');
    expect(clampVerdict({ category: 'CODE', level: 'L2', confidence: 0.49, ceiling: 'L1' }).level).toBe('L3');
  });

  it('在上限内且置信度足够时不动', () => {
    expect(clampVerdict({ category: 'CODE', level: 'L3', confidence: 0.8, ceiling: 'L3' }).level).toBe('L3');
    expect(clampVerdict({ category: 'CODE', level: 'L2', confidence: 0.6, ceiling: 'L1' }).level).toBe('L2');
  });

  it('levelAtMost 语义：数值越小越确定', () => {
    expect(levelAtMost('L3', 'L1')).toBe(true);
    expect(levelAtMost('L2', 'L3')).toBe(false);
  });
});

describe('日志指纹', () => {
  it('时间戳/线程/路径/长数字被归一化，异常类名保留', () => {
    const a = normalizeLine('2026-11-15 09:12:03,123 [main] ERROR c.b.Foo - failed at /data/app/x.jar id=123456789');
    const b = normalizeLine('2026-11-15 09:27:44,999 [pool-2] ERROR c.b.Foo - failed at /opt/app/y.jar id=987654321');
    expect(a).toBe(b);
    expect(a).toContain('ERROR');
    expect(normalizeLine('java.lang.OutOfMemoryError: Java heap space')).toContain('OutOfMemoryError');
  });

  it('同类错误合并计数，并按次数降序', () => {
    const lines = [
      '2026-11-15 09:00:00 INFO start',
      '2026-11-15 09:01:00 ERROR java.lang.NullPointerException at a.b.C',
      '2026-11-15 09:02:00 ERROR java.lang.NullPointerException at a.b.C',
      '2026-11-15 09:03:00 ERROR java.sql.SQLException: timeout',
    ];
    const result = fingerprint(lines, { maxSignatures: 10, samplesPerSignature: 2 });
    expect(result.signatures[0].count).toBe(2);
    expect(result.signatures[0].exceptionClass).toBe('java.lang.NullPointerException');
    expect(result.version).toBe('sig-1');
  });
});

describe('command 预设的取证顺序', () => {
  it('失败类命令要求日志优先', () => {
    for (const engine of ALL_ENGINES) {
      const text = readFile(path.join('command', `diag-${engine}-failed.md`));
      expect(text).toContain('日志优先');
      expect(text).toContain(`mode:"FAILED"`);
    }
  });

  it('变慢类命令要求指标优先', () => {
    for (const engine of ALL_ENGINES) {
      const text = readFile(path.join('command', `diag-${engine}-slow.md`));
      expect(text).toContain('指标优先');
      expect(text).toContain(`mode:"SLOW"`);
    }
  });
});
