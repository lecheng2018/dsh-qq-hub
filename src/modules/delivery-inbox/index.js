// 内置模块：投递异常收件箱（只读）。
//
// 为什么要有它：投递台账（deliveries.json）从 PR-1 起就会把失败如实记成
// `unknown` / `failed` / `cancelled`（含理由），但这些状态**一直没有出口** ——
// 只在日志里刷一行、只在返回值里带个计数。结果是「记了没人看」：
// 消息丢了、她以为发了，主人也不知道。
//
// 设计取舍（都往"不误导"的方向偏）：
//   · **只读**：不给「重发」按钮。`unknown` 的定义就是「可能已经发出去了」，
//     重发就是赌用户会不会收到两条一样的消息 —— 这种决定必须人来做，不该做成一个按钮。
//   · **默认只看异常**：正常 `sent` 不进来，否则一屏全是成功噪音，真正要看的被淹没。
//   · **内容打码到可辨认为止**：只给前 N 字，够认出是哪条消息就行，不在面板里摊全文。
//   · **读不到就说读不到**：文件缺失/损坏时明确告知，绝不显示成「今天没有异常」。
//     （把"读失败"显示成"没问题"是这类面板最容易犯的错。）

import { readJson } from '../../core/store.js'

/** 面板/接口里最多列多少条。台账本身有容量上限，这里再收一道，避免把一屏撑爆。 */
const MAX_ITEMS = 50
/** 单条消息正文最多展示多少字（够认出是哪条即可）。 */
const PREVIEW_CHARS = 60
/** 这些状态算「异常」：需要主人知道，但不需要（也不该）自动重发。 */
const ATTENTION_STATES = Object.freeze(['unknown', 'failed', 'cancelled'])

/** 从段落里抽一段可辨认的正文预览（不摊全文）。 */
function previewOf(segments) {
  const parts = []
  for (const seg of Array.isArray(segments) ? segments : []) {
    const t = seg?.type
    if (t === 'text' && typeof seg?.data?.text === 'string') parts.push(seg.data.text)
    else if (t === 'image') parts.push('[图片]')
    else if (t === 'record' || t === 'voice') parts.push('[语音]')
    else if (t === 'face') parts.push('[表情]')
    else if (t === 'at') parts.push(`@${seg?.data?.qq ?? '?'}`)
    else if (t === 'reply') parts.push('[引用]')
    else if (typeof t === 'string' && t) parts.push(`[${t}]`)
  }
  const joined = parts.join('').replace(/\s+/g, ' ').trim()
  if (!joined) return ''
  const chars = Array.from(joined)
  return chars.length > PREVIEW_CHARS ? chars.slice(0, PREVIEW_CHARS).join('') + '…' : joined
}

/** 解析 limit：只有正数才当真，且不超过 MAX_ITEMS；其余一律回默认。 */
function limitOf(limit) {
  const n = Number(limit)
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_ITEMS, Math.floor(n)) : MAX_ITEMS
}

/** 这条记录该展示哪个失败理由（不同终态记在不同字段）。 */
function reasonOf(rec) {
  return String(rec?.unknownReason || rec?.failReason || rec?.cancelReason || '').trim()
}

/** 哪一刻进入这个终态的（用于排序与展示）。 */
function happenedAtOf(rec) {
  const t = Number(rec?.unknownAt || rec?.failedAt || rec?.cancelledAt || rec?.createdAt || 0)
  return Number.isFinite(t) && t > 0 ? t : 0
}

/**
 * 把一份台账文档整理成面板要的形状。纯函数，便于单测。
 * @param {object|null} doc deliveries.json 的内容（{version, savedAt, deliveries}）
 * @param {{limit?: number}} [opts]
 */
export function summarizeDeliveries(doc, { limit = MAX_ITEMS } = {}) {
  // 读不到 / 结构不对：明确报告「读不到」，绝不伪装成「没有异常」。
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.deliveries)) {
    return { ok: false, reason: 'deliveries-unreadable', items: [], counts: {}, total: 0 }
  }
  const all = doc.deliveries.filter((r) => r && typeof r === 'object')
  const counts = {}
  for (const r of all) counts[r.state] = (counts[r.state] || 0) + 1
  const items = all
    .filter((r) => ATTENTION_STATES.includes(r.state))
    .map((r) => ({
      deliveryId: String(r.deliveryId || ''),
      chatKey: String(r.chatKey || ''),
      state: String(r.state || ''),
      at: happenedAtOf(r),
      attemptCount: Number(r.attemptCount) || 0,
      // 发送方（core / 某个扩展模块）：排查"是谁发的"第一眼要看这个。
      source: String(r.sourceModuleId || ''),
      action: String(r.action || ''),
      note: String(r.note || ''),
      reason: reasonOf(r),
      preview: previewOf(r.segments),
      contentChars: Number(r.contentChars) || 0,
    }))
    .sort((a, b) => b.at - a.at)
    // 非正数/非法值一律回默认，而不是夹成 1 —— 「limit: -3 只给 1 条」是个没人想要的惊喜。
    .slice(0, limitOf(limit))
  return { ok: true, savedAt: Number(doc.savedAt) || 0, items, counts, total: all.length }
}

export default {
  id: 'delivery-inbox',
  name: '投递异常',
  version: '1.0.0',
  description: '只读查看没送出去/不确定送达的消息（不提供重发）',
  tab: 'memory',
  files: ['chat/delivery-ledger.js'],
  setup(api) {
    const file = () => api.dataDir('deliveries.json')

    api.route('/deliveries/exceptions', async (req) => {
      const q = (req && req.query) || {}
      const limit = Number(q.limit)
      let doc = null
      try {
        doc = readJson(file(), null)
      } catch (error) {
        api.log?.warn?.('投递台账读取失败：', error?.message || error)
      }
      const out = summarizeDeliveries(doc, { limit: Number.isFinite(limit) && limit > 0 ? limit : MAX_ITEMS })
      // 把文件路径一并带出去：真排查时主人需要知道去哪儿看原文件。
      return { ...out, file: file() }
    })

    return {}
  },
}
