// 入口合流防抖中间件（RFC-0001 §4 Phase 2 / US-008，G2 中断并合并）。
//
// 把 hub 内部 pending/enqueue/flush 的「连发合并」语义（src/chat/hub.js:1709 起）
// 上提为洋葱管道中间件：同一 chat 的入站事件在窗口期内先挂起聚合，到期或达到
// 条数上限后 lead 携带合并段放行，followers 以 'superseded-merged' 中止——
// 它们从未经旧入口（terminal 在本层之后才可能被派发，两级都不进），装配发送口
// 的「无 ctx 回落」路径对它们不存在（旧核心没跑就没有发送），双发风险为零。
//
// compose §2.2 冒泡态语义（US-008a）是本件成立的前提：follower 被 abort 时，
// 已派发各层（tracing → flush → egress → 本层）的 bubble 正常回溯收尾；
// 其 reply 队列从未入过东西，即便有残留也在 dispatcher 发送边界被丢弃计数。
//
// G2 诚实边界（legacy 核心对 abort 的响应粒度，照实记录）：
//   - abort 的生效粒度 = US-005 Dispatcher 契约的「未 flush 回复不外发 + dropped
//     计数」；正在进行中的 LLM/DSH 回合**不会被打断**——legacy 核心没有把取消
//     通道接进 agent.followup/steer，signal 只在出口链路被消费。
//   - busy steer 中止在飞 lead 后，旧回合的推理照常跑完（其未 flush 的回复被
//     Dispatcher 丢弃）；新回合下行时会撞进 hub 自身的 busy/waiting 语义，真回合
//     要等旧轮 release 才被旧核心受理。管道层的「中断」是出口级中断，不是推理级中断。

import { traceStage } from './mw-tracing.js'

/**
 * 入口合流灰度开关：FLAG_INGRESS_AGGREGATOR。
 * 解析口径与 FLAG_USE_PIPELINE / FLAG_EGRESS_SHADOW 一致（仅 'true'/'1' 算开）。
 * 为什么不是「FLAG_USE_PIPELINE 一开就上」：legacy 核心的 Ingress（hub.onMessage 的
 * 逐事件解析 + 自家 pending 合流）还在原位，本件按拍板语义会吞掉 followers（不进终端），
 * 于是旧核心只能看见 lead 那一条报文——实测 e2e 开启态 7 条用例丢消息/超时。
 * 等 US-009/Phase 3 把 Ingress 收进管道（或旧核心不再自持合流）后再把这个开关并进
 * FLAG_USE_PIPELINE。装配细节见 src/host.js 管道装配处注释。
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isIngressAggregatorEnabled(env = process.env) {
  const raw = env?.FLAG_INGRESS_AGGREGATOR
  if (typeof raw !== 'string') return false
  const v = raw.trim().toLowerCase()
  return v === 'true' || v === '1'
}

/** 与 hub RANK 同款：mode 越大越优先（engaged < interject < must；未知按 must）。 */
const RANK = { engaged: 1, interject: 2, must: 3 }
/** 图片段合并上限，与 hub pending 的 p.images.length < 4 对齐。 */
const IMAGE_CAP = 4

/** 聚合元数据在 ctx.state 上的键（供装配层/观测消费）。 */
export const AGGREGATION_KEY = Symbol.for('dsh-qq-hub.kernel.aggregation')

/** 事件 → hub 同款 chatId 口径：group:<gid> / private:<uid>；不归聊事件返回 undefined。 */
function chatIdFromInbound(inbound) {
  if (inbound?.groupId) return `group:${inbound.groupId}`
  const userId = String(inbound?.sender?.userId ?? '')
  if (userId && inbound?.subType !== 'group') return `private:${userId}`
  return undefined
}

/** 整条事件的文本并入一个槽（与 hub p.texts 的「一条消息一项」同构）。 */
function extractText(inbound) {
  const segs = inbound?.segments
  if (Array.isArray(segs) && segs.length) {
    return segs.filter((s) => s && s.type === 'text').map((s) => String(s.data?.text ?? '')).join('')
  }
  return String(inbound?.rawText ?? '')
}

function extractImages(inbound) {
  const segs = inbound?.segments
  if (!Array.isArray(segs)) return []
  return segs.filter((s) => s && s.type === 'image')
}

/** 幂等 deferred：flush/steer/dispose 三路唤醒都安全。 */
function makeDeferred() {
  const d = { settled: false, value: undefined, promise: null }
  d.promise = new Promise((resolve) => {
    d.resolve = (v) => {
      if (d.settled) return
      d.settled = true
      d.value = v
      resolve(v)
    }
  })
  return d
}

