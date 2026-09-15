#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 docx 版中间产物（stage2 HTML）重排为可直接打开的静态网页版计划书。"""
import pathlib
import re
from bs4 import BeautifulSoup, NavigableString, Tag

ROOT = pathlib.Path("/Users/mxq/Desktop/dataforge/output/45d4b135-45a3-447c-86ab-8a2d7ff7a55e")
SRC = ROOT / "stage2" / "formatted-DataForge项目计划书.html"
OUT = ROOT / "stage3" / "DataForge数据开发平台-项目计划书.html"

CSS = """
:root{
  --page:#eef1f5; --surface:#ffffff; --surface-2:#f6f8fb;
  --text:#1f2328; --text-2:#5b6470; --text-3:#8b939e;
  --border:#e2e6ec; --border-2:#cfd6df;
  --primary:#1565c0; --primary-d:#0f2a54; --accent:#00897b;
  --danger:#c62828; --warn-bg:#fff7f6; --info-bg:#f2f7fd;
  --radius:12px; --radius-s:8px;
  --sans:system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--page);color:var(--text);font-family:var(--sans);
  font-size:15.5px;line-height:1.78;-webkit-font-smoothing:antialiased}
a{color:var(--primary);text-decoration:none}
a:hover{text-decoration:underline}
.skip{position:absolute;left:-9999px}
.skip:focus{left:12px;top:12px;z-index:99;background:var(--surface);padding:8px 14px;border-radius:var(--radius-s)}

/* ── 封面 ── */
.hero{background:var(--primary-d);color:#fff;padding:56px 24px 44px}
.hero-inner{max-width:1180px;margin:0 auto}
.hero-cat{margin:0 0 14px;font-size:13px;letter-spacing:.16em;color:#8fb4e8;font-weight:600}
.hero-title{margin:0 0 14px;font-size:clamp(24px,3.4vw,38px);line-height:1.28;font-weight:600;letter-spacing:.01em}
.hero-sub{margin:0 0 30px;font-size:clamp(14px,1.5vw,17px);color:#c2d4ee;line-height:1.6}
.hero-meta{display:flex;flex-wrap:wrap;gap:10px 28px;margin:0;padding:18px 0 0;border-top:1px solid rgba(255,255,255,.16)}
.hero-meta div{font-size:13px;color:#a9c2e4}
.hero-meta b{color:#e6eefb;font-weight:600;margin-right:6px}

/* ── 布局 ── */
.layout{max-width:1180px;margin:0 auto;padding:28px 24px 72px;display:grid;
  grid-template-columns:250px minmax(0,1fr);gap:34px;align-items:start}
.sidebar{position:sticky;top:24px;max-height:calc(100vh - 48px);overflow:auto}
.toc-head{margin:0 0 10px;font-size:12px;letter-spacing:.14em;color:var(--text-3);
  font-weight:600;text-transform:uppercase}
.toc ol{list-style:none;margin:0;padding:0}
.toc li{margin:0}
.toc a{display:block;padding:6px 10px 6px 12px;font-size:13.5px;color:var(--text-2);
  border-left:2px solid transparent;border-radius:0 var(--radius-s) var(--radius-s) 0;line-height:1.5}
.toc a:hover{background:var(--surface);color:var(--primary);text-decoration:none}
.toc a.active{color:var(--primary);border-left-color:var(--primary);background:var(--surface);font-weight:600}
.toc .lvl-3 a{padding-left:26px;font-size:12.5px;color:var(--text-3)}
.toc-toggle{display:none}

/* ── 正文卡片 ── */
main{min-width:0}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);
  padding:26px 30px;margin:0 0 22px}
.chapter{scroll-margin-top:20px}
.chapter>h2{margin:-26px -30px 20px;padding:16px 30px;font-size:20px;font-weight:600;
  color:var(--primary-d);background:var(--surface-2);border-bottom:3px solid var(--primary);
  border-radius:var(--radius) var(--radius) 0 0;line-height:1.45}
h3{margin:30px 0 12px;padding-left:12px;font-size:16.5px;font-weight:600;color:var(--primary);
  border-left:3px solid var(--accent);line-height:1.5;scroll-margin-top:20px}
h3:first-of-type{margin-top:6px}
h4{margin:20px 0 8px;font-size:15px;font-weight:600;color:var(--text)}
p{margin:0 0 14px;text-align:justify;word-break:break-word;text-indent:2em}
.hero-cat,.hero-sub,.toc-head,.stats-title,.doc-end,.stat .v,.stat .l{text-indent:0}
main ul,main ol{margin:0 0 16px;padding-left:22px}
main li{margin:0 0 8px;text-align:justify}
strong{font-weight:600;color:#111}
.data-emphasis{color:var(--danger);font-weight:600}

/* ── 表格 ── */
.table-wrap{overflow-x:auto;margin:0 0 18px;border:1px solid var(--border);border-radius:var(--radius-s)}
table{border-collapse:collapse;width:100%;min-width:520px;font-size:13.5px}
table caption{caption-side:top;text-align:left;padding:10px 14px;font-size:12.5px;font-weight:600;
  color:var(--text-2);background:var(--surface-2);border-bottom:1px solid var(--border)}
th,td{padding:9px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--border);
  line-height:1.6;border-right:1px solid var(--border)}
th:last-child,td:last-child{border-right:none}
thead th{background:var(--primary);color:#fff;font-weight:600;border-color:var(--primary);
  white-space:nowrap}
tbody tr:nth-child(even) td{background:var(--surface-2)}
tbody tr:last-child td{border-bottom:none}

/* ── 指标卡 ── */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin:0 0 18px}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-s);
  padding:14px 12px;text-align:center}
.stat .v{display:block;font-size:22px;font-weight:600;color:var(--primary);line-height:1.25}
.stat .l{display:block;margin-top:4px;font-size:12px;color:var(--text-2);line-height:1.4}
.stats-title{margin:0 0 10px;font-size:12.5px;font-weight:600;color:var(--text-2)}

/* ── 摘要 ── */
.summary{background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--primary);
  border-radius:var(--radius);padding:24px 30px;margin:0 0 22px}
.summary h2{margin:0 0 6px;font-size:19px;font-weight:600;color:var(--primary-d)}
.summary .en{font-size:12px;color:var(--text-3);letter-spacing:.06em;font-weight:400}
.summary p{margin:0 0 12px}
.summary p:last-child{margin-bottom:0}

/* ── 提示块 ── */
.callout{margin:0 0 16px;padding:13px 16px;border-radius:var(--radius-s);border-left:4px solid;
  background:var(--info-bg);border-left-color:var(--primary)}
.callout.warn{background:var(--warn-bg);border-left-color:var(--danger)}

/* ── 页脚 ── */
.doc-end{margin:6px 0 0;padding:18px 0 0;border-top:1px solid var(--border);
  font-size:13px;color:var(--text-3);text-align:center}
.totop{position:fixed;right:22px;bottom:22px;width:40px;height:40px;border-radius:50%;
  background:var(--surface);border:1px solid var(--border-2);color:var(--text-2);
  display:flex;align-items:center;justify-content:center;font-size:16px;
  box-shadow:0 2px 10px rgba(15,42,84,.10)}
.totop:hover{color:var(--primary);text-decoration:none;border-color:var(--primary)}

/* ── 响应式 ── */
@media (max-width:960px){
  .layout{grid-template-columns:minmax(0,1fr);gap:18px;padding-top:18px}
  .sidebar{position:static;max-height:none}
  .toc-toggle{display:flex;width:100%;align-items:center;justify-content:space-between;
    padding:11px 14px;background:var(--surface);border:1px solid var(--border);
    border-radius:var(--radius-s);font:inherit;font-size:14px;font-weight:600;
    color:var(--primary-d);cursor:pointer}
  .toc{display:none;margin-top:8px;background:var(--surface);border:1px solid var(--border);
    border-radius:var(--radius-s);padding:8px}
  .toc.open{display:block}
  .card,.summary{padding:20px 18px}
  .chapter>h2{margin:-20px -18px 16px;padding:14px 18px;font-size:18px}
}

/* ── 打印 ── */
@media print{
  @page{margin:16mm 14mm}
  body{background:#fff;font-size:10.5pt;line-height:1.65}
  .hero{background:#fff;color:#000;padding:0 0 18px;border-bottom:2px solid var(--primary-d)}
  .hero-cat{color:var(--primary)}
  .hero-title{color:var(--primary-d);font-size:20pt}
  .hero-sub{color:#333}
  .hero-meta{border-top:1px solid #bbb}
  .hero-meta div{color:#333}
  .hero-meta b{color:#000}
  .layout{display:block;max-width:none;padding:12px 0 0}
  .sidebar,.totop,.skip{display:none}
  .card,.summary{border:none;border-radius:0;padding:0;margin:0 0 14pt;break-inside:auto}
  .chapter>h2{margin:0 0 10pt;padding:0 0 4pt;background:none;border-bottom:1.5pt solid var(--primary-d);
    border-radius:0;font-size:14pt;break-after:avoid}
  h3{font-size:11.5pt;margin:14pt 0 6pt;break-after:avoid}
  table{min-width:0;font-size:9pt}
  thead th{background:#e8edf5!important;color:#000;border-color:#9aa8b8}
  tbody tr:nth-child(even) td{background:#f7f9fc}
  .stats{grid-template-columns:repeat(5,1fr)}
  .callout,.summary{break-inside:avoid}
  .doc-end{break-before:avoid}
  a{color:inherit;text-decoration:none}
}
"""

