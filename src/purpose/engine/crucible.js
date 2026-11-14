/**
 * 潜伏素材熔炉（crucible）—— 纯逻辑层。
 *
 * 素材潜伏 → 到期发酵 → 产物注入：
 *   · ingest  把 RSS / B站 / 群聊里「没被消费掉的线索」沉淀进素材池（同 fingerprint 只续期，不重复）；
 *   · prune   到期的先烂掉（TTL 裁剪），池子超过上限时淘汰最旧的；
 *   · match   按「这个会话关心什么」给池子打分，只吐 top-N；没命中就返回空数组，绝不随机兜底；
 *   · fingerprint 内容指纹（source|url|title|summary），跨重启可复现。
 *
 * 模块边界：本文件零 I/O、零网络，只做「算」。落盘（data/mind/lurk-pool.json）与取素材
 * 都在接线层，单测可以只测这里。
 *
 * 隐私单向流动：条目可带可选 scope（'global' | 'private:<id>' | 'group:<id>'），
 * 缺省视为 global；match 只允许 chatKey 完全相同的非全局条目命中 —— 主人私聊里的私事
 * 永远不会成为群聊的插话素材（计划书 §七 隐私单向流动铁律）。
 *
 * ⚠️ 接线状态（US-012 有意为之）：本模块**尚未接线**，目前只有测试在调用它，属于「已交付但
 * 尚未通电」的纯函数层 —— 故事 AC 只要求纯函数层。后续故事的接入点有两处：
 *   · `src/purpose/engine.js`（barrel）—— 需要把本文件的具名导出补进 re-export 列表；
 *   · `src/purpose/module.js` 的 lurk-pool 落盘 / 取素材处 —— 真正的 ingest/prune/match 调用点。
 * 在接上之前，`match` 返回的条目一律是深拷贝，接线层可以放心把素材交给提示词组装，不用担心
 * 反向改坏池子。
 */

import { createHash } from 'node:crypto'
import { DAY, MINUTE, isPlainObject } from './shared.js'

/** 素材来源：只认这三种（非法来源 fail-closed 抛错，不静默丢）。 */
export const CRUCIBLE_SOURCES = Object.freeze(['rss', 'bili', 'group'])

/** 默认潜伏 3 天：够久到「迟到的接话」有意义，又不至于把过时资讯当生活线索。 */
export const CRUCIBLE_DEFAULT_TTL_MS = 3 * DAY
export const CRUCIBLE_MIN_TTL_MS = 5 * MINUTE
export const CRUCIBLE_MAX_TTL_MS = 30 * DAY
export const CRUCIBLE_MAX_ENTRIES = 500

export const CRUCIBLE_TITLE_MAX = 160
export const CRUCIBLE_SUMMARY_MAX = 600
export const CRUCIBLE_TAG_MAX = 24
export const CRUCIBLE_MAX_TAGS = 12
export const CRUCIBLE_URL_MAX = 1024
export const CRUCIBLE_INTEREST_MAX = 32
export const CRUCIBLE_MAX_INTERESTS = 24

/** match 默认 top-N 与上限。 */
export const CRUCIBLE_MATCH_LIMIT = 5
export const CRUCIBLE_MAX_MATCH_LIMIT = 20

/** 命中字段权重：标题最重，标签次之，摘要只做佐证。 */
const FIELD_WEIGHTS = Object.freeze({ title: 3, tags: 2.5, summary: 1.5 })

const SCOPE_RE = /^(global|private:\S+|group:\S+)$/
const URL_RE = /^https?:\/\//i

