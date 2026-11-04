// 索引记忆库：本地 JSON 存储 + 倒排索引（中文按二元字组切词，英文数字按词）+ BM25 打分，
// 再叠加「关于当前说话人」「重要程度」「新近程度」的加权。不依赖外部向量库，几千条也是毫秒级。
//
// 记忆来源：她自己调 remember 工具记的、后台从聊天里自动提炼的、主人在面板里手动加的。
// 召回时机：每一轮回复前，用「这一轮对方说的话」（太短就连上一句）检索最相关的几条，作为上下文悄悄告诉她。
//
// 借鉴的做法：
// - 遗忘曲线（MemoryBank）：记得多牢按「多久没想起 + 被想起过几天 + 重要程度」算，常聊到的忘得慢。
// - 整理时先比对旧记忆（Mem0）：新事实是新增、补充旧的，还是说明旧的过时了。
// - 过时不删（Graphiti）：旧记忆标成「已过时」，不再被想起，但留着历史、面板里能恢复。
// - 常驻的人物小档案（Letta 的 memory block）：每个人一小段印象，聊天时一直带着，不靠关键词碰运气。

import { randomUUID } from 'node:crypto'
import { dataDir, readJson, writeJson } from '../core/store.js'
import { askModel } from '../core/llm.js'
import { openMemoryDb } from './memory-sqlite.js'
import { conceptsOf } from './memory-concepts.js'

// ---------------- 纯函数：切词与打分 ----------------

const STOP = new Set('的了是我你他她它们在有和就不也都很吗吧呢啊呀哦嗯这那个一上下来去说要会能着过'.split(''))

// ---------------- 作用域配额（P1-2） ----------------
// 全局 3000 条上限的问题：多群+多私聊很快顶满，然后按重要度整体裁，
// 可能把某个作用域整段清空，还没有日志。改成每个作用域独立配额。
export const SCOPE_QUOTAS = { global: 500, group: 400, private: 300 }
const TOTAL_CAP = 6000 // 兜底：所有作用域加起来也别无限涨

export function quotaForScope(scope) {
  const s = String(scope || '')
  if (s.startsWith('group:')) return SCOPE_QUOTAS.group
  if (s.startsWith('private:')) return SCOPE_QUOTAS.private
  return SCOPE_QUOTAS.global
}

/** 超配额时淘汰：优先 auto 来源、低 importance、低 retention（老且不常想起）。返回淘汰条数。 */
export function evictScopeItems(items, scope, quota, now = Date.now()) {
  const inScope = items.filter((m) => m.scope === scope)
  if (inScope.length <= quota) return 0
  const victims = inScope
    .slice()
    .sort((a, b) =>
      (Number(a.importance || 0.5) - Number(b.importance || 0.5))
      || ((b.source === 'auto' ? 1 : 0) - (a.source === 'auto' ? 1 : 0))
      || (Number(a.at || 0) - Number(b.at || 0)))
    .slice(0, inScope.length - quota)
    .map((m) => m.id)
  const kill = new Set(victims)
  let removed = 0
  for (let i = items.length - 1; i >= 0; i--) {
    if (kill.has(items[i].id)) { items.splice(i, 1); removed++ }
  }
  return removed
}

/** 切词：英文/数字整词；中文连续段拆成二元字组（单字段保留单字，去掉停用字）。 */export function tokenize(text) {
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
// ---------------- 否定/反义校验（P1-3） ----------------
// Jaccard 0.6 会把「养猫/养狗」「喜欢钓鱼/不喜欢钓鱼」判成重复，
// 保留较长那句等于把事实改错。相似但否定词状态不一致的，强制当新条目存。
const NEG_WORDS = ['不', '没', '别', '莫', '无', '未', '戒', '停', '取消了', '不再', '已经不', '讨厌', '恨']
// 常见反义词对：同一句式换了关键名词（猫↔狗）语义就反了，也不能合并
const ANT_PAIRS = [['猫', '狗'], ['猫', '犬'], ['狗', '犬'], ['男', '女'], ['来', '去'], ['买', '卖'], ['吃', '吐'],
  ['喜欢', '讨厌'], ['爱', '恨'], ['在', '不在'], ['会', '不会'], ['有', '没有'], ['是', '不是'], ['开了', '关了'],
  ['工作', '辞职'], ['上学', '辍学'], ['结婚', '离婚'], ['搬来', '搬走']]

/** 两句相似文本的「极性」是否一致：否定词命中集合 + 反义词对；scope/about 不同也算不一致。 */
export function contradicts(aText, bText, aAbout = '', bAbout = '', aScope = '', bScope = '') {
  if (aScope !== bScope) return true
  if (aAbout && bAbout && aAbout !== bAbout) return true
  const a = String(aText || ''); const b = String(bText || '')
  const hits = (t) => NEG_WORDS.filter((w) => t.includes(w)).join('|')
  if (hits(a) !== hits(b)) return true
  for (const [x, y] of ANT_PAIRS) {
    if ((a.includes(x) && b.includes(y) && !a.includes(y) && !b.includes(x))
      || (a.includes(y) && b.includes(x) && !a.includes(x) && !b.includes(y))) return true
  }
  return false
}

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
    // 概念集合（P2-1）：「他最近过得怎么样」和「阿强搬家到上海」没有共同字词，
    // 但共享「近况/居住」概念 —— 靠这个重叠把纯语义提问捞回来。
    const concepts = conceptsOf(`${it.text} ${(it.tags || []).join(' ')}`)
    return { it, tf, len: toks.length || 1, concepts }
  })
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1)
  return { docs, df, avgLen, N: docs.length }
}

/**
 * 检索。
 * @param idx buildIndex() 的结果
 * @param {string} query
 * @param {{about?:string|string[], now?:number, limit?:number, minScore?:number, includeInvalid?:boolean}} [o]
 *   about：关于这些人（QQ 号）的记忆加分；群里可以传这一段里所有说话的人
 */
export function search(idx, query, o = {}) {
  const q = [...new Set(tokenize(query))]
  const qConcepts = conceptsOf(query)
  const now = o.now ?? Date.now()
  const aboutSet = new Set((Array.isArray(o.about) ? o.about : o.about ? [o.about] : []).map(String))
  const k1 = 1.4
  const b = 0.7
  const scored = []
  for (const d of idx.docs) {
    let s = 0
    const why = []
    for (const t of q) {
      const f = d.tf.get(t)
      if (!f) continue
      const n = idx.df.get(t) || 0
      // IDF 下限：语料很少时（比如某个群只有一两条记忆），标准 BM25 的 IDF
      // 会趋近 0，导致「唯一记得的那条」反而检不出来 —— 等于失忆。
      // 按作用域分索引后这种情况很常见，所以给 IDF 兜一个下限，保证单词命中也有分。
      const idf = Math.max(0.6, Math.log(1 + (idx.N - n + 0.5) / (n + 0.5)))
      const part = idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / idx.avgLen))
      s += part
      why.push([t, part])
    }
    const it = d.it
    if (it.invalidAt && !o.includeInvalid) continue
    const aboutHit = Boolean(it.about) && aboutSet.has(String(it.about))
    // 概念重叠（P2-1）：查询与记忆没有共同字词时的语义兜底。重叠比例当分。
    let conceptScore = 0
    if (qConcepts.size && d.concepts?.size) {
      let overlap = 0
      for (const c of qConcepts) if (d.concepts.has(c)) overlap++
      if (overlap) conceptScore = overlap / Math.min(qConcepts.size, d.concepts.size)
    }
    if (s <= 0 && !aboutHit && conceptScore <= 0) continue
    const importance = 0.6 + 0.8 * (Number(it.importance) || 0.5)
    const score = (s + (aboutHit ? 0.8 : 0) + conceptScore * 1.2) * importance * (0.55 + 0.45 * retention(it, now))
    scored.push({ it, score, why: why.sort((x, y) => y[1] - x[1]).slice(0, 3).map((w) => w[0]).concat(aboutHit ? ['（关于这个人）'] : []).concat(conceptScore > 0.3 ? ['（语义相关）'] : []) })
  }
  scored.sort((x, y) => y.score - x.score)
  return scored.filter((x) => x.score >= (o.minScore ?? 0.35)).slice(0, o.limit ?? 6)
}

