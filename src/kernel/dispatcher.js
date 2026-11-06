// 出站 Dispatcher 与优先级队列（RFC-0001 §2 Dispatcher & API Call Sink / §4 Phase 1，US-005）。
//
// 回写态（Flush Phase）的执行者：管道退栈后吃 ctx.reply 缓冲池，按优先级出队、
// 限流整形、逐条交给注入的 sender 物理发包。本模块是**纯库**——
//   - 零 require onebot/fs/net：sender、log、clock、sleep、jitter 全部构造注入；
//   - 重试策略委托 sender 自身：Dispatcher 不吞错误、不自作重试，单条抛错只计 failed
//     并入 summary.failures，后续条目照常发送（语义见 drain JSDoc，供 US-007 接线方决策）；
//   - shadow（dry-run）与 live 互斥，由构造参数决定：shadow 不调 sender，只对每条
//     payload 计算稳定 hash 记录，供与旧通道逐条比对（RFC Phase 1 双发校验）。
//
// 内核观察项守则（US-001 verifier 移交）：
//   - reply.queue getter 返回内部数组引用 → drain 开头 slice() 快照，clear() 前绝不触碰原数组；
//   - enqueue 的 segments 元素是浅冻结（数组冻结、元素对象未冻结）→ 本模块全程**只读**，
//     不改段对象、不写 payload 任何字段。

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
 * 确定性序列化：对象键排序、数组保序、undefined/null 归一为 null。
 * 跨进程、跨字段书写顺序都产出同一串——hash 比对的根基，不能用裸 JSON.stringify。
 */