function fail(message) {
  throw new TypeError(`crucible: ${message}`)
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** 严格裁剪：结果长度**一定 ≤ max**（shared.clip 会多补一个省略号，在这里就越过上限了）。 */
function clipStrict(value, max) {
  const s = oneLine(value)
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

function normalizeCount(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function normalizeNow(now) {
  const at = Number(now)
  if (!Number.isFinite(at) || at <= 0) fail('now 必须是正的毫秒时间戳')
  return at
}

/**
 * 内容指纹：source + url + title + summary 的 sha256 前缀。
 * 刻意不含 capturedAt / ttlMs —— 同一条素材再被抓到时指纹不变，才能「只更新时间」。
 */
export function fingerprint(material) {
  if (!isPlainObject(material)) fail('fingerprint 需要素材对象')
  const parts = [
    oneLine(material.source).toLowerCase(),
    oneLine(material.url).toLowerCase(),
    oneLine(material.title),
    oneLine(material.summary),
  ]
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32)
}

function normalizeUrl(raw) {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') fail('url 必须是字符串')
  const url = raw.trim()
  if (!url) return ''
  if (url.length > CRUCIBLE_URL_MAX) fail(`url 超过 ${CRUCIBLE_URL_MAX} 字符`)
  if (!URL_RE.test(url)) fail('url 必须是 http(s) 地址')
  return url
}

function normalizeTags(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) fail('tags 必须是数组')
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (typeof item !== 'string' && typeof item !== 'number') fail('tags 只能包含字符串')
    const tag = oneLine(item).toLowerCase()
    if (!tag) continue
    const safe = tag.length > CRUCIBLE_TAG_MAX ? tag.slice(0, CRUCIBLE_TAG_MAX) : tag
    if (seen.has(safe)) continue
    seen.add(safe)
    out.push(safe)
    if (out.length >= CRUCIBLE_MAX_TAGS) break
  }
  return out
}

function normalizeScope(raw) {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') fail('scope 必须是字符串')
  const scope = raw.trim()
  if (!scope) return ''
  if (!SCOPE_RE.test(scope)) fail(`非法 scope「${raw}」`)
  return scope
}

function normalizeCapturedAt(raw, now) {
  if (raw === undefined || raw === null || raw === '') return now
  const at = Number(raw)
  if (!Number.isFinite(at) || at <= 0) fail('capturedAt 必须是正的毫秒时间戳')
  return Math.round(at)
}

function normalizeTtl(raw) {
  if (raw === undefined || raw === null || raw === '') return CRUCIBLE_DEFAULT_TTL_MS
  const ttl = Number(raw)
  if (!Number.isFinite(ttl) || ttl <= 0) fail('ttlMs 必须是正数（毫秒）')
  return Math.min(CRUCIBLE_MAX_TTL_MS, Math.max(CRUCIBLE_MIN_TTL_MS, Math.round(ttl)))
}

/** 外部线索 → 池内素材（结构固定：source/title/summary/url/tags/capturedAt/ttlMs/fingerprint）。 */
function buildEntry(raw, now) {
  if (!isPlainObject(raw)) fail('素材必须是对象')
  const source = oneLine(raw.source).toLowerCase()
  if (!CRUCIBLE_SOURCES.includes(source)) {
    fail(`非法 source「${oneLine(raw.source)}」，只接受 ${CRUCIBLE_SOURCES.join('|')}`)
  }
  const title = clipStrict(raw.title, CRUCIBLE_TITLE_MAX)
  const summary = clipStrict(raw.summary, CRUCIBLE_SUMMARY_MAX)
  if (!title && !summary) fail('title 与 summary 不能同时为空')
  const entry = {
    source,
    title,
    summary,
    url: normalizeUrl(raw.url),
    tags: normalizeTags(raw.tags),
    capturedAt: normalizeCapturedAt(raw.capturedAt, now),
    ttlMs: normalizeTtl(raw.ttlMs),
  }
  entry.fingerprint = fingerprint(entry)
  const scope = normalizeScope(raw.scope)
  if (scope) entry.scope = scope
  return entry
}

function poolEntries(pool) {
  if (pool === undefined || pool === null) return []
  if (!Array.isArray(pool)) fail('素材池必须是数组')
  return pool.filter(isPlainObject)
}

function mergeTags(left, right) {
  const out = []
  for (const tag of [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]) {
    if (typeof tag !== 'string' || !tag) continue
    if (out.includes(tag)) continue
    out.push(tag)
    if (out.length >= CRUCIBLE_MAX_TAGS) break
  }
  return out
}

function expireAtOf(entry) {
  const capturedAt = Number(entry.capturedAt)
  if (!Number.isFinite(capturedAt) || capturedAt <= 0) return 0
  const ttl = Number(entry.ttlMs)
  return capturedAt + (Number.isFinite(ttl) && ttl > 0 ? ttl : CRUCIBLE_DEFAULT_TTL_MS)
}

