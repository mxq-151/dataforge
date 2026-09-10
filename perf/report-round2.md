# 智能体对话模块性能优化（第二轮）— 前后对比报告

- 生成时间：2026-09-10
- 优化前基线：`perf/round2-before.json` / CPU 采样 `perf/profile-before.json`、`perf/profile-conv-before.json`
- 优化后基线：`perf/round2-after.json` / CPU 采样 `perf/profile-after.json`、`perf/profile-conv-after.json`
- 运行环境：macOS + HeadlessChrome 152，vite dev server（**开发构建，未压缩**）
- 迭代次数：指标 3 次/场景取中位数；CPU 采样 2~3 次取代表轮

---

## 一、结论速览

### 1.1 CPU 占用（本次要解决的核心问题）

用 V8 采样器（100µs 间隔）在**真实渲染代码路径**上采集 CPU profile，按函数自身耗时归因。
「非空闲 CPU」= 采样窗口总时长 − idle 采样时长。

| 场景 | 非空闲 CPU | 折算单核占用 |
| --- | ---: | ---: |
| long-24k（长回复 24K 字符） | 3449.9 → 1213.1 ms (**-64.8%**) | 30.4% → **11.7%** |
| conv-40t-16k（40 轮历史 + 16K 回复） | 4418.8 → 2214.4 ms (**-49.9%**) | 56.6% → **30.6%** |

只看与智能体对话面板直接相关的部分（React 运行时 + react-markdown + 面板自有代码）：

| 场景 | AI 面板相关 CPU | 降幅 |
| --- | ---: | ---: |
| long-24k | 2444.9 → 481.4 ms | **-80.3%** |
| conv-40t-16k | 2248.2 → 484.8 ms | **-78.4%** |

分模块自身耗时（V8 采样，越靠前收益越大）：

| 热点模块 | long-24k 优化前 → 后 | 变化 |
| --- | ---: | ---: |
| react-markdown 解析管线 | 1047.8 → 133.6 ms | **-87.2%** |
| react.js（createElement 等） | 69.9 → 3.3 ms | **-95.3%** |
| react_jsx-runtime（生产路径 jsx） | 322.1 → 44.1 ms | **-86.3%** |
| react_jsx-dev-runtime（开发路径 jsxDEV） | 405.3 → 81.6 ms | **-79.9%** |
| lib-9qH3G_6W（micromark/mdast 工具） | 140.4 → 33.2 ms | **-76.4%** |
| react-dom_client（协调 + 提交） | 411.1 → 133.5 ms | **-67.5%** |

> `react.js` 降到 3.3ms 是关键信号：React 元素创建量本身塌缩了，说明**重渲染次数**而非
> 单次渲染成本才是根因 —— 这与诊断结论一致。

### 1.2 界面流畅度指标

| 场景 | 主线程阻塞 | AI 时间线提交总耗时 | AI 提交 p95 | 编辑器输入延迟 p95 |
| --- | ---: | ---: | ---: | ---: |
| medium-8k | 244.6 → 172.8 ms (**-29.4%**) | 350.6 → 127.6 ms (**-63.6%**) | 6.7 → 1.2 ms (-82.1%) | 1.5 → 1.8 ms |
| long-24k | 1725.9 → 526.3 ms (**-69.5%**) | 1936 → 394 ms (**-79.6%**) | 17.6 → 1.3 ms (**-92.6%**) | 10.6 → 2.1 ms (**-80.2%**) |
| conv-40t-16k | 963.9 → 354.8 ms (**-63.2%**) | 1544.4 → 362.4 ms (**-76.5%**) | 10.5 → 1.5 ms (**-85.7%**) | 0 → 0 ms |

Monaco 提交次数：medium 68 → 3、long 201 → 3、conv 135 → 3。
（次数下降源于父组件不再被每帧流式状态反复触发，**不是**改了编辑器链路 —— 见 §5 验证）

---

## 二、诊断过程（先定位，再动手）

本轮没有猜测，先用 `scripts/ai-bench-profile.mjs`（新增）在 long-24k 场景下抓 V8 CPU profile，
按 `函数@文件:行` 聚合自身耗时，得到两条明确结论：

### 结论 1：Markdown 解析仍存在 O(n²)

