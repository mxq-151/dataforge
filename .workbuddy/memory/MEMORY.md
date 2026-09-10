# DataForge 项目长期记忆

## 性能基准（AI 对话模块）

### 基准设施
- `bench.html` + `src/views/ai-bench/`（免登录 `?page=ai-bench`），跑在**真实生产代码路径**上：
  合成事件客户端喂给真实 `useOpencodeEvents`，再由真实 `MessageTimeline` / `PacedMarkdown` 渲染。
- 场景预设（`AIBenchPage.DEFAULT_CONFIGS`）：`medium`(8K) / `long`(24K) / `conversation`(40 轮历史 + 16K)。
- 指标：主线程阻塞（8ms 心跳延迟）、长任务、React Profiler 子树提交、编辑器输入延迟、内存。
- 工具：`scripts/ai-bench.mjs`（指标）、`scripts/ai-bench-profile.mjs`（V8 CPU profile）、
  `scripts/ai-bench-compare.mjs`（前后对比 → Markdown）。
- 报告落在 `perf/`：第一轮 `report.md`（09-05），第二轮 `report-round2.md`（09-10）。

### 本机（macOS）跑基准的硬性前提
1. 脚本默认浏览器是 Windows Edge 路径，必须显式指定：
   `--browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`
2. **必须先 unset 代理变量**：`unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy`。
   本机有 `HTTP_PROXY=http://127.0.0.1:51112`，会让 curl/探测走代理，探活返回 502 造成
   「服务器没起来」的误判。
3. `npx vite` 在本机会卡住不输出；用 `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --strictPort`
   直接启动（后台任务）。
4. 端口分配：`ai-bench.mjs` 用 9333，`ai-bench-profile.mjs` 用 9334，可并行不冲突。

### 测量陷阱
- 基准页的「编辑器输入探针」（`startTyping`，25ms 节奏向 Monaco 输入）**自身消耗约 580ms
  Monaco CPU**，会淹没对话模块信号。测对话模块 CPU 时必须 `--typing false`。
- 火焰里 `(idle)` 占比通常 55%~72%（打字机是定时器驱动的），
  **非空闲 CPU = 采样总时长 − idle** 才是有效口径。
- 开发构建（未压缩 + jsxDEV + React dev 模式）绝对数值远高于生产；只比前后**比值**。
- `longtask` 观测在 headless 下不稳定，个别 0↔1 的波动属噪声。
- 原始 profile JSON 每份 3~4MB，分析后应删除（`perf/*.raw.json`）。

### 优化成果基线（第二轮后，供后续回归对照）
| 场景 | 非空闲 CPU | 主线程阻塞 | AI 提交总耗时 |
| --- | ---: | ---: | ---: |
| medium-8k | — | 172.8 ms | 127.6 ms |
| long-24k | 1213.1 ms（单核 11.7%） | 526.3 ms | 394 ms |
| conv-40t-16k | 2214.4 ms（单核 30.6%） | 354.8 ms | 362.4 ms |

回归防线：**renderedChars 必须与优化前逐字节一致**（6558 / 19617 / 13087）。

## 架构约定

- 流式文本分两层：`partTextAccumDelta`（ref，逐字即时）+ `messages`（结构性状态）。
  逐字增长只走 ref + `subscribePartText`，**不进 `messages`**——
  消息列表是「结构」，不是「高频数据」，写它会连带投影/查找表/可见行全部重算。
  例外：part 从无文本变为有文本的**首次上屏**必须写 `messages`（投影靠它判断可渲染性）；
  用户消息文本始终全量同步（回滚回显读 `messages`）。
- `PacedMarkdown` 的稳定前缀必须**按块缓存元素**。整段缓存 = 每次前缀前进都整段重解析 = O(n²)。
- 虚拟化只解决 DOM 数量，不解决「每次 commit 重建视口内所有行的元素树」；行包装组件需 `React.memo`。
- 时间线行投影/查找表是 O(消息数) 的，成本随对话历史长度线性增长 ——
  长对话场景要单独用 `conversation` 预设验证，`long` 预设测不出这部分。

## 用户偏好（项目相关）
- 性能类任务要求**诊断驱动**：先量化定位（CPU profile / 计数器），再改，不接受凭猜测优化。
- 交付必须含**优化前后量化对比**，并说明未改动项与噪声范围内的指标。
- 改动需附 `tsc --noEmit` 与 `vitest` 计数；新增逻辑需配套单测（尤其纯函数分支边界）。
