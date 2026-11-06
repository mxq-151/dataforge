/**
 * 术语表模板的工具函数测试。
 *
 * 这些函数直接决定「插入模板」按钮写进正文的内容，所以只测三件事：
 * 空文档得到完整模板、已有内容不被覆盖、重复插入不会破坏 Markdown 段落分隔。
 *
 * 与服务端的契约（模板文本必须可被 TermDictionary 解析）由 Java 侧
 * TermTableTemplateContractTest 用同一段文本断言，这里只校验客户端行为。
 */

import { describe, expect, it } from 'vitest';
import { appendTermTemplate, hasTermTable, TERM_TABLE_TEMPLATE } from './termTableTemplate';

describe('术语表模板', () => {
  it('模板包含服务端要求的章节标题与三列表头', () => {
    expect(TERM_TABLE_TEMPLATE).toContain('## 术语表');
    expect(TERM_TABLE_TEMPLATE).toContain('| 术语 | 别名 | 英文名 |');
    expect(TERM_TABLE_TEMPLATE.trim().split('\n').length).toBeGreaterThanOrEqual(5);
  });

  it('空文档直接得到模板', () => {
    expect(appendTermTemplate('')).toBe(TERM_TABLE_TEMPLATE);
    expect(appendTermTemplate('   \n\n')).toBe(TERM_TABLE_TEMPLATE);
  });

  it('已有内容时追加，不覆盖，且保留一个空行分隔', () => {
    const content = '# 订单域\n\n本文说明订单口径。\n\n';
    const result = appendTermTemplate(content);

    expect(result.startsWith('# 订单域\n\n本文说明订单口径。\n\n## 术语表')).toBe(true);
    expect(result.match(/## 术语表/g)).toHaveLength(1);
  });

  it('重复插入保留两组表格（作者可自行删除多余的一组）', () => {
    const once = appendTermTemplate('# 文档');
    const twice = appendTermTemplate(once);

    expect(twice.match(/\| 术语 \| 别名 \| 英文名 \|/g)).toHaveLength(2);
  });

  it('识别已有术语表：标题或表头任一命中即可', () => {
    expect(hasTermTable('## 术语表\n\n| 术语 | 别名 |')).toBe(true);
    expect(hasTermTable('| 术语 | 别名 | 英文名 |\n| --- | --- | --- |')).toBe(true);
    expect(hasTermTable('### 业务术语\n\n正文')).toBe(true);
    expect(hasTermTable('订单明细也叫订单流水。')).toBe(false);
  });
});
