// 索引记忆库：本地 JSON 存储 + 倒排索引（中文按二元字组切词，英文数字按词）+ BM25 打分，
// 再叠加「关于当前说话人」「重要程度」「新近程度」的加权。不依赖外部向量库，几千条也是毫秒级。
//
// 记忆来源：她自己调 remember 工具记的、后台从聊天里自动提炼的、主人在面板里手动加的。
// 召回时机：每一轮回复前，用「这一轮对方说的话」检索最相关的几条，作为上下文悄悄告诉她。

import { randomUUID } from 'node:crypto'
import { dataDir, readJson, writeJson } from '../core/store.js'
import { askModel } from '../core/llm.js'

// ---------------- 纯函数：切词与打分 ----------------

const STOP = new Set('的了是我你他她它们在有和就不也都很吗吧呢啊呀哦嗯这那个一上下来去说要会能着过'.split(''))

/** 切词：英文/数字整词；中文连续段拆成二元字组（单字段保留单字，去掉停用字）。 */
export function tokenize(text) {
  const out = []
  const s = String(text || '').toLowerCase()
  for (const m of s.matchAll(/[a-z0-9_]{2,}|[一-鿿]+/g)) {
    const w = m[0]
    if (/^[a-z0-9_]+$/.test(w)) { out.push(w); continue }
    if (w.length === 1) { if (!STOP.has(w)) out.push(w); continue }
    for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2))
  }
  return out
}

/** 两段文字有多像（字组 Jaccard），用于去重。 */
export function similarity(a, b) {
  const A = new Set(tokenize(a))
  const B = new Set(tokenize(b))
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

/** 建索引：返回 { docs, df, avgLen }。 */
export function buildIndex(items) {
  const df = new Map()
  const docs = items.map((it) => {
    const toks = tokenize(`${it.text} ${(it.tags || []).join(' ')} ${it.aboutName || ''}`)
    const tf = new Map()
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1)
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1)
    return { it, tf, len: toks.length || 1 }
  })
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1)
  return { docs, df, avgLen, N: docs.length }
}

/**
 * 检索。
 * @param idx buildIndex() 的结果
 * @param {string} query
 * @param {{about?:string, now?:number, limit?:number, minScore?:number}} [o]
 */
export function search(idx, query, o = {}) {
  const q = [...new Set(tokenize(query))]
  const now = o.now ?? Date.now()
  const k1 = 1.4
  const b = 0.7
  const scored = []
  for (const d of idx.docs) {
    let s = 0
    for (const t of q) {
      const f = d.tf.get(t)
      if (!f) continue
      const n = idx.df.get(t) || 0
      const idf = Math.log(1 + (idx.N - n + 0.5) / (n + 0.5))
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / idx.avgLen))
    }
    const it = d.it
    const aboutHit = o.about && it.about && String(it.about) === String(o.about)
    if (s <= 0 && !aboutHit) continue
    const ageDays = Math.max(0, (now - (it.at || now)) / 86400_000)
    const recency = 1 / (1 + ageDays / 30) // 一个月前的记忆权重减半
    const importance = 0.6 + 0.8 * (Number(it.importance) || 0.5)
    const score = (s + (aboutHit ? 0.8 : 0)) * importance * (0.6 + 0.4 * recency)
    scored.push({ it, score })
  }
  scored.sort((x, y) => y.score - x.score)
  return scored.filter((x) => x.score >= (o.minScore ?? 0.35)).slice(0, o.limit ?? 6)
}

// ---------------- 记忆库 ----------------

/** 解析「回顾」的模型输出：{insights:[], style:[]}；老格式的纯数组当作 insights。 */
export function parseReflection(out) {
  const str = (t) => String(typeof t === 'string' ? t : t?.text || '').trim()
  const obj = String(out || '').match(/\{[\s\S]*\}/)
  if (obj) {
    try {
      const j = JSON.parse(obj[0])
      if (Array.isArray(j.insights) || Array.isArray(j.style)) {
        return { insights: (j.insights || []).map(str).filter(Boolean), style: (j.style || []).map(str).filter(Boolean) }
      }
    } catch (error) {}
  }
  const arr = String(out || '').match(/\[[\s\S]*\]/)
  try {
    return { insights: arr ? JSON.parse(arr[0]).map(str).filter(Boolean) : [], style: [] }
  } catch (error) {
    return { insights: [], style: [] }
  }
}

