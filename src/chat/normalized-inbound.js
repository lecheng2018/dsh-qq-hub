// M2-A · NormalizedInbound：标准化入站事件工厂（纯模块，不依赖 DSH / OneBot / host）
//
// 冻结契约（ADR-0001 §1/§4）：eventId、可选 messageId、ChatKey、发送者、时间戳、
// 结构化 segments、来源（realtime/backfill）。本工厂负责：
//   1. 输入校验（复用 modular-contracts 的 assertNormalizedInbound，唯一权威）；
//   2. 不可变边界：产出深冻结对象，调用方的原对象不被修改；
//   3. 便捷视图：textOf / segsOf / sourceOf / isBackfill，消费者零猜测。
//
// raw 边界（ADR-0001 §4）：核心不携带、不理解 OneBot 原始对象；legacy raw 只能留在
// 适配层（M3-A），本工厂不接受 raw 透传字段——契约外字段一律丢弃，防止适配层私搭桥。

import { assertNormalizedInbound, CONTRACT_VERSION } from '../kernel/modular-contracts.js'

/** 事件 ID 的确定性缺省派生：同一消息在同一聊天里重复到达时派生出同一 ID（去重语义友好）。 */
function deriveEventId({ messageId, chatKey, timestamp }) {
  if (messageId != null && messageId !== '') return `msg:${chatKey}:${messageId}`
  return `evt:${chatKey}:${timestamp}`
}

/**
 * 创建标准化入站事件。
 * @param {object} input
 * @param {string} [input.eventId] 事件唯一 ID；缺省由 messageId+chatKey+timestamp 派生
 * @param {string|number} [input.messageId] 网关消息 ID（poke 等无消息形态可缺省）
 * @param {string} input.chatKey ChatKey（private:<id> / group:<id>）
 * @param {{userId: string|number, nickname?: string, card?: string}} input.sender
 * @param {number} input.timestamp 毫秒时间戳
 * @param {'realtime'|'backfill'} input.source 来源
 * @param {Array<{type: string, data: object}>} input.segments 结构化消息段
 * @returns {Readonly<object>} 深冻结的 NormalizedInbound
 */
export function createNormalizedInbound(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('inbound 入参必须是对象')
  }
  const {
    eventId, messageId, chatKey, sender, timestamp, source, segments,
  } = input

  if (segments !== undefined && !Array.isArray(segments)) {
    throw new TypeError('segments 必须是数组（缺省按无消息段处理）')
  }
  const normalizedSegments = Object.freeze(
    (segments ?? []).map((seg) => {
      if (!seg || typeof seg !== 'object' || Array.isArray(seg)) {
        throw new TypeError('segments 每项必须是 {type, data} 对象')
      }
      return Object.freeze({ type: String(seg.type ?? ''), data: Object.freeze({ ...(seg.data ?? {}) }) })
    }),
  )

  const normalizedSender = sender && typeof sender === 'object'
    ? Object.freeze({ userId: String(sender.userId ?? ''), ...(sender.nickname !== undefined ? { nickname: String(sender.nickname) } : {}), ...(sender.card !== undefined ? { card: String(sender.card) } : {}) })
    : undefined

  const outbound = Object.freeze({
    contractVersion: CONTRACT_VERSION,
    eventId: String(eventId ?? deriveEventId({ messageId, chatKey, timestamp })),
    ...(messageId != null && messageId !== '' ? { messageId: String(messageId) } : {}),
    chatKey: String(chatKey ?? ''),
    sender: normalizedSender,
    timestamp: Number(timestamp),
    source: String(source ?? ''),
    segments: normalizedSegments,
  })
  // 契约校验是唯一权威：不满足冻结契约（缺字段/非法类型/未知来源）直接抛
  assertNormalizedInbound(outbound)
  return outbound
}

/** 纯文本视图：拼接全部 text 段。 */
export function textOf(inbound) {
  return (inbound?.segments ?? []).filter((s) => s?.type === 'text').map((s) => String(s.data?.text ?? '')).join('')
}

/** 按类型取消息段。 */
export function segsOf(inbound, type) {
  return (inbound?.segments ?? []).filter((s) => s?.type === type)
}

/** 来源视图。 */
export function sourceOf(inbound) {
  return inbound?.source ?? ''
}

/** 是否补收来源。 */
export function isBackfill(inbound) {
  return sourceOf(inbound) === 'backfill'
}
