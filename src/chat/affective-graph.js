// P4 · 信任矩阵与专属梗词表（affective-graph）。
//
// 关系演化要「有据可查」：等级只能被**可解释信号**推动，不允许随机跃迁。
// 这一层是纯内存的图算法 + 隐私隔离断言，零 I/O；调用方（宿主）自己决定什么时候落盘
// `data/mind/affective-graph.json`（toJSON / load 提供确定性快照）。
//
// 三个等级：0 陌生人（不主动私聊）/ 1 熟络好友 / 2 挚友。
// 隐私铁律：scope 由 ChatKey 决定（`private:<uid>` / `group:<gid>`），
// 私聊里攒下的等级与梗**绝对不可**被群 scope 读到——越界直接抛 AffectiveScopeError。
//
// ⚠️ 本模块尚未接主链（US-015 只交付纯算法层，避免跨故事混改）。
// 生产接线点：`src/host/modular-core.js` 的回复姿态组装处（与 `group-atmosphere-gate` 同层，
// 由 US-021 集成验证时统一核对）——那一处必须把**当前会话的 ChatKey** 作为 `viewer` 显式传入
// （或在 createAffectiveGraph({ viewer }) 里声明图级 viewer），并消费 tone() 的
// temperature / jokeScale 去调回复温度与玩笑尺度。接线完成前 tone() 没有任何调用方。

import { parseChatKey } from './chat-key.js'

/** 等级语义（下标即等级值）。 */
export const TRUST_LEVEL_LABELS = Object.freeze(['陌生人', '熟络好友', '挚友'])
export const TRUST_MIN = 0
export const TRUST_MAX = 2
/** 空图默认等级：陌生人（不主动私聊）。 */
export const DEFAULT_LEVEL = 0

/** 梗文本长度上限（超出截断）：梗词表是「暗号」，不该变成小作文仓库。 */
export const MAX_JOKE_LENGTH = 200

/** 等级跃迁门槛：累计权重分 ≥ 阈值即到达该等级。 */
export const LEVEL_THRESHOLDS = Object.freeze([0, 3, 7])

/** 可解释信号词表：只有词表内的信号能推动信任度，未知信号一律拒收（fail-closed）。 */
export const SIGNAL_WEIGHTS = Object.freeze({
  'shared-joke': 2,          // 一起玩过梗
  'deep-talk': 1,            // 深夜长聊 / 掏心窝
  'mutual-help': 1,          // 互相帮过忙
  'conflict': -2,            // 吵过架
  'boundary-violation': -3,  // 越界冒犯
  'explicit-confirmed': 2,   // 本人明确认可关系变近
})

const clampInt = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v))))
const periodMs = (days) => Math.max(1, Math.round(days)) * 86_400_000

/** 跨 scope 越界读取：群 scope 想读私聊的等级/梗。 */
export class AffectiveScopeError extends Error {
  constructor(message, { chatKey, scope, ownerScope } = {}) {
    super(message)
    this.name = 'AffectiveScopeError'
    this.code = 'E_SCOPE_ISOLATION'
    this.chatKey = chatKey
    this.scope = scope
    this.ownerScope = ownerScope
  }
}

/** 合法等级（整数 0..2）→ 数字；其余一律 null（调用方回退 0）。 */
export function normalizeLevel(value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < TRUST_MIN || value > TRUST_MAX) return null
  return value
}

/** 等级 → 中文标签；非法等级按陌生人算。 */
export function levelLabel(level) {
  const n = normalizeLevel(level)
  return TRUST_LEVEL_LABELS[n === null ? DEFAULT_LEVEL : n]
}

/** 分数 → 等级（只认阈值，不掺随机量）。 */
export function levelFromScore(score, thresholds = LEVEL_THRESHOLDS) {
  const s = Number.isFinite(Number(score)) ? Number(score) : 0
  let level = DEFAULT_LEVEL
  for (let i = 0; i < thresholds.length; i += 1) {
    if (s >= thresholds[i]) level = i
  }
  return Math.min(TRUST_MAX, Math.max(TRUST_MIN, level))
}

