/**
 * 通道身份与幂等键（跨类型共享）。
 *
 * 为什么在 shared：task-diag 与 data-analysis 需要**完全相同**的键格式——
 * 一旦两套各自拼 `serviceType|componentId|hostId|dataTypeId|stream|ref`，
 * 同一个通道在两个类型下会被判成不同证据，幂等与审计都会失效。
 * 这里只放纯函数，不依赖任何类型的通道常量。
 */

export type ChannelIdentity = {
  serviceType: string
  componentId: string
  hostId: string
  dataTypeId: string
  stream: string
}

/** 通道身份（不含 ref），用于作用域白名单与所有权矩阵。 */
export function channelIdentityOf(channel: ChannelIdentity): string {
  return [channel.serviceType, channel.componentId, channel.hostId, channel.dataTypeId, channel.stream].join("|")
}

/** 幂等落盘键：四元组 + stream + 排序后的 ref。 */
export function channelKeyOf(channel: ChannelIdentity & { ref?: Record<string, string> }): string {
  const refPart = Object.entries(channel.ref ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(",")
  return [channelIdentityOf(channel), refPart].join("|")
}
