import { useState, useCallback, useEffect, useRef } from 'react';
import { Store } from '../bridge/store';
import { DEFAULT_CONFIG } from '../types/opencode-backend';
import type { OpenCodeConfig } from '../types/opencode-backend';

/** Store 中的配置文件名 */
const STORE_FILE = 'opencode-config.json';
const STORE_KEY = 'config';

export default function useOpenCodeConfig() {
  const [config, setConfig] = useState<OpenCodeConfig>({ ...DEFAULT_CONFIG });
  const [loaded, setLoaded] = useState(false);
  const storeRef = useRef<Store | null>(null);

  // 异步加载配置（从 Store 读取，兼容 localStorage 旧数据）
  useEffect(() => {
    let cancelled = false;

    async function loadConfig() {
      try {
        // 1. 尝试从 Store 读取
        const store = await Store.load(STORE_FILE);
        if (cancelled) return;
        storeRef.current = store;

        const stored = await store.get<OpenCodeConfig>(STORE_KEY);
        if (stored) {
          // 迁移：DeepSeek 暂不支持 Responses API（opencode 上游 issue #35689
          // 未修复，reasoning 内容在 Responses API 模式下被丢弃）。
          // 自动关闭 deepseek provider 下所有模型的 useResponsesApi=true 配置。
          if (Array.isArray(stored.llmModels) && stored.llmModels.length > 0) {
            let needMigrate = false;
            const migratedModels = stored.llmModels.map(m => {
              if (m && m.providerID?.toLowerCase() === 'deepseek' && m.useResponsesApi) {
                needMigrate = true;
                return { ...m, useResponsesApi: false };
              }
              return m;
            });
            if (needMigrate) {
              stored.llmModels = migratedModels;
              // 异步持久化迁移后的配置，不阻塞加载流程
              store.set(STORE_KEY, stored).then(() => store.save()).catch(() => {});
            }
          }
          // 过滤 null 值，避免 input 收到 null
          const cleaned = Object.fromEntries(
            Object.entries(stored).filter(([, v]) => v !== null)
          );
          setConfig(prev => ({ ...prev, ...cleaned }));
          setLoaded(true);
          return;
        }

        // 2. 兼容：尝试从 localStorage 迁移旧数据
        const oldKey = 'dataforge_opencode_config';
        const raw = localStorage.getItem(oldKey);
        if (raw) {
          try {
            const oldConfig = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
            setConfig(oldConfig);
            // 迁移到 Store
            await store.set(STORE_KEY, oldConfig);
            await store.save();
            // 清除旧数据
            localStorage.removeItem(oldKey);
            if (!cancelled) setLoaded(true);
            return;
          } catch { /* ignore parse error */ }
        }
      } catch {
        // Store 不可用时不降级到 localStorage
        // 避免含 API Key 的配置被 XSS 窃取
      }
      if (!cancelled) setLoaded(true);
    }

    loadConfig();
    return () => { cancelled = true; };
  }, []);

  const updateConfig = useCallback((partial: Partial<OpenCodeConfig>) => {
    setConfig(prev => {
      const next = { ...prev, ...partial };
      // 持久化到 Store
      if (storeRef.current) {
        storeRef.current.set(STORE_KEY, next).then(() => {
          storeRef.current?.save();
        }).catch(() => {});
      }
      // Store 不可用时不降级到 localStorage，避免含 API Key 的配置被 XSS 窃取
      return next;
    });
  }, []);

  const resetConfig = useCallback(() => {
    const fresh = { ...DEFAULT_CONFIG };
    setConfig(fresh);
    if (storeRef.current) {
      storeRef.current.set(STORE_KEY, fresh).then(() => {
        storeRef.current?.save();
      }).catch(() => {});
    }
    // Store 不可用时不降级到 localStorage
  }, []);

  return { config, updateConfig, resetConfig, loaded };
}
