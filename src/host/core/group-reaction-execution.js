// 群 REACT 执行器（Batch 2 / T2.1）：插件声明式表情回应的**唯一**执行点。
//
// 铁律（任务书 §0）：
//   · 只经 Shared Outbox 直通（set_msg_emoji_like），绝不绕过 Outbox、绝不经会把状态
//     转成异常的 hub-egress、绝不伪造 gatewayMessageId；
//   · unknown 绝不自动重试、绝不补文本、绝不换锚（HARD INVARIANT #9）；
//   · 防重不伪造幂等（HARD INVARIANT #11）：确定性 deliveryId 只是防重键，执行前先查
//     台账抑制重复，重复异常也读台账归类，绝不把重复当成首次发送成功；
//   · 仅 sent 记成功预算（noteSpeak + noteInterject 各一次），严禁 noteSpokeInGroup；
//   · sent / unknown 就地标记本回合成员的群缓冲条目为已处理（复用 fed 语义，只标本回合成员）。
//
// 输入严格只接受 { turn, io, offeredMode, participation, groups, outbox, log, now }。

const MESSAGE_ID_RE = /^[1-9][0-9]*$/
const EMOJI_ID_RE = /^[1-9][0-9]{0,9}$/
// 与 reply-delivery 的文本漂移放弃阈值同口径（生成期间群里新增 ≥6 条非本人消息 → 放弃）
const REACT_DRIFT_LIMIT = 6
const TERMINAL_STATES = new Set(['sent', 'failed', 'unknown', 'cancelled'])
// T2.5 第 7 条：group/result.reason 归一化白名单 —— 这些短代码原样放行，其余一律收敛
const KNOWN_REACTION_REASONS = new Set(['duplicate-suppressed', 'duplicate-in-flight'])
const REACT_REASON_RE = /^react-[a-z0-9-]+$/
const STATE_FALLBACK_REASON = {
  failed: 'react-failed',
  unknown: 'react-unknown',
  cancelled: 'react-cancelled',
  skipped: 'react-skipped',
}

/**
 * 把 Outbox 返回的 reason 收敛成 group/result 可用的稳定短代码（T2.5 第 7 条）。
 * 执行器本体仍忠实返回 Outbox 原始 { state, deliveryId, reason }（T2.1 第 9 条）；
 * 这里的收敛只发生在 modular-core 写入 terminalResult 时。
 *  · '' / 白名单短代码（duplicate-* / react-*）→ 原样保留；
 *  · Outbox 取消原因 → 稳定短代码（dryRun→outbox-dry-run、总开关→outbox-disabled、
 *    authorize→outbox-unauthorized、身份泄露→outbox-identity-guard、台账已变更/取消→outbox-cancelled）；
 *  · 其余自由文本（error.message、中文长句、内部路径）→ 一律按 state 兜底，绝不透传。
 */
export function normalizeReactionResultReason(state, reason) {
  const raw = String(reason || '')
  if (!raw) return ''
  if (KNOWN_REACTION_REASONS.has(raw) || REACT_REASON_RE.test(raw)) return raw
  if (raw === 'dryRun') return 'outbox-dry-run'
  if (raw.includes('总开关')) return 'outbox-disabled'
  if (raw.includes('authorize')) return 'outbox-unauthorized'
  if (raw.includes('身份泄露')) return 'outbox-identity-guard'
  if (raw.includes('台账已变更') || raw.includes('取消')) return 'outbox-cancelled'
  return state === 'sent' ? '' : (STATE_FALLBACK_REASON[state] || 'react-cancelled')
}

/**
 * 执行一个已声明的群表情回应。
 * @returns {Promise<{state: 'sent'|'failed'|'unknown'|'cancelled'|'skipped', deliveryId: string, reason: string}>}
 */
