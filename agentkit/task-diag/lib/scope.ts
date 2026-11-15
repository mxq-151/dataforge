/**
 * 作用域票据 + 证据持久化。
 *
 * 为什么这两件事放在同一个文件：
 * 「谁能取哪条通道」与「同一通道只落一次盘」是同一个不变量的两面，
 * 拆到两个文件必然出现两套 channelKey 计算，最终互相漂移。
 *
 * 为什么不能只靠 frontmatter 的 tools 白名单：
 * - 已安装 @opencode-ai/sdk 的 `AgentConfig.tools` 是 `Record<string, boolean>`
 *   （见 node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts），语义是启用/禁用，
 *   不是 allowlist；新增工具默认可用，因此它只能当第一层；
 * - 真正的硬保证是本文件的 assertChannel：纯本地读文件，不依赖 opencode 版本。
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { diagError } from "./http"
import {
  CODES,
  DIAG_DIR,
  channelTripleOf,
  channelsOf,
  evidenceDir,
  handoffPath,
  isSafeRunId,
  ownerEngineOfChannel,
  scopePath,
} from "./constants"
import { EvidencePackSchema, ScopeSchema, type EvidencePack, type Scope, type Target } from "./schema"
import { readJson, writeJsonAtomic, nowIso } from "../../shared/lib/io"


export function ensureRunId(runId: string): string {
  if (!isSafeRunId(runId)) {
    throw diagError(CODES.SCOPE_DENIED, `非法 runId：${runId}（只允许字母数字下划线连字符，6–64 位）`)
  }
  return runId
}

export function loadScope(root: string, runId: string): Scope {
  ensureRunId(runId)
  const raw = readJson<unknown>(scopePath(root, runId))
  if (!raw) {
    throw diagError(CODES.SCOPE_DENIED, `未找到作用域票据：runId=${runId}。请先由编排器建立运行（diag_capabilities）。`)
  }
  const parsed = ScopeSchema.safeParse(raw)
  if (!parsed.success) {
    throw diagError(
      CODES.SCHEMA,
      `作用域票据不合法：${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    )
  }
  return parsed.data
}

export function saveScope(root: string, scope: Scope): void {
  writeJsonAtomic(scopePath(root, scope.runId), ScopeSchema.parse(scope))
}

/** 引擎匹配校验：引擎 agent 只能处理自己引擎的运行。 */
export function assertEngine(scope: Scope, engine: string): void {
  if (scope.engine !== engine) {
    throw diagError(CODES.SCOPE_DENIED, `本次运行属于 ${scope.engine}，拒绝处理 ${engine}`)
  }
}

/**
 * 通道校验：
 * 1) 命中 forbiddenChannels → D10（能力表已判定不可用）；
 * 2) 三元组不属于本引擎画像 → D04（跨引擎越权）；
 * 3) 不在 allowedChannels → D10（本引擎通道，但本次运行未授权，通常是配置未就绪）。
 */
export function assertChannel(
  scope: Scope,
  channel: { serviceType: string; logKind: string; componentRole: string },
): void {
  const triple = channelTripleOf(channel)

  const forbidden = scope.forbiddenChannels.find((item) => item.channelKey === triple)
  if (forbidden) {
    throw diagError(CODES.CHANNEL_UNAVAILABLE, `通道不可用：${triple}（${forbidden.reason}）`)
  }

  const owner = ownerEngineOfChannel(triple)
  if (owner && owner !== scope.engine) {
    throw diagError(CODES.SCOPE_DENIED, `通道 ${triple} 属于 ${owner}，本次运行是 ${scope.engine}，拒绝访问`)
  }

  const allowed = scope.allowedChannels.some(
    (item) =>
      item.serviceType === channel.serviceType &&
      item.logKind === channel.logKind &&
      item.componentRole === channel.componentRole,
  )
  if (!allowed) {
    throw diagError(
      CODES.CHANNEL_UNAVAILABLE,
      `通道未在本次运行的作用域内：${triple}；已授权：${
        scope.allowedChannels.map((item) => channelTripleOf(item)).join("、") || "（空）"
      }`,
    )
  }
}

