import { defineConfig } from 'vitest/config';

/**
 * 单元测试配置，与渲染进程的 vite.config.mts 分开维护。
 *
 * 原因：vite.config.mts 为 Electron 渲染进程服务，带 react 插件、数十条 monaco
 * optimizeDeps 排除项与 file:// 专属的 base: './'。单元测试完全不需要这些，
 * 独立配置可以少加载插件、也避免被渲染进程的特化配置影响。
 * vitest 会优先读取 vitest.config.*，不会改动 vite.config.mts 的构建行为。
 */
export default defineConfig({
  // 与渲染进程保持一致，便于将来给引用 vscode 模块的组件写测试
  resolve: {
    alias: {
      vscode: '@codingame/monaco-vscode-extension-api',
    },
  },

  test: {
    // 这是 Electron 渲染进程代码，默认按浏览器环境跑：
    // 例如 textmateFix.test.ts 断言 warmUpTextmate 会用隐藏编辑器 attach 模型，
    // 而源码里该分支要求 document 存在，node 环境下走不到；tools.test.tsx 也需要真实 DOM。
    environment: 'jsdom',
    // electron/ 下的用例是主进程代码（凭据信封等纯逻辑），不需要 DOM，
    // 文件内用 `// @vitest-environment node` 单独声明环境。
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'electron/**/*.{test,spec}.{ts,tsx}'],
    // react-file-navigator 的产物是 ESM，但内部用了无扩展名的相对导入（'./App'），
    // 被外部化交给 Node 加载时会解析失败，这里让 Vite 内联转换它。
    server: {
      deps: {
        inline: ['react-file-navigator'],
      },
    },
    exclude: ['node_modules/**', 'dist/**', 'dist-electron/**', 'release/**'],
    // 测试文件已被 tsconfig.json exclude，tsc 不做类型检查，这里也只跑运行时断言
    typecheck: { enabled: false },
    // 注册 @testing-library/react 的 DOM 清理（未开 globals，自动清理不会生效）
    setupFiles: ['./src/test/setup.ts'],

    // 默认 5s 对 textmateFix.test.ts 不够，放宽到 20s：
    // registerAllTextmateLanguages() 会 fire-and-forget 地启动 probeTokenizationDiag
    // （20×200ms 轮询，最长 4s）与 warmUpTextmate（每语言 2s 防御上限）。这些后台任务
    // 在用例体与 afterEach 结束后仍在跑，vitest 要等它们排空才能结束该文件，
    // 这段等待会记到「当时正在执行的那个用例」头上——所以超时的用例每次都不同。
    // 实测用例体本身是毫秒级，7s 左右的耗时全部来自这段后台排空。
    // 根因在源码（后台诊断任务无法被取消或 await），这里先放宽阈值保证套件可用。
    testTimeout: 20000,
    teardownTimeout: 30000,
  },
});
