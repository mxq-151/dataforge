# -*- coding: utf-8 -*-
"""DataForge 项目计划书 Markdown -> HTML 渲染内核。

被 df_gen_stage2.py（打印版 / stage2）与 df_make_web.py（网页版 / stage3）共用。

渲染约定（与既有交付件保持一致）：
- `## 一、…`     -> h2，id = section-N（N 为章序，从 1 起）
- `### 1.1 xxx`  -> h3，标题写作（一）xxx；id = section-N-{块序号}
- `#### 1. xxx`  -> h4，标题照写
- 块序号：章内 0-based 递增，h2 自身为 0，导语随后为 1，依此类推
- 表格 -> table；有序 / 无序列表 -> ol / ul.plain-list；引用 -> callout
- 章导语取自 LEADIN；第九章（附录）额外注入「平台核心一览」指标卡
"""

import re

CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
          '十一', '十二', '十三', '十四', '十五']

LEADIN = {
    1: '本章说明项目的提出背景、平台定位、与 AI 编程助手及云数据平台的差异（谁提出需求）、'
       '与同类平台的对照、建设目标与范围边界，为后续章节的需求分析与方案设计提供依据。',
    2: '本章从使用角色出发梳理典型场景，并给出规范开发环境、信息底座、血缘与任务依赖三类功能需求。',
    3: '本章给出平台的总体架构、核心设计原则（五类信息与需求驱动的开发闭环）与四项关键设计决策及其取舍依据。',
    4: '本章逐一说明四大核心组件与治理组件的设计，突出各自对智能体理解业务数据的贡献。',
    7: '本章列出交付物清单，并明确功能验收范围、质量保障标准与交付验收的组织方式。',
}

# 小节级导语（按 `x.y` 编号匹配，注入到对应 h3 之前）；第五章、第六章的导语本身写在正文里，不重复注入
H3_LEADIN = {
    '2.2': '功能需求按规范开发环境、信息底座、血缘与任务依赖三个方向描述。',
}

APPENDIX_LEADIN = '本附录汇总各子系统的现状规模与关键配置项，作为计划书的事实依据与后续变更的比对基线。'

# 附录「平台核心一览」指标卡（数值与附录基线保持一致，改动附录口径时须同步）
STATS = [
    ('4', '核心组件'),
    ('5', '类上下文信息'),
    ('28', '张服务端表'),
    ('1001', '自动化测试用例'),
    ('13', '种数据源类型'),
]

COVER = {
    'category': '数据平台建设',
    'subtitle': '规范开发环境 · 信息底座 · 数据血缘与任务依赖',
    'secret': '内部资料',
}


def inline(text):
    """行内标记：反引号按纯文本输出（既有交付件同样不保留 code 样式）。"""
    text = text.replace('`', '')
    text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
    return text


def _is_new_block(line):
    return bool(re.match(r'^(#{1,4} |\||> |[-*] |\d+\. |---$|===$)', line))


def parse(md_text):
    """把 Markdown 解析为块序列：[(type, payload), ...]"""
    lines = md_text.split('\n')
    blocks, i, n = [], 0, len(lines)
    while i < n:
        raw = lines[i]
        line = raw.strip()
        if not line:
            i += 1
            continue
        if line.startswith('#### '):
            blocks.append(('h4', line[5:].strip()))
            i += 1
        elif line.startswith('### '):
            blocks.append(('h3', line[4:].strip()))
            i += 1
        elif line.startswith('## '):
            blocks.append(('h2', line[3:].strip()))
            i += 1
        elif line.startswith('# '):
            blocks.append(('h1', line[2:].strip()))
            i += 1
        elif line.startswith('|'):
            rows = []
            while i < n and lines[i].strip().startswith('|'):
                rows.append([c.strip() for c in lines[i].strip().strip('|').split('|')])
                i += 1
            blocks.append(('table', (rows[0], rows[2:])))
        elif line.startswith('> '):
            buf = []
            while i < n and lines[i].strip().startswith('>'):
                buf.append(lines[i].strip()[2:].strip())
                i += 1
            blocks.append(('callout', ' '.join(buf)))
        elif re.match(r'^[-*] ', line):
            items = []
            while i < n and re.match(r'^[-*] ', lines[i].strip()):
                items.append(lines[i].strip()[2:].strip())
                i += 1
            blocks.append(('ul', items))
        elif re.match(r'^\d+\. ', line):
            items = []
            while i < n and re.match(r'^\d+\. ', lines[i].strip()):
                items.append(re.sub(r'^\d+\. ', '', lines[i].strip()))
                i += 1
            blocks.append(('ol', items))
        elif line in ('---', '***', '___'):
            i += 1
        else:
            buf = []
            while i < n and lines[i].strip() and not _is_new_block(lines[i].strip()):
                buf.append(lines[i].strip())
                i += 1
            blocks.append(('p', ' '.join(buf)))
    return blocks


