import { describe, it, expect } from 'vitest';
import { buildWorkflowFromFolder, deriveFolderWorkflowName, mapCodeFileToTask, type FolderCodeFileInput } from './schedulerMapping';

/**
 * 「文件夹 → 工作流」构建的单元测试。
 *
 * 这条路径服务于文件浏览器右键文件夹「提交调度」：
 * 每个代码文件生成一个任务节点，节点间的依赖边取自各文件代码头声明的 @依赖。
 * 这里钉住四个容易出错的行为：
 * 1. 任务名 = 文件名（不含扩展名）；工作流名 = 文件夹的项目内相对路径；
 * 2. 只有「被依赖的任务也在这批文件里」时才连边；
 * 3. 跨项目 / 不在本批次的依赖不连边，但必须出现在 unresolved 里（不静默丢弃）；
 * 4. 依赖成环时给出环上的任务名。
 */

const ROOT = '/proj/src';
const FOLDER = `${ROOT}/demo`;

/** 构造块注释代码头（新规范） */
const header = (fields: Record<string, string>) =>
  `/*\n${Object.entries(fields).map(([k, v]) => ` * @${k}: ${v}`).join('\n')}\n */\n`;

/** scala 文件（@引擎 spark → SPARK 任务） */
const scalaFile = (path: string, deps?: string): FolderCodeFileInput => ({
  filePath: `${FOLDER}/${path}`,
  content: header({ 引擎: 'spark', ...(deps ? { 依赖: deps } : {}) }) + 'object Demo { def main(a: Array[String]): Unit = {} }\n',
});

/** sql 文件（@引擎 mysql → SQL 任务） */
const sqlFile = (path: string, deps?: string): FolderCodeFileInput => ({
  filePath: `${FOLDER}/${path}`,
  content: header({ 引擎: 'mysql', ...(deps ? { 依赖: deps } : {}) }) + 'select 1;\n',
});

const build = (files: FolderCodeFileInput[], projectCode = 'demo') =>
  buildWorkflowFromFolder(files, { rootPath: ROOT, folderPath: FOLDER, projectCode });

const nodeByName = (nodes: { name: string; x: number; taskType: string }[], name: string) =>
  nodes.find(n => n.name === name)!;

