// Phase 0b · Thread Ledger：挂起线索账本（纯内存状态机，零 I/O 零网络）
//
// 解决的是「去洗澡了」「约定明天分享新歌」这类**没闭环的话**在下一轮里凭空蒸发：
// 用户发来无关新话题，旧实现直接把线索当已闭环，模型再问「洗完了吗」就露馅了。
// 这里只做数据结构与状态机，不读盘不写盘也不发网络请求——落盘、Provider 注入、
// S2 慢思考的显式顺承闭环都由上层（Phase 2 的 context-assembly / modular-core）接驳。
//
// 四条硬规则（计划书 §5）：
//   1. **不自动闭环**：只有 resolve() 才把线索标记 resolved；用户发新话题、甚至消费掉一轮
//      都不是闭环，只是把线索往 extended / dormant 推一格（US-020 的【顺承前情】判定才闭环）；
//   2. **三态拓扑**：active（等待顺承）--[第一轮未顺承]--> extended（顺延 1 轮）
//      --[仍未顺承 / TTL 到期]--> dormant（休眠沉淀）；状态迁移只发生在这两条显式入口
//      （advance() 轮次推进 / pruneExpired() 软 TTL 裁剪）；
//   3. **软 TTL 且严禁物理删除**：任何超时、任何容量压力都不物理删除 active / extended /
//      未完成归档的 dormant 记录；容量上限优先淘汰 resolved，其次淘汰已完成归档的 dormant，到顶且无可淘汰项就抛「容量已满」fail-closed；
//   4. **读操作无副作用**：peek()/list() 只按时间判定可见性，绝不在查询里改状态。
//
// 休眠时的摘要转存**不在本模块存**：v3.4 要求直接复用 `src/features/memory-archive.js:383
// recentEvents()` 的经历流，所以这里只提供可注入的转存钩子（onDormant 函数，或
// archive: { addEvent }），本模块既不 import 具体实现、也不留私有事件数组（保持零 I/O）。
// 没注入钩子时不静默吞掉：记录上标 `pendingArchive: true`，可用 retryArchive() 补写。
//
// chatKey 一律经 src/chat/chat-key.js 的 parseChatKey 校验（冻结契约 ADR-0001：
// private:<数字ID> / group:<数字ID>），裸 QQ 号、空串、0 号一律抛明确 TypeError。

import { parseChatKey } from './chat-key.js'

/** 线索类型（只增不改，便于落盘格式演进）。 */
export const THREAD_TYPES = Object.freeze([
  'temporary_leave',   // 去洗澡了 / 吃饭去了，稍后回来
  'promise',           // 约定明天分享新歌、答应帮你查资料
  'question_pending',  // 问了对方一个还没答的问题
  'topic_postponed',   // 说到一半的话题被别的事打断
])

/**
 * 线索状态机（v3.4 拓扑，顺序即生命周期顺序）：
 *
 *   active ──[第一轮未顺承]──► extended ──[仍未顺承 / TTL 到期]──► dormant
 *      │                          │                                 │
 *      └──────────────────[显式 resolve()]─────────────────────────► resolved
 *
 * active 也可被显式 resolve() 直接闭环；dormant 也可被显式 resolve()（用户隔天回来接上话）。
 * 「未顺承」永远不等于闭环：active 只升 extended，extended 只降 dormant。
 */
export const THREAD_STATES = Object.freeze(['active', 'extended', 'dormant', 'resolved'])

/** 仍在「等待顺承」的活状态（会被轮次推进 / TTL 裁剪推动）。 */
export const LIVE_STATES = Object.freeze(['active', 'extended'])

/** 默认软 TTL：2 小时（计划书 §5.2 的口径）。 */
export const DEFAULT_TTL_MS = 2 * 3600_000

/** 摘要长度上限（按 Unicode code point 计）：进提示词的只有一行，超长截断而不是整条拒绝。 */
export const MAX_SUMMARY_CHARS = 200

/** 单账本最多保留多少条线索（内存上限兜底；到顶优先淘汰 resolved 或已归档 dormant，绝不删活线索）。 */
export const DEFAULT_MAX_THREADS = 1000

const TYPE_SET = new Set(THREAD_TYPES)
const STATE_SET = new Set(THREAD_STATES)
const LIVE_SET = new Set(LIVE_STATES)
const ELLIPSIS = '…'

