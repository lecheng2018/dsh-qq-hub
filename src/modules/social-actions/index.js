// 内置模块：社交动作。三件事，全部默认关、逐项可控：
//   1. 表情回应（自动）：关系温度 ≥1 时，低概率给对方刚发的消息加一个表情回应——
//      情感图谱联动（level），冲突/越界在场绝不回应（复用 affective-signals 的判定），
//      同会话冷却 + 概率上限，绝不变成骚扰；
//   2. 精华（工具 qq_essence，仅主人/群聊）：设/取精华消息；
//   3. QZone 写扩展（工具 qq_qzone_action，仅主人）：赞/取消赞/评论/改可见性——
//      都是公开社交足迹，评论与改可见性要显式确认。
//
// 纪律：
//   · set_msg_emoji_like / set_essence_msg / like_qzone 等都是状态写，不进只读白名单；
//   · 回应决策是纯函数（decideReaction），随机源与时间可注入，测试直打；
//   · recent 表有界（50 条）+ TTL（10 分钟）+ dispose 清理；冷却表自动过期清理。
//
// 内存纪律：无定时器、无子进程；两张有界表都自带过期清理。

import { defineTool, str, int } from '../../tools/tools.js'
import { registerReadActions } from '../../onebot/read-actions.js'

/** recent 表容量与 TTL。 */
const RECENT_CAP = 50
const RECENT_TTL_MS = 10 * 60_000
/** 表情回应冷却（同会话一次回应后，这个时长内不再回应）。 */
export const REACTION_COOLDOWN_MS = 30 * 60_000

/**
 * 回应决策（纯函数）。任何一条不满足就返回 null（不回应）：
 *   · 关系温度 ≥1（陌生人不回应）；
 *   · 这一轮没有冲突/越界信号（吵架时绝不补表情）；
 *   · 概率命中（random 注入）；
 *   · 该会话不在冷却期。
 * @returns {string|null} 要用的 emojiId
 */
export function decideReaction({ level, conflictPresent, chance, random = Math.random, cooldownActive, pool }) {
  if (!(Number(level) >= 1)) return null
  if (conflictPresent) return null
  if (!Array.isArray(pool) || !pool.length) return null
  if (cooldownActive) return null
  const p = Math.max(0, Math.min(1, Number(chance) || 0))
  if (!(random() < p)) return null
  return pool[Math.floor(random() * pool.length)] || null
}

/** 从一段文本里判定冲突/越界是否在场（复用情感信号的保守判定，绝不自己另造词表）。 */
export function conflictPresentIn(text, mineSignals) {
  try {
    const signals = mineSignals({ userText: String(text ?? '') }) || []
    return signals.some((s) => s?.kind === 'conflict' || s?.kind === 'boundary-violation')
  } catch {
    return true // 判定器坏了按「在场」处理：宁可漏回应，不可火上浇油
  }
}

