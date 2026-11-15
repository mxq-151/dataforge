// @vitest-environment node
/**
 * data-analysis 的结构性用例。
 *
 * 覆盖确定性部分：通道矩阵与路由、作用域越权、channelKey 幂等、四态与 A 段错误码、
 * 预算、结论钳制、报告渲染，以及 10 个工具的存在性与 not_implemented 分支。
 *
 * 不覆盖：真实 dataforge-server 联调、真实 Flink/Spark 通道可用性（阶段四单独验证）。
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  ANALYSIS_ROUTES,
  ANALYSIS_TYPES,
  CHANNELS,
  CODES,
  REQUIRED_CHANNELS,
  channelById,
} from "./constants"
import { assertChannel, assertOwner, buildScope, channelKeyFor, loadScope } from "./scope"
import { initBudget, peekBudget, spend } from "./budget"
import { clampAnalysisVerdict, renderReport, reportFromFinding } from "./render"
import { EvidencePackSchema, FindingSchema } from "./schema"
import { channelIdentityOf, channelKeyOf } from "../../shared/lib/channel"

import anaCapabilities from "../tool/ana-capabilities"
import anaQuery from "../tool/ana-query"
import anaRecordEvidence from "../tool/ana-record-evidence"
import anaFinalizeReport from "../tool/ana-finalize-report"
import anaIndicator from "../tool/ana-indicator"
import anaMetadataDetail from "../tool/ana-metadata-detail"

const HERE = path.dirname(new URL(import.meta.url).pathname)
const KIT_ROOT = path.resolve(HERE, "..")
const TOOL_DIR = path.join(KIT_ROOT, "tool")

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-test-"))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function ctx() {
  return { directory: root, worktree: root } as never
}

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>
}

function newScope(type: (typeof ANALYSIS_TYPES)[number] = "runtime") {
  return buildScope(root, { analysisType: type, target: {} }).scope
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn()
    throw new Error("expected throw")
  } catch (error) {
    const err = error as { code?: string }
    expect(err.code).toBe(code)
  }
}

describe("通道矩阵与路由", () => {
  it("7 个 telemetry v1 通道 + metadata 只读通道 + data.query 均已登记", () => {
    const ids = CHANNELS.map((channel) => channel.id)
    for (const id of ["metrics", "logs", "discovery", "runtime.snapshot", "runtime.config", "runtime.compare", "metadata.service"]) {
      expect(ids).toContain(id)
    }
    expect(ids).toContain("metadata.indicator")
    expect(ids).toContain("metadata.table")
    expect(ids).toContain("metadata.retrieval")
    expect(channelById("data.query")?.status).toBe("unmanaged")
  })

  it("每个分析类型都有路由与必需通道，且必需通道都已登记", () => {
    for (const type of ANALYSIS_TYPES) {
      expect(ANALYSIS_ROUTES[type]).toMatch(/^ana-/)
      for (const channelId of REQUIRED_CHANNELS[type]) {
        expect(channelById(channelId), `${type} -> ${channelId}`).toBeTruthy()
      }
    }
  })

  it("data.query 的 requirements 指向 B-01", () => {
    const spec = channelById("data.query")!
    expect(spec.requirements.join(" ")).toContain("B-01")
  })
})

describe("作用域票据与越权", () => {
  it("runtime 类型授权 v1 通道，不授权 data.query", () => {
    const scope = newScope("runtime")
    expect(scope.allowedChannels).toContain("logs")
    expect(scope.allowedChannels).not.toContain("data.query")
    expect(fs.existsSync(path.join(root, ".analysisagent", "runs", scope.runId, "scope.json"))).toBe(true)
  })

  it("未登记通道 → A09", () => {
    const scope = newScope("runtime")
    expectCode(() => assertChannel(scope, "made.up"), CODES.CHANNEL_UNAVAILABLE)
  })

  it("unmanaged 通道 → A10，并带 B-01 requirements", () => {
    const scope = newScope("integrity")
    try {
      assertChannel(scope, "data.query")
      throw new Error("expected throw")
    } catch (error) {
      const err = error as { code?: string; detail?: { requirements?: string[] } }
      expect(err.code).toBe(CODES.CHANNEL_UNMANAGED)
      expect((err.detail?.requirements ?? []).join(" ")).toContain("B-01")
    }
  })

  it("跨类型取数（reconcile 用 logs）→ A04", () => {
    const scope = newScope("reconcile")
    expectCode(() => assertChannel(scope, "logs"), CODES.CHANNEL_FORBIDDEN)
  })

  it("所有权矩阵：ana-trend 不能写 logs", () => {
    const scope = newScope("trend")
    const spec = assertChannel(scope, "metrics")
    expect(() => assertOwner(spec, "ana-profile")).toThrow()
  })

  it("scope.json 缺失 → A06", () => {
    expectCode(() => loadScope(root, "missing-run"), CODES.SCHEMA_INVALID)
  })
})

describe("channelKey 幂等", () => {
  it("ref 顺序不影响幂等键", () => {
    const a = channelKeyFor({ channelId: "logs", ref: { table: "t1", database: "db" } })
    const b = channelKeyFor({ channelId: "logs", ref: { database: "db", table: "t1" } })
    expect(a).toBe(b)
  })

  it("与 shared 的通道身份格式一致", () => {
    const key = channelKeyFor({ channelId: "metrics", serviceType: "flink", componentId: "flink.jobmanager", hostId: "h1" })
    expect(key).toBe(
      channelKeyOf({
        serviceType: "flink",
        componentId: "flink.jobmanager",
        hostId: "h1",
        dataTypeId: "metrics",
        stream: "v1",
      }),
    )
    expect(channelIdentityOf({ serviceType: "flink", componentId: "flink.jobmanager", hostId: "h1", dataTypeId: "metrics", stream: "v1" })).toBe(
      "flink|flink.jobmanager|h1|metrics|v1",
    )
  })

  it("不同通道产生不同键", () => {
    expect(channelKeyFor({ channelId: "logs" })).not.toBe(channelKeyFor({ channelId: "metrics" }))
  })
})

describe("预算", () => {
  it("初始化默认上限，扣减后记账", () => {
    const scope = newScope()
    const initial = initBudget(root, scope.runId)
    expect(initial.used).toEqual({ queries: 0, rows: 0 })
    spend(root, scope.runId, { queries: 2, rows: 10 }, "test")
    const state = peekBudget(root, scope.runId)
    expect(state.used).toEqual({ queries: 2, rows: 10 })
  })

  it("超限抛 A05，且不写入部分扣减", () => {
    const scope = newScope()
    initBudget(root, scope.runId, { queries: 1, rows: 10 })
    expectCode(() => spend(root, scope.runId, { queries: 2 }, "over"), CODES.BUDGET_EXHAUSTED)
    expect(peekBudget(root, scope.runId).used).toEqual({ queries: 0, rows: 0 })
  })
})

describe("结论钳制", () => {
  const base = {
    analysisType: "trend",
    confidence: 0.9,
    hasDataEvidence: false,
    hasIndicator: true,
    truncated: false,
    zeroRows: false,
    claimCount: 1,
  }

  it("无数据证据：L1 → L3", () => {
    expect(clampAnalysisVerdict({ ...base, level: "L1" }).level).toBe("L3")
  })

  it("有数据证据：L1 保持", () => {
    expect(clampAnalysisVerdict({ ...base, level: "L1", hasDataEvidence: true }).level).toBe("L1")
  })

  it("截断：最好只能到 L2（L1 → L2，L3 不变）", () => {
    expect(clampAnalysisVerdict({ ...base, level: "L1", hasDataEvidence: true, truncated: true }).level).toBe("L2")
    expect(clampAnalysisVerdict({ ...base, level: "L3", hasDataEvidence: true, truncated: true }).level).toBe("L3")
  })

  it("空结果：最好只能到 L2（L1 → L2）", () => {
    expect(clampAnalysisVerdict({ ...base, level: "L1", hasDataEvidence: true, zeroRows: true }).level).toBe("L2")
  })

  it("低置信度：最好只能到 L3（L1 → L3）", () => {
    expect(clampAnalysisVerdict({ ...base, level: "L1", hasDataEvidence: true, confidence: 0.4 }).level).toBe("L3")
  })

  it("无 claim：强制 L4 且置信度归零", () => {
    const result = clampAnalysisVerdict({ ...base, level: "L2", claimCount: 0 })
    expect(result.level).toBe("L4")
    expect(result.confidence).toBe(0)
  })

  it("reconcile 无口径引用：最好只能到 L3", () => {
    const result = clampAnalysisVerdict({ ...base, analysisType: "reconcile", hasIndicator: false, level: "L1" })
    expect(result.level).toBe("L3")
  })
})

describe("报告渲染", () => {
  it("包含级别、上限、缺口与口径提示", () => {
    const finding = {
      runId: "r1",
      analysisType: "runtime" as const,
      target: { table: "t1" },
      verdict: { conclusion: "产出晚于基线", confidence: 0.7, level: "L3" as const },
      claims: [{ text: "启动时间推迟 40 分钟", evidenceRefs: ["evidence/a.json"] }],
      evidenceRefs: ["evidence/a.json"],
      rejected: [],
      gaps: [{ code: "B-03", detail: "无分区统计", requirements: [] }],
      indicatorRefs: [],
      unknowns: ["未验证调度侧"],
    }
    const report = reportFromFinding({
      finding,
      level: "L3",
      confidence: 0.7,
      ceiling: "L3",
      ceilingReason: "无数据内容证据",
      evidence: ["analysis/AN-r1/evidence/a.json"],
      unknowns: ["未验证调度侧"],
      title: "测试报告",
      generatedAt: "2026-11-15T00:00:00.000Z",
    })
    const md = renderReport(report)
    expect(md).toContain("**L3**")
    expect(md).toContain("B-03")
    expect(md).toContain("未引用指标口径")
    expect(md).toContain("产出晚于基线")
  })
})

describe("schema 严格校验", () => {
  it("证据包接受最小合法形状", () => {
    const parsed = EvidencePackSchema.safeParse({
      runId: "r1",
      analysisType: "runtime",
      owner: "ana-runtime",
      step: "logs",
      channel: { id: "logs" },
      channelKey: "k",
      scopeTicketId: "r1",
      scan: { bytes: null, bytesUnavailable: true },
      createdAt: "2026-11-15T00:00:00.000Z",
    })
    expect(parsed.success).toBe(true)
  })

  it("证据包拒绝未知字段", () => {
    const parsed = EvidencePackSchema.safeParse({
      runId: "r1",
      analysisType: "runtime",
      owner: "ana-runtime",
      step: "logs",
      channel: { id: "logs" },
      channelKey: "k",
      scopeTicketId: "r1",
      scan: { bytes: null },
      createdAt: "2026-11-15T00:00:00.000Z",
      forged: true,
    })
    expect(parsed.success).toBe(false)
  })

  it("findings 拒绝非法级别", () => {
    const parsed = FindingSchema.safeParse({
      runId: "r1",
      analysisType: "runtime",
      target: {},
      verdict: { conclusion: "x", confidence: 0.5, level: "L9" },
      claims: [],
      evidenceRefs: [],
      rejected: [],
      gaps: [],
      indicatorRefs: [],
      unknowns: [],
    })
    expect(parsed.success).toBe(false)
  })

  it("claim 必须带证据引用", () => {
    const parsed = FindingSchema.safeParse({
      runId: "r1",
      analysisType: "runtime",
      target: {},
      verdict: { conclusion: "x", confidence: 0.5, level: "L3" },
      claims: [{ text: "无证据结论", evidenceRefs: [] }],
      evidenceRefs: [],
      rejected: [],
      gaps: [],
      indicatorRefs: [],
      unknowns: [],
    })
    expect(parsed.success).toBe(false)
  })
})

describe("工具集", () => {
  it("恰好 10 个 ana-* 工具", () => {
    const tools = fs.readdirSync(TOOL_DIR).filter((name) => /^ana-.*\.ts$/.test(name))
    expect(tools.sort()).toEqual(
      [
        "ana-budget.ts",
        "ana-capabilities.ts",
        "ana-finalize-report.ts",
        "ana-handoff-read.ts",
        "ana-indicator.ts",
        "ana-metadata-detail.ts",
        "ana-query.ts",
        "ana-record-evidence.ts",
        "ana-resolve-target.ts",
        "ana-telemetry.ts",
      ].sort(),
    )
  })

  it("ana_capabilities 建立运行并把 data.query 标为不可用", async () => {
    const result = parse(
      await anaCapabilities.execute({ analysisType: "integrity", target: {}, maxQueries: 5, maxRows: 100 }, ctx()),
    )
    expect(result.ok).toBe(true)
    const runId = result.runId as string
    expect(runId).toMatch(/^\d{14}-[0-9a-f]{4}$/)
    const blocked = result.blockedChannels as { id: string; status: string; contract: string }[]
    expect(blocked.some((channel) => channel.id === "data.query" && channel.status === "unmanaged")).toBe(true)
    expect(blocked.find((channel) => channel.id === "data.query")?.contract).toBe("unmanaged-execution")
    expect((result.usableChannels as string[]).includes("data.query")).toBe(false)
    expect(fs.existsSync(path.join(root, ".analysisagent", "runs", runId, "capabilities.json"))).toBe(true)
  })

  it("能力表标注契约来源：v1 / metadata-readonly / unmanaged-execution", async () => {
    const result = parse(await anaCapabilities.execute({ analysisType: "attribution", target: {} }, ctx()))
    const channels = (result.blockedChannels as { id: string; contract: string }[]).concat(
      (result.usableChannels as string[]).map((id) => ({ id, contract: "" })),
    )
    const contractOf = (id: string) => {
      const saved = JSON.parse(
        fs.readFileSync(path.join(root, ".analysisagent", "runs", result.runId as string, "capabilities.json"), "utf8"),
      ) as { channels: { id: string; contract: string }[] }
      return saved.channels.find((channel) => channel.id === id)?.contract
    }
    expect(channels.length).toBeGreaterThan(0)
    expect(contractOf("metrics")).toBe("telemetry-v1")
    expect(contractOf("logs")).toBe("telemetry-v1")
    expect(contractOf("metadata.indicator")).toBe("metadata-readonly")
    expect(contractOf("data.query")).toBe("unmanaged-execution")
  })

  it("子代理可写 findings；错误 owner 被拒（A04）", async () => {
    const scope = newScope("runtime")
    const finding = {
      runId: scope.runId,
      analysisType: "runtime" as const,
      target: {},
      verdict: { conclusion: "产出晚于基线 40 分钟", confidence: 0.8, level: "L1" as const },
      claims: [{ text: "启动延迟", evidenceRefs: ["evidence/logs-abc.json"] }],
      evidenceRefs: ["evidence/logs-abc.json"],
      rejected: [],
      gaps: [],
      indicatorRefs: [],
      unknowns: [],
    }
    const rejected = parse(
      await anaRecordEvidence.execute(
        { runId: scope.runId, kind: "findings", step: "findings", owner: "ana-profile", finding },
        ctx(),
      ),
    )
    expect(rejected.ok).toBe(false)
    expect(rejected.code).toBe(CODES.CHANNEL_FORBIDDEN)

    const written = parse(
      await anaRecordEvidence.execute(
        { runId: scope.runId, kind: "findings", step: "findings", owner: "ana-runtime", finding },
        ctx(),
      ),
    )
    expect(written.ok).toBe(true)
    expect(fs.existsSync(path.join(root, ".analysisagent", "runs", scope.runId, "findings.json"))).toBe(true)
  })

  it("无 findings 且 fallback=true：生成 L4 能力缺口报告", async () => {
    const scope = newScope("integrity")
    const result = parse(await anaFinalizeReport.execute({ runId: scope.runId, fallback: true, reason: "data.query 未纳管" }, ctx()))
    expect(result.ok).toBe(true)
    expect(result.level).toBe("L4")
    const report = fs.readFileSync(path.join(root, "analysis", `AN-${scope.runId}`, "report.md"), "utf8")
    expect(report).toContain("无法判定")
    expect(report).toContain("**L4**")
  })

  it("L1 结论在无数据证据时被钳制为 L3", async () => {
    const scope = newScope("runtime")
    await anaRecordEvidence.execute(
      {
        runId: scope.runId,
        kind: "findings",
        step: "findings",
        owner: "ana-runtime",
        finding: {
          runId: scope.runId,
          analysisType: "runtime",
          target: {},
          verdict: { conclusion: "运行态正常", confidence: 0.9, level: "L1" },
          claims: [{ text: "指标无异常", evidenceRefs: ["evidence/a.json"] }],
          evidenceRefs: ["evidence/a.json"],
          rejected: [],
          gaps: [],
          indicatorRefs: [],
          unknowns: [],
        },
      },
      ctx(),
    )
    const result = parse(await anaFinalizeReport.execute({ runId: scope.runId }, ctx()))
    expect(result.ok).toBe(true)
    expect(result.level).toBe("L3")
    expect(result.ceiling).toBe("L3")
  })

  it("ana_query 固定返回 not_implemented + B-01，不执行任何查询", async () => {
    const scope = newScope("integrity")
    const result = parse(await anaQuery.execute({ runId: scope.runId, purpose: "检查分区是否缺失" }, ctx()))
    expect(result.ok).toBe(false)
    expect(result.code).toBe(CODES.CHANNEL_UNMANAGED)
    expect(result.outcome).toBe("not_implemented")
    expect(result.neededInterface).toBe("B-01")
    expect((result.requirements as string[]).join(" ")).toContain("B-01")
  })

  it("ana_record_evidence 拒绝未登记通道", async () => {
    const scope = newScope("runtime")
    const result = parse(
      await anaRecordEvidence.execute(
        {
          runId: scope.runId,
          step: "manual",
          channelId: "not.registered",
          owner: "ana-runtime",
          stats: [],
          facts: [{ key: "k", value: 1, source: "test" }],
          samples: [],
          gaps: [],
          indicatorRefs: [],
        },
        ctx(),
      ),
    )
    expect(result.ok).toBe(false)
    expect(result.code).toBe(CODES.CHANNEL_UNAVAILABLE)
  })

  it("ana_finalize_report 缺少 findings → A06", async () => {
    const scope = newScope("runtime")
    const result = parse(await anaFinalizeReport.execute({ runId: scope.runId }, ctx()))
    expect(result.ok).toBe(false)
    expect(result.code).toBe(CODES.SCHEMA_INVALID)
  })

  it("ana_indicator 缺 code/id → A14", async () => {
    const scope = newScope("reconcile")
    const result = parse(await anaIndicator.execute({ runId: scope.runId, owner: "ana-indicator" }, ctx()))
    expect(result.ok).toBe(false)
    expect(result.code).toBe(CODES.INDICATOR_UNAVAILABLE)
  })

  it("ana_metadata_detail 在 runtime 作用域下越权 → A04", async () => {
    const scope = newScope("runtime")
    const result = parse(
      await anaMetadataDetail.execute({ runId: scope.runId, database: "db", table: "t", owner: "ana-profile" }, ctx()),
    )
    expect(result.ok).toBe(false)
    expect(result.code).toBe(CODES.CHANNEL_FORBIDDEN)
  })
})
