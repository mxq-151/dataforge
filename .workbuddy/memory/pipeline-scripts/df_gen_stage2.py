#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把重写后的 final_draft.md 转成 docx 导向的 stage2 HTML（复用已通过门禁的版式）。"""
import pathlib
import re

ROOT = pathlib.Path("/Users/mxq/Desktop/dataforge/output/45d4b135-45a3-447c-86ab-8a2d7ff7a55e")
MD = ROOT / "stage1" / "final_draft.md"
OUT = ROOT / "stage2" / "formatted-DataForge项目计划书.html"

CSS = """@page { @bottom-center { content: counter(page); } }
@page cover { @bottom-center { content: none; } }
section[role="cover"] { page: cover; }
:root {
  --typography-fontFamily-heading: 微软雅黑, Microsoft YaHei, PingFang SC;
  --typography-fontFamily-body: 微软雅黑, Microsoft YaHei, PingFang SC;
  --typography-fontFamily-data: DIN Next, Arial, sans-serif;
  --typography-fontSize-coverTitle: 22pt;
  --typography-fontSize-coverCategory: 14pt;
  --typography-fontSize-sectionHeader: 13pt;
  --typography-fontSize-h1: 20pt;
  --typography-fontSize-h2: 11pt;
  --typography-fontSize-h3: 10pt;
  --typography-fontSize-body: 9pt;
  --typography-fontSize-small: 8pt;
  --typography-fontSize-tiny: 7pt;
  --typography-lineHeight-title: 1.3;
  --typography-lineHeight-body: 1.6;
  --typography-lineHeight-compact: 1.2;
  --typography-fontWeight-heading: 600;
  --typography-fontWeight-bold: 700;
  --color-primary: #1565C0;
  --color-accent: #00897B;
  --color-text: #212121;
  --color-textSecondary: #616161;
  --color-heading: #1A237E;
  --color-divider: #E0E0E0;
  --color-background: #FFFFFF;
  --color-surface: #F5F7FA;
  --color-danger: #C62828;
  --spacing-paragraph: 0.75em;
  --spacing-sectionGap: 2.5em;
  --spacing-cardPadding: 1.5em;
  --spacing-cell: 0.5em;
  --spacing-block: 0.9em;
  --layout-maxContentWidth: 160mm;
  --decoration-headingBorderWidth: 4px;
  --decoration-h3BorderWidth: 3px;
  --hairline: 1px;
  --summary-border-width: 4px;
  --fs-h1: var(--typography-fontSize-h1);
  --fs-h2: var(--typography-fontSize-h2);
  --fs-h3: var(--typography-fontSize-h3);
  --fs-section: var(--typography-fontSize-sectionHeader);
  --fs-body: var(--typography-fontSize-body);
  --fs-small: var(--typography-fontSize-small);
  --fs-tiny: var(--typography-fontSize-tiny);
  --ff-heading: var(--typography-fontFamily-heading);
  --ff-body: var(--typography-fontFamily-body);
  --ff-data: var(--typography-fontFamily-data);
  --lh-body: var(--typography-lineHeight-body);
  --lh-compact: var(--typography-lineHeight-compact);
  --fw-bold: var(--typography-fontWeight-bold);
  --page-content-width: var(--layout-maxContentWidth);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--ff-body); font-size: var(--fs-body); line-height: var(--lh-body); color: var(--color-text); background: var(--color-background); max-width: var(--page-content-width); margin-left: auto; margin-right: auto; }
.cover-category { font-family: var(--ff-heading); font-size: var(--typography-fontSize-coverCategory); font-weight: var(--fw-bold); color: var(--color-primary); text-align: left; letter-spacing: 0.08em; margin-bottom: var(--spacing-block); }
.cover-title { font-family: var(--ff-heading); font-size: var(--typography-fontSize-coverTitle); font-weight: var(--fw-bold); color: var(--color-primary); text-align: left; line-height: var(--typography-lineHeight-title); margin-bottom: var(--spacing-block); }
.cover-subtitle { font-family: var(--ff-body); font-size: var(--fs-h2); color: var(--color-textSecondary); text-align: left; margin-bottom: var(--spacing-sectionGap); }
.cover-meta-line { font-family: var(--ff-body); font-size: var(--fs-small); color: var(--color-textSecondary); text-align: left; border-top: var(--hairline) solid var(--color-divider); padding-top: var(--spacing-cell); margin-bottom: var(--spacing-cell); line-height: var(--lh-compact); }
.toc-title { font-family: var(--ff-heading); font-size: var(--fs-section); font-weight: var(--fw-bold); color: var(--color-heading); text-align: left; text-indent: 0; margin-bottom: var(--spacing-block); }
.toc-list, .toc-list ol, .toc-list ul { list-style: none; list-style-type: none; padding-left: 0; }
.toc-list li { font-size: var(--fs-body); color: var(--color-text); text-align: left; margin-bottom: var(--spacing-cell); line-height: var(--lh-compact); }
h2 { font-family: var(--ff-heading); font-size: var(--fs-section); font-weight: var(--fw-bold); color: var(--color-heading); text-align: left; background: var(--color-surface); border-bottom: var(--decoration-headingBorderWidth) solid var(--color-primary); padding: var(--spacing-cell) var(--spacing-cell); margin-top: var(--spacing-sectionGap); margin-bottom: var(--spacing-block); line-height: var(--typography-lineHeight-title); }
h3 { font-family: var(--ff-heading); font-size: var(--fs-h3); font-weight: var(--fw-bold); color: var(--color-primary); text-align: left; border-left: var(--decoration-h3BorderWidth) solid var(--color-accent); padding-left: var(--spacing-cell); margin-top: var(--spacing-block); margin-bottom: var(--spacing-paragraph); line-height: var(--typography-lineHeight-title); }
h4 { font-family: var(--ff-heading); font-size: var(--fs-body); font-weight: var(--fw-bold); color: var(--color-text); text-align: left; margin-top: var(--spacing-paragraph); margin-bottom: var(--spacing-paragraph); }
p { font-size: var(--fs-body); color: var(--color-text); text-align: justify; margin-bottom: var(--spacing-paragraph); line-height: var(--lh-body); }
li { font-size: var(--fs-body); color: var(--color-text); text-align: left; margin-bottom: var(--spacing-cell); line-height: var(--lh-body); }
ol.plain-list, ul.plain-list { padding-left: var(--spacing-cardPadding); }
table.data-table { width: 100%; border-collapse: collapse; margin-bottom: var(--spacing-block); }
table.data-table caption { font-size: var(--fs-small); font-weight: var(--fw-bold); color: var(--color-textSecondary); text-align: left; margin-bottom: var(--spacing-cell); }
table.data-table th { font-family: var(--ff-heading); font-size: var(--fs-small); font-weight: var(--fw-bold); color: var(--color-background); background: var(--color-primary); text-align: left; border: var(--hairline) solid var(--color-primary); padding: var(--spacing-cell); line-height: var(--lh-compact); }
table.data-table td { font-size: var(--fs-small); color: var(--color-text); text-align: left; border: var(--hairline) solid var(--color-divider); padding: var(--spacing-cell); vertical-align: top; line-height: var(--lh-compact); }
table.data-table tbody tr:nth-child(even) td { background: var(--color-surface); }
table.metric-table { width: 100%; border-collapse: collapse; margin-top: var(--spacing-block); margin-bottom: var(--spacing-block); }
table.metric-table th { font-family: var(--ff-heading); font-size: var(--fs-small); font-weight: var(--fw-bold); color: var(--color-background); background: var(--color-primary); text-align: left; border: var(--hairline) solid var(--color-primary); padding: var(--spacing-cell); line-height: var(--lh-compact); }
table.metric-table td { background: var(--color-background); border: var(--hairline) solid var(--color-divider); padding: var(--spacing-cell); text-align: center; vertical-align: middle; }
table.metric-table .metric-value { text-indent: 0; font-family: var(--ff-data); font-size: var(--fs-h2); font-weight: var(--fw-bold); color: var(--color-primary); text-align: center; margin-bottom: 0; line-height: var(--lh-compact); }
table.metric-table .metric-label { text-indent: 0; font-size: var(--fs-tiny); color: var(--color-textSecondary); text-align: center; margin-bottom: 0; line-height: var(--lh-compact); }
.data-emphasis { color: var(--color-danger); font-weight: var(--fw-bold); }
p.callout-info { font-size: var(--fs-body); color: var(--color-text); text-align: justify; text-indent: 0; background: var(--color-surface); border-left: var(--summary-border-width) solid var(--color-primary); padding: var(--spacing-cell); margin-bottom: var(--spacing-block); }
.doc-footnote { font-size: var(--fs-small); color: var(--color-textSecondary); text-align: left; text-indent: 0; border-top: var(--hairline) solid var(--color-divider); padding-top: var(--spacing-cell); margin-top: var(--spacing-sectionGap); }
"""