def h3_title(text):
    """`1.1 项目背景` -> `（一）项目背景`"""
    m = re.match(r'^(\d+)\.(\d+)\s+(.*)$', text)
    if not m:
        return text
    idx = int(m.group(2)) - 1
    cn = CN_NUM[idx] if 0 <= idx < len(CN_NUM) else str(idx + 1)
    return '（%s）%s' % (cn, m.group(3))


def build_chapters(blocks):
    chapters, cur = [], None
    for b in blocks:
        if b[0] == 'h1':
            continue
        if b[0] == 'h2':
            cur = {'n': len(chapters) + 1, 'title': b[1], 'blocks': []}
            chapters.append(cur)
        elif cur is not None:
            cur['blocks'].append(b)
    return chapters


def assign_ids(chapters):
    """给每章内容块编号，返回 [(type, payload, block_index), ...]"""
    for ch in chapters:
        counter = [0]
        items = []

        def add(kind, payload):
            counter[0] += 1
            items.append([kind, payload, counter[0]])

        if ch['n'] in LEADIN:
            add('leadin', LEADIN[ch['n']])
        if ch['title'].startswith('九、附录'):
            add('stats', STATS)
            add('leadin', APPENDIX_LEADIN)
        for kind, payload in ch['blocks']:
            if kind == 'h3':
                m = re.match(r'^(\d+\.\d+)\s', payload)
                if m and m.group(1) in H3_LEADIN:
                    add('leadin', H3_LEADIN[m.group(1)])
            add(kind, payload)
        ch['items'] = items
    return chapters


def extract_meta(md_text):
    """从文末 `**编制单位**：…` 等行提取封面信息。"""
    def grab(key):
        m = re.search(r'\*\*%s\*\*：(.+)' % key, md_text)
        return m.group(1).strip() if m else ''
    return {
        'title': (re.search(r'^#\s+(.+)$', md_text, re.M) or [None, ''])[1].strip(),
        'org': grab('编制单位'),
        'version': grab('文档版本'),
        'date': grab('编制日期'),
    }


# --------------------------------------------------------------------------
# stage2：打印 / 转 docx 用 HTML
# --------------------------------------------------------------------------

def _table_html(header, body, cls='data-table'):
    out = ['<table class="%s">\n<thead><tr>' % cls]
    for c in header:
        out.append('\n<th>%s</th>' % inline(c))
    out.append('\n</tr></thead><tbody>')
    for row in body:
        out.append('\n<tr>')
        for c in row:
            out.append('\n<td>%s</td>' % inline(c))
        out.append('\n</tr>')
    out.append('\n</tbody></table>')
    return ''.join(out)


