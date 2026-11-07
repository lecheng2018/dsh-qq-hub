// 出站 Dispatcher 与优先级队列（RFC-0001 §2 Dispatcher & API Call Sink / §4 Phase 1，US-005）。
//
// 回写态（Flush Phase）的执行者：管道退栈后吃 ctx.reply 缓冲池，按优先级出队、
// 限流整形、逐条交给注入的 sender 物理发包。本模块是**纯库**——
//   - 零 require onebot/fs/net：sender、log、clock、sleep、jitter 全部构造注入；
//   - 重试策略委托 sender 自身：Dispatcher 不吞错误、不自作重试，单条抛错只计 failed
//     并入 summary.failures，后续条目照常发送（语义见 drain JSDoc，供 US-007 接线方决策）；
//   - shadow（dry-run）与 live 互斥，由构造参数决定：shadow 不调 sender、不真睡，
//     只对每条 payload 计算稳定 hash 记录，供与旧通道逐条比对（RFC Phase 1 双发校验）。
//
// 2026-11-07 review A4 修复对照（P1×4 / P2×3 全落）：
//   #1 takeBatch：live drain 在**首个 await 之前**同步「快照 + 清空」原子领取批次；
//      批次外新入队的条目留在队列归下一批，正常路径不再结尾 clear()（旧实现结尾
//      clear() 会把 drain 期间新入队的消息连锅吞掉且不计 dropped）。并发 drain 因
//      领取原子的天然拿到不相交批次，同一条目不可能被双发。
//   #2 篡改窗口：由 context.js enqueue 深冻结 + queue getter 快照化根治（A2 联动），
//      本模块全程只读。
//   #3 sleep 拒绝不再炸整批：捕获后把**未尝试条目**经 restoreFront 放回队列（deferred
//      计数 + infrastructureError），已发送条目绝不重放。
//   #4 限流状态跨 drain 生效：实例级 lastSentAt（单调时钟），同优先级 FIFO 与
//      createdAt 解耦（#5：删掉 createdAt 次排序，稳定排序保入队序）。
//   #6 canonicalJSON 对齐 JSON.stringify 出站语义（函数省略、Date 走 toJSON、
//      BigInt/循环引用抛错由调用方计失败）。
//   #7 jitter 结果二次 clamp 回 [min,max]，构造参数与 jitter 返回值全校验。

import { createHash } from 'node:crypto'

/** RFC §3.1 ReplyPriority → 出队权重（越小越先）。未知值一律归 NORMAL，不让脏数据插队。 */
const PRIORITY_WEIGHT = { HIGH: 0, NORMAL: 1, LOW: 2 }

function normalizePriority(priority) {
  return priority === 'HIGH' || priority === 'LOW' ? priority : 'NORMAL'
}

function round3(ms) {
  return Math.round(ms * 1000) / 1000
}

/** 缺省睡眠原语：测试必须注入假 sleep，绝不允许真睡。 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 文本段总字数——限流间隔的「打字时长」输入（语义对齐 chat/reply.js bubbleDelay，但不 import）。 */
function segmentsTextLength(segments) {
  let len = 0
  for (const seg of segments) {
    if (seg?.type === 'text') len += String(seg?.data?.text ?? '').length
  }
  return len
}

/**
 * 确定性序列化：先按 JSON.stringify 的出站语义归一（review A4#6），再做键排序稳定化。
 * 函数/symbol 在对象上省略、在数组里为 null；Date 走 toJSON；BigInt/循环引用抛
 * TypeError（调用方按单条失败处理，不炸批次）。
 */