LEADIN = {
    "一": "本章说明项目的提出背景、平台定位、与同类平台的差异、建设目标与范围边界，为后续章节的需求分析与方案设计提供依据。",
    "二": "本章从使用角色出发梳理典型场景，并给出规范开发环境、信息底座、血缘与任务依赖三类功能需求。",
    "三": "本章给出平台的总体架构，并说明核心设计原则与四项关键设计决策及其取舍依据。",
    "四": "本章逐一说明四大核心组件与治理组件的设计，突出各自对智能体理解业务数据的贡献。",
    "六": "本章给出推广目标、推广渠道与公开活动 / 比赛参与计划，并明确各阶段的时间节点与产出。",
    "七": "本章列出交付物清单，并明确功能验收范围、质量保障标准与交付验收的组织方式。",
    "九": "本附录汇总各子系统的现状规模与关键配置项，作为计划书的事实依据与后续变更的比对基线。",
}
LEADIN_H3 = {
    "2.2": "功能需求按规范开发环境、信息底座、血缘与任务依赖三个方向描述。",
}

CN = "一二三四五六七八九十"


METRIC_HEAD = "平台核心一览"
METRIC = [
    ("4", "核心组件"),
    ("5", "类上下文信息"),
    ("28", "张服务端表"),
    ("1001", "自动化测试用例"),
    ("13", "种数据源类型"),
]


