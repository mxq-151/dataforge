/**
 * modelContextLimit.test.ts — 模型 context 窗口表与合并策略
 *
 * 回归用例背景（2026-09-13）：
 * 顶部进度条显示「181.7k / 128.0k（142.0%）」。实际模型是
 * deepseek/deepseek-flash（显示名 DeepSeek V4.1 Flash），官方 context = 1,000,000。
 * 旧表只判 `deepseek-v4` 前缀，`deepseek-flash` 落进泛化 `deepseek` 分支 → 128k。
 */

import { describe, it, expect } from 'vitest';
import {
  getHardcodedContextLimit,
  resolveContextLimit,
  DEFAULT_CONTEXT_LIMIT,
  DEEPSEEK_V4_CONTEXT_LIMIT,
} from './modelContextLimit';

describe('getHardcodedContextLimit', () => {
  it('deepseek-flash（DeepSeek V4.1 Flash）应为 1M —— 本次线上问题的主回归点', () => {
    expect(getHardcodedContextLimit('deepseek-flash')).toBe(DEEPSEEK_V4_CONTEXT_LIMIT);
    expect(getHardcodedContextLimit('deepseek-flash')).toBe(1_000_000);
  });

  it('DeepSeek V4 家族其它 id 同为 1M', () => {
    for (const id of [
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4-pro',
      'deepseek-v4.1-flash',
      'DeepSeek-V4-Flash',
      'deepseek-v4',
    ]) {
      expect(getHardcodedContextLimit(id), id).toBe(DEEPSEEK_V4_CONTEXT_LIMIT);
    }
  });

  it('DeepSeek 老模型仍为 128k（不能被 V4 规则误伤）', () => {
    for (const id of [
      'deepseek-chat',
      'deepseek-reasoner',
      'deepseek-v3',
      'deepseek-v3.1',
      'deepseek-v3.2',
      'deepseek-r1',
      'deepseek-v2',
      'deepseek',
    ]) {
      expect(getHardcodedContextLimit(id), id).toBe(128_000);
    }
  });

  it('OpenAI / Anthropic / Qwen / Gemini 维持原判定', () => {
    expect(getHardcodedContextLimit('gpt-4o')).toBe(128_000);
    expect(getHardcodedContextLimit('gpt-4-turbo')).toBe(128_000);
    expect(getHardcodedContextLimit('gpt-4.1')).toBe(128_000);
    expect(getHardcodedContextLimit('gpt-4')).toBe(8_192);
    expect(getHardcodedContextLimit('gpt-3.5-turbo')).toBe(16_385);
    expect(getHardcodedContextLimit('claude-sonnet-4')).toBe(200_000);
    expect(getHardcodedContextLimit('claude-3-5-sonnet')).toBe(200_000);
    expect(getHardcodedContextLimit('qwen3-coder-plus')).toBe(32_000);
    expect(getHardcodedContextLimit('gemini-2.0-flash')).toBe(1_000_000);
    expect(getHardcodedContextLimit('gemini-1.5-pro')).toBe(1_000_000);
    expect(getHardcodedContextLimit('gemini-pro')).toBe(32_000);
  });

  it('完全未知的模型回落到默认值', () => {
    expect(getHardcodedContextLimit('some-local-llm')).toBe(DEFAULT_CONTEXT_LIMIT);
    expect(getHardcodedContextLimit('')).toBe(DEFAULT_CONTEXT_LIMIT);
    expect(getHardcodedContextLimit(undefined as unknown as string)).toBe(DEFAULT_CONTEXT_LIMIT);
  });

  it('大小写不敏感', () => {
    expect(getHardcodedContextLimit('DEEPSEEK-FLASH')).toBe(DEEPSEEK_V4_CONTEXT_LIMIT);
    expect(getHardcodedContextLimit('GPT-4O')).toBe(128_000);
  });
});

describe('resolveContextLimit', () => {
  it('API 给出正确值时以 API 为准', () => {
    expect(resolveContextLimit(1_000_000, 'deepseek-flash')).toBe(1_000_000);
    expect(resolveContextLimit(200_000, 'claude-sonnet-4')).toBe(200_000);
  });

  it('API 低估时用硬编码下限兜住（避免进度条误报满载）', () => {
    expect(resolveContextLimit(128_000, 'deepseek-flash')).toBe(1_000_000);
    expect(resolveContextLimit(32_768, 'deepseek-v4-flash')).toBe(1_000_000);
  });

  it('API 缺失/非法值时退回硬编码值', () => {
    expect(resolveContextLimit(null, 'deepseek-flash')).toBe(1_000_000);
    expect(resolveContextLimit(undefined, 'deepseek-chat')).toBe(128_000);
    expect(resolveContextLimit(0, 'deepseek-chat')).toBe(128_000);
    expect(resolveContextLimit(-1, 'deepseek-chat')).toBe(128_000);
    expect(resolveContextLimit(NaN, 'deepseek-chat')).toBe(128_000);
  });

  it('未知模型 + API 有效值 → 取较大者（API 值生效）', () => {
    expect(resolveContextLimit(512_000, 'some-local-llm')).toBe(512_000);
  });
});