export default {
  id: 'social-actions',
  name: '社交动作',
  version: '1.0.0',
  description: '关系温度够了才有的表情回应（可关可调）；主人私聊工具：设/取精华（qq_essence）、QZone 赞/评论/改可见性（qq_qzone_action）',
  defaults: {
    reactionsEnabled: false,
    reactionChancePercent: 12,
    reactionCooldownMin: 30,
    reactionEmojiIds: '4,66,85',
    qzoneActionsEnabled: false,
  },
  settings: [
    { key: 'reactionsEnabled', label: '表情回应', type: 'switch', hint: '关系温度 ≥1（熟络好友以上）且无冲突时，低概率给对方刚发的消息加表情回应' },
    { key: 'reactionChancePercent', label: '回应概率 (%)', type: 'number', min: 0, max: 100, step: 1, hint: '她每次回复后触发判定；12 就是 12%' },
    { key: 'reactionCooldownMin', label: '同会话冷却 (分钟)', type: 'number', min: 5, max: 240, step: 5 },
    { key: 'reactionEmojiIds', label: '回应表情池', type: 'text', placeholder: '4,66,85', hint: 'QQ 表情 id，逗号分隔（手机 QQ 长按回应可看到 id；认不出的 id 网关会拒绝，属于软失败）' },
    { key: 'qzoneActionsEnabled', label: 'QZone 互动', type: 'switch', hint: '开之后主人才可以用 qq_qzone_action 赞/评论/改可见性（公开社交足迹，默认关）' },
  ],
  setup(api) {
    const { onebot, hub } = api.core

    // 状态写动作不进只读白名单（保守：失败不重试）。
    registerReadActions([])

    const mineSignals = api.lib('chat/affective-signals.js')?.mineSignals

    const settingsOf = () => {
      const s = api.settings() || {}
      return {
        reactionsEnabled: s.reactionsEnabled === true,
        chance: Math.max(0, Math.min(100, Number(s.reactionChancePercent) || 0)) / 100,
        cooldownMs: Math.max(5, Number(s.reactionCooldownMin) || 30) * 60_000,
        pool: String(s.reactionEmojiIds ?? '').split(',').map((x) => x.trim()).filter(Boolean),
        qzoneActionsEnabled: s.qzoneActionsEnabled === true,
      }
    }

    /** chatId → { messageId, text, at }。有界 + 过期（最近一条入站，供回应定位）。 */
    const recent = new Map()
    const noteRecent = (chatId, entry) => {
      const now = Date.now()
      for (const [key, value] of recent) if (now - value.at > RECENT_TTL_MS) recent.delete(key)
      while (recent.size >= RECENT_CAP) recent.delete(recent.keys().next().value)
      recent.set(chatId, { ...entry, at: now })
    }
    /** 冷却表：chatId → 上次回应时间。过期项顺手清，表不无限长。 */
    const cooldown = new Map()
    api.onDispose?.(() => { recent.clear(); cooldown.clear() })

    api.on('message', (msg) => {
      try {
        if (!msg?.messageId) return false
        noteRecent(msg.chatId, { messageId: String(msg.messageId), text: String(msg.text || ''), userId: String(msg.userId || '') })
      } catch { /* 只看不拦 */ }
      return false
    })

    // 她说完话（activity out）→ 判定要不要给刚那条入站消息加回应。绝不阻塞投递链。
    api.on('activity', ({ kind, chatId } = {}) => {
      if (kind !== 'out') return
      try {
        const s = settingsOf()
        if (!s.reactionsEnabled || !s.pool.length) return
        const rec = recent.get(chatId)
        if (!rec || Date.now() - rec.at > RECENT_TTL_MS) return
        const graph = api.use('affective-graph')
        const tone = typeof graph?.toneFor === 'function' ? graph.toneFor(chatId) : null
        const last = cooldown.get(chatId)
        const emojiId = decideReaction({
          level: Number(tone?.level) || 0,
          conflictPresent: conflictPresentIn(rec.text, mineSignals),
          chance: s.chance,
          cooldownActive: typeof last === 'number' && Date.now() - last < s.cooldownMs,
          pool: s.pool,
        })
        if (!emojiId) return
        cooldown.set(chatId, Date.now())
        Promise.resolve(onebot.call('set_msg_emoji_like', { message_id: rec.messageId, emoji_id: emojiId }, { timeoutMs: 8000 }))
          .then(() => api.log.debug(`${chatId}:给 ${rec.messageId} 加了表情回应 ${emojiId}`))
          .catch((error) => api.log.debug(`${chatId}:表情回应没上（软失败，不重试）：`, error?.message || error))
      } catch (error) {
        api.log.debug('表情回应判定失败（忽略）：', error?.message || error)
      }
    })

    // 精华：仅主人、仅群聊（精华是群功能）
    api.tool(({ chat, level, sessionId }) => {
      if (chat.kind !== 'group') return []
      return defineTool({
        name: 'qq_essence',
        description: '设置或取消群精华消息。只有主人要求时才能用；message_id 省略时对「主人刚引用/最近发的那条」操作可能对不上，最好给明确 id。',
        properties: {
          action: { type: 'string', enum: ['set', 'unset'], description: 'set 设精华 / unset 取消精华' },
          message_id: str('要操作的消息 id'),
        },
        required: ['action'],
        execute: async ({ action, message_id }) => {
          if (!hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能让我设置精华' }
          const mid = String(message_id || '').trim()
          if (!mid) return { ok: false, message: '要给 message_id（消息 id）' }
          if (String(action) === 'set') await onebot.call('set_essence_msg', { message_id: mid }, { timeoutMs: 10000 })
          else if (String(action) === 'unset') await onebot.call('delete_essence_msg', { message_id: mid }, { timeoutMs: 10000 })
          else return { ok: false, message: 'action 要是 set 或 unset' }
          return { ok: true, message: action === 'set' ? '设成精华了' : '精华取消了' }
        },
      })
    })

    // QZone 写扩展：仅主人；评论/改可见性是公开足迹，confirm=确认
    api.tool(({ chat, level, sessionId }) => {
      if (level !== 'full') return []
      return defineTool({
        name: 'qq_qzone_action',
        description: '以她的 QQ 账号操作 QZone：like 点赞 / unlike 取消赞 / comment 评论（公开足迹，confirm=确认）/ set_right 改某条说说的可见范围（confirm=确认）。只有主人要求时才能用。',
        properties: {
          action: { type: 'string', enum: ['like', 'unlike', 'comment', 'set_right'], description: 'like / unlike / comment / set_right' },
          tid: str('说说 id（面板空间页或 get_qzone_msg_list 里拿）'),
          content: str('comment：评论内容'),
          ugc_right: { type: 'integer', description: 'set_right：1 所有人 / 4 好友 / 16 部分好友 / 64 仅自己 / 128 被挡部分' },
          confirm: str('comment / set_right：必须写「确认」'),
        },
        required: ['action', 'tid'],
        execute: async (args) => {
          if (!hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能让我动 QZone' }
          const s = settingsOf()
          if (!s.qzoneActionsEnabled) return { ok: false, message: 'QZone 互动没开：主人在面板「社交动作」页打开开关' }
          const tid = String(args.tid || '').trim()
          const action = String(args.action || '')
          const isPublic = action === 'comment' || action === 'set_right'
          if (isPublic && String(args.confirm || '').trim() !== '确认') return { ok: false, message: '评论和改可见性是公开足迹，confirm 要明确写「确认」' }
          switch (action) {
            case 'like': await onebot.call('like_qzone', { tid }, { timeoutMs: 15000 }); return { ok: true, message: '点赞了' }
            case 'unlike': await onebot.call('unlike_qzone', { tid }, { timeoutMs: 15000 }); return { ok: true, message: '取消赞了' }
            case 'comment': {
              const content = String(args.content || '').trim()
              if (!content) return { ok: false, message: 'comment 要给 content' }
              await onebot.call('comment_qzone', { tid, content }, { timeoutMs: 20000 })
              return { ok: true, message: '评论发出去了' }
            }
            case 'set_right': {
              const right = Number(args.ugc_right) || 0
              if (![1, 4, 16, 64, 128].includes(right)) return { ok: false, message: 'ugc_right 要是 1 / 4 / 16 / 64 / 128' }
              await onebot.call('set_qzone_msg_right', { tid, ugc_right: right }, { timeoutMs: 15000 })
              return { ok: true, message: '可见范围改好了' }
            }
            default:
              return { ok: false, message: 'action 要是 like / unlike / comment / set_right' }
          }
        },
      })
    })

    return { decideReaction, conflictPresentIn }
  },
}