def inline(s):
    s = re.sub(r"`([^`]+)`", r"\1", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    return s


def parse_table(lines):
    rows = [[c.strip() for c in l.strip().strip("|").split("|")] for l in lines]
    header = rows[0]
    body = rows[2:]  # skip separator
    out = ['<table class="data-table">', "<thead><tr>"]
    out += [f"<th>{inline(c)}</th>" for c in header]
    out += ["</tr></thead><tbody>"]
    for r in body:
        out.append("<tr>")
        out += [f"<td>{inline(c)}</td>" for c in r]
        out.append("</tr>")
    out += ["</tbody></table>"]
    return "\n".join(out)


def parse_list(lines, ordered):
    tag = "ol" if ordered else "ul"
    out = [f'<{tag} class="plain-list">']
    for l in lines:
        item = re.sub(r"^\s*(?:\d+\.|[-*])\s+", "", l)
        out.append(f"<li>{inline(item)}</li>")
    out.append(f"</{tag}>")
    return "\n".join(out)


def main():
    text = MD.read_text(encoding="utf-8")
    lines = text.split("\n")

    # 剥离顶部 H1 与末尾落款（封面单独生成）
    blocks = []  # (kind, payload)
    i = 0
    while i < len(lines):
        ln = lines[i]
        s = ln.strip()
        if not s:
            i += 1
            continue
        if s.startswith("# ") :
            i += 1
            continue
        if s.startswith("#### "):
            blocks.append(("h4", s[5:].strip()))
            i += 1
        elif s.startswith("### "):
            blocks.append(("h3", s[4:].strip()))
            i += 1
        elif s.startswith("## "):
            blocks.append(("h2", s[3:].strip()))
            i += 1
        elif s == "---":
            i += 1
            continue
        elif s.startswith(">"):
            q = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                q.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
            blocks.append(("quote", " ".join(q)))
        elif s.startswith("|"):
            tbl = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                tbl.append(lines[i])
                i += 1
            blocks.append(("table", parse_table(tbl)))
        elif re.match(r"^\d+\.\s", s):
            lst = []
            while i < len(lines) and re.match(r"^\d+\.\s", lines[i].strip()):
                lst.append(lines[i]); i += 1
            blocks.append(("ol", parse_list(lst, True)))
        elif re.match(r"^[-*]\s", s):
            lst = []
            while i < len(lines) and re.match(r"^[-*]\s", lines[i].strip()):
                lst.append(lines[i]); i += 1
            blocks.append(("ul", parse_list(lst, False)))
        else:
            # 段落（合并连续非空行）
            para = [s]
            i += 1
            while i < len(lines) and lines[i].strip() and not re.match(r"^(#{1,4}\s|\||>|[-*]\s|\d+\.\s|---)", lines[i]):
                para.append(lines[i].strip()); i += 1
            blocks.append(("p", inline(" ".join(para))))
            continue

    # 章节与标题编号
    chapters = []  # {num, title, items}
    cur = None
    for kind, payload in blocks:
        if kind == "h2":
            m = re.match(r"^([一二三四五六七八九十]+)、", payload)
            num = m.group(1) if m else ""
            cur = {"num": num, "title": payload, "items": []}
            chapters.append(cur)
        elif kind == "h3":
            # 归一化 h3 编号为（一）（二）…
            m = re.match(r"^(\d+)\.(\d+)\s+(.*)$", payload)
            if m and cur and cur["num"]:
                sub = CN[int(m.group(2)) - 1]
                payload = f"（{sub}）{m.group(3)}"
                key = f"{m.group(1)}.{m.group(2)}"
            else:
                key = None
            if key and key in LEADIN_H3:
                cur["items"].append(("p", LEADIN_H3[key]))
            cur["items"].append(("h3", payload))
        else:
            cur["items"].append((kind, payload))

    # 章节导语：h2 后紧跟 h3 时插入
    for ch in chapters:
        if ch["items"] and ch["items"][0][0] == "h3" and ch["num"] in LEADIN:
            ch["items"].insert(0, ("p", LEADIN[ch["num"]]))

    # 目录
    toc = []
    for i, ch in enumerate(chapters, 1):
        toc.append(f'<li><a href="#section-{i}">{ch["title"]}</a></li>')

    metric_cells = "".join(
        f'<td><p class="metric-value">{v}</p><p class="metric-label">{l}</p></td>' for v, l in METRIC
    )

    body_parts = []
    for i, ch in enumerate(chapters, 1):
        body_parts.append(f'<h2 id="section-{i}">{ch["title"]}</h2>')
        if ch["title"].startswith("九、附录"):
            body_parts.append(
                f'<table class="metric-table"><thead><tr><th colspan="5">{METRIC_HEAD}</th></tr></thead>'
                f'<tbody><tr>{metric_cells}</tr></tbody></table>'
            )
        for kind, payload in ch["items"]:
            if kind == "quote":
                body_parts.append(f'<p class="callout-info">&nbsp;&nbsp;{inline(payload)}</p>')
            elif kind == "h3":
                body_parts.append(f"<h3>{payload}</h3>")
            elif kind == "h4":
                body_parts.append(f"<h4>{payload}</h4>")
            elif kind == "p":
                body_parts.append(f'<p style="text-indent:18pt">{payload}</p>')
            else:
                body_parts.append(payload)


    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="docx-page-size" content="A4">
<title>DataForge 数据开发平台项目计划书</title>
<style>{CSS}</style>
</head>
<body>

<section role="cover">
  <p class="cover-category">数据平台建设</p>
  <h1 class="cover-title">DataForge 数据开发平台项目计划书</h1>
  <p class="cover-subtitle">规范开发环境 · 信息底座 · 数据血缘与任务依赖</p>
  <p class="cover-meta-line">编制单位：DataForge 项目组</p>
  <p class="cover-meta-line">文档版本：V1.0</p>
  <p class="cover-meta-line">编制日期：2026 年 9 月</p>
  <p class="cover-meta-line">文档密级：内部资料</p>
</section>

<section role="body" data-page-restart="1">

  <nav class="doc-toc" aria-label="文档目录">
    <p class="toc-title">目录</p>
    <ol class="toc-list">{"".join(toc)}</ol>
  </nav>

  {"".join(body_parts)}

  <p class="doc-footnote">编制单位：DataForge 项目组　|　文档版本：V1.0　|　编制日期：2026 年 9 月</p>

</section>
</body>
</html>
"""
    OUT.write_text(html, encoding="utf-8")
    print(f"输出: {OUT}")
    print(f"字节: {len(html.encode('utf-8'))}")
    print(f"章节: {len(chapters)}  目录条目: {len(toc)}  表格: {html.count('<table')}  h2: {html.count('<h2')}  h3: {html.count('<h3')}")
    return chapters


if __name__ == "__main__":
    main()
