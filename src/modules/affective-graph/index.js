// 内置模块：情感记忆图谱（US-015 / 计划书 §八）。
//
// 关系演化要「有据可查」：信任等级只能被**可解释信号**推动，不允许随机跃迁。
// 此前 src/chat/affective-graph.js 是零引用死代码 —— 497 行、14 个单测全绿，
// 但生产代码从不调用，tone() 没有任何调用方。
//
// 接线口径（模块注释指明的生产接线点）：
// - 把当前会话的 ChatKey 作为 viewer 显式传入，避免跨 scope 越界读等级；
// - 消费 tone() 的 temperature / jokeScale 去调回复温度与玩笑尺度，
//   proactivePrivate 决定「该不该主动找这个人」。
//
// 本模块负责四件事：
//   1. 图 + 持久化 + 对外查询（toneFor / trustLevel）；
//   2. **信号喂料**（feed）：把一轮对话交给 affective-signals 挖成六种可解释信号再 bump，
//      同 chatKey 同 kind 有 10 分钟冷却，避免刷屏式加分把等级吹虚；
//   3. 面板可观测性：/affective/state 给出图规模、等级分布、最近信号（含被引用原话）；
//   4. 手动补录：/affective/bump（HTTP）。

import { createAffectiveGraph, SIGNAL_WEIGHTS, TRUST_LEVEL_LABELS } from '../../chat/affective-graph.js'
import { mineSignals, MIN_CONFIDENCE } from '../../chat/affective-signals.js'
import { isChatKey } from '../../chat/chat-key.js'
import { readJson, writeJson } from '../../core/store.js'

/** 同 chatKey 同 kind 的计分冷却：10 分钟内的重复命中不再加分（防刷屏虚高）。 */
export const SIGNAL_COOLDOWN_MS = 10 * 60_000

/** 面板「最近信号」默认条数。 */
export const RECENT_SIGNAL_LIMIT = 12

/** 等级分布的最大等级（0..2）。 */
const LEVEL_COUNT = TRUST_LEVEL_LABELS.length

