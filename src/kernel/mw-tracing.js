// Tracing & Metrics 中间件（RFC-0001 §2 Middleware 1 / §1.1 P8 / G4，US-004）。
//
// 站在管道最外层，把「这次回复慢在哪一步」变成一行可 grep 的 debug 打点：
//   - 进入/回溯各取一次时间戳 → 本轮 total、本层自身开销 mw0、下游整段 mw1；
//   - 下游中间件可用 traceStage() 自愿上报更细分段（Phase 1+ 逐层蚕食时加段，装配无需改）；
//   - 异常在回溯阶段计数后**原样上抛**，绝不吞（RFC P6 的病根就是外层巨型 try/catch）；
//   - abort 属于正常中断，记 aborted 标记，不计错误。
//
// 契约边界：
//   - traceId/spanId 的唯一来源是 createContext 的 ctx.meta（RFC §3.3）。本中间件不另造
//     id，也不改写 meta；裸 ctx（无 meta）进管道时用占位符记录，身份仍由 Context 工厂负责。
//   - 计时源默认 performance.now()，可注入 now() 走假时钟（RFC P4：时钟必须可注入）。
//   - 日志级别恒为 debug：core/logger.js 只把非 debug 行推给宿主 logger，生产环境不刷屏；
//     本中间件任何情况下都不打 info 及以上。日志出口自身抛错也不影响管道。
//   - 不引入任何跨请求的聚合可变状态（RFC P1 教训）：统计口径留在每轮的 TraceRecord 上，
//     由调用方（面板 / 指标导出）自行读取。

import { performance } from 'node:perf_hooks'

/** ctx.state 上挂载本轮 trace 记录的 symbol 键（与 string 键天然隔离）。 */
export const TRACE_KEY = Symbol.for('dsh-qq-hub.kernel.trace')

/** 裸 ctx 缺 traceId/spanId 时的占位符——宁可占位，也不在中间件里造第二个 id 源。 */
const NO_ID = '-'

/** 阶段名进单行日志前的字符收敛：保留字母（含中文）数字与 - . /，换行等空白折成下划线。 */
function safeName(name, fallback = 'stage') {
  const raw = String(name ?? '').trim()
  return raw ? raw.replace(/[^\p{L}\p{N}./-]/gu, '_') : fallback
}

function round3(ms) {
  return Math.round(ms * 1000) / 1000
}

function fmtMs(ms) {
  return `${round3(ms)}ms`
}

/**
 * 单轮打点记录：挂在 ctx.state（有 state 时）供下游中间件与回溯层读写。
 */
export class TraceRecord {
  #now

  /**
   * @param {() => number} now 计时源
   * @param {import('./types.js').ContextMeta} [meta] ctx.meta（traceId/spanId 来源）
   */
  constructor(now, meta) {
    this.#now = now
    this.traceId = typeof meta?.traceId === 'string' && meta.traceId ? meta.traceId : NO_ID
    this.spanId = typeof meta?.spanId === 'string' && meta.spanId ? meta.spanId : NO_ID
    /** @type {{ index: number, name: string, ms: number }[]} 按管道层级归段的耗时 */
    this.segments = []
    /** @type {{ name: string, ms: number }[]} 下游中间件自愿上报的细分段 */
    this.stages = []
    this.totalMs = 0
    this.selfMs = 0
    this.downstreamMs = 0
    /** 回溯到本层的异常条数（Phase 0 语义：一轮最多一条） */
    this.errors = 0
    /** 出错层级：沿 originalCause 找到的最内层 PipelineError.index；无法归层为 -1 */
    this.errorLayer = -1
    /** 最近一次错误的消息摘要（仅用于打点定位，不参与任何流程判断） */
    this.errorMessage = ''
    this.aborted = false
  }

