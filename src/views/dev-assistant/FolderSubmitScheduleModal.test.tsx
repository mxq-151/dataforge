import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import FolderSubmitScheduleModal from './FolderSubmitScheduleModal';
import { unifiedCompile } from '../../services/unifiedCompile';
import { ToastProvider } from '../../components/Toast';
import { ExecutionType, type DolphinSchedulerApi } from '../../types/dolphinscheduler';

/**
 * 文件夹「提交调度」模态框的回归测试。
 *
 * 需求：右键文件夹 → 提交调度 → 弹窗内容与「工作流定义」一致，
 * 但**不显示左侧任务节点类型面板**（节点按该文件夹下的代码文件自动生成），
 * 且**不提供运行**、只做保存；保存前对 Java/Scala 可编译节点编译并回填主 Jar 包。
 *
 * 工作流定义编辑器在这里被替换为桩组件：它的内部是 @antv/x6 画布，jsdom 下无法渲染，
 * 而本测试要钉住的是「传进去的节点/边是否正确、是否隐藏了侧栏、是否给了运行入口」，
 * 用桩组件反而更直接。
 *
 * unifiedCompile / bridge.fs 在这里被 mock 掉：编译走主进程 Maven，jsdom 下不可用；
 * 要测的是「编译成功 → 上传 → 回填 mainJar」与「编译失败 → 阻止保存」的接线，而非编译本身。
 */

const saveSpy = vi.fn();

vi.mock('../schedule-management/components/WorkflowDefinitionEditor', () => ({
  default: (props: any) => (
    <div
      data-testid="wf-editor"
      data-workflow-name={props.workflowName}
      data-node-names={props.existingNodes.map((n: any) => n.name).join(',')}
      data-edge-count={String(props.existingEdges.length)}
      data-sidebar={String(props.showTaskTypeSidebar)}
      data-has-trigger={String(!!props.onTrigger)}
      data-hide-header={String(!!props.hideToolbarHeader)}
      data-hide-validate={String(!!props.hideToolbarValidate)}
      data-app-name-ctx={props.appNameContext ? `${props.appNameContext.project}|${props.appNameContext.workflow}` : ''}
    >
      <button
        data-testid="wf-save"
        onClick={() => {
          saveSpy(props);
          props.onSave({
            name: props.workflowName,
            description: 'desc',
            executionType: ExecutionType.PARALLEL,
            timeout: 0,
            globalParams: [],
            nodes: props.existingNodes,
            edges: props.existingEdges,
            release: true,
          });
        }}
      >
        save
      </button>
    </div>
  ),
}));

vi.mock('../../services/unifiedCompile', () => ({
  unifiedCompile: vi.fn(),
}));

vi.mock('../../bridge/fs', () => ({
  readFile: vi.fn(async () => new Uint8Array([0x50, 0x4b])),
}));

const ROOT = '/proj/src';
const FOLDER = `${ROOT}/demo`;

const header = (fields: Record<string, string>) =>
  `/*\n${Object.entries(fields).map(([k, v]) => ` * @${k}: ${v}`).join('\n')}\n */\n`;

const FILES: Record<string, string> = {
  [`${FOLDER}/a.scala`]: header({ 引擎: 'spark' }) + 'object A {}\n',
  [`${FOLDER}/b.sql`]: header({ 引擎: 'mysql' }) + 'select 1;\n',
  [`${FOLDER}/c.scala`]: header({ 引擎: 'spark', 依赖: 'demo.a' }) + 'object C {}\n',
};

/** 不含可编译文件（sql/py/sh）的文件集，用于测「保存 → create/update」的基本接线，避免编译闸门干扰 */
const NON_COMPILABLE_FILES: Record<string, string> = {
  [`${FOLDER}/a.sql`]: header({ 引擎: 'mysql' }) + 'select 1;\n',
  [`${FOLDER}/b.py`]: header({ 引擎: 'python' }) + 'print(1)\n',
  [`${FOLDER}/c.sql`]: header({ 引擎: 'mysql', 依赖: 'demo.a' }) + 'select 2;\n',
};

const COMPILE_CONFIG = { javaHome: '/jdk', scalaHome: '/scala', mavenHome: '/mvn' };

const pageOf = (totalList: any[]) => ({
  code: 0, msg: '', data: { totalList, total: totalList.length, totalPage: 1, pageSize: 200, currentPage: 1 },
});