export function createMemoryStore({ dsh, getConfig, hub, log }) {
  const file = () => dataDir('memories.json')
  const load = () => readJson(file(), () => ({ items: [] }))
  const save = (s) => {
    writeJson(file(), s)
    cache = null
  }
  let cache = null // { stamp, idx }
  const index = () => {
    const s = load()
    const stamp = s.items.length + ':' + (s.items.at(-1)?.id || '') + ':' + (s.rev || 0)
    if (!cache || cache.stamp !== stamp) cache = { stamp, idx: buildIndex(s.items) }
    return cache.idx
  }

  function add({ text, about = '', aboutName = '', tags = [], importance = 0.5, source = 'tool', chatId = '' }) {
    const t = String(text || '').trim().slice(0, 200)
    if (!t) return { ok: false, message: '内容是空的' }
    const s = load()
    // 去重：很像的就更新旧的（时间、重要程度取新），不重复存
    const dup = s.items.find((m) => similarity(m.text, t) >= 0.6 && (!about || !m.about || m.about === String(about)))
    if (dup) {
      dup.text = t.length >= dup.text.length ? t : dup.text
      dup.at = Date.now()
      dup.importance = Math.max(Number(dup.importance) || 0, Number(importance) || 0)
      s.rev = (s.rev || 0) + 1
      save(s)
      return { ok: true, message: '✓', updated: dup.id }
    }
    const item = { id: randomUUID().slice(0, 8), text: t, about: String(about || ''), aboutName: String(aboutName || ''), tags: (tags || []).slice(0, 5), importance: Math.max(0, Math.min(1, Number(importance) || 0.5)), source, chatId, at: Date.now(), hits: 0 }
    s.items.push(item)
    if (s.items.length > 3000) s.items = s.items.sort((a, b) => (b.importance - a.importance) || (b.at - a.at)).slice(0, 3000)
    save(s)
    return { ok: true, message: '✓', id: item.id }
  }

  function update(id, patch) {
    const s = load()
    const m = s.items.find((x) => x.id === id)
    if (!m) return { ok: false, message: '没有这条' }
    for (const k of ['text', 'about', 'aboutName', 'tags', 'importance']) if (patch[k] !== undefined) m[k] = patch[k]
    s.rev = (s.rev || 0) + 1
    save(s)
    return { ok: true, item: m }
  }

  function remove(id) {
    const s = load()
    s.items = s.items.filter((m) => m.id !== id)
    s.rev = (s.rev || 0) + 1
    save(s)
    return { ok: true }
  }

  function recall(query, { about, limit } = {}) {
    const hits = search(index(), query, { about, limit: limit ?? getConfig().memory.recallCount })
    if (hits.length) {
      const s = load()
      for (const h of hits) {
        const m = s.items.find((x) => x.id === h.it.id)
        if (m) { m.hits = (m.hits || 0) + 1; m.lastHit = Date.now() }
      }
      writeJson(file(), s) // 只改命中计数，不动索引
    }
    return hits
  }

  // ---------- 相处经验：按人（私聊按 QQ 号，群按群）归类的、概括性的「怎么和 TA 相处」，越聊越懂 ----------
  const personKey = (chat) => (chat.kind === 'group' ? `group:${chat.groupId}` : chat.userId ? `qq:${chat.userId}` : '')
  function insightsOf(key) {
    return (load().insights || {})[key] || []
  }
  function setInsights(key, list, name) {
    const s = load()
    s.insights = s.insights || {}
    s.insightNames = s.insightNames || {}
    s.insights[key] = list.slice(0, 8)
    if (name) s.insightNames[key] = name
    s.rev = (s.rev || 0) + 1
    save(s)
  }

  // ---------- 说话方式：聊久了潜移默化学到的（对方的说话习惯 + 她自己慢慢养成的说法） ----------
  function styleOf(key) {
    return (load().styles || {})[key] || []
  }
  function setStyle(key, list) {
    const s = load()
    s.styles = s.styles || {}
    s.styles[key] = list.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, key === 'self' ? 6 : 5)
    s.rev = (s.rev || 0) + 1
    save(s)
  }

  /** 给系统提示词上下文用：相处经验（常驻）+ 按这一轮对方说的话检索到的记忆。 */
  function contextFor(chat, sessionId) {
    const cfg = getConfig().memory
    if (!cfg.enabled) return ''
    const parts = []
    const ins = insightsOf(personKey(chat))
    if (ins.length) parts.push('（和' + (chat.kind === 'group' ? '这个群' : '对方') + '相处的经验，照着做就好，不用说出来：' + ins.map((x) => x.text).join('；') + '）')
    const sty = styleOf(personKey(chat))
    const self = styleOf('self')
    if (sty.length || self.length) {
      parts.push('（说话方式：' + [sty.length ? '和' + (chat.kind === 'group' ? '这个群' : '对方') + '聊久了，' + sty.join('；') : '', self.length ? '你平时不知不觉会用的说法：' + self.join('、') : ''].filter(Boolean).join('。') + '。自然带一点就好，别刻意模仿，也别变成另一个人。）')
    }
    const q = hub?.lastTextOf?.(sessionId) || ''
    if (q) {
      const hits = recall(q, { about: chat.userId })
      if (hits.length) parts.push('（你记得这些事，聊到相关的就自然用上，别说「根据记忆」：' + hits.map((h) => (h.it.aboutName ? `[${h.it.aboutName}] ` : '') + h.it.text).join('；') + '）')
    }
    return parts.join('\n')
  }

  /** 回顾：结合最近聊天和已有经验，更新这个人的相处经验（合并、提炼、最多 8 条，概括不琐碎）。 */
  async function reflect(chat, transcript) {
    const key = personKey(chat)
    if (!key) return 0
    const old = insightsOf(key)
    const oldStyle = styleOf(key)
    const who = chat.kind === 'group' ? '这个群' : '对方'
    const out = await askModel(dsh, {
      cfg: getConfig(),
      system: '你是「大肥鱼」，在回顾自己和' + who + '的相处。输出一个 JSON 对象 {"insights":[...],"style":[...]}。\n'
        + 'insights：「怎么相处更好」的经验。概括性的、可复用的相处之道（比如「他累的时候不想多聊，简单安慰就好」「喜欢被吐槽，不喜欢太正经」），不要记具体事件和事实细节；和已有经验重复的合并，过时或被证伪的删掉，不超过 8 条，每条不超过 30 字。\n'
        + 'style：' + who + '的说话方式，以及你和' + who + '聊天时可以自然贴近的地方（比如「消息很短，常一句话分几条发」「爱用“hhh”和“草”」「不爱用标点」「喜欢叠字」），只写说话的形式和习惯，不写内容；不超过 5 条，每条不超过 30 字。\n'
        + '只输出这个 JSON 对象。',
      text: `已有经验：\n${old.map((x) => '- ' + x.text).join('\n') || '（还没有）'}\n\n已记下的说话方式：\n${oldStyle.map((x) => '- ' + x).join('\n') || '（还没有）'}\n\n最近的聊天：\n${transcript}`,
      maxTokens: 1500,
      temperature: 0.3,
    })
    const { insights: rawIns, style: rawStyle } = parseReflection(out)
    if (rawStyle.length) setStyle(key, rawStyle)
    const arr = rawIns.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 8)
    if (!arr.length) return 0
    const now = Date.now()
    setInsights(key, arr.map((text) => old.find((x) => x.text === text) || { id: randomUUID().slice(0, 8), text, at: now }), chat.nickname || chat.groupId || '')
    log.info(`更新了和 ${key} 相处的经验（${arr.length} 条）`)
    return arr.length
  }

  // ---------- 每日整理：临时记忆（各会话的聊天流水）→ 长期记忆 + 相处经验，整理完清空 ----------
  // 各个 DSH 会话自己的对话上下文不动；这里只处理插件记下的聊天流水。

  /** 从一段聊天里提炼长期记忆，并回顾相处经验。lines：[{who, text}] */
  async function extractLines(chatId, lines) {
    const talk = lines.filter((l) => l.text && !String(l.text).startsWith('【系统'))
    if (talk.filter((l) => l.who !== 'bot').length < 3) return { ok: false, message: '聊天太少', added: 0, insights: 0 }
    try {
      // 太长就分段，每段最多 80 行
      const chunks = []
      for (let i = 0; i < talk.length; i += 80) chunks.push(talk.slice(i, i + 80))
      let n = 0
      let transcript = ''
      for (const part of chunks.slice(-3)) {
        transcript = part.map((l) => `${l.who === 'bot' ? '我' : l.who}：${l.text}`).join('\n')
        n += await extractFacts(chatId, transcript)
      }
      log.info(`从 ${chatId} 的聊天里提炼了 ${n} 条新记忆`)
      // 顺便回顾一次相处经验（用全天的聊天，最多最近 120 行）
      let ins = 0
      try {
        const [kind, id] = chatId.split(':')
        const chat = kind === 'group' ? { kind, groupId: id, nickname: '' } : { kind: 'private', userId: id, nickname: talk.filter((l) => l.who !== 'bot').at(-1)?.who || '' }
        ins = await reflect(chat, talk.slice(-120).map((l) => `${l.who === 'bot' ? '我' : l.who}：${l.text}`).join('\n'))
      } catch (error) {
        log.warn('回顾相处经验失败：', error.message)
      }
      return { ok: true, added: n, insights: ins }
    } catch (error) {
      log.warn('提炼记忆失败：', error.message)
      return { ok: false, message: error.message, added: 0, insights: 0 }
    }
  }

  async function extractFacts(chatId, transcript) {
    const out = await askModel(dsh, {
      cfg: getConfig(),
      system: '你帮一个叫「大肥鱼」的聊天角色整理长期记忆。从对话里挑出以后值得记住的事实：对方的名字/称呼、喜好、讨厌的东西、身份、约定、重要经历、你们之间的关系变化。不要记寒暄、日常琐事、一次性的问答；不要记大肥鱼自己的人设和喜好（她本来就知道），只记关于别人、以及你们之间的事。每条一句话，主语写清楚是谁。只输出 JSON 数组，例如 [{"text":"小明喜欢吃辣","about":"小明","importance":0.6}]，没有值得记的就输出 []。',
      text: transcript,
      maxTokens: 1500,
      temperature: 0.2,
    })
    const m = out.match(/\[[\s\S]*\]/)
    const arr = m ? JSON.parse(m[0]) : []
    let n = 0
    for (const x of arr.slice(0, 10)) {
      if (!x || !x.text) continue
      if (/^(我|大肥鱼)/.test(String(x.about || '')) || String(x.about || '') === '大肥鱼') continue
      const about = chatId.startsWith('private:') ? chatId.slice(8) : ''
      const r = add({ text: x.text, aboutName: x.about || '', about, importance: x.importance ?? 0.5, source: 'auto', chatId })
      if (r.ok && r.id) n++
    }
    return n
  }

  const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  let busy = false

  /**
   * 整理临时记忆。
   * @param {{includeToday?:boolean}} o includeToday：连今天的也提炼（手动整理时），但今天的流水不删（写日记还要用）
   */
  async function consolidate(o = {}) {
    if (busy) return { ok: false, message: '正在整理中' }
    busy = true
    const today = dayKey()
    let added = 0
    let insights = 0
    let days = 0
    try {
      for (const day of hub.chatLogDays()) {
        if (day > today || (day === today && !o.includeToday)) continue
        // 同一天整理过一部分的（比如下午那次），只处理之后新增的聊天
        const done = (load().processed || {})[day] || 0
        const all = hub.chatLogOf(day)
        const byChat = new Map()
        for (const l of all.slice(done)) {
          if (String(l.chatId).startsWith('system:')) continue
          if (!byChat.has(l.chatId)) byChat.set(l.chatId, [])
          byChat.get(l.chatId).push(l)
        }
        for (const [chatId, lines] of byChat) {
          const r = await extractLines(chatId, lines)
          added += r.added || 0
          insights += r.insights ? 1 : 0
        }
        const s = load()
        s.processed = s.processed || {}
        if (day < today) {
          hub.deleteChatLog(day) // 整理完清空（今天的留着，写日记还要用）
          delete s.processed[day]
        } else {
          s.processed[day] = all.length
        }
        save(s)
        days++
      }
      if (days) await learnSelfStyle()
      const s = load()
      s.lastConsolidate = { day: today, at: Date.now(), added, insights, days }
      save(s)
      log.info(`整理临时记忆：处理了 ${days} 天，新增 ${added} 条长期记忆，更新了 ${insights} 份相处经验`)
      return { ok: true, added, insights, days, message: `整理好了：新增 ${added} 条记忆，更新 ${insights} 份相处经验` }
    } catch (error) {
      log.warn('整理临时记忆失败：', error.message)
      return { ok: false, message: error.message }
    } finally {
      busy = false
    }
  }

  /** 从各人的说话方式里，沉淀出几条她自己不知不觉学会的说法（很少、很淡）。 */
  async function learnSelfStyle() {
    const s = load()
    const pool = Object.entries(s.styles || {}).filter(([k]) => k !== 'self').flatMap(([, v]) => v)
    if (pool.length < 3) return
    try {
      const out = await askModel(dsh, {
        cfg: getConfig(),
        system: '你是「大肥鱼」。下面是你和不同的人聊天时注意到的说话习惯，以及你自己已经养成的说法。挑出你和大家聊久了、自然会被带上的说话方式（口头禅、语气词、发消息的节奏），保持你原本的性格，不超过 6 条，每条不超过 20 字。只输出 JSON 数组。',
        text: `已经养成的：\n${styleOf('self').map((x) => '- ' + x).join('\n') || '（还没有）'}\n\n大家的说话习惯：\n${pool.map((x) => '- ' + x).join('\n')}`,
        maxTokens: 800,
        temperature: 0.3,
      })
      const m = out.match(/\[[\s\S]*\]/)
      const arr = m ? JSON.parse(m[0]).map((t) => String(typeof t === 'string' ? t : t?.text || '')) : []
      if (arr.length) setStyle('self', arr)
    } catch (error) {
      log.warn('沉淀说话方式失败：', error.message)
    }
  }

  /** 每分钟调一次：一天几个整理时间点（默认 04:00 / 16:00），到点且这个点今天还没跑过就整理。 */
  async function tick() {
    const cfg = getConfig().memory
    if (!cfg.enabled || !cfg.dailyConsolidate) return
    const s = load()
    const today = dayKey()
    const now = new Date()
    const mins = now.getHours() * 60 + now.getMinutes()
    const runs = s.runs || {}
    const due = (cfg.consolidateTimes || []).filter((t) => {
      const [hh, mm] = String(t).split(':').map(Number)
      return mins >= hh * 60 + mm && runs[t] !== today
    })
    if (!due.length) return
    // 连今天到目前为止的聊天一起提炼；记着整理到第几行，下一次只处理新的
    const r = await consolidate({ includeToday: true })
    if (r.ok) {
      const s2 = load()
      s2.runs = { ...(s2.runs || {}) }
      for (const t of due) s2.runs[t] = today
      save(s2)
    }
  }

  /** 群聊话题和记忆库有多相关（0~1），给插话判断用。 */
  function topicScore(text) {
    const hits = search(index(), text, { limit: 1, minScore: 0.01 })
    return hits.length ? Math.min(1, hits[0].score / 3) : 0
  }

  return {
    add, update, remove, recall, contextFor, consolidate, tick, topicScore,
    styles: () => load().styles || {},
    setStyle: (key, list) => setStyle(key, (list || []).map(String)),
    lastConsolidate: () => load().lastConsolidate || null,
    insights: () => {
      const s = load()
      return Object.entries(s.insights || {}).map(([key, list]) => ({ key, name: (s.insightNames || {})[key] || '', list }))
    },
    setInsights: (key, list) => setInsights(key, list.map((x) => (typeof x === 'string' ? { id: randomUUID().slice(0, 8), text: x, at: Date.now() } : x))),
    list: (q) => {
      const items = load().items
      if (!q) return items.slice().sort((a, b) => b.at - a.at)
      return search(index(), q, { limit: 100, minScore: 0.01 }).map((h) => ({ ...h.it, score: Number(h.score.toFixed(2)) }))
    },
    stats: () => {
      const items = load().items
      return { count: items.length, auto: items.filter((m) => m.source === 'auto').length }
    },
  }
}
