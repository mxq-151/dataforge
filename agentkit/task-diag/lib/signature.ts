/**
 * 日志归一化与指纹抽取（纯函数，可单测）。
 *
 * 这是「成本与问题量成正比」的核心：4MB / 4 万行日志在进入模型之前就被折叠成
 * ≤20 条指纹 × ≤3 行样本。任何提高召回率的改动都必须同时跑单测，并递增版本号——
 * 报告里会记录 `fingerprintVersion`，版本变了历史结论不可直接比较。
 *
 * 注意：本文件只做字符串处理，不访问网络、不读写文件。
 */

/** 指纹算法版本：改变归一化规则必须递增。 */
export const FINGERPRINT_VERSION = "sig-1"

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
const ISO_TS = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?/g
const TIME_ONLY = /\b\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?\b/g
const DATE_ONLY = /\b\d{4}-?\d{2}-?\d{2}\b/g
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g
const HEX_LONG = /\b(?:0x)?[0-9a-fA-F]{8,}\b/g
const IP_PORT = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g
const LONG_NUM = /\b\d{5,}\b/g
const UNIX_PATH = /(?:[A-Za-z]:)?(?:\/[\w.@+-]+){2,}/g
const THREAD_PREFIX = /^\s*\[[^\]]{1,60}\]\s*/
const BRACKET_TS = /^\s*[\[(]\d{4}-\d{2}-\d{2}[^\])]*[\])]\s*/
const BRACKET_GROUP = /\[\s*([^\]\n]{1,60}?)\s*\]/g
const LEVEL_WORD = /^(FATAL|ERROR|SEVERE|WARN|WARNING|INFO|DEBUG|TRACE)$/i
const LOG_LEVEL_TOKEN = /\b(FATAL|ERROR|SEVERE|WARN|WARNING|INFO|DEBUG|TRACE)\b/gi

export type LogLevel = "FATAL" | "ERROR" | "WARN" | "INFO" | "DEBUG" | "UNKNOWN"

/** 去掉 ANSI 颜色与回车。 */
export function stripAnsi(line: string): string {
  return line.replace(ANSI, "").replace(/\r/g, "")
}

/** 日志级别：FATAL/ERROR/SEVERE 归 ERROR 档，WARNING 归 WARN。 */
export function levelOf(line: string): LogLevel {
  const upper = line.toUpperCase()
  if (/\b(FATAL|SEVERE)\b/.test(upper)) return "FATAL"
  if (/\bERROR\b/.test(upper)) return "ERROR"
  if (/\bWARN(ING)?\b/.test(upper)) return "WARN"
  if (/\bINFO\b/.test(upper)) return "INFO"
  if (/\b(DEBUG|TRACE)\b/.test(upper)) return "DEBUG"
  return "UNKNOWN"
}

/** 从一行里抓第一个时间戳（用于 firstSeen / lastSeen），抓不到返回 null。 */
export function timestampOf(line: string): string | null {
  const match = ISO_TS.exec(line)
  ISO_TS.lastIndex = 0
  if (!match) return null
  return match[0].replace(" ", "T")
}

/** 归一化：抹掉易变部分，保留异常类名与消息骨架。 */
export function normalizeLine(line: string): string {
  let text = stripAnsi(line).trim()
  text = text.replace(THREAD_PREFIX, "")
  text = text.replace(BRACKET_TS, "")
  text = text.replace(ISO_TS, "<ts>")
  text = text.replace(DATE_ONLY, "<date>")
  text = text.replace(TIME_ONLY, "<time>")
  text = text.replace(UUID, "<uuid>")
  // 线程名（[main] / [pool-2-thread-1] / [Thread-3] …）归一化，但保留 [ERROR] 这类级别标记，
  // 否则不同级别的相同文案会被合并成同一个指纹。
  text = text.replace(BRACKET_GROUP, (match, inner: string) => (LEVEL_WORD.test(inner) ? match : "<thread>"))
  text = text.replace(IP_PORT, "<ip>")
  text = text.replace(UNIX_PATH, "<path>")
  text = text.replace(HEX_LONG, "<hex>")
  text = text.replace(LONG_NUM, "<num>")
  text = text.replace(/\s+/g, " ")
  return text.trim()
}

/** 异常类名抽取（Java/Scala 栈首行常见形态）。 */
export function exceptionClassOf(line: string): string | null {
  const match = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(?:[A-Z][\w$]*(?:Exception|Error|Throwable)))/.exec(line)
  return match ? match[1] : null
}

