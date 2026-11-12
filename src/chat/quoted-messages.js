import { parseMessageEvent } from './inbound.js'

const CACHE_MAX = 200

function contextOf(ctx) {
  if (typeof ctx === 'string') {
    const group = ctx.startsWith('group:')
    return { kind: group ? 'group' : 'private', chatId: ctx, groupId: group ? ctx.slice(6) : '', userId: group ? '' : ctx.slice(8) }
  }
  const chatId = String(ctx?.chatId || '')
  const group = Boolean(ctx?.groupId) || chatId.startsWith('group:')
  return {
    kind: group ? 'group' : 'private',
    chatId,
    groupId: String(ctx?.groupId || (group ? chatId.slice(6) : '')),
    userId: String(ctx?.userId || (!group ? chatId.slice(8) : '')),
  }
}

function usable(seg) {
  return [seg?.data?.url, seg?.data?.file].some((value) => typeof value === 'string'
    && (/^https?:\/\//i.test(value) || value.startsWith('base64://') || value.startsWith('file://') || /^[a-zA-Z]:[\\/]/.test(value)))
}

function needsHistory(parsed) {
  return [...(parsed.images || []), ...(parsed.stickers || [])].some((seg) => !usable(seg))
}

export function createQuotedMessages({ onebot, getConfig, selfId, faceName, isSentMessage, log } = {}) {
  const cache = new Map()

  async function fromHistory(id, chat) {
    if (!chat.groupId && !chat.userId) return null
    const group = chat.kind === 'group'
    const action = group ? 'get_group_msg_history' : 'get_friend_msg_history'
    const base = group ? { group_id: Number(chat.groupId) } : { user_id: Number(chat.userId) }
    const anchor = /^-?\d+$/.test(id) ? Number(id) : 0
    const attempts = anchor
      ? [{ ...base, message_id: anchor, count: 5, reverse_order: false }, { ...base, count: 30 }]
      : [{ ...base, count: 30 }]
    for (const params of attempts) {
      try {
        const raw = await onebot.call(action, params, { timeoutMs: 8000, retries: 0 })
        const hit = (raw?.messages || []).find((item) => String(item?.message_id ?? '') === id || String(item?.real_id ?? '') === id)
        if (hit) return hit
      } catch (error) {
        log?.debug?.(`引用消息历史也拉不到（${id}）：`, error.message)
      }
    }
    return null
  }

  async function get(replyId, ctx = null) {
    const id = String(replyId || '')
    if (!id) return null
    const chat = contextOf(ctx)
    const key = `${chat.chatId || `${chat.kind}:${chat.groupId || chat.userId}`}:${id}`
    if (cache.has(key)) return cache.get(key)
    let out = { ok: false, who: '', uid: '', text: '', images: [], stickers: [], media: [], records: 0, isBot: false, at: 0 }
    try {
      const raw = await onebot.call('get_msg', { message_id: Number(id) || id }, { timeoutMs: 5000, retries: 0 })
      const sender = raw?.sender || {}
      const uid = String(sender.user_id ?? raw?.user_id ?? '')
      const botId = String(selfId || getConfig()?.botQQ || '')
      const eventFor = (message, from = sender) => ({
        message_type: chat.kind,
        group_id: chat.groupId || undefined,
        user_id: uid,
        sender: from,
        message,
      })
      const options = typeof faceName === 'function' ? { faceName } : undefined
      let parsed = parseMessageEvent(eventFor(raw?.message ?? raw?.raw_message ?? ''), botId, options)
      if (needsHistory(parsed)) {
        const hit = await fromHistory(id, chat)
        if (hit) {
          const originalText = parsed.text
          const again = parseMessageEvent(eventFor(hit.message ?? '', hit.sender || sender), botId, options)
          if (!needsHistory(again)) parsed = { ...again, text: originalText || again.text }
          else {
            parsed.images = [...(parsed.images || []), ...(again.images || [])]
            parsed.stickers = [...(parsed.stickers || []), ...(again.stickers || [])]
          }
        }
      }
      const images = parsed.images || []
      const stickers = parsed.stickers || []
      out = {
        ok: true,
        who: String(sender.card || sender.nickname || uid || '某人'),
        uid,
        text: String(parsed.text || '').trim().slice(0, 300),
        images,
        stickers,
        media: [...images, ...stickers],
        records: (parsed.records || []).length,
        isBot: uid === botId || Boolean(isSentMessage?.(id)),
        at: Date.now(),
      }
    } catch (error) {
      log?.debug?.(`引用消息没拉到（${id}）：`, error.message)
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
    cache.set(key, out)
    return out
  }

  return { get }
}
