/**
 * 反向追溯：需求指标 → 指标编码 → 表 → 字段。
 * 查询不到即报 W26，不返回空结果让调用方「自己看着办」。
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { readJson, tracePath } from "../lib/constants"

type Trace = { businessName: string; entries: { code: string; name: string; domain: string; table: string; fields: string[]; datasource: string }[] }

export default tool({
  description: "按指标名称反查设计落地位置（指标编码、表、字段、数据源）。未命中返回 W26_TRACE_MISSING，并给出最接近的名称。",
  args: {
    metricName: z.string().min(1),
  },
  async execute(args, context) {
    const trace = readJson<Trace>(tracePath(context.directory))
    if (!trace) {
      return JSON.stringify({
        ok: false,
        code: "W26_TRACE_MISSING",
        message: "缺少 .dw/trace.json：设计尚未定稿，请先跑 dw-finalize-design",
      })
    }
    const entry = trace.entries.find((item) => item.name === args.metricName)
    if (!entry) {
      const near = trace.entries
        .map((item) => ({ name: item.name, distance: Math.abs(item.name.length - args.metricName.length) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 5)
        .map((item) => item.name)
      return JSON.stringify({
        ok: false,
        code: "W26_TRACE_MISSING",
        metricName: args.metricName,
        candidates: near,
        message: `设计中没有指标「${args.metricName}」，不会用近似名替代；请确认需求指标名或先补齐设计。`,
      })
    }
    return JSON.stringify({ ok: true, ...entry, businessName: trace.businessName })
  },
})