/** 造一个只记录调用的调度 API 替身（工作流列表随创建而更新，模拟真实服务端） */
const makeDsApi = (opts: {
  projects?: { code: number; name: string }[];
  workflows?: { code: number; name: string }[];
  /** 项目内「其他工作流」的任务节点，用于解析跨文件夹的 @依赖（生成前置依赖节点） */
  externalTasks?: { code: number; name: string }[];
} = {}) => {
  const workflows = [...(opts.workflows ?? [])];
  let nextCode = 500;
  const EXTERNAL_WF_CODE = 900;
  const api = {
    project: { list: vi.fn(async () => pageOf(opts.projects ?? [{ code: 11, name: 'demo' }])) },
    workflowDefinition: {
      list: vi.fn(async (_pc: number, params?: { searchVal?: string }) => {
        const search = params?.searchVal;
        if (search) {
          // 按名称查重（handleSave 里用于判断同名工作流是否存在）
          return pageOf(workflows.filter(w => w.name === search));
        }
        // 无 searchVal：buildProjectTaskIndex 分页扫描项目内全部工作流（含挂外部任务的工作流）
        const all = [...workflows];
        if (opts.externalTasks?.length) all.push({ code: EXTERNAL_WF_CODE, name: 'external_wf' });
        return pageOf(all);
      }),
      detail: vi.fn(async (_pc: number, code: number) => {
        if (code === EXTERNAL_WF_CODE) {
          return {
            code: 0, msg: '', data: {
              workflowDefinition: { code, name: 'external_wf' } as any,
              taskNodes: (opts.externalTasks ?? []).map(t => ({
                code: t.code, name: t.name, taskType: 'SQL', description: '', taskParams: '{}',
                flag: 'YES', taskPriority: 2, workerGroup: 'default', environmentCode: -1,
                failRetryTimes: 0, failRetryInterval: 1, timeoutFlag: 'CLOSE', timeout: 0, delayTime: 0, x: 0, y: 0,
              })),
              edges: [], globalParams: [],
            },
          };
        }
        return { code: 0, msg: '', data: { workflowDefinition: { code, name: 'wf' } as any, taskNodes: [], edges: [], globalParams: [] } };
      }),
      createWithTasks: vi.fn(async (_pc: number, payload: { name: string }) => {
        workflows.push({ code: nextCode++, name: payload.name });
        return { code: 0, msg: '', data: null };
      }),
      update: vi.fn(async () => ({ code: 0, msg: '', data: null })),
      release: vi.fn(async () => ({ code: 0, msg: '', data: null })),
    },
    workerGroup: { list: vi.fn(async () => pageOf([])) },
    environment: { list: vi.fn(async () => pageOf([])) },
    resource: {
      queryBaseDir: vi.fn(async () => ({ code: 0, msg: '', data: '/resources' })),
      createDir: vi.fn(async () => ({ code: 0, msg: '', data: null })),
      upload: vi.fn(async () => ({ code: 0, msg: '', data: null })),
    },
  };
  return api as unknown as DolphinSchedulerApi & typeof api;
};

const readFileContent = vi.fn(async (p: string) => FILES[p] ?? '');

const renderModal = (overrides: Record<string, any> = {}) => {
  const onClose = vi.fn();
  const props = {
    visible: true,
    folderPath: FOLDER,
    codeFilePaths: Object.keys(FILES),
    rootPath: ROOT,
    projectCode: 'demo',
    readFileContent,
    dsApi: makeDsApi(),
    isRealApi: true,
    onClose,
    ...overrides,
  };
  const utils = render(
    <ToastProvider>
      <FolderSubmitScheduleModal {...props} />
    </ToastProvider>
  );
  return { ...utils, props, onClose };
};

/** 环境单选项外层（data-testid 在包裹 label 上）：用于断言选中态 */
const envOption = (env: 'prod' | 'gray' | 'test') =>
  document.querySelector(`[data-testid="deploy-env-${env}"]`) as HTMLElement;
/** 环境单选项内部的 radio 输入：点击它触发 React onChange */
const envRadio = (env: 'prod' | 'gray' | 'test') =>
  document.querySelector(`[data-testid="deploy-env-${env}"] input`) as HTMLInputElement;

beforeEach(() => {
  saveSpy.mockClear();
  readFileContent.mockClear();
  vi.mocked(unifiedCompile).mockReset();
});