/** 容量已满：到上限且无可淘汰记录时抛出（fail-closed，绝不静默 evict 活线索或未完成归档线索）。 */
export class ThreadLedgerCapacityError extends Error {
  constructor(maxThreads) {
    super(`挂起线索容量已满（上限 ${maxThreads} 条，且无可淘汰的已闭环或已归档线索）：拒绝新线索，绝不物理删除活线索或未归档线索`)
    this.name = 'ThreadLedgerCapacityError'
    this.code = 'THREAD_LEDGER_CAPACITY_FULL'
    this.maxThreads = maxThreads
  }
}

function fail(message) {
  throw new TypeError(message)
}

function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  return String(value)
}

/**
 * 校验 ChatKey → 规范化字符串（fail-closed）。
 * 不支持裸 QQ 号：跨域键混用是记忆串味的根源。
 */
export function normalizeChatKey(chatKey) {
  try {
    const { kind, id } = parseChatKey(chatKey)
    return `${kind}:${id}`
  } catch (err) {
    throw new TypeError(
      `线索 chatKey 非法（必须是 private:<数字ID> 或 group:<数字ID>）：收到 ${describe(chatKey)}`,
      { cause: err },
    )
  }
}

/** 校验线索类型。 */
export function normalizeThreadType(type) {
  if (typeof type !== 'string' || !TYPE_SET.has(type)) {
    fail(`未知线索类型：${describe(type)}（可选 ${THREAD_TYPES.join(' / ')}）`)
  }
  return type
}

/**
 * 归一摘要：多空白压成一个空格（进提示词只要一行），过长截断加省略号。
 * 空串 / 纯空白直接拒绝——没有摘要的线索进上下文只是噪音。
 * 截断按 code point（Array.from）切，绝不切断代理对——否则 emoji 尾巴会留成孤立代理。
 */
export function normalizeThreadSummary(summary) {
  if (typeof summary !== 'string') fail(`线索摘要必须是字符串：收到 ${describe(summary)}`)
  const text = summary.replace(/\s+/g, ' ').trim()
  if (!text) fail('线索摘要不能为空')
  const points = Array.from(text)
  if (points.length <= MAX_SUMMARY_CHARS) return text
  return points.slice(0, MAX_SUMMARY_CHARS - ELLIPSIS.length).join('') + ELLIPSIS
}

/** 校验 TTL：必须是有限的非负数字（0 允许，表示立刻可休眠）。 */
export function normalizeThreadTtl(ttlMs, fallback = DEFAULT_TTL_MS) {
  if (ttlMs === undefined) return fallback
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) fail(`ttlMs 必须是有限数字：收到 ${describe(ttlMs)}`)
  if (ttlMs < 0) fail(`ttlMs 不能为负数：收到 ${ttlMs}`)
  return Math.round(ttlMs)
}