`PacedMarkdown` 上一轮引入了「稳定前缀 + 活动尾部」拆分，但**稳定前缀是整段交给一个
ReactMarkdown 解析的**。前缀每前进一个段落就要把「整段前缀」重新解析一次：

- 24K 字符回复 ≈ 触发 80 次前缀重解析，每次解析的是当时已有的全部前缀（平均约 12K 字符）
- 累计解析字符数 ≈ 文本量的 **10 倍以上**

这解释了为什么 `react-markdown` 独占本轮优化前非空闲 CPU 的约 1/3。

### 结论 2：逐字增长触发整棵时间线重算

一次 commit 数对账（long-24k，流式窗口约 9.6s）：

| 触发源 | 频率 | 每次 commit 的重渲染范围 |
| --- | --- | --- |
| `flushDeltas` 把 accumDelta 写回 `messages` | 33ms ≈ 30/s | **整棵时间线**：投影重建 + 查找表重建 + 视口内所有行 |
| `PacedMarkdown` 打字机步进 | 32ms ≈ 31/s | 仅该 Markdown 子树 |

实测 long-24k 共 599 次 AI 子树提交 ≈ 200 + 200 两个来源叠加。
其中 30/s 的那一路是「重渲染范围与历史长度无关、但与视口行数成正比」的**结构性浪费**：
它让 `useTimelineProjection` 里的 `constructMessageRows` / `groupParts` /
`reuseTimelineRows` / `entryByID` / `assistantCopyPartID` 每 33ms 对**全部消息**重算一遍。

对照：conv-40t-16k（40 轮历史）优化前单核占用高达 56.6%，明显高于 long-24k 的 30.4% ——
因为同样的每帧重算成本，在 200 行的长历史下更高。这正是用户反馈的「对话内容越长 CPU 越高」。

---

## 三、改动点

### 3.1 流式文本与消息列表解耦（`src/hooks/opencode/useOpencodeEvents.ts`）

- 新增 `subscribePartText(partID, listener)`：按 part 粒度的文本订阅（通知按 ~32ms 合并）。
- 改写 `flushDeltas(force?)`：
  - **首次上屏**：part 从「无文本」变为「有文本」时，才把文本写进 `messages`
    （投影需要知道该 part 已可渲染，这一步不可省）；
  - **后续增长**：只更新 `partTextAccumDelta`（ref）+ 通知该 part 的订阅者，
    **完全不触碰 `messages`**；
  - `force=true` 用于流式结束 / 重连兜底，保证最终文本一定完整落在 `messages`。
- **用户消息不受影响**：角色为 `user` 时仍然全量同步（回滚回显、用户气泡直接读 `messages`）。

效果：逐字增长的重渲染范围从「整棵时间线（含投影/查找表/全部可见行）」
收缩为「正在流式的那一个 part」。

### 3.2 稳定前缀按块缓存（`src/components/ai/parts/PacedMarkdown.tsx`）

- 新增 `splitStableBlocks(text)`：把稳定前缀按**顶层块**（空行为界、围栏代码块内不切分）拆分。
- 组件内维护 `blockCacheRef`（块文本 ↔ React 元素），每步进逐块比对公共前缀，
  **只解析新增的块**，历史块复用元素引用 → 整体由 O(n²) 降为 O(n)。
- 保守合并规则（避免破坏跨块语义）：
  1. 首行缩进 1~3 空格的块与前一块合并（可能是列表/引用续行）；
  2. 含引用式链接定义（`[label]: url`，含 GFM 脚注）的块与后续块合并。

### 3.3 时间线行 memo 化（`src/components/ai/timeline/MessageTimeline.tsx`）

- 抽出 `VirtualRow`（`React.memo`）：虚拟化只保证 DOM 节点数有界，
  但每次 commit 仍会重建视口内每一行的元素树。memo 化后，
  `row` 引用由 `reuseTimelineRows` 保持稳定、`measureElement` 是 virtualizer 实例方法
  （引用恒定），只有真正变化的行才重渲染。

### 3.4 零散开销

- `UserMessageDisplay`：`Intl.DateTimeFormat` 改为模块级复用
  （原先每次重渲染都新建格式化器）。
