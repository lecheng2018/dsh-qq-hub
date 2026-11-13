// Phase 3 · 每日 Token 配额账本（Token Circuit Breaker）
//
// 计划书 §八.2 / §十一.1：后台生活流与内心独白按 ChatKey 分配每日预算，超限即熔断，
// 调用方降级为「经典低成本问答」，绝不无限空转。
//
// 配额划分（v3.4 权重）：
//   · 默认单日总预算 50,000 Token；
//   · 主人私聊占 60%，白名单群聊均分 40%；
//   · 非主人私聊与未授权群 **不分配** 主动生活流配额（limit 恒为 0，记账直接拒绝）。
//
// 本模块零 I/O：不读配置、不写磁盘、不发网络请求。全局单例 + `createTokenLedger()`
// 工厂两种用法；所有对外返回值都是**脱离内部状态的副本**，调用方改返回值不会污染账本。

import { parseChatKey } from './chat-key.js'

/** 默认单日后台预算（Token）。 */
export const DEFAULT_DAILY_BUDGET = 50_000
/** 主人私聊权重。 */
export const OWNER_SHARE = 0.6
/** 白名单群聊权重（均分）。 */
export const GROUP_SHARE = 0.4

export const TIER_OWNER = 'owner'
export const TIER_GROUP = 'group'
export const TIER_NONE = 'none'

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 当前 UTC 日 key（`YYYY-MM-DD`）——只在调用方不显式给 dateKey 时兜底用。 */
export function todayKey(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(d.getTime())) return todayKey(new Date())
  return d.toISOString().slice(0, 10)
}

