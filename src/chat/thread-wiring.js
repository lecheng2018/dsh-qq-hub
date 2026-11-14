// US-019 · 线索生产者接线层：把 S1 规则层（thread-producer）与 S2 慢思考层（thread-judge）
// 的产出真正写进挂起线索账本（thread-ledger），并把超时线索推到 dormant + 归档经历流。
//
// 为什么单独一层而不是散在 modular-core 里：这一层是**纯编排**（依赖全部注入），
// 单测可以拿真账本 + 假模型完整跑一遍，不需要起会话、网关、DSH 宿主。
// modular-core 只负责「什么时候调用它」（见那里的一行调用与注释）。
//
// 三条不变式：
//   1. **绝不抛**：线索是增强项，任何异常（账本容量满、chatKey 非法、模型挂了）只记日志，
//      绝不影响这一轮已经发出去的回复，也不阻断下一轮；
//   2. **投递之后才写**：新线索必须在 reply-delivery 的 applyThreadContinuation 跑完**之后**入账。
//      否则同一轮的 advance() 会把刚生下来的 active 直接推成 extended（生下来就漏一轮）；
//   3. **顺带裁剪**：每轮末尾按节流间隔调 pruneExpired()，让 TTL 到期的线索真的转 dormant
//      并走 onDormant → memory addEvent({kind:'thread-dormant'}) 归档——否则 pruning 又成了死代码。

import { extractAndStripInnerMonologue } from './reply.js'
import { ThreadLedgerCapacityError } from './thread-ledger.js'
import { mineThreads, normalizeThreadSummaryText, TYPE_TTL_MS } from './thread-producer.js'
import { judgeThreads } from './thread-judge.js'

/** 裁剪节流：每轮都扫一遍账本没必要，默认最多每分钟一次（账本上限 1000 条，扫描本身就是内存遍历）。 */
export const DEFAULT_PRUNE_INTERVAL_MS = 60_000

/**
 * 两条同类型摘要是不是在说同一件事。
 *
 * 口径：**相对最长公共子串**（LCS 长度 / 较长者长度）≥ 0.6 算同一件事。
 * 选 LCS 而不是编辑距离：「明天把链接发你」/「明天把链接发我」这类同义改写只是尾巴一字之差，
 * LCS 很高；「明天把链接发你」/「周末带你去吃饭」是两件事，LCS 很低。
 * 阈值 0.6 是刻意偏保守的：宁可留两条相近的线索（第二轮的 S1 会因为账本合并去重），
 * 也不要把「他明天发我链接」和「他明天来接我」这种真不同的约定误并成一条。
 */
export function isSimilarSummary(a, b) {
  const x = Array.from(String(a || ''))
  const y = Array.from(String(b || ''))
  if (!x.length || !y.length) return false
  if (x.join('') === y.join('')) return true
  const longest = Math.max(x.length, y.length)
  // 极短摘要（≤3 字）不做相似判定：信息量太低，容易误并
  if (longest <= 3) return false
  // 滚动数组算 LCS 长度（O(min(n,m)) 空间）
  let prev = new Array(y.length + 1).fill(0)
  let best = 0
  for (let i = 1; i <= x.length; i += 1) {
    const cur = new Array(y.length + 1).fill(0)
    for (let j = 1; j <= y.length; j += 1) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    if (cur[y.length] > best) best = cur[y.length]
    prev = cur
  }
  return best / longest >= 0.6
}

/**
 * 建一个线索观察者（每轮投递后调用一次）。
 *
 * @param {object} o
 * @param {object} o.dsh 宿主 ctx（S2 判定用；没有就只跑 S1）
 * @param {() => object} o.getConfig 当前配置（每轮现读，面板改完下一轮生效）
 * @param {object} o.ledger 挂起线索账本（createThreadLedger 的返回值）
 * @param {object} [o.log] 日志器
 * @param {() => number} [o.now] 时钟
 * @param {Function} [o.judge] S2 判定实现（默认 thread-judge 的 judgeThreads，测试可注入）
 * @param {number} [o.pruneIntervalMs]
 */
