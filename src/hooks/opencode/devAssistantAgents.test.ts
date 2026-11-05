/**
 * devAssistantAgents.test.ts — 多智能体编排的跨进程契约测试
 *
 * 子代理定义在 electron 侧（opencode 配置注入），提示词在渲染进程侧按名字指挥主智能体
 * 分派。名字写错、子代理没注册、或把机器解析契约复制进子代理 prompt，都会让编排静默失效：
 * 主智能体发出 task 调用 → 服务端找不到 agent → 整批并行任务失败，而提示词测试完全无感。
 *
 * 因此这里锁三件事：
 * 1. 名称一致：electron 侧注册的 agent key 与渲染侧常量逐字相同
 * 2. 编排章节只在 S2/S3：S1 是需求方，不参与分派
 * 3. 子代理 prompt 不复制机器解析契约（9 列表头、@引擎 枚举等），避免出现第二份事实源
 */

import { describe, it, expect } from 'vitest';
import {
  DEV_ASSISTANT_AGENTS,
  AGENT_DATA_ARCHITECT,
  AGENT_DATA_DEV,
} from '../../../electron/backend/devAssistantAgents';
import {
  DEV_ASSISTANT_SUBAGENT_NAMES,
} from './devAssistantAgents';
import {
  BUSINESS_REQUESTER_INSTRUCTIONS,
  DATA_ARCHITECT_INSTRUCTIONS,
  DATA_DEV_ENGINEER_INSTRUCTIONS,
} from './opencodeInstructions';

describe('子代理注册 — 两侧名称必须逐字一致', () => {
  it('electron 侧注册的 agent 与渲染侧常量同名同数量', () => {
    expect(Object.keys(DEV_ASSISTANT_AGENTS).sort()).toEqual(
      [...DEV_ASSISTANT_SUBAGENT_NAMES].sort(),
    );
  });

  it('渲染侧常量覆盖设计与开发两个子代理', () => {
    expect(AGENT_DATA_ARCHITECT).toBe('data-architect');
    expect(AGENT_DATA_DEV).toBe('data-dev');
    expect(DEV_ASSISTANT_AGENTS[AGENT_DATA_ARCHITECT]).toBeDefined();
    expect(DEV_ASSISTANT_AGENTS[AGENT_DATA_DEV]).toBeDefined();
  });

  it.each(Object.entries(DEV_ASSISTANT_AGENTS))(
    '%s 是 subagent 模式且带用途描述与角色指令',
    (_name, def) => {
      // mode 必须是 subagent：设为 primary 会污染主智能体的切换列表
      expect(def.mode).toBe('subagent');
      expect(def.description.length).toBeGreaterThan(20);
      expect(def.prompt).toContain('## 角色');
      expect(def.prompt).toContain('待确认问题');
    },
  );
});

describe('编排章节 — 只下发给 S2 / S3', () => {
  it('S2 声明按表分派 data-architect，且产物只能由主智能体写入', () => {
    const prompt = DATA_ARCHITECT_INSTRUCTIONS;

    expect(prompt).toContain('## 多智能体并行编排（多表设计时启用）');
    expect(prompt).toContain(AGENT_DATA_ARCHITECT);
    // 多个子代理并行写同一份设计文档会互相覆盖，写入权必须收敛到主智能体
    expect(prompt).toContain('唯一写入者是你');
    expect(prompt).toContain('禁止让子代理写文件');
    // 子代理看不到主会话历史，规范只能随任务描述下发
    expect(prompt).toContain('任务描述必须自带规范摘要');
  });

  it('S3 声明按表分派 data-dev，并保留主智能体的整体校验责任', () => {
    const prompt = DATA_DEV_ENGINEER_INSTRUCTIONS;

    expect(prompt).toContain('## 多智能体并行编排（多表开发时启用）');
    expect(prompt).toContain(AGENT_DATA_DEV);
    // 产物按文件隔离才允许并行，重叠会导致互相覆盖
    expect(prompt).toContain('不得有文件重叠');
    expect(prompt).toContain('任务描述必须自带规范摘要');
    // 子代理自检不能替代主智能体的整体校验
    expect(prompt).toContain('子代理的自检不能替代你的自检');
    expect(prompt).toContain('子代理失败或返回不完整时，由你补做该表');
  });

  it('S1 不下发编排章节（需求方不参与分派）', () => {
    expect(BUSINESS_REQUESTER_INSTRUCTIONS).not.toContain('多智能体并行编排');
    expect(BUSINESS_REQUESTER_INSTRUCTIONS).not.toContain(AGENT_DATA_DEV);
    expect(BUSINESS_REQUESTER_INSTRUCTIONS).not.toContain(AGENT_DATA_ARCHITECT);
  });
});

describe('子代理 prompt 不复制机器解析契约', () => {
  /**
   * 这些字符串是 extractMetrics / fileHeader / programArgs 的解析依据，
   * 唯一事实源必须是 S2/S3 提示词。复制进子代理 prompt 就会产生第二份，且无人对齐。
   */
  const FORBIDDEN = [
    '| 指标编码',
    'spark、flink、flink_stream',
    'cla:{分类}-{分级}',
    '| 规则名 | 规则类型',
  ];

  it.each(Object.entries(DEV_ASSISTANT_AGENTS))(
    '%s 的角色指令里没有契约正文',
    (_name, def) => {
      for (const token of FORBIDDEN) {
        expect(def.prompt, `子代理 prompt 出现了契约正文: ${token}`).not.toContain(token);
      }
    },
  );

  it('子代理被明确要求以主智能体下发的规范摘要为准', () => {
    for (const def of Object.values(DEV_ASSISTANT_AGENTS)) {
      expect(def.prompt).toContain('规范来源（强约束）');
      expect(def.prompt).toContain('以任务描述中');
    }
  });
});
