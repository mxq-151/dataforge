# DataForge 项目长期记忆

## 项目定位
Electron + React + Vite 的数据开发平台（DataForge），内嵌 opencode 二进制 + Monaco（@codingame/monaco-vscode-api 25.1.2）+ LSP（JDT.LS / Metals）。

## 测试与校验约定

- 项目**未安装 vitest**（package.json 无该 devDep，也无 vitest 配置），但有 8 个 `*.test.ts(x)` 文件。
  跑单测用：`npx --yes vitest@2.1.9 run [文件] --reporter=basic`（走 npm 缓存，不污染 node_modules）。
- 类型检查用：`./node_modules/.bin/tsc -p tsconfig.json --noEmit`。
  `tsconfig.json` 显式 exclude 了 `src/**/*.test.ts(x)`，因此测试文件不在类型检查范围内。
- 已知既有失败（与改动无关，勿误判为回归）：`src/services/textmate/textmateFix.test.ts`（3 例，warmUp 相关）、
  `src/components/ai/parts/tools.test.tsx`（收集期报错，0 test）。

## 提示词 ↔ 解析器耦合（重要）

`src/hooks/opencode/opencodeInstructions.ts` 中「数据指标」表格的列结构会被
`src/utils/extractMetrics.ts` 解析入库，改动提示词必须同步考虑解析兼容性：

- 数仓设计（DATA_ARCHITECT）：8 列 `指标编码 | 指标名称 | 主题域 | 指标含义 | 计算表达式 | 过滤条件 | 字段来源 | 数据源`。
  表头历史写作「指定含义」，解析器两种写法都认。
- 业务需求（BUSINESS_REQUESTER）：5 列 `指标名称 | 业务定义 | 计算口径 | 过滤条件 | 应用场景`；
  旧文档无「指标名称」的 4 列格式（业务定义 | 计算口径 | 过滤条件 | 应用场景）仍兼容，以业务定义截断作指标名。
- 解析约束：`## 数据指标` 必须是二级标题；该章节内所有 markdown 表格都会被解析，因此提示词要求章节内只放一张表；
  单元格内禁止出现 `|`；`字段来源` 格式为 `A.B:C,D;E.F:G,H`。
- 提示词改列名/列数后，务必同步 `extractMetrics.ts` 注释 + `extractMetrics.test.ts`
  「提示词表头 ↔ 解析器一致」用例（该用例直接从提示词常量取表头拼文档跑解析）。

## 三角色提示词的协作链路

`opencodeInstructions.ts` 里业务需求 / 数仓设计 / 数据开发三个提示词通过共用常量 `DELIVERY_CHAIN`
串成"业务需求 → 数仓设计 → 数据开发"三级链路，并各有一条 `## 上下游衔接`：

- 交付物：需求文档 `docs/xxx_开发需求.md` → `docs/xxx_数仓设计.md` + `ddls/{分层}_ddl.sql` → 处理程序（sql/、java/ 等）
- 指标编码只在数仓设计阶段分配（`{项目编码}_0001`），数据开发须写进代码头 `@指标` 注释做溯源
- 回退规则：下游发现设计缺陷/口径矛盾时停止实现并回退上游确认，不得擅自改设计或用改代码掩盖
- 改任一角色的职责边界时，要同步检查另外两个角色的上下游衔接描述是否还成立

## 编辑本仓库 TS 文件的经验

源码里的中文引号是全角/半角混用，Edit 工具按原样匹配中文文本时容易失败。
对大段中文模板字符串的替换，直接用 python 脚本按锚点切片替换更稳（注意用 `chr(34)` 构造 ASCII 双引号）。

## 用户偏好

- 期望聚焦目标的具体验证（tsc / vitest 计数），不要泛泛而谈的宽泛报告。
- 前端 bug 修复需配套单元测试。
- 涉及网络的构建前先配置代理。