/**
 * 入口合流防抖中间件工厂。
 *
 * @param {object} [options]
 * @param {() => any} [options.getConfig] 配置源，消费 getConfig().merge：
 *   enabled / waitSec / maxSec / groupWaitSec / groupMaxSec（秒，换算毫秒；口径同 hub enqueue）
 * @param {() => number} [options.clock] 毫秒时钟（缺省 Date.now；测试注入假时钟）
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
 *   可中止睡眠；**注入时必须尊重 signal**（中止后尽快结束），否则 dispose/条数上限
 *   提前收尾会拖到窗口自然到期。缺省走宿主 setTimeout，句柄全部登记在实例内。
 * @param {{ debug?: Function, info?: Function, warn?: Function }} [options.log]
 * @param {(name: string, ms: number) => any} [options.reportStage] 分段自报覆盖位（G4）：
 *   给了就用它（段名 'aggregator' / 'aggregator-direct'，ms 取注入 clock）；
 *   缺省走 mw-tracing 的 traceStage 自报，未装 tracing 时自动退化为直执行。
 * @param {(inbound: any, ctx: any) => string | undefined} [options.resolveChatId] 归聊钩子
 * @param {(inbound: any, ctx: any) => string} [options.resolveMode] mode 判定钩子（缺省 must，同 hub 入口默认）
 * @param {number} [options.maxCount] 条数上限，达到即提前 flush（缺省 20）
 * @returns {((ctx: any, next: () => Promise<void>) => Promise<void>) & { dispose(): void, stats(): object }}
 */