/** 「刚才」「3 小时前」「昨天」这样的说法。 */
export function agoText(at, now = Date.now()) {
  const m = Math.max(0, Math.round((now - at) / 60000))
  if (m < 30) return '刚才'
  if (m < 60 * 20) return `${Math.max(1, Math.round(m / 60))} 小时前`
  return '昨天'
}

/** 一条记忆是什么时候的：今天 / 昨天 / 3 天前 / 09-17 / 去年 03-02 / 2024-05-01。 */
export function whenText(at, now = Date.now()) {
  if (!at) return ''
  const d = new Date(at)
  const n = new Date(now)
  const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day0(n) - day0(d)) / 86400_000)
  const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  if (d.getFullYear() === n.getFullYear()) return md
  if (d.getFullYear() === n.getFullYear() - 1) return '去年 ' + md
  return `${d.getFullYear()}-${md}`
}

/** 想起来的一条记忆怎么写给她：[什么时候] [关于谁] 内容。 */
export function memoryLine(it, now = Date.now()) {
  return `[${whenText(it.at, now)}] ` + (it.aboutName ? `[${it.aboutName}] ` : '') + it.text
}

/**
 * 该不该忘掉：每日整理自动提炼出来的、不太重要、已经淡了的（见 retention），忘掉。
 * 她自己记的、你加的、经历和日记不自动忘。
 *
 * 【经历类的四档清晰度】移植自 surfcore 的记忆卡设计（docs/guides/MEMORY_CARD.md）：
 * 浏览经历（B站/小黑盒/画画）源源不断，原来一律 return false → 记忆库只增不减。
 * 现在按清晰度分级，每天最多降一档（慢慢模糊，不是突然消失）：
 *   vivid（清晰）→ clear（清楚）→ fuzzy（模糊，正文已截断）→ trace（只剩印象）→ 遗忘
 * 主人相关的记忆（about 是主人 QQ，或 importance ≥ 0.65）永不遗忘，最差保持 clear。
 */
/** 这条记忆是不是主人相关的。两边都要非空才比较——空串相比会恒等，把普通记忆误判成主人的。 */
export function isOwnerMemory(m) {
  const a = String((m && m.about) || '').trim()
  const o = String((m && m.ownerQQ) || '').trim()
  return Boolean(a && o && a === o)
}

export const CLARITY_STEPS = ['vivid', 'clear', 'fuzzy', 'trace']

/** 一条记忆当前该是什么清晰度（纯函数，方便测试）。 */
export function clarityOf(m, now = Date.now()) {
  if (m.pinned) return 'vivid'
  const r = retention(m, now)
  const own = isOwnerMemory(m) || (Number(m.importance) || 0) >= 0.65
  // 主人的重要记忆最差保持 clear（surfcore 的 minOwnerImportance 规则）
  if (r >= 0.5) return 'vivid'
  if (r >= 0.25) return 'clear'
  if (own) return 'clear'
  if (r >= 0.08) return 'fuzzy'
  return 'trace'
}

export function shouldForget(m, now = Date.now()) {
  // 过时的留半年（面板里能看到、能恢复），之后清掉
  if (m.invalidAt) return now - m.invalidAt > 180 * 86400_000
  if (m.pinned) return false
  // 经验/洞察/你亲手加的：不自动忘
  if (m.source !== 'auto' && m.source !== 'event') return false
  // 主人相关或明确重要的：不遗忘
  if ((Number(m.importance) || 0) >= 0.65) return false
  if (isOwnerMemory(m)) return false

  const step = clarityOf(m, now)
  if (step === 'trace') {
    // 只走到「印象」阶段还不够，得再放一段（retention 掉到极低）才真正忘
    return retention(m, now) < 0.05
  }
  return false
}

/**
 * 记得多牢（0~1）：R = e^(-Δt/τ)。Δt 是离上次被想起（或记下）过了多久；
 * τ 随「被想起过几天」和重要程度变长——一条普通记忆两个月没碰就淡了，隔几天就聊到一次的能记很久。
 */
