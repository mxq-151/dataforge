import { describe, it, expect } from 'vitest';
import { buildJarsArg, mapCodeFileToTask, type SavedConfig, reconcileWorkflowDependencies, findDependencyCycle, dependentNodeName, layoutWorkflowByDependency, GRID_START_X, GRID_START_Y, GRID_GAP_X, GRID_GAP_Y, type HeaderDependency } from './schedulerMapping';
import type { DSWorkflowTaskNode, DSWorkflowEdge } from '../types/dolphinscheduler';

function mkNode(code: number, name: string, taskType = 'SPARK'): DSWorkflowTaskNode {
  return {
    code,
    name,
    taskType: taskType as DSWorkflowTaskNode['taskType'],
    description: '',
    taskParams: '{}',
    flag: 'YES',
    taskPriority: 'MEDIUM',
    workerGroup: 'default',
    environmentCode: -1,
    failRetryTimes: 0,
    failRetryInterval: 1,
    timeoutFlag: 'CLOSE',
    timeout: 0,
    delayTime: 0,
    x: 100,
    y: 100,
  };
}

function edge(src: number, dst: number): DSWorkflowEdge {
  return { id: `e_${src}_${dst}`, sourceCode: src, targetCode: dst };
}

/** 简易跨工作流解析器：taskName -> code */
function mkResolver(index: Map<string, number>) {
  return async (labels: Set<string>) => {
    const result = new Map();
    for (const label of labels) {
      const taskName = label.includes('.') ? label.slice(label.indexOf('.') + 1) : label;
      const code = index.get(taskName);
      if (code != null) {
        result.set(label, { projectCode: 1, definitionCode: 900, taskCode: code, taskName, label });
      }
    }
    return result;
  };
}

function mkLocalDeps(entries: Record<string, string>): Map<string, HeaderDependency[]> {
  const map = new Map<string, HeaderDependency[]>();
  for (const [task, depStr] of Object.entries(entries)) {
    const deps: HeaderDependency[] = (depStr && depStr !== '无')
      ? depStr.split(',').map(t => {
          const dot = t.indexOf('.');
          return dot >= 0 ? { projectCode: t.slice(0, dot), taskName: t.slice(dot + 1) } : { projectCode: '', taskName: t };
        })
      : [];
    map.set(task, deps);
  }
  return map;
}