/** 校验日期 key，非法直接抛 TypeError（fail-closed）。 */
export function assertDateKey(dateKey) {
  if (typeof dateKey !== 'string' || !DATE_KEY_PATTERN.test(dateKey)) {
    throw new TypeError(`dateKey 必须是 YYYY-MM-DD 字符串，收到 ${describe(dateKey)}`)
  }
  const d = new Date(`${dateKey}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dateKey) {
    throw new TypeError(`dateKey 不是真实存在的日期：${dateKey}`)
  }
  return dateKey
}

function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN'
  if (typeof value === 'object') return 'object'
  return `${typeof value} ${JSON.stringify(value)}`
}

/** Token 数必须是「非负整数」；负数 / 小数 / 字符串 / NaN / Infinity 一律 TypeError。 */
function assertTokens(tokens) {
  if (typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens < 0) {
    throw new TypeError(`tokens 必须是非负整数，收到 ${describe(tokens)}`)
  }
  return tokens
}

/** 预算：数字或 `{ total, ownerShare }`；负数 / 非数字 / 权重越界一律 TypeError。 */
function normalizeBudget(budget) {
  let total = DEFAULT_DAILY_BUDGET
  let ownerShare = OWNER_SHARE
  if (budget === undefined || budget === null) {
    // 用默认值
  } else if (typeof budget === 'number') {
    total = budget
  } else if (typeof budget === 'object' && !Array.isArray(budget)) {
    if (budget.total !== undefined) total = budget.total
    if (budget.ownerShare !== undefined) ownerShare = budget.ownerShare
  } else {
    throw new TypeError(`budget 必须是数字或 { total, ownerShare }，收到 ${describe(budget)}`)
  }
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
    throw new TypeError(`budget.total 必须是非负整数，收到 ${describe(total)}`)
  }
  if (typeof ownerShare !== 'number' || !Number.isFinite(ownerShare) || ownerShare < 0 || ownerShare > 1) {
    throw new TypeError(`budget.ownerShare 必须是 0~1 之间的数字，收到 ${describe(ownerShare)}`)
  }
  return { total, ownerShare, groupShare: 1 - ownerShare }
}

/** 把一个池子按输入顺序均分，余数给靠前的 chatKey（保证总和精确、结果确定）。 */
function splitEvenly(pool, chatKeys) {
  const out = new Map()
  if (chatKeys.length === 0) return out
  const base = Math.floor(pool / chatKeys.length)
  const remainder = pool - base * chatKeys.length
  chatKeys.forEach((key, index) => {
    out.set(key, base + (index < remainder ? 1 : 0))
  })
  return out
}

/** 归类：主人私聊 / 白名单群 / 其余（0 配额）。 */
function classify(chatKey, entry) {
  const { kind } = parseChatKey(chatKey)
  if (kind === 'private') {
    return (entry.owner === true || entry.role === TIER_OWNER) ? TIER_OWNER : TIER_NONE
  }
  return (entry.whitelisted === true || entry.role === 'whitelist' || entry.role === TIER_GROUP)
    ? TIER_GROUP
    : TIER_NONE
}

/**
 * 建一个独立账本实例（测试与多实例场景用；生产用模块级单例）。
 * @param {{budget?: number|{total:number, ownerShare?:number}, today?: string}} [options]
 */
export function createTokenLedger(options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const baseBudget = opts.budget
  const initialBudget = normalizeBudget(baseBudget)
  let dateKey = opts.today === undefined ? todayKey() : assertDateKey(opts.today)
  let budget = initialBudget.total
  let ownerShare = initialBudget.ownerShare
  /** chatKey -> 当日上限 */
  const limits = new Map()
  /** chatKey -> 等级（owner / group / none） */
  const tiers = new Map()
  /** chatKey -> 已用 Token */
  const used = new Map()

  function currentDate(optsIn) {
    return optsIn && optsIn.dateKey !== undefined ? assertDateKey(optsIn.dateKey) : dateKey
  }

  /** 跨日自动滚动：换日即清空当日用量，权重与分配沿用。 */
  function rollTo(day) {
    if (day === dateKey) return
    dateKey = day
    used.clear()
  }

  function limitOf(chatKey) {
    return limits.get(chatKey) || 0
  }

  /**
   * 记账：返回与实际入账一致的票据（applied 可能被剩余额度截断）。
   * 非法 chatKey / 非法 token 抛 TypeError；0 配额或额度耗尽时 `refused: true`（不抛错）。
   */
  function record(chatKey, tokens, optsIn = {}) {
    parseChatKey(chatKey) // 非法 ChatKey fail-closed 抛 TypeError
    assertTokens(tokens)
    const day = currentDate(optsIn)
    rollTo(day)
    const limit = limitOf(chatKey)
    const usedBefore = used.get(chatKey) || 0
    const remainBefore = Math.max(0, limit - usedBefore)
    const tier = tiers.get(chatKey) || TIER_NONE
    if (limit <= 0) {
      return receipt(chatKey, tokens, 0, 0, limit, tier, 'no-quota')
    }
    if (remainBefore <= 0) {
      return receipt(chatKey, tokens, 0, usedBefore, limit, tier, 'exhausted')
    }
    const applied = Math.min(tokens, remainBefore)
    used.set(chatKey, usedBefore + applied)
    const after = usedBefore + applied
    return receipt(chatKey, tokens, applied, after, limit, tier, applied < tokens ? 'exhausted' : null)
  }

  function receipt(chatKey, requested, applied, usedAfter, limit, tier, reason) {
    return {
      chatKey,
      dateKey,
      tier,
      requested,
      applied,
      used: usedAfter,
      limit,
      remaining: Math.max(0, limit - usedAfter),
      exhausted: limit - usedAfter <= 0,
      refused: reason !== null,
      reason,
    }
  }

  /** 剩余额度（≥0）；无配额返回 0。只读，换日不回写状态。 */
  function remaining(chatKey, optsIn = {}) {
    parseChatKey(chatKey)
    const day = currentDate(optsIn)
    const limit = limitOf(chatKey)
    const spent = day === dateKey ? (used.get(chatKey) || 0) : 0
    return Math.max(0, limit - spent)
  }

  /** 是否已达配额（无配额恒为 true，调用方据此熔断）。 */
  function isExhausted(chatKey, optsIn = {}) {
    return remaining(chatKey, optsIn) <= 0
  }

  /** 配额详情快照（副本，改它不影响账本）。 */
  function quotaOf(chatKey, optsIn = {}) {
    parseChatKey(chatKey)
    const day = currentDate(optsIn)
    const limit = limitOf(chatKey)
    const spent = day === dateKey ? (used.get(chatKey) || 0) : 0
    return {
      chatKey,
      dateKey: day,
      tier: tiers.get(chatKey) || TIER_NONE,
      limit,
      used: spent,
      remaining: Math.max(0, limit - spent),
      exhausted: limit - spent <= 0,
    }
  }

  /** 跨日重置（也用于测试与运维手动翻页）。 */
  function resetDaily(day) {
    assertDateKey(day)
    dateKey = day
    used.clear()
    return snapshot()
  }

  /**
   * 按权重分配当日预算。
   * @param {Array<{chatKey:string, owner?:boolean, whitelisted?:boolean, role?:string}>} chats
   * @param {number|{total:number, ownerShare?:number}} [budgetIn]
   * @param {{dateKey?:string}} [optsIn]
   */
  function allocate(chats, budgetIn = undefined, optsIn = {}) {
    if (!Array.isArray(chats)) {
      throw new TypeError(`chats 必须是数组，收到 ${describe(chats)}`)
    }
    // 不传 budget 时回落到实例构造时的基准预算（默认 50,000），不沿用上一次调用的值。
    const conf = normalizeBudget(budgetIn === undefined ? baseBudget : budgetIn)
    const day = currentDate(optsIn)

    const ownerKeys = []
    const groupKeys = []
    const noneKeys = []
    const seen = new Set()
    for (const entry of chats) {
      if (!entry || typeof entry !== 'object' || typeof entry.chatKey !== 'string') {
        throw new TypeError(`chats 的每一项必须是含 chatKey 的对象，收到 ${describe(entry)}`)
      }
      parseChatKey(entry.chatKey)
      if (seen.has(entry.chatKey)) continue // 同一个 chatKey 只分一次，重复项忽略
      seen.add(entry.chatKey)
      const tier = classify(entry.chatKey, entry)
      if (tier === TIER_OWNER) ownerKeys.push(entry.chatKey)
      else if (tier === TIER_GROUP) groupKeys.push(entry.chatKey)
      else noneKeys.push(entry.chatKey)
    }

    const ownerBudget = Math.floor(conf.total * conf.ownerShare)
    const groupBudget = conf.total - ownerBudget

    rollTo(day)
    budget = conf.total
    ownerShare = conf.ownerShare
    limits.clear()
    tiers.clear()
    for (const key of noneKeys) {
      limits.set(key, 0)
      tiers.set(key, TIER_NONE)
    }
    for (const [key, limit] of splitEvenly(ownerBudget, ownerKeys)) {
      limits.set(key, limit)
      tiers.set(key, TIER_OWNER)
    }
    for (const [key, limit] of splitEvenly(groupBudget, groupKeys)) {
      limits.set(key, limit)
      tiers.set(key, TIER_GROUP)
    }
    return snapshot()
  }

  /** 当前账本快照（副本；嵌套对象也是新对象）。 */
  function snapshot() {
    const allocations = {}
    let totalLimit = 0
    for (const [key, limit] of limits) {
      allocations[key] = limit
      totalLimit += limit
    }
    const usages = {}
    let totalUsed = 0
    for (const [key, spent] of used) {
      usages[key] = spent
      totalUsed += spent
    }
    const ownerBudget = Math.floor(budget * ownerShare)
    return {
      dateKey,
      budget,
      ownerShare,
      groupShare: 1 - ownerShare,
      ownerBudget,
      groupBudget: budget - ownerBudget,
      totalLimit,
      totalUsed,
      totalRemaining: Math.max(0, totalLimit - totalUsed),
      allocations,
      usage: usages,
    }
  }

  return { allocate, record, remaining, isExhausted, quotaOf, resetDaily, snapshot }
}

/** 模块级单例（生产用）；测试建议用 `createTokenLedger()` 拿隔离实例。 */
export const defaultLedger = createTokenLedger()

export const tokenLedgerAllocate = (chats, budget, options) => defaultLedger.allocate(chats, budget, options)
export const tokenLedgerRecord = (chatKey, tokens, options) => defaultLedger.record(chatKey, tokens, options)
export const tokenLedgerRemaining = (chatKey, options) => defaultLedger.remaining(chatKey, options)
export const tokenLedgerIsExhausted = (chatKey, options) => defaultLedger.isExhausted(chatKey, options)
export const tokenLedgerQuotaOf = (chatKey, options) => defaultLedger.quotaOf(chatKey, options)
export const tokenLedgerResetDaily = (dateKey) => defaultLedger.resetDaily(dateKey)
export const tokenLedgerSnapshot = () => defaultLedger.snapshot()
