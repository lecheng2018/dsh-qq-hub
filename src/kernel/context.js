// Context 运行时构造工厂（RFC-0001 §3.3）。
//
// 中间件之间唯一的通信介质：
//   - meta：基础设施元数据，构造即冻结；
//   - inbound：物理入站信封，由驱动层构造时保证只读，这里原样引用（rawPayload
//     保留对原事件的引用是**有意契约**：legacy 终端与 backfill 记账靠对象同一性；
//     深拷贝/深冻结 rawPayload 会破坏该契约，review A2 该项按设计取舍处理，
//     信封壳与 segments 的冻结由驱动层（legacyEventToEnvelope）负责）；
//   - reply：出站缓冲池（OutputReplyQueue 语义），enqueue 深拷贝并逐层冻结
//     （review A2 P1：旧版只冻数组容器，段对象可被外部偷改）；queue getter
//     返回冻结快照，不再暴露内部数组；
//   - state：Map 承载的派生数据容器，symbol/string 键天然隔离；
//   - signal/abort：统一取消语义，供 compose 短路未执行的中间件。

import crypto from 'node:crypto'

/** 上下文状态容器：支持基于 Symbol 或 Key 的隔离存储。 */
class ContextStateImpl {
  #store = new Map()

  get(key) {
    return this.#store.get(key)
  }

  set(key, value) {
    this.#store.set(key, value)
    return this
  }

  has(key) {
    return this.#store.has(key)
  }

  delete(key) {
    return this.#store.delete(key)
  }

  /** 返回快照副本：外部改动不会回写原容器。 */
  toMap() {
    return new Map(this.#store)
  }
}

/**
 * 深拷贝并冻结纯数据值；无法结构化克隆的值保留原引用但冻结其所经容器。
 * @param {any} value
 * @returns {any}
 */
function deepImmutableCopy(value) {
  if (value === null || typeof value !== 'object') return value
  try {
    const clone = structuredClone(value)
    return freezeDeep(clone)
  } catch {
    // 函数/类实例/循环引用：不克隆，就地冻结容器层（元素引用不可变仍由产出方负责）
    return freezeDeep(value, { stopAtFirstNonPlain: true })
  }
}

/** 递归冻结；stopAtFirstNonPlain 时只冻本层及普通对象/数组链，不深越非纯数据。 */
function freezeDeep(value, opts = {}) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  if (Array.isArray(value)) {
    for (const v of value) if (!opts.stopAtFirstNonPlain || typeof v === 'object') freezeDeep(v, opts)
    return Object.freeze(value)
  }
  const proto = Object.getPrototypeOf(value)
  if (proto === Object.prototype || proto === null) {
    for (const k of Object.keys(value)) if (!opts.stopAtFirstNonPlain || typeof value[k] === 'object') freezeDeep(value[k], opts)
    return Object.freeze(value)
  }
  return value // 类实例不代冻
}

/** 出站回复缓冲池：条目入队即冻结，杜绝后置中间件偷改已发内容。 */
class OutputReplyQueueImpl {
  #queue = []

  /** 只读快照（review A2：旧版返回内部数组引用，push/splice/length=0 可绕过冻结）。 */
  get queue() {
    return Object.freeze(this.#queue.slice())
  }

  /**
   * 入队：自动生成 id 与 createdAt；segments 深拷贝并逐层冻结（纯数据段），
   * 非纯数据值（函数/类实例等 structuredClone 拒收的东西）保留引用但冻结容器，
   * 并在开发环境留一行 debug——对齐 review A2「显式 DTO 优于泛化冻结」。
   * @param {Omit<import('./types.js').ReplyPayload, 'id' | 'createdAt'>} payload
   */
  enqueue(payload) {
    const frozenSegments = (payload.segments || []).map((seg) => deepImmutableCopy(seg))
    const item = Object.freeze({
      ...payload,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      segments: Object.freeze(frozenSegments),
    })
    this.#queue.push(item)
  }

  /**
   * 把一批**已冻结的既存条目**放回队首（dispatcher 调度故障时的 deferred 归还，
   * review A4#3：不许重发已成功项、也不许吞掉未尝试项）。保持原 id/createdAt/顺序。
   * @param {any[]} items
   */
  restoreFront(items) {
    if (Array.isArray(items) && items.length) this.#queue.unshift(...items)
  }

  /**
   * 截回指定长度（命令路由 handler 抛错的回滚位：review A2 快照化后外部不能再
   * `queue.length = n` 偷改内部数组，正规 API 走这里）。非法/越界静默忽略。
   * @param {number} length
   */
  rollbackTo(length) {
    if (Number.isInteger(length) && length >= 0 && length < this.#queue.length) this.#queue.length = length
  }

  clear() {
    this.#queue.length = 0
  }

  isEmpty() {
    return this.#queue.length === 0
  }
}

/**
 * Context 实例化工厂。
 *
 * @param {import('./types.js').InboundEnvelope} envelope 驱动层归一化出的只读信封
 * @param {string} driverId 产出该信封的驱动标识
 * @param {string} [parentTraceId] 上游透传的链路 id；缺省时新起一条 trace
 * @param {{ signal?: AbortSignal }} [options] 上游取消信号透传（review A2 P1：
 *   HTTP 断开/任务超时必须能取消本轮 Context）；父信号已 abort 则新 ctx 出生即 abort，
 *   父信号后续 abort 会转发进来；本地 abort 时卸载转发监听（不留闭包在长命信号上）。
 * @returns {import('./types.js').Context}
 */
export function createContext(envelope, driverId, parentTraceId, options = {}) {
  const abortController = new AbortController()
  const parentSignal = options?.signal
  const traceId = parentTraceId ?? crypto.randomUUID()
  const spanId = crypto.randomBytes(8).toString('hex')

  const meta = Object.freeze({
    traceId,
    spanId,
    receivedAt: Date.now(),
    driverId,
  })

  const ctx = {
    meta,
    inbound: envelope,
    reply: new OutputReplyQueueImpl(),
    state: new ContextStateImpl(),
    get signal() {
      return abortController.signal
    },
    abort(reason) {
      if (parentSignal) {
        try { parentSignal.removeEventListener('abort', forwardParentAbort) } catch { /* 非标准信号容忍 */ }
      }
      abortController.abort(reason)
    },
  }

  function forwardParentAbort() {
    // 重复 abort 无副作用（AbortController 幂等）；reason 取父信号的首次 reason
    try { abortController.abort(parentSignal.reason) } catch { abortController.abort() }
  }
  if (parentSignal && typeof parentSignal.addEventListener === 'function') {
    if (parentSignal.aborted) forwardParentAbort()
    else parentSignal.addEventListener('abort', forwardParentAbort, { once: true })
  }
  return ctx
}