export function createAggregatorMiddleware(options = {}) {
  const {
    getConfig,
    clock = () => Date.now(),
    sleep,
    log,
    reportStage,
    resolveChatId = chatIdFromInbound,
    resolveMode = () => 'must',
    maxCount = 20,
  } = options

  const dbg = (msg) => { try { log?.debug?.(msg) } catch { /* 日志出口不吃崩主链 */ } }
  const warn = (msg) => { try { log?.warn?.(msg) } catch {} }
  const stage = (name, ms) => { try { reportStage?.(name, ms) } catch {} }
  /**
   * 分段自报（G4 粒度）：装配层显式给了 reportStage 就只走它（测试/独立观测用），
   * 否则交给 traceStage——没装 tracing 时 traceStage 自动退化为直执行，flag-off 零风险面。
   * @param {any} ctx
   * @param {string} name
   * @param {() => Promise<any>} fn
   */
  async function timed(ctx, name, fn) {
    if (reportStage) {
      const t0 = clock()
      try {
        return await fn()
      } finally {
        stage(name, clock() - t0)
      }
    }
    return traceStage(ctx, name, fn)
  }

  /** chatId → 聚合窗口（lead = items[0]；wake 唤醒 lead，entries 各自持 deferred 唤醒 follower）。 */
  const windows = new Map()
  /** 在飞 lead 注册表：chatId → 当前正在跑整链的回合 ctx（装配层语义）。 */
  const inFlight = new Map()
  /** 全部定时器句柄登记处：dispose 逐个 clearTimeout，零泄漏。 */
  const timers = new Set()
  let disposed = false
  const counters = { mergedRounds: 0, steered: 0, disposedAborts: 0 }
  let lastSteered = null // { at, ctx }：steer 丢弃计数观测用

  /** 窗口到期睡眠（可中止）：sleep 注入则走注入函数，否则宿主 setTimeout。 */
  function sleepMs(ms, signal) {
    const bounded = Math.max(0, ms)
    if (typeof sleep === 'function') {
      const controller = new AbortController()
      const onOuterAbort = () => controller.abort()
      if (signal?.aborted || disposed) controller.abort()
      else signal?.addEventListener?.('abort', onOuterAbort, { once: true })
      const p = Promise.resolve()
        // 防护：cancel 可能早于这笔 microtask（同一条消息重排窗口的常见次序）。
        // 已被中止就别再把 aborted signal 递给注入的 sleep——不少 sleep 实现对
        // 「进来就 aborted」的 signal 不会再触发回调，会留下永不结束的僵尸窗口。
        .then(() => (controller.signal.aborted ? undefined : sleep(bounded, controller.signal)))
        .then(() => (controller.signal.aborted ? 'cancelled' : 'expired'), () => 'error')
      p.cancel = () => { try { controller.abort() } catch {} }
      return p
    }
    let handle
    const done = new Promise((resolve) => {
      handle = setTimeout(() => { timers.delete(handle); resolve('expired') }, bounded)
      handle.unref?.()
      timers.add(handle)
    })
    done.cancel = () => {
      if (timers.has(handle)) { clearTimeout(handle); timers.delete(handle) }
    }
    if (signal?.aborted || disposed) done.cancel()
    signal?.addEventListener?.('abort', () => done.cancel(), { once: true })
    return done
  }

  /** 窗口计时：min(wait, max 余量)，群/私聊参数分开（口径同 hub.js:1735-1737）。 */
  function windowMs(win) {
    const m = (typeof getConfig === 'function' ? getConfig()?.merge : null) || {}
    const group = String(win.leadCtx?.inbound?.groupId ?? '') !== ''
    const wait = Math.max(0, Number(group ? m.groupWaitSec : m.waitSec) || 0) * 1000
    const max = Math.max(0, Number(group ? m.groupMaxSec : m.maxSec) || 0) * 1000
    const left = Math.max(0, max - (clock() - win.firstAt))
    return Math.min(wait, left)
  }

  /** 重排窗口定时器（每条新消息重置 wait，max 从首条起算——与 hub 一致）。 */
  function armTimer(win) {
    win.timer?.cancel()
    const timer = sleepMs(windowMs(win), win.wakeSignal ?? undefined)
    win.timer = timer
    Promise.resolve(timer).then((why) => {
      if (why === 'expired' && windows.get(win.chatId) === win) flushWindow(win.chatId, 'window')
    })
  }

  /** 把一条事件并入窗口缓冲（texts 到达序、images≤4、senders 并集、mode RANK 取最高）。 */
  function absorb(win, ctx) {
    win.count++
    const text = extractText(ctx.inbound)
    if (text) win.texts.push(text)
    for (const img of extractImages(ctx.inbound)) {
      if (win.images.length >= IMAGE_CAP) break
      win.images.push(img)
    }
    const uid = String(ctx.inbound?.sender?.userId ?? '')
    if (uid) win.senders.add(uid)
    const mode = String(resolveMode(ctx.inbound, ctx) || 'must')
    if ((RANK[mode] || 3) > (RANK[win.mode] || 3)) win.mode = mode
  }

  /** 合并收口：followers 段并进 lead.inbound，lead 放行、followers 中止。 */
  function flushWindow(chatId, reason) {
    const win = windows.get(chatId)
    if (!win) return
    windows.delete(chatId)
    win.timer?.cancel()
    const [lead, ...followers] = win.entries
    const leadCtx = win.leadCtx
    if (leadCtx.signal?.aborted) {
      // lead 开窗后已被 steer/dispose 中断：整窗作废，一个都不放行
      win.wake.resolve('aborted')
      for (const f of followers) f.deferred.resolve('aborted')
      return
    }
    // 段合并写回 lead 的 inbound 视图（拍板设计）。信封对象本身被驱动层冻结，
    // 所以这里是「替换 leadCtx.inbound 为合并后新信封」而非就地改——ctx 的 inbound
    // 是可赋值槽（context.js 只冻结 meta/信封），替换后 egress/legacy 读到的即合并态。
    // rawPayload 保持 lead 原事件**同一引用**不重建：旧核心真正消费的是 rawPayload
    // （hub 内部 pending 合流仍在其位），信封合并供 Ingress 视角与后续 Phase 纯管道链路使用。
    const mergedText = win.texts.join('\n')
    const leadInbound = leadCtx.inbound || {}
    try {
      leadCtx.inbound = Object.freeze({
        ...leadInbound,
        segments: Object.freeze([
          ...(mergedText ? [{ type: 'text', data: Object.freeze({ text: mergedText }) }] : []),
          ...win.images,
        ]),
        rawText: mergedText,
      })
    } catch (err) {
      warn(`aggregator: 合并写回 lead.inbound 失败（${chatId}）：${err && err.message}`)
    }
    leadCtx.state.set(AGGREGATION_KEY, {
      merged: true,
      count: win.count,
      senders: [...win.senders],
      mode: win.mode,
      followers: followers.length,
      reason,
    })
    counters.mergedRounds++
    if (win.count > 1) dbg(`${chatId}：入口合流 ${win.count} 条（mode=${win.mode}，${reason}）`)
    // follower 先行中止：abort 发生在「本层 await deferred」这一点——此刻本层的
    // 在飞派发边界就是本层自己，terminal（旧核心）与 flush/egress/dispatcher
    // 两级都不进；已派发各层 bubble 按 §2.2 正常收尾。reply 队列从未入过东西，
    // 外发为零。随后唤醒 follower 的 await，让其从本层直接 return。
    for (const f of followers) {
      if (!f.ctx.signal?.aborted) {
        try { f.ctx.abort('superseded-merged') } catch {}
      }
      f.deferred.resolve('merged')
    }
    win.wake.resolve('flushed')
  }

  /** busy steer：中止在飞 lead；丢弃观测（其 reply 队列里未 flush 的条目）由 stats 汇总。 */
  function steerInFlight(chatId) {
    const running = inFlight.get(chatId)
    if (!running) return
    try { running.abort('superseded') } catch {}
    inFlight.delete(chatId)
    counters.steered++
    lastSteered = { at: clock(), ctx: running }
    dbg(`${chatId}：busy steer——中止在飞回合（出口级中断；进行中的 LLM 请求不打断）`)
  }

  async function aggregator(ctx, next) {
    if (disposed) {
      try { ctx.abort('aggregator-disposed') } catch {}
      counters.disposedAborts++
      return
    }
    const m = (typeof getConfig === 'function' ? getConfig()?.merge : null) || {}
    const chatId = m.enabled === false ? undefined : resolveChatId(ctx.inbound, ctx)
    // 不归聊（poke/notice/无 sender）或合流关闭：直通下行，不碰窗口。
    if (!chatId) {
      await timed(ctx, 'aggregator-direct', () => next())
      return
    }

    // busy steer：上一回合还在整链途中，新事件按 hub 私聊 steer 语义——中止在飞
    // lead，自己作为下一回合 lead 立即开窗（不并进旧回合的推理上下文，见文件头
    // G2 诚实边界：legacy 核心的 steer 通道吃的是旧核心自己的会话，这里只保证
    // 「回复不外发 + 新一轮尽快起步」）。
    steerInFlight(chatId)

    let win = windows.get(chatId)
    const entry = { ctx, deferred: makeDeferred() }
    if (!win) {
      win = {
        chatId,
        leadCtx: ctx,
        entries: [],
        texts: [],
        images: [],
        senders: new Set(),
        mode: String(resolveMode(ctx.inbound, ctx) || 'must'),
        firstAt: clock(),
        count: 0,
        timer: null,
        wake: makeDeferred(),
      }
      windows.set(chatId, win)
      win.entries.push(entry)
      absorb(win, ctx)
      if (win.count >= maxCount) flushWindow(chatId, 'count')
      else armTimer(win)
    } else {
      win.entries.push(entry)
      absorb(win, ctx)
      if (win.count >= maxCount) flushWindow(chatId, 'count')
      else armTimer(win)
    }

    if (win.leadCtx !== ctx) {
      // 非 lead：等合并/作废信号。被 flushWindow 中止后本层直接 return，
      // 不 next()——下游两级都不进（拍板设计的 follower 兜底断言点）。
      await entry.deferred.promise
      return
    }

    // —— lead 路径 ——
    const why = await win.wake.promise
    if (why !== 'flushed' || ctx.signal?.aborted) return // 整窗被 steer/dispose 作废
    inFlight.set(chatId, ctx)
    try {
      // 旧核心 + egress + dispatcher 全链；G4 粒度：整段自报为 'aggregator'
      await timed(ctx, 'aggregator', () => next())
    } finally {
      if (inFlight.get(chatId) === ctx) inFlight.delete(chatId)
    }
  }

  /** 卸载：清全部定时器，挂起窗口逐个中止（lead/follower 都不再下行）。 */
  function dispose() {
    if (disposed) return
    disposed = true
    for (const win of windows.values()) {
      win.timer?.cancel()
      for (const e of win.entries) {
        if (!e.ctx.signal?.aborted) {
          try { e.ctx.abort('aggregator-disposed') } catch {}
          counters.disposedAborts++
        }
        e.deferred.resolve('aborted')
      }
      win.wake.resolve('aborted')
    }
    windows.clear()
    for (const handle of timers) { try { clearTimeout(handle) } catch {} }
    timers.clear()
    inFlight.clear()
    dbg('aggregator: disposed')
  }

  aggregator.dispose = dispose
  aggregator.stats = () => ({
    windows: windows.size,
    inFlight: inFlight.size,
    pendingTimers: timers.size,
    mergedRounds: counters.mergedRounds,
    steered: counters.steered,
    disposedAborts: counters.disposedAborts,
    // 最近一次 steer 时在飞 lead 的未 flush 回复条数（dispatcher 会将其计 dropped）
    lastSteerPendingReplies: lastSteered?.ctx?.reply?.queue?.length ?? 0,
  })
  return aggregator
}