export function createThreadObserver({
  dsh, getConfig, ledger, log, now = Date.now, judge = judgeThreads,
  pruneIntervalMs = DEFAULT_PRUNE_INTERVAL_MS,
} = {}) {
  if (!ledger || typeof ledger.push !== 'function') throw new TypeError('createThreadObserver 需要带 push() 的线索账本')
  const cfgOf = typeof getConfig === 'function' ? getConfig : () => ({})
  const warn = (msg) => { try { log?.warn?.(msg) } catch { /* 日志器自己炸了也不影响 */ } }
  const info = (msg) => { try { log?.info?.(msg) } catch { /* 同上 */ } }
  const debug = (msg) => { try { log?.debug?.(msg) } catch { /* 同上 */ } }
  let lastPruneAt = 0

  /** 裁剪节流间隔：允许传函数（配置热改下一轮生效），也允许传定值。 */
  function pruneIntervalOf() {
    const raw = typeof pruneIntervalMs === 'function' ? pruneIntervalMs() : pruneIntervalMs
    const ms = Number(raw)
    return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_PRUNE_INTERVAL_MS
  }
  /** 未完成的观察链：测试与优雅退出可以 flush 等它收尾（fire-and-forget 不能靠 sleep 猜）。 */
  let chain = Promise.resolve()

  /** 这条会话这一轮要不要跑 S2：群聊默认不跑（群里每条消息一次模型调用，成本压不住）。 */
  function judgeEnabledFor(chatKey) {
    const t = cfgOf()?.threads || {}
    if (t.judge === false) return false
    if (String(chatKey).startsWith('group:') && t.judgeInGroups !== true) return false
    return true
  }

  /** 把 S2 的 `[{type,summary}]` 补成可入账的 `[{chatKey,type,summary,ttlMs}]`。 */
  function withTtl(chatKey, rows) {
    if (!Array.isArray(rows)) return []
    const out = []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const type = String(row.type || '')
      if (!(type in TYPE_TTL_MS)) continue
      const summary = normalizeThreadSummaryText(row.summary)
      if (!summary) continue
      out.push({ chatKey, type, summary, ttlMs: TYPE_TTL_MS[type] })
    }
    return out
  }

  /**
   * 合并 S1 与 S2 的产出。
   *
   * 账本自身的合并口径是「同 chatKey + type + **逐字相同**的 summary」，但两层对同一件事的
   * 措辞天然不同（S1 从原话里截「明天把链接发你」，S2 概括成「明天把链接发我」），
   * 逐字比较会放两条同义线索进账本。所以这里再按「同类型 + 高度相似」收一次：
   * S1 排在前面，先入者留下（规则层更贴原话，进提示词时更不容易让模型读岔）。
   */
  function dedupe(rows) {
    const out = []
    for (const row of rows) {
      const summary = normalizeThreadSummaryText(row.summary)
      if (!summary) continue
      const dup = out.some((kept) => kept.type === row.type && isSimilarSummary(
        normalizeThreadSummaryText(kept.summary), summary,
      ))
      if (dup) continue
      out.push(row)
    }
    return out
  }

  /**
   * 一轮投递之后：挖线索 → 入账 → 顺手裁剪。
   *
   * @param {object} turn
   * @param {string} turn.chatKey 会话键
   * @param {string} [turn.userText] 用户这一轮说的话
   * @param {string} [turn.replyRaw] 她这一轮**原始**输出（含 <inner>；由本层剥离，出站已自己剥过一遍）
   * @param {string} [turn.replyText] 已经剥好的正文（传了就不用 replyRaw）
   * @param {object} [turn.innerMeta] 已解析的 <inner> 元数据（传了就不用 replyRaw）
   * @param {string} [turn.recentText] 最近几轮对话原文（S2 用；不传就只用 userText + 正文）
   * @returns {Promise<{produced:number, pushed:number, pruned:number, failed:number}>}
   */
  function recordTurn(turn = {}) {
    const run = () => observe(turn)
    // 串成一条链：同一会话的连续几十轮不会互相踩账本状态，flush 也有确定的收尾点。
    const next = chain.then(run, run)
    chain = next.then(() => {}, () => {})
    return next
  }

  async function observe(turn) {
    const stat = { produced: 0, pushed: 0, pruned: 0, failed: 0 }
    const chatKey = typeof turn.chatKey === 'string' ? turn.chatKey.trim() : ''
    if (!chatKey) return stat
    const at = typeof now === 'function' ? now() : Date.now()
    const cfg = cfgOf()
    // 总开关关着：连裁剪都不做（账本可能是别处塞进来的，但没有生产者就不推进它的生命周期）。
    if (cfg?.threads?.enabled === false) return stat

    // 1. 拆 <inner>：innerMeta.memo 是 S1 的第二数据源；replyText 是 question_pending 的来源。
    let innerMeta = turn.innerMeta && typeof turn.innerMeta === 'object' ? turn.innerMeta : null
    let replyText = typeof turn.replyText === 'string' ? turn.replyText : ''
    if (typeof turn.replyRaw === 'string' && turn.replyRaw) {
      const parsed = extractAndStripInnerMonologue(turn.replyRaw)
      if (!innerMeta) innerMeta = parsed.inner
      if (!replyText) replyText = parsed.text
    }
    const userText = typeof turn.userText === 'string' ? turn.userText : ''

    // 2. S1 规则层（同步、零 I/O、绝不出错）
    let rules = []
    try {
      rules = mineThreads({ chatKey, userText, innerMeta, replyText, now: at })
    } catch (error) {
      warn(`线索规则层跳过：${chatKey} ${error?.message || error}`)
    }

    // 3. S2 慢思考层（fail-open：判不出来就当没有）
    let slow = []
    if (judgeEnabledFor(chatKey)) {
      try {
        const recent = String(turn.recentText || '').trim()
          || [userText, replyText].filter(Boolean).join('\n')
        const rows = await judge({
          dsh, cfg, chatKey, recentText: recent, now: at, log,
          timeoutMs: Number(cfg?.threads?.judgeTimeoutMs) || undefined,
        })
        slow = withTtl(chatKey, rows)
      } catch (error) {
        // judgeThreads 自己已经 fail-open；这里再兜一层，防止注入实现抛出来打断整轮。
        warn(`线索判定层跳过：${chatKey} ${error?.message || error}`)
      }
    }

    const candidates = dedupe([...rules, ...slow])
    stat.produced = candidates.length

    // 4. 入账：容量满（ThreadLedgerCapacityError）只记一条日志，绝不物理删除活线索、绝不冒泡。
    for (const candidate of candidates) {
      try {
        ledger.push(candidate, { now: at })
        stat.pushed += 1
      } catch (error) {
        stat.failed += 1
        if (error instanceof ThreadLedgerCapacityError || error?.code === 'THREAD_LEDGER_CAPACITY_FULL') {
          warn(`线索账本已满，本轮其余线索不入账：${chatKey}（${error.message}）`)
          break // 容量已满：后面几条必然同样失败，别刷一串同样的日志
        }
        warn(`线索入账失败：${chatKey} ${candidate.type} ${error?.message || error}`)
      }
    }

    // 5. 轮末软裁剪：TTL 到期的 active/extended → dormant，并走注入的归档钩子进经历流。
    if (at - lastPruneAt >= pruneIntervalOf()) {
      lastPruneAt = at
      stat.pruned = prune(at)
    }

    if (stat.pushed) info(`${chatKey}：挂起线索 +${stat.pushed}（${candidates.map((c) => c.type).join(',')}）`)
    return stat
  }

  /** pruneExpired + 归档补写；账本/钩子出问题都只记日志。 */
  function prune(at) {
    let pruned = 0
    try {
      const turned = ledger.pruneExpired({ now: at })
      pruned = Array.isArray(turned) ? turned.length : 0
      for (const record of turned || []) {
        debug(`线索转休眠：${record.chatKey} ${record.type} ${record.id}（${record.dormantReason || 'ttl_expired'}）`)
      }
    } catch (error) {
      warn(`线索裁剪失败：${error?.message || error}`)
    }
    // 归档钩子当时没注入 / 记忆模块没起来：这里补写，否则摘要只能永远停在 pendingArchive。
    try {
      const stats = typeof ledger.stats === 'function' ? ledger.stats() : null
      if (stats && stats.pendingArchive > 0 && typeof ledger.retryArchive === 'function') {
        const flushed = ledger.retryArchive()
        if (flushed.length) info(`线索归档补写 ${flushed.length} 条进经历流`)
      }
    } catch (error) {
      debug(`线索归档补写跳过：${error?.message || error}`)
    }
    return pruned
  }

  /** 等所有未完成的观察链收尾（测试、优雅退出用）。 */
  function flush() { return chain }

  return { recordTurn, flush, prune }
}