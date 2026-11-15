/**
 * 写盘强制闸（R17）：拦截模型对 docs/*_开发需求.md 的直接写入。
 *
 * 分工：
 * - finalize-doc 负责「内容是否合格 + 如何增量合并 + 原子落盘」（R16）。它用 node:fs 写，不经过 write 工具。
 * - guard 负责「谁都不许绕过 finalize-doc 直接写」（R17）。它拿不到调用者身份，只能按目标路径判定，
 *   因此对 write / edit / apply_patch / shell 重定向一律拦截，并把 Markdown 校验结果附在错误里，
 *   让模型一次就拿到可执行的下一步。
 *
 * 注意：hook 内 throw 会让本次工具调用失败，错误文本会作为工具结果回传给模型。
 * 未捕获异常的包装方式需按你的 opencode 版本确认（本机 1.19.5 为 plugin.trigger 内直接失败）。
 */
import type { Plugin } from "@opencode-ai/plugin"
import { DOC_SUFFIX, ruleOf } from "../lib/constants"
import { compactIssues, hasError, validateMarkdown } from "../lib/md-validator"

const TARGET_PATTERN = new RegExp(`${DOC_SUFFIX.replace(".", "\\.")}$`)
const PATCH_PATTERN = new RegExp(DOC_SUFFIX.replace(".", "\\."))
const SHELL_WRITE = /(^|\s)(>|>>|tee|mv|cp|sed\s+-i|truncate)\s*/

function buildError(target: string | null, content: string | null): Error {
  const rule = ruleOf("R17")
  const lines = [
    `[${rule.code}] 禁止直接写入需求文档：${target ?? "docs/*_开发需求.md"}`,
    "唯一合法写盘路径是 finalize-doc（渲染 → R01–R07/R10/R15 校验 → A/B 与 C 类门禁 → 增量合并 → 原子写盘）。",
    "如需修改内容：第 1/2/4~9 章用 submit-chapter，第 3 章用 submit-metrics-batch，然后重新调用 finalize-doc。",
  ]
  if (content) {
    const issues = validateMarkdown(content)
    if (hasError(issues)) {
      lines.push(`本次内容 Markdown 校验不通过：${compactIssues(issues).join(" / ")}`)
    } else {
      lines.push("本次内容满足 Markdown 校验，但仍须走 finalize-doc 以保证增量合并不覆盖已有内容。")
    }
  }
  return new Error(lines.join("\n"))
}

const server: Plugin = async (input) => {
  void input
  return {
    "tool.execute.before": async (event, output) => {
      const args = (output?.args ?? {}) as Record<string, any>

      if (event.tool === "write" || event.tool === "edit") {
        const target: string | undefined = args.filePath
        if (!target || !TARGET_PATTERN.test(target)) return
        const content = event.tool === "write" ? args.content : args.newString
        throw buildError(target, typeof content === "string" ? content : null)
      }

      if (event.tool === "apply_patch") {
        const patch = String(args.patchText ?? "")
        if (PATCH_PATTERN.test(patch)) throw buildError(null, null)
        return
      }

      if (event.tool === "bash" || event.tool === "shell") {
        const command = String(args.command ?? "")
        if (PATCH_PATTERN.test(command) && SHELL_WRITE.test(command)) throw buildError(null, null)
        return
      }
    },
  }
}

export default { id: "doc-guard", server }