function isExpired(entry, now) {
  return now >= expireAtOf(entry)
}

/**
 * 超上限时按「最旧」淘汰，返回新池子与被淘汰的指纹。prune 与 ingest 共享同一套淘汰规则，
 * 免得「写入口没有上限、读出口才有上限」这种只在清理时才收口的漏洞。
 */
function trimToLimit(entries, limit) {
  const overflow = entries.length - limit
  if (overflow <= 0) return { pool: entries, removed: [] }
  const byOldest = [...entries].sort((a, b) => (
    (Number(a.capturedAt) || 0) - (Number(b.capturedAt) || 0)
    || String(a.fingerprint ?? '').localeCompare(String(b.fingerprint ?? ''))
  ))
  const dropped = byOldest.slice(0, overflow)
  const removed = dropped.map((entry) => entry.fingerprint)
  const dropSet = new Set(removed)
  return { pool: entries.filter((entry) => !dropSet.has(entry.fingerprint)), removed }
}

/**
 * 沉淀素材：把一条（或一批）线索并进池子。
 *
 *   ingest(pool, item, { now, maxEntries })
 *
 * 同 fingerprint 命中已有条目时**只续期**（capturedAt 取较晚者、ttlMs 取较大者、tags 取并集），
 * 不产生第二条，也不覆盖最初的标题/摘要 —— 素材是事实，事实只增不改。
 * 非法输入（非对象、非法 source、非法 url/tags/时间）一律抛 TypeError，不做「猜一下」。
 *
 * 自身也带硬上限（与 prune 共享 CRUCIBLE_MAX_ENTRIES 与同一套 trimToLimit）：写入口不留
 * 无条件增长的余地，否则连续 ingest 会先把池子撑到几千条、再让每次续期都退化成 O(n)。
 * 超上限时按最旧淘汰，被淘汰的指纹进 evicted；added / refreshed 只报**还留在池里**的指纹。
 *
 * @returns {{ pool: object[], added: string[], refreshed: string[], evicted: string[] }}
 */
export function ingest(pool, incoming, { now = Date.now(), maxEntries = CRUCIBLE_MAX_ENTRIES } = {}) {
  const at = normalizeNow(now)
  const limit = normalizeCount(maxEntries, CRUCIBLE_MAX_ENTRIES, 1, CRUCIBLE_MAX_ENTRIES)
  const next = poolEntries(pool).map((entry) => ({
    ...entry,
    tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
    fingerprint: typeof entry.fingerprint === 'string' && entry.fingerprint ? entry.fingerprint : fingerprint(entry),
  }))
  const index = new Map()
  next.forEach((entry, i) => index.set(entry.fingerprint, i))

  const batch = Array.isArray(incoming) ? incoming : [incoming]
  const added = []
  const refreshed = []
  for (const raw of batch) {
    const entry = buildEntry(raw, at)
    const pos = index.get(entry.fingerprint)
    if (pos === undefined) {
      index.set(entry.fingerprint, next.length)
      next.push(entry)
      added.push(entry.fingerprint)
      continue
    }
    const prev = next[pos]
    next[pos] = {
      ...prev,
      capturedAt: Math.max(Number(prev.capturedAt) || 0, entry.capturedAt),
      ttlMs: Math.max(Number(prev.ttlMs) || 0, entry.ttlMs),
      tags: mergeTags(prev.tags, entry.tags),
    }
    if (!refreshed.includes(entry.fingerprint)) refreshed.push(entry.fingerprint)
  }
  const trimmed = trimToLimit(next, limit)
  if (!trimmed.removed.length) return { pool: trimmed.pool, added, refreshed, evicted: [] }
  const alive = new Set(trimmed.pool.map((entry) => entry.fingerprint))
  return {
    pool: trimmed.pool,
    added: added.filter((print) => alive.has(print)),
    refreshed: refreshed.filter((print) => alive.has(print)),
    evicted: trimmed.removed,
  }
}

