/**
 * client/useModelContextLimit.ts — 从 SDK 查询当前模型的真实上下文窗口
 *
 * 硬编码的模型 context 窗口表 + 合并策略见 ../modelContextLimit。
 * 这里只保留 API 查询策略（location + 重试 + 最后一次生效保护）。
 *
 * 两个必须踩住的坑（2026-09-13 修复，症状：进度条显示 181.7k/128.0k = 142%）：
 * 1. **必须带 location**。`/api/model` 按 location 惰性初始化实例，不带
 *    location 时服务端只用自己的 cwd 兜底；带 location 才能查到目标项目实例
 *    的模型表。SDK 会把它同时写进 header 与 query。
 * 2. **冷实例首次查询会「成功但返回空」**。实例尚未完成 provider 加载时接口
 *    返回 200 + `data: []`，只查一次就会静默回落到硬编码表，而那正是被
 *    `deepseek-flash`（DeepSeek V4.1 Flash）漏判成 128k 的那张表。故按
 *    递增间隔重试几次，把冷启动窗口让过去。
 */

import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { getHardcodedContextLimit, resolveContextLimit } from '../modelContextLimit';
import type { LogEntry, OpenCodeConfig } from '../../../types/opencode-backend';

export interface UseModelContextLimitOptions {
  /** 客户端是否已就绪 */
  ready: boolean;
  clientRef: MutableRefObject<OpencodeClient | null>;
  /** 当前工作目录（作为 API 的 location） */
  currentDirectory: string | null;
  /** 全局配置：取 config.model / config.modelProvider 作为未被运行时覆盖时的默认模型 */
  config: OpenCodeConfig;
  /** 运行时覆盖的模型（优先于 config） */
  activeLLMModel: { providerID: string; modelID: string } | null;
  setContextLimit: (limit: number) => void;
  addLog: (entry: LogEntry) => void;
}

export function useModelContextLimit(options: UseModelContextLimitOptions): void {
  const {
    ready,
    clientRef,
    currentDirectory,
    config,
    activeLLMModel,
    setContextLimit,
    addLog,
  } = options;

  const fetchModelContextLimit = useCallback(async (
    c: OpencodeClient,
    modelID: string,
    providerID: string,
    dir: string | null,
    isCancelled: () => boolean,
  ) => {
    const hardcodedLimit = getHardcodedContextLimit(modelID);

    /** 查一次 API，返回 limit.context（查不到返回 null） */
    const queryApiLimit = async (): Promise<{ limit: number | null; reason: string }> => {
      try {
        const result = await c.v2.model.list(
          dir ? { location: { directory: dir } } : undefined
        );
        const models = (result.data as any)?.data ?? result.data;
        if (!Array.isArray(models)) {
          return { limit: null, reason: '返回体不是模型数组' };
        }
        const matched = models.find((m: any) => m.id === modelID && m.providerID === providerID)
          ?? models.find((m: any) => m.id === modelID);
        const ctx = matched?.limit?.context;
        if (typeof ctx === 'number' && ctx > 0) {
          return { limit: ctx, reason: 'ok' };
        }
        return { limit: null, reason: `模型表中无 ${modelID}（共 ${models.length} 条）` };
      } catch (err) {
        return { limit: null, reason: err instanceof Error ? err.message : String(err) };
      }
    };

    // 冷实例返回空列表是「会自愈」的，重试间隔按 0 / 800 / 1600 / 3200ms 递增
    const RETRY_DELAYS_MS = [0, 800, 1600, 3200];
    let lastReason = '';

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
      if (isCancelled()) return;

      const { limit, reason } = await queryApiLimit();
      if (isCancelled()) return;

      if (limit != null) {
        const finalLimit = resolveContextLimit(limit, modelID);
        setContextLimit(finalLimit);
        addLog({
          source: 'agent',
          text: `模型 ${providerID}/${modelID} contextLimit=${finalLimit}（API=${limit}, 硬编码=${hardcodedLimit}, 第 ${attempt + 1} 次查询）`,
          timestamp: new Date(),
          level: 'info',
        });
        return;
      }

      lastReason = reason;
      addLog({
        source: 'agent',
        text: `第 ${attempt + 1}/${RETRY_DELAYS_MS.length} 次查询模型 ${providerID}/${modelID} 的 limit 未命中：${reason}`,
        timestamp: new Date(),
        level: 'warn',
      });
    }

    // 重试耗尽 → 硬编码兜底（此处才是真正需要警惕的路径：说明 API 一直不可用）
    if (isCancelled()) return;
    setContextLimit(hardcodedLimit);
    addLog({
      source: 'agent',
      text: `未从 API 获得模型 ${providerID}/${modelID} 的 limit（${lastReason}），使用硬编码 fallback (${hardcodedLimit})`,
      timestamp: new Date(),
      level: 'warn',
    });
  }, [setContextLimit, addLog]);

  // 当客户端连接、目录变化或模型切换时，获取真实的 contextLimit。
  // 用自增序号做「最后一次调用生效」的保护：模型/目录连续切换时，先发起的那次
  // 查询（含重试）可能后返回，不能让它覆盖新模型的结果。
  const limitFetchSeqRef = useRef(0);
  useEffect(() => {
    const c = clientRef.current;
    if (!c || !ready) return;
    const modelID = activeLLMModel?.modelID ?? config.model;
    const providerID = activeLLMModel?.providerID ?? config.modelProvider;
    if (!modelID) return;
    const seq = ++limitFetchSeqRef.current;
    fetchModelContextLimit(c, modelID, providerID, currentDirectory, () => seq !== limitFetchSeqRef.current);
  }, [ready, currentDirectory, config.model, config.modelProvider, activeLLMModel, clientRef, fetchModelContextLimit]);
}
