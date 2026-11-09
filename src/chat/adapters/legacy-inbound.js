// M3-A · Legacy Inbound Adapter：OneBot v11 事件 → NormalizedInbound（raw 只留适配层）
//
// 复用 src/chat/inbound.js 的 parseMessageEvent 全部语义（文本/表情/图片/引用/转发判定），
// 只做「映射」不做「解释」：NormalizedInbound.segments 保留结构化原文（ADR-0001 §4 raw 边界）；
// parseMessageEvent 的文本视图作为 meta.text 供消费方直接用（避免每个消费方重复解析）。
// 本适配器不被主链引用（M4 接线前零生产调用）。

import { createNormalizedInbound } from '../normalized-inbound.js'
import { chatKeyFromEvent } from '../chat-key.js'
import { parseMessageEvent } from '../inbound.js'

/**
 * @param {object} ev OneBot v11 原始事件
 * @param {object} o
 * @param {string|number} o.selfId 机器人 QQ
 * @param {'realtime'|'backfill'} [o.source] 来源（补收适配时传 backfill）
 * @param {(id: string) => string|undefined} [o.faceName] 系统表情 id → 名字
 * @param {number} [o.timestamp] 覆盖时间戳（补收用原始时间）
 * @returns {Readonly<object>} NormalizedInbound（冻结契约）
 */
export function legacyEventToNormalized(ev, { selfId, source = 'realtime', faceName, timestamp } = {}) {
  if (!ev || typeof ev !== 'object') throw new TypeError('ev 必须是对象')

  // 戳一戳（notice 事件）：建模为 poke 段的入站事件
  if (ev.post_type === 'notice' && ev.notice_type === 'notify' && ev.sub_type === 'poke') {
    const poker = String(ev.user_id ?? ev.sender_id ?? '')
    if (!poker) throw new TypeError('poke 事件缺 user_id/sender_id')
    const chatKey = ev.group_id != null ? `group:${ev.group_id}` : `private:${poker}`
    return createNormalizedInbound({
      eventId: `poke:${ev.group_id ?? 'p'}:${poker}:${ev.time ?? timestamp ?? Date.now()}`,
      chatKey,
      sender: { userId: poker, ...(ev.sender?.nickname ? { nickname: String(ev.sender.nickname) } : {}) },
      timestamp: Number(timestamp ?? (ev.time ? ev.time * 1000 : Date.now())),
      source,
      segments: [{ type: 'poke', data: { action: String(ev.action ?? ''), suffix: String(ev.suffix ?? ''), targetId: String(ev.target_id ?? '') } }],
    })
  }

  // message / message_sent：复用 parseMessageEvent 的完整解析语义
  if (ev.post_type !== 'message' && ev.post_type !== 'message_sent') {
    throw new TypeError(`legacy 适配器只处理 message/message_sent/poke，收到 ${ev.post_type ?? '(无 post_type)'}`)
  }
  const chatKey = chatKeyFromEvent(ev)
  if (!chatKey) throw new TypeError('事件缺 user_id/group_id，无法成键（fail-closed，不猜）')
  const parsed = parseMessageEvent(ev, selfId, { faceName })
  const self = String(selfId ?? ev.self_id ?? '')
  const senderId = ev.post_type === 'message_sent' ? self : parsed.userId
  const segments = (Array.isArray(ev.message) ? ev.message : typeof ev.message === 'string'
    ? [{ type: 'text', data: { text: ev.message.replace(/\[CQ:[^\]]*\]/g, '') } }]
    : []).filter((s) => s && typeof s === 'object').map((s) => ({ type: String(s.type ?? ''), data: { ...(s.data ?? {}) } }))

  return createNormalizedInbound({
    eventId: `msg:${chatKey}:${ev.message_id ?? ''}`,
    ...(ev.message_id != null ? { messageId: String(ev.message_id) } : {}),
    chatKey,
    sender: { userId: String(senderId), nickname: String(ev.sender?.card || ev.sender?.nickname || senderId) },
    timestamp: Number(timestamp ?? (ev.time ? ev.time * 1000 : Date.now())),
    source,
    segments,
    // parseMessageEvent 的富视图给消费方（meta 不进契约字段——createNormalizedInbound 会丢弃契约外字段，
    // 所以这里以闭包共享而非字段透传：见 legacyInboundBatch 的 returns）
  })
}

/**
 * 批量适配：事件 + 富解析视图一起返回（富视图 = parseMessageEvent 全量产物，供 M4 管道消费）。
 * @returns {{ inbound: object, view: object }[]} view.kind/chatId/text/mentioned/replyId/images/...
 */
export function legacyInboundBatch(events, opts = {}) {
  const out = []
  for (const ev of Array.isArray(events) ? events : []) {
    try {
      out.push({ inbound: legacyEventToNormalized(ev, opts), view: parseMessageEvent(ev, opts.selfId, { faceName: opts.faceName }) })
    } catch {
      // 无主事件（缺键/不支持形态）：跳过并留痕——绝不猜键
      out.push({ inbound: null, view: null, event: ev })
    }
  }
  return out
}
