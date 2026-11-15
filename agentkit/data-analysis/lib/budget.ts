/**
 * 预算记账：查询次数与返回行数。
 *
 * 与 task-diag 的 `calls/bytes` 是**不同语义**，因此不共用其 budget 模块
 * （那套绑定 `.diag` 路径、D05 码与扫描字节）。这里的硬失败是 A05，
 * 读写仍走 `shared/lib/io` 的写锁事务。
 */
import { nowIso, readJson, updateJson } from "../../shared/lib/io"
import { CODES, LIMITS, budgetPath } from "./constants"
import { aError } from "./client"

export type BudgetCost = { queries?: number; rows?: number }

export type BudgetState = {
  runId: string
  limit: { queries: number; rows: number }
  used: { queries: number; rows: number }
  updatedAt: string
  trail: { at: string; label: string; queries: number; rows: number }[]
}

function stateOf(runId: string): BudgetState {
  return {
    runId,
    limit: { queries: LIMITS.maxQueries, rows: LIMITS.maxRows },
    used: { queries: 0, rows: 0 },
    updatedAt: nowIso(),
    trail: [],
  }
}

export function initBudget(
  root: string,
  runId: string,
  limit?: { queries?: number; rows?: number },
): BudgetState {
  const existing = readJson<BudgetState>(budgetPath(root, runId))
  if (existing) return existing
  const next: BudgetState = {
    ...stateOf(runId),
    limit: {
      queries: limit?.queries ?? LIMITS.maxQueries,
      rows: limit?.rows ?? LIMITS.maxRows,
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
  remaining: { queries: number; rows: number }
}

/** 扣减预算；超限抛 A05，且不写入任何扣减（保持账实一致）。 */
export function spend(root: string, runId: string, cost: BudgetCost, label: string): SpendResult {
  const queries = Math.max(0, Math.trunc(cost.queries ?? 0))
  const rows = Math.max(0, Math.trunc(cost.rows ?? 0))

  let exhausted: { queries: number; rows: number; limit: BudgetState["limit"] } | null = null

  const result = updateJson<BudgetState>(budgetPath(root, runId), (current) => {
    const base = current ?? stateOf(runId)
    const nextQueries = base.used.queries + queries
    const nextRows = base.used.rows + rows
    if (nextQueries > base.limit.queries || nextRows > base.limit.rows) {
      exhausted = { queries: nextQueries, rows: nextRows, limit: base.limit }
      return undefined
    }
    const trail = [...base.trail, { at: nowIso(), label, queries, rows }].slice(-40)
    return {
      ...base,
      used: { queries: nextQueries, rows: nextRows },
      updatedAt: nowIso(),
      trail,
    }
  })

  if (exhausted) {
    const hit = exhausted as { queries: number; rows: number; limit: BudgetState["limit"] }
    throw aError(
      CODES.BUDGET_EXHAUSTED,
      `预算耗尽：本次需要累计 ${hit.queries} 次查询 / ${hit.rows} 行，上限为 ${hit.limit.queries} 次 / ${hit.limit.rows} 行。请停止取数并输出「证据不足」。`,
    )
  }

  const state = result.value ?? stateOf(runId)
  return {
    state,
    remaining: {
      queries: Math.max(0, state.limit.queries - state.used.queries),
      rows: Math.max(0, state.limit.rows - state.used.rows),
    },
  }
}

export function budgetSummary(state: BudgetState): {
  queriesUsed: number
  queriesLimit: number
  rowsUsed: number
  rowsLimit: number
  queriesLeft: number
  rowsLeft: number
  exhausted: boolean
} {
  const queriesLeft = Math.max(0, state.limit.queries - state.used.queries)
  const rowsLeft = Math.max(0, state.limit.rows - state.used.rows)
  return {
    queriesUsed: state.used.queries,
    queriesLimit: state.limit.queries,
    rowsUsed: state.used.rows,
    rowsLimit: state.limit.rows,
    queriesLeft,
    rowsLeft,
    exhausted: queriesLeft === 0 || rowsLeft === 0,
  }
}
