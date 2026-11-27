// 记忆召回与融合检索：BM25 主通道 + 向量 RRF + 可选 cross-encoder 精排，
// 召回命中日志/节流、同会话冷却去噪、上下文装配、群背景补充与相关度评分。

import { buildIndex, search, cutAtSentence, memoryLine, retention, tokenize } from './memory-core.js'
import { visibleScopes } from './memory-scope.js'
import { fuseRrf } from './memory-vector.js'
import { createReranker, parseMinScore } from './memory-rerank.js'

const DEFAULT_VEC_MIN_COS = 0.35
const DEFAULT_RERANK_MIN_SCORE = 0.05
const SESSION_RECALL_COOLDOWN_TURNS = 8
const SESSION_RECALL_MAX_SESSIONS = 200

/**
 * 创建记忆召回处理器。
 */
export function createMemoryRecall({ getConfig, hub, chatLog, log, session, indexCache, crud, vec, reranker: rerankerInit, reflectionContext = true, styleContext = true }) {
  const { load, withSnapshot, recordHits, getVectorScopes } = session
  const { activePersonaId, personaVisible, scopeOfChat, scopeFromChatId, scopeVisible, indexFor, indexAll, hasScopeOverride, isScopeOverridden } = indexCache
  const { recentEvents } = crud
  const { profileOf, profileKeyOf, insightsOf, styleOf, styleSourceOf, personKey } = indexCache.derived || {}

  const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const vecStatusSafe = () => { try { return vec?.status() } catch { return { enabled: false } } }
  const reranker = { current: rerankerInit }
  const rerankStatusSafe = () => { try { return reranker.current?.status() } catch { return { enabled: false } } }

  // ---------- 召回命中日志 ----------

  const recallLog = [] // 最近几次想起了什么（给面板看 + 负反馈纠偏用）
  function recordRecallHits(hits, { where = '', query = '' } = {}) {
    recallLog.unshift({
      at: Date.now(),
      where,
      query: String(query).slice(0, 120),
      hits: hits.map((h) => ({ id: h.it.id, text: h.it.text, score: Number(Number(h.score || 0).toFixed(2)), why: h.why || [] })),
    })
    recallLog.length = Math.min(recallLog.length, 20)
    if (hits.length) recordHits(hits)
  }

  // ---------- 同会话召回冷却（8 轮内不重复注入同一条高权记忆） ----------

  const sessionRecall = new Map() // sessionId -> { turn: number, ids: Map<string, number> }

  function recentSessionRecalled(sessionId) {
    const sid = sessionId ? String(sessionId) : ''
    if (!sid) return { ids: new Set(), hasPriorTurns: false }
    const rec = sessionRecall.get(sid)
    if (!rec) return { ids: new Set(), hasPriorTurns: false }
    const nextTurn = rec.turn + 1
    const ids = new Set()
    for (const [id, lastTurn] of rec.ids) {
      if (nextTurn - lastTurn < SESSION_RECALL_COOLDOWN_TURNS) ids.add(id)
      else rec.ids.delete(id)
    }
    return { ids, hasPriorTurns: rec.turn > 0 }
  }

  function recordSessionRecalled(sessionId, memIds) {
    const sid = sessionId ? String(sessionId) : ''
    if (!sid) return
    let rec = sessionRecall.get(sid)
    if (!rec) {
      if (sessionRecall.size >= SESSION_RECALL_MAX_SESSIONS) {
        const oldest = sessionRecall.keys().next().value
        if (oldest !== undefined) sessionRecall.delete(oldest)
      }
      rec = { turn: 0, ids: new Map() }
      sessionRecall.set(sid, rec)
    }
    rec.turn += 1
    for (const id of memIds) {
      if (id) rec.ids.set(String(id), rec.turn)
    }
    for (const [id, lastTurn] of rec.ids) {
      if (rec.turn - lastTurn >= SESSION_RECALL_COOLDOWN_TURNS) rec.ids.delete(id)
    }
  }

  // ---------- BM25 主通道 ----------

  function recallBm25(query, { about, limit, context = '', chat = null, scopes = null } = {}) {
    const max = limit ?? getConfig().memory.recallCount
    const inScopes = (scope) => Array.isArray(scopes) && scopes.includes(String(scope))
    const scoped = (list) => (chat ? list.filter((h) => scopeVisible(h.it.scope, chat) && personaVisible(h.it, chat))
      : Array.isArray(scopes) ? list.filter((h) => inScopes(h.it.scope) && personaVisible(h.it, h.it.scope))
      : [])
    let idx
    if (chat) idx = indexFor(chat)
    else if (Array.isArray(scopes)) {
      const seen = new Set()
      const merged = []
      for (const sc of scopes) {
        const i = indexFor(sc)
        if (!i) continue
        for (const d of i.docs) {
          const id = d?.it?.id
          if (id != null && id !== '') {
            if (seen.has(String(id))) continue
            seen.add(String(id))
          }
          merged.push(d.it)
        }
      }
      idx = buildIndex(merged)
    } else idx = buildIndex([])
    const hits = scoped(search(idx, query, { about, limit: chat || Array.isArray(scopes) ? max * 3 : max })).slice(0, max)
    if (context && hits.length < max) {
      const have = new Set(hits.map((h) => h.it.id))
      for (const h of scoped(search(idx, context, { about, limit: max * 3, minScore: 0.5 }))) {
        if (hits.length >= max) break
        if (!have.has(h.it.id)) hits.push({ ...h, score: h.score * 0.6, why: [...(h.why || []), '（上一句）'] })
      }
    }
    return hits
  }

  function recall(query, { about, limit, where = '', context = '', chat = null, scopes = null } = {}) {
    const hits = recallBm25(query, { about, limit, context, chat, scopes })
    recordRecallHits(hits, { where, query })
    return hits
  }

  // ---------- 融合召回（BM25 + 向量 RRF + 精排） ----------

  function vectorScopesFor(chat, scopes) {
    if (Array.isArray(scopes)) {
      return [...new Set(scopes.map((sc) => String(sc || '').trim()).filter(Boolean))]
    }
    if (!chat) return []
    const out = new Set(visibleScopes(chat))
    if (hasScopeOverride()) {
      const candidates = new Set(getVectorScopes())
      const ownerQQ = String(getConfig()?.ownerQQ || '').trim()
      if (ownerQQ) candidates.add(`private:${ownerQQ}`)
      for (const sc of candidates) {
        if (!sc || out.has(sc)) continue
        try { if (isScopeOverridden(sc, chat)) out.add(sc) } catch {}
      }
    }
    return [...out]
  }

  async function recallFused(query, { about, limit, where = '', context = '', chat = null, scopes = null, excludeIds = null, minCos = DEFAULT_VEC_MIN_COS, rerankMinScore } = {}) {
    const q = String(query || '').trim()
    if (!q) return []
    const max = limit ?? getConfig().memory.recallCount
    const excluded = excludeIds instanceof Set ? excludeIds : (Array.isArray(excludeIds) ? new Set(excludeIds.map(String)) : null)
    if (!vec?.enabled()) {
      const hits = recallBm25(q, { about, limit: excluded?.size ? max + excluded.size : max, context, chat, scopes })
        .filter((h) => !excluded || !excluded.has(String(h.it.id)))
        .slice(0, max)
      recordRecallHits(hits, { where, query: q })
      return hits
    }
    const rerankEnabled = reranker.current?.enabled()
    const rerankCap = rerankEnabled ? Math.max(max, Number(reranker.current.status()?.topN) || 20) : max
    const poolLimit = Math.max(max * 2, rerankCap)
    const bm25 = recallBm25(q, { about, limit: poolLimit, context, chat, scopes })
      .filter((h) => !excluded || !excluded.has(String(h.it.id)))
      .slice(0, poolLimit)

    // 所有可见作用域合并成一次向量检索（每个 scope 一次 embed 会成倍放大延迟）
    const targetScopes = vectorScopesFor(chat, scopes)
    const byScopeMap = new Map()
    const activeScopes = []
    for (const scope of targetScopes) {
      const idx = indexFor(scope)
      if (!idx || !idx.docs || !idx.docs.length) continue
      byScopeMap.set(scope, new Map(idx.docs.map((d) => [String(d.it.id), d.it])))
      activeScopes.push(scope)
    }
    const vecSeen = new Set()
    const vecHits = []
    const now = Date.now()
    if (activeScopes.length) {
      // 短查询语义太泛：拼上上下文当检索语句（与 BM25 侧的 ctxText 口径一致）
      const ctxStr = String(context || '').trim()
      const vecQuery = (ctxStr && q.length < 12) ? `${ctxStr} ${q}` : q
      let raw = []
      try {
        raw = await vec.searchScopes(vecQuery, activeScopes, {
          whitelistOf: (sc) => {
            const m = byScopeMap.get(String(sc))
            return m ? new Set(m.keys()) : new Set()
          },
          topK: poolLimit,
          timeoutMs: 2500,
          minCos,
        })
      } catch { raw = [] }
      for (const c of raw) {
        const id = String(c.id)
        if ((excluded && excluded.has(id)) || vecSeen.has(id)) continue
        const byId = byScopeMap.get(String(c.scope))
        const it = byId ? byId.get(id) : null
        if (!it || it.invalidAt) continue
        if (chat ? (!scopeVisible(it.scope, chat) || !personaVisible(it, chat)) : !personaVisible(it, it.scope)) continue
        vecSeen.add(id)
        const w = (0.6 + 0.8 * (Number(it.importance) || 0.5)) * (0.55 + 0.45 * retention(it, now))
        vecHits.push({ it, score: c.cos * w, why: ['（语义召回）'] })
      }
    }
    vecHits.sort((a, b) => b.score - a.score)
    let hits = fuseRrf(bm25, vecHits.slice(0, poolLimit), { limit: rerankCap })
    let rerankFilteredAll = false
    if (rerankEnabled) {
      const preCount = hits.length
      const argMinScore = parseMinScore(rerankMinScore)
      const cfgMinScore = reranker.current.status()?.minScore
      const effectiveMinScore = argMinScore !== undefined
        ? argMinScore
        : (cfgMinScore !== undefined ? cfgMinScore : DEFAULT_RERANK_MIN_SCORE)
      hits = await reranker.current.rerank(q, hits, { minScore: effectiveMinScore })
      if (preCount > 0 && hits.length === 0) rerankFilteredAll = true
    }
    hits = hits.slice(0, max)
    recordRecallHits(hits, { where, query: q })
    // 精排把候选全汰：标记给 hintBody，禁止再拿「泛问兜底」反塞无关记忆
    if (rerankFilteredAll) Object.defineProperty(hits, 'rerankFilteredAll', { value: true, enumerable: false })
    return hits
  }

  // ---------- 上下文装配 ----------

  function contextFor(chat, sessionId) {
    return withSnapshot(() => contextForInner(chat, sessionId))
  }
  function contextForInner(chat, sessionId) {
    const cfg = getConfig().memory
    if (!cfg.enabled) return ''
    const parts = []
    const currentPersona = activePersonaId(chat)
    const people = chat.kind === 'group' ? (hub?.speakersOf?.(sessionId) || []).slice(0, 3) : chat.userId ? [chat.userId] : []
    const pScope = scopeOfChat(chat)
    const isProfileMatch = (p) => {
      if (!p) return false
      const pid = String(p.personaId || p.persona || '').trim()
      if (pid && pid !== currentPersona) return false
      if (p.personaScope && String(p.personaScope).trim() !== currentPersona) return false
      return true
    }
    const profs = people
      .map((qq) => {
        const local = profileOf(qq, pScope, currentPersona)
        const glob = pScope === 'global' ? null : profileOf(qq, 'global', currentPersona)
        const validLocal = isProfileMatch(local) ? local : null
        const validGlob = isProfileMatch(glob) ? glob : null
        if (validLocal && validGlob && validLocal.text !== validGlob.text) return { ...validLocal, text: `${validLocal.text}；${validGlob.text}` }
        return validLocal || validGlob
      })
      .filter(Boolean)
    if (profs.length) parts.push('（你对' + (chat.kind === 'group' ? '正在说话的人' : '对方') + '的印象：' + profs.map((p) => (chat.kind === 'group' && p.name ? p.name + '——' : '') + p.text).join('；') + '）')
    const isGroupChat = chat.kind === 'group'
    const pKey = personKey(chat)
    const rawIns = reflectionContext ? insightsOf(pKey, currentPersona) : []
    const ins = isGroupChat ? rawIns.filter((item) => item?.origin === 'manual') : rawIns
    if (ins.length) parts.push('（和' + (isGroupChat ? '这个群' : '对方') + '相处的经验，照着做就好，不用说出来：' + ins.map((x) => x.text).join('；') + '）')
    const rawSty = styleContext ? styleOf(pKey, currentPersona) : []
    const sty = isGroupChat ? (styleSourceOf(pKey)?.origin === 'manual' ? rawSty : []) : rawSty
    const self = (styleContext && !isGroupChat) ? styleOf('self', currentPersona) : []
    if (sty.length || self.length) {
      parts.push('（说话方式：' + [sty.length ? '和' + (isGroupChat ? '这个群' : '对方') + '聊久了，' + sty.join('；') : '', self.length ? '你平时不知不觉会用的说法：' + self.join('、') : ''].filter(Boolean).join('。') + '。自然带一点就好，别刻意模仿，也别变成另一个人；若和人设里的硬性规则（尤其是「绝对禁止」）冲突，完全以人设为准，被禁的写法一条都不要用。）')
    }
    const stableEventTime = (at, now = Date.now()) => {
      if (!at) return ''
      const m = Math.max(0, Math.round((now - at) / 60000))
      if (m < 30) return '刚才'
      const d = new Date(at)
      const n = new Date(now)
      const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
      const days = Math.round((day0(n) - day0(d)) / 86400_000)
      if (days <= 0) return `${hm} `
      if (days === 1) return `昨天 ${hm} `
      return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm} `
    }
    const recent = recentEvents(24, 4, chat)
    if (recent.length) parts.push('（你最近做过的事：' + recent.map((m) => `${stableEventTime(m.at)}${m.text}`).join('；') + '。聊到了可以自然提起。）')
    return parts.join('\n')
  }

  // ---------- 主人私聊问起群里的事：临时把最近 24h 群聊流水当她的见闻 ----------

  const GROUP_TALK = /(群|群聊|群里|他们|大家|那些人在聊)/

  function groupBackdrop(chat, queryText) {
    if (!chat || chat.kind !== 'private') return ''
    const all = getConfig()
    const ob = all.group && all.group.ownerBrief
    if (!ob || ob.enabled !== true) return ''
    if (!all.ownerQQ || String(chat.userId) !== String(all.ownerQQ)) return ''
    if (!GROUP_TALK.test(String(queryText || ''))) return ''
    const now = Date.now()
    const cutoff = now - 86400_000
    let rows = []
    try {
      for (const dk of [dayKey(), dayKey(new Date(cutoff))]) {
        for (const l of chatLog?.readDay?.(dk) || hub?.chatLogOf?.(dk) || []) {
          if (!l || !String(l.chatId).startsWith('group:') || !String(l.text || '').trim()) continue
          const t = Number(l.t) || 0
          if (t && t < cutoff) continue
          rows.push(l)
        }
      }
      rows.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0))
    } catch (error) {
      return ''
    }
    const allow = new Set((ob.groups || []).map(String))
    if (allow.size) rows = rows.filter((l) => allow.has(String(l.chatId).slice(6)))
    if (!rows.length) return ''
    const limit = Math.max(1, Math.min(30, Number(ob.lines) || 12))
    const byGroup = new Map()
    for (const l of rows) {
      const gid = String(l.chatId).slice(6)
      if (!byGroup.has(gid)) byGroup.set(gid, [])
      byGroup.get(gid).push(l)
    }
    const blocks = []
    let total = 0
    for (const [gid, list] of byGroup) {
      if (total >= 120) break
      const tail = list.slice(-limit)
      total += tail.length
      const name = hub?.groupNames?.get?.(gid) || ''
      const title = name && name !== gid ? `群「${name}」（${gid}）` : `群 ${gid}`
      const body = tail.map((l) => {
        const who = l.who === 'bot' ? '我' : (l.who || '有人')
        return `${who}：${String(l.text).replace(/\s+/g, ' ').trim().slice(0, 100)}`
      }).join('\n')
      blocks.push(`【${title} · 最近 ${tail.length} 条】\n${body}`)
    }
    log.info(`主人问起群里的事：补了 ${blocks.length} 个群、共 ${total} 条最近的群聊记录`)
    return '（下面是你最近在几个群里经历过的片段，属于你自己的见闻 —— **不是主人发给你的消息**，别当成主人在跟你说话。'
      + '主人提到群里的事时，就像回忆自己白天的经历一样接着说下去，不用特意说「我看到了」「我知道了」；'
      + '群里的私事也别主动往外讲。想知道某个具体群的情况，就看你记得的那个群。）\n'
      + blocks.join('\n\n') + '\n【以上是最近群里的情况】'
  }

  // ---------- 提示词注入 ----------

  function recallHint(chat, queryText, prevText = '', { sessionId } = {}) {
    const cfg = getConfig().memory
    if (!cfg.enabled) return ''
    const q = String(queryText || '').trim()
    if (!q) return ''
    const backdrop = groupBackdrop(chat, q)
    const recent = recentEvents(24, 4, chat)
    const { ids: cooledIds, hasPriorTurns } = recentSessionRecalled(sessionId)
    const shown = new Set([...recent.map((m) => m.id), ...cooledIds])
    const about = chat && chat.kind === 'private' ? chat.userId
      : chat && chat.kind === 'group' ? (hub?.speakersOf?.(sessionId) || []).slice(0, 3)
      : undefined
    const ctxText = q.length < 12 ? String(prevText || '').slice(-300) : ''
    const maxItems = Math.max(1, Math.min(20, Math.round(Number(cfg.hintCount) || 8)))
    const maxChars = Math.max(120, Math.min(2000, Math.round(Number(cfg.hintMaxChars) || 600)))
    const hits = recall(q, { about, where: (chat && chat.chatId) || '', context: ctxText, chat }).filter((h) => !shown.has(h.it.id)).slice(0, maxItems)
    return hintBody(hits, { chat, shown, backdrop, maxItems, maxChars, sessionId, allowFallback: !hasPriorTurns })
  }

  function hintBody(hits, { chat, shown, backdrop, maxItems, maxChars, sessionId, allowFallback = true }) {
    if (!hits.length && allowFallback) {
      const fallback = (chat ? indexFor(chat).docs : [])
        .filter((d) => !d.it.invalidAt && !shown.has(d.it.id) && personaVisible(d.it, chat))
        .sort((a, b) => (Number(b.it.importance) || 0.5) - (Number(a.it.importance) || 0.5) || b.it.at - a.it.at)
        .slice(0, 2)
        .map((d) => ({ it: d.it, score: 0.3, why: ['（泛问兜底·最近重要）'] }))
      hits.push(...fallback)
    }
    if (!hits.length) {
      recordSessionRecalled(sessionId, [])
      return backdrop
    }
    const lines = []
    const emittedIds = []
    let used = 0
    for (const h of hits) {
      let line = memoryLine(h.it)
      if (line.length > 120) line = cutAtSentence(line, 120)
      if (lines.length && used + line.length + 1 > maxChars) break
      lines.push(line)
      emittedIds.push(h.it.id)
      used += line.length + 1
    }
    recordSessionRecalled(sessionId, emittedIds)
    const body = lines.join('\n')
    return ['（你记得这些事：\n' + body + '）', backdrop].filter(Boolean).join('\n')
  }

  async function recallHintFused(chat, queryText, prevText = '', { sessionId } = {}) {
    const cfg = getConfig().memory
    if (!cfg.enabled) return ''
    const q = String(queryText || '').trim()
    if (!q) return ''
    if (!vec?.enabled()) return recallHint(chat, queryText, prevText, { sessionId })
    try {
      const backdrop = groupBackdrop(chat, q)
      const recent = recentEvents(24, 4, chat)
      const { ids: cooledIds, hasPriorTurns } = recentSessionRecalled(sessionId)
      const shown = new Set([...recent.map((m) => m.id), ...cooledIds])
      const about = chat && chat.kind === 'private' ? chat.userId
        : chat && chat.kind === 'group' ? (hub?.speakersOf?.(sessionId) || []).slice(0, 3)
        : undefined
      const ctxText = q.length < 12 ? String(prevText || '').slice(-300) : ''
      const maxItems = Math.max(1, Math.min(20, Math.round(Number(cfg.hintCount) || 8)))
      const maxChars = Math.max(120, Math.min(2000, Math.round(Number(cfg.hintMaxChars) || 600)))
      const hits = await recallFused(q, {
        about,
        limit: maxItems,
        where: (chat && chat.chatId) || '',
        context: ctxText,
        chat,
        excludeIds: shown,
      })
      return hintBody(hits, { chat, shown, backdrop, maxItems, maxChars, sessionId, allowFallback: !hasPriorTurns && !hits.rerankFilteredAll })
    } catch (error) {
      return recallHint(chat, queryText, prevText, { sessionId })
    }
  }

  // ---------- 提炼/对比辅助 ----------

  function relatedTo(chatId, transcript) {
    const ppl = new Set([...String(transcript).matchAll(/\((\d{5,})\)/g)].map((m) => m[1]))
    if (chatId.startsWith('private:')) ppl.add(chatId.slice(8))
    const scope = scopeFromChatId(chatId)
    const items = load().items.filter((m) => {
      if (m.invalidAt || m.source === 'event' || m.source === 'diary') return false
      const sc = String(m.scope || '').trim()
      if (!sc) return false
      if (sc !== 'global' && !(scope && sc === scope)) return false
      return personaVisible(m, chatId)
    })
    const out = items.filter((m) => m.about && ppl.has(String(m.about))).sort((a, b) => b.at - a.at).slice(0, 10)
    for (const h of search(indexFor(chatId), String(transcript).slice(-1500), { limit: 8, minScore: 0.5 })) {
      if (out.length >= 15) break
      if (!out.some((m) => m.id === h.it.id) && h.it.source !== 'event' && h.it.source !== 'diary' && personaVisible(h.it, chatId)) out.push(h.it)
    }
    return out
  }

  function topicScore(text, chat = null) {
    if (!chat) return 0
    const idx = indexFor(chat)
    if (!idx) return 0
    const hits = search(idx, text, { limit: Math.max(10, idx.N || 10), minScore: 0.01 }).filter((h) => personaVisible(h.it, chat))
    if (!hits.length) return 0
    const q = new Set(tokenize(text))
    const d = new Set(tokenize(hits[0].it?.text || ''))
    if (!q.size || !d.size) return 0
    const N = Math.max(1, Number(idx.N) || 1)
    const rarity = (t) => Math.max(0.05, 1 - (idx.df?.get?.(t) || 0) / N)
    let Q = 0
    let D = 0
    let W = 0
    for (const t of q) Q += rarity(t)
    for (const t of d) {
      const r = rarity(t)
      D += r
      if (q.has(t)) W += r
    }
    if (!W || !Q || !D) return 0
    // F1 的调和平均：召回率与精确率都要高才得高分，避免「查询很长 → 加分」的虚高
    const p = W / Q
    const r = W / D
    return Math.max(0, Math.min(1, (2 * p * r) / (p + r)))
  }

  return {
    recall,
    recallBm25,
    recallFused,
    recallHint,
    recallHintFused,
    contextFor,
    topicScore,
    relatedTo,
    recallLog,
    clearRecalls: () => { recallLog.length = 0 },
    recentSessionRecalled,
    recordSessionRecalled,
    recordRecallHits,
    reranker,
  }
}
