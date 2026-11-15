/**
 * 作用域票据、通道归属校验、能力表与证据落盘。
 *
 * 规则（与 task-diag 同构，但作用域主体是 `analysisType` 而不是 `engine`）：
 * - 任何网络请求之前先 `assertChannel`：未登记 → A09；未纳管 → A10；不在白名单 → A04；
 * - 证据包按 `channelKey` 幂等落盘，同一键只写一次；
 * - 跨类型不允许复用 `.diag` 的票据或键（目录、前缀、键前缀都不同）。
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { channelKeyOf } from "../../shared/lib/channel"
import { nowIso, readJson, writeJsonAtomic } from "../../shared/lib/io"
import {
  CODES,
  LIMITS,
  REQUIRED_CHANNELS,
  STATE_DIR,
  channelById,
  evidenceDir,
  findingsPath,
  reportDir,
  runDir,
  scopePath,
  type AnalysisType,
  type ChannelSpec,
} from "./constants"
import { aError } from "./client"
import {
  CapabilitiesSchema,
  EvidencePackSchema,
  ScopeSchema,
  type Capabilities,
  type EvidencePack,
  type IndicatorRef,
  type Scope,
  type Target,
  type TimeRange,
} from "./schema"

export type BuildScopeInput = {
  analysisType: AnalysisType
  target: Target
  timeRange?: TimeRange
  indicators?: IndicatorRef[]
  maxQueries?: number
  maxRows?: number
}

function newRunId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14)
  const suffix = crypto.randomBytes(2).toString("hex")
  return `${stamp}-${suffix}`
}

function allowedChannelsFor(analysisType: AnalysisType): string[] {
  const required = REQUIRED_CHANNELS[analysisType] ?? []
  // 未纳管的通道仍然写进白名单：能力表要能如实展示「有这条通道但不可用」，
  // 真正拒绝发生在 assertChannel（先判 unmanaged，再判越权）。
  return [...new Set(required)]
}

export function buildScope(root: string, input: BuildScopeInput): { scope: Scope; scopePath: string } {
  const runId = newRunId()
  const scope = ScopeSchema.parse({
    runId,
    analysisType: input.analysisType,
    target: input.target,
    timeRange: input.timeRange,
    indicators: input.indicators ?? [],
    mode: "analysis",
    allowedChannels: allowedChannelsFor(input.analysisType),
    forbiddenChannels: [],
    budget: {
      maxQueries: input.maxQueries ?? LIMITS.maxQueries,
      maxRows: input.maxRows ?? LIMITS.maxRows,
    },
    createdAt: nowIso(),
  })

  const dir = runDir(root, runId)
  fs.mkdirSync(dir, { recursive: true })
  const file = scopePath(root, runId)
  writeJsonAtomic(file, scope)
  return { scope, scopePath: file }
}

type ScopeSchemaType = Scope

export function loadScope(root: string, runId: string): Scope {
  const raw = readJson<unknown>(scopePath(root, runId))
  if (!raw) {
    throw aError(CODES.SCHEMA_INVALID, `未找到 scope.json（runId=${runId}）。请先调用 ana_capabilities 建立运行。`)
  }
  const parsed = ScopeSchema.safeParse(raw)
  if (!parsed.success) {
    throw aError(
      CODES.SCHEMA_INVALID,
      `scope.json 不合法：${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    )
  }
  return parsed.data
}

/** 通道归属校验：必须在任何网络请求之前调用。 */
export function assertChannel(scope: ScopeSchemaType, channelId: string): ChannelSpec {
  const spec = channelById(channelId)
  if (!spec) {
    throw aError(CODES.CHANNEL_UNAVAILABLE, `未登记的通道：${channelId}（可用通道由能力表给出）`)
  }
  if (spec.status === "unmanaged") {
    throw aError(
      CODES.CHANNEL_UNMANAGED,
      `通道 ${spec.id} 尚未纳入分析作用域（unmanaged）：无 scope、无幂等、结论不可复核。`,
      { channelId: spec.id, requirements: spec.requirements, neededInterface: "B-01" },
    )
  }
  if (scope.forbiddenChannels.includes(spec.id)) {
    throw aError(CODES.CHANNEL_FORBIDDEN, `通道 ${spec.id} 被本次运行显式禁用。`, { channelId: spec.id })
  }
  if (!scope.allowedChannels.includes(spec.id)) {
    throw aError(
      CODES.CHANNEL_FORBIDDEN,
      `通道 ${spec.id} 不在分析类型 ${scope.analysisType} 的授权范围内。不得跨类型取数。`,
      { analysisType: scope.analysisType, channelId: spec.id, allowed: scope.allowedChannels },
    )
  }
  return spec
}