function canonicalJSON(value) {
  const wire = JSON.parse(JSON.stringify(value === undefined ? null : value))
  return stable(wire)
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v)
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
    const keys = Object.keys(v).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`
  }
}

/**
 * ReplyPayload 稳定 hash：只取 target + segments 的规范化 JSON 做 sha256 前 12 位。
 * 刻意不含 id/createdAt/priority/delayMs——同内容两次入队（新旧双通道各发一次）必须同 hash 才可比对。
 * @param {Pick<import('./types.js').ReplyPayload, 'targetType' | 'targetId' | 'segments'>} payload
 * @returns {string} 12 位十六进制摘要
 */
export function hashReplyPayload(payload) {
  const normalized = {
    targetType: payload?.targetType ?? null,
    targetId: payload?.targetId ?? null,
    segments: Array.isArray(payload?.segments) ? payload.segments : [],
  }
  return createHash('sha256').update(canonicalJSON(normalized), 'utf8').digest('hex').slice(0, 12)
}

function assertFinite(name, v, min, max) {
  if (!Number.isFinite(v) || (min !== undefined && v < min) || (max !== undefined && v > max)) {
    throw new TypeError(`dispatcher shaping: ${name} 必须为有限数${min !== undefined ? ` 且 ≥ ${min}` : ''}${max !== undefined ? ` 且 ≤ ${max}` : ''}，收到 ${String(v)}`)
  }
}

/**
 * 创建出站 Dispatcher。
 *
 * @param {object} [options]
 * @param {(payload: import('./types.js').ReplyPayload) => Promise<void> | void} [options.sender]
 *   注入的发送依赖（US-007 接线时换 onebot call）。live 模式必填；抛错视为该条失败，
 *   **重试策略由 sender 自行实现**——Dispatcher 只隔离单条、计数、继续 drain。
 * @param {{ debug?: Function, warn?: Function, error?: Function }} [options.log] 日志出口，缺省静默；
 *   出口抛错就地吃掉，绝不把可观测性做成新故障面（US-004 同纪律）。
 * @param {() => number} [options.clock] 时间戳源（summary.startedAt/finishedAt），缺省 Date.now
 * @param {() => number} [options.mono] 单调 pacing 时钟（review A4#4 跨 drain 间隔），缺省 performance.now
 * @param {(ms: number) => Promise<void>} [options.sleep] 睡眠原语，缺省 setTimeout（测试注入假 sleep）
 * @param {() => number} [options.jitter] 间隔抖动随机源 [0,1)，缺省 Math.random，系数 0.8 + r*0.5；
 *   返回值非法（非有限/越界）按 0.5 处理不炸批。
 * @param {'live' | 'shadow'} [options.mode] 'shadow' = dry-run，不调 sender、不真睡、**不消费队列**
 * @param {object} [options.shaping] 限流整形参数（语义对齐 hub 的 mood/bubbleDelay，参数注入不外引）
 * @param {number} [options.shaping.baseMs=350] 打字基础耗时
 * @param {number} [options.shaping.perCharMs=110] 每字符耗时（约每秒 9 字）
 * @param {number} [options.shaping.minGapMs=700] 间隔下限（jitter 后仍 clamp 回此界，review A4#7）
 * @param {number} [options.shaping.maxGapMs=4500] 间隔上限
 * @param {string} [options.stageName='dispatcher'] 喂给 reportStage 的段名
 * @param {(name: string, ms: number) => void} [options.reportStage] US-004 traceStage 打点注入：
 *   drain 结束时上报一次 (stageName, latencyMs)，供 tracing 中间件归段。抛错就地吃掉。
 * @returns {{ drain: (ctx: any) => Promise<object>, shadowRecords: () => object[], mode: string }}
 */
export function createDispatcher(options = {}) {
  const mode = options.mode ?? 'live'
  if (mode !== 'live' && mode !== 'shadow') {
    throw new TypeError(`Dispatcher mode 必须是 'live' 或 'shadow'，收到：${String(mode)}`)
  }
  const sender = options.sender
  if (mode === 'live' && typeof sender !== 'function') {
    throw new TypeError('live 模式必须注入 sender')
  }

  const log = options.log
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now()
  // 缺省跟随注入的 clock（测试假时钟可钉死 pacing）；两者都没注入才用真实单调钟
  const mono = typeof options.mono === 'function'
    ? options.mono
    : (typeof options.clock === 'function' ? options.clock : () => performance.now())
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep
  const rawJitter = typeof options.jitter === 'function' ? options.jitter : Math.random
  const jitter = () => {
    const r = rawJitter()
    // 契约 [0,1)；对 r===1（旧测试的满抖动探针）从宽接受，越界/非法值取中位 0.5
    return Number.isFinite(r) && r >= 0 && r <= 1 ? r : 0.5
  }

  const shaping = {
    baseMs: options.shaping?.baseMs ?? 350,
    perCharMs: options.shaping?.perCharMs ?? 110,
    minGapMs: options.shaping?.minGapMs ?? 700,
    maxGapMs: options.shaping?.maxGapMs ?? 4500,
  }
  assertFinite('baseMs', shaping.baseMs, 0)
  assertFinite('perCharMs', shaping.perCharMs, 0)
  assertFinite('minGapMs', shaping.minGapMs, 0)
  assertFinite('maxGapMs', shaping.maxGapMs, 0)
  if (shaping.minGapMs > shaping.maxGapMs) throw new TypeError('dispatcher shaping: minGapMs 不得大于 maxGapMs')

  const stageName = typeof options.stageName === 'string' ? options.stageName : 'dispatcher'
  const reportStage = typeof options.reportStage === 'function' ? options.reportStage : null

  /** shadow 记录池：构造级累积（跨 drain 可查），供 US-007 与旧通道批量比对。 */
  const shadow = []
  /** 实例级 pacing 状态（review A4#4：跨 drain/跨 ctx 也保持最小间隔）。 */
  let lastSentAt = -Infinity

  function safeLog(level, args) {
    try {
      log?.[level]?.(...args)
    } catch (error) {}
  }

  /**
   * 单条出队间隔。契约（review A4#4 三选一拍板，保持 US-007 接线兼容）：
   *   - payload.delayMs 为**显式覆写**（number 且有限时直接生效，含 0）：
   *     cutover 路径下 hub 已自 pacing，覆写 0 是接线契约的一部分，不是绕过限流；
   *   - 缺省走 typing 估时 → clamp [min,max] → jitter(0.8~1.3) → **再 clamp 回 [min,max]**（A4#7）。
   */
  function gapFor(payload) {
    if (typeof payload.delayMs === 'number' && Number.isFinite(payload.delayMs)) {
      return Math.max(0, payload.delayMs)
    }
    const typing = shaping.baseMs + segmentsTextLength(payload.segments) * shaping.perCharMs
    const clamped = Math.min(shaping.maxGapMs, Math.max(shaping.minGapMs, typing))
    const jittered = Math.round(clamped * (0.8 + jitter() * 0.5))
    return Math.min(shaping.maxGapMs, Math.max(shaping.minGapMs, jittered))
  }

  /**
   * 排空 ctx.reply。
   *
   * 契约（US-007 接线方决策依据，review A4 修复后版）：
   *   - **live 批次领取是原子的**：首个 await 之前同步「快照 + clear」；本轮只处理
   *     领取到的批次，drain 期间新入队条目留在队列归下一次 drain（不再被结尾 clear 吞掉）。
   *     并发 drain 领取不相交批次，天然无同条双发。
   *   - 每条**发送边界**重查 ctx.signal.aborted：已 abort 则把批次内剩余未尝试条目计入
   *     dropped（这些条目已领取出队列，语义=丢弃并计数），正常返回不抛错。
   *     在途 sender/sleep 不打断——abort 生效粒度是「下一条发送之前」，Phase 1 不做抢占式取消。
   *   - 失败隔离：sender 抛错 → failed+1、failures 记 {id, message}、error 日志一条，
   *     继续发后续条目；是否重试由 sender 决定，Dispatcher 不重放。
   *   - sleep 拒绝（注入调度器故障）：捕获，**未尝试条目 restoreFront 放回队列**计 deferred
   *     并附 infrastructureError；已发送条目绝不重放。
   *   - shadow 模式：不消费队列（旧通道还要吃它）、不真睡、不调 sender，只记 hash；
   *     abort 路径与 live 一致地 clear（被抢占的内容谁都别想再发）。
   *   - pacing：实例级 lastSentAt（单调时钟）跨 drain 生效；delayMs 显式覆写语义见 gapFor。
   *
   * @param {any} ctx 洋葱 Context（需要 reply.queue/reply.clear/reply.restoreFront? 与 signal.aborted 的最小 duck 形态）
   * @returns {Promise<{total: number, sent: number, failed: number, dropped: number, deferred: number,
   *   shadow: number, byPriority: object, failures: object[], infrastructureError?: object,
   *   startedAt: number, finishedAt: number, latencyMs: number}>} flush summary
   */
  async function drain(ctx) {
    const startedAt = clock()
    const queueView = Array.isArray(ctx?.reply?.queue) ? ctx.reply.queue : []
    let items = [...queueView]
    const total = items.length

    // live：同步原子领取批次（快照此刻已在手，clear 必须在任何 await 之前）
    if (mode === 'live' && typeof ctx?.reply?.clear === 'function') ctx.reply.clear()

    const byPriority = { HIGH: 0, NORMAL: 0, LOW: 0 }
    for (const item of items) byPriority[normalizePriority(item.priority)] += 1

    // 同优先级 FIFO：稳定排序保入队序；createdAt 不再参与（review A4#5——
    // 时钟回拨/历史时间戳会重排队列，且缺失 createdAt 会被当 0 插队）
    const ordered = items.sort(
      (a, b) => PRIORITY_WEIGHT[normalizePriority(a.priority)] - PRIORITY_WEIGHT[normalizePriority(b.priority)],
    )

    let sent = 0
    let failed = 0
    let dropped = 0
    let deferred = 0
    let shadowed = 0
    let aborted = false
    let infrastructureError = null
    /** @type {{id: string, message: string}[]} */
    const failures = []

    for (let i = 0; i < ordered.length; i += 1) {
      const payload = ordered[i]
      if (ctx?.signal?.aborted) {
        aborted = true
        dropped = ordered.length - i
        break
      }
      if (mode === 'shadow') {
        // 影子不真睡（review C2#6）、不消费队列
        try {
          shadow.push({ id: payload.id, hash: hashReplyPayload(payload), priority: normalizePriority(payload.priority) })
          shadowed += 1
        } catch (error) {
          failed += 1
          failures.push({ id: String(payload.id), message: String(error?.message ?? error) })
          safeLog('error', ['dispatcher: shadow hash failed id=', payload.id, ':', error?.message ?? error])
        }
        continue
      }
      const gap = gapFor(payload)
      if (gap > 0 || lastSentAt !== -Infinity) {
        const waitMs = Math.max(0, lastSentAt + gap - mono())
        if (waitMs > 0) {
          try {
            await sleep(waitMs)
          } catch (error) {
            // 调度器故障：未尝试条目（含本条）放回队列头部，绝不重放已发送项
            deferred = ordered.length - i
            if (typeof ctx?.reply?.restoreFront === 'function') ctx.reply.restoreFront(ordered.slice(i))
            infrastructureError = { phase: 'sleep', message: String(error?.message ?? error) }
            safeLog('warn', ['dispatcher: sleep failed, deferred', deferred, ':', error?.message ?? error])
            break
          }
          if (ctx?.signal?.aborted) {
            aborted = true
            dropped = ordered.length - i
            break
          }
        }
      }
      try {
        await sender(payload)
        sent += 1
      } catch (error) {
        failed += 1
        failures.push({ id: String(payload.id), message: String(error?.message ?? error) })
        safeLog('error', ['dispatcher: send failed id=', payload.id, ':', error?.message ?? error])
      } finally {
        lastSentAt = mono()
      }
    }

    if (aborted) {
      safeLog('warn', ['dispatcher: ctx aborted, dropped', dropped, 'of', total, 'pending replies'])
    }

    const finishedAt = clock()
    const summary = {
      total,
      sent,
      failed,
      dropped,
      deferred,
      shadow: shadowed,
      byPriority,
      failures,
      startedAt,
      finishedAt,
      latencyMs: round3(finishedAt - startedAt),
    }
    if (infrastructureError) summary.infrastructureError = infrastructureError
    safeLog('debug', [
      `dispatcher flush mode=${mode} total=${total} sent=${sent} failed=${failed} dropped=${dropped} deferred=${deferred} shadow=${shadowed} latency=${summary.latencyMs}ms`,
    ])
    if (reportStage) {
      try {
        reportStage(stageName, summary.latencyMs)
      } catch (error) {}
    }
    return summary
  }

  /** shadow 记录的可查快照：{id, hash, priority}[]，副本返回，防外部篡改观测数据。 */
  function shadowRecords() {
    return shadow.map((r) => ({ ...r }))
  }

  return { drain, shadowRecords, mode }
}