JS = """
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
"""


def strip_lead_nbsp(tag):
    """去掉 docx 版式为左边框段落加的 &nbsp;&nbsp; 前导空格。"""
    for node in tag.find_all(string=True):
        if node.strip():
            node.replace_with(re.sub(r"^(\s|&nbsp;|\u00a0)+", "", str(node)))
            break


def build():
    soup = BeautifulSoup(SRC.read_text(encoding="utf-8"), "html.parser")
    cover = soup.select_one('section[role="cover"]')
    body = soup.select_one('section[role="body"]')

    cat = cover.select_one(".cover-category").get_text(strip=True)
    title = cover.select_one(".cover-title").get_text(strip=True)
    sub = cover.select_one(".cover-subtitle").get_text(strip=True)
    metas = [p.get_text(strip=True) for p in cover.select(".cover-meta-line")]

    nav = body.find("nav", class_="doc-toc")
    if nav:
        nav.extract()
    summary = body.find("div", class_="executive-summary")

    # 更新页脚日期：计划书正文里的编制日期保留原样，页脚用同样的表述
    chapters, cur = [], None
    for el in list(body.children):
        if isinstance(el, NavigableString):
            continue
        if el.name == "h2":
            cur = {"h2": el, "items": []}
            chapters.append(cur)
        elif cur is not None:
            cur["items"].append(el)
        elif el is summary:
            continue

    # ── 目录 ──
    toc_items = []
    for i, ch in enumerate(chapters, 1):
        hid = f"section-{i}"
        ch["h2"]["id"] = hid
        toc_items.append(("2", hid, ch["h2"].get_text(strip=True)))
        for j, it in enumerate(ch["items"], 1):
            if it.name == "h3":
                tid = f"section-{i}-{j}"
                it["id"] = tid
                toc_items.append(("3", tid, it.get_text(strip=True)))

    # ── 摘要区（含指标表 → 指标卡）──
    sum_html = []
    if summary:
        h2 = summary.find("h2")
        badge = summary.find("span", class_="summary-badge")
        sum_html.append('<h2>%s%s</h2>' % (
            h2.get_text(strip=True) if h2 else "执行摘要",
            f' <span class="en">{badge.get_text(strip=True)}</span>' if badge else ""))
        mt = summary.find("table", class_="metric-table")
        if mt:
            stats = []
            for td in mt.select("tbody td"):
                ps = td.find_all("p")
                v = ps[0].get_text(strip=True) if ps else ""
                l = ps[1].get_text(strip=True) if len(ps) > 1 else ""
                stats.append(f'<div class="stat"><span class="v">{v}</span><span class="l">{l}</span></div>')
            cap = mt.find("th")
            sum_html.append('<p class="stats-title">%s</p>' % (cap.get_text(strip=True) if cap else "现状基线"))
            sum_html.append('<div class="stats">%s</div>' % "".join(stats))
            mt.extract()
        for p in summary.find_all("p"):
            cls = p.get("class") or []
            if cls and "summary-header" in cls:
                continue
            strip_lead_nbsp(p)
            sum_html.append(str(p))

    # ── 正文章节 ──
    chap_html = []
    for i, ch in enumerate(chapters, 1):
        buf = [str(ch["h2"])]
        for it in ch["items"]:
            if isinstance(it, NavigableString):
                continue
            if it.name == "table":
                t = BeautifulSoup(str(it), "html.parser").find("table")
                if "metric-table" in (t.get("class") or []):
                    stats = []
                    for td in t.select("tbody td"):
                        ps = td.find_all("p")
                        v = ps[0].get_text(strip=True) if ps else ""
                        l = ps[1].get_text(strip=True) if len(ps) > 1 else ""
                        stats.append(f'<div class="stat"><span class="v">{v}</span><span class="l">{l}</span></div>')
                    cap = t.find("th")
                    buf.append(f'<p class="stats-title">{cap.get_text(strip=True) if cap else "现状一览"}</p>')
                    buf.append(f'<div class="stats">{"".join(stats)}</div>')
                else:
                    t["class"] = ["data"]
                    buf.append(f'<div class="table-wrap">{t}</div>')
            elif it.name == "p":
                cls = it.get("class") or []
                if "callout-info" in cls or "callout-warning" in cls:
                    strip_lead_nbsp(it)
                    kind = "callout warn" if "callout-warning" in cls else "callout"
                    buf.append(f'<div class="{kind}">{it.decode_contents()}</div>')
                elif "doc-footnote" in cls:
                    continue
                else:
                    buf.append(str(it))
            else:
                buf.append(str(it))
        chap_html.append(f'<section class="card chapter" aria-labelledby="section-{i}">{"".join(buf)}</section>')

    toc_lis = "".join(
        f'<li class="lvl-{lvl}"><a href="#{i}">{t}</a></li>' for lvl, i, t in toc_items
    )
    meta_html = "".join(
        f'<div><b>{m.split("：", 1)[0]}：</b>{m.split("：", 1)[1]}</div>' if "：" in m else f"<div>{m}</div>"
        for m in metas
    )
    foot_order = ("编制单位", "文档版本", "编制日期")
    foot_parts = []
    for key in foot_order:
        for m in metas:
            if m.startswith(key):
                foot_parts.append(m)
                break
    foot = "　|　".join(foot_parts)

    summary_block = (
        f'<section class="summary" aria-labelledby="summary-title">{"".join(sum_html)}</section>'
        if sum_html else ""
    )

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="DataForge 项目计划书 · 静态网页版">
<meta name="description" content="{title}：桌面端一体化开发环境、平台服务中台、Spark 与 Flink 写入合规网关">
<title>{title}</title>
<style>{CSS}</style>
</head>
<body id="top">
<a class="skip" href="#main">跳到正文</a>

