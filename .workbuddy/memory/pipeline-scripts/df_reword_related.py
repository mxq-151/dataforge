#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把「规范开发环境」的价值主张从『规范且无歧义』改写为『规范且前后相互关联』。

三处源码同步：
  stage1/final_draft.md                      （内容源，真源）
  stage2/formatted-DataForge项目计划书.html   （docx 版式中间产物）
  stage3/DataForge数据开发平台-项目计划书.html （网页交付版）
docx 交付件由 editor_sdk 单独原地替换。
"""
import pathlib
import sys

ROOT = pathlib.Path("/Users/mxq/Desktop/dataforge/output/45d4b135-45a3-447c-86ab-8a2d7ff7a55e")
FILES = [
    ROOT / "stage1" / "final_draft.md",
    ROOT / "stage2" / "formatted-DataForge项目计划书.html",
    ROOT / "stage3" / "DataForge数据开发平台-项目计划书.html",
]

# 顺序敏感：长串先替换，避免短串抢先命中
PAIRS = [
    # 1) 表1 dataforge 一行「在智能体理解业务数据中的角色」
    ("从源头保证开发产生的信息规范且无歧义",
     "从源头保证开发产生的信息规范且前后相互关联", None),
    # 2) 表4 dataforge（桌面端）一行「对智能体理解业务数据的贡献」
    ("保证开发产生的信息规范且无歧义",
     "保证开发产生的信息规范且前后相互关联", None),
    # 3) 1.2 节收口句
    ("保证信息源头无歧义",
     "保证源头信息规范且前后关联", None),
    # 4) 1.3 建设目标·规范开发环境目标
    ("确保开发产生的信息规范且无歧义",
     "确保开发产生的信息规范且前后相互关联", None),
    # 5) 3.2 节五类信息收口句（原文带 <strong> 包裹）
    ("源头是否无歧义", "源头是否规范、前后是否关联", None),
    # 6) 3.2 五类信息表·规范开发环境行「回答的问题」（md 用 " |" 收尾，HTML 用 "</td>"）
    ("命名与口径是否规范 |", "命名与口径是否规范、是否前后关联 |", None),
    ("命名与口径是否规范</td>", "命名与口径是否规范、是否前后关联</td>", None),
    # 7) 决策二补一句，把「关联」落到具体机制上
    ("信息流转之后的补救阶段。",
     "信息流转之后的补救阶段。同步地，代码头参数声明把程序入参与调度任务的参数显式对齐，"
     "使开发阶段产生的信息与上下游环节可以直接衔接——规范解决的是同一件事有没有唯一说法，"
     "关联解决的是这件事与上下游能否对上。", None),
]


def main():
    total = {}
    for f in FILES:
        text = f.read_text(encoding="utf-8")
        orig = text
        hits = []
        for old, new, _ in PAIRS:
            n = text.count(old)
            if n:
                text = text.replace(old, new)
                hits.append(f"{n}x {old[:22]}…")
        if text == orig:
            print(f"!! 未命中任何替换: {f.name}")
            return 1
        f.write_text(text, encoding="utf-8")
        total[f.name] = hits
        for h in hits:
            print(f"  [{f.name}] {h}")

    # 校验：三份文件里不该再残留「规范开发环境」语境的旧表述
    leftovers = ["从源头保证开发产生的信息规范且无歧义",
                 "保证信息源头无歧义",
                 "源头是否无歧义"]
    bad = 0
    for f in FILES:
        t = f.read_text(encoding="utf-8")
        for s in leftovers:
            if s in t:
                print(f"!! 残留 {s} @ {f.name}")
                bad += 1
    print("残留检查:", "OK" if not bad else f"{bad} 处")
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