export async function executeGroupReaction({ turn, io, offeredMode, participation, groups, outbox, log, now = Date.now() }) {
  const deliveryId = `group-react:${turn?.turnId ?? ''}`
  const zero = (state, reason) => ({ state, deliveryId, reason })

  // ---- 前置防御：任一不满足则零 Outbox 调用 ----
  // turnId 是确定性防重键的组成部分：空 turnId 会让所有回合碰撞同一个 'group-react:' 键，先拒。
  if (!String(turn?.turnId || '').trim()) return zero('cancelled', 'react-missing-turn-id')
  const chatKey = String(turn?.chatKey || '')
  if (!chatKey.startsWith('group:')) return zero('cancelled', 'react-not-group-chat')
  if (offeredMode !== 'interject') return zero('cancelled', 'react-not-interject')
  const reaction = participation && typeof participation === 'object' && !Array.isArray(participation) ? participation.reaction : null
  const messageId = String(reaction?.messageId ?? '')
  const emojiId = String(reaction?.emojiId ?? '')
  if (participation?.level !== 'react'
      || !reaction || typeof reaction !== 'object' || Array.isArray(reaction)
      || !MESSAGE_ID_RE.test(messageId) || !EMOJI_ID_RE.test(emojiId)) {
    return zero('cancelled', 'react-declaration-invalid')
  }
  if (io?.signal?.aborted) return zero('cancelled', 'react-turn-aborted')
  // 锚点必须属于本回合成员：跨回合 / 非本回合成员的消息一律拒绝（不得给旧消息发表情）
  const memberIds = new Set((Array.isArray(io?.members) ? io.members : []).map((m) => String(m?.messageId || '')).filter(Boolean))
  if (!memberIds.has(messageId)) return zero('cancelled', 'react-anchor-not-in-turn')

  const gid = chatKey.slice(6)

  // ---- 漂移复核：锚点必须还在缓冲里，且其后没有刷过屏 ----
  const buf = groups.buffer(gid)
  const anchorIdx = buf.findIndex((x) => x && x.mid === messageId)
  if (anchorIdx < 0) return zero('skipped', 'react-anchor-missing')
  const drift = buf.slice(anchorIdx + 1).filter((x) => x && !x.self && !x.officialBot).length
  if (drift >= REACT_DRIFT_LIMIT) return zero('skipped', 'react-drift')

  // ---- 防重（HARD INVARIANT #11）：请求前先查台账，已有记录一律零新请求 ----
  const ledger = outbox?.ledger
  const readLedger = () => (ledger && typeof ledger.get === 'function' ? ledger.get(deliveryId) : null)
  const classify = (existing) => {
    if (!existing) return null
    if (existing.state === 'queued' || existing.state === 'sending') return { state: 'unknown', deliveryId, reason: 'duplicate-in-flight' }
    if (TERMINAL_STATES.has(existing.state)) return { state: existing.state, deliveryId, reason: 'duplicate-suppressed' }
    return null
  }
  const preExisting = classify(readLedger())
  if (preExisting) return preExisting

  // ---- 经 Shared Outbox 直通（唯一物理出口） ----
  let result
  try {
    result = await outbox.request({
      chatKey,
      deliveryId,
      turnId: turn.turnId,
      sourceModuleId: participation.sourceModuleId,
      action: 'set_msg_emoji_like',
      params: { message_id: messageId, emoji_id: emojiId },
      receipt: 'optional',
      note: '[群参与] 表情回应',
    })
  } catch (error) {
    // 重复 deliveryId 异常：重读台账归类（绝不伪装成首次成功，绝不重试）。
    const raced = classify(readLedger())
    if (raced) return raced
    if (error?.unknown === true) {
      // 副作用未知：成员消息同样按已处理抑制下一轮重复（与正常 unknown 路径同口径）
      markMembersFed()
      return { state: 'unknown', deliveryId, reason: 'react-unknown' }
    }
    log?.warn?.(`群 ${gid}：REACT 投递失败：${error?.message || error}`)
    return { state: 'failed', deliveryId, reason: 'react-request-failed' }
  }

  const state = String(result?.state || 'unknown')

  // ---- 预算与已处理标记：只有 sent 记成功预算；sent / unknown 标记本回合成员已处理 ----
  if (state === 'sent') {
    try { groups.noteSpeak(gid, now) } catch { /* 预算是旁路，绝不影响终态 */ }
    try { groups.noteInterject(gid, now) } catch { /* 同上 */ }
  }
  if (state === 'sent' || state === 'unknown') markMembersFed()

  return { state, deliveryId, reason: String(result?.reason || '') }

  /** 就地标记 groups.buffer(gid) 返回的活动数组条目（不得操作副本），
   *  且只标当前 io.members 里有 messageId 对应的条目，绝不误标旧消息。
   *  sent / unknown 都要标（unknown 的副作用未知，成员消息按已处理抑制下一轮重复）；
   *  failed / cancelled / skipped 与 duplicate 抑制路径不标。 */
  function markMembersFed() {
    for (const entry of buf) {
      if (entry && entry.mid && memberIds.has(entry.mid)) entry.fed = true
    }
  }
}