describe('buildWorkflowFromFolder', () => {
  it('每个代码文件生成一个任务节点，任务名取文件名、工作流名取文件夹相对路径', () => {
    const r = build([scalaFile('a.scala'), sqlFile('b.sql')]);

    expect(r.nodes.map(n => n.name)).toEqual(['a', 'b']);
    expect(r.nodes.map(n => n.taskType)).toEqual(['SPARK', 'SQL']);
    // 文件夹相对 rootPath 的路径
    expect(r.name).toBe('demo');
    expect(r.edges).toEqual([]);
    expect(r.unresolved).toEqual([]);
    expect(r.cycle).toBeNull();
  });

  it('同批次内的 @依赖 生成依赖边，且前置节点排在更小的 x（分层布局）', () => {    const r = build([scalaFile('a.scala'), scalaFile('c.scala', 'demo.a')]);

    expect(r.edges).toHaveLength(1);
    const a = nodeByName(r.nodes, 'a');
    const c = nodeByName(r.nodes, 'c');
    const edge = r.edges[0];
    expect(edge.sourceCode).toBe(r.nodes.find(n => n.name === 'a')!.code);
    expect(edge.targetCode).toBe(r.nodes.find(n => n.name === 'c')!.code);
    // 前置任务在左侧
    expect(a.x).toBeLessThan(c.x);
    expect(r.unresolved).toEqual([]);
  });

  it('多个前置依赖（逗号分隔）都能连边', () => {
    const r = build([
      scalaFile('a.scala'),
      sqlFile('b.sql'),
      scalaFile('c.scala', 'demo.a, demo.b'),
    ]);

    expect(r.edges).toHaveLength(2);
    const cCode = r.nodes.find(n => n.name === 'c')!.code;
    expect(r.edges.every(e => e.targetCode === cCode)).toBe(true);
  });

  it('不在本批次的依赖：不连边，但记入 unresolved（不静默丢弃）', () => {
    const r = build([scalaFile('a.scala'), scalaFile('d.scala', 'demo.zzz')]);

    expect(r.edges).toEqual([]);
    expect(r.unresolved).toEqual([
      { from: 'd', projectCode: 'demo', taskName: 'zzz' },
    ]);
  });

  it('跨项目依赖：即使本批次存在同名任务也不连边', () => {
    const r = build([scalaFile('a.scala'), scalaFile('e.scala', 'other.a')]);

    expect(r.edges).toEqual([]);
    expect(r.unresolved).toEqual([
      { from: 'e', projectCode: 'other', taskName: 'a' },
    ]);
  });

  it('依赖成环时返回环上的任务名', () => {
    const r = build([scalaFile('f.scala', 'demo.g'), scalaFile('g.scala', 'demo.f')]);

    expect(r.edges).toHaveLength(2);
    expect(r.cycle).not.toBeNull();
    // findDependencyCycle 的契约：返回闭合路径（首尾为同一节点）
    const cycle = r.cycle!;
    expect([...new Set(cycle)].sort()).toEqual(['f', 'g']);
    expect(cycle[0]).toBe(cycle[cycle.length - 1]);
  });

  it('自依赖（依赖自身）不连边，也不作为待解析的外部依赖', () => {
    const r = build([scalaFile('a.scala', 'demo.a')]);

    expect(r.edges).toEqual([]);
    // 不进 unresolved：否则会被当成跨工作流依赖解析成「指向自身」的前置依赖节点形成环
    expect(r.unresolved).toEqual([]);
  });

  it('空输入：无节点，工作流名仍按文件夹相对路径推导', () => {
    const r = build([]);

    expect(r.nodes).toEqual([]);
    expect(r.edges).toEqual([]);
    expect(r.name).toBe('demo');
  });

  it('依赖成环时节点仍给出坐标（不因分层布局无解而丢失位置）', () => {
    const r = build([scalaFile('f.scala', 'demo.g'), scalaFile('g.scala', 'demo.f')]);

    expect(r.cycle).not.toBeNull();
    for (const n of r.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
    // 网格兜底：两个节点不应重叠
    const [f, g] = [nodeByName(r.nodes, 'f'), nodeByName(r.nodes, 'g')];
    expect(f.x !== g.x || f.y !== g.y).toBe(true);
  });

  it('文件夹即基准目录（相对路径为空）时用该文件夹自身的名字', () => {
    const r = buildWorkflowFromFolder([scalaFile('a.scala')], {
      rootPath: ROOT,
      folderPath: ROOT,
    });

    // 相对路径为空时不能退化成无意义的 'workflow'，应取文件夹名（ROOT 末段）
    expect(r.name).toBe('src');
  });

  it('节点 code 互不相同（避免画布上节点互相覆盖）', () => {
    const r = build([scalaFile('a.scala'), sqlFile('b.sql'), scalaFile('c.scala')]);
    const codes = r.nodes.map(n => n.code);
    expect(new Set(codes).size).toBe(3);
  });

  it('headerDeps 记录每个代码文件任务的代码头 @依赖（供保存前依赖重建）', () => {
    const r = build([
      scalaFile('a.scala'),
      scalaFile('c.scala', 'demo.a'),
      sqlFile('d.sql', 'other.zzz'),
    ]);

    // 无 @依赖 声明 → 空数组；有声明 → 逐条解析为 {调度项目, 前置任务名}
    expect(r.headerDeps.get('a')).toEqual([]);
    expect(r.headerDeps.get('c')).toEqual([{ projectCode: 'demo', taskName: 'a' }]);
    expect(r.headerDeps.get('d')).toEqual([{ projectCode: 'other', taskName: 'zzz' }]);
  });
});

describe('文件夹工作流名称（须与单文件提交调度同一规范）', () => {
  it('与同目录下单文件提交的 workflowName 完全一致', () => {
    const folder = `${ROOT}/demo/ads`;
    const filePath = `${folder}/a.scala`;
    const content = header({ 引擎: 'spark' }) + 'object A {}\n';

    // 单文件口径：文件所在目录的相对路径，分隔符转下划线
    const single = mapCodeFileToTask('a.scala', content, filePath, ROOT);
    const batch = buildWorkflowFromFolder(
      [{ filePath, content }],
      { rootPath: ROOT, folderPath: folder, projectCode: 'demo' },
    );

    expect(single.workflowName).toBe('demo_ads');
    expect(batch.name).toBe(single.workflowName);
  });

  it('文件夹不在基准目录之下时退化为文件夹名（不把整条绝对路径当名称）', () => {
    // 推导基准与单文件不同（或未传）时，toRelativePath 会回退成绝对路径——
    // 这正是「名称不对且带斜杠」的根因，必须退化成可读的文件夹名
    expect(deriveFolderWorkflowName('/other/place/ads', ROOT)).toBe('ads');
    expect(deriveFolderWorkflowName('/other/place/ads', undefined)).toBe('ads');
  });

  it('文件夹就是基准目录本身时用该文件夹自身的名字', () => {
    expect(deriveFolderWorkflowName(ROOT, ROOT)).toBe('src');
  });

  it('只做分隔符替换、不做 sanitize（清洗留给真正提交给调度系统时）', () => {
    // 与单文件一致：base 名称保留特殊字符，两处界面显示才不会有差异
    expect(deriveFolderWorkflowName(`${ROOT}/demo/a-b (v2)`, ROOT)).toBe('demo_a-b (v2)');
  });

  it('拿不到任何路径信息时回退 workflow', () => {
    expect(deriveFolderWorkflowName(undefined, ROOT)).toBe('workflow');
  });
});
