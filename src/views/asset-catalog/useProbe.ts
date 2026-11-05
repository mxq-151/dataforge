/**
 * 资产模块通用探测钩子
 *
 * ── 为什么抽出来 ────────────────────────────────────────────
 * 资产概况（AssetOverviewTab）与资产详情页签（AssetDetailTabs）都是「一块看板各自探一个接口」，
 * 探测语义完全一致：成功取 data、失败一律落到 unavailable（接口未就绪是预期状态，不是错误），
 * 且不弹全局 toast。此前 AssetOverviewTab 内部实现了一份，详情页签若各写一份必然漂移。
 *
 * ── 语义 ────────────────────────────────────────────────────
 * - loading：请求进行中；
 * - ok：请求成功（data 可能为 null —— 服务端返回空体时由调用方自行判定空态）；
 * - unavailable：请求失败。调用方按「接口不可用 + 能力清单」降级，不视为异常。
 */

import { useEffect, useState } from 'react';

export type ProbeStatus = 'loading' | 'ok' | 'unavailable';

export interface ProbeResult<T> {
  status: ProbeStatus;
  data: T | null;
}

/**
 * 探测单个接口。loader 建议写成内联函数，靠 deps 驱动重探测
 * （loader 本人不进依赖数组，避免每次渲染都重新发请求）。
 */
export function useProbe<T>(
  loader: () => Promise<{ data: T[] | T }>,
  deps: unknown[] = []
): ProbeResult<T> {
  const [state, setState] = useState<ProbeResult<T>>({ status: 'loading', data: null });
  const depsKey = JSON.stringify(deps);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', data: null });
    // 用 Promise.resolve().then(loader) 而非直接 loader()：把 loader 的**同步抛错**
    // 也转成 reject，否则接口封装缺失/构造即抛时会在 effect 里直接冒泡成渲染错误。
    Promise.resolve()
      .then(loader)
      .then(res => {
        if (!cancelled) setState({ status: 'ok', data: (res?.data ?? null) as T | null });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'unavailable', data: null });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey]);

  return state;
}

export default useProbe;