/** 所有权矩阵：只有声明过该通道的 agent 才能写证据。 */
export function assertOwner(spec: ChannelSpec, owner: string): void {
  if (!spec.owners.includes(owner)) {
    throw aError(CODES.CHANNEL_FORBIDDEN, `agent ${owner} 没有通道 ${spec.id} 的所有权。`, {
      channelId: spec.id,
      owner,
      allowedOwners: spec.owners,
    })
  }
}

/** 生成幂等键；格式复用 task-diag 的 `channelKeyOf`。 */
export function channelKeyFor(input: {
  channelId: string
  serviceType?: string
  componentId?: string
  hostId?: string
  dataTypeId?: string
  stream?: string
  ref?: Record<string, string>
}): string {
  return channelKeyOf({
    serviceType: input.serviceType || input.channelId,
    componentId: input.componentId || "analysis",
    hostId: input.hostId || "cluster",
    dataTypeId: input.dataTypeId || input.channelId,
    stream: input.stream || "v1",
    ref: input.ref,
  })
}

export type SaveEvidenceResult = { path: string; reused: boolean }

/** 证据包落盘：同 `step + channelKey` 只写一次。 */
export function saveEvidencePack(
  root: string,
  runId: string,
  step: string,
  pack: EvidencePack,
  channelKey: string,
): SaveEvidenceResult {
  const parsed = EvidencePackSchema.safeParse(pack)
  if (!parsed.success) {
    throw aError(
      CODES.SCHEMA_INVALID,
      `证据包不合法：${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    )
  }
  const dir = evidenceDir(root, runId)
  fs.mkdirSync(dir, { recursive: true })
  const hash = crypto.createHash("sha1").update(channelKey).digest("hex").slice(0, 12)
  const safeStep = step.replace(/[^a-zA-Z0-9._-]/g, "-")
  const file = `${dir}/${safeStep}-${hash}.json`
  if (fs.existsSync(file)) return { path: file.replace(`${root}/`, ""), reused: true }
  writeJsonAtomic(file, parsed.data)
  return { path: file.replace(`${root}/`, ""), reused: false }
}

export function loadFindings(root: string, runId: string): unknown | null {
  return readJson<unknown>(findingsPath(root, runId))
}

export function listEvidencePacks(root: string, runId: string): EvidencePack[] {
  const dir = evidenceDir(root, runId)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      const raw = readJson<unknown>(path.join(dir, name))
      const parsed = EvidencePackSchema.safeParse(raw)
      return parsed.success ? [parsed.data] : []
    })
}

/** 能力表：可用性 = 通道已纳管 && 已注入 API 地址。 */
export function buildCapabilities(scope: Scope, apiAvailable: boolean, agent: string): Capabilities {
  const channels = scope.allowedChannels.map((id) => {
    const spec = channelById(id)
    if (!spec) {
      return {
        id,
        label: id,
        contract: "unmanaged-execution" as const,
        status: "unmanaged" as const,
        usable: false,
        owners: [],
        requirements: ["未登记通道：请检查 constants 的 CHANNELS"],
      }
    }
    const usable = spec.status === "available" && apiAvailable
    return {
      id: spec.id,
      label: spec.label,
      contract: spec.contract,
      status: spec.status,
      usable,
      owners: spec.owners,
      requirements: usable
        ? []
        : apiAvailable
          ? spec.requirements
          : ["未注入 DATAFORGE_API_HOST，无法访问 dataforge-server"],
    }
  })

  const missing = channels.filter((channel) => !channel.usable).flatMap((channel) => channel.requirements || [])

  return CapabilitiesSchema.parse({
    runId: scope.runId,
    analysisType: scope.analysisType,
    agent,
    apiAvailable,
    channels,
    missing: [...new Set(missing)],
    createdAt: nowIso(),
  })
}

export function saveCapabilities(root: string, capabilities: Capabilities): string {
  const dir = path.join(runDir(root, capabilities.runId))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "capabilities.json")
  writeJsonAtomic(file, capabilities)
  return file.replace(`${root}/`, "")
}

/** 确保产物目录存在（写报告前调用）。 */
export function ensureReportDir(root: string, runId: string): string {
  const dir = reportDir(root, runId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export { STATE_DIR }
