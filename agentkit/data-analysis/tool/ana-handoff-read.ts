import { tool } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { CODES, LIMITS } from "../lib/constants"
import { aError, toolError, toolOk, toolFail } from "../lib/client"
import { loadScope } from "../lib/scope"

/**
 * 只读读取 T5（任务诊断）产出的 handoff。
 *
 * 边界（设计文档 §3.9）：
 * - 只能读 `.diag/runs/<sourceRunId>/handoff/<fromEngine>.json`；
 * - handoff 不是证据，不能进入 `claims[]`，只能作为线索，由本类型重新取证；
 * - 不写入、不修改、不跨目录读取；路径做白名单与 `..` 校验。
 */
export default tool({
  description:
    "只读诊断 handoff（T5 → T6 的单向线索）。返回摘要，不返回原始日志；handoff 不是证据，引用前必须用本类型通道重新取证。",
  args: {
    runId: z.string().min(1).describe("本次分析 runId"),
    sourceRunId: z.string().min(1).describe("诊断 runId（T5）"),
    fromEngine: z.string().min(1).default("spark").describe("handoff 来源引擎，例如 spark"),
  },
  async execute(args, context) {
    try {
      const root = context.directory || context.worktree || process.cwd()
      loadScope(root, args.runId)

      if (!/^[A-Za-z0-9._-]+$/.test(args.sourceRunId) || !/^[a-zA-Z0-9._-]+$/.test(args.fromEngine)) {
        throw aError(CODES.SCHEMA_INVALID, "sourceRunId / fromEngine 含非法字符")
      }

      const handoffRoot = path.resolve(root, ".diag", "runs", args.sourceRunId, "handoff")
      const file = path.resolve(handoffRoot, `${args.fromEngine}.json`)
      if (!file.startsWith(`${handoffRoot}${path.sep}`) && file !== handoffRoot) {
        throw aError(CODES.WRITE_FORBIDDEN, "handoff 路径越界")
      }

      if (!fs.existsSync(file)) {
        return toolFail(CODES.HANDOFF_UNAVAILABLE, `未找到 handoff：.diag/runs/${args.sourceRunId}/handoff/${args.fromEngine}.json`, {
          requirements: [
            "确认诊断 runId 是否正确",
            "T5 当前未实现 handoff 产出：需要先由诊断类型生成只读 handoff",
          ],
        })
      }

      const size = fs.statSync(file).size
      if (size > LIMITS.handoffBytes) {
        return toolFail(CODES.HANDOFF_UNAVAILABLE, `handoff 文件过大（${size} 字节），拒绝加载`, {
          requirements: [`handoff 需裁剪到 ${LIMITS.handoffBytes} 字节以内`],
        })
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"))
      } catch {
        throw aError(CODES.SCHEMA_INVALID, "handoff 不是合法 JSON")
      }

      const data = (parsed ?? {}) as Record<string, unknown>
      return toolOk({
        source: file.replace(`${root}/`, ""),
        usage: "lead-only",
        summary: {
          engine: data.engine ?? args.fromEngine,
          verdict: data.verdict ?? null,
          dataSuspects: data.dataSuspects ?? data.handoff ?? null,
          gaps: data.gaps ?? [],
        },
        warning: "handoff 只是线索，不是证据：不得写入 claims[]，必须用本类型的遥测或受控查询重新取证",
      })
    } catch (error) {
      return toolError(error)
    }
  },
})