export function retention(m, now = Date.now()) {
  const last = Math.max(m.at || 0, m.lastHit || 0)
  const days = Math.max(0, (now - last) / 86400_000)
  const strength = 1 + Math.min(10, Number(m.hitDays) || 0)
  const tau = 20 * strength * (0.5 + (Number(m.importance) || 0.5))
  return Math.exp(-days / tau)
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

export function createMemoryStore({ dsh, getConfig, hub, log, personaText }) {
  /** 从人设文本里抽「禁止」类硬规则行，给 style 学习当护栏（人设没写或没传 personaText 就返回空）。 */
  const personaGuard = () => {
    try {
      const t = String(personaText?.() || '')
      if (!t) return ''
      const lines = t.split('\n').map((l) => l.trim()).filter((l) => l && l.length <= 80 && /禁止|不要|不许|不得|别成|别用|别刻意/.test(l))
      if (!lines.length) return ''
      return lines.slice(0, 12).join('\n')
    } catch { return '' }
  }

  const file = () => dataDir('memories.json')
  /** 作用域配额淘汰：本作用域超了就裁（低重要度/auto 来源/最老先走），淘汰要留日志。 */
  function evictIfNeeded(s, scope) {
    // 快路径：库还没大到可能超配额就别扫（单群 400 / 全库 6000）
    if (s.items.length <= 400) return
    const quota = quotaForScope(scope)
    const removed = evictScopeItems(s.items, scope, quota)
    if (removed > 0) log?.info?.(`记忆库：${scope} 超出配额 ${quota} 条，淘汰了 ${removed} 条最不重要的`)
    // 全库兜底上限：防极端情况（大量小作用域）无限涨
    if (s.items.length > TOTAL_CAP) {
      const victims = s.items.slice().sort((a, b) => (Number(a.importance || 0.5) - Number(b.importance || 0.5)) || (Number(a.at || 0) - Number(b.at || 0)))
        .slice(0, s.items.length - TOTAL_CAP).map((m) => m.id)
      const kill = new Set(victims)
      let n = 0
      for (let i = s.items.length - 1; i >= 0; i--) { if (kill.has(s.items[i].id)) { s.items.splice(i, 1); n++ } }
      if (n > 0) log?.info?.(`记忆库：全库超过兜底上限 ${TOTAL_CAP} 条，淘汰 ${n} 条`)
    }
  }
  // 作用域索引缓存（按 scope 分组）；任何写入都会 clear
  const cache = new Map() // scope -> { stamp, count, idx }
  // tokenize 结果缓存（id → Set）：add 的 dup 预筛每次扫几百上千条，重复切词是纯浪费。
  // 写入路径清（save 后条目可能变），读路径随便缓存。
  const tokCache = new Map()
  const tokOf = (m) => {
    let t = tokCache.get(m.id)
    if (!t) { t = new Set(tokenize(m.text)); tokCache.set(m.id, t) }
    return t
  }
  // 存储层（P1-1）：SQLite 单表 + 内存镜像。load() 返回镜像（不再整读 541KB），
  // save() 算 diff 增量写库（不再整份重写）。db 打不开（老 Node/文件锁）自动退回 JSON 全量读写。
  let store = null
  try {
    store = openMemoryDb(dataDir('memories.db'), { log })
  } catch (error) {
    log?.warn?.('SQLite 记忆库打不开，退回 JSON 存储：', error.message)
    store = null
  }
  const jsonLoad = () => readJson(file(), () => ({ items: [] }))
  const jsonSave = (s) => writeJson(file(), s)
  const load = () => (store ? store.load() : jsonLoad())

  const pendingHitUpdates = new Map()
  let hitFlushTimer = null

  function scheduleFlushHits() {
    if (hitFlushTimer) return
    hitFlushTimer = setTimeout(() => {
      hitFlushTimer = null
      flushHits()
    }, 5000)
    hitFlushTimer.unref?.()
  }

  function flushHits() {
    if (!pendingHitUpdates.size) return
    const s = load()
    let changed = false
    for (const [id, delta] of pendingHitUpdates) {
      const m = s.items.find((x) => x.id === id)
      if (!m) continue
      if (delta.hitDays) m.hitDays = (m.hitDays || 0) + delta.hitDays
      m.hits = (m.hits || 0) + delta.hits
      m.lastHit = delta.lastHit
      changed = true
    }
    pendingHitUpdates.clear()
    if (changed) save(s)
  }

  const save = (s) => {
    if (pendingHitUpdates.size) {
      for (const [id, delta] of pendingHitUpdates) {
        const m = s.items.find((x) => x.id === id)
        if (m) {
          if (delta.hitDays) m.hitDays = (m.hitDays || 0) + delta.hitDays
          m.hits = (m.hits || 0) + delta.hits
          m.lastHit = delta.lastHit
        }
      }
      pendingHitUpdates.clear()
      if (hitFlushTimer) { clearTimeout(hitFlushTimer); hitFlushTimer = null }
    }
    if (store) store.save(s)
    else jsonSave(s)
    cache.clear()
    if (tokCache.size > 8000) tokCache.clear() // 防 id 无限积累；条目改文本概率低，粗放即可
  }
  /**
   * 记忆索引。**必须带作用域**：索引只包含这个聊天看得见的条目。
   *
   * 这是整个隔离方案的地基。以前 index() 用全量 items 建索引，
   * 于是所有基于它的检索（recall、topicScore、relatedTo、面板搜索）天然跨域，
   * 谁忘了在调用点补过滤，谁就是一条泄漏通道 —— 实测陌生群提到「NAS」「Docker」
   * 就能通过 topicScore 命中主人的私聊记忆，把她的插话概率往上抬。
   *
   * 现在改成：索引按作用域分组构建并缓存，接口强制传 chat 或 scope。
   * 传 'global' 只拿 global；传 null/undefined 返回空索引（fail-closed，宁可不给）。
   */
  /**
   * 全量索引：**只在主人自己的管理路径用**（面板列表、导出、/new 之类）。
   * 任何面向聊天内容生成的检索都必须走 indexFor(chat)，否则就是跨域。
   */
  const indexAll = () => {
    const s = load()
    const stamp = (s.rev || 0) + ':' + s.items.length
    const hit = cache.get('__all__')
    if (hit && hit.stamp === stamp) return hit.idx
    const idx = buildIndex(s.items)
    cache.set('__all__', { stamp, idx })
    return idx
  }
  function scopeKeyOf(chatOrScope) {
    if (chatOrScope === 'global') return 'global'
    if (chatOrScope && typeof chatOrScope === 'object') return scopeOfChat(chatOrScope)
    // 字符串形式的作用域（'private:123' / 'group:456'）也认
    if (typeof chatOrScope === 'string' && chatOrScope.trim()) return chatOrScope.trim()
    return '' // 没给作用域：下面会被当成空索引
  }
  function indexFor(chatOrScope) {
    const scope = scopeKeyOf(chatOrScope)
    if (!scope) return buildIndex([]) // fail-closed：没说清楚给谁看，就什么都不给
    const chatLike = chatOrScope && typeof chatOrScope === 'object' ? chatOrScope : null
    const s = load()
    // 可看见的条目：本作用域的 + global（global 处处可见）
    const visible = s.items.filter((m) => {
      const sc = String(m.scope || '').trim()
      if (!sc) return false // 无作用域老数据：不再当 global 放行
      if (sc === 'global' || sc === scope) return true
      // 隔离 override（memory-privacy 的「不隔离」开关）：某聊天被开放时，
      // 放行的作用域条目也要并进索引 —— 只做 scopeVisible 不够，索引是按作用域物理建的。
      return chatLike && scopeOverrideFn && scopeOverrideFn(sc, chatLike)
    })
    const stamp = s.rev || 0
    const hit = cache.get(scope)
    if (hit && hit.stamp === stamp && hit.count === s.items.length) return hit.idx
    const idx = buildIndex(visible)
    cache.set(scope, { stamp, count: s.items.length, idx })
    return idx
  }

  /**
   * 记忆作用域：私聊里记的只在那个私聊可见，群里记的只在那群可见，global 到处可见。
   * 老数据没有 scope 字段，一律按 global（和以前行为一致，不会突然丢记忆）。
   */
  function scopeOfChat(chat) {
    if (!chat || chat.kind === 'system') return 'global'
    if (chat.kind === 'private') return `private:${chat.userId}`
    if (chat.kind === 'group') return `group:${chat.groupId}`
    return 'global'
  }
  /** 从 chatId 字符串（'private:123' / 'group:456'）反推作用域；自动整理按聊天分批跑时用。 */
  function scopeFromChatId(chatId) {
    const id = String(chatId || '')
    if (id.startsWith('private:') || id.startsWith('group:')) return id
    // 推断不出来时返回空，由调用方决定兜底（不要在这里默默升成 global —— 那是泄漏的来源）
    return ''
  }
  /** 这条记忆在 chat 这个聊天里能不能被想起。
   *  没有 scope 的老数据按「只属于记下它的那个聊天」处理：宁可少给，不可多给。
   *  老数据若真是该公开的（她自己的设定等），迁移时显式标成 global 即可。
   *  scopeOverride（P0-4 后接 memory-privacy 的隔离开关）：某个聊天被面板设为「不隔离」时，
   *  由模块注册的判定函数决定放行哪些别的作用域（比如让这个群看到主人私聊的记忆）。
   *  主库不自己存开关，只提供挂点；没人注册时行为完全不变。 */
  let scopeOverrideFn = null
  function registerScopeOverride(fn) {
    scopeOverrideFn = typeof fn === 'function' ? fn : null
    cache.clear() // 放行规则变了，按作用域建的索引全部重建（否则旧索引里没有新放行的条目）
  }
  function scopeVisible(scope, chat) {
    const raw = String(scope || '').trim()
    if (!raw) return false // 老数据无作用域：一律不跨聊天可见（以前当 global 放行，是跨群泄漏的主因）
    if (raw === 'global') return true
    if (!chat || chat.kind === 'system') return false
    if (raw === scopeOfChat(chat)) return true
    if (scopeOverrideFn && scopeOverrideFn(raw, chat)) return true
    return false
  }

  function add({ text, about = '', aboutName = '', tags = [], importance = 0.5, source = 'tool', chatId = '', scope = '' }) {
    const t = String(text || '').trim().slice(0, 200)
    if (!t) return { ok: false, message: '内容是空的' }
    const s = load()
    // 去重：很像的就更新旧的（时间、重要程度取新），不重复存。
    // 但否定词/反义状态不一致（养猫 vs 养狗、喜欢 vs 不喜欢）不算重复 —— 语义反转不能合并（P1-3）。
    const ownerQQ0 = String(getConfig()?.ownerQQ || '')
    const scopeGuess = String(scope || '').trim() || scopeFromChatId(chatId) || (ownerQQ0 ? `private:${ownerQQ0}` : 'global')
    // dup 只可能出现在同一作用域里（跨 scope 条目互相看不见，合并了也是泄漏）
    const scopeItems = s.items.filter((m) => String(m.scope || '') === scopeGuess)
    const tToks = new Set(tokenize(t))
    const maybe = (m) => {
      if (m.invalidAt) return false
      if (!about || !m.about || m.about === String(about)) {
        for (const w of tokOf(m)) if (tToks.has(w)) return true
      }
      return false
    }
    const dup = scopeItems.find((m) => maybe(m) && similarity(m.text, t) >= 0.6
      && !contradicts(t, m.text, String(about || ''), String(m.about || ''), scopeGuess, String(m.scope || '')))
    if (dup) {
      dup.text = t.length >= dup.text.length ? t : dup.text
      dup.at = Date.now()
      dup.importance = Math.max(Number(dup.importance) || 0, Number(importance) || 0)
      s.rev = (s.rev || 0) + 1
      save(s)
      return { ok: true, message: '✓', updated: dup.id }
    }
    // 落库作用域：显式给了就用；否则按 chatId 推断（private:xxx / group:xxx）；
    // 都推断不出来时落到主人私聊（不落 global —— 无主的记忆一旦公开，就是跨群泄漏）
    const ownerQQ = String(getConfig()?.ownerQQ || '')
    const finalScope = String(scope || '').trim() || scopeFromChatId(chatId) || (ownerQQ ? `private:${ownerQQ}` : 'global')
    const item = { id: randomUUID().slice(0, 8), text: t, about: String(about || ''), aboutName: String(aboutName || ''), tags: (tags || []).slice(0, 5), importance: Math.max(0, Math.min(1, Number(importance) || 0.5)), source, chatId, scope: finalScope, at: Date.now(), hits: 0, clarity: 'vivid' }
    s.items.push(item)
    evictIfNeeded(s, finalScope)
    save(s)
    return { ok: true, message: '✓', id: item.id }
  }

  /** 导入旧档案第一步：让模型从一大段文字里挑出值得记的，返回候选（不直接存）。 */
  async function importCandidates(text) {
    const src = String(text || '').trim()
    if (!src) return []
    const chunks = []
    for (let i = 0; i < src.length && chunks.length < 6; i += 5000) chunks.push(src.slice(i, i + 5000))
    const out = []
    for (const part of chunks) {
      const r = await askModel(dsh, {
        cfg: getConfig(),
        system: '你帮一个叫「大肥鱼」的聊天角色从旧档案（设定、聊天笔记、以前的记忆文件）里挑出值得长期记住的事：别人的名字/称呼、喜好、身份、约定、重要经历、和她的关系。不要记她自己的人设和外貌（那些在人格里），不要记无关的说明文字。每条一句话、主语写清楚。只输出 JSON 数组，例如 [{"text":"小明喜欢吃辣","about":"小明","importance":0.6}]。',
        text: part,
        maxTokens: 2500,
        temperature: 0.2,
      })
      const m = String(r).match(/\[[\s\S]*\]/)
      try { for (const x of m ? JSON.parse(m[0]) : []) if (x && x.text) out.push({ text: String(x.text).slice(0, 200), aboutName: String(x.about || ''), importance: Math.max(0, Math.min(1, Number(x.importance) || 0.5)) }) } catch (error) {}
    }
    // 和已有记忆、彼此之间去重
    const have = load().items
    const uniq = []
    for (const c of out) if (!have.some((m) => similarity(m.text, c.text) >= 0.6) && !uniq.some((u) => similarity(u.text, c.text) >= 0.6)) uniq.push(c)
    return uniq.slice(0, 80)
  }

  /** 导入旧档案第二步：把勾选的候选存进记忆库。 */
  function importCommit(items) {
    let n = 0
    for (const c of items || []) if (add({ text: c.text, aboutName: c.aboutName || '', importance: c.importance ?? 0.5, source: 'import' }).id) n++
    return n
  }

  /** 她自己做过的事（唱了歌、刷了 B 站……）：记成「经历」，最近一天的会常驻在上下文里。
   *
   *  作用域默认落在**主人私聊**，不是 global。原因：这类经历的源头几乎都是「算法按主人的兴趣
   *  推给她的内容」——「在B站看了《猫猫合集》」「刷到白米饭料理」表面是她的经历，
   *  实际暴露的是主人的兴趣画像。真实事故里陌生人正是靠这类条目套出
   *  「主人爱看猫狗搞笑合集」「对白米饭感兴趣」「对 NAS 自建感兴趣」。
   *
   *  所以：默认 private:<主人QQ>；要公开进所有聊天，必须显式传 scope: 'global'
   *  （只有「在别人空间公开评论」这种对方本来就看得见的事才配）。 */
  function addEvent({ text, about = '', aboutName = '', tags = [], importance = 0.45, scope = '', chat = null, chatId = '' }) {
    // 优先级：显式 scope > 当前 chat > chatId 推断 > 主人私聊（兜底不再是 global）
    const sc = String(scope || '').trim() || (chat ? scopeOfChat(chat) : scopeFromChatId(chatId))
    const ownerScope = String(getConfig()?.ownerQQ || '')
    const finalScope = sc === 'global' ? 'global' : sc || (ownerScope ? `private:${ownerScope}` : 'global')
    return add({ text, about, aboutName, tags: ['经历', ...tags], importance, source: 'event', chatId: chatId || (chat && chat.chatId) || '', scope: finalScope })
  }

  /** 最近 hours 小时里她做过的事（经历 + 空间日记），新的在前。
   *  传了 chat 就只返回这个聊天可见的（和 recall 用同一套 scopeVisible），不传保持老行为。
   *  群聊一律返回空：她的「近况」在群里没有任何正当用途，只会变成谈资
   *  （「我最近在 B 站看猫猫」= 直接暴露主人的兴趣画像），所以连 global 也不注入。 */
  function recentEvents(hours = 24, limit = 4, chat = null) {
    if (chat && chat.kind === 'group') return []
    const since = Date.now() - hours * 3600_000
    return load().items
      .filter((m) => (m.source === 'event' || m.source === 'diary') && m.at >= since)
      .filter((m) => (chat ? scopeVisible(m.scope, chat) : true))
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
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

  /** 补充或改正一条旧记忆：换成新说法，旧说法留进 history。 */
  function revise(id, text, importance) {
    const s = load()
    const m = s.items.find((x) => x.id === id)
    const t = String(text || '').trim().slice(0, 200)
    if (!m || !t) return false
    m.history = [...(m.history || []), { text: m.text, at: m.at }].slice(-3)
    m.text = t
    m.at = Date.now()
    m.importance = Math.max(Number(m.importance) || 0, Number(importance) || 0)
    s.rev = (s.rev || 0) + 1
    save(s)
    return true
  }

  /** 标成过时：不再被想起，但不删（面板里能看到被哪条取代、能恢复）。 */
  function invalidate(id, byId = '') {
    const s = load()
    const m = s.items.find((x) => x.id === id)
    if (!m) return false
    m.invalidAt = Date.now()
    if (byId) m.supersededBy = byId
    s.rev = (s.rev || 0) + 1
    save(s)
    return true
  }

  function restore(id) {
    const s = load()
    const m = s.items.find((x) => x.id === id)
    if (!m) return { ok: false, message: '没有这条' }
    delete m.invalidAt
    delete m.supersededBy
    s.rev = (s.rev || 0) + 1
    save(s)
    return { ok: true }
  }

  function remove(id) {
    const s = load()
    s.items = s.items.filter((m) => m.id !== id)
    s.rev = (s.rev || 0) + 1
    save(s)
    return { ok: true }
  }

  /** 主人换号迁移：旧 QQ 号名下的私聊记忆（private:oldQQ 作用域 + 关于旧号的小档案）整体搬到新号。 */
  function reassignOwner(fromQQ, toQQ) {
    const from = String(fromQQ || '').replace(/\D/g, '')
    const to = String(toQQ || '').replace(/\D/g, '')
    if (from.length < 5 || to.length < 5) return { ok: false, message: 'QQ 号位数不对' }
    if (from === to) return { ok: false, message: '新旧号码一样' }
    const s = load()
    let moved = 0
    for (const m of s.items) {
      let hit = false
      if (m.scope === `private:${from}`) { m.scope = `private:${to}`; m.chatId = `private:${to}`; hit = true }
      if (String(m.about || '') === from) { m.about = to; hit = true }
      if (String(m.aboutName || '') === from) { m.aboutName = to; hit = true }
      if (hit) moved++
    }
    if (moved) { s.rev = (s.rev || 0) + 1; save(s) }
    log.info(`主人迁移：${from} → ${to}，搬了 ${moved} 条记忆`)
    return { ok: true, moved, message: `搬了 ${moved} 条记忆到 ${to}` }
  }

  // 召回负反馈（#5）：用户明显说「记错了」，最近注入过的记忆要降权——BM25 补不上的那半环。
  const MISS_RE = /(记错|不是这[个样]|谁跟你说的?|乱记|瞎记|胡说|没有?这回事|记岔|搞错|什么跟什么|不对吧|才不是)/
  function reportMiss(chatId, text) {
    const t = String(text || '')
    if (!t || !MISS_RE.test(t)) return 0
    const now = Date.now()
    let touched = 0
    for (const entry of recallLog) {
      if (now - Number(entry.at || 0) > 90_000) continue
      if (chatId && entry.where && entry.where !== chatId) continue
      for (const h of entry.hits || []) {
        const s = load()
        const it = s.items.find((x) => x.id === h.id)
        if (!it) continue
        const before = Number(it.importance) || 0.5
        const after = Math.max(0.1, Math.round((before * 0.8) * 100) / 100)
        if (after === before) continue
        it.importance = after
        s.rev = (s.rev || 0) + 1
        save(s)
        log.info(`召回纠错：「${String(it.text).slice(0, 40)}」重要性 ${before} → ${after}（用户说记错了）`)
        touched++
      }
      if (touched) break // 只纠最近一次召回
    }
    return touched
  }

  const recallLog = [] // 最近几次想起了什么（给面板看）
  function recall(query, { about, limit, where = '', context = '', chat = null, scopes = null } = {}) {
    const max = limit ?? getConfig().memory.recallCount
    // 作用域过滤：拿不到当前聊天（chat=null）就不限，保持老调用方行为；
    // 传了 chat 就只留这个聊天可见的（私聊作用域的条目在群里会被物理过滤掉，模型套话也拿不到）。
    // 后台任务（没有 chat 概念）必须显式传 scopes 数组声明可见域（如 ['global','private:10000001']），
    // 否则一律拒绝（fail-closed）——防止后台路径拿到全库。
    const inScopes = (scope) => Array.isArray(scopes) && scopes.includes(String(scope))
    const scoped = (list) => (chat ? list.filter((h) => scopeVisible(h.it.scope, chat))
      : Array.isArray(scopes) ? list.filter((h) => inScopes(h.it.scope))
      : [])
    // 索引本身就按作用域建：传了 chat 只检索它看得见的条目（双保险，scoped 再滤一次）
    // scopes 数组模式：逐个作用域取索引合并检索（候选仍然只有声明过的域，不会碰到别的私聊）
    let idx
    if (chat) idx = indexFor(chat)
    else if (Array.isArray(scopes)) {
      idx = buildIndex(scopes.flatMap((sc) => {
        const i = indexFor(sc)
        return i ? i.docs.map((d) => d.it) : []
      }))
    } else idx = buildIndex([]) // 没声明可见域的后台调用：什么都不给
    const hits = scoped(search(idx, query, { about, limit: chat || Array.isArray(scopes) ? max * 3 : max })).slice(0, max)
    // 这一句没想起几条（「嗯嗯」「然后呢」）：用上一句再找找，分数打折
    if (context && hits.length < max) {
      const have = new Set(hits.map((h) => h.it.id))
      for (const h of scoped(search(idx, context, { about, limit: max * 3, minScore: 0.5 }))) {
        if (hits.length >= max) break
        if (!have.has(h.it.id)) hits.push({ ...h, score: h.score * 0.6, why: [...(h.why || []), '（上一句）'] })
      }
    }
    recallLog.unshift({ at: Date.now(), where, query: String(query).slice(0, 120), hits: hits.map((h) => ({ id: h.it.id, text: h.it.text, score: Number(h.score.toFixed(2)), why: h.why || [] })) })
    recallLog.length = Math.min(recallLog.length, 20)
    if (hits.length) {
      const now = Date.now()
      const todayStr = new Date().toDateString()
      for (const h of hits) {
        const id = h.it.id
        const cur = pendingHitUpdates.get(id) || {
          hits: 0,
          lastHit: 0,
          hitDays: 0,
          lastDayStr: h.it.lastHit ? new Date(h.it.lastHit).toDateString() : ''
        }
        cur.hits += 1
        cur.lastHit = now
        if (cur.lastDayStr !== todayStr) {
          cur.hitDays += 1
          cur.lastDayStr = todayStr
        }
        pendingHitUpdates.set(id, cur)
      }
      scheduleFlushHits()
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

  // ---------- 人物小档案：每个人一小段印象（是谁、什么关系、喜好、近况），聊天时常驻 ----------
  // 档案按「QQ + 作用域」存：私聊里对她的印象不外流到群里，群里认识的也不带到私聊。
  // 键形如 "10000001@private:10000001" / "10000001@group:955741432" / "10000001@global"。
  // 老数据（只按 QQ 号存的）一律当 global，仍然哪里都能用，不会突然失忆。
  function profileKeyOf(qq, scope) {
    const q = String(qq || '')
    if (!q) return ''
    return `${q}@${scope || 'global'}`
  }
  /** 取这个 QQ 在某个作用域下的档案；scope 为空时返回 global 那份（面板/兼容用）。 */
  function profileOf(qq, scope) {
    const all = load().profiles || {}
    const key = profileKeyOf(qq, scope)
    if (key && all[key]) return all[key]
    if (scope) return null
    // 没给作用域：退回老的按 QQ 号存的那份（兼容旧调用与旧数据）
    return all[String(qq)] || null
  }
  function setProfile(qq, text, name = '', scope = '') {
    const s = load()
    s.profiles = s.profiles || {}
    const key = profileKeyOf(qq, scope)
    const t = String(text || '').trim().slice(0, 200)
    const prev = s.profiles[key]
    if (t) s.profiles[key] = { qq: String(qq), scope: scope || 'global', text: t, name: name || prev?.name || '', at: Date.now() }
    else delete s.profiles[key]
    s.rev = (s.rev || 0) + 1
    save(s)
  }

  /** 按这个人的记忆重写小档案（记忆少于 3 条的不写）。scope 限定只用哪个作用域的记忆来写。 */
  async function buildProfile(qq, scope = '') {
    const cfg = getConfig()
    // 只用「这个作用域自己的」记忆写档案。
    // 以前还会把 global 记忆也喂进来（`|| scope === 'global'`），后果是：
    // 在陌生群里给主人写档案时，会把主人私聊里的私事混进去，提炼成一条 global 档案，
    // 于是「私事 → global → 哪里都能读」—— 等于绕过了所有隔离。
    // global 档案该由 global 自己那条线维护，不该由别的聊天代写。
    // scope 为空必须拒绝（fail-closed）：兜不住空 scope 就退化成全库，跨域污染重演。
    if (!String(scope || '').trim()) throw new Error('没说清用哪个作用域的记忆（private:/group:/global），拒绝重写')
    const mine = load().items
      .filter((m) => !m.invalidAt && String(m.about) === String(qq))
      .filter((m) => String(m.scope || '') === String(scope))
      .sort((a, b) => a.at - b.at)
    if (mine.length < 3) return false
    const name = mine.filter((m) => m.aboutName).at(-1)?.aboutName || ''
    const old = profileOf(qq, scope)?.text || ''
    const out = await askModel(dsh, {
      cfg,
      system: '你是「大肥鱼」。根据你记得的关于一个人的事，写一张给自己看的人物小档案：TA 是谁、怎么称呼、和你什么关系、性格和喜好、最近在忙什么。只写记忆里明确有的，不要推测性格、不要编，也不要写「应该」「可能」这种猜的话；旧档案和新记忆矛盾时以新记忆为准。用第三人称，一段话，100 字以内，不要标题和列表。',
      text: `${String(qq) === String(cfg.ownerQQ) ? `这是你的${cfg.ownerName || '主人'}。\n` : ''}旧档案：${old || '（还没有）'}\n\n记得的事（越往下越新）：\n${mine.slice(-40).map((m) => `- [${whenText(m.at)}] ${m.text}`).join('\n')}`,
      maxTokens: 1500,
      temperature: 0.3,
    })
    const text = String(out || '').trim().replace(/^[「"]|[」"]$/g, '')
    if (!text) throw new Error('模型没写出东西，等会儿再试')
    setProfile(qq, text, name, scope)
    return true
  }

  /** 给系统提示词上下文用：人物小档案 + 相处经验（常驻）+ 按这一轮对方说的话检索到的记忆。 */
  function contextFor(chat, sessionId) {
    const cfg = getConfig().memory
    if (!cfg.enabled) return ''
    const parts = []
    // 对这个人（群里是正在说话的几个人）的印象，不用等关键词碰上
    const people = chat.kind === 'group' ? (hub?.speakersOf?.(sessionId) || []).slice(0, 3) : chat.userId ? [chat.userId] : []
    // 档案按当前聊天作用域取：群聊只拿本群里认识的印象，私聊只拿这个私聊的，
    // 再加上 global（她自己设定、大家都该知道的）。私聊里的私事不会进群聊。
    const pScope = scopeOfChat(chat)
    // 当前聊天作用域的档案 + global 档案（不是二选一）：
    // global 档案是**显式标注为公开的那部分**（她自己是谁、大家都该知道的），哪里都能读。
    // 真正要防的是「私事被自动提炼成 global」——那在 buildProfile 里堵，
    // 而不是把 global 整个禁掉（禁掉会让所有正常的人设也读不到）。
    const profs = people
      .map((qq) => {
        const local = profileOf(qq, pScope)
        const glob = pScope === 'global' ? null : profileOf(qq, 'global')
        if (local && glob && local.text !== glob.text) return { ...local, text: `${local.text}；${glob.text}` }
        return local || glob
      })
      .filter(Boolean)
    if (profs.length) parts.push('（你对' + (chat.kind === 'group' ? '正在说话的人' : '对方') + '的印象：' + profs.map((p) => (chat.kind === 'group' && p.name ? p.name + '——' : '') + p.text).join('；') + '）')
    const ins = insightsOf(personKey(chat))
    if (ins.length) parts.push('（和' + (chat.kind === 'group' ? '这个群' : '对方') + '相处的经验，照着做就好，不用说出来：' + ins.map((x) => x.text).join('；') + '）')
    const sty = styleOf(personKey(chat))
    const self = styleOf('self')
    if (sty.length || self.length) {
      parts.push('（说话方式：' + [sty.length ? '和' + (chat.kind === 'group' ? '这个群' : '对方') + '聊久了，' + sty.join('；') : '', self.length ? '你平时不知不觉会用的说法：' + self.join('、') : ''].filter(Boolean).join('。') + '。自然带一点就好，别刻意模仿，也别变成另一个人；若和人设里的硬性规则（尤其是「绝对禁止」）冲突，完全以人设为准，被禁的写法一条都不要用。）')
    }
    // 最近做过的事：不用等别人提，她自己记得（比如刚给你唱过歌）
    const recent = recentEvents(24, 4, chat)
    if (recent.length) parts.push('（你最近做过的事：' + recent.map((m) => `${agoText(m.at)}${m.text}`).join('；') + '。聊到了可以自然提起。）')
    // 注意：随每条消息变化的「相关记忆」不放在这里（#79）——运行时上下文快照每轮都会追加到历史，
    // 内容一变就多一份快照；放在用户消息里（recallHint）只占当轮，不会越滚越大。
    return parts.join('\n')
  }

  // 主人私聊里问起群里的事：才临时把最近 24 小时的群聊流水当成「她自己的见闻」补进这一轮
  // （不常驻、不写进记忆；默认关，面板「聊天 → 主人私聊」里可以调每个群几条、限定只取哪些群）
  const GROUP_TALK = /(群|群聊|群里|他们|大家|那些人在聊)/

  function groupBackdrop (chat, queryText) {
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
        for (const l of hub?.chatLogOf?.(dk) || []) {
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
    // 群白名单：配了就只取这些群（不配 = 所有群）
    const allow = new Set((ob.groups || []).map(String))
    if (allow.size) rows = rows.filter((l) => allow.has(String(l.chatId).slice(6)))
    if (!rows.length) return ''
    // 按群分组，每个群各取最后 limit 条（最多 30），整体再兜一个上限
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
    // 措辞当成「她自己的见闻」，而不是「给她看的材料」——
    // 否则她会回一句「我看到了」，而不是接着聊群里那件事本身。
    return '（下面是你最近在几个群里经历过的片段，属于你自己的见闻 —— **不是主人发给你的消息**，别当成主人在跟你说话。'
      + '主人提到群里的事时，就像回忆自己白天的经历一样接着说下去，不用特意说「我看到了」「我知道了」；'
      + '群里的私事也别主动往外讲。想知道某个具体群的情况，就看你记得的那个群。）\n'
      + blocks.join('\n\n') + '\n【以上是最近群里的情况】'
  }

  /**
   * 这一轮聊到的事相关的记忆（#79）：内容随每条消息变化，所以由模块在「交给她的内容」里附上，
   * 不放进每轮都会追加的运行时上下文快照。最多 4 条、总长 ≤ 300 字。
   */
  function recallHint(chat, queryText, prevText = '', { sessionId } = {}) {
    const cfg = getConfig().memory
    if (!cfg.enabled) return ''
    const q = String(queryText || '').trim()
    if (!q) return ''
    const backdrop = groupBackdrop(chat, q)
    const recent = recentEvents(24, 4, chat)
    const shown = new Set(recent.map((m) => m.id))
    // 说话人消解（P2-2）：群聊里「他养了什么」的「他」是这一轮在说话的人 ——
    // 把 speakersOf 当 about 数组传下去，检索时关于这些人的记忆加分。
    const about = chat && chat.kind === 'private' ? chat.userId
      : chat && chat.kind === 'group' ? (hub?.speakersOf?.(sessionId) || []).slice(0, 3)
      : undefined
    // 「嗯嗯」「然后呢」这种短句单看检索不到东西，把上一句也带上
    const ctxText = q.length < 12 ? String(prevText || '').slice(-300) : ''
    const hits = recall(q, { about, where: (chat && chat.chatId) || '', context: ctxText, chat }).filter((h) => !shown.has(h.it.id)).slice(0, 4)
    // 泛问兜底（P2-1）：「他最近怎么样」和记忆没有任何字词/概念重叠，recall 严格按相关性返回空，
    // 模型会完全失忆。注入场景退而求其次给这个作用域最近的重要记忆（明确检索/清空契约不受影响）。
    if (!hits.length) {
      const now = Date.now()
      const fallback = (chat ? indexFor(chat).docs : [])
        .filter((d) => !d.it.invalidAt && !shown.has(d.it.id))
        .sort((a, b) => (Number(b.it.importance) || 0.5) - (Number(a.it.importance) || 0.5) || b.it.at - a.it.at)
        .slice(0, 2)
        .map((d) => ({ it: d.it, score: 0.3, why: ['（泛问兜底·最近重要）'] }))
      hits.push(...fallback)
    }
    if (!hits.length) return backdrop
    let body = hits.map((h) => memoryLine(h.it)).join('；')
    if (body.length > 300) body = body.slice(0, 300) + '…'
    return ['（你记得这些事，方括号里是什么时候的事，聊到相关的就自然用上，别把老事当新事说，也别说「根据记忆」：' + body + '）', backdrop].filter(Boolean).join('\n')
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
        + (personaGuard() ? '人设硬性规则（style 不得与它冲突；被禁止的标点、格式、长度，对方用得再多也不许学）：\n' + personaGuard() + '\n' : '')
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
    const isQzone = chatId === 'qzone'
    // 空间动态一条就可能有料；聊天至少要几句（3 行太少——「早」「早」「哈哈」也够得着，
    // 模型硬凑出「群里早上打招呼」占配额，2026-11-05 复盘）
    if (talk.filter((l) => l.who !== 'bot').length < (isQzone ? 1 : 6)) return { ok: false, message: '内容太少', added: 0, insights: 0 }
    // 纯寒暄快筛：全是短招呼/语气词就没有提炼价值，不浪费一次模型调用（模型见了硬话也会凑记忆）
    const nonBot = talk.filter((l) => l.who !== 'bot')
    if (!isQzone && nonBot.length <= 12) {
      const substantive = nonBot.filter((l) => {
        const t = String(l.text).trim()
        if (t.length >= 12) return true
        return !/^(早|晚上好|中午好|早安|晚安|哈+|嘿+|嗯+|哦+|在吗|在|来了|吃了吗|睡了|哈哈+|呵呵|666+|好滴|好的|OK|ok|行|嗯嗯|诶|欸|？|\?|~|…|。)+[~！!。～\s]*$/.test(t)
      })
      if (substantive.length === 0) return { ok: false, message: '都是寒暄，没什么可记', added: 0, insights: 0 }
    }
    // 带上 QQ 号，模型才能把事记到人头上（群聊、空间里说话的人很多）
    const line = (l) => (l.who === 'bot' ? '我' : l.uid ? `${l.who}(${l.uid})` : l.who) + '：' + l.text
    try {
      // 太长就分段，每段最多 80 行
      const chunks = []
      for (let i = 0; i < talk.length; i += 80) chunks.push(talk.slice(i, i + 80))
      let n = 0
      // 全量分段提炼（原来只挖最后 3 块=240 行，长群聊前半场直接丢）。
      // 上限 8 块：一天超过 640 行的活跃群，太老的流水价值也低，砍掉头部。
      for (const part of chunks.slice(-8)) n += await extractFacts(chatId, part.map(line).join('\n'))
      log.info(`从 ${chatId} 的${isQzone ? '空间动态' : '聊天'}里提炼了 ${n} 条新记忆`)
      if (isQzone) return { ok: true, added: n, insights: 0 }
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

  /** 这段聊天相关的旧记忆：关于在场的人的 + 和内容相关的，最多 15 条，给模型比对用。 */
  function relatedTo(chatId, transcript) {
    const ppl = new Set([...String(transcript).matchAll(/\((\d{5,})\)/g)].map((m) => m[1]))
    if (chatId.startsWith('private:')) ppl.add(chatId.slice(8))
    // 只在本聊天可见的记忆里挑：以前这里是全量 load().items，
    // 只要聊天记录里出现了某人的 QQ，就会把「关于这个人」的记忆全部捞进来 ——
    // 包括别的作用域的。实测陌生群提一句主人的 QQ，就能把主人私聊的「猫叫粥粥」
    // 当成已知事实喂给提炼模型，接着被写进这个群的新记忆。
    // 作用域：这个聊天自己的 + global。qzone / 推断不出作用的走私聊与 global 两路。
    const scope = scopeFromChatId(chatId)
    const items = load().items.filter((m) => {
      if (m.invalidAt || m.source === 'event' || m.source === 'diary') return false
      const sc = String(m.scope || '').trim()
      if (!sc) return false // 无 scope 老数据：不参与提炼（宁可不给）
      if (sc === 'global') return true
      return scope ? sc === scope : false
    })
    const out = items.filter((m) => m.about && ppl.has(String(m.about))).sort((a, b) => b.at - a.at).slice(0, 10)
    // 用当前聊天的索引：提炼 A 群聊天时，不该把主人私聊或 B 群的记忆当成「已知事实」喂给模型
    for (const h of search(indexFor(chatId), String(transcript).slice(-1500), { limit: 8, minScore: 0.5 })) {
      if (out.length >= 15) break
      if (!out.some((m) => m.id === h.it.id) && h.it.source !== 'event' && h.it.source !== 'diary') out.push(h.it)
    }
    return out
  }

  async function extractFacts(chatId, transcript) {
    const cfg = getConfig()
    const source = chatId === 'qzone' ? '下面是 QQ 空间里的动态（好友发的说说、别人给你的评论、你的回复）' : '下面是一段聊天'
    const related = relatedTo(chatId, transcript)
    const known = new Map(related.map((m) => [m.id, m]))
    const out = await askModel(dsh, {
      cfg,
      system: `你帮一个叫「大肥鱼」的聊天角色整理长期记忆。${source}，说话人后面括号里是 QQ 号。挑出以后值得记住的事实：别人的名字/称呼、喜好、讨厌的东西、身份、近况和重要经历、约定、你们之间的关系变化。不要记寒暄、日常琐事、一次性的问答；不要记大肥鱼自己的人设和喜好（她本来就知道），只记关于别人、以及你们之间的事。每条一句话，主语写清楚是谁。QQ 号是 ${cfg.ownerQQ} 的人是她的${cfg.ownerName || '主人'}。` +
        (related.length ? '\n每条新事实先和「已经记得的事」比一比：全新的写 "op":"add"；是对某条旧记忆的补充或更准确的说法，写 "op":"update"、"id" 填那条的编号、"text" 写合并后的完整说法；和某条旧记忆矛盾、说明那条已经过时（比如以前喜欢现在不喜欢了、换了工作、搬家了、分手了），写 "op":"outdated"、"id" 填旧的编号、"text" 写现在的新事实。拿不准是不是矛盾就当 add；已经记得、没有新信息的不要输出。' : '') +
        `只输出 JSON 数组，例如 [{"op":"add","text":"小明喜欢吃辣","about":"小明","about_qq":"12345","importance":0.6}]（about_qq 写这件事是关于谁的 QQ 号，不知道就不写），没有值得记的就输出 []。`,
      text: (related.length ? `已经记得的事：\n${related.map((m) => `#${m.id} [${whenText(m.at)}] ${m.aboutName ? '[' + m.aboutName + '] ' : ''}${m.text}`).join('\n')}\n\n` : '') + transcript,
      maxTokens: 1500,
      temperature: 0.2,
    })
    const m = out.match(/\[[\s\S]*\]/)
    let arr = []
    if (m) {
      try { arr = JSON.parse(m[0]) } catch { arr = [] }
    }
    let n = 0
    for (const x of arr.slice(0, 12)) {
      if (!x || !x.text) continue
      if (/^(我|大肥鱼)/.test(String(x.about || '')) || String(x.about || '') === '大肥鱼') continue
      // 关于谁：模型给了 QQ 号就用（群聊、空间里也能记到人头上），私聊默认是对方
      const qq = String(x.about_qq ?? '').replace(/\D/g, '')
      const about = qq.length >= 5 && qq !== String(cfg.botQQ) ? qq : chatId.startsWith('private:') ? chatId.slice(8) : ''
      const op = String(x.op || 'add')
      const target = known.get(String(x.id || '').replace(/^#/, ''))
      // 补充旧的（你在面板里亲手写的不改写）
      if (op === 'update' && target && target.source !== 'panel') {
        if (revise(target.id, x.text, x.importance)) n++
        continue
      }
      // 旧的过时了：先标过时（这样新的不会被当成重复合并进去），再记新的
      if (op === 'outdated' && target) {
        invalidate(target.id)
        const r = add({ text: x.text, aboutName: x.about || target.aboutName || '', about: about || target.about || '', importance: x.importance ?? target.importance ?? 0.5, source: 'auto', chatId, scope: scopeFromChatId(chatId) })
        if (r.id || r.updated) {
          invalidate(target.id, r.id || r.updated)
          log.info(`记忆更新：「${target.text}」过时了 → 「${String(x.text).slice(0, 60)}」`)
          n++
        }
        continue
      }
      const r = add({ text: x.text, aboutName: x.about || '', about, importance: x.importance ?? 0.5, source: 'auto', chatId, scope: scopeFromChatId(chatId) })
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
    const startedAt = Date.now()
    let added = 0
    let insights = 0
    let days = 0
    let profiles = 0
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
      // 这次记忆有变化的人，重写人物小档案（每次最多 8 个人）
      const live = load()
      const touched = [...new Set(live.items
        .filter((m) => m.about && (m.at >= startedAt || (m.invalidAt || 0) >= startedAt))
        .map((m) => profileKeyOf(m.about, String(m.scope || 'global'))))]
      // 还没有小档案、但已经记了不少事的人也补上（刚升级时一次补几个，按记得的多少排）
      // 关键：按「QQ + 作用域」分组重建，绝不能用全部记忆混写一份 ——
      // 混写会把私聊里的私事写进一份所有聊天都能读的档案，群聊照样套得到。
      const count = new Map()
      for (const m of live.items) {
        if (!m.about || m.invalidAt) continue
        const sc = String(m.scope || 'global')
        const key = profileKeyOf(m.about, sc)
        count.set(key, (count.get(key) || 0) + 1)
      }
      const missing = [...count]
        .filter(([key, n]) => n >= 3 && !(live.profiles || {})[key] && !touched.some((t) => t === key))
        .sort((x, y) => y[1] - x[1])
        .map(([key]) => key)
      const targets = [...new Set([...touched, ...missing])].slice(0, 8)
      for (const key of targets) {
        const at = key.lastIndexOf('@')
        const qq = at > 0 ? key.slice(0, at) : key
        const scope = at > 0 ? key.slice(at + 1) : 'global'
        try { if (await buildProfile(qq, scope)) profiles++ } catch (error) { log.warn('写人物小档案失败：', error.message) }
      }
      const s = load()
      // ① 模糊化（surfcore 记忆卡设计）：fuzzy 档把正文截断成「只剩大意」，trace 档只留标题。
      //    只动经历类（event）且非主人相关的；正文一截，检索和上下文都省，但还认得出是什么事。
      const nowC = Date.now()
      let blurred = 0
      for (const it of s.items) {
        if (it.invalidAt || it.pinned) continue
        if (it.source !== 'event' && it.source !== 'auto') continue
        const item = { ...it, ownerQQ: getConfig()?.ownerQQ || '' }
        const step = clarityOf(item, nowC)
        if (step !== 'fuzzy' && step !== 'trace') continue
        const raw = String(it.text || '')
        if (step === 'fuzzy' && raw.length > 40) { it.text = raw.slice(0, 40) + '…（记不太清了）'; it.clarity = 'fuzzy'; blurred++ }
        else if (step === 'trace' && raw.length > 16) { it.text = raw.slice(0, 16) + '…（只剩个印象）'; it.clarity = 'trace'; blurred++ }
      }
      // ② 遗忘：不重要、很久没被想起的清掉，记忆库不会越堆越乱
      const before = s.items.length
      s.items = s.items.filter((m) => !shouldForget({ ...m, ownerQQ: getConfig()?.ownerQQ || '' }))
      const forgot = before - s.items.length
      s.lastConsolidate = { day: today, at: Date.now(), added, insights, days, forgot, blurred, profiles }
      save(s)
      log.info(`整理临时记忆：处理了 ${days} 天，新增或更新 ${added} 条长期记忆，更新了 ${insights} 份相处经验、${profiles} 份人物小档案${blurred ? `，${blurred} 条旧的变模糊了` : ''}${forgot ? `，忘掉 ${forgot} 条不重要的旧记忆` : ''}`)
      return { ok: true, added, insights, days, forgot, blurred, profiles, message: `整理好了：新增或更新 ${added} 条记忆，更新 ${insights} 份相处经验、${profiles} 份人物小档案${blurred ? `，${blurred} 条变模糊` : ''}${forgot ? `，忘掉 ${forgot} 条旧的` : ''}` }
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
        system: '你是「大肥鱼」。下面是你和不同的人聊天时注意到的说话习惯，以及你自己已经养成的说法。挑出你和大家聊久了、自然会被带上的说话方式（口头禅、语气词、发消息的节奏），保持你原本的性格，不超过 6 条，每条不超过 20 字。只输出 JSON 数组。' + (personaGuard() ? ' 注意：下面这些人设硬性规则优先级最高，学到的说法不得与它冲突：' + personaGuard() : ''),
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
    if (!cfg.enabled || !cfg.dailyConsolidate) {
      const cutoff = dayKey(new Date(Date.now() - 14 * 86400_000))
      for (const day of hub.chatLogDays?.() || []) if (day < cutoff) hub.deleteChatLog(day)
      return
    }
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

  /**
   * 群聊话题和这个聊天里的记忆有多相关（0~1），给插话判断用。
   *
   * **必须传 chat**。以前不传，查的是全量索引：陌生群只要提到主人私聊里出现过
   * 的词（实测「NAS」0.13、「Docker」0.25），插话相关度就被抬高 50% 权重下的对应值，
   * 她会因此主动开口，而开口的内容来自主人的私聊记忆 —— 事故的直接推力。
   * 现在按当前聊天的索引算，别处记的东西不会让她在陌生群里「感兴趣」。
   */
  function topicScore(text, chat = null) {
    if (!chat) return 0 // fail-closed：不知道在哪个聊天，就当不相关
    const hits = search(indexFor(chat), text, { limit: 1, minScore: 0.01 })
    return hits.length ? Math.min(1, hits[0].score / 3) : 0
  }

  /**
   * 清空某个聊天的记忆（/new 命令用）：只删这个作用域的东西，别的聊天不受影响。
   * 一起清掉三样，否则「清了记忆」她还会按旧档案和旧经验说话：
   *   1) 这个作用域下的记忆条目  2) 这个人的小档案  3) 相处经验 + 说话方式
   * 属于 global 的记忆不动（她自己的设定、公开发生的事）。注意 B 站/抖音这类浏览记录
   * 默认就落在主人私聊，所以执行 /new 会一并清掉 —— 这正是想要的效果。
   * @returns {{items:number, profile:number, insights:number, style:number}} 各清了多少
   */
  function clearScope(chat) {
    const scope = scopeOfChat(chat)
    const key = personKey(chat)
    const s = load()
    const before = s.items.length
    // 只删 scope 完全等于当前聊天的；global 与别人的私聊一律保留
    s.items = s.items.filter((m) => String(m.scope || '') !== scope)
    const items = before - s.items.length
    let profile = 0
    if (key || scope) {
      s.profiles = s.profiles || {}
      for (const k of Object.keys(s.profiles)) {
        const p = s.profiles[k]
        const pScope = p?.scope || (k.includes('@') ? k.slice(k.lastIndexOf('@') + 1) : 'global')
        if (pScope === scope) { delete s.profiles[k]; profile++ }
      }
    }
    let insights = 0
    let style = 0
    if (key && s.insights && s.insights[key]) { insights = s.insights[key].length; delete s.insights[key] }
    if (key && s.styles && s.styles[key]) { style = (s.styles[key] || []).length; delete s.styles[key] }
    s.rev = (s.rev || 0) + 1
    save(s)
    recallLog.length = 0 // 面板上「最近想起了什么」也一起清掉，免得还显示着删掉的条目
    return { scope, items, profile, insights, style }
  }

  return {
    recallHint,
    scopeOfChat, scopeVisible, registerScopeOverride,
    add, addEvent, recentEvents, update, remove, restore, recall, contextFor, consolidate, tick, topicScore, importCandidates, importCommit, clearScope, relatedTo, indexFor, indexAll, reassignOwner, reportMiss,
    profiles: () => {
      const s = load()
      return Object.entries(s.profiles || {}).map(([key, p]) => {
        // key 形如 "qq@scope"；老数据是纯 qq（无 @），按 global 处理
        const at = key.lastIndexOf('@')
        const qq = p.qq || (at > 0 ? key.slice(0, at) : key)
        const scope = p.scope || (at > 0 ? key.slice(at + 1) : 'global')
        return { key, qq, scope, ...p, qq, scope }
      }).sort((a, b) => b.at - a.at)
    },
    profileOf, profileKeyOf, setProfile, buildProfile,
    recalls: () => recallLog.slice(),
    styles: () => load().styles || {},
    setStyle: (key, list) => setStyle(key, (list || []).map(String)),
    lastConsolidate: () => load().lastConsolidate || null,
    insights: () => {
      const s = load()
      return Object.entries(s.insights || {}).map(([key, list]) => ({ key, name: (s.insightNames || {})[key] || '', list }))
    },
    setInsights: (key, list) => setInsights(key, list.map((x) => (typeof x === 'string' ? { id: randomUUID().slice(0, 8), text: x, at: Date.now() } : x))),
    /** 删一条相处经验：insights[key] 是 {id,text,at} 数组，按 id 摘掉一条。 */
    removeInsight: (key, id) => {
      const s = load()
      const list = (s.insights || {})[key] || []
      const next = list.filter((x) => String(x.id) !== String(id))
      if (next.length === list.length) return false
      setInsights(key, next, (s.insightNames || {})[key] || '')
      return true
    },
    /** 删一个人物小档案：profileKeyOf(qq, scope) 命中才删，text 传空字符串即删。 */
    removeProfile: (qq, scope) => { setProfile(qq, '', '', scope); return true },
    list: (q) => {
      const items = load().items
      // 面板里过时的也列出来（排在后面），能看到被哪条取代、能恢复
      const textOf = new Map(items.map((m) => [m.id, m.text]))
      const withBy = (m) => (m.supersededBy ? { ...m, supersededText: textOf.get(m.supersededBy) || '' } : m)
      if (!q) return items.slice().sort((a, b) => (Boolean(a.invalidAt) - Boolean(b.invalidAt)) || b.at - a.at).map(withBy)
      // 面板搜索：主人自己看全库，这里有意识地用全量索引
      return search(indexAll(), q, { limit: 100, minScore: 0.01, includeInvalid: true }).map((h) => withBy({ ...h.it, score: Number(h.score.toFixed(2)) }))
    },
    stats: () => {
      const items = load().items
      const live = items.filter((m) => !m.invalidAt)
      return { count: live.length, auto: live.filter((m) => m.source === 'auto').length, events: live.filter((m) => m.source === 'event').length, outdated: items.length - live.length }
    },
    /** 关闭存储层（宿主退出/热重载时调用；SQLite 要 close 才不落脏 WAL）。 */
    dispose: () => { try { flushHits() } catch (error) {} try { store?.close?.() } catch (error) {} store = null },
  }
}
