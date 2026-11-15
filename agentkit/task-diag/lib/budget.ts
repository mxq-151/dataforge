/**
 * 预算记账：调用次数与扫描字节。
 *
 * 设计要点：
 * - 每个 run 一份 `.diag/runs/<runId>/budget.json`，编排器与引擎 agent 共用同一份，
 *   因此「引擎 agent 重复取数」会直接吃掉自己的额度，成本反馈是即时的；
 * - 超限不是告警而是**硬失败**（D05_BUDGET_EXHAUSTED），迫使流程收敛为"证据不足"；
 * - 读改写走 shared/lib/io 的写锁事务，避免并发覆盖。
 */
import { readJson, updateJson, nowIso } from "../../shared/lib/io"
import { BUDGET, CODES, budgetPath } from "./constants"
import { diagError } from "./http"

export type BudgetCost = { calls?: number; bytes?: number }

export type BudgetState = {
  runId: string
  limit: { calls: number; bytes: number }
  used: { calls: number; bytes: number }
  updatedAt: string
  trail: { at: string; label: string; calls: number; bytes: number }[]
}

function stateOf(runId: string): BudgetState {
  return {
    runId,
    limit: { calls: BUDGET.totalCalls, bytes: BUDGET.scanBytes },
    used: { calls: 0, bytes: 0 },
    updatedAt: nowIso(),
    trail: [],
  }
}

export function initBudget(
  root: string,
  runId: string,
  limit?: { calls?: number; bytes?: number },
): BudgetState {
  const existing = readJson<BudgetState>(budgetPath(root, runId))
  if (existing) return existing
  const next: BudgetState = {
    ...stateOf(runId),
    limit: {
      calls: limit?.calls ?? BUDGET.totalCalls,
      bytes: limit?.bytes ?? BUDGET.scanBytes,
    },
  }
  updateJson<BudgetState>(budgetPath(root, runId), () => next)
  return next
}

export function peekBudget(root: string, runId: string): BudgetState {
  return readJson<BudgetState>(budgetPath(root, runId)) ?? stateOf(runId)
}

export type SpendResult = {
  state: BudgetState
  remaining: { calls: number; bytes: number }
}

/** 扣减预算；超限抛 D05，且不写入任何扣减（保持账实一致）。 */
export function spend(
  root: string,
  runId: string,
  cost: BudgetCost,
  label: string,
): SpendResult {
  const calls = Math.max(0, Math.trunc(cost.calls ?? 0))
  const bytes = Math.max(0, Math.trunc(cost.bytes ?? 0))

  let exhausted: { calls: number; bytes: number; limit: BudgetState["limit"] } | null = null

  const result = updateJson<BudgetState>(budgetPath(root, runId), (current) => {
    const base = current ?? stateOf(runId)
    const nextCalls = base.used.calls + calls
    const nextBytes = base.used.bytes + bytes
    if (nextCalls > base.limit.calls || nextBytes > base.limit.bytes) {
      exhausted = { calls: nextCalls, bytes: nextBytes, limit: base.limit }
      return undefined
    }
    const trail = [...base.trail, { at: nowIso(), label, calls, bytes }].slice(-40)
    return {
      ...base,
      used: { calls: nextCalls, bytes: nextBytes },
      updatedAt: nowIso(),
      trail,
    }
  })

  if (exhausted) {
    const hit = exhausted as { calls: number; bytes: number; limit: BudgetState["limit"] }
    throw diagError(
      CODES.BUDGET_EXHAUSTED,
      `预算耗尽：本次需要累计 ${hit.calls} 次调用 / ${hit.bytes} 字节，上限为 ${hit.limit.calls} 次 / ${hit.limit.bytes} 字节。请停止取证并输出「证据不足」。`,
    )
  }

  const state = result.value ?? stateOf(runId)
  return {
    state,
    remaining: {
      calls: Math.max(0, state.limit.calls - state.used.calls),
      bytes: Math.max(0, state.limit.bytes - state.used.bytes),
    },
  }
}

export function budgetSummary(state: BudgetState): {
  callsUsed: number
  callsLimit: number
  bytesUsed: number
  bytesLimit: number
  callsLeft: number
  bytesLeft: number
  exhausted: boolean
} {
  const callsLeft = Math.max(0, state.limit.calls - state.used.calls)
  const bytesLeft = Math.max(0, state.limit.bytes - state.used.bytes)
  return {
    callsUsed: state.used.calls,
    callsLimit: state.limit.calls,
    bytesUsed: state.used.bytes,
    bytesLimit: state.limit.bytes,
    callsLeft,
    bytesLeft,
    exhausted: callsLeft === 0 || bytesLeft === 0,
  }
}