/** 梗文本归一化：去首尾空白、折叠空白、拉丁字母折小写（去重与跨 scope 撞车检测共用一口径）。 */
export function normalizeJoke(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function parseKey(chatKey) {
  const { kind, id } = parseChatKey(chatKey) // 非法 ChatKey 抛 TypeError
  return { chatKey: `${kind}:${id}`, scope: kind, uid: String(id) }
}

// viewer 三态：显式合法会话 / 未声明 / 声明了却判不出来（fail-closed，绝不当成「自己」）。
const VIEWER_EXPLICIT = 'explicit'
const VIEWER_UNKNOWN = 'unknown'
const VIEWER_INVALID = 'invalid'

/**
 * 解析「这次调用是谁发起的」。
 * - 未声明（undefined）→ unknown：老口径（调用方自称就是该会话），但仍受同号 uid 撞车检查约束；
 * - 声明了却不是合法 ChatKey（null / '' / 数字 / 对象 / 乱码 / 前导零）→ invalid：**一律 fail-closed**，
 *   读接口只给最小信息、写接口直接抛错，绝不复用「自己」这个身份；
 * - 合法 → explicit：按 scope/uid 做方向判定。
 */
function resolveViewer(value) {
  if (value === undefined) return { kind: VIEWER_UNKNOWN }
  if (typeof value !== 'string') return { kind: VIEWER_INVALID, raw: value }
  try {
    const parsed = parseKey(value)
    return { kind: VIEWER_EXPLICIT, chatKey: parsed.chatKey, scope: parsed.scope, uid: parsed.uid }
  } catch {
    return { kind: VIEWER_INVALID, raw: value }
  }
}

/** 本次调用的 viewer 声明优先；没声明则回退图级 viewer（生产接线用）；都没有 → unknown。 */
function pickViewer(opts, defaultViewer) {
  if (opts && typeof opts === 'object' && opts.viewer !== undefined) return opts.viewer
  return defaultViewer
}

const describeViewer = (viewer) => (typeof viewer.raw === 'string' ? JSON.stringify(viewer.raw) : String(viewer.raw))

/** 深拷贝一条梗：tags 必须是新数组，否则调用方 push 一下就把内部词表改了。 */
const copyJoke = (joke) => ({ ...joke, tags: Array.isArray(joke.tags) ? [...joke.tags] : [] })

function normalizeSignal(signal) {
  if (!signal || typeof signal !== 'object') {
    throw new TypeError('signal 必须是 { kind, note? } 对象')
  }
  const kind = String(signal.kind || '').trim()
  const weight = SIGNAL_WEIGHTS[kind]
  if (!Number.isFinite(weight)) {
    throw new TypeError(`未知信号：${kind || '(空)'}（只接受 ${Object.keys(SIGNAL_WEIGHTS).join(' / ')}）`)
  }
  const note = typeof signal.note === 'string' ? signal.note.trim().slice(0, 200) : ''
  return { kind, weight, note }
}

/**
 * 建一张信任矩阵。
 * @param {{ now?:()=>number, thresholds?:number[], decayPerPeriod?:number, decayEveryDays?:number, maxSignals?:number, maxJokes?:number }} [opts]
 */
export function createAffectiveGraph({
  now = () => 0,
  thresholds = LEVEL_THRESHOLDS,
  decayPerPeriod = 1,
  decayEveryDays = 14,
  maxSignals = 50,
  maxJokes = 200,
  // 图级 viewer：宿主接线时声明「这张图服务于哪个会话」。每次调用仍可用 opts.viewer 覆盖。
  viewer: defaultViewer,
} = {}) {
  /** chatKey -> record */
  const records = new Map()
  /** uid -> Set<chatKey>：给跨 scope 越界检测用 */
  const byUid = new Map()

  const clock = () => {
    const t = Number(now())
    return Number.isFinite(t) ? t : 0
  }

  const scopeOfUid = (uid) => {
    const keys = byUid.get(uid)
    return keys ? [...keys] : []
  }

  /** 声明了 viewer 时按方向判定：群 scope 绝不能读私聊 scope 的等级与梗。 */
  function assertReadable(target, viewer) {
    if (viewer.scope === target.scope) {
      // 私聊之间也要分人：private:A 不许借着「同一域」读 private:B。
      if (target.scope === 'private' && String(viewer.uid) !== String(target.uid)) {
        throw new AffectiveScopeError(
          `${viewer.chatKey} 不允许读取别人的私聊节点 ${target.chatKey}`,
          { chatKey: target.chatKey, scope: viewer.chatKey, ownerScope: target.scope },
        )
      }
      return
    }
    if (viewer.scope === 'group' && target.scope === 'private') {
      throw new AffectiveScopeError(
        `group scope 不允许读取 ${target.chatKey} 的等级与梗（隐私单向流动）`,
        { chatKey: target.chatKey, scope: viewer.chatKey, ownerScope: target.scope },
      )
    }
  }

  function assertNoScopeCollision(key, scope, uid) {
    const others = scopeOfUid(uid).filter((k) => k !== key)
    if (others.length === 0) return
    throw new AffectiveScopeError(
      `${scope} scope 不允许读写 ${others[0]} 的关系数据（隐私单向流动）`,
      { chatKey: key, scope, ownerScope: others[0].split(':')[0] },
    )
  }

  /**
   * 统一入口：解析目标键 + 解析发起方（viewer）并做隐私判定。任何一条都不许猜。
   * - viewer 合法且跨域越界 → 抛 AffectiveScopeError（不多给一个字段）；
   * - viewer 非法（给了值但判不出来）→ 抛 AffectiveScopeError，**不复用「自己」身份**；
   * - viewer 未声明 → 既无法证明「就是本会话」，也无法证明「不是」：只能靠同号 uid 撞车做
   *   fail-closed 兜底（节点已存在也要查，见 items 2）；strictViewer 时直接降级为最小信息。
   */
  function resolveAccess(chatKey, opts, { write = false } = {}) {
    const { chatKey: key, scope, uid } = parseKey(chatKey)
    const viewer = resolveViewer(pickViewer(opts, defaultViewer))
    const target = { chatKey: key, scope, uid }
    if (viewer.kind === VIEWER_INVALID) {
      // 写操作直接拒；读操作按最小信息返回（绝不复用「自己」这个身份）。
      if (write) {
        throw new AffectiveScopeError(
          `viewer 非法（${describeViewer(viewer)}），拒绝写入 ${key}（fail-closed）`,
          { chatKey: key, scope: describeViewer(viewer), ownerScope: scope },
        )
      }
      return { target, viewer, minimal: true }
    }
    if (viewer.kind === VIEWER_EXPLICIT) {
      assertReadable(target, viewer)
      return { target, viewer, minimal: false }
    }
    // 未声明 viewer：无论节点是否已存在，同号 uid 跨 scope 撞车一律拒绝
    // （先建节点 / 快照双节点这两条老绕行路径都从这里堵死）。
    assertNoScopeCollision(key, scope, uid)
    // 仍然无法判定发起方：图里已经同时承载别的聊天域时，匿名读私聊节点一律只给最小信息。
    // 单域图（整张图只有一个 scope）里「没声明 viewer」可以等价成「就是本域会话」，不在此列。
    if (scope === 'private' && hasOtherScope('private')) return { target, viewer, minimal: true }
    return { target, viewer, minimal: false }
  }

  /** 这张图里是否已经有别的聊天域（用于判定匿名调用的身份是否可判定）。 */
  function hasOtherScope(scope) {
    for (const rec of records.values()) if (rec.scope !== scope) return true
    return false
  }

  const minimalDeny = (key, scope) => {
    throw new AffectiveScopeError(
      `未声明 viewer，无法判定发起方会话，拒绝读写 ${key}（fail-closed）`,
      { chatKey: key, scope: 'unknown', ownerScope: scope },
    )
  }

  /** 只读定位：越界（显式 viewer 或同号 uid 撞车）→ 抛错；不建记录。 */
  function readRecord(chatKey, opts) {
    const { target, minimal } = resolveAccess(chatKey, opts)
    const rec = records.get(target.chatKey) || null
    if (minimal) return { rec: null, target, minimal }
    // 显式合法 viewer 也要过同号 uid 检查：private:A 里躺着的 uid 与 group:B 同一个号，
    // 说明这两个域在撞车，给谁都不安全 → fail-closed。
    const viewer = resolveViewer(pickViewer(opts, defaultViewer))
    if (viewer.kind === VIEWER_EXPLICIT && rec) {
      const others = [...(byUid.get(target.uid) || [])].filter((k) => k !== target.chatKey)
      if (others.length > 0 && viewer.scope === 'private') assertNoScopeCollision(target.chatKey, target.scope, target.uid)
    }
    return { rec, target, minimal: false }
  }

  /** 写入定位：越界同样抛错，其余情况按需建一条空记录。 */
  function openRecord(chatKey, opts) {
    const { target, minimal } = resolveAccess(chatKey, opts, { write: true })
    if (minimal) minimalDeny(target.chatKey, target.scope)
    const { chatKey: key, scope, uid } = target
    const existing = records.get(key)
    if (existing) return existing
    const t = clock()
    const rec = {
      chatKey: key,
      scope,
      uid,
      level: DEFAULT_LEVEL,
      score: 0,
      signals: [],
      jokes: [],
      createdAt: t,
      updatedAt: t,
      lastActiveAt: t,
      decayCursor: t,
    }
    records.set(key, rec)
    if (!byUid.has(uid)) byUid.set(uid, new Set())
    byUid.get(uid).add(key)
    return rec
  }

  function recount(rec, reason) {
    const previous = rec.level
    const next = levelFromScore(rec.score, thresholds)
    rec.level = next
    rec.updatedAt = clock()
    return {
      level: next,
      previousLevel: previous,
      changed: next !== previous,
      score: rec.score,
      reason,
    }
  }

  /** 当前信任等级；空图 / 无记录 / 无法判定发起方 → 0，跨 scope → 抛错。 */
  function trustLevel(chatKey, opts) {
    const { rec, minimal } = readRecord(chatKey, opts)
    if (minimal || !rec) return DEFAULT_LEVEL
    const lv = normalizeLevel(rec.level)
    if (lv === null) {
      // 快照被写坏时的 fail-closed：回到陌生人，不抛错、不猜。
      rec.level = DEFAULT_LEVEL
      return DEFAULT_LEVEL
    }
    return lv
  }

  /** 可解释解释视图：为什么是这个等级。 */
  function explain(chatKey, opts) {
    const { chatKey: key } = parseKey(chatKey)
    const { rec, target, minimal } = readRecord(key, opts)
    if (minimal || !rec) {
      return {
        chatKey: key,
        scope: target.scope,
        level: DEFAULT_LEVEL,
        label: levelLabel(DEFAULT_LEVEL),
        score: 0,
        signals: [],
        jokes: 0,
        reason: minimal ? '无法判定发起方会话，按最小信息返回（fail-closed）' : '空图：还没攒下任何信号',
      }
    }
    const lv = normalizeLevel(rec.level)
    if (lv === null) rec.level = DEFAULT_LEVEL
    return {
      chatKey: key,
      scope: target.scope,
      level: lv === null ? DEFAULT_LEVEL : lv,
      label: levelLabel(rec.level),
      score: rec.score,
      signals: rec.signals.map((s) => ({ ...s })),
      jokes: rec.jokes.length,
      reason: rec.signals.length > 0 ? rec.signals[rec.signals.length - 1].note || rec.signals[rec.signals.length - 1].kind : '暂无信号',
    }
  }

  /** 记一条可解释信号并重算等级。 */
  function bump(chatKey, signal, opts) {
    const rec = openRecord(chatKey, opts)
    const s = normalizeSignal(signal)
    rec.score += s.weight
    rec.signals.push({ kind: s.kind, weight: s.weight, note: s.note, at: clock() })
    if (rec.signals.length > maxSignals) rec.signals.splice(0, rec.signals.length - maxSignals)
    rec.lastActiveAt = clock()
    const out = recount(rec, `${s.kind}${s.note ? `：${s.note}` : ''}`)
    return { ...out, chatKey: rec.chatKey, signal: { ...s } }
  }

  /** 长时间没互动就衰减（默认每 14 天掉 1 分，最低 0，等级跟着回落）。 */
  function decay(chatKey, at, opts) {
    const { rec, target, minimal } = readRecord(chatKey, opts)
    if (minimal) minimalDeny(target.chatKey, target.scope)
    if (!rec) {
      return { chatKey: parseKey(chatKey).chatKey, level: DEFAULT_LEVEL, previousLevel: DEFAULT_LEVEL, changed: false, score: 0, decayed: 0 }
    }
    const t = Number.isFinite(Number(at)) ? Number(at) : clock()
    const span = periodMs(decayEveryDays)
    const idle = Math.max(0, t - rec.decayCursor)
    const periods = Math.floor(idle / span)
    if (periods <= 0) {
      return { chatKey: rec.chatKey, level: rec.level, previousLevel: rec.level, changed: false, score: rec.score, decayed: 0 }
    }
    rec.decayCursor += periods * span
    const decayed = Math.min(rec.score, periods * Math.max(0, Number(decayPerPeriod) || 0))
    rec.score -= decayed
    if (decayed > 0) {
      rec.signals.push({ kind: 'decay', weight: -decayed, note: `闲置 ${periods} 个衰减周期`, at: t })
      if (rec.signals.length > maxSignals) rec.signals.splice(0, rec.signals.length - maxSignals)
    }
    const out = recount(rec, `闲置 ${periods} 个周期，衰减 ${decayed} 分`)
    return { ...out, decayed }
  }

  /** 外部（面板 / 快照）直接设等级；非法值 fail-closed 回退 0。 */
  function setLevel(chatKey, level, opts) {
    const rec = openRecord(chatKey, opts)
    const lv = normalizeLevel(level)
    const previous = rec.level
    if (lv === null) {
      rec.level = DEFAULT_LEVEL
      rec.score = 0
      rec.updatedAt = clock()
      rec.signals.push({ kind: 'invalid-level', weight: 0, note: `非法等级 ${String(level)}，回退陌生人`, at: clock() })
      return { ok: false, level: DEFAULT_LEVEL, previousLevel: previous, changed: previous !== DEFAULT_LEVEL, reason: '非法等级，已回退陌生人' }
    }
    rec.level = lv
    // 分数跟着等级走，免得下一次 bump 立刻把等级又拽回去
    rec.score = thresholds[lv]
    rec.updatedAt = clock()
    return { ok: true, level: lv, previousLevel: previous, changed: previous !== lv, reason: `显式设定为 ${levelLabel(lv)}` }
  }

  /** 记一个专属梗（同 scope 同文本去重）。 */
  function addJoke(chatKey, text, { tags = [], viewer } = {}) {
    const rec = openRecord(chatKey, { viewer })
    const norm = normalizeJoke(text)
    if (!norm) return { ok: false, added: false, reason: '梗文本为空', joke: null }
    const dup = rec.jokes.find((j) => j.norm === norm)
    if (dup) return { ok: true, added: false, reason: '已存在（去重）', joke: copyJoke(dup) }
    // 梗文本必须有长度上限：截断而不是拒收（拒收会让「随手贴长文」把用户卡住）。
    const raw = String(text).replace(/\s+/g, ' ').trim()
    const text2 = raw.length > MAX_JOKE_LENGTH ? raw.slice(0, MAX_JOKE_LENGTH) : raw
    const joke = {
      text: text2,
      norm: normalizeJoke(text2),
      tags: Array.isArray(tags) ? tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 8) : [],
      at: clock(),
    }
    rec.jokes.push(joke)
    if (rec.jokes.length > maxJokes) rec.jokes.splice(0, rec.jokes.length - maxJokes)
    rec.lastActiveAt = clock()
    // 深拷贝出站：浅拷贝会把内部 tags 数组直接交给调用方。
    return { ok: true, added: true, reason: '已收录', joke: copyJoke(joke) }
  }

  /** 列梗；跨 scope 读取抛错。 */
  function listJokes(chatKey, opts) {
    const { rec, minimal } = readRecord(chatKey, opts)
    if (minimal || !rec) return []
    return rec.jokes.map(copyJoke)
  }

  /** 回复姿态：信任等级影响温度与玩笑尺度（0 级不主动私聊）。 */
  function tone(chatKey, opts) {
    const level = trustLevel(chatKey, opts)
    if (level <= 0) return { level, label: levelLabel(level), temperature: 'cool', jokeScale: 0.2, proactivePrivate: false }
    if (level === 1) return { level, label: levelLabel(level), temperature: 'warm', jokeScale: 0.6, proactivePrivate: true }
    return { level, label: levelLabel(level), temperature: 'intimate', jokeScale: 1, proactivePrivate: true }
  }

  /** 确定性快照（宿主负责落盘）。 */
  function toJSON() {
    const out = []
    for (const rec of records.values()) {
      out.push({
        chatKey: rec.chatKey,
        scope: rec.scope,
        uid: rec.uid,
        level: rec.level,
        score: rec.score,
        signals: rec.signals.map((s) => ({ ...s })),
        jokes: rec.jokes.map((j) => ({ ...j, tags: [...j.tags] })),
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        lastActiveAt: rec.lastActiveAt,
        decayCursor: rec.decayCursor,
      })
    }
    return { version: 1, nodes: out.sort((a, b) => (a.chatKey < b.chatKey ? -1 : a.chatKey > b.chatKey ? 1 : 0)) }
  }

  /** 从快照恢复；坏节点（非法等级 / 缺 chatKey）跳过，等级非法则回退 0。 */
  function load(snapshot) {
    const nodes = snapshot && Array.isArray(snapshot.nodes) ? snapshot.nodes : []
    let loaded = 0
    let skipped = 0
    for (const node of nodes) {
      if (!node || typeof node.chatKey !== 'string') { skipped += 1; continue }
      let parsed
      try { parsed = parseKey(node.chatKey) } catch { skipped += 1; continue }
      if (records.has(parsed.chatKey)) { skipped += 1; continue }
      // 快照里同号 uid 出现在两个 scope → 两个域在撞车，后到的那个直接不收（fail-closed）。
      const clash = [...(byUid.get(parsed.uid) || [])].filter((k) => k !== parsed.chatKey)
      if (clash.length > 0) { skipped += 1; continue }
      const lv = normalizeLevel(node.level)
      const score = Number.isFinite(Number(node.score)) ? Number(node.score) : (lv === null ? 0 : thresholds[lv])
      const t = Number.isFinite(Number(node.createdAt)) ? Number(node.createdAt) : clock()
      const rec = {
        chatKey: parsed.chatKey,
        scope: parsed.scope,
        uid: parsed.uid,
        level: lv === null ? DEFAULT_LEVEL : lv,
        score: lv === null ? 0 : score,
        signals: Array.isArray(node.signals) ? node.signals.slice(-maxSignals).map((s) => ({ ...s })) : [],
        jokes: Array.isArray(node.jokes) ? node.jokes.slice(-maxJokes).map((j) => ({ ...j, tags: Array.isArray(j.tags) ? [...j.tags] : [] })) : [],
        createdAt: t,
        updatedAt: Number.isFinite(Number(node.updatedAt)) ? Number(node.updatedAt) : t,
        lastActiveAt: Number.isFinite(Number(node.lastActiveAt)) ? Number(node.lastActiveAt) : t,
        decayCursor: Number.isFinite(Number(node.decayCursor)) ? Number(node.decayCursor) : t,
      }
      records.set(rec.chatKey, rec)
      if (!byUid.has(rec.uid)) byUid.set(rec.uid, new Set())
      byUid.get(rec.uid).add(rec.chatKey)
      loaded += 1
    }
    return { loaded, skipped }
  }

  return { trustLevel, explain, bump, decay, setLevel, addJoke, listJokes, tone, toJSON, load, size: () => records.size }
}

export default createAffectiveGraph
