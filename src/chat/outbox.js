// M2-D · Outbox：统一投递出口（纯模块；sender 注入，fake/真实 OneBot 适配器都实现同一签名）
//
// 职责（任务书 M2-D）：
//   - 统一投递条目 + 每聊天 FIFO + 授权复核 + dryRun + 取消 + 真实回执 + unknown；
//   - 三态结果如实返回：sent（带网关真实 messageId）/ failed（确定没发出去）/ unknown（副作用未知）；
//   - **unknown 绝不自动重试**——重试条件必须有状态依据（ADR-0001 红线）；
//   - 崩溃恢复（sending → unknown）由 delivery-ledger 承担，本层尊重台账不重放。
//
// 红线：本模块不做业务决策（不发主动发言、不改内容）；内容清洗/分条是适配层（M3-C）的事。

import { parseChatKey } from './chat-key.js'
import { createDeliveryLedger, newDeliveryId } from './delivery-ledger.js'

export { newDeliveryId }

/**
 * @param {object} o
 * @param {(action: string, params: object, opts?: object) => Promise<{messageId?: string}>} o.send
 *   物理发送注入点：send_group_msg / send_private_msg 二选一由 outbox 决定；
 *   返回 { messageId }（网关真实回执）；抛错时 error.unknown === true 表示副作用未知。
 * @param {object} [o.ledger] 已有台账（缺省自建内存台账）
 * @param {(delivery: object) => Promise<boolean>} [o.authorize] 授权复核（缺省全放行；M4 接 chat/access.js）
 * @param {() => boolean} [o.dryRun] 试运行注入（true = 只记台账不实发，状态记为 cancelled + dryRun 标记）
 */
export function createOutbox({ send, ledger, authorize, dryRun } = {}) {
  if (typeof send !== 'function') throw new TypeError('send 必须是函数')
  const book = ledger || createDeliveryLedger({})
  /** chatKey -> Promise（发送串行链，保证每聊天 FIFO） */
  const chains = new Map()
  let disposed = false

  /**
   * 请求发送（模块/核心统一入口）。
   * @param {object} req
   * @param {string} req.chatKey
   * @param {string} [req.turnId]
   * @param {string} [req.sourceModuleId] 来源模块（审计用）
   * @param {Array<{type:string,data:object}>} req.segments
   * @param {string} [req.deliveryId] 幂等键（缺省生成）
   * @returns {Promise<{state:'sent'|'failed'|'unknown'|'cancelled', deliveryId:string, gatewayMessageId?:string, reason?:string}>}
   */
  async function request(req) {
    if (disposed) throw new Error('outbox 已卸载')
    const chatKey = String(req?.chatKey ?? '')
    parseChatKey(chatKey)
    const segments = req?.segments
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new TypeError('segments 必须是非空数组')
    }
    const deliveryId = String(req?.deliveryId || newDeliveryId())
    const rec = book.enqueue({
      deliveryId,
      chatKey,
      turnId: req?.turnId,
      sourceModuleId: req?.sourceModuleId,
      segments,
    })

    // dryRun：记台账（cancelled + dryRun 标记）不实发——面板/测试可对账
    if (dryRun?.()) {
      book.mark(deliveryId, 'cancelled', { reason: 'dryRun' })
      rec.state = 'cancelled'
      return { state: 'cancelled', deliveryId, reason: 'dryRun' }
    }

    // 授权复核（排队期间权限可能变化，出队时再查一次——任务书「队列中权限变化」场景）
    if (authorize) {
      let ok = false
      try {
        ok = await authorize({ ...rec, segments })
      } catch (error) {
        ok = false
      }
      if (!ok) {
        book.mark(deliveryId, 'cancelled', { reason: 'authorize 拒绝' })
        return { state: 'cancelled', deliveryId, reason: 'authorize 拒绝' }
      }
    }

    // 每聊天 FIFO：串行链保证同聊天按入队顺序发送；不同聊天并行
    const prev = chains.get(chatKey) || Promise.resolve()
    const chain = prev.catch(() => {}).then(() => doSend(rec))
    chains.set(chatKey, chain)
    chain.finally(() => {
      if (chains.get(chatKey) === chain) chains.delete(chatKey)
    })
    return chain
  }

  async function doSend(rec) {
    // 出队复核：排队期间被取消/台账已变 → 不发
    const current = book.get(rec.deliveryId)
    if (!current || current.state !== 'queued') {
      return { state: current?.state ?? 'cancelled', deliveryId: rec.deliveryId, reason: '排队期间台账已变更（取消/重复请求）' }
    }
    book.mark(rec.deliveryId, 'sending')
    const isGroup = parseChatKey(rec.chatKey).kind === 'group'
    const idNum = parseChatKey(rec.chatKey).id
    const action = isGroup ? 'send_group_msg' : 'send_private_msg'
    const params = isGroup
      ? { group_id: Number(idNum), message: rec.segments }
      : { user_id: Number(idNum), message: rec.segments }
    try {
      const result = await send(action, params)
      // 红线：没有真实 messageId 的「成功」不是 sent——诚实降级为 unknown（副作用未知）
      if (result?.messageId == null || result.messageId === '') {
        book.mark(rec.deliveryId, 'unknown', { reason: '发送调用无异常但网关未回 messageId，不冒充 sent' })
        return { state: 'unknown', deliveryId: rec.deliveryId, reason: '网关未回 messageId' }
      }
      book.mark(rec.deliveryId, 'sent', { gatewayMessageId: result.messageId })
      return { state: 'sent', deliveryId: rec.deliveryId, gatewayMessageId: String(result.messageId) }
    } catch (error) {
      if (error?.unknown === true) {
        // 副作用可能已发生：绝不重试、绝不降级 failed（重发=重复消息）
        book.mark(rec.deliveryId, 'unknown', { reason: String(error?.message || '发送结果未知') })
        return { state: 'unknown', deliveryId: rec.deliveryId, reason: String(error?.message || '发送结果未知') }
      }
      book.mark(rec.deliveryId, 'failed', { reason: String(error?.message || error) })
      return { state: 'failed', deliveryId: rec.deliveryId, reason: String(error?.message || error) }
    }
  }

  /** 取消还在队列里的投递（已 sending/sent 的不可取消——副作用已发生或正在发生）。 */
  function cancel(deliveryId, reason = '调用方取消') {
    const rec = book.get(deliveryId)
    if (!rec) return { state: 'unknown-delivery' }
    if (rec.state === 'queued') {
      book.mark(deliveryId, 'cancelled', { reason })
      return { state: 'cancelled' }
    }
    return { state: rec.state, reason: `已 ${rec.state}，不可取消` }
  }

  return { request, cancel, ledger: book }
}