export type SignatureSample = { line: number; text: string; context: string[] }

export type Signature = {
  id: string
  signature: string
  level: LogLevel
  count: number
  firstSeen: string | null
  lastSeen: string | null
  firstLine: number
  lastLine: number
  exceptionClass: string | null
  samples: SignatureSample[]
}

export type FingerprintOptions = {
  maxSignatures?: number
  samplesPerSignature?: number
  contextLines?: number
  /** 只保留这些级别；为空表示全部级别参与指纹，但排序仍按出现次数 */
  levels?: LogLevel[]
}

export type FingerprintResult = {
  version: string
  signatures: Signature[]
  scannedLines: number
  keptLines: number
  droppedSignatures: number
  levelCounts: Record<string, number>
}

/**
 * 指纹抽取。
 *
 * - 相同归一化文本归为一条，按出现次数降序；
 * - 超过 `maxSignatures` 的尾部折叠为 `droppedSignatures` 计数，不丢"错误种类很多"这个事实；
 * - 每条样本最多 `samplesPerSignature` 条，每条样本最多 `contextLines` 行上下文。
 */
export function fingerprint(lines: string[], options: FingerprintOptions = {}): FingerprintResult {
  const maxSignatures = options.maxSignatures ?? 20
  const samplesPerSignature = options.samplesPerSignature ?? 3
  const contextLines = options.contextLines ?? 2
  const levelFilter = options.levels && options.levels.length > 0 ? new Set(options.levels) : null

  type Bucket = {
    signature: string
    level: LogLevel
    count: number
    firstSeen: string | null
    lastSeen: string | null
    firstLine: number
    lastLine: number
    exceptionClass: string | null
    samples: SignatureSample[]
  }

  const buckets = new Map<string, Bucket>()
  const levelCounts: Record<string, number> = {}
  let keptLines = 0

  for (let i = 0; i < lines.length; i++) {
    const raw = stripAnsi(lines[i])
    if (!raw.trim()) continue
    const level = levelOf(raw)
    levelCounts[level] = (levelCounts[level] ?? 0) + 1
    if (levelFilter && !levelFilter.has(level)) continue

    const normalized = normalizeLine(raw)
    if (!normalized) continue
    keptLines += 1

    const ts = timestampOf(raw)
    const bucket = buckets.get(normalized)
    if (!bucket) {
      buckets.set(normalized, {
        signature: normalized,
        level,
        count: 1,
        firstSeen: ts,
        lastSeen: ts,
        firstLine: i + 1,
        lastLine: i + 1,
        exceptionClass: exceptionClassOf(raw),
        samples:
          samplesPerSignature > 0
            ? [
                {
                  line: i + 1,
                  text: clipText(raw, 500),
                  context: contextLines > 0 ? lines.slice(i + 1, i + 1 + contextLines).map((x) => clipText(stripAnsi(x), 300)) : [],
                },
              ]
            : [],
      })
      continue
    }

    bucket.count += 1
    bucket.lastLine = i + 1
    if (ts) {
      if (!bucket.firstSeen) bucket.firstSeen = ts
      bucket.lastSeen = ts
    }
    if (bucket.samples.length < samplesPerSignature) {
      bucket.samples.push({
        line: i + 1,
        text: clipText(raw, 500),
        context: contextLines > 0 ? lines.slice(i + 1, i + 1 + contextLines).map((x) => clipText(stripAnsi(x), 300)) : [],
      })
    }
  }

  const ordered = [...buckets.values()].sort((a, b) => b.count - a.count || a.firstLine - b.firstLine)
  const kept = ordered.slice(0, maxSignatures)
  const dropped = ordered.length - kept.length

  return {
    version: FINGERPRINT_VERSION,
    signatures: kept.map((bucket, index) => ({
      id: `SIG-${String(index + 1).padStart(3, "0")}`,
      signature: bucket.signature,
      level: bucket.level,
      count: bucket.count,
      firstSeen: bucket.firstSeen,
      lastSeen: bucket.lastSeen,
      firstLine: bucket.firstLine,
      lastLine: bucket.lastLine,
      exceptionClass: bucket.exceptionClass,
      samples: bucket.samples,
    })),
    scannedLines: lines.length,
    keptLines,
    droppedSignatures: dropped,
    levelCounts,
  }
}

/** 按 UTF-8 字节截断，附截断标记。 */
export function clipText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  let end = text.length
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end -= 1
  return `${text.slice(0, end)}…`
}

export function bytesOf(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8")
}
