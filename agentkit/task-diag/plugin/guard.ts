/**
 * 写盘闸：只允许写 diagnosis/ 与 .diag/，其余一律拒绝。
 *
 * 与 req-doc / dw-dev 的 guard 同机制，但允许目录不同：
 * 诊断不得污染需求文档、DDL、代码目录。
 *
 * 注意：这是"防误写"的最后一道，不负责防越权取数——取数的防线在 lib/scope.ts。
 */
import type { Plugin } from "@opencode-ai/plugin"
import path from "node:path"

const ALLOWED_DIRS = ["diagnosis", ".diag"]
const WRITE_TOOLS = new Set(["write", "edit", "patch", "apply_patch", "multiedit"])

function normalize(input: unknown): string {
  if (typeof input === "string") return input
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>
    for (const key of ["filePath", "path", "file_path", "target"]) {
      const value = record[key]
      if (typeof value === "string") return value
    }
  }
  return ""
}

function isAllowed(root: string, target: string): boolean {
  if (!target) return false
  const absolute = path.isAbsolute(target) ? target : path.resolve(root, target)
  const relative = path.relative(root, absolute)
  if (relative.startsWith("..")) return false
  const first = relative.split(path.sep)[0]
  return ALLOWED_DIRS.includes(first)
}

export default (async ({ directory }) => {
  return {
    "tool.execute.before": async (input: { tool: string; args?: unknown }, output?: { args?: unknown }) => {
      if (!WRITE_TOOLS.has(input.tool)) return
      const args = (output?.args ?? input.args ?? {}) as Record<string, unknown>
      const target = normalize(args)
      if (!isAllowed(directory, target)) {
        throw new Error(
          `[D08_WRITE_FORBIDDEN] task-diag 只允许写 diagnosis/ 与 .diag/，拒绝写入：${target || "(未提供路径)"}`,
        )
      }
    },
  }
}) satisfies Plugin