export default {
  id: 'affective-graph',
  name: '情感图谱',
  version: '1.1.0',
  description: '按会话记录信任等级与专属梗词，给出回复温度与主动搭话建议；自动从对话里识别关系信号',
  tab: 'memory',
  files: ['chat/affective-graph.js', 'chat/affective-signals.js'],
  setup(api) {
    const file = () => api.dataDir('affective-graph.json')
    const graph = createAffectiveGraph({ now: () => Date.now() })

    // 恢复：坏节点由模块自身跳过（非法等级回退 0），这里只兜底异常
    try {
      const saved = readJson(file(), () => null)
      if (saved) graph.load(saved)
    } catch (error) {
      api.log?.warn?.('情感图谱载入失败（从空图开始）：', error?.message || error)
    }

    let dirty = false
    const persist = () => {
      if (!dirty) return
      try { writeJson(file(), graph.toJSON()); dirty = false }
      catch (error) { api.log?.warn?.('情感图谱落盘失败：', error?.message || error) }
    }
    api.every(60_000, persist, '情感图谱落盘')
    api.onDispose?.(persist)

    /** 冷却表：`${chatKey}\u0000${kind}` → 上次计分时间。只在 feed 里读写，随冷却窗口自动过期。 */
    const cooldown = new Map()

    /** 给一轮回复用的姿态建议（temperature / jokeScale）。非法 chatKey 一律退回中性。 */
    function toneFor(chatId) {
      try {
        const t = graph.tone(String(chatId || ''), { viewer: String(chatId || '') })
        return { ok: true, ...t }
      } catch (error) {
        // 跨 scope 越界或非法 key：不给任何特权，退回中性
        return { ok: false, level: 0, label: TRUST_LEVEL_LABELS[0], temperature: 'cool', jokeScale: 0.2, proactivePrivate: false }
      }
    }

    /** 宽松取数字：`valueOf` 抛错 / NaN / 字符串怪物一律回退默认值（绝不让它冒泡）。 */
    function safeNumber(value, fallback) {
      let n = NaN
      try { n = Number(value) } catch { n = NaN }
      return Number.isFinite(n) ? n : fallback
    }

    /** 宽松取 chatKey：非法/怪类型一律回退空串（模块层不猜作用域）。 */
    function safeKey(value) {
      let text = ''
      try { text = String(value ?? '').trim() } catch { return '' }
      if (!text) return ''
      return isChatKey(text) ? text : ''
    }

    /** 冷却键 + 过期清理（同一 chatKey/kind 在窗口内只算一次）。 */
    function coolingDown(chatKey, kind, at, windowMs) {
      const key = `${chatKey}\u0000${kind}`
      for (const [k, ts] of cooldown) if (at - ts >= windowMs) cooldown.delete(k) // 顺手清过期项，表不会无限长
      const last = cooldown.get(key)
      return typeof last === 'number' && at - last < windowMs
    }

    /**
     * 自动喂料：把一轮对话挖成信号再 bump。
     *
     * 永不抛错（调用方在回复投递收尾处，绝不允许影响投递）：
     * - 模块关着 / chatKey 非法 / 没有任何信号 → `{ ok: false }` + 原因，不产生副作用；
     * - bump 单个失败 → 记进 `failed`，其余信号照常记（一条坏信号不该拖垮整轮）；
     * - 冷却中的信号记进 `skipped`（面板可解释「为什么这条没加分」）。
     *
     * @param {object} input 同 `mineSignals`（chatKey / userText / botText / recentContext / now）
     * @param {number} [input.cooldownMs] 覆盖默认冷却窗口（测试与回放用）
     * @returns {{ok: boolean, applied: Array, skipped: Array, message?: string}}
     */
    function feed({ chatKey, userText, botText, recentContext, now, cooldownMs } = {}) {
      const out = { ok: false, applied: [], skipped: [] }
      // 整个入口包住：调用方在回复投递收尾处，记分失败绝不许变成"回复失败"
      try {
        return feedUnsafe({ chatKey, userText, botText, recentContext, now, cooldownMs }, out)
      } catch (error) {
        out.ok = false
        out.message = `信号喂料异常（已忽略）：${error?.message || error}`
        return out
      }
    }

    /** feed 的实际逻辑（异常由 feed 兜住）。 */
    function feedUnsafe({ chatKey, userText, botText, recentContext, now, cooldownMs }, out) {
      const chatId = safeKey(chatKey)
      if (!chatId) { out.message = '缺少合法 chatKey'; return out }
      const at = safeNumber(now, Date.now())
      const windowMs = Math.max(1, safeNumber(cooldownMs, SIGNAL_COOLDOWN_MS))
      let signals = []
      try {
        signals = mineSignals({ chatKey: chatId, userText, botText, recentContext, now: at })
      } catch (error) {
        out.message = `信号挖掘失败：${error?.message || error}`
        return out
      }
      // 确定性 + 保守：只认词表内、置信度过线的信号（mineSignals 已过滤，这里再兜一层）
      for (const signal of signals) {
        if (!signal || !Object.hasOwn(SIGNAL_WEIGHTS, signal.kind)) continue
        if (Number(signal.confidence) < (MIN_CONFIDENCE[signal.kind] ?? 1)) continue
        if (coolingDown(chatId, signal.kind, at, windowMs)) {
          out.skipped.push({ kind: signal.kind, note: signal.note, reason: '冷却中' })
          continue
        }
        try {
          graph.bump(chatId, { kind: signal.kind, note: signal.note }, { viewer: chatId })
          cooldown.set(`${chatId}\u0000${signal.kind}`, at)
          dirty = true
          out.applied.push({ kind: signal.kind, note: signal.note, confidence: signal.confidence })
        } catch (error) {
          // 单个信号失败（跨 scope / 非法键）：跳过，不污染其余信号
          out.skipped.push({ kind: signal.kind, note: signal.note, reason: String(error?.message || error) })
        }
      }
      out.ok = out.applied.length > 0
      if (!out.ok) out.message = out.message || (signals.length ? '全部信号都在冷却中' : '这一轮没有识别到关系信号')
      return out
    }

    /** 面板统计：图规模 + 等级分布 + 最近 N 条信号（含 note 原话）+ 各 kind 计数（均为只读快照）。 */
    function stats({ limit = RECENT_SIGNAL_LIMIT } = {}) {
      const snapshot = graph.toJSON()
      const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : []
      const levels = TRUST_LEVEL_LABELS.map((label, level) => ({
        level, label,
        count: nodes.filter((node) => node.level === level).length,
      }))
      const byKind = Object.fromEntries(Object.keys(SIGNAL_WEIGHTS).map((kind) => [kind, 0]))
      const recent = []
      for (const node of nodes) {
        for (const signal of Array.isArray(node.signals) ? node.signals : []) {
          if (Object.hasOwn(byKind, signal.kind)) byKind[signal.kind] += 1
          recent.push({
            chatKey: node.chatKey,
            kind: signal.kind,
            weight: signal.weight,
            note: String(signal.note || ''),
            at: Number(signal.at) || 0,
          })
        }
      }
      // 稳定排序：时间倒序，同时间按 chatKey/kind —— 面板刷新不会跳序
      recent.sort((a, b) => (b.at - a.at)
        || (a.chatKey < b.chatKey ? -1 : a.chatKey > b.chatKey ? 1 : 0)
        || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
      const max = Math.max(1, Math.min(50, Math.round(Number(limit) || RECENT_SIGNAL_LIMIT)))
      return {
        size: nodes.length,
        levels,
        signals: byKind,
        recent: recent.slice(0, max),
        recentTotal: recent.length,
      }
    }

    api.route('/affective/state', async (req) => {
      const chatId = String((req && req.query && req.query.chat) || '')
      const limit = Number((req && req.query && req.query.limit) || 0) || undefined
      const base = { ok: true, size: graph.size(), tone: null, ...stats({ limit }) }
      if (!chatId) return base
      // explain() 给出「为什么是这个等级」；越界/非法键按最小信息返回（图自己 fail-closed）
      let explain = null
      try { explain = graph.explain(chatId, { viewer: chatId }) } catch { explain = null }
      return { ...base, tone: toneFor(chatId), explain }
    })

    api.route('/affective/bump', async (req) => {
      if (req && req.method !== 'POST') return { ok: false, message: '请使用 POST 记录关系信号' }
      const body = (await api.core.http.body(req).catch(() => ({}))) || {}
      const chatId = String(body.chat || '')
      const kind = String(body.signal || '')
      if (!chatId || !Object.hasOwn(SIGNAL_WEIGHTS, kind)) {
        return { ok: false, message: `chat 与合法 signal 必填（可选：${Object.keys(SIGNAL_WEIGHTS).join('/')}）` }
      }
      try {
        const out = graph.bump(chatId, { kind, note: String(body.note || '') }, { viewer: chatId })
        dirty = true
        return { ok: true, ...out, tone: toneFor(chatId) }
      } catch (error) {
        return { ok: false, message: String(error?.message || error) }
      }
    })

    return { graph, toneFor, persist, dispose: persist, feed, stats }
  },
}