def render_stage2(chapters, meta):
    parts = []
    toc = []
    for ch in chapters:
        n = ch['n']
        toc.append('<li><a href="#section-%d">%s</a></li>' % (n, ch['title']))
        parts.append('\n  <h2 id="section-%d">%s</h2>' % (n, ch['title']))
        for kind, payload, idx in ch['items']:
            if kind == 'leadin':
                parts.append('<p style="text-indent:18pt">%s</p>' % inline(payload))
            elif kind == 'stats':
                tds = ''.join(
                    '<td><p class="metric-value">%s</p><p class="metric-label">%s</p></td>' % (v, l)
                    for v, l in payload)
                parts.append('<table class="metric-table"><thead><tr><th colspan="%d">平台核心一览</th>'
                             '</tr></thead><tbody><tr>%s</tr></tbody></table>' % (len(payload), tds))
            elif kind == 'h3':
                parts.append('<h3>%s</h3>' % h3_title(payload))
            elif kind == 'h4':
                parts.append('<h4>%s</h4>' % inline(payload))
            elif kind == 'p':
                parts.append('<p style="text-indent:18pt">%s</p>' % inline(payload))
            elif kind == 'callout':
                parts.append('<p class="callout-info">&nbsp;&nbsp;%s</p>' % inline(payload))
            elif kind == 'table':
                parts.append(_table_html(payload[0], payload[1]))
            elif kind in ('ul', 'ol'):
                tag = 'ol' if kind == 'ol' else 'ul'
                lis = ''.join('\n<li>%s</li>' % inline(x) for x in payload)
                parts.append('<%s class="plain-list">%s\n</%s>' % (tag, lis, tag))
    return '\n'.join(toc), '\n'.join(parts)


def build_stage2(md_text, css):
    meta = extract_meta(md_text)
    chapters = assign_ids(build_chapters(parse(md_text)))
    toc, body = render_stage2(chapters, meta)
    footnote = ('<p class="doc-footnote">编制单位：%s　|　文档版本：%s　|　编制日期：%s</p>'
                % (meta['org'], meta['version'], meta['date']))
    cover = []
    cover.append('<section role="cover">')
    cover.append('  <p class="cover-category">%s</p>' % COVER['category'])
    cover.append('  <h1 class="cover-title">%s</h1>' % meta['title'])
    cover.append('  <p class="cover-subtitle">%s</p>' % COVER['subtitle'])
    cover.append('  <p class="cover-meta-line">编制单位：%s</p>' % meta['org'])
    cover.append('  <p class="cover-meta-line">文档版本：%s</p>' % meta['version'])
    cover.append('  <p class="cover-meta-line">编制日期：%s</p>' % meta['date'])
    cover.append('  <p class="cover-meta-line">文档密级：%s</p>' % COVER['secret'])
    cover.append('</section>')
    return """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="docx-page-size" content="A4">
<title>%(title)s</title>
<style>%(css)s
</style>
</head>
<body>

%(cover)s

<section role="body" data-page-restart="1">

  <nav class="doc-toc" aria-label="文档目录">
    <p class="toc-title">目录</p>
    <ol class="toc-list">%(toc)s</ol>
  </nav>

  %(body)s

  %(footnote)s

</section>

</body>
</html>
""" % {'title': meta['title'], 'css': css, 'cover': '\n'.join(cover), 'toc': toc,
       'body': body, 'footnote': footnote}


# --------------------------------------------------------------------------
# stage3：网页版（侧栏目录 + 卡片式分章）
# --------------------------------------------------------------------------

SCRIPT = """
<script>
(function(){
  var btn=document.getElementById('tocToggle'),toc=document.getElementById('toc');
  if(btn&&toc){btn.addEventListener('click',function(){toc.classList.toggle('open');
    btn.setAttribute('aria-expanded',toc.classList.contains('open')?'true':'false');});}
  var links=[].slice.call(document.querySelectorAll('#toc a[href^="#"]'));
  var map={};links.forEach(function(a){var el=document.getElementById(a.getAttribute('href').slice(1));
    if(el){map[el.id]=a;}});
  var targets=Object.keys(map).map(function(k){return document.getElementById(k);});
  if(!('IntersectionObserver' in window)||!targets.length){return;}
  var cur=null;
  var io=new IntersectionObserver(function(es){
    es.forEach(function(e){ if(e.isIntersecting){
      if(cur){cur.classList.remove('active');}
      cur=map[e.target.id]; if(cur){cur.classList.add('active');}
    }});
  },{rootMargin:'-8% 0px -80% 0px',threshold:0});
  targets.forEach(function(t){io.observe(t);});
})();
</script>
"""