/** 时间戳校验视图（now 既可来自注入时钟，也可逐调用显式传入）。 */
export function assertTimestamp(value, path = 'now') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${path} 必须是非负有限时间戳：收到 ${describe(value)}`)
  }
  return value
}

/** 布尔校验视图（didContinue 这类信号必须显式，不猜）。 */
function assertBoolean(value, path) {
  if (typeof value !== 'boolean') fail(`${path} 必须是布尔值：收到 ${describe(value)}`)
  return value
}

/** 这条线索是否已过软 TTL（纯判定，不改状态）。 */
export function isThreadExpired(thread, now) {
  if (!thread) return false
  return assertTimestamp(now) >= thread.createdAt + thread.ttlMs
}

/** 线索是否仍未闭环（active / extended / dormant 都算未闭环）。 */
export function isThreadUnresolved(thread) {
  return Boolean(thread) && thread.status !== 'resolved'
}

/** 线索是否还活着等顺承（active / extended）。 */
export function isThreadLive(thread) {
  return Boolean(thread) && LIVE_SET.has(thread.status)
}

function toEpochMs(value, at) {
  // createdAt 只接受数字时间戳；Date 实例给个便捷视图，但绝不偷偷调用 Date.now()
  if (value === undefined) return at
  if (value instanceof Date) return assertTimestamp(value.getTime(), 'createdAt')
  return assertTimestamp(value, 'createdAt')
}

function normalizeCapacity(value, fallback, path) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) fail(`${path} 必须是正整数：收到 ${describe(value)}`)
  return value
}

/**
 * 建一个挂起线索账本（纯内存）。
 *
 * @param {object} [opts]
 * @param {() => number} [opts.now] 可注入时钟，测试与回放用
 * @param {number} [opts.maxThreads] 线索总数上限（超限只淘汰 resolved，见 THREAD_STATES 注释）
 * @param {(payload: object) => any} [opts.onDormant] 休眠转存钩子（推荐；参数含 summary / chatKey / threadId）
 * @param {{addEvent: (payload: object) => any}} [opts.archive] 转存钩子的对象形态
 *   （上层直接把 memoryArchive 或 { addEvent: (e) => memoryArchive.addEvent(e) } 传进来即可）
 */
export function createThreadLedger(opts = {}) {
  const clock = typeof opts.now === 'function' ? opts.now : Date.now
  const maxThreads = normalizeCapacity(opts.maxThreads, DEFAULT_MAX_THREADS, 'maxThreads')

  /** 注入的转存钩子：onDormant 函数优先，其次 archive.addEvent（不 import 具体实现）。 */
  const archiveHook = (() => {
    if (typeof opts.onDormant === 'function') return opts.onDormant
    if (opts.archive && typeof opts.archive.addEvent === 'function') {
      return (payload) => opts.archive.addEvent(payload)
    }
    return null
  })()

  /** 插入顺序数组（同 createdAt 时用它做稳定 tie-break） */
  let threads = []
  const byId = new Map()
  let seq = 0

  function at(optsArg, fallbackNow) {
    const explicit = optsArg && optsArg.now !== undefined ? optsArg.now : undefined
    if (explicit !== undefined) return assertTimestamp(explicit)
    if (fallbackNow !== undefined) return assertTimestamp(fallbackNow)
    return assertTimestamp(clock())
  }

  function replaceAt(index, record) {
    threads = threads.slice()
    threads[index] = record
    byId.set(record.id, record)
    return record
  }

  function removeAt(index) {
    const record = threads[index]
    threads = threads.slice()
    threads.splice(index, 1)
    byId.delete(record.id)
    return record
  }

  function nextId() {
    seq += 1
    let id = `thr_${seq}`
    while (byId.has(id)) {
      seq += 1
      id = `thr_${seq}`
    }
    return id
  }

  function findActiveDuplicate(chatKey, type, summary) {
    // 只与仍在 active 的同名线索合并；extended 说明已经漏了一轮，属于另一段待观察的线索
    for (let i = threads.length - 1; i >= 0; i -= 1) {
      const t = threads[i]
      if (t.chatKey === chatKey && t.type === type && t.summary === summary && t.status === 'active') return i
    }
    return -1
  }

  /** 找最旧的某个状态记录下标（-1 = 没有）。 */
  function oldestIndexOf(status) {
    let oldest = -1
    for (let i = 0; i < threads.length; i += 1) {
      if (threads[i].status !== status) continue
      if (oldest === -1 || threads[i].createdAt < threads[oldest].createdAt) oldest = i
    }
    return oldest
  }

  /**
   * 容量闸门：到上限优先寻找最旧的 resolved 淘汰。
   * 若没有 resolved，寻找最旧的、已经完成归档（pendingArchive !== true）的 dormant 线索淘汰。
   * 仅当没有任何可淘汰线索（全部线索均为未完结的 active / extended 或正在归档的线索）时 fail-closed。
   */
  function ensureCapacity() {
    if (threads.length < maxThreads) return
    let victim = oldestIndexOf('resolved')
    if (victim === -1) {
      for (let i = 0; i < threads.length; i += 1) {
        const item = threads[i]
        if (item.status === 'dormant' && item.pendingArchive !== true) {
          if (victim === -1 || item.createdAt < threads[victim].createdAt) {
            victim = i
          }
        }
      }
    }
    if (victim === -1) throw new ThreadLedgerCapacityError(maxThreads)
    removeAt(victim)
  }

  /**
   * 尝试把休眠线索的摘要转存到经历流（注入钩子）。
   * 不 import memory-archive：这里只认「可调用」这一件事，零 I/O 由上层保证。
   *
   * @returns {{archived:boolean, error:string}}
   */
  function archiveDormant(record, when, reason, hook = archiveHook) {
    if (!hook) return { archived: false, error: '' }
    const payload = Object.freeze({
      threadId: record.id,
      chatKey: record.chatKey,
      type: record.type,
      summary: record.summary,
      text: record.summary,      // memoryArchive.addEvent({ text }) 可直接摊平消费
      scope: record.chatKey,     // 转存作用域跟随原聊天域，由上层映射成 private:<id> / global
      source: 'thread_ledger',
      tags: Object.freeze(['经历', '挂起线索']),
      at: when,
      reason,
    })
    try {
      const result = hook(payload)
      if (result && typeof result === 'object' && result.ok === false) {
        return { archived: false, error: String(result.message || '转存钩子返回 ok:false') }
      }
      return { archived: true, error: '' }
    } catch (err) {
      return { archived: false, error: err && err.message ? String(err.message) : String(err) }
    }
  }

  /** active / extended → dormant（统一入口：状态迁移 + 摘要转存）。 */
  function toDormant(index, when, reason, misses) {
    const record = threads[index]
    const pending = { ...record, status: 'dormant' }
    const probe = archiveDormant(pending, when, reason)
    return replaceAt(index, Object.freeze({
      ...record,
      status: 'dormant',
      misses,
      dormantAt: when,
      dormantReason: reason,
      updatedAt: when,
      pendingArchive: !probe.archived,
      archiveError: probe.error,
    }))
  }

  return {
    /**
     * 新增一条挂起线索。
     * 同 chatKey + type + 归一后 summary 且仍 active 时**合并**：沿用原 id、
     * recurrence +1、createdAt 续期（TTL 重新起算），避免「又说了一遍去洗澡」攒出两条。
     * 容量到顶且全是活线索时抛 ThreadLedgerCapacityError（不静默淘汰）。
     *
     * @param {{chatKey:string, type:string, summary:string, ttlMs?:number, createdAt?:number|Date, id?:string}} input
     * @param {{now?:number}} [o]
     */
    push(input, o = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('线索必须是对象')
      const chatKey = normalizeChatKey(input.chatKey)
      const type = normalizeThreadType(input.type)
      const summary = normalizeThreadSummary(input.summary)
      const ttlMs = normalizeThreadTtl(input.ttlMs)
      const when = at(o)
      const createdAt = toEpochMs(input.createdAt, when)

      if (input.id === undefined) {
        const dupIndex = findActiveDuplicate(chatKey, type, summary)
        if (dupIndex !== -1) {
          // 续期而不是新建：createdAt 前移，TTL 重新起算
          return replaceAt(dupIndex, Object.freeze({
            ...threads[dupIndex],
            createdAt,
            ttlMs,
            updatedAt: when,
            recurrence: threads[dupIndex].recurrence + 1,
          }))
        }
      }

      let id = nextId()
      if (input.id !== undefined) {
        if (typeof input.id !== 'string' || !input.id.trim()) fail(`线索 id 必须是非空字符串：收到 ${describe(input.id)}`)
        id = input.id.trim()
        if (byId.has(id)) fail(`线索 id 重复：${id}`)
      }

      ensureCapacity()

      const record = Object.freeze({
        id,
        chatKey,
        type,
        summary,
        createdAt,
        ttlMs,
        status: 'active',
        misses: 0,
        recurrence: 1,
        updatedAt: when,
      })
      threads = threads.concat([record])
      byId.set(id, record)
      return record
    },

    /**
     * 取这个聊天最近的一条未闭环线索。
     * 默认只看 active（extended 要显式 includeExtended，dormant 要显式 includeDormant）：
     * 上下文注入应该只默认拿「还在等顺承的第一顺位」，其余靠调用方显式开口。
     * 已过期但还没 prune 的活线索不再返回（读操作不改状态，只是不可见）。
     *
     * @param {string} chatKey
     * @param {{now?:number, type?:string, includeExtended?:boolean, includeDormant?:boolean, includeExpired?:boolean}} [o]
     */
    peek(chatKey, o = {}) {
      const key = normalizeChatKey(chatKey)
      const when = at(o)
      const wantExtended = o.includeExtended === true
      const wantDormant = o.includeDormant === true
      const wantExpired = o.includeExpired === true
      const wantType = o.type === undefined ? '' : normalizeThreadType(o.type)

      let best = null
      for (const t of threads) {
        if (t.chatKey !== key) continue
        if (t.status === 'resolved') continue
        if (t.status === 'extended' && !wantExtended) continue
        if (t.status === 'dormant' && !wantDormant) continue
        if (wantType && t.type !== wantType) continue
        if (LIVE_SET.has(t.status) && !wantExpired && isThreadExpired(t, when)) continue
        // createdAt 相同则后插入者优先（后来居上）
        if (!best || t.createdAt >= best.createdAt) best = t
      }
      return best
    },

    /** 按 id 取一条线索（不含任何时间过滤，给审计与测试用）。 */
    get(id) {
      if (typeof id !== 'string' || !id.trim()) return null
      return byId.get(id.trim()) || null
    },

    /**
     * 轮次推进（v3.4 三态拓扑的唯一正向入口）。
     *
     * 每消费一轮，「这个聊天里所有还在等顺承的线索（active / extended）」：
     *   - didContinue === false（本轮没顺承）：active → extended（misses=1），
     *     extended → dormant（misses=2，休眠沉淀 + 摘要转存经历流）；
     *   - didContinue === true（本轮顺承了）：状态不动，**也不自动 resolved**——
     *     闭环只能由 S2【顺承前情】判定后显式 resolve()（US-020）。
     *
     * @param {string} chatKey
     * @param {{now?:number, didContinue?:boolean}} [o] didContinue 缺省按 false（未顺承）
     * @returns {{didContinue:boolean, changed:object[], extended:object[], dormant:object[], continued:object[]}}
     */
    advance(chatKey, o = {}) {
      const key = normalizeChatKey(chatKey)
      const when = at(o)
      const didContinue = o.didContinue === undefined ? false : assertBoolean(o.didContinue, 'didContinue')

      const out = { didContinue, changed: [], extended: [], dormant: [], continued: [] }
      for (let i = 0; i < threads.length; i += 1) {
        const t = threads[i]
        if (t.chatKey !== key) continue
        if (!LIVE_SET.has(t.status)) continue
        if (didContinue) {
          out.continued.push(t)
          continue
        }
        const misses = (Number.isInteger(t.misses) ? t.misses : 0) + 1
        let next
        if (t.status === 'active') {
          next = replaceAt(i, Object.freeze({
            ...t,
            status: 'extended',
            misses,
            extendedAt: when,
            updatedAt: when,
          }))
        } else {
          next = toDormant(i, when, 'rounds_exhausted', misses)
          out.dormant.push(next)
        }
        if (next.status === 'extended') out.extended.push(next)
        out.changed.push(next)
      }
      return Object.freeze({
        didContinue,
        changed: Object.freeze(out.changed),
        extended: Object.freeze(out.extended),
        dormant: Object.freeze(out.dormant),
        continued: Object.freeze(out.continued),
      })
    },

    /**
     * 显式闭环（S2 慢思考在 <inner> 里确认顺承后调用）。
     * 已 resolved 再 resolve 是幂等空操作，不覆盖首次闭环时间。
     * dormant 也能被闭环（用户隔天回来把话接上了）。
     *
     * @param {string} id
     * @param {{now?:number, by?:string}} [o]
     * @returns {object|null} 未知 id 返回 null
     */
    resolve(id, o = {}) {
      if (typeof id !== 'string' || !id.trim()) fail(`线索 id 必须是非空字符串：收到 ${describe(id)}`)
      const record = byId.get(id.trim())
      if (!record) return null
      if (record.status === 'resolved') return record
      const when = at(o)
      const by = o.by === undefined ? '' : String(o.by)
      const index = threads.indexOf(record)
      return replaceAt(index, Object.freeze({
        ...record,
        status: 'resolved',
        resolvedAt: when,
        resolvedBy: by,
        updatedAt: when,
      }))
    },

    /**
     * 列举线索（默认全部，按 createdAt 倒序）。
     * status 接受单个状态、数组，或两个别名：'unresolved'（active + extended + dormant）/ 'all'。
     * limit 语义与 memory-archive.recentEvents 对齐：0 = 空数组，不传 = 不限。
     *
     * @param {{chatKey?:string, status?:string|string[], type?:string, since?:number, limit?:number, pendingArchive?:boolean, now?:number}} [o]
     */
    list(o = {}) {
      const key = o.chatKey === undefined ? '' : normalizeChatKey(o.chatKey)
      const wantType = o.type === undefined ? '' : normalizeThreadType(o.type)
      const states = normalizeStateFilter(o.status)
      if (o.since !== undefined) assertTimestamp(o.since, 'since')
      if (o.pendingArchive !== undefined) assertBoolean(o.pendingArchive, 'pendingArchive')
      const limit = normalizeLimit(o.limit)

      const out = []
      for (const t of threads) {
        if (key && t.chatKey !== key) continue
        if (wantType && t.type !== wantType) continue
        if (!states.has(t.status)) continue
        if (o.since !== undefined && t.createdAt < o.since) continue
        if (o.pendingArchive !== undefined && (t.pendingArchive === true) !== o.pendingArchive) continue
        out.push(t)
      }
      out.sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? 1 : -1))
      return Object.freeze(limit === null ? out : out.slice(0, limit))
    },

    /**
     * 软 TTL 裁剪：把超时仍未闭环的 **active / extended** 线索转 dormant
     * （**绝不物理删除**），同时把摘要经注入钩子转存经历流。幂等：同一线索只转一次。
     *
     * @param {{now?:number}} [o]
     * @returns {object[]} 本次转入 dormant 的线索（无变化时为空数组）
     */
    pruneExpired(o = {}) {
      const when = at(o)
      const turned = []
      for (let i = 0; i < threads.length; i += 1) {
        const t = threads[i]
        if (!LIVE_SET.has(t.status)) continue
        if (!isThreadExpired(t, when)) continue
        const misses = Number.isInteger(t.misses) ? t.misses : 0
        turned.push(toDormant(i, when, 'ttl_expired', misses))
      }
      return Object.freeze(turned)
    },

    /**
     * 补写休眠摘要（创建时没注入钩子、或钩子当时抛错/返回 ok:false 时）。
     * 成功的记录清掉 pendingArchive；失败的保持 pending，绝不丢弃摘要。
     *
     * @param {(payload:object)=>any} [hook] 不传则用构造时注入的钩子
     * @returns {object[]} 本次补写成功的线索
     */
    retryArchive(hook) {
      const use = typeof hook === 'function' ? hook : archiveHook
      if (!use) fail('retryArchive 需要可调用的转存钩子（onDormant 函数或 archive.addEvent）')
      const flushed = []
      for (let i = 0; i < threads.length; i += 1) {
        const t = threads[i]
        if (t.pendingArchive !== true) continue
        const when = Number.isFinite(t.dormantAt) ? t.dormantAt : t.updatedAt
        const probe = archiveDormant(t, when, t.dormantReason || 'retry', use)
        if (!probe.archived) continue
        flushed.push(replaceAt(i, Object.freeze({
          ...t,
          pendingArchive: false,
          archiveError: '',
        })))
      }
      return Object.freeze(flushed)
    },

    /** 账本快照（面板 / 排障用，不返回内部数组引用）。 */
    stats() {
      const counts = { active: 0, extended: 0, dormant: 0, resolved: 0 }
      let pendingArchive = 0
      for (const t of threads) {
        counts[t.status] = (counts[t.status] || 0) + 1
        if (t.pendingArchive === true) pendingArchive += 1
      }
      return Object.freeze({
        threads: threads.length,
        active: counts.active,
        extended: counts.extended,
        dormant: counts.dormant,
        resolved: counts.resolved,
        pendingArchive,
        capacity: maxThreads,
      })
    },
  }
}

function normalizeStateFilter(status) {
  if (status === undefined || status === 'all') return new Set(THREAD_STATES)
  if (status === 'unresolved') return new Set(['active', 'extended', 'dormant'])
  const items = Array.isArray(status) ? status : [status]
  const out = new Set()
  for (const item of items) {
    if (typeof item !== 'string' || !STATE_SET.has(item)) {
      fail(`未知线索状态：${describe(item)}（可选 ${THREAD_STATES.join(' / ')}，或 unresolved / all）`)
    }
    out.add(item)
  }
  if (out.size === 0) fail('status 过滤不能为空数组')
  return out
}

/** limit：未传 → null（不限）；0 → 空；其余非负整数。 */
function normalizeLimit(limit, fallback = null) {
  if (limit === undefined) return fallback
  if (!Number.isInteger(limit) || limit < 0) fail(`limit 必须是非负整数：收到 ${describe(limit)}`)
  return limit
}
