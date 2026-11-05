/**
 * client/context.ts — OpencodeClient 的 React Context 与读取入口
 *
 * 单独成文件是为了断开循环依赖：门面 useOpencodeClient.tsx 需要 import 两个模块
 * Provider，而两个 Provider 又都需要这个 Context。
 */

import { createContext, useContext } from 'react';
import type { OpencodeClientBackend } from './types';

/** 每个 (moduleId, projectId) 一份独立实例 */
export const OpencodeClientContext = createContext<OpencodeClientBackend | null>(null);

/**
 * 获取当前 moduleId + projectId 对应的 OpencodeClientBackend 实例
 * 必须在 OpencodeClientProvider 内使用
 */
export function useOpencodeClient(): OpencodeClientBackend {
  const ctx = useContext(OpencodeClientContext);
  if (!ctx) {
    throw new Error('useOpencodeClient must be used within OpencodeClientProvider');
  }
  return ctx;
}