<header class="hero">
  <div class="hero-inner">
    <p class="hero-cat">{cat}</p>
    <h1 class="hero-title">{title}</h1>
    <p class="hero-sub">{sub}</p>
    <div class="hero-meta">{meta_html}</div>
  </div>
</header>

<div class="layout">
  <aside class="sidebar">
    <button class="toc-toggle" id="tocToggle" aria-expanded="false" aria-controls="toc">目录<span aria-hidden="true">▾</span></button>
    <nav class="toc" id="toc" aria-label="文档目录">
      <p class="toc-head">目录</p>
      <ol>{toc_lis}</ol>
    </nav>
  </aside>

  <main id="main">
    {summary_block}
    {"".join(chap_html)}
    <p class="doc-end">{foot}</p>
  </main>
</div>

<a class="totop" href="#top" title="回到顶部" aria-label="回到顶部">↑</a>
<script>{JS}</script>
</body>
</html>
"""
    # 剥掉 docx 专用的行内首行缩进（18pt），让网页版 CSS 的 2em 生效
    html = html.replace(' style="text-indent:18pt"', "")
    OUT.write_text(html, encoding="utf-8")
    return html, chapters, toc_items


html, chapters, toc = build()
print(f"输出: {OUT}")
print(f"字节: {len(html.encode('utf-8'))}")
print(f"章节: {len(chapters)}  目录条目: {len(toc)}")
ext = re.findall(r'(?:src|href)\s*=\s*["\'](https?://[^"\']+)', html)
print("外部资源引用:", ext or "无（完全自包含）")
print("残留 nbsp 前导:", html.count("&nbsp;&nbsp;"))