  /**
   * 计时一个业务阶段并归段。异常原样上抛、不计错误（计数交给最外层回溯，避免重复计数）。
   * @param {string} name 段名，例如 'legacy-hub' / 'llm'
   * @param {() => any} fn 阶段本体，允许返回 Promise
   * @returns {Promise<any>} fn 的返回值
   */
  async stage(name, fn) {
    const t0 = this.#now()
    try {
      return await fn()
    } finally {
      this.stages.push({ name: safeName(name), ms: round3(this.#now() - t0) })
    }
  }
}

/**
 * 取回本轮 trace 记录；未装 tracing 中间件时返回 undefined。
 * @param {any} ctx
 * @returns {TraceRecord | undefined}
 */
export function getTrace(ctx) {
  return typeof ctx?.state?.get === 'function' ? ctx.state.get(TRACE_KEY) : undefined
}

/**
 * 下游中间件的自助打点：无 tracing 中间件时退化为直接执行 fn，绝不因此炸链路。
 * @param {any} ctx
 * @param {string} name 段名
 * @param {() => any} fn 阶段本体
 * @returns {Promise<any>}
 */
export async function traceStage(ctx, name, fn) {
  const trace = getTrace(ctx)
  if (!trace) return await fn()
  return trace.stage(name, fn)
}

/**
 * 沿 PipelineError 的 originalCause 链一次走完，同时取到：
 *   - layer：最内层 index（真正出错的层级；链上每层 wrap 的 index 由外向内递减）；
 *   - message：根因错误文本，排障直接看最内层原因。
 * 用鸭子类型读取兼容错误链，不依赖具体管道实现。
 * @param {any} error
 * @returns {{ layer: number, message: string }}
 */
function describeError(error) {
  let layer = -1
  let root = error
  let e = error
  while (e && e.name === 'PipelineError') {
    if (typeof e.index === 'number') layer = e.index
    if (e.originalCause) root = e.originalCause
    e = e.originalCause
  }
  return { layer, message: String(root?.message ?? root ?? 'unknown') }
}

/**
 * 渲染单行打点：`trace <traceId8> total=.. mw0=.. mw1=.. [段=..] err=.. [at=mwN] [msg=..] [aborted=1]`
 * @param {TraceRecord} trace
 * @returns {string}
 */
export function formatTraceLine(trace) {
  const parts = [`trace ${String(trace.traceId).slice(0, 8)}`, `total=${fmtMs(trace.totalMs)}`]
  for (const seg of trace.segments) parts.push(`mw${seg.index}=${fmtMs(seg.ms)}`)
  for (const st of trace.stages) parts.push(`${st.name}=${fmtMs(st.ms)}`)
  parts.push(`err=${trace.errors}`)
  if (trace.errorLayer >= 0) parts.push(`at=mw${trace.errorLayer}`)
  if (trace.errorMessage) parts.push(`msg='${String(trace.errorMessage).replace(/[\r\n]+/g, ' ')}'`)
  if (trace.aborted) parts.push('aborted=1')
  return parts.join(' ')
}

/**
 * 创建 tracing 中间件（放在 compose 数组第 0 项即成为管道最外层）。
 *
 * @param {object} [options]
 * @param {{ debug?: (msg: string) => void }} [options.log] core/logger.js child 形态的日志出口，缺省静默
 * @param {() => number} [options.now] 计时源，缺省 performance.now（测试注入假时钟）
 * @returns {import('./types.js').Middleware}
 */
export function createTracingMiddleware(options = {}) {
  const log = options.log
  const now = typeof options.now === 'function' ? options.now : () => performance.now()

  function emit(trace) {
    // 打点失败绝不能把业务带崩：日志出口异常就地吃掉
    try {
      log?.debug?.(formatTraceLine(trace))
    } catch (error) {}
  }

  return async function tracingMiddleware(ctx, next) {
    const trace = new TraceRecord(now, ctx?.meta)
    if (typeof ctx?.state?.set === 'function') ctx.state.set(TRACE_KEY, trace)

    const tEnter = now()
    const tDownIn = now()
    let failure = null
    try {
      await next()
    } catch (error) {
      // 计数 + 归层 + 根因文本，然后原样上抛：本中间件只观测，不解释、不吞、不二次包装
      trace.errors += 1
      const info = describeError(error)
      trace.errorLayer = info.layer
      trace.errorMessage = info.message.slice(0, 160)
      failure = error // 只暂存：先出打点，再原样上抛
    }
    const tDownOut = now()
    if (ctx?.signal?.aborted) trace.aborted = true
    const tExit = now()

    trace.downstreamMs = round3(tDownOut - tDownIn)
    trace.totalMs = round3(tExit - tEnter)
    trace.selfMs = round3(trace.totalMs - trace.downstreamMs)
    // mw0 = 本层簿记开销，mw1 = 下游整段（第 1..N 层合计；Phase 0 只有遗留终端一层，即终端耗时）
    trace.segments.push(
      { index: 0, name: 'tracing', ms: trace.selfMs },
      { index: 1, name: 'downstream', ms: trace.downstreamMs },
    )
    emit(trace)
    if (failure) throw failure
  }
}