def render_web(chapters, meta):
    toc = []
    sections = []
    for ch in chapters:
        n = ch['n']
        toc.append('<li class="lvl-2"><a href="#section-%d">%s</a></li>' % (n, ch['title']))
        inner = ['<h2 id="section-%d">%s</h2>' % (n, ch['title'])]
        for kind, payload, idx in ch['items']:
            if kind == 'leadin':
                inner.append('<p>%s</p>' % inline(payload))
            elif kind == 'stats':
                stats = ''.join('<div class="stat"><span class="v">%s</span><span class="l">%s</span></div>'
                                % (v, l) for v, l in payload)
                inner.append('<p class="stats-title">平台核心一览</p><div class="stats">%s</div>' % stats)
            elif kind == 'h3':
                title = h3_title(payload)
                toc.append('<li class="lvl-3"><a href="#section-%d-%d">%s</a></li>' % (n, idx, title))
                inner.append('<h3 id="section-%d-%d">%s</h3>' % (n, idx, title))
            elif kind == 'h4':
                inner.append('<h4>%s</h4>' % inline(payload))
            elif kind == 'p':
                inner.append('<p>%s</p>' % inline(payload))
            elif kind == 'callout':
                inner.append('<div class="callout">&nbsp;&nbsp;%s</div>' % inline(payload))
            elif kind == 'table':
                inner.append('<div class="table-wrap">%s</div>'
                             % _table_html(payload[0], payload[1], cls='data'))
            elif kind in ('ul', 'ol'):
                tag = 'ol' if kind == 'ol' else 'ul'
                lis = ''.join('\n<li>%s</li>' % inline(x) for x in payload)
                inner.append('<%s class="plain-list">%s\n</%s>' % (tag, lis, tag))
        sections.append('<section class="card chapter" aria-labelledby="section-%d">%s</section>'
                        % (n, ''.join(inner)))
    return ''.join(toc), '\n    '.join(sections)


def build_web(md_text, css):
    meta = extract_meta(md_text)
    chapters = assign_ids(build_chapters(parse(md_text)))
    toc, body = render_web(chapters, meta)
    hero_meta = ''.join('<div><b>%s：</b>%s</div>' % (k, v) for k, v in
                        (('编制单位', meta['org']), ('文档版本', meta['version']),
                         ('编制日期', meta['date']), ('文档密级', COVER['secret'])))
    end = '编制单位：%s　|　文档版本：%s　|　编制日期：%s' % (meta['org'], meta['version'], meta['date'])
    return """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="DataForge 项目计划书 · 静态网页版">
<meta name="description" content="%(title)s：面向业务方的 AI 数据开发平台——业务方提需求、智能体做开发">
<title>%(title)s</title>
<style>
%(css)s
</style>
</head>
<body id="top">
<a class="skip" href="#main">跳到正文</a>

<header class="hero">
  <div class="hero-inner">
    <p class="hero-cat">%(category)s</p>
    <h1 class="hero-title">%(title)s</h1>
    <p class="hero-sub">%(subtitle)s</p>
    <div class="hero-meta">%(hero_meta)s</div>
  </div>
</header>

<div class="layout">
  <aside class="sidebar">
    <button class="toc-toggle" id="tocToggle" aria-expanded="false" aria-controls="toc">目录<span aria-hidden="true">▾</span></button>
    <nav class="toc" id="toc" aria-label="文档目录">
      <p class="toc-head">目录</p>
      <ol>%(toc)s</ol>
    </nav>
  </aside>

  <main id="main">
    %(body)s
    <p class="doc-end">%(end)s</p>
  </main>
</div>

<a class="totop" href="#top" title="回到顶部" aria-label="回到顶部">↑</a>
%(script)s
</body>
</html>
""" % {'title': meta['title'], 'css': css, 'category': COVER['category'],
       'subtitle': COVER['subtitle'], 'hero_meta': hero_meta, 'toc': toc,
       'body': body, 'end': end, 'script': SCRIPT}