function canonicalJSON(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'function') return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`
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

/**
 * 创建出站 Dispatcher。
 *
 * @param {object} [options]
 * @param {(payload: import('./types.js').ReplyPayload) => Promise<void> | void} [options.sender]
 *   注入的发送依赖（US-007 接线时换 onebot call）。live 模式必填；抛错视为该条失败，
 *   **重试策略由 sender 自行实现**——Dispatcher 只隔离单条、计数、继续 drain。
 * @param {{ debug?: Function, warn?: Function, error?: Function }} [options.log] 日志出口，缺省静默；
 *   出口抛错就地吃掉，绝不把可观测性做成新故障面（US-004 同纪律）。
 * @param {() => number} [options.clock] 时间戳源，缺省 Date.now（测试注入假时钟）
 * @param {(ms: number) => Promise<void>} [options.sleep] 睡眠原语，缺省 setTimeout（测试注入假 sleep）
 * @param {() => number} [options.jitter] 间隔抖动随机源 [0,1)，缺省 Math.random，系数 0.8 + r*0.5
 *   （与 bubbleDelay 同款抗惊群思路；测试注入常量函数即可钉死间隔序列）
 * @param {'live' | 'shadow'} [options.mode] 'shadow' = dry-run，不调 sender 只记 hash；与 live 互斥
 * @param {object} [options.shaping] 限流整形参数（语义对齐 hub 的 mood/bubbleDelay，参数注入不外引）
 * @param {number} [options.shaping.baseMs=350] 打字基础耗时
 * @param {number} [options.shaping.perCharMs=110] 每字符耗时（约每秒 9 字）
 * @param {number} [options.shaping.minGapMs=700] 间隔下限
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
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep
  const jitter = typeof options.jitter === 'function' ? options.jitter : Math.random

  const shaping = {
    baseMs: options.shaping?.baseMs ?? 350,
    perCharMs: options.shaping?.perCharMs ?? 110,
    minGapMs: options.shaping?.minGapMs ?? 700,
    maxGapMs: options.shaping?.maxGapMs ?? 4500,
  }
  const stageName = typeof options.stageName === 'string' ? options.stageName : 'dispatcher'
  const reportStage = typeof options.reportStage === 'function' ? options.reportStage : null

  /** shadow 记录池：构造级累积（跨 drain 可查），供 US-007 与旧通道批量比对。 */
  const shadow = []

  function safeLog(level, args) {
    try {
      log?.[level]?.(...args)
    } catch (error) {}
  }

  /** 单条出队间隔：payload.delayMs 显式覆写优先；否则按文本长度做 typing 估时（bubbleDelay 语义）。 */
  function gapFor(payload) {
    if (typeof payload.delayMs === 'number' && Number.isFinite(payload.delayMs)) {
      return Math.max(0, payload.delayMs)
    }
    const typing = shaping.baseMs + segmentsTextLength(payload.segments) * shaping.perCharMs
    const clamped = Math.min(shaping.maxGapMs, Math.max(shaping.minGapMs, typing))
    return Math.round(clamped * (0.8 + jitter() * 0.5))
  }

  /**
   * 排空 ctx.reply：快照 → (priority, createdAt) 稳定排序 → 逐条限流发送。
   *
   * 契约（US-007 接线方决策依据）：
   *   - 每条**发送边界**重查 ctx.signal.aborted（sleep 前与 sleep 后各一次）：已 abort 则把
   *     剩余未尝试条目计入 dropped、写计数日志、调 ctx.reply.clear()，正常返回不抛错。
   *     在途 sender/sleep 不打断——abort 生效粒度是「下一条发送之前」，Phase 1 不做抢占式取消。
   *   - 失败隔离：sender 抛错 → failed+1、failures 记 {id, message}、error 日志一条，
   *     继续发后续条目；是否重试由 sender 决定，Dispatcher 不重放。
   *   - 队列消费语义：live 模式完整 drain（含中途 abort）后调 ctx.reply.clear()——条目一经
   *     尝试即视为消费，失败项不留在队列里等重发；**shadow 成功排空不动队列**（旧通道还要吃它），
   *     仅 abort 路径与 live 一致地 clear（被抢占的内容谁都别想再发）。
   *   - 快照纪律：queue getter 返回内部引用，开头 slice() 拷贝；drain 期间外部再 enqueue
   *     也不进入本轮（防活锁），清空只经 ctx.reply.clear()。
   *
   * @param {any} ctx 洋葱 Context（需要 reply.queue/reply.clear 与 signal.aborted 的最小 duck 形态）
   * @returns {Promise<{total: number, sent: number, failed: number, dropped: number, shadow: number,
   *   byPriority: {HIGH: number, NORMAL: number, LOW: number}, failures: {id: string, message: string}[],
   *   startedAt: number, finishedAt: number, latencyMs: number}>} flush summary
   */
  async function drain(ctx) {
    const startedAt = clock()
    const items = Array.isArray(ctx?.reply?.queue) ? [...ctx.reply.queue] : []
    const total = items.length

    const byPriority = { HIGH: 0, NORMAL: 0, LOW: 0 }
    for (const item of items) byPriority[normalizePriority(item.priority)] += 1

    // 稳定排序：V8 sort 自 Node 11 起保证稳定；同权重天然维持 enqueue 原序，createdAt 显式兜底
    const ordered = items.sort(
      (a, b) => PRIORITY_WEIGHT[normalizePriority(a.priority)] - PRIORITY_WEIGHT[normalizePriority(b.priority)]
        || (a.createdAt ?? 0) - (b.createdAt ?? 0),
    )

    let sent = 0
    let failed = 0
    let dropped = 0
    let shadowed = 0
    let aborted = false
    /** @type {{id: string, message: string}[]} */
    const failures = []

    for (let i = 0; i < ordered.length; i += 1) {
      const payload = ordered[i]
      if (ctx?.signal?.aborted) {
        aborted = true
        dropped = ordered.length - i
        break
      }
      if (i > 0) {
        const gap = gapFor(payload)
        if (gap > 0) {
          await sleep(gap)
          if (ctx?.signal?.aborted) {
            aborted = true
            dropped = ordered.length - i
            break
          }
        }
      }
      if (mode === 'shadow') {
        shadow.push({ id: payload.id, hash: hashReplyPayload(payload), priority: normalizePriority(payload.priority) })
        shadowed += 1
      } else {
        try {
          await sender(payload)
          sent += 1
        } catch (error) {
          failed += 1
          failures.push({ id: String(payload.id), message: String(error?.message ?? error) })
          safeLog('error', ['dispatcher: send failed id=', payload.id, ':', error?.message ?? error])
        }
      }
    }

    if (aborted) {
      ctx.reply.clear()
      safeLog('warn', ['dispatcher: ctx aborted, dropped', dropped, 'of', total, 'pending replies'])
    } else if (mode === 'live') {
      ctx.reply.clear()
    }

    const finishedAt = clock()
    const summary = {
      total,
      sent,
      failed,
      dropped,
      shadow: shadowed,
      byPriority,
      failures,
      startedAt,
      finishedAt,
      latencyMs: round3(finishedAt - startedAt),
    }
    safeLog('debug', [
      `dispatcher flush mode=${mode} total=${total} sent=${sent} failed=${failed} dropped=${dropped} shadow=${shadowed} latency=${summary.latencyMs}ms`,
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