/**
 * 到期发酵前的清理：剔掉过期条目，再按上限淘汰最旧的。
 *
 *   prune(pool, { now, maxEntries })
 *
 * 返回的 pool 里每一条都是**深拷贝**（`tags` 换新数组）：调用方对返回值做的任何改动都不会
 * 回流到入参 pool。少了这一层，`prune(pool).pool[0].title = 'x'` 会直接把调用方的池子改坏。
 *
 * @returns {{ pool: object[], removed: string[] }} 换下来的指纹（过期 + 超上限）
 */
export function prune(pool, { now = Date.now(), maxEntries = CRUCIBLE_MAX_ENTRIES } = {}) {
  const at = normalizeNow(now)
  const limit = normalizeCount(maxEntries, CRUCIBLE_MAX_ENTRIES, 1, CRUCIBLE_MAX_ENTRIES)
  const kept = []
  const removed = []
  for (const entry of poolEntries(pool)) {
    if (isExpired(entry, at)) {
      removed.push(typeof entry.fingerprint === 'string' && entry.fingerprint ? entry.fingerprint : fingerprint(entry))
      continue
    }
    // 深拷贝后再放进结果：`prune(pool).pool[0].title = '改坏'` 不能把入参 pool 改掉。
    kept.push(cloneEntry(entry))
  }
  const trimmed = trimToLimit(kept, limit)
  removed.push(...trimmed.removed)
  return { pool: trimmed.pool, removed }
}

/** 单条素材的深拷贝：顶层字段展开 + tags 换新数组（严禁把内层数组引用露出去）。 */
function cloneEntry(entry) {
  return {
    ...entry,
    tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
  }
}

function cloneEntries(pool) {
  return poolEntries(pool).map(cloneEntry)
}

/**
 * 把池子关进闭包的小外壳（仍然零 I/O）：`factory.match(chatKey, interests)` 就是计划书里
 * 「按这个会话关心什么去池子里挑素材」的直接写法，省得每处调用都把 pool 传来传去。
 *
 * 真正的逻辑只有上面三个纯函数，这里仅做 pool 绑定；每次返回的都是副本，外部改动
 * 不会回流到内部池子（防止「谁拿到素材谁顺手改一笔」）。
 */
export function createCrucible(initialPool = []) {
  let pool = cloneEntries(initialPool)
  return {
    entries() {
      return pool.map((entry) => ({ ...entry, tags: [...entry.tags] }))
    },
    ingest(incoming, options) {
      const result = ingest(pool, incoming, options)
      pool = result.pool
      // 内部池拿的是 result.pool 的引用，所以交出去的必须是副本（否则 added/evicted 之外
      // 的 pool 会与内部池同一份，一次 tag 注入就污染了整池）。
      return {
        pool: cloneEntries(result.pool),
        added: [...result.added],
        refreshed: [...result.refreshed],
        evicted: [...result.evicted],
      }
    },
    prune(options) {
      const result = prune(pool, options)
      pool = result.pool
      // `c.prune().pool[0].tags.push('注入')` 曾经直接改到内部池：必须交深拷贝。
      return { pool: cloneEntries(result.pool), removed: [...result.removed] }
    },
    match(chatKey, interests, options) {
      return match(pool, chatKey, interests, options)
    },
  }
}

/** 取兴趣对象的词（别名 word/text/keyword/tag 只认字符串，其他类型 fail-closed）。 */
function interestWord(raw, isObject) {
  if (!isObject) return raw
  for (const key of ['word', 'text', 'keyword', 'tag']) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') fail(`兴趣对象的 ${key} 必须是字符串`)
    return value
  }
  return ''
}

