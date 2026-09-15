#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""删除第七章「风险识别与应对」，并把后续章节重编号（八→七、九→八、十→九）及其交叉引用同步。"""
import pathlib
import sys

MD = pathlib.Path("/Users/mxq/Desktop/dataforge/output/45d4b135-45a3-447c-86ab-8a2d7ff7a55e"
                  "/stage1/final_draft.md")

# 顺序敏感：先删章，再按 八→七、九→八、十→九 的升序重编号，避免互相覆盖
HEADINGS = [("## 八、", "## 七、"), ("## 九、", "## 八、"), ("## 十、", "## 九、")]

SUBSECTIONS = [
    ("### 8.1 ", "### 7.1 "),
    ("### 8.2 ", "### 7.2 "),
    ("### 8.3 ", "### 7.3 "),
    ("### 8.4 ", "### 7.4 "),
    ("### 8.5 ", "### 7.5 "),
    ("### 9.1 ", "### 8.1 "),
]

# 内联引用必须整串替换，禁止对裸 "8.2" 做正则（会误伤 Hutool 5.8.24 这类版本号）
INLINE = [
    ("见 8.5。", "见 7.5。"),
    ("验收方式（第八章）", "验收方式（第七章）"),
    ("| 已落地 | 8.2 核心链路可用性 + 8.3 质量保障", "| 已落地 | 7.2 核心链路可用性 + 7.3 质量保障"),
    ("| 已落地 / 待深化 | 8.2 接口联调与自检脚本", "| 已落地 / 待深化 | 7.2 接口联调与自检脚本"),
    ("| 已落地（字段级追溯待深化） | 8.2 字段血缘", "| 已落地（字段级追溯待深化） | 7.2 字段血缘"),
    ("第十章附录", "第九章附录"),
    ("按 9.1 的本项目口径度量", "按 8.1 的本项目口径度量"),
]


def main():
    text = MD.read_text(encoding="utf-8")

    start = text.index("## 七、风险识别与应对")
    end = text.index("## 八、验收标准与质量保障")
    removed = text[start:end]
    text = text[:start] + text[end:]
    print(f"已删除第七章：{len(removed)} 字符（{removed.count(chr(10) + '| R')} 条风险）")

    for old, new in HEADINGS + SUBSECTIONS + INLINE:
        n = text.count(old)
        if old.startswith(("## ", "### ")) and n != 1:
            print(f"!! 标题 {old!r} 命中 {n} 次（应为 1）")
            return 1
        text = text.replace(old, new)
        print(f"  {n}x {old.strip()} → {new.strip()}")

    MD.write_text(text, encoding="utf-8")

    # 自检：不该残留任何 8.x / 9.1 / 十章 引用，也不该有 R\d 编号
    bad = []
    for probe in ["8.1", "8.2", "8.3", "8.4", "8.5", "9.1", "第十章", "第八章", "第九章",
                  "风险识别与应对"]:
        if probe in text:
            # 允许出现在与章节无关的上下文（如版本号），逐例打印供人工判断
            for i, line in enumerate(text.split("\n"), 1):
                if probe in line:
                    bad.append(f"{probe} @ L{i}: {line[:80]}")
    print("残留检查:", "OK" if not bad else "")
    for b in bad:
        print("   ", b)
    return 0


if __name__ == "__main__":
    sys.exit(main())
