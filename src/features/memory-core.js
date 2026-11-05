// 记忆核心纯函数层（1.3.48 拆分）：配额、切词、BM25 索引与检索、相似度、时间文案、
// 清晰度/遗忘曲线、回执解析。全部无 I/O、无状态——状态与副作用在 memory.js 的 createMemoryStore。
// 对外入口不变：memory.js re-export 这里的所有名字。

import { conceptsOf } from './memory-concepts.js'

// ---------------- 纯函数：切词与打分 ----------------

const STOP = new Set('的了是我你他她它们在有和就不也都很吗吧呢啊呀哦嗯这那个一上下来去说要会能着过'.split(''))

// ---------------- 作用域配额（P1-2） ----------------
// 全局 3000 条上限的问题：多群+多私聊很快顶满，然后按重要度整体裁，
// 可能把某个作用域整段清空，还没有日志。改成每个作用域独立配额。
export const SCOPE_QUOTAS = { global: 500, group: 400, private: 300 }
export const TOTAL_CAP = 6000 // 兜底：所有作用域加起来也别无限涨

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
/** 一条记忆太长时按句子边界收短，实在没有句读才用省略号（绝不从半句中间断）。 */
export function cutAtSentence(line, max = 120) {
  const s = String(line || '')
  if (s.length <= max) return s
  const head = s.slice(0, max)
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf(';'), head.lastIndexOf('，'), head.lastIndexOf(','))
  if (cut > max * 0.5) return head.slice(0, cut + 1)
  return head + '…'
}

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