describe('reconcileWorkflowDependencies — 依赖关系重建', () => {
  it('同工作流内 A->B、C->D 两条独立链，不被串成 A->B->C->D', async () => {
    // 工作流已有 A、B（B 依赖 A），本次提交 D（依赖 C），C 为无依赖任务
    const nodes = [mkNode(1, 'A'), mkNode(2, 'B'), mkNode(3, 'C'), mkNode(4, 'D')];
    const edges = [edge(1, 2)]; // A->B
    const localDeps = mkLocalDeps({ A: '无', B: 'A', C: '无', D: 'C' });

    const res = await reconcileWorkflowDependencies({
      nodes,
      edges,
      localHeaderDeps: localDeps,
      mainTaskName: 'D',
      resolvedLabels: new Map(),
      resolveExternalDeps: mkResolver(new Map()),
      allocateCode: (() => { let c = 100; return () => c++; })(),
      nextSlot: (() => { let i = 0; return () => ({ x: 300 + i++ * 450, y: 140 }); })(),
    });

    expect(res.edges.map(e => `${e.sourceCode}->${e.targetCode}`).sort()).toEqual(['1->2', '3->4']);
    expect(res.nodes.map(n => n.name).sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(res.warnings).toEqual([]);
  });

  it('清除旧逻辑遗留的错误串行边（A->B->C->D 修正为 A->B、C->D）', async () => {
    // 模拟旧版串行连接产生的工作流：A->B->C->D，本地代码头声明 B 依赖 A、D 依赖 C
    const nodes = [mkNode(1, 'A'), mkNode(2, 'B'), mkNode(3, 'C'), mkNode(4, 'D')];
    const edges = [edge(1, 2), edge(2, 3), edge(3, 4)];
    const localDeps = mkLocalDeps({ A: '无', B: 'A', C: '无', D: 'C' });

    const res = await reconcileWorkflowDependencies({
      nodes,
      edges,
      localHeaderDeps: localDeps,
      mainTaskName: 'D',
      resolvedLabels: new Map(),
      resolveExternalDeps: mkResolver(new Map()),
      allocateCode: (() => { let c = 100; return () => c++; })(),
      nextSlot: (() => { let i = 0; return () => ({ x: 300 + i++ * 450, y: 140 }); })(),
    });

    expect(res.edges.map(e => `${e.sourceCode}->${e.targetCode}`).sort()).toEqual(['1->2', '3->4']);
  });

  it('跨工作流依赖：每个任务使用专属前置依赖节点，互不覆盖', async () => {
    // 工作流内 dim_campaign（依赖外部 ods_campaign）与 dim_creative（依赖外部 ods_ads）并存
    const externalIndex = new Map([['ods_campaign_load_f', 501], ['ods_ads_load_f', 502]]);
    const nodes = [mkNode(11, 'dim_campaign_load_f'), mkNode(12, 'dim_creative_load_f')];
    const edges: DSWorkflowEdge[] = [];
    const localDeps = mkLocalDeps({
      dim_campaign_load_f: 'proj.ods_campaign_load_f',
      dim_creative_load_f: 'proj.ods_ads_load_f',
    });

    const res = await reconcileWorkflowDependencies({
      nodes,
      edges,
      localHeaderDeps: localDeps,
      mainTaskName: 'dim_creative_load_f',
      resolvedLabels: new Map(),
      resolveExternalDeps: mkResolver(externalIndex),
      allocateCode: (() => { let c = 100; return () => c++; })(),
      nextSlot: (() => { let i = 0; return () => ({ x: 300 + i++ * 450, y: 140 }); })(),
    });

    const depNodes = res.nodes.filter(n => n.taskType === 'DEPENDENT');
    expect(depNodes.map(n => n.name).sort()).toEqual([
      '前置依赖_dim_campaign_load_f',
      '前置依赖_dim_creative_load_f',
    ]);
    // 每个专属前置依赖节点只指向自己的目标任务
    const byName = new Map(res.nodes.map(n => [n.name, n] as const));
    const campaignDep = byName.get('前置依赖_dim_campaign_load_f')!;
    const creativeDep = byName.get('前置依赖_dim_creative_load_f')!;
    expect(res.edges).toContainEqual(expect.objectContaining({ sourceCode: campaignDep.code, targetCode: 11 }));
    expect(res.edges).toContainEqual(expect.objectContaining({ sourceCode: creativeDep.code, targetCode: 12 }));
    // 两个 DEPENDENT 节点的依赖内容各自正确
    expect(JSON.parse(campaignDep.taskParams).dependence.dependTaskList[0].dependItemList[0].depTaskCode).toBe(501);
    expect(JSON.parse(creativeDep.taskParams).dependence.dependTaskList[0].dependItemList[0].depTaskCode).toBe(502);
  });

  it('提交无依赖任务时不再误删其他任务的依赖（旧版共享节点缺陷）', async () => {
    // 工作流内 B（依赖 A）已就绪，本次提交无依赖任务 C
    const nodes = [mkNode(1, 'A'), mkNode(2, 'B'), mkNode(3, 'C')];
    const edges = [edge(1, 2)];
    const localDeps = mkLocalDeps({ A: '无', B: 'A', C: '无' });

    const res = await reconcileWorkflowDependencies({
      nodes,
      edges,
      localHeaderDeps: localDeps,
      mainTaskName: 'C',
      resolvedLabels: new Map(),
      resolveExternalDeps: mkResolver(new Map()),
      allocateCode: (() => { let c = 100; return () => c++; })(),
      nextSlot: (() => { let i = 0; return () => ({ x: 300 + i++ * 450, y: 140 }); })(),
    });

    expect(res.edges).toEqual([edge(1, 2)]);
  });

  it('清理旧版共享「前置依赖」节点与孤儿 DEPENDENT 节点', async () => {
    // 旧版遗留：共享「前置依赖」节点指向 B，但 B 的代码头依赖的是同工作流任务 A
    const sharedDep = { ...mkNode(90, '前置依赖', 'DEPENDENT'), taskParams: '{}' };
    const nodes = [mkNode(1, 'A'), mkNode(2, 'B'), sharedDep];
    const edges = [edge(90, 2)];
    const localDeps = mkLocalDeps({ A: '无', B: 'A' });

    const res = await reconcileWorkflowDependencies({
      nodes,
      edges,
      localHeaderDeps: localDeps,
      mainTaskName: 'B',
      resolvedLabels: new Map(),
      resolveExternalDeps: mkResolver(new Map()),
      allocateCode: (() => { let c = 100; return () => c++; })(),
      nextSlot: (() => { let i = 0; return () => ({ x: 300 + i++ * 450, y: 140 }); })(),
    });

    // B 的依赖被重建为直接边 A->B，共享节点无出边被清理
    expect(res.edges.map(e => `${e.sourceCode}->${e.targetCode}`)).toEqual(['1->2']);
    expect(res.nodes.map(n => n.name).sort()).toEqual(['A', 'B']);
  });

  it('更新任务依赖：由 A 改为 C 时替换入边；去掉全部依赖时清空入边', async () => {
    const nodes = [mkNode(1, 'A'), mkNode(2, 'B'), mkNode(3, 'C')];
    const edges = [edge(1, 2)];
    // B 的依赖从 A 改为 C
    let localDeps = mkLocalDeps({ A: '无', B: 'C', C: '无' });
    let res = await reconcileWorkflowDependencies({
      nodes, edges, localHeaderDeps: localDeps, mainTaskName: 'B',
      resolvedLabels: new Map(), resolveExternalDeps: mkResolver(new Map()),
      allocateCode: (() => { let c = 100; return () => c++; })(),
      nextSlot: (() => { let i = 0; return () => ({ x: 300 + i++ * 450, y: 140 }); })(),
    });
    expect(res.edges.map(e => `${e.sourceCode}->${e.targetCode}`)).toEqual(['3->2']);

    // B 的依赖改为无
    localDeps = mkLocalDeps({ A: '无', B: '无', C: '无' });
    res = await reconcileWorkflowDependencies({
      nodes, edges: res.edges, localHeaderDeps: localDeps, mainTaskName: 'B',
      resolvedLabels: new Map(), resolveExternalDeps: mkResolver(new Map()),
      allocateCode: (() => { let c = 100; return () => c++; })(),
      nextSlot: (() => { let i = 0; return () => ({ x: 300 + i++ * 450, y: 140 }); })(),
    });
    expect(res.edges).toEqual([]);
  });

  it('本地不存在对应文件的任务保持原有边不变', async () => {
    const nodes = [mkNode(1, 'A'), mkNode(2, 'B'), mkNode(3, 'Manual')];
    const edges = [edge(1, 2), edge(2, 3)];
    // 本地只有 A、B 的文件，Manual 为用户手工维护任务
    const localDeps = mkLocalDeps({ A: '无', B: 'A' });

    const res = await reconcileWorkflowDependencies({
      nodes, edges, localHeaderDeps: localDeps, mainTaskName: 'B',
      resolvedLabels: new Map(), resolveExternalDeps: mkResolver(new Map()),
      allocateCode: (() => { let c = 100; return () => c++; })(),
      nextSlot: (() => { let i = 0; return () => ({ x: 300 + i++ * 450, y: 140 }); })(),
    });

    expect(res.edges.map(e => `${e.sourceCode}->${e.targetCode}`).sort()).toEqual(['1->2', '2->3']);
  });

  it('自依赖声明产生告警并被忽略', async () => {
    const nodes = [mkNode(1, 'A')];
    const localDeps = mkLocalDeps({ A: 'A' });
    const res = await reconcileWorkflowDependencies({
      nodes, edges: [], localHeaderDeps: localDeps, mainTaskName: 'A',
      resolvedLabels: new Map(), resolveExternalDeps: mkResolver(new Map()),
      allocateCode: (() => { let c = 100; return () => c++; })(),
      nextSlot: (() => { let i = 0; return () => ({ x: 300 + i++ * 450, y: 140 }); })(),
    });
    expect(res.edges).toEqual([]);
    expect(res.warnings.some(w => w.includes('自身'))).toBe(true);
  });
});

describe('findDependencyCycle — 依赖环检测', () => {
  it('无环时返回 null', () => {
    const nodes = [mkNode(1, 'A'), mkNode(2, 'B'), mkNode(3, 'C')];
    expect(findDependencyCycle(nodes, [edge(1, 2), edge(1, 3)])).toBeNull();
  });

  it('检测出环并返回任务名路径', () => {
    const nodes = [mkNode(1, 'A'), mkNode(2, 'B'), mkNode(3, 'C')];
    const cycle = findDependencyCycle(nodes, [edge(1, 2), edge(2, 3), edge(3, 1)]);
    expect(cycle).not.toBeNull();
    expect(new Set(cycle!)).toEqual(new Set(['A', 'B', 'C']));
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
  });
});

describe('dependentNodeName', () => {
  it('生成任务专属前置依赖节点名', () => {
    expect(dependentNodeName('dwd_ad_event_detail_etl_f')).toBe('前置依赖_dwd_ad_event_detail_etl_f');
  });
});

describe('buildJarsArg', () => {
  it('jarPath 为目录时拼接 jarPath(去尾斜杠) + jarName', () => {
    expect(buildJarsArg([
      { jarPath: '/opt/jars/', jarName: 'my-udf.jar' },
    ])).toBe('/opt/jars/my-udf.jar');
  });

  it('jarPath 无尾斜杠时正常拼接', () => {
    expect(buildJarsArg([
      { jarPath: 'hdfs:///jars', jarName: 'lib-a.jar' },
    ])).toBe('hdfs:///jars/lib-a.jar');
  });

  it('jarPath 以 .jar 结尾时视为完整文件路径直接使用', () => {
    expect(buildJarsArg([
      { jarPath: '/opt/custom/lib-b.jar', jarName: 'lib-b.jar' },
    ])).toBe('/opt/custom/lib-b.jar');
  });

  it('jarName 缺失时回退到 name', () => {
    expect(buildJarsArg([
      { jarPath: '/opt/jars/', name: 'fallback.jar' },
    ])).toBe('/opt/jars/fallback.jar');
  });

  it('多个依赖以逗号连接', () => {
    expect(buildJarsArg([
      { jarPath: '/opt/jars/', jarName: 'a.jar' },
      { jarPath: 'hdfs:///jars', jarName: 'b.jar' },
      { jarPath: '/full/c.jar', jarName: 'c.jar' },
    ])).toBe('/opt/jars/a.jar,hdfs:///jars/b.jar,/full/c.jar');
  });

  it('无 jarPath 或无文件名的条目被忽略', () => {
    expect(buildJarsArg([
      { jarPath: '', jarName: 'a.jar' },
      { jarPath: '/opt/jars/', jarName: '' },
      { jarPath: '/opt/jars/', jarName: '  ' },
      {},
    ])).toBe('');
  });

  it('空输入返回空字符串', () => {
    expect(buildJarsArg([])).toBe('');
  });
});

describe('buildJarsArg — basePath/jarPath 组成', () => {
  it('basePath + jarPath 拼接（jarPath 为相对路径含文件名）', () => {
    expect(buildJarsArg([
      { basePath: '/opt/dataforge/jars', jarPath: 'udf/my-udf.jar' },
    ])).toBe('/opt/dataforge/jars/udf/my-udf.jar');
  });

  it('basePath 已带尾斜杠时不重复加 /', () => {
    expect(buildJarsArg([
      { basePath: 'hdfs:///user/jars/', jarPath: 'a.jar' },
    ])).toBe('hdfs:///user/jars/a.jar');
  });

  it('jarPath 带前导斜杠时去掉，避免 basePath 双斜杠', () => {
    expect(buildJarsArg([
      { basePath: '/opt/jars', jarPath: '/my-udf.jar' },
    ])).toBe('/opt/jars/my-udf.jar');
  });

  it('多个依赖 basePath/jarPath 以逗号连接', () => {
    expect(buildJarsArg([
      { basePath: '/opt/jars', jarPath: 'a.jar' },
      { basePath: 'hdfs:///jars', jarPath: 'udf/b.jar' },
    ])).toBe('/opt/jars/a.jar,hdfs:///jars/udf/b.jar');
  });

  it('有 basePath 时 jarPath 以 .jar 结尾同样按 basePath 拼接（而非当完整路径）', () => {
    expect(buildJarsArg([
      { basePath: '/opt/jars', jarPath: 'lib-b.jar' },
    ])).toBe('/opt/jars/lib-b.jar');
  });

  it('有 basePath 但无 jarPath 的条目被忽略', () => {
    expect(buildJarsArg([
      { basePath: '/opt/jars', jarPath: '' },
      { basePath: '/opt/jars' },
    ])).toBe('');
  });
});

describe('mapCodeFileToTask — 配置依赖通过 --jars 跟随提交', () => {
  const sparkScalaContent = `/*
 * @备注: 测试 Spark 任务
 * @引擎: spark
 * @数据源: test_datasource
 */
object TestApp {
  def main(args: Array[String]): Unit = {}
}`;

  const mkConfig = (dependencies: SavedConfig['dependencies']): SavedConfig => ({
    dependencies,
    programParams: [],
    taskParams: [],
  });

  it('SPARK 任务：--jars 不在 mapCodeFileToTask 注入（改由提交端 buildJarsArg 拼接，避免污染弹窗输入框）', () => {
    const mapping = mapCodeFileToTask('TestApp.scala', sparkScalaContent, undefined, undefined, mkConfig([
      { id: 'd1', name: 'my-udf', version: '1.0', source: 'custom', basePath: '/opt/dataforge/jars', jarPath: 'udf/my-udf.jar' },
    ]));
    expect(mapping.taskType).toBe('SPARK');
    expect(mapping.taskParams.others || '').not.toContain('--jars');
    // 依赖不进入 Spark 任务的 resourceList，仅由提交端 buildJarsArg 生成 --jars
    expect(mapping.taskParams.resourceList).not.toContain('my-udf');
  });

  it('SPARK 任务：多个 custom jar 的拼接由 buildJarsArg 完成（basePath/jarPath 逗号连接）', () => {
    const config = mkConfig([
      { id: 'd1', name: 'a', version: '1.0', source: 'custom', basePath: '/opt/jars', jarPath: 'a.jar' },
      { id: 'd2', name: 'b', version: '1.0', source: 'custom', basePath: '/opt/jars', jarPath: 'udf/b.jar' },
    ]);
    const mapping = mapCodeFileToTask('TestApp.scala', sparkScalaContent, undefined, undefined, config);
    expect(mapping.taskType).toBe('SPARK');
    expect(mapping.taskParams.others || '').not.toContain('--jars');
    // --jars 由提交弹窗调用 buildJarsArg 动态生成，此处验证拼接结果正确
    const jarsArg = buildJarsArg(config.dependencies.filter(d => d.source === 'custom'));
    expect(jarsArg).toBe('/opt/jars/a.jar,/opt/jars/udf/b.jar');
  });

  it('SPARK 任务：custom 但无 jarPath（仅 Maven 坐标）时不注入 --jars', () => {
    const mapping = mapCodeFileToTask('TestApp.scala', sparkScalaContent, undefined, undefined, mkConfig([
      { id: 'd1', name: 'org.apache.spark:spark-sql_2.12:3.5.0', version: '', source: 'custom' },
    ]));
    expect(mapping.taskParams.others || '').not.toContain('--jars');
  });

  it('SPARK 任务：非 custom 来源（即使带 jarPath）不注入 --jars', () => {
    const mapping = mapCodeFileToTask('TestApp.scala', sparkScalaContent, undefined, undefined, mkConfig([
      { id: 'd1', name: 'spark-sql', version: '3.5.0', source: 'maven', jarPath: '/opt/jars/', jarName: 'spark-sql.jar' },
    ]));
    expect(mapping.taskParams.others || '').not.toContain('--jars');
  });

  it('FLINK 任务：即使依赖带 jarPath 也不注入 --jars', () => {
    const flinkJavaContent = `/*
 * @备注: 测试 Flink 任务
 * @引擎: flink
 * @数据源: test_datasource
 */
public class TestJob {
  public static void main(String[] args) {}
}`;
    const mapping = mapCodeFileToTask('TestJob.java', flinkJavaContent, undefined, undefined, mkConfig([
      { id: 'd1', name: 'my-udf', version: '1.0', source: 'custom', basePath: '/opt/jars', jarPath: 'my-udf.jar' },
    ]));
    expect(mapping.taskType).toBe('FLINK');
    expect(mapping.taskParams.others || '').not.toContain('--jars');
  });
});

describe('layoutWorkflowByDependency — 前置节点在依赖节点左侧', () => {
  it('任务 A 是 B 的前置依赖，则 A 位于 B 左侧', () => {
    const nodes = [mkNode(1, 'A'), mkNode(2, 'B')];
    layoutWorkflowByDependency(nodes, [edge(1, 2)]);
    const a = nodes.find(n => n.name === 'A')!;
    const b = nodes.find(n => n.name === 'B')!;
    expect(a.x).toBeLessThan(b.x);
    expect(b.x - a.x).toBe(GRID_GAP_X);
    expect(b.y).toBe(a.y);
  });

  it('同工作流与跨工作流(k: 前置依赖节点->任务)均满足 前置在左', () => {
    const depNode = mkNode(10, '前置依赖_B', 'DEPENDENT');
    const a = mkNode(1, 'A');
    const b = mkNode(2, 'B');
    const c = mkNode(3, 'C');
    const nodes = [a, b, c, depNode];
    // A->B 同工作流直接前置；前置依赖_B -> C 跨工作流前置
    const edges = [edge(1, 2), edge(10, 3)];
    layoutWorkflowByDependency(nodes, edges);

    const x = (name: string) => nodes.find(n => n.name === name)!.x;
    expect(x('A')).toBeLessThan(x('B'));
    expect(x('前置依赖_B')).toBeLessThan(x('C'));
    // DEPENDENT 节点作为源节点落入第 0 层，恒在最左侧
    expect(x('前置依赖_B')).toBe(x('A'));
  });

  it('单链 A->B->C 依次左到右，每步间距恰为横向间距', () => {
    const nodes = [mkNode(1, 'A'), mkNode(2, 'B'), mkNode(3, 'C')];
    layoutWorkflowByDependency(nodes, [edge(1, 2), edge(2, 3)]);
    const x = (name: string) => nodes.find(n => n.name === name)!.x;
    expect(x('A')).toBe(GRID_START_X);
    expect(x('B')).toBe(x('A') + GRID_GAP_X);
    expect(x('C')).toBe(x('A') + 2 * GRID_GAP_X);
  });

  it('同一层多个独立节点自上而下均匀分布、不重叠', () => {
    // S 依赖 M1、M2；根因 M1/M2 无依赖，同处第 0 层
    const m1 = mkNode(1, 'M1');
    const m2 = mkNode(2, 'M2');
    const s = mkNode(3, 'S');
    const nodes = [m1, m2, s];
    layoutWorkflowByDependency(nodes, [edge(1, 3), edge(2, 3)]);
    const xs = nodes.map(n => n.x);
    expect(xs[0]).toBe(xs[1]);
    expect(xs[2]).toBe(xs[0] + GRID_GAP_X);
    // 同层节点纵向错开
    expect(Math.abs(m1.y - m2.y)).toBe(GRID_GAP_Y);
    expect(m1.x).toBe(GRID_START_X);
    expect(m1.y).toBe(GRID_START_Y);
  });

  it('无依赖边(仅一个节点或全独立)时坐标稳定为起始格', () => {
    const nodes = [mkNode(1, 'A'), mkNode(2, 'B')];
    layoutWorkflowByDependency(nodes, []);
    for (const n of nodes) {
      expect(n.x).toBe(GRID_START_X);
    }
    expect(Math.abs(nodes[0].y - nodes[1].y)).toBe(GRID_GAP_Y);
  });
});
