// @vitest-environment jsdom
/**
 * SettingsView.prompts.test.tsx — 「智能体提示词」标签页与配置模态框
 *
 * 锁定：
 * 1. 任务类型概览按「主 Agent + 子 Agent 名称」分块展示
 * 2. 模态框第一个块是主 Agent，其后按 agent 名称展示子 Agent，且默认回填系统内置提示词
 * 3. 保存只写入被修改的 agent；与内置正文一致或留空的块不落盘
 * 4. 「恢复内置」把草稿还原为系统内置提示词
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import SettingsView from './SettingsView';
import { DEFAULT_CONFIG, type OpenCodeConfig } from '../../types/opencode-backend';
import {
  AGENT_DATA_RETRIEVER,
  AGENT_REQUIREMENT_VERIFIER,
  AGENT_REQUIREMENT_WRITER,
  DEV_ASSISTANT_AGENTS,
} from '../../hooks/opencode/devAssistantAgents';

const baseConfig = (partial: Partial<OpenCodeConfig> = {}): OpenCodeConfig => ({
  ...DEFAULT_CONFIG,
  taskPrompts: {},
  subagentPrompts: {},
  ...partial,
});

const renderPromptsTab = (config: OpenCodeConfig) => {
  const onUpdateConfig = vi.fn();
  render(
    <SettingsView
      config={config}
      onUpdateConfig={onUpdateConfig}
      onResetConfig={vi.fn()}
      logs={[]}
      onClearLogs={vi.fn()}
    />
  );
  fireEvent.click(screen.getByText('智能体提示词'));
  return { onUpdateConfig };
};

const openModal = () => fireEvent.click(screen.getByRole('button', { name: /配置提示词/ }));

const modalElement = () => document.querySelector('.settings-prompt-modal') as HTMLElement;

/** 取某个 agent 分块内的 textarea（用块标题定位，避免依赖 DOM 顺序） */
const textareaOf = (blockTitle: string) => {
  const section = within(modalElement()).getByText(blockTitle).closest('section');
  if (!section) throw new Error(`找不到分块: ${blockTitle}`);
  return within(section).getByRole('textbox') as HTMLTextAreaElement;
};

const modalSaveButton = () => within(modalElement()).getByRole('button', { name: /保存/ });

describe('SettingsView — 智能体提示词', () => {
  it('概览按主 Agent + 子 Agent 名称展示，并标注内置默认', () => {
    renderPromptsTab(baseConfig());

    for (const label of ['需求编写', '数仓开发', '数据分析', '运维管理']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(screen.getByText('主 Agent · 需求编写')).toBeTruthy();
    for (const name of [AGENT_DATA_RETRIEVER, AGENT_REQUIREMENT_WRITER, AGENT_REQUIREMENT_VERIFIER]) {
      expect(screen.getByText(`子 Agent · ${name}`)).toBeTruthy();
    }
    expect(screen.getByText('内置默认')).toBeTruthy();
  });

  it('模态框第一块是主 Agent，子 Agent 按名称分块并回填系统内置提示词', () => {
    renderPromptsTab(baseConfig());
    openModal();

    const mainTextarea = textareaOf('主 Agent · 需求编写');
    expect(mainTextarea.value).toContain('## 角色');

    const writerTextarea = textareaOf(`子 Agent · ${AGENT_REQUIREMENT_WRITER}`);
    expect(writerTextarea.value).toBe(DEV_ASSISTANT_AGENTS[AGENT_REQUIREMENT_WRITER].prompt);

    // 系统内置提示词可从每个块的折叠区查看
    expect(screen.getAllByText('查看系统内置提示词').length).toBeGreaterThanOrEqual(3);
  });

  it('保存主 Agent 修改时只写入 taskPrompts，未改动的子 Agent 不落盘', () => {
    const { onUpdateConfig } = renderPromptsTab(baseConfig());
    openModal();

    fireEvent.change(textareaOf('主 Agent · 需求编写'), { target: { value: '## 自定义主 Agent' } });
    fireEvent.click(modalSaveButton());

    expect(onUpdateConfig).toHaveBeenCalledWith({
      taskPrompts: { BUSINESS_REQUESTER: '## 自定义主 Agent' },
      subagentPrompts: {},
    });
  });

  it('保存子 Agent 修改时只写入 subagentPrompts', () => {
    const { onUpdateConfig } = renderPromptsTab(baseConfig());
    openModal();

    fireEvent.change(textareaOf(`子 Agent · ${AGENT_REQUIREMENT_WRITER}`), {
      target: { value: '## 自定义需求编写子代理' },
    });
    fireEvent.click(modalSaveButton());

    expect(onUpdateConfig).toHaveBeenCalledWith({
      taskPrompts: {},
      subagentPrompts: { [AGENT_REQUIREMENT_WRITER]: '## 自定义需求编写子代理' },
    });
  });

  it('恢复内置把草稿还原为系统内置提示词，保存后删除自定义覆盖', () => {
    const { onUpdateConfig } = renderPromptsTab(
      baseConfig({
        taskPrompts: { BUSINESS_REQUESTER: '旧主提示词' },
        subagentPrompts: { [AGENT_REQUIREMENT_VERIFIER]: '旧校验提示词' },
      })
    );
    openModal();

    expect(textareaOf('主 Agent · 需求编写').value).toBe('旧主提示词');
    const mainSection = within(modalElement()).getByText('主 Agent · 需求编写').closest('section') as HTMLElement;
    fireEvent.click(within(mainSection).getByRole('button', { name: /恢复内置/ }));
    expect(textareaOf('主 Agent · 需求编写').value).toContain('## 角色');

    fireEvent.click(modalSaveButton());

    expect(onUpdateConfig).toHaveBeenCalledWith({
      taskPrompts: {},
      // 未改动的子 Agent 覆盖必须保留
      subagentPrompts: { [AGENT_REQUIREMENT_VERIFIER]: '旧校验提示词' },
    });
  });
});