describe('FolderSubmitScheduleModal', () => {
  it('打开后读取全部代码文件，并把自动生成的节点交给编辑器', async () => {
    const { findByTestId } = renderModal();
    const editor = await findByTestId('wf-editor');

    expect(readFileContent).toHaveBeenCalledTimes(3);
    // 任务名 = 文件名（不含扩展名）；工作流名 = 文件夹的项目内相对路径 + 默认环境后缀 _test
    expect(editor.getAttribute('data-node-names')).toBe('a,b,c');
    expect(editor.getAttribute('data-workflow-name')).toBe('demo_test');
    // c.scala 依赖 demo.a → 一条边
    expect(editor.getAttribute('data-edge-count')).toBe('1');
  });

  it('副标题显示「调度项目名称 + 工作流名称」，不是带斜杠的路径', async () => {
    const { findByTestId, container } = renderModal();
    await findByTestId('wf-editor');

    // projectCode = 'demo'（同时是调度项目名称），工作流名 = FOLDER 相对 ROOT 的 'demo' + 默认环境 _test
    const title = container.querySelector('.folder-submit-schedule__path');
    expect(title?.textContent).toBe('demo 工作流名称：demo_test');
    expect(title?.textContent).not.toContain('/');
    // 完整文件夹路径仍在 title 里可查
    expect(title?.getAttribute('title')).toBe('demo 工作流名称：demo_test');
  });

  it('草稿就绪前头部就用同一规范推导出的工作流名（不闪相对路径）', () => {
    const { container } = renderModal({ readFileContent: vi.fn(() => new Promise<string>(() => {})) } as any);

    const title = container.querySelector('.folder-submit-schedule__path');
    expect(title?.textContent).toBe('demo 工作流名称：demo_test');
  });

  it('环境单选：默认选中「测试」，三个选项齐全', async () => {
    const { findByTestId } = renderModal();
    await findByTestId('wf-editor');

    expect(envOption('test').getAttribute('data-active')).toBe('true');
    expect(envOption('gray').getAttribute('data-active')).toBe('false');
    expect(envOption('prod').getAttribute('data-active')).toBe('false');
  });

  it('环境选项位于头部副标题内、工作流名称之后（不再是独立一行）', async () => {
    const { findByTestId, container } = renderModal();
    await findByTestId('wf-editor');

    const subtitle = container.querySelector('.folder-submit-schedule__subtitle')!;
    const path = subtitle.querySelector('.folder-submit-schedule__path')!;
    const group = subtitle.querySelector('.deploy-env-radio')!;
    expect(group).toBeTruthy();
    // 名称在前、环境选项紧随其后
    expect(path.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 旧的独立环境行已移除
    expect(container.querySelector('.folder-submit-schedule__env')).toBeNull();
  });

  it('切换环境：工作流名称与交给编辑器的名称同步换成对应后缀', async () => {
    const { findByTestId, container } = renderModal();
    await findByTestId('wf-editor');

    fireEvent.click(envRadio('prod'));

    await waitFor(() =>
      expect(container.querySelector('.folder-submit-schedule__path')?.textContent)
        .toBe('demo 工作流名称：demo_prod')
    );
    expect(document.querySelector('[data-testid="wf-editor"]')!.getAttribute('data-workflow-name'))
      .toBe('demo_prod');

    fireEvent.click(envRadio('gray'));
    await waitFor(() =>
      expect(document.querySelector('[data-testid="wf-editor"]')!.getAttribute('data-workflow-name'))
        .toBe('demo_gray')
    );
  });

  it('切换环境后保存：按带环境后缀的名称创建/更新', async () => {
    const dsApi = makeDsApi({ projects: [{ code: 11, name: 'demo' }], workflows: [] });
    const { findByTestId } = renderModal({
      dsApi,
      codeFilePaths: Object.keys(NON_COMPILABLE_FILES),
      readFileContent: vi.fn(async (p: string) => NON_COMPILABLE_FILES[p] ?? ''),
    });

    await findByTestId('wf-editor');
    fireEvent.click(envRadio('prod'));
    await waitFor(() =>
      expect(document.querySelector('[data-testid="wf-editor"]')!.getAttribute('data-workflow-name'))
        .toBe('demo_prod')
    );

    fireEvent.click(await findByTestId('wf-save'));

    await waitFor(() => expect(dsApi.workflowDefinition.createWithTasks).toHaveBeenCalledTimes(1));
    const [, payload] = dsApi.workflowDefinition.createWithTasks.mock.calls[0] as any;
    expect(payload.name).toBe('demo_prod');
  });

  it('任务节点的应用名称按「项目.工作流.任务」生成（交给编辑器的上下文含环境后缀）', async () => {
    const { findByTestId } = renderModal();
    await findByTestId('wf-editor');

    // 上下文与头部名称同源：project = 调度项目名称，workflow = 带环境后缀的最终名称
    const editorOf = () => document.querySelector('[data-testid="wf-editor"]')!;
    expect(editorOf().getAttribute('data-app-name-ctx')).toBe('demo|demo_test');

    fireEvent.click(envRadio('prod'));
    await waitFor(() =>
      expect(editorOf().getAttribute('data-app-name-ctx')).toBe('demo|demo_prod')
    );
  });

  it('保存：SPARK 节点的应用名称写为 项目.工作流.任务，无该项的任务类型不写入', async () => {
    const dsApi = makeDsApi({ projects: [{ code: 11, name: 'demo' }], workflows: [] });
    vi.mocked(unifiedCompile).mockResolvedValue({
      success: true, jarPath: '/tmp/a.jar', output: '', error: '', packageName: '', className: '',
    });

    const { findByTestId } = renderModal({ dsApi, compileConfig: COMPILE_CONFIG, devProjectId: 1 });
    fireEvent.click(await findByTestId('wf-save'));

    await waitFor(() => expect(dsApi.workflowDefinition.createWithTasks).toHaveBeenCalledTimes(1));
    const [, payload] = dsApi.workflowDefinition.createWithTasks.mock.calls[0] as any;

    // a.scala / c.scala 是 SPARK（有「应用名称」项）→ 项目.工作流.任务
    const a = payload.nodes.find((n: any) => n.name === 'a');
    const c = payload.nodes.find((n: any) => n.name === 'c');
    expect(JSON.parse(a.taskParams).appName).toBe('demo.demo_test.a');
    expect(JSON.parse(c.taskParams).appName).toBe('demo.demo_test.c');
    // b.sql 是 SQL，没有「应用名称」项 → 不写入
    const b = payload.nodes.find((n: any) => n.name === 'b');
    expect(JSON.parse(b.taskParams).appName).toBeUndefined();
  });

  it('保存：切换环境后应用名称用带后缀的工作流名', async () => {
    const dsApi = makeDsApi({ projects: [{ code: 11, name: 'demo' }], workflows: [] });
    vi.mocked(unifiedCompile).mockResolvedValue({
      success: true, jarPath: '/tmp/a.jar', output: '', error: '', packageName: '', className: '',
    });

    const { findByTestId } = renderModal({ dsApi, compileConfig: COMPILE_CONFIG, devProjectId: 1 });
    await findByTestId('wf-editor');
    fireEvent.click(envRadio('prod'));
    await waitFor(() =>
      expect(document.querySelector('[data-testid="wf-editor"]')!.getAttribute('data-workflow-name'))
        .toBe('demo_prod')
    );

    fireEvent.click(await findByTestId('wf-save'));
    await waitFor(() => expect(dsApi.workflowDefinition.createWithTasks).toHaveBeenCalledTimes(1));
    const [, payload] = dsApi.workflowDefinition.createWithTasks.mock.calls[0] as any;
    const a = payload.nodes.find((n: any) => n.name === 'a');
    expect(JSON.parse(a.taskParams).appName).toBe('demo.demo_prod.a');
  });

  it('节点数徽标按画布上的任务节点统计，文案为「个任务节点」', async () => {
    const { findByTestId, container } = renderModal();
    await findByTestId('wf-editor');

    // 3 个代码文件 → 3 个任务节点；文案不再是「个代码文件」
    const count = container.querySelector('.folder-submit-schedule__count');
    expect(count?.textContent).toBe('3 个任务节点');
    expect(container.textContent).not.toContain('个代码文件并生成任务节点…');
  });

  it('节点数包含自动生成的「前置依赖」任务节点', async () => {
    const extFiles: Record<string, string> = {
      [`${FOLDER}/a.sql`]: header({ 引擎: 'mysql' }) + 'select 1;\n',
      [`${FOLDER}/h.sql`]: header({ 引擎: 'mysql', 依赖: 'demo.ext_task' }) + 'select 2;\n',
    };
    const dsApi = makeDsApi({
      projects: [{ code: 11, name: 'demo' }],
      workflows: [],
      externalTasks: [{ code: 700, name: 'ext_task' }],
    });

    const { findByTestId, container } = renderModal({
      dsApi,
      codeFilePaths: Object.keys(extFiles),
      readFileContent: vi.fn(async (p: string) => extFiles[p] ?? ''),
    });
    await findByTestId('wf-editor');

    await waitFor(() =>
      expect(container.querySelector('.folder-submit-schedule__count')?.textContent).toBe('3 个任务节点')
    );
  });

  it('不显示左侧任务节点类型面板，也不提供运行入口', async () => {
    const { findByTestId } = renderModal();
    const editor = await findByTestId('wf-editor');

    expect(editor.getAttribute('data-sidebar')).toBe('false');
    expect(editor.getAttribute('data-has-trigger')).toBe('false');
  });

  it('保留工具栏「校验」按钮（只有调度管理的工作流定义不显示它）', async () => {
    const { findByTestId } = renderModal();
    const editor = await findByTestId('wf-editor');

    expect(editor.getAttribute('data-hide-validate')).toBe('false');
  });

  it('保存：目标项目下没有同名工作流时创建（createWithTasks）', async () => {
    const dsApi = makeDsApi({ projects: [{ code: 11, name: 'demo' }], workflows: [] });
    const { findByTestId, onClose } = renderModal({
      dsApi,
      codeFilePaths: Object.keys(NON_COMPILABLE_FILES),
      readFileContent: vi.fn(async (p: string) => NON_COMPILABLE_FILES[p] ?? ''),
    });

    fireEvent.click(await findByTestId('wf-save'));

    await waitFor(() => expect(dsApi.workflowDefinition.createWithTasks).toHaveBeenCalledTimes(1));
    const [projectCode, payload] = dsApi.workflowDefinition.createWithTasks.mock.calls[0] as any;
    expect(projectCode).toBe(11);
    // 默认环境为「测试」→ 名称带 _test 后缀
    expect(payload.name).toBe('demo_test');
    expect(payload.nodes).toHaveLength(3);
    expect(payload.edges).toHaveLength(1);
    // 未走到「创建后回查上线」这一步之外的分支：勾选了上线 → 回查并 release
    await waitFor(() => expect(dsApi.workflowDefinition.release).toHaveBeenCalledWith(11, expect.anything(), 1));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('保存：已存在同名工作流时更新（update），并带上上线状态', async () => {
    // 同名匹配按「带环境后缀的最终名称」，所以演示数据里的既有工作流也叫 demo_test
    const dsApi = makeDsApi({
      projects: [{ code: 11, name: 'demo' }],
      workflows: [{ code: 99, name: 'demo_test' }],
    });
    const { findByTestId } = renderModal({
      dsApi,
      codeFilePaths: Object.keys(NON_COMPILABLE_FILES),
      readFileContent: vi.fn(async (p: string) => NON_COMPILABLE_FILES[p] ?? ''),
    });

    fireEvent.click(await findByTestId('wf-save'));

    await waitFor(() => expect(dsApi.workflowDefinition.update).toHaveBeenCalledTimes(1));
    const [projectCode, wfCode, payload] = dsApi.workflowDefinition.update.mock.calls[0] as any;
    expect(projectCode).toBe(11);
    expect(wfCode).toBe(99);
    expect(payload.release).toBe(true);
    expect(dsApi.workflowDefinition.createWithTasks).not.toHaveBeenCalled();
  });

  it('保存前编译 Java/Scala 节点并回填主 Jar 包，SQL 节点不参与', async () => {
    const dsApi = makeDsApi({ projects: [{ code: 11, name: 'demo' }], workflows: [] });
    vi.mocked(unifiedCompile).mockResolvedValue({
      success: true, jarPath: '/tmp/a.jar', output: '', error: '', packageName: '', className: '',
    });

    const { findByTestId } = renderModal({ dsApi, compileConfig: COMPILE_CONFIG, devProjectId: 1 });

    fireEvent.click(await findByTestId('wf-save'));
    await waitFor(() => expect(dsApi.workflowDefinition.createWithTasks).toHaveBeenCalledTimes(1));

    // 仅 a.scala / c.scala（SPARK）触发编译，b.sql 不触发
    expect(unifiedCompile).toHaveBeenCalledTimes(2);

    const [, payload] = dsApi.workflowDefinition.createWithTasks.mock.calls[0] as any;
    const a = payload.nodes.find((n: any) => n.name === 'a');
    const c = payload.nodes.find((n: any) => n.name === 'c');
    const b = payload.nodes.find((n: any) => n.name === 'b');

    const aParams = JSON.parse(a.taskParams);
    expect(aParams.mainJar).toContain('/resources/demo/');
    expect(aParams.mainJar).toContain('.jar');
    const cParams = JSON.parse(c.taskParams);
    expect(cParams.mainJar).toContain('.jar');
    // SQL 节点没有 mainJar 字段，未被回填
    const bParams = JSON.parse(b.taskParams);
    expect(bParams.mainJar).toBeUndefined();
    // jar 已上传到资源中心
    expect(dsApi.resource.upload).toHaveBeenCalledTimes(2);
  });

  it('编译失败时阻止保存并提示', async () => {
    const dsApi = makeDsApi({ projects: [{ code: 11, name: 'demo' }], workflows: [] });
    vi.mocked(unifiedCompile).mockResolvedValue({
      success: false, jarPath: '', output: 'compile error', error: 'compile error', packageName: '', className: '',
    });

    const { findByTestId, container } = renderModal({ dsApi, compileConfig: COMPILE_CONFIG, devProjectId: 1 });

    fireEvent.click(await findByTestId('wf-save'));

    await waitFor(() => expect(container.textContent).toContain('编译失败'));
    expect(dsApi.workflowDefinition.createWithTasks).not.toHaveBeenCalled();
    expect(dsApi.workflowDefinition.update).not.toHaveBeenCalled();
  });

  it('未配置 JAVA_HOME 时阻止保存并提示', async () => {
    const dsApi = makeDsApi({ projects: [{ code: 11, name: 'demo' }], workflows: [] });
    const { findByTestId, container } = renderModal({ dsApi }); // 不传 compileConfig

    fireEvent.click(await findByTestId('wf-save'));

    await waitFor(() => expect(container.textContent).toContain('JAVA_HOME 未配置'));
    expect(dsApi.workflowDefinition.createWithTasks).not.toHaveBeenCalled();
    expect(dsApi.workflowDefinition.update).not.toHaveBeenCalled();
  });

  it('生产环境：代码里引用了非生产库时阻止保存并逐条提示', async () => {
    const dsApi = makeDsApi({ projects: [{ code: 11, name: 'demo' }], workflows: [] });
    const prodFiles: Record<string, string> = {
      [`${FOLDER}/a.sql`]: header({ 引擎: 'mysql' })
        + 'insert overwrite table dwd_olist_test.dwd_olist_order_d select * from ods_olist_test.ods_olist_order_d;\n',
    };
    const { findByTestId, container } = renderModal({
      dsApi,
      codeFilePaths: Object.keys(prodFiles),
      readFileContent: vi.fn(async (p: string) => prodFiles[p] ?? ''),
    });

    fireEvent.click(envRadio('prod'));
    fireEvent.click(await findByTestId('wf-save'));

    await waitFor(() => expect(container.textContent).toContain('非生产库「ods_olist_test」'));
    // 行号是代码里的真实行号：代码头占 1-3 行，SQL 语句在第 4 行
    expect(container.textContent).toContain('「a.sql」第 4 行');
    expect(container.textContent).toContain('dwd_olist_test');
    expect(dsApi.workflowDefinition.createWithTasks).not.toHaveBeenCalled();
    expect(dsApi.workflowDefinition.update).not.toHaveBeenCalled();
  });

  it('生产环境：代码全部引用生产库时照常提交（闸门不误拦）', async () => {
    const dsApi = makeDsApi({ projects: [{ code: 11, name: 'demo' }], workflows: [] });
    const prodFiles: Record<string, string> = {
      [`${FOLDER}/a.sql`]: header({ 引擎: 'mysql' })
        + 'select * from ods_olist_prod.ods_olist_order_d;\n',
    };
    const { findByTestId } = renderModal({
      dsApi,
      codeFilePaths: Object.keys(prodFiles),
      readFileContent: vi.fn(async (p: string) => prodFiles[p] ?? ''),
    });

    fireEvent.click(envRadio('prod'));
    fireEvent.click(await findByTestId('wf-save'));

    await waitFor(() => expect(dsApi.workflowDefinition.createWithTasks).toHaveBeenCalledTimes(1));
    expect(dsApi.workflowDefinition.createWithTasks.mock.calls[0][1].name).toBe('demo_prod');
  });

  it('角色准入：数据开发工程师（无生产权限）用测试环境照常保存', async () => {
    const dsApi = makeDsApi({ projects: [{ code: 11, name: 'demo' }], workflows: [] });
    const files: Record<string, string> = {
      [`${FOLDER}/a.sql`]: header({ 引擎: 'mysql' }) + 'select * from ods_olist_test.ods_olist_order_d;\n',
    };
    const { findByTestId } = renderModal({
      dsApi,
      canSubmitSchedule: true,
      canSubmitProd: false,
      codeFilePaths: Object.keys(files),
      readFileContent: vi.fn(async (p: string) => files[p] ?? ''),
    });

    // 「生产」置灰，灰度/测试可选
    expect(envRadio('prod').disabled).toBe(true);
    expect(envOption('prod').getAttribute('data-disabled')).toBe('true');
    expect(envRadio('gray').disabled).toBe(false);
    expect(envRadio('test').disabled).toBe(false);

    fireEvent.click(await findByTestId('wf-save'));

    await waitFor(() => expect(dsApi.workflowDefinition.createWithTasks).toHaveBeenCalledTimes(1));
    expect(dsApi.workflowDefinition.createWithTasks.mock.calls[0][1].name).toBe('demo_test');
  });

  it('角色准入：无提交调度权限时保存被拦截并提示', async () => {
    const dsApi = makeDsApi({ projects: [{ code: 11, name: 'demo' }], workflows: [] });
    const { findByTestId, container } = renderModal({
      dsApi,
      canSubmitSchedule: false,
      canSubmitProd: false,
    });

    fireEvent.click(await findByTestId('wf-save'));

    await waitFor(() => expect(container.textContent).toContain('当前角色无权提交调度'));
    expect(dsApi.workflowDefinition.createWithTasks).not.toHaveBeenCalled();
    expect(dsApi.workflowDefinition.update).not.toHaveBeenCalled();
  });

  it('打开弹窗即自动配置跨工作流前置依赖：编辑器直接收到「前置依赖」节点与连线', async () => {
    const extFiles: Record<string, string> = {
      [`${FOLDER}/a.scala`]: header({ 引擎: 'spark' }) + 'object A {}\n',
      [`${FOLDER}/h.scala`]: header({ 引擎: 'spark', 依赖: 'demo.ext_task' }) + 'object H {}\n',
    };
    const dsApi = makeDsApi({
      projects: [{ code: 11, name: 'demo' }],
      workflows: [],
      externalTasks: [{ code: 700, name: 'ext_task' }],
    });

    const { findByTestId, container } = renderModal({
      dsApi,
      codeFilePaths: Object.keys(extFiles),
      readFileContent: vi.fn(async (p: string) => extFiles[p] ?? ''),
    });

    await findByTestId('wf-editor');
    // 关键：不等保存，草稿阶段就该把 DEPENDENT 节点与连线准备好，用户在画布上直接可见
    const editorOf = () => document.querySelector('[data-testid="wf-editor"]')!;
    await waitFor(() =>
      expect(editorOf().getAttribute('data-node-names')).toContain('前置依赖_h')
    );
    // a、h 两个代码任务 + 1 个自动生成的「前置依赖_h」
    expect(editorOf().getAttribute('data-node-names')?.split(',')).toHaveLength(3);
    expect(editorOf().getAttribute('data-edge-count')).toBe('1');
    // 不再是「未自动连线」的含糊提示，而是明确告知已自动配置
    expect(container.textContent).not.toContain('不在本文件夹内');
    expect(container.textContent).toContain('已为 1 个跨工作流前置依赖自动生成');
  });

  it('外部 @依赖：保存时自动生成「前置依赖」DEPENDENT 节点并连边', async () => {
    // 用 sql 文件（非可编译）避免走编译/上传，聚焦依赖重建这条链路
    const extFiles: Record<string, string> = {
      [`${FOLDER}/a.sql`]: header({ 引擎: 'mysql' }) + 'select 1;\n',
      [`${FOLDER}/h.sql`]: header({ 引擎: 'mysql', 依赖: 'demo.ext_task' }) + 'select 2;\n',
    };
    const dsApi = makeDsApi({
      projects: [{ code: 11, name: 'demo' }],
      workflows: [],
      externalTasks: [{ code: 700, name: 'ext_task' }],
    });

    const { findByTestId } = renderModal({
      dsApi,
      codeFilePaths: Object.keys(extFiles),
      readFileContent: vi.fn(async (p: string) => extFiles[p] ?? ''),
    });

    // 必须等「前置依赖_h」出现再点保存：编辑器的 key 含节点数
    // （`${filesKey}-${draft.nodes.length}`），自动生成的依赖节点到达时 key 变化 →
    // React 会卸载旧编辑器再挂新的，此时点的是**已卸载的按钮**，点击不会触发保存。
    // 不等这一步就会变成「偶发超时 20s」的假失败（异步解析完成的早晚取决于机器负载）。
    const editorOf = () => document.querySelector('[data-testid="wf-editor"]')!;
    await waitFor(() =>
      expect(editorOf().getAttribute('data-node-names')).toContain('前置依赖_h')
    );

    fireEvent.click(await findByTestId('wf-save'));
    // 机器负载高时 jsdom 下异步链路会被显著拖慢，放宽等待
    await waitFor(() => expect(dsApi.workflowDefinition.createWithTasks).toHaveBeenCalledTimes(1), { timeout: 20000 });

    const [, payload] = dsApi.workflowDefinition.createWithTasks.mock.calls[0] as any;
    // 生成了「前置依赖_h」DEPENDENT 节点
    const depNode = payload.nodes.find((n: any) => n.name === '前置依赖_h');
    expect(depNode).toBeTruthy();
    expect(depNode.taskType).toBe('DEPENDENT');
    // 连边：前置依赖_h -> h
    const hNode = payload.nodes.find((n: any) => n.name === 'h');
    expect(payload.edges).toContainEqual({
      id: expect.any(String),
      sourceCode: depNode.code,
      targetCode: hNode.code,
    });
    // DEPENDENT 节点的 taskParams 里包含前置任务 code
    const depParams = JSON.parse(depNode.taskParams);
    expect(depParams.dependence.dependTaskList[0].dependItemList[0].depTaskCode).toBe(700);
  });

  it('找不到与项目编码同名的调度项目时：给出提示且不提交', async () => {
    const dsApi = makeDsApi({ projects: [{ code: 11, name: 'other_project' }] });
    const { findByTestId, container } = renderModal({ dsApi });

    fireEvent.click(await findByTestId('wf-save'));

    await waitFor(() =>
      expect(container.textContent).toContain('未找到名称与项目编码「demo」一致的调度项目')
    );
    expect(dsApi.workflowDefinition.createWithTasks).not.toHaveBeenCalled();
    expect(dsApi.workflowDefinition.update).not.toHaveBeenCalled();
  });

  it('依赖成环给出提示；调度系统中找不到的外部依赖也给出提示', async () => {
    const cyclic: Record<string, string> = {
      [`${FOLDER}/f.scala`]: header({ 引擎: 'spark', 依赖: 'demo.g' }) + 'object F {}\n',
      [`${FOLDER}/g.scala`]: header({ 引擎: 'spark', 依赖: 'demo.f' }) + 'object G {}\n',
      [`${FOLDER}/h.scala`]: header({ 引擎: 'spark', 依赖: 'other.x' }) + 'object H {}\n',
    };
    const { findByTestId, container } = renderModal({
      codeFilePaths: Object.keys(cyclic),
      readFileContent: vi.fn(async (p: string) => cyclic[p] ?? ''),
    });

    await findByTestId('wf-editor');
    expect(container.textContent).toContain('依赖存在环');
    // other.x 在调度系统里查不到 → 明确告知未能自动配置（而不是旧的「不在本文件夹内」含糊提示）
    await waitFor(() =>
      expect(container.textContent).toContain('以下前置依赖在调度系统中未找到对应任务')
    );
    // 查不到的依赖不会凭空生成「前置依赖」节点
    const nodeNames = document.querySelector('[data-testid="wf-editor"]')!
      .getAttribute('data-node-names');
    expect(nodeNames).not.toContain('前置依赖');
  });

  it('没有代码文件时给出错误态，不渲染编辑器', async () => {
    const { queryByTestId, container } = renderModal({ codeFilePaths: [] });

    await waitFor(() => expect(container.textContent).toContain('没有可提交调度的代码文件'));
    expect(queryByTestId('wf-editor')).toBeNull();
  });
});
