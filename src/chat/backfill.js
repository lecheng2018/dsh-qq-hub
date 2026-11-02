// 断线消息补收系统（Backfill）：连接恢复后自动拉取断线期间错过的 QQ 消息
//
// 痛点场景：
// 电脑睡眠/合盖、网络闪断、NapCat/OneBot 重启期间，QQ 会漏掉别人 @ 或私聊的消息。
// 恢复后由插件自动通过 OneBot 的 get_group_msg_history / get_friend_msg_history 补收。
//
// 安全保障：
// 1. 补收到的消息注入提示给 AI「这是断线期间错过的消息，带原始时间」；
// 2. 补收消息严禁执行任何管理命令、审批放行或确认码（防止重放攻击）；
// 3. 超过 maxAgeMinutes（默认 6 小时）的过旧消息只落上下文不主动唤醒。

import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from '../core/store.js'

export const BACKFILL_DEFAULTS = Object.freeze({
  enabled: true,
  gapMs: 120_000,          // 两次事件包间隔超过此值判定为断线（默认 2 分钟）
  settleMs: 10_000,        // 恢复连接后等待网络稳定的时间（默认 10 秒）
  maxAgeMinutes: 360,      // 最多补收几分钟内的消息（默认 6 小时）
  maxPerConversation: 50,  // 每个会话最多补收几条
  lookbackMs: 60_000,      // 额外往前多看 1 分钟，防止临界丢失
})

export function normalizeBackfillConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const num = (v, min, max, d) => (Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : d)
  return {
    enabled: c.enabled !== false,
    gapMs: Math.round(num(c.gapMs, 30_000, 3_600_000, BACKFILL_DEFAULTS.gapMs)),
    settleMs: Math.round(num(c.settleMs, 0, 120_000, BACKFILL_DEFAULTS.settleMs)),
    maxAgeMinutes: num(c.maxAgeMinutes, 5, 7 * 24 * 60, BACKFILL_DEFAULTS.maxAgeMinutes),
    maxPerConversation: Math.round(num(c.maxPerConversation, 1, 100, BACKFILL_DEFAULTS.maxPerConversation)),
    lookbackMs: Math.round(num(c.lookbackMs, 0, 600_000, BACKFILL_DEFAULTS.lookbackMs)),
  }
}

/**
 * 记录上一次收到 OneBot 数据包的时间，发现断档
 */
export function createUpstreamGapTracker({ file = dataDir('upstream-seen.json'), gapMs = BACKFILL_DEFAULTS.gapMs, now = Date.now, onError = () => {} } = {}) {
  let last = 0
  let savedAt = 0
  try {
    const raw = fs.readFileSync(file, 'utf8')
    last = Number(JSON.parse(raw)?.lastPacketAt) || 0
  } catch (error) {
    if (error?.code !== 'ENOENT') onError(error)
  }

  function save(t) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ lastPacketAt: t }), { encoding: 'utf8', mode: 0o600 })
      fs.renameSync(tmp, file)
      savedAt = t
    } catch (error) {
      onError(error)
    }
  }

  return {
    notePacket(threshold = gapMs) {
      const t = now()
      const prev = last
      last = t
      const gap = prev ? t - prev : 0
      if (gap > threshold) {
        save(t)
        return { since: prev, gapMs: gap }
      }
      if (t - savedAt >= 60_000) save(t)
      return null
    },
    lastPacketAt: () => last,
    reset(t = now()) {
      last = t
      save(t)
    }
  }
}

/**
 * 最近处理过的消息 ID 去重缓存
 */
export function createSeenMessageIds({ max = 1000 } = {}) {
  const byKey = new Map()
  return {
    add(key, id) {
      if (id == null || id === '') return
      let set = byKey.get(key)
      if (!set) {
        set = new Set()
        byKey.set(key, set)
      }
      set.add(String(id))
      if (set.size > max) {
        for (const old of set) {
          set.delete(old)
          if (set.size <= max) break
        }
      }
    },
    has(key, id) {
      return id != null && Boolean(byKey.get(key)?.has(String(id)))
    },
    clear() {
      byKey.clear()
    }
  }
}

/**
 * 补收时严禁执行的消息（命令/动态码/审批指令）
 */
export function isCommandLike(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  if (t.startsWith('/') || t.startsWith('／')) return true
  if (/^\d{4,8}$/.test(t)) return true // TOTP 动态码
  if (/^(?:#?\d{1,6}\s*)?(通过|同意|允许|放行|批准|拒绝|驳回|取消|不行|拦下|pass|yes|no|y|n|ok|deny)(?:\s*#?\d{1,6})?\s*[。.!！]?$/i.test(t)) return true
  return false
}

export function plainTextOf(message) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  return message.filter((s) => s?.type === 'text').map((s) => String(s.data?.text ?? '')).join('')
}

/**
 * 从历史记录中筛选要补收的消息
 */
export function selectBackfill(messages, { key, since, now = Date.now(), selfId, seen, config } = {}) {
  const c = normalizeBackfillConfig(config)
  const from = Number(since) - c.lookbackMs
  const maxAgeMs = c.maxAgeMinutes * 60_000
  const items = []
  const skippedCommands = []
  const uniq = new Set()

  for (const m of Array.isArray(messages) ? messages : []) {
    const t = Number(m?.time) * 1000
    if (!Number.isFinite(t) || t < from || t > now + 60_000) continue
    const self = selfId ?? m?.self_id
    if (self != null && String(m?.user_id ?? m?.sender?.user_id ?? '') === String(self)) continue // 过滤自己发的
    const id = m?.message_id ?? m?.real_id
    if (id != null && (uniq.has(String(id)) || seen?.has(key, id))) continue
    if (id != null) uniq.add(String(id))

    const ageMs = Math.max(0, now - t)
    const item = { event: m, timeMs: t, ageMs, tooOld: ageMs > maxAgeMs }
    const text = plainTextOf(m?.message ?? m?.raw_message)

    if (isCommandLike(text)) {
      skippedCommands.push({ ...item, text })
    } else {
      items.push(item)
    }
  }

  items.sort((a, b) => a.timeMs - b.timeMs)
  return {
    items: items.slice(-c.maxPerConversation),
    skippedCommands
  }
}

export function describeDuration(ms) {
  const min = Math.max(1, Math.round(Number(ms) / 60_000))
  if (min < 60) return `约 ${min} 分钟`
  const h = Math.floor(min / 60)
  const m = min % 60
  return `约 ${h} 小时${m ? ` ${m} 分` : ''}`
}

export function backfillNoticeBlock({ gapMs, count, earliestAgeMs }) {
  return `【补收提示】机器人与 QQ 断开连接${describeDuration(gapMs)}。以下 ${count} 条消息是断线期间错过的，刚从历史记录补收（最早一条在${describeDuration(earliestAgeMs)}前）。请看原始时间正常回复，可以自然说明刚看到，不要假装是刚发的。`
}
