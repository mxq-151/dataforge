/**
 * 跨 kit 共享的最小 IO 助手。
 *
 * 两套 agentkit（req-doc / dw-dev）物化到同一个用户级目录，源码若各写一份，
 * 原子写盘与 `nowIso` 的语义迟早分叉；这里作为唯一实现，两边只做再导出。
 *
 * 写盘并发约定：
 * - 跨进程：`<目标文件>.lock` 以 O_EXCL 创建，抢不到就短间隔重试；
 * - 进程内：同一路径再加一层互斥，避免同进程的并发调用互相覆盖临时文件；
 * - 锁失效：持锁进程已退出时立即判失效；锁内容损坏或 pid 被复用则按超龄兜底；
 *   等待超过 LOCK_TIMEOUT_MS 仍未拿到锁时抛错，不会无限阻塞。
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const LOCK_SUFFIX = ".lock"
const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 30_000
const LOCK_RETRY_MS = 20
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4))

const inProcessLocks = new Map<string, { token: string; at: number }>()
let tmpSeq = 0

type LockInfo = { pid?: number; token?: string; createdAt?: number }

function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms)
}

function readLockInfo(lockFile: string): LockInfo | null {
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf8")) as LockInfo
  } catch {
    return null
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** 锁是否已失效：持锁进程不存在立即失效；内容损坏或 pid 被复用时按超龄失效。 */
function lockIsStale(lockFile: string): boolean {
  let mtimeMs: number
  try {
    mtimeMs = fs.statSync(lockFile).mtimeMs
  } catch {
    return false
  }
  const info = readLockInfo(lockFile)
  if (info) {
    const age = typeof info.createdAt === "number" ? Date.now() - info.createdAt : Date.now() - mtimeMs
    if (typeof info.pid === "number" && info.pid !== process.pid && !processAlive(info.pid)) return true
    return age > LOCK_STALE_MS
  }
  return Date.now() - mtimeMs > LOCK_STALE_MS
}

function acquireWriteLock(file: string): () => void {
  const target = path.resolve(file)
  const lockFile = `${target}${LOCK_SUFFIX}`
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`
  const deadline = Date.now() + LOCK_TIMEOUT_MS

  for (;;) {
    const held = inProcessLocks.get(target)
    if (!held) break
    if (Date.now() - held.at > LOCK_STALE_MS) {
      inProcessLocks.delete(target)
      break
    }
    if (Date.now() > deadline) throw new Error(`等待进程内写锁超时：${target}`)
    sleepSync(LOCK_RETRY_MS)
  }
  inProcessLocks.set(target, { token, at: Date.now() })
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    for (;;) {
      try {
        const fd = fs.openSync(lockFile, "wx")
        try {
          fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }))
        } finally {
          fs.closeSync(fd)
        }
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        if (lockIsStale(lockFile)) {
          // 持锁进程已退出或锁已超龄：清掉后重试；清理失败说明别人先动手，继续轮询。
          try {
            fs.rmSync(lockFile, { force: true })
          } catch {
            /* 其他进程已清理 */
          }
          continue
        }
        if (Date.now() > deadline) throw new Error(`等待写锁超时：${lockFile}`)
        sleepSync(LOCK_RETRY_MS)
      }
    }
  } catch (error) {
    inProcessLocks.delete(target)
    throw error
  }

  return () => {
    try {
      const info = readLockInfo(lockFile)
      if (!info || info.token === token) fs.rmSync(lockFile, { force: true })
    } catch {
      /* 释放失败不影响本次写入结果，超龄后由其它写入方清理 */
    } finally {
      inProcessLocks.delete(target)
    }
  }
}

function writeAtomicUnlocked(target: string, content: string): void {
  tmpSeq += 1
  const tmp = `${target}.${process.pid}.${tmpSeq}.${crypto.randomBytes(6).toString("hex")}.tmp`
  try {
    fs.writeFileSync(tmp, content, "utf8")
    fs.renameSync(tmp, target)
  } finally {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 临时文件已随 rename 消失或无权删除，不覆盖原始错误 */
    }
  }
}

function writeAtomic(file: string, content: string): void {
  const target = path.resolve(file)
  const release = acquireWriteLock(target)
  try {
    writeAtomicUnlocked(target, content)
  } finally {
    release()
  }
}

export function readJson<T = unknown>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
  } catch {
    return null
  }
}

export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeAtomic(file, JSON.stringify(value, null, 2))
}

export function writeTextAtomic(file: string, text: string): void {
  writeAtomic(file, text)
}

/** 事务结果：`written=false` 表示 `mutate` 返回 undefined，本次只读不写。 */
export type TransactionResult<T> = { value: T | null; written: boolean }

/**
 * 读改写事务：同一把写锁内完成「读 → mutate → 原子写」。
 * `mutate` 返回 undefined 表示本次不写（用于校验失败等场景），直接错误会原样抛出。
 */
export function updateJson<T>(
  file: string,
  mutate: (current: T | null) => T | undefined,
): TransactionResult<T> {
  const target = path.resolve(file)
  const release = acquireWriteLock(target)
  try {
    const current = readJson<T>(target)
    const next = mutate(current)
    if (next === undefined) return { value: current, written: false }
    writeAtomicUnlocked(target, JSON.stringify(next, null, 2))
    return { value: next, written: true }
  } finally {
    release()
  }
}

/** 文本版读改写事务，语义与 `updateJson` 一致。 */
export function updateText(
  file: string,
  mutate: (current: string | null) => string | undefined,
): TransactionResult<string> {
  const target = path.resolve(file)
  const release = acquireWriteLock(target)
  try {
    const current = readText(target)
    const next = mutate(current)
    if (next === undefined) return { value: current, written: false }
    writeAtomicUnlocked(target, next)
    return { value: next, written: true }
  } finally {
    release()
  }
}

export function nowIso(): string {
  return new Date().toISOString()
}
