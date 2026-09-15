# -*- coding: utf-8 -*-
"""stage1/final_draft.md -> stage2/formatted-*.html（打印版，可再转 docx）。

用法：python df_gen_stage2.py <md_path> <out_html> [css_path]
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from df_md import build_stage2  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    md_path = sys.argv[1]
    out_path = sys.argv[2]
    css_path = sys.argv[3] if len(sys.argv) > 3 else os.path.join(HERE, 'stage2.css')
    md = io.open(md_path, encoding='utf-8').read()
    css = io.open(css_path, encoding='utf-8').read()
    html = build_stage2(md, css)
    io.open(out_path, 'w', encoding='utf-8').write(html)
    print('stage2 ->', out_path, len(html), 'chars')


if __name__ == '__main__':
    main()
