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
// 本模块只负责「图 + 持久化 + 对外查询」，实际信号由下游调用方 bump。

import { createAffectiveGraph, SIGNAL_WEIGHTS, TRUST_LEVEL_LABELS } from '../../chat/affective-graph.js'
import { readJson, writeJson } from '../../core/store.js'

export default {
  id: 'affective-graph',
  name: '情感图谱',
  version: '1.0.0',
  description: '按会话记录信任等级与专属梗词，给出回复温度与主动搭话建议',
  tab: 'memory',
  files: ['chat/affective-graph.js'],
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

    api.route('/affective/state', async (req) => {
      const chatId = String((req && req.query && req.query.chat) || '')
      if (!chatId) return { ok: true, size: graph.size(), tone: null }
      return { ok: true, size: graph.size(), tone: toneFor(chatId) }
    })

    api.route('/affective/bump', async (req) => {
      if (req && req.method !== 'POST') return { ok: false, message: '请使用 POST 记录关系信号' }
      const body = (await api.core.http.body(req)) || {}
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

    return { graph, toneFor, persist }
  },
}
