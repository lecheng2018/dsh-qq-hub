// Context 运行时构造工厂（RFC-0001 §3.3）。
//
// 中间件之间唯一的通信介质：
//   - meta：基础设施元数据，构造即冻结；
//   - inbound：物理入站信封，由驱动层构造时保证只读，这里原样引用；
//   - reply：出站缓冲池（OutputReplyQueue 语义），enqueue 条目连同 segments 一起冻结；
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

/** 出站回复缓冲池：条目入队即冻结，杜绝后置中间件偷改已发内容。 */
class OutputReplyQueueImpl {
  #queue = []

  get queue() {
    return this.#queue
  }

  /**
   * 入队：自动生成 id 与 createdAt，segments 拷贝一份后冻结。
   * @param {Omit<import('./types.js').ReplyPayload, 'id' | 'createdAt'>} payload
   */
  enqueue(payload) {
    const item = Object.freeze({
      ...payload,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      segments: Object.freeze([...payload.segments]),
    })
    this.#queue.push(item)
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
 * @returns {import('./types.js').Context}
 */
export function createContext(envelope, driverId, parentTraceId) {
  const abortController = new AbortController()
  const traceId = parentTraceId ?? crypto.randomUUID()
  const spanId = crypto.randomBytes(8).toString('hex')

  const meta = Object.freeze({
    traceId,
    spanId,
    receivedAt: Date.now(),
    driverId,
  })

  return {
    meta,
    inbound: envelope,
    reply: new OutputReplyQueueImpl(),
    state: new ContextStateImpl(),
    get signal() {
      return abortController.signal
    },
    abort(reason) {
      abortController.abort(reason)
    },
  }
}
