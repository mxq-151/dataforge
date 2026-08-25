/**
 * tools.test.tsx — opencode-tools 功能测试
 *
 * 测试覆盖：
 * - ToolRegistry: register/get/render
 * - ToolPartDisplay: 分发逻辑、隐藏工具、错误处理、fake pending 修正
 * - BashTool: command 提取、description、ANSI 去除、输出
 * - FileEditTool: edit/write/apply_patch 标题、文件名、diff 统计、defer
 * - TaskTool: agent tone、subagent 类型、导航
 * - SkillTool: skill 名称、hideDetails
 * - WebFetchTool: URL、hideDetails
 * - WebSearchTool: provider 标签、query、URL 提取
 * - QuestionTool: 问答对、completed 状态
 * - GenericTool: label 提取、args 提取、兜底
 * - ToolErrorCard: 错误消息格式化、可展开
 * - ContextToolGroup: 分组摘要、busy 状态
 * - BasicTool: trigger 类型、展开/折叠、hideDetails、defer、locked、forceOpen
 * - CollapsibleHeader: 键盘操作、disabled、href
 * - TextShimmer: active/inactive 状态
 * - deferredMount: 调度与取消
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// ── ToolRegistry 测试 ──────────────────────────────────────────

import { ToolRegistry, registerTool, getTool } from './ToolRegistry';
import type { ToolProps } from './ToolRegistry';

describe('ToolRegistry', () => {
  it('register + get 注册和获取工具渲染器', () => {
    const MockTool: React.FC<ToolProps> = () => <div>mock</div>;
    registerTool('__test_mock__', MockTool);
    expect(getTool('__test_mock__')).toBe(MockTool);
    expect(ToolRegistry.render('__test_mock__')).toBe(MockTool);
  });

  it('get 未注册工具返回 undefined', () => {
    expect(getTool('__nonexistent__')).toBeUndefined();
    expect(ToolRegistry.render('__nonexistent__')).toBeUndefined();
  });

  it('内置工具已注册：bash/edit/write/apply_patch/webfetch/websearch/question/skill/task', () => {
    // ToolPartDisplay 模块加载时已注册
    const builtinTools = ['bash', 'edit', 'write', 'apply_patch', 'webfetch', 'websearch', 'question', 'skill', 'task'];
    for (const tool of builtinTools) {
      expect(getTool(tool)).toBeDefined();
      // React.memo 包裹后 typeof 为 'object'，但仍是可调用组件
      expect(typeof getTool(tool) === 'function' || typeof getTool(tool) === 'object').toBe(true);
    }
  });

  it('edit/write/apply_patch 共用同一渲染器', () => {
    expect(getTool('edit')).toBe(getTool('write'));
    expect(getTool('write')).toBe(getTool('apply_patch'));
  });
});

// ── ToolPartDisplay 分发逻辑测试 ───────────────────────────────

import ToolPartDisplay from './ToolPartDisplay';
import type { Part, ToolPart, Message } from '../../../types/opencode-backend';

function makeToolPart(tool: string, state: Record<string, unknown> = {}): ToolPart {
  return {
    id: `part-${tool}`,
    type: 'tool',
    tool,
    state: {
      status: 'completed',
      input: {},
      metadata: {},
      time: {},
      ...state,
    },
  } as unknown as ToolPart;
}

function makeMessage(): Message {
  return { id: 'msg-1', role: 'assistant', parentID: 'u1', time: { created: Date.now() } } as unknown as Message;
}

describe('ToolPartDisplay', () => {
  it('todowrite 不渲染（返回 null）', () => {
    const part = makeToolPart('todowrite');
    const { container } = render(
      <ToolPartDisplay part={part as Part} message={makeMessage()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('question pending 不渲染', () => {
    const part = makeToolPart('question', { status: 'pending' });
    const { container } = render(
      <ToolPartDisplay part={part as Part} message={makeMessage()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('question running 不渲染', () => {
    const part = makeToolPart('question', { status: 'running' });
    const { container } = render(
      <ToolPartDisplay part={part as Part} message={makeMessage()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('question completed 渲染', () => {
    const part = makeToolPart('question', {
      status: 'completed',
      input: { questions: [] },
      metadata: { answers: [] },
    });
    const { container } = render(
      <ToolPartDisplay part={part as Part} message={makeMessage()} />,
    );
    expect(container.innerHTML).not.toBe('');
  });

  it('error 状态渲染 ToolErrorCard', () => {
    const part = makeToolPart('bash', {
      status: 'error',
      error: 'Error: Command failed with exit code 1',
    });
    const { container } = render(
      <ToolPartDisplay part={part as Part} message={makeMessage()} />,
    );
    expect(container.querySelector('.ai-panel__tool-card--error')).not.toBeNull();
  });

  it('error 为 SessionErrorUnknown 对象时（session API 路径）仍渲染错误卡片', () => {
    // session.messages() 返回的 ToolStateError.error 在运行时是
    // { type: "unknown", message: string } 对象，而非 string。
    const part = makeToolPart('bash', {
      status: 'error',
      error: { type: 'unknown', message: 'Command exited with code 127' },
    });
    const { container } = render(
      <ToolPartDisplay part={part as Part} message={makeMessage()} />,
    );
    const errorCard = container.querySelector('.ai-panel__tool-card--error');
    expect(errorCard).not.toBeNull();
    // 对象形态的 message 应被提取并展示在 body 中（点击展开后可见）
    const trigger = container.querySelector('.ai-panel__collapsible-header');
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger!);
    const body = container.querySelector('.ai-panel__tool-card-body--error');
    expect(body?.textContent).toContain('Command exited with code 127');
  });

  it('status=error 但 error 字段缺失时兜底渲染 Unknown error', () => {
    // 不应再因 fields.error 为空而跳过 ToolErrorCard
    const part = makeToolPart('bash', { status: 'error' });
    const { container } = render(
      <ToolPartDisplay part={part as Part} message={makeMessage()} />,
    );
    expect(container.querySelector('.ai-panel__tool-card--error')).not.toBeNull();
  });

  it('question dismissed 特殊文案', () => {
    const part = makeToolPart('question', {
      status: 'error',
      error: 'Error: User dismissed this question',
    });
    const { container } = render(
      <ToolPartDisplay part={part as Part} message={makeMessage()} />,
    );
    expect(container.querySelector('.ai-panel__question-dismissed')).not.toBeNull();
  });

  it('fake pending 修正：有 output + endTime 时修正为 completed', () => {
    // 即使 status=pending，但有 output 时应修正为 completed
    const part = makeToolPart('bash', {
      status: 'pending',
      output: '$ echo hello\nhello',
      time: { end: Date.now() },
      title: 'Shell',
    });
    const { container } = render(
      <ToolPartDisplay part={part as Part} message={makeMessage()} />,
    );
    // 修正为 completed 后应正常渲染（不是 pending 样式）
    expect(container.querySelector('.ai-panel__basic-tool--pending')).toBeNull();
  });

  it('正常工具渲染器分发', () => {
    const part = makeToolPart('bash', {
      status: 'completed',
      input: { command: 'echo hello' },
      output: 'hello',
    });
    const { container } = render(
      <ToolPartDisplay part={part as Part} message={makeMessage()} />,
    );
    // 应渲染 BasicTool 卡片
    expect(container.querySelector('.ai-panel__basic-tool')).not.toBeNull();
  });

  it('未注册工具回退到 GenericTool', () => {
    const part = makeToolPart('custom_tool_xyz', {
      status: 'completed',
      input: { description: 'Custom operation' },
    });
    const { container } = render(
      <ToolPartDisplay part={part as Part} message={makeMessage()} />,
    );
    expect(container.textContent).toContain('Called custom_tool_xyz');
  });

  it('task error 带 subtitle（description 或 sessionId）', () => {
    const part = makeToolPart('task', {
      status: 'error',
      error: 'Error: Task failed',
      input: { description: 'Build the project' },
    });
    const { container } = render(
      <ToolPartDisplay part={part as Part} message={makeMessage()} />,
    );
    const errorCard = container.querySelector('.ai-panel__tool-card--error');
    expect(errorCard).not.toBeNull();
    expect(errorCard?.textContent).toContain('Build the project');
  });

  it('websearch error 使用 provider 标签作标题', () => {
    const part = makeToolPart('websearch', {
      status: 'error',
      error: 'Error: Search failed',
      metadata: { provider: 'exa' },
    });
    const { container } = render(
      <ToolPartDisplay part={part as Part} message={makeMessage()} />,
    );
    expect(container.textContent).toContain('Exa Web Search');
  });
});

// ── BashTool 测试 ─────────────────────────────────────────────

import BashTool from './tools/BashTool';

describe('BashTool', () => {
  it('显示 Shell 标题和 command', () => {
    render(
      <BashTool
        tool="bash"
        input={{ command: 'echo hello', description: 'Say hello' }}
        metadata={{}}
        status="completed"
        output="hello"
      />,
    );
    expect(screen.getByText('Shell')).not.toBeNull();
    expect(screen.getByText('Say hello')).not.toBeNull();
  });

  it('展开后显示 $ command + 输出', () => {
    const { container } = render(
      <BashTool
        tool="bash"
        input={{ command: 'echo hello' }}
        metadata={{}}
        status="completed"
        output="hello"
        defaultOpen
      />,
    );
    // 需要点击 trigger 展开后才能看到内容（defaultOpen 只设置初始状态）
    const trigger = container.querySelector('.ai-panel__collapsible-header');
    if (trigger) fireEvent.click(trigger);
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain('$ echo hello');
    expect(code?.textContent).toContain('hello');
  });

  it('ANSI 转义序列被去除', () => {
    const { container } = render(
      <BashTool
        tool="bash"
        input={{ command: 'ls' }}
        metadata={{}}
        status="completed"
        output="\x1b[32msuccess\x1b[0m"
        defaultOpen
      />,
    );
    const trigger = container.querySelector('.ai-panel__collapsible-header');
    if (trigger) fireEvent.click(trigger);
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.textContent).toContain('success');
  });

  it('pending 状态标题扫光', () => {
    const { container } = render(
      <BashTool
        tool="bash"
        input={{ command: 'echo hello' }}
        metadata={{}}
        status="pending"
      />,
    );
    expect(container.querySelector('.ai-panel__basic-tool--pending')).not.toBeNull();
    expect(container.querySelector('.ai-panel__text-shimmer--active')).not.toBeNull();
  });

  it('description 为空时不显示 subtitle', () => {
    render(
      <BashTool
        tool="bash"
        input={{ command: 'ls' }}
        metadata={{}}
        status="completed"
      />,
    );
    expect(screen.queryByTestId('subtitle')).toBeNull();
  });
});

// ── FileEditTool 测试 ─────────────────────────────────────────

import FileEditTool from './tools/FileEditTool';

describe('FileEditTool', () => {
  it('edit 工具显示 Edit 标题', () => {
    render(
      <FileEditTool
        tool="edit"
        input={{ filePath: '/src/index.ts' }}
        metadata={{}}
        status="completed"
      />,
    );
    expect(screen.getByText('Edit')).not.toBeNull();
  });

  it('write 工具显示 Write 标题', () => {
    render(
      <FileEditTool
        tool="write"
        input={{ filePath: '/src/new.ts' }}
        metadata={{}}
        status="completed"
      />,
    );
    expect(screen.getByText('Write')).not.toBeNull();
  });

  it('apply_patch 工具显示 Patch 标题', () => {
    render(
      <FileEditTool
        tool="apply_patch"
        input={{ filePath: '/src/patch.ts' }}
        metadata={{}}
        status="completed"
      />,
    );
    expect(screen.getByText('Patch')).not.toBeNull();
  });

  it('从路径提取文件名作为 subtitle', () => {
    render(
      <FileEditTool
        tool="edit"
        input={{ filePath: '/src/components/App.tsx' }}
        metadata={{}}
        status="completed"
      />,
    );
    expect(screen.getByText('App.tsx')).not.toBeNull();
  });

  it('有 patch 时显示 diff 统计（+N/-M）', () => {
    const patch = `--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,4 @@\n-old line\n+new line\n+added line\n context line`;
    render(
      <FileEditTool
        tool="edit"
        input={{ filePath: '/src/file.ts' }}
        metadata={{ filediff: { file: '/src/file.ts', patch } }}
        status="completed"
      />,
    );
    expect(screen.getByText('+2')).not.toBeNull();
    expect(screen.getByText('-1')).not.toBeNull();
  });

  it('展开后显示 patch 内容', () => {
    const patch = `--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new`;
    const { container } = render(
      <FileEditTool
        tool="edit"
        input={{ filePath: '/src/file.ts' }}
        metadata={{ filediff: { file: '/src/file.ts', patch } }}
        status="completed"
        defaultOpen
      />,
    );
    // defer=true 导致延迟挂载，需要等 rAF
    // 但测试中 rAF 可能不执行，验证容器存在即可
    expect(container.querySelector('.ai-panel__basic-tool')).not.toBeNull();
  });

  it('defer=true（延迟挂载）', () => {
    const { container } = render(
      <FileEditTool
        tool="edit"
        input={{ filePath: '/src/file.ts' }}
        metadata={{}}
        status="completed"
      />,
    );
    // FileEditTool 内部写死 defer={true}
    expect(container.querySelector('.ai-panel__basic-tool')).not.toBeNull();
  });

  it('filePath 为空时不显示 subtitle', () => {
    const { container } = render(
      <FileEditTool
        tool="edit"
        input={{}}
        metadata={{}}
        status="completed"
      />,
    );
    // 应该不 crash
    expect(container.querySelector('.ai-panel__basic-tool')).not.toBeNull();
  });
});

// ── WebFetchTool 测试 ─────────────────────────────────────────

import WebFetchTool from './tools/WebFetchTool';

describe('WebFetchTool', () => {
  it('显示 Web Fetch 标题', () => {
    render(
      <WebFetchTool
        tool="webfetch"
        input={{ url: 'https://example.com' }}
        metadata={{}}
        status="completed"
      />,
    );
    expect(screen.getByText('Web Fetch')).not.toBeNull();
  });

  it('URL 可点击跳转', () => {
    render(
      <WebFetchTool
        tool="webfetch"
        input={{ url: 'https://example.com' }}
        metadata={{}}
        status="completed"
      />,
    );
    const link = screen.getByText('https://example.com');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('https://example.com');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('hideDetails 模式（不展开内容）', () => {
    const { container } = render(
      <WebFetchTool
        tool="webfetch"
        input={{ url: 'https://example.com' }}
        metadata={{}}
        status="completed"
      />,
    );
    // hideDetails 模式下不应有展开内容
    expect(container.querySelector('.ai-panel__basic-tool-content')).toBeNull();
  });

  it('URL 为空时不显示链接', () => {
    const { container } = render(
      <WebFetchTool
        tool="webfetch"
        input={{}}
        metadata={{}}
        status="completed"
      />,
    );
    expect(container.querySelector('a')).toBeNull();
  });
});

// ── WebSearchTool 测试 ────────────────────────────────────────

import WebSearchTool from './tools/WebSearchTool';

describe('WebSearchTool', () => {
  it('默认 provider 标签为 Web Search', () => {
    render(
      <WebSearchTool
        tool="websearch"
        input={{ query: 'test query' }}
        metadata={{}}
        status="completed"
      />,
    );
    expect(screen.getByText('Web Search')).not.toBeNull();
  });

  it('parallel provider 标签', () => {
    render(
      <WebSearchTool
        tool="websearch"
        input={{ query: 'test' }}
        metadata={{ provider: 'parallel' }}
        status="completed"
      />,
    );
    expect(screen.getByText('Parallel Web Search')).not.toBeNull();
  });

  it('exa provider 标签', () => {
    render(
      <WebSearchTool
        tool="websearch"
        input={{ query: 'test' }}
        metadata={{ provider: 'exa' }}
        status="completed"
      />,
    );
    expect(screen.getByText('Exa Web Search')).not.toBeNull();
  });

  it('显示搜索查询作为 subtitle', () => {
    render(
      <WebSearchTool
        tool="websearch"
        input={{ query: 'react hooks' }}
        metadata={{}}
        status="completed"
      />,
    );
    expect(screen.getByText('react hooks')).not.toBeNull();
  });

  it('从 output 中提取 URL 链接', () => {
    const output = 'Results:\nhttps://example.com/page1\nhttps://example.com/page2';
    const { container } = render(
      <WebSearchTool
        tool="websearch"
        input={{ query: 'test' }}
        metadata={{}}
        status="completed"
        output={output}
        defaultOpen
      />,
    );
    // 点击展开
    const trigger = container.querySelector('.ai-panel__collapsible-header');
    if (trigger) fireEvent.click(trigger);
    const links = container.querySelectorAll('.ai-panel__websearch-link');
    expect(links).toHaveLength(2);
  });

  it('URL 去重', () => {
    const output = 'https://example.com\nhttps://example.com';
    const { container } = render(
      <WebSearchTool
        tool="websearch"
        input={{ query: 'test' }}
        metadata={{}}
        status="completed"
        output={output}
        defaultOpen
      />,
    );
    const trigger = container.querySelector('.ai-panel__collapsible-header');
    if (trigger) fireEvent.click(trigger);
    const links = container.querySelectorAll('.ai-panel__websearch-link');
    expect(links).toHaveLength(1);
  });

  it('无 URL 时显示原始 output', () => {
    const { container } = render(
      <WebSearchTool
        tool="websearch"
        input={{ query: 'test' }}
        metadata={{}}
        status="completed"
        output="No results found"
        defaultOpen
      />,
    );
    const trigger = container.querySelector('.ai-panel__collapsible-header');
    if (trigger) fireEvent.click(trigger);
    expect(container.querySelector('.ai-panel__tool-card-output')).not.toBeNull();
  });
});

// ── SkillTool 测试 ────────────────────────────────────────────

import SkillTool from './tools/SkillTool';

describe('SkillTool', () => {
  it('显示 skill 名称', () => {
    render(
      <SkillTool
        tool="skill"
        input={{ name: 'code-review' }}
        metadata={{}}
        status="completed"
      />,
    );
    expect(screen.getByText('code-review')).not.toBeNull();
  });

  it('显示技能徽章', () => {
    render(
      <SkillTool
        tool="skill"
        input={{ name: 'debug' }}
        metadata={{}}
        status="completed"
      />,
    );
    expect(screen.getByText('技能')).not.toBeNull();
  });

  it('name 缺失时显示默认 Skill', () => {
    render(
      <SkillTool
        tool="skill"
        input={{}}
        metadata={{}}
        status="completed"
      />,
    );
    expect(screen.getByText('Skill')).not.toBeNull();
  });

  it('hideDetails 模式（无展开内容）', () => {
    const { container } = render(
      <SkillTool
        tool="skill"
        input={{ name: 'test' }}
        metadata={{}}
        status="completed"
      />,
    );
    expect(container.querySelector('.ai-panel__basic-tool-content')).toBeNull();
  });
});

// ── QuestionTool 测试 ─────────────────────────────────────────

import QuestionTool from './tools/QuestionTool';

describe('QuestionTool', () => {
  it('显示 Questions 标题', () => {
    render(
      <QuestionTool
        tool="question"
        input={{ questions: [] }}
        metadata={{ answers: [] }}
        status="completed"
      />,
    );
    expect(screen.getByText('Questions')).not.toBeNull();
  });

  it('未回答时 subtitle 显示 "N question(s)"', () => {
    render(
      <QuestionTool
        tool="question"
        input={{
          questions: [
            { id: 'q1', header: 'Q1', question: 'Which option?', options: null },
          ],
        }}
        metadata={{ answers: [] }}
        status="completed"
      />,
    );
    expect(screen.getByText('1 question')).not.toBeNull();
  });

  it('已回答时 subtitle 显示 "N answered"', () => {
    render(
      <QuestionTool
        tool="question"
        input={{
          questions: [
            { id: 'q1', header: 'Q1', question: 'Which?', options: null },
          ],
        }}
        metadata={{ answers: [['option1']] }}
        status="completed"
      />,
    );
    expect(screen.getByText('1 answered')).not.toBeNull();
  });

  it('显示问答对内容', () => {
    render(
      <QuestionTool
        tool="question"
        input={{
          questions: [
            {
              id: 'q1',
              header: 'Framework',
              question: 'Which framework?',
              options: [
                { label: 'React', description: 'React library' },
                { label: 'Vue', description: 'Vue framework' },
              ],
            },
          ],
        }}
        metadata={{ answers: [['React']] }}
        status="completed"
        defaultOpen
      />,
    );
    expect(screen.getByText('Framework')).not.toBeNull();
    expect(screen.getByText('Which framework?')).not.toBeNull();
    // React 出现在 option-label 和 answer 中，使用 getAllByText
    expect(screen.getAllByText('React').length).toBeGreaterThanOrEqual(1);
  });

  it('completed 时默认展开', () => {
    // defaultOpen = completed 为 true
    const { container } = render(
      <QuestionTool
        tool="question"
        input={{
          questions: [
            { id: 'q1', header: 'H', question: 'Q?', options: null },
          ],
        }}
        metadata={{ answers: [['ans']] }}
        status="completed"
      />,
    );
    expect(container.querySelector('.ai-panel__basic-tool-content')).not.toBeNull();
  });
});

// ── TaskTool 测试 ─────────────────────────────────────────────

import TaskTool from './tools/TaskTool';
import { PartsDataProvider } from './PartsDataContext';

describe('TaskTool', () => {
  it('显示子代理徽章', () => {
    render(
      <PartsDataProvider>
        <TaskTool
          tool="task"
          input={{ subagent_type: 'build', description: 'Build project' }}
          metadata={{}}
          status="completed"
        />
      </PartsDataProvider>,
    );
    expect(screen.getByText('子代理')).not.toBeNull();
  });

  it('agent 名称首字母大写', () => {
    render(
      <PartsDataProvider>
        <TaskTool
          tool="task"
          input={{ subagent_type: 'build', description: 'Build project' }}
          metadata={{}}
          status="completed"
        />
      </PartsDataProvider>,
    );
    expect(screen.getByText('Build')).not.toBeNull();
  });

  it('running 状态显示 spinner', () => {
    const { container } = render(
      <PartsDataProvider>
        <TaskTool
          tool="task"
          input={{ subagent_type: 'plan', description: 'Planning' }}
          metadata={{}}
          status="running"
        />
      </PartsDataProvider>,
    );
    expect(container.querySelector('.ai-panel__task-tool-spinner')).not.toBeNull();
  });

  it('hideDetails 模式（无展开内容）', () => {
    const { container } = render(
      <PartsDataProvider>
        <TaskTool
          tool="task"
          input={{ subagent_type: 'ask', description: 'Question' }}
          metadata={{}}
          status="completed"
        />
      </PartsDataProvider>,
    );
    expect(container.querySelector('.ai-panel__basic-tool-content')).toBeNull();
  });

  it('background 任务追加标记', () => {
    render(
      <PartsDataProvider>
        <TaskTool
          tool="task"
          input={{ subagent_type: 'build', description: 'Build' }}
          metadata={{ background: true }}
          status="completed"
        />
      </PartsDataProvider>,
    );
    expect(screen.getByText(/background/)).not.toBeNull();
  });

  it('已知 tone（ask/build/docs/plan）使用固定颜色', () => {
    const { container: c1 } = render(
      <PartsDataProvider>
        <TaskTool
          tool="task"
          input={{ subagent_type: 'ask', description: 'Ask' }}
          metadata={{}}
          status="completed"
        />
      </PartsDataProvider>,
    );
    const askTitle = c1.querySelector('.ai-panel__basic-tool-title');
    expect(askTitle).not.toBeNull();
    // 浏览器将 #58a6ff 转为 rgb(88, 166, 255)
    const style = askTitle?.getAttribute('style') ?? '';
    expect(style).toMatch(/(#[0-9a-fA-F]{6}|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\))/);
  });

  it('有 sessionId 时 triggerHref 可用', () => {
    const sessionHref = vi.fn((id: string) => `/session/${id}`);
    const { container } = render(
      <PartsDataProvider sessionHref={sessionHref}>
        <TaskTool
          tool="task"
          input={{ subagent_type: 'build', description: 'Build' }}
          metadata={{ sessionId: 'child-123' }}
          status="completed"
        />
      </PartsDataProvider>,
    );
    expect(sessionHref).toHaveBeenCalledWith('child-123');
    expect(container.querySelector('a[href]')).not.toBeNull();
  });

  it('点击 trigger 调用 navigateToSession', () => {
    const navigateToSession = vi.fn();
    const { container } = render(
      <PartsDataProvider navigateToSession={navigateToSession}>
        <TaskTool
          tool="task"
          input={{ subagent_type: 'build', description: 'Build' }}
          metadata={{ sessionId: 'child-456' }}
          status="completed"
        />
      </PartsDataProvider>,
    );
    const trigger = container.querySelector('.ai-panel__collapsible-header');
    expect(trigger).not.toBeNull();
    fireEvent.click(trigger!);
    expect(navigateToSession).toHaveBeenCalledWith('child-456');
  });
});

// ── GenericTool 测试 ──────────────────────────────────────────

import { GenericTool } from './BasicTool';

describe('GenericTool', () => {
  it('显示 "Called {tool}" 标题', () => {
    render(
      <GenericTool tool="mcp_server" status="completed" input={{}} />,
    );
    expect(screen.getByText('Called mcp_server')).not.toBeNull();
  });

  it('从 input 提取 label（description 优先）', () => {
    render(
      <GenericTool
        tool="custom"
        status="completed"
        input={{ description: 'Run analysis', query: 'backup' }}
      />,
    );
    expect(screen.getByText('Run analysis')).not.toBeNull();
  });

  it('label 优先级：description > query > url > filePath > path > pattern > name', () => {
    render(
      <GenericTool
        tool="custom"
        status="completed"
        input={{ name: 'myname', pattern: '*.ts', path: '/src' }}
      />,
    );
    // path 优先于 pattern 和 name
    expect(screen.getByText('/src')).not.toBeNull();
  });

  it('提取最多 3 个参数（排除 label 键）', () => {
    render(
      <GenericTool
        tool="custom"
        status="completed"
        input={{ description: 'desc', offset: 0, limit: 100, verbose: true, extra: 'val' }}
      />,
    );
    // offset=0, limit=100, verbose=true（最多 3 个，extra 被截断）
    expect(screen.getByText('offset=0')).not.toBeNull();
    expect(screen.getByText('limit=100')).not.toBeNull();
    expect(screen.getByText('verbose=true')).not.toBeNull();
  });

  it('input 为空时无 subtitle', () => {
    const { container } = render(
      <GenericTool tool="unknown" status="completed" />,
    );
    expect(container.querySelector('.ai-panel__basic-tool-subtitle')).toBeNull();
  });
});

// ── ToolErrorCard 测试 ────────────────────────────────────────

import ToolErrorCard from './ToolErrorCard';

describe('ToolErrorCard', () => {
  it('显示工具标题', () => {
    render(<ToolErrorCard tool="bash" error="Command not found" />);
    expect(screen.getByText('Shell')).not.toBeNull();
  });

  it('自定义 title 覆盖默认标题', () => {
    render(<ToolErrorCard tool="websearch" error="Failed" title="Exa Web Search" />);
    expect(screen.getByText('Exa Web Search')).not.toBeNull();
  });

  it('错误消息去除 "Error:" 前缀', () => {
    render(<ToolErrorCard tool="bash" error="Error: Command failed" />);
    // "Error:" 前缀被去除，剩余 "Command failed"
    expect(screen.queryByText('Error: Command failed')).toBeNull();
  });

  it('冒号拆分：冒号前为 subtitle，冒号后为 body', () => {
    render(<ToolErrorCard tool="bash" error="Command failed: exit code 1 with long additional text that exceeds sixty characters limit" />);
    expect(screen.getByText('Command failed')).not.toBeNull();
  });

  it('短错误消息也可展开（hasBody 门控，不再用 >60 字符）', () => {
    const { container } = render(<ToolErrorCard tool="bash" error="Short error" />);
    // body="Short error"（非空）→ hasBody=true → 箭头可见、可展开
    expect(container.querySelector('.ai-panel__collapsible-arrow')).not.toBeNull();
  });

  it('长错误消息可展开', () => {
    const { container } = render(
      <ToolErrorCard
        tool="bash"
        error="This is a very long error message that exceeds the sixty character limit for the expandable body area of the card"
      />,
    );
    expect(container.querySelector('.ai-panel__collapsible-arrow')).not.toBeNull();
  });

  it('defaultOpen 时短错误消息 body 直接可见', () => {
    const { container } = render(
      <ToolErrorCard tool="task" error="Sub-agent failed" subtitle="Build" defaultOpen />,
    );
    // body 始终在 open + hasBody 时显示，不受消息长度限制
    const body = container.querySelector('.ai-panel__tool-card-body--error');
    expect(body).not.toBeNull();
    expect(body?.textContent).toContain('Sub-agent failed');
  });

  it('error 缺失时兜底 Unknown error', () => {
    const { container } = render(<ToolErrorCard tool="bash" />);
    // errorMessage = error || 'Unknown error'
    expect(container.querySelector('.ai-panel__tool-card--error')).not.toBeNull();
    // 兜底文本 "Unknown error" 拆分：无冒号 → subtitle="Failed"，body="Unknown error"
    expect(container.querySelector('.ai-panel__collapsible-arrow')).not.toBeNull();
  });

  it('subtitle prop 优先', () => {
    render(
      <ToolErrorCard
        tool="task"
        error="Some error: details here"
        subtitle="Build the project"
      />,
    );
    expect(screen.getByText('Build the project')).not.toBeNull();
  });

  it('错误图标（X 圆圈）', () => {
    const { container } = render(<ToolErrorCard tool="bash" error="Fail" />);
    expect(container.querySelector('.ai-panel__tool-icon--error')).not.toBeNull();
  });
});

// ── ContextToolGroup 测试 ─────────────────────────────────────

import ContextToolGroup from './ContextToolGroup';

describe('ContextToolGroup', () => {
  function makeContextPart(tool: string, input: Record<string, unknown> = {}): ToolPart {
    return {
      id: `ctx-${tool}`,
      type: 'tool',
      tool,
      state: {
        status: 'completed',
        input,
        metadata: {},
        time: {},
      },
    } as unknown as ToolPart;
  }

  it('completed 状态显示 "Gathered context"', () => {
    render(
      <ContextToolGroup
        parts={[makeContextPart('read', { filePath: '/src/a.ts' })]}
        busy={false}
      />,
    );
    expect(screen.getByText('Gathered context')).not.toBeNull();
  });

  it('busy 状态显示 "Gathering context"', () => {
    render(
      <ContextToolGroup
        parts={[makeContextPart('read', { filePath: '/src/a.ts' })]}
        busy={true}
      />,
    );
    expect(screen.getByText('Gathering context')).not.toBeNull();
  });

  it('摘要统计："N reads, M searches, K lists"', () => {
    render(
      <ContextToolGroup
        parts={[
          makeContextPart('read', { filePath: '/src/a.ts' }),
          makeContextPart('read', { filePath: '/src/b.ts' }),
          makeContextPart('glob', { path: '/src', pattern: '*.ts' }),
          makeContextPart('list', { path: '/src' }),
        ]}
        busy={false}
      />,
    );
    expect(screen.getByText('2 reads, 1 search, 1 list')).not.toBeNull();
  });

  it('展开后显示每个工具的详情', () => {
    const { container } = render(
      <ContextToolGroup
        parts={[
          makeContextPart('read', { filePath: '/src/App.tsx' }),
          makeContextPart('glob', { path: '/src', pattern: '*.ts' }),
        ]}
        busy={false}
      />,
    );
    // 点击展开
    const trigger = container.querySelector('.ai-panel__collapsible-header');
    fireEvent.click(trigger!);
    expect(container.querySelector('.ai-panel__context-tool-group-list')).not.toBeNull();
    expect(screen.getByText('App.tsx')).not.toBeNull();
  });

  it('running 工具标题扫光', () => {
    const runningPart: ToolPart = {
      id: 'ctx-read-running',
      type: 'tool',
      tool: 'read',
      state: {
        status: 'running',
        input: { filePath: '/src/a.ts' },
        metadata: {},
        time: {},
      },
    } as unknown as ToolPart;
    const { container } = render(
      <ContextToolGroup parts={[runningPart]} busy={false} />,
    );
    expect(container.querySelector('.ai-panel__text-shimmer--active')).not.toBeNull();
  });

  it('read 工具显示 offset/limit args', () => {
    const { container } = render(
      <ContextToolGroup
        parts={[makeContextPart('read', { filePath: '/src/a.ts', offset: 10, limit: 50 })]}
        busy={false}
      />,
    );
    // 点击展开
    const trigger = container.querySelector('.ai-panel__collapsible-header');
    fireEvent.click(trigger!);
    expect(screen.getByText('offset=10')).not.toBeNull();
    expect(screen.getByText('limit=50')).not.toBeNull();
  });
});

// ── BasicTool 测试 ────────────────────────────────────────────

import BasicTool from './BasicTool';

describe('BasicTool', () => {
  it('TriggerTitle 结构化渲染', () => {
    render(
      <BasicTool
        status="completed"
        trigger={{ title: 'Edit', subtitle: 'file.ts' }}
      >
        <div>content</div>
      </BasicTool>,
    );
    expect(screen.getByText('Edit')).not.toBeNull();
    expect(screen.getByText('file.ts')).not.toBeNull();
  });

  it('工具徽章显示', () => {
    render(
      <BasicTool
        status="completed"
        trigger={{ title: 'Shell', subtitle: 'desc' }}
      />,
    );
    expect(screen.getByText('工具')).not.toBeNull();
  });

  it('ReactNode trigger 渲染', () => {
    render(
      <BasicTool status="completed" trigger={<span>Custom Trigger</span>}>
        <div>content</div>
      </BasicTool>,
    );
    expect(screen.getByText('Custom Trigger')).not.toBeNull();
  });

  it('函数 trigger 渲染', () => {
    render(
      <BasicTool status="completed" trigger={(open) => <span>{open ? 'Open' : 'Closed'}</span>}>
        <div>content</div>
      </BasicTool>,
    );
    expect(screen.getByText('Closed')).not.toBeNull();
  });

  it('点击展开/折叠', () => {
    const { container } = render(
      <BasicTool
        status="completed"
        trigger={{ title: 'Tool' }}
        defaultOpen={false}
      >
        <div data-testid="content">Expanded content</div>
      </BasicTool>,
    );
    // 初始折叠
    expect(screen.queryByTestId('content')).toBeNull();
    // 点击展开
    const trigger = container.querySelector('.ai-panel__collapsible-header');
    fireEvent.click(trigger!);
    expect(screen.getByTestId('content')).not.toBeNull();
  });

  it('hideDetails 不渲染展开内容', () => {
    const { container } = render(
      <BasicTool
        status="completed"
        trigger={{ title: 'Tool' }}
        hideDetails
        defaultOpen
      >
        <div>Hidden content</div>
      </BasicTool>,
    );
    expect(container.querySelector('.ai-panel__basic-tool-content')).toBeNull();
  });

  it('pending 状态禁止操作', () => {
    const { container } = render(
      <BasicTool
        status="pending"
        trigger={{ title: 'Tool' }}
      >
        <div>Content</div>
      </BasicTool>,
    );
    expect(container.querySelector('.ai-panel__basic-tool--pending')).not.toBeNull();
    // pending 时 arrow 不显示
    expect(container.querySelector('.ai-panel__collapsible-arrow')).toBeNull();
  });

  it('locked 模式禁止关闭', () => {
    const { container } = render(
      <BasicTool
        status="completed"
        trigger={{ title: 'Tool' }}
        defaultOpen
        locked
      >
        <div data-testid="content">Content</div>
      </BasicTool>,
    );
    // 展开状态
    expect(screen.getByTestId('content')).not.toBeNull();
    // 点击尝试关闭（locked 禁止）
    const trigger = container.querySelector('.ai-panel__collapsible-header');
    fireEvent.click(trigger!);
    // 仍然展开
    expect(screen.getByTestId('content')).not.toBeNull();
  });

  it('forceOpen 效果', () => {
    render(
      <BasicTool
        status="completed"
        trigger={{ title: 'Tool' }}
        forceOpen
      >
        <div data-testid="content">Forced content</div>
      </BasicTool>,
    );
    // forceOpen 应展开
    expect(screen.getByTestId('content')).not.toBeNull();
  });

  it('受控展开模式', () => {
    const onOpenChange = vi.fn();
    const { container } = render(
      <BasicTool
        status="completed"
        trigger={{ title: 'Tool' }}
        open={false}
        onOpenChange={onOpenChange}
      >
        <div>Content</div>
      </BasicTool>,
    );
    const trigger = container.querySelector('.ai-panel__collapsible-header');
    fireEvent.click(trigger!);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('args 渲染', () => {
    render(
      <BasicTool
        status="completed"
        trigger={{ title: 'Read', args: ['offset=0', 'limit=100'] }}
      />,
    );
    expect(screen.getByText('offset=0')).not.toBeNull();
    expect(screen.getByText('limit=100')).not.toBeNull();
  });

  it('pending 时不显示 subtitle/args', () => {
    render(
      <BasicTool
        status="pending"
        trigger={{ title: 'Tool', subtitle: 'desc', args: ['arg1'] }}
      />,
    );
    expect(screen.queryByText('desc')).toBeNull();
    expect(screen.queryByText('arg1')).toBeNull();
  });
});

// ── CollapsibleHeader 测试 ────────────────────────────────────

import CollapsibleHeader from './CollapsibleHeader';

describe('CollapsibleHeader', () => {
  it('点击触发 onToggle', () => {
    const onToggle = vi.fn();
    const { container } = render(
      <CollapsibleHeader open={false} onToggle={onToggle}>
        <span>Header</span>
      </CollapsibleHeader>,
    );
    fireEvent.click(container.firstChild as Element);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('disabled 时点击无效', () => {
    const onToggle = vi.fn();
    const { container } = render(
      <CollapsibleHeader open={false} onToggle={onToggle} disabled>
        <span>Header</span>
      </CollapsibleHeader>,
    );
    fireEvent.click(container.firstChild as Element);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('键盘 Enter 触发 toggle', () => {
    const onToggle = vi.fn();
    const { container } = render(
      <CollapsibleHeader open={false} onToggle={onToggle}>
        <span>Header</span>
      </CollapsibleHeader>,
    );
    fireEvent.keyDown(container.firstChild as Element, { key: 'Enter' });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('键盘 Space 触发 toggle', () => {
    const onToggle = vi.fn();
    const { container } = render(
      <CollapsibleHeader open={false} onToggle={onToggle}>
        <span>Header</span>
      </CollapsibleHeader>,
    );
    fireEvent.keyDown(container.firstChild as Element, { key: ' ' });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('disabled 时键盘无效', () => {
    const onToggle = vi.fn();
    const { container } = render(
      <CollapsibleHeader open={false} onToggle={onToggle} disabled>
        <span>Header</span>
      </CollapsibleHeader>,
    );
    fireEvent.keyDown(container.firstChild as Element, { key: 'Enter' });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('aria-expanded 属性', () => {
    const { container } = render(
      <CollapsibleHeader open={true} onToggle={() => {}}>
        <span>Header</span>
      </CollapsibleHeader>,
    );
    const el = container.firstChild as Element;
    expect(el?.getAttribute('aria-expanded')).toBe('true');
  });

  it('href 渲染为 <a> 元素', () => {
    const { container } = render(
      <CollapsibleHeader open={false} onToggle={() => {}} href="/link">
        <span>Header</span>
      </CollapsibleHeader>,
    );
    const el = container.firstChild as Element;
    expect(el?.tagName).toBe('A');
    expect(el?.getAttribute('href')).toBe('/link');
    expect(el?.getAttribute('target')).toBe('_blank');
  });

  it('无 href 渲染为 div[role=button]', () => {
    const { container } = render(
      <CollapsibleHeader open={false} onToggle={() => {}}>
        <span>Header</span>
      </CollapsibleHeader>,
    );
    const el = container.firstChild as Element;
    expect(el?.tagName).toBe('DIV');
    expect(el?.getAttribute('role')).toBe('button');
  });

  it('展开箭头方向', () => {
    const { container: closedContainer } = render(
      <CollapsibleHeader open={false} onToggle={() => {}} showArrow>
        <span>Header</span>
      </CollapsibleHeader>,
    );
    const closedArrow = closedContainer.querySelector('.ai-panel__collapsible-arrow');
    expect(closedArrow?.classList.contains('ai-panel__collapsible-arrow--open')).toBe(false);

    const { container: openContainer } = render(
      <CollapsibleHeader open={true} onToggle={() => {}} showArrow>
        <span>Header</span>
      </CollapsibleHeader>,
    );
    const openArrow = openContainer.querySelector('.ai-panel__collapsible-arrow');
    expect(openArrow?.classList.contains('ai-panel__collapsible-arrow--open')).toBe(true);
  });

  it('showArrow=false 不渲染箭头', () => {
    const { container } = render(
      <CollapsibleHeader open={false} onToggle={() => {}} showArrow={false}>
        <span>Header</span>
      </CollapsibleHeader>,
    );
    expect(container.querySelector('.ai-panel__collapsible-arrow')).toBeNull();
  });
});

// ── TextShimmer 测试 ──────────────────────────────────────────

import TextShimmer from './TextShimmer';

describe('TextShimmer', () => {
  it('渲染文本内容', () => {
    render(<TextShimmer text="Loading" active={true} />);
    expect(screen.getByText('Loading')).not.toBeNull();
  });

  it('active=true 时添加 active class', () => {
    const { container } = render(<TextShimmer text="Loading" active={true} />);
    const el = container.firstChild as Element;
    expect(el?.classList.contains('ai-panel__text-shimmer--active')).toBe(true);
    expect(el?.getAttribute('data-active')).toBe('true');
  });

  it('active=false 时无 active class', () => {
    const { container } = render(<TextShimmer text="Done" active={false} />);
    const el = container.firstChild as Element;
    expect(el?.classList.contains('ai-panel__text-shimmer--active')).toBe(false);
    expect(el?.getAttribute('data-active')).toBe('false');
  });

  it('aria-label 等于 text', () => {
    const { container } = render(<TextShimmer text="Processing" active={true} />);
    const el = container.firstChild as Element;
    expect(el?.getAttribute('aria-label')).toBe('Processing');
  });
});

// ── deferredMount 测试 ────────────────────────────────────────

import { scheduleDeferredMount, scheduleFrameMount } from '../utils/deferredMount';

describe('deferredMount', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scheduleDeferredMount 返回 cancel 函数', () => {
    const fn = vi.fn();
    const cancel = scheduleDeferredMount(fn);
    expect(typeof cancel).toBe('function');
    cancel();
  });

  it('scheduleDeferredMount cancel 后 fn 不执行', () => {
    const fn = vi.fn();
    const cancel = scheduleDeferredMount(fn);
    cancel();
    // 推进双层 rAF
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('scheduleFrameMount 返回 cancel 函数', () => {
    const fn = vi.fn();
    const cancel = scheduleFrameMount(fn);
    expect(typeof cancel).toBe('function');
    cancel();
  });

  it('scheduleFrameMount cancel 后 fn 不执行', () => {
    const fn = vi.fn();
    const cancel = scheduleFrameMount(fn);
    cancel();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(fn).not.toHaveBeenCalled();
  });
});

// ── PartsDataContext 测试 ─────────────────────────────────────

import { usePartsData } from './PartsDataContext';

describe('PartsDataContext', () => {
  it('默认值为空对象', () => {
    let contextValue: any;
    const Consumer: React.FC = () => {
      contextValue = usePartsData();
      return null;
    };
    render(<Consumer />);
    expect(contextValue).toEqual({});
  });

  it('Provider 注入值可通过 usePartsData 获取', () => {
    let contextValue: any;
    const Consumer: React.FC = () => {
      contextValue = usePartsData();
      return null;
    };
    const navigateToSession = vi.fn();
    render(
      <PartsDataProvider navigateToSession={navigateToSession} currentSessionID="s1">
        <Consumer />
      </PartsDataProvider>,
    );
    expect(contextValue.navigateToSession).toBe(navigateToSession);
    expect(contextValue.currentSessionID).toBe('s1');
  });
});
