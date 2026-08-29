import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * 组件测试的 DOM 清理。
 *
 * @testing-library/react 的自动清理只在测试框架暴露了「全局 afterEach」时生效
 * （即 vitest 开启 globals: true）。本项目测试统一显式 import { describe, it } from 'vitest'，
 * 未开 globals，自动清理不会注册 —— 表现为前一个用例渲染的 DOM 残留到下一个用例，
 * queryByText 查到多个元素而误报失败。这里显式注册一次即可。
 */
afterEach(() => {
  cleanup();
});