function normalizeInterests(interests) {
  if (interests === undefined || interests === null) return []
  const list = Array.isArray(interests) ? interests : [interests]
  const out = []
  const index = new Map()
  for (const raw of list) {
    const obj = isPlainObject(raw)
    // fail-closed：兴趣元素只认字符串或 { word, weight } 对象。数字/布尔/null 一律抛错，
    // 而不是被 oneLine 强转成 "123" 去池子里误命中（验证者实测 [123] 能返回 5 条）。
    if (!obj && typeof raw !== 'string') fail('兴趣元素必须是字符串或 { word, weight } 对象')
    // 对象形式同样 fail-closed：`{ word: 123 }` 若走 oneLine 会被强转成 "123" 参与打分，
    // 与上一条同一类静默强转。这里选「抛错」而不是「跳过」：跳过会让写错的调用方静默拿到
    // 0 条结果，错误被吞掉更难发现。
    const text = oneLine(interestWord(raw, obj)).toLowerCase()
    if (!text) continue
    const term = text.length > CRUCIBLE_INTEREST_MAX ? text.slice(0, CRUCIBLE_INTEREST_MAX) : text
    let weight = 1
    if (obj && raw.weight !== undefined && raw.weight !== null) {
      const w = Number(raw.weight)
      if (!Number.isFinite(w) || w <= 0) fail('兴趣权重必须是正数')
      weight = Math.min(10, Math.max(0.1, w))
    }
    const pos = index.get(term)
    if (pos === undefined) {
      index.set(term, out.length)
      out.push({ text: term, weight })
    } else if (weight > out[pos].weight) {
      out[pos] = { text: term, weight }
    }
  }
  return out.slice(0, CRUCIBLE_MAX_INTERESTS)
}

function normalizeChatKey(chatKey) {
  if (chatKey === undefined || chatKey === null) return ''
  if (typeof chatKey !== 'string') fail('chatKey 必须是字符串')
  return chatKey.trim()
}

function scopeVisible(scope, chatKey) {
  if (!scope || scope === 'global') return true
  return scope === chatKey
}

function scoreEntry(entry, terms) {
  const title = oneLine(entry.title).toLowerCase()
  const summary = oneLine(entry.summary).toLowerCase()
  const tags = Array.isArray(entry.tags) ? entry.tags.map((tag) => String(tag).toLowerCase()) : []
  const hits = []
  let score = 0
  for (const term of terms) {
    let hit = 0
    if (title && title.includes(term.text)) hit += FIELD_WEIGHTS.title
    if (tags.some((tag) => tag.length >= 2 && (tag.includes(term.text) || term.text.includes(tag)))) hit += FIELD_WEIGHTS.tags
    if (summary && summary.includes(term.text)) hit += FIELD_WEIGHTS.summary
    if (hit <= 0) continue
    score += hit * term.weight
    hits.push(term.text)
  }
  return { score: Math.round(score * 1000) / 1000, hits }
}

/**
 * 按这个会话关心的事（兴趣 / 关键词）给池子打分，返回 top-N。
 *
 *   match(pool, chatKey, interests, { now, limit })
 *
 * - interests：字符串数组，或 [{ word, weight }]（权重 0.1~10）；空/无命中 → `[]`，不做随机兜底；
 * - 过期素材不参与；带 scope 的素材只在 chatKey 完全相同时可见（隐私单向流动）；
 * - 排序：得分降序 → capturedAt 降序 → fingerprint 升序（完全确定性）。
 *
 * 返回条目是**深副本** + `score` / `hits`：`tags` 换新数组（`[...tags]`），调用方随手 push /
 * 改元素都不会回流到池子。少了这一层，`match(...)[0].tags.push('注入')` 就能跨会话污染池子。
 */
export function match(pool, chatKey, interests, { now = Date.now(), limit = CRUCIBLE_MATCH_LIMIT } = {}) {
  const at = normalizeNow(now)
  const key = normalizeChatKey(chatKey)
  const terms = normalizeInterests(interests)
  const top = normalizeCount(limit, CRUCIBLE_MATCH_LIMIT, 1, CRUCIBLE_MAX_MATCH_LIMIT)
  if (!terms.length) return []
  const scored = []
  for (const entry of poolEntries(pool)) {
    if (isExpired(entry, at)) continue
    if (!scopeVisible(entry.scope, key)) continue
    const { score, hits } = scoreEntry(entry, terms)
    if (score <= 0) continue
    scored.push({
      ...entry,
      tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
      score,
      hits: [...hits],
    })
  }
  scored.sort((a, b) => (
    b.score - a.score
    || (Number(b.capturedAt) || 0) - (Number(a.capturedAt) || 0)
    || String(a.fingerprint ?? '').localeCompare(String(b.fingerprint ?? ''))
  ))
  return scored.slice(0, top)
}
