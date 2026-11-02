// 移植自 h-D-ACE/dsh-qq 的 slang-learner.js：群黑话本（Slang Learner）
//
// dsh-qq 的做法：从群聊里发现反复出现的陌生词（群梗、缩写、绰号），
// 生成候选词；管理员审核通过后才注入提示词，避免被乱码和噪声带偏。
//
// 这里同样分两步：自动收集候选 → 主人在面板/命令里批准 → 才进「交给她的话」。

import { readJson, writeJson, dataDir } from '../../core/store.js'

const ID = 'slang-learner'

/** 中英文分词：中文取连续 2~4 字，英文/数字取整词。 */
export function candidatesFrom(text) {
  const t = String(text || '')
  const out = new Set()
  for (const m of t.matchAll(/[\u4e00-\u9fa5]{2,6}/g)) {
    const w = m[0]
    if (w.length >= 2 && w.length <= 4) out.add(w)
  }
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9]{2,12}/g)) out.add(m[0].toLowerCase())
  return [...out]
}

/** 常见词白名单（不作为候选）。 */
const COMMON = new Set(['哈哈', '呵呵', '哈哈哈哈哈', '什么', '这个', '那个', '我们', '你们', '他们', '就是', '可以', '没有', '不是', '真的', '知道', '现在', '今天', '明天', '昨天', '时候', '一个', '这样', '那样', '怎么', '因为', '所以', '但是', '而且', '然后', '如果', '已经', '还是', '应该', '可能', '需要', '不要', '一直', '一样', '自己', '大家', '东西', '事情', '问题', '感觉', '觉得', '有点', '一点', '时候', '还', '嗯嗯', '哦哦', '好好', '收到'])

export default {
  id: ID,
  name: '群黑话本',
  version: '1.0.0',
  api: 1,
  description: '移植自 dsh-qq：自动收集群里反复出现的新词，批准后才让她学着用',
  panel: 'panel.js',
  tab: 'group',
  defaults: {
    enabled: true,
    /** 至少出现几次才算候选 */
    minCount: 3,
    /** 提示词里最多带几条 */
    maxInPrompt: 8,
  },
  settings: [
    { key: 'enabled', label: '启用黑话收集', type: 'switch' },
    { key: 'minCount', label: '至少出现几次', type: 'number', min: 2, max: 20, step: 1 },
    { key: 'maxInPrompt', label: '提示词里最多几条', type: 'number', min: 0, max: 20, step: 1 },
  ],
  setup(api) {
    const file = () => dataDir('slang.json')
    // { counts: { 群号: { 词: 次数 } }, approved: { 群号: { 词: { meaning, at } } } }
    let db = readJson(file(), { counts: {}, approved: {} })
    const save = () => { try { writeJson(file(), db) } catch (error) { api.log.warn('保存黑话本失败：', error.message) } }

    api.on('activity', (a) => {
      if (!api.settings().enabled) return
      if (!a || a.kind !== 'in' || !String(a.chatId || '').startsWith('group:')) return
      if (!a.text || String(a.userId) === String(api.core?.hub?.selfId || '')) return
      const gid = String(a.chatId).slice(6)
      const bucket = (db.counts[gid] ||= {})
      for (const w of candidatesFrom(a.text)) {
        if (COMMON.has(w)) continue
        bucket[w] = (bucket[w] || 0) + 1
      }
      // 控制体积：只留前 200 个
      const keys = Object.keys(bucket)
      if (keys.length > 200) {
        const sorted = keys.sort((x, y) => bucket[y] - bucket[x]).slice(0, 200)
        db.counts[gid] = Object.fromEntries(sorted.map((k) => [k, bucket[k]]))
      }
    })

    const pending = (gid) => {
      const counts = db.counts[gid] || {}
      const approved = db.approved[gid] || {}
      const min = Number(api.settings().minCount)
      return Object.entries(counts)
        .filter(([w, n]) => n >= min && !approved[w])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([w, n]) => ({ word: w, count: n }))
    }

    api.command({
      name: 'slang',
      desc: '看 / 批准群里的黑话：/slang 看候选，/slang 通过 词 意思是 这样',
      aliases: ['黑话', '梗'],
      run: async (arg, msg) => {
        if (!api.isOwner(msg.userId)) return '只有主人能管黑话本'
        if (msg.kind !== 'group') return '这个命令要在群里用'
        const gid = String(msg.groupId)
        const list = pending(gid)
        const text = String(arg || '').trim()
        if (!text) {
          if (!list.length) return '这个群暂时没有新候选词'
          return '候选：\n' + list.map((x) => `${x.word}（${x.count} 次）`).join('\n') + '\n批准：/slang 通过 词 意思是…'
        }
        const m = text.match(/^(?:通过|批准)\s*(\S+)\s*([\s\S]*)$/)
        if (!m) return '用法：/slang 通过 词 意思是 这样用'
        const word = m[1]
        const meaning = m[2].trim().slice(0, 60)
        ;(db.approved[gid] ||= {})[word] = { meaning, at: Date.now() }
        save()
        api.log.info(`[黑话本] 群 ${gid} 批准「${word}」：${meaning || '（没写意思）'}`)
        return `记住了：${word}${meaning ? ' —— ' + meaning : ''}`
      },
    })

    api.command({
      name: 'slangdel',
      desc: '从黑话本里删掉一个词：/slangdel 词',
      aliases: ['删黑话'],
      run: async (arg, msg) => {
        if (!api.isOwner(msg.userId)) return '只有主人能管黑话本'
        if (msg.kind !== 'group') return '这个命令要在群里用'
        const gid = String(msg.groupId)
        const w = String(arg || '').trim()
        if (!w) return '用法：/slangdel 词'
        delete (db.approved[gid] || {})[w]
        delete (db.counts[gid] || {})[w]
        save()
        return `删掉了：${w}`
      },
    })

    // 群里聊天时把本群已批准的黑话带上（别的群的不会串过来）
    api.on('prompt', (content, info) => {
      const cfg = api.settings()
      if (!cfg.enabled || !info?.chat || info.chat.kind !== 'group' || !Array.isArray(content)) return content
      const approved = db.approved[String(info.chat.groupId)] || {}
      const entries = Object.entries(approved).slice(0, Number(cfg.maxInPrompt))
      if (!entries.length) return content
      const body = entries.map(([w, v]) => `${w}${v.meaning ? '：' + v.meaning : ''}`).join('；')
      return [{ type: 'text', text: `（这个群的黑话，看懂了就用，别硬拗：${body}）` }, ...content]
    })

    api.route('/list', (req) => {
      const gid = String(req?.query?.gid || '')
      if (gid) return { ok: true, gid, pending: pending(gid), approved: db.approved[gid] || {} }
      return { ok: true, groups: Object.keys(db.approved), pendingCounts: Object.fromEntries(Object.keys(db.counts).map((g) => [g, pending(g).length])) }
    })
    api.route('/approve', (req) => {
      const gid = String(req?.query?.gid || '')
      const word = String(req?.query?.word || '')
      const meaning = String(req?.query?.meaning || '')
      if (!gid || !word) return { ok: false, message: '缺参数' }
      ;(db.approved[gid] ||= {})[word] = { meaning, at: Date.now() }
      save()
      return { ok: true }
    })

    return { pending, approved: (gid) => db.approved[String(gid)] || {}, candidatesFrom }
  },
}
