// @vitest-environment jsdom
/**
 * UserMessageDisplay.test.tsx — 用户消息气泡的展示形态
 *
 * 覆盖点：
 * 1. 默认为「用户」徽标（真实用户输入）
 * 2. variant='subagent-task' 时改为「子代理任务」徽标（子代理会话首条注入消息）
 *
 * 背景：子代理会话（带 parentID）的首条 user 消息是主会话 task 工具写下的任务
 * prompt，并非用户输入，前端需改标区分，且不提供回滚。
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import UserMessageDisplay from './UserMessageDisplay';
import type { UserMessage } from '../../../types/opencode-backend';

/** 构造最小可用 UserMessage（仅用例断言所需字段） */
function makeMessage(): UserMessage {
  return {
    id: 'msg_user_1',
    sessionID: 'ses_1',
    role: 'user',
    time: { created: Date.now() },
  } as unknown as UserMessage;
}

describe('UserMessageDisplay 展示形态', () => {
  it('默认渲染「用户」徽标', () => {
    render(<UserMessageDisplay message={makeMessage()} text="帮我生成 DWD 层代码" />);
    expect(screen.getByText('用户')).toBeTruthy();
    expect(screen.queryByText('子代理任务')).toBeNull();
  });

  it('variant=subagent-task 渲染「子代理任务」徽标', () => {
    render(
      <UserMessageDisplay
        message={makeMessage()}
        text="你是大数据 Spark 开发工程师……"
        variant="subagent-task"
      />,
    );
    expect(screen.getByText('子代理任务')).toBeTruthy();
    expect(screen.queryByText('用户')).toBeNull();
  });
});