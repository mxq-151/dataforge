/**
 * 术语表模板 —— 「知识库章节约定」的唯一客户端事实源。
 *
 * ── 为什么需要一个模板而不是只写提示词 ──────────────────────
 * 术语扩展依赖「业务知识文档里有 `## 术语表` 章节，且用可解析的写法」。
 * 只在服务端支持解析、不在编辑界面告诉作者怎么写，等于约定只存在于代码注释里：
 * 作者写一篇自以为有术语表的文档，检索侧却解析不到，双方都无从发现。
 *
 * ── 与服务端解析器的契约 ────────────────────────────────────
 * 服务端 `TermDictionary` 的解析规则：
 *   - 章节标题含「术语」；或文档标题含「术语」（整篇解析）
 *   - 三列表头必须含「术语」（可带「别名」「英文名」，缺列也能工作）
 * Java 侧 `TermTableTemplateContractTest` 用同一段模板文本做解析断言，
 * 改动这里必须同步改那边，否则模板会变成「编辑器能插入、服务端解析不到」的死文本。
 */

export const TERM_TABLE_TEMPLATE = `## 术语表

| 术语 | 别名 | 英文名 |
| --- | --- | --- |
| 订单明细 | 订单流水、下单记录 | order_detail |
`;

/** 追加模板；保留作者已有内容，不覆盖 */
export function appendTermTemplate(content: string): string {
  const trimmed = content.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n\n${TERM_TABLE_TEMPLATE}` : TERM_TABLE_TEMPLATE;
}

/**
 * 粗判是否已有术语表，仅用于切换按钮文案（真正的解析以服务端为准）。
 *
 * 判定口径对齐服务端：章节标题「含」术语即算（如「业务术语」「术语表」），
 * 或表格里出现含「术语」的单元格。故意不用「标题必须以术语表结尾」这种更严的规则 ——
 * 那会让「### 业务术语」这种能被服务端解析的标题被判成没有术语表。
 */
export function hasTermTable(content: string): boolean {
  return /^#{1,6}[^\n]*术语/m.test(content) || /^\s*\|[^\n]*术语[^\n]*\|/m.test(content);
}

/** 编辑器里的写法提示；与服务端可解析格式保持一致 */
export const TERM_TABLE_HINT =
  '智能体会解析「术语表」章节做同义词扩展：业务说法、别名、英文名写在同一行，' +
  '检索时才能把「订单流水」映射到 dwd_trade_order_detail_d。';