/** 由引擎画像 + 实际可用通道 id 构造作用域。 */
export function buildScope(input: {
  runId: string
  engine: string
  mode: "FAILED" | "SLOW"
  target: Target | null
  availableChannelIds: string[]
  unavailable: { id: string; reason: string }[]
  calls: number
}): Scope {
  const channels = channelsOf(input.engine)
  const unavailableIds = new Set(input.unavailable.map((item) => item.id))
  const allowed = channels
    .filter((channel) => input.availableChannelIds.includes(channel.id) && !unavailableIds.has(channel.id))
    .map((channel) => ({
      serviceType: channel.serviceType,
      logKind: channel.logKind,
      componentRole: channel.componentRole,
      refKey: channel.refKey,
      label: channel.label,
    }))

  const forbidden = channels
    .filter((channel) => !allowed.some((item) => channelTripleOf(item) === channelTripleOf(channel)))
    .map((channel) => ({
      channelKey: channelTripleOf(channel),
      reason: input.unavailable.find((item) => item.id === channel.id)?.reason ?? "能力表未标记为可用",
    }))

  return {
    runId: input.runId,
    engine: input.engine,
    mode: input.mode,
    createdAt: nowIso(),
    target: input.target,
    allowedChannels: allowed,
    forbiddenChannels: forbidden,
    budget: { calls: input.calls, scanBytes: 4 * 1024 * 1024 },
  }
}

// ── 证据持久化 ──────────────────────────────────────────────────────────
export function evidenceKey(channelKey: string): string {
  return crypto.createHash("sha1").update(channelKey).digest("hex").slice(0, 10)
}

export function evidenceFileName(step: string, key: string): string {
  return `${sanitizeStep(step)}-${evidenceKey(key)}.json`
}

function sanitizeStep(step: string): string {
  return step.replace(/[^0-9A-Za-z_-]/g, "_").slice(0, 40) || "step"
}

export type SavePackResult = { path: string; reused: boolean; bytes: number }

/**
 * 幂等落盘：同一 dedupeKey 已存在时直接复用，不再重复取数。
 * 返回值里的 path 是相对工作区的路径，便于写进 findings 与报告。
 */
export function saveEvidencePack(
  root: string,
  runId: string,
  step: string,
  pack: unknown,
  dedupeKey: string,
): SavePackResult {
  const parsed = EvidencePackSchema.safeParse(pack)
  if (!parsed.success) {
    throw diagError(
      CODES.SCHEMA,
      `证据包不合法：${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    )
  }
  const dir = evidenceDir(root, runId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, evidenceFileName(step, dedupeKey))
  const relative = path.relative(root, file)

  if (fs.existsSync(file)) {
    const existing = readJson<EvidencePack>(file)
    return { path: relative, reused: true, bytes: existing ? Buffer.byteLength(JSON.stringify(existing)) : 0 }
  }

  writeJsonAtomic(file, parsed.data)
  return { path: relative, reused: false, bytes: Buffer.byteLength(JSON.stringify(parsed.data)) }
}

// ── 交接包（Hudi 复用 Spark）────────────────────────────────────────────
/**
 * 切缝：作业侧证据（YARN/Spark 日志、Spark 指标）归 spark agent，且只取一次；
 * hudi agent 不调用任何日志/指标工具，只读 spark 写下的交接包，补充 Hudi 侧缺口。
 */
export function saveHandoff(root: string, runId: string, fromEngine: string, payload: unknown): string {
  const file = handoffPath(root, runId, fromEngine)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeJsonAtomic(file, { runId, fromEngine, createdAt: nowIso(), ...(payload as Record<string, unknown>) })
  return path.relative(root, file)
}

export function readHandoff<T = Record<string, unknown>>(root: string, runId: string, fromEngine: string): T | null {
  return readJson<T>(handoffPath(root, runId, fromEngine))
}

/** 确认工作区根目录存在，避免工具在错误的 cwd 下落盘。 */
export function assertWorkspace(root: string): void {
  if (!root || !fs.existsSync(root)) {
    throw diagError(CODES.WRITE_FORBIDDEN, `工作区目录不存在：${root || "(空)"}`)
  }
  if (root.includes(`${path.sep}${DIAG_DIR}${path.sep}`)) {
    throw diagError(CODES.WRITE_FORBIDDEN, "工作区根目录不能位于 .diag 内部")
  }
}