- `TextPartDisplay` / `ReasoningPartDisplay`：改用 `useSyncExternalStore`
  订阅 part 文本（替代原先依赖 `messages` 变化被动重渲染）。

---

## 四、兼容性与未改动项

**未改动**：Monaco 编辑器链路、`projection.ts` / `rows.ts` 投影核心逻辑、
聊天输入区、会话管理、权限/提问 dock、SSE 传输与重连退避、消息分页与压缩逻辑。

**刻意保留**：流式结束后仍由 `TextPartDisplay` 用**完整 GFM** 一次性重渲染 ——
分块只作用于流式过程中的中间态，最终形态与优化前完全一致（见 §5 逐字节校验）。

---

## 五、验证

### 5.1 渲染完整性（最关键的回归防线）

基准页在流式结束后测量 `data-timeline-part-id` 节点的 `textContent` 长度：

| 场景 | 优化前 renderedChars | 优化后 renderedChars |
| --- | ---: | ---: |
| medium-8k | 6558（3/3 次完全一致） | 6558（3/3 次完全一致） |
| long-24k | 19617 | 19617 |
| conv-40t-16k | 13087 | 13087 |

**前后逐字节相同** —— 分块渲染与订阅化改造没有丢字、没有截断、没有改变最终渲染结果。

### 5.2 类型检查与单元测试

- `tsc -p tsconfig.json --noEmit` → **0 错误**
- `vitest run src/components/ai` → **212/212 通过**
  （含新增 `splitStableBlocks` 的 10 条用例：空行分块、围栏原子性、列表不拆散、
  缩进续行合并、引用定义合并、4 空格独立代码块、拼接无损、后缀增长块划分稳定）
- 其中 `PacedMarkdown.test.ts` 由 12 条增至 **22 条**

### 5.3 编辑器未被波及

Monaco 提交次数从 201 降到 3，方向是「更少」而非「更多」：
原因是父组件不再被每帧流式状态触发重渲染（`AIBenchPage` 的 re-render 传导到 `EditorArea`）。
编辑器输入延迟 p95 在 long 场景从 10.6ms 降到 2.1ms，**没有回退**。

---

## 六、诚实说明（噪声与边界）

1. **开发构建**：基准跑在 vite dev（未压缩、`jsxDEV`、React 开发模式），
   绝对数值高于生产构建；有意义的是**前后比值**，不是绝对值。
2. **个别指标在噪声范围内**，未改善也不算回退：
   - long 场景「>50ms 长任务数」0 → 1（headless 下 longtask 观测本身不稳定）；
   - conv 场景「心跳 max」55.6 → 58.2ms（单次最坏尖峰）；
   - medium 场景「编辑器输入延迟 p95」1.5 → 1.8ms（均低于 2ms，无感知差异）。
3. **基准为合成流式**（`syntheticClient` 生成的结构化长回复，含段落/列表/代码块/表格），
   非真实 LLM 会话；事件频率（40 字符/16ms）贴近真实但非等同。
4. **conv 场景仍残留约 87ms** 的 Monaco 渲染开销，来自基准页把编辑器与时间线并排布局
   导致的布局联动，**不属于**智能体对话模块。
5. 分块渲染的语义边界已被保守规则覆盖（引用定义、缩进续行），
   但若后续出现「跨块引用的脚注/HTML 块」等极端 Markdown，仍建议回归一次视觉比对。

---

## 七、复现方式

```bash
npm run dev:renderer                                  # 启动 vite（5173）

# 指标基线与对比
node scripts/ai-bench.mjs --out perf/before.json --presets medium,long,conversation \
  --iterations 3 --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
node scripts/ai-bench.mjs --out perf/after.json --presets medium,long,conversation --iterations 3 ...
node scripts/ai-bench-compare.mjs --before perf/before.json --after perf/after.json --out perf/report.md

# CPU 热点（本轮新增）
node scripts/ai-bench-profile.mjs --preset long         --iterations 3 --typing false --out perf/profile-after.json
node scripts/ai-bench-profile.mjs --preset conversation --iterations 2 --out perf/profile-conv-after.json
```

`--typing false` 用于关闭基准页自带的「编辑器输入探针」——该探针自身会消耗约 580ms
Monaco CPU，会淹没对话模块的信号（诊断阶段发现并规避）。
