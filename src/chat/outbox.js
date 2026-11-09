// M2-D · Outbox：统一投递出口（纯模块；sender 注入，fake/真实 OneBot 适配器都实现同一签名）
//
// 职责（任务书 M2-D）：
//   - 统一投递条目 + 每聊天 FIFO + 授权复核 + dryRun + 取消 + 真实回执 + unknown；
//   - 三态结果如实返回：sent（带网关真实 messageId）/ failed（确定没发出去）/ unknown（副作用未知）；
//   - **unknown 绝不自动重试**——重试条件必须有状态依据（ADR-0001 红线）；
//   - 崩溃恢复（sending → unknown）由 delivery-ledger 承担，本层尊重台账不重放。
//
// 2026-11-08 复核修复（报告 §4.2/§4.3/§4.4/§5）：
//   - FIFO：enqueue 与链注册之间**不引入任何 await**——授权挪到出队时执行，
//     慢授权不再被后入队的快授权超车；撤权发生在排队期间也能拦住（出队重查台账 + 重跑 authorize）。
//   - 全局闸：enabled/dryRun 在出队时刻动态复核（注入回调），不依赖入口或命令分支的一次性快照。
//   - 身份泄露闸：guard 注入回调在唯一出站点生效（同 legacy sendSegments 语义：force 豁免）。
//   - 台账 fail-closed：enqueue / sending 落盘失败 = 不发起物理发送。
//   - dispose：真实卸载——之后拒绝新请求，并把还在排队的条目落 cancelled。
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
 * @param {(delivery: object) => Promise<boolean>} [o.authorize] 授权复核（缺省全放行；出队时执行）
 * @param {() => boolean} [o.dryRun] 全局试运行注入（出队时动态读取；true = 只记台账不实发）
 * @param {() => boolean} [o.enabled] 全局总开关注入（出队时动态读取；false = 不发）
 * @param {(delivery: object) => {ok: boolean, message?: string}} [o.guard] 身份泄露闸注入
 *   （出队后、物理发送前执行；ok=false 拦下记 cancelled；req.force=true 时同 legacy 豁免）
 */
export function createOutbox({ send, ledger, authorize, dryRun, enabled, guard } = {}) {
  if (typeof send !== 'function') throw new TypeError('send 必须是函数')
  const book = ledger || createDeliveryLedger({})
  /** chatKey -> Promise（发送串行链，保证每聊天 FIFO） */
  const chains = new Map()
  /** 还没出队的 deliveryId（dispose 清理对象） */
  const pending = new Set()
  let disposed = false

  /**
   * 请求发送（模块/核心统一入口）。
   * @param {object} req
   * @param {string} req.chatKey
   * @param {string} [req.turnId]
   * @param {string} [req.sourceModuleId] 来源模块（审计用）
   * @param {Array<{type:string,data:object}>} req.segments
   * @param {string} [req.deliveryId] 幂等键（缺省生成）
   * @param {boolean} [req.dryRun] 按次试运行（调用方显式语义，立即记台账不实发）
   * @param {boolean} [req.force] 同 legacy force：豁免全局 enabled/dryRun/身份闸（授权仍执行）
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
    // 同步登记台账：FIFO 顺序 = enqueue 顺序（台账落盘失败 fail-closed 直接抛出，不发送）
    const rec = book.enqueue({
      deliveryId,
      chatKey,
      turnId: req?.turnId,
      sourceModuleId: req?.sourceModuleId,
      segments,
    })

    // 按次试运行：调用方显式语义，不排队（无 await 在 enqueue 与链注册之间插入任何东西）
    if (req?.dryRun === true) {
      book.mark(deliveryId, 'cancelled', { reason: 'dryRun' })
      return { state: 'cancelled', deliveryId, reason: 'dryRun' }
    }

    // 每聊天 FIFO：链式串行；授权 / 全局闸 / 身份闸都在**出队时**执行。
    // 关键：链注册（读取并覆盖 chains）本身同步发生在 enqueue 之后、无任何 await，
    // 保证同聊天两条请求按入队顺序挂链——慢授权不会被后入队的快授权超车。
    const prev = chains.get(chatKey) || Promise.resolve()
    const chain = prev.catch(() => {}).then(() => drainOne(rec, req))
    chains.set(chatKey, chain)
    pending.add(deliveryId)
    chain.finally(() => {
      pending.delete(deliveryId)
      if (chains.get(chatKey) === chain) chains.delete(chatKey)
    })
    return chain
  }

  /** 出队处理：台账复核 → 全局闸 → 授权（再复核台账）→ 身份闸 → sending 落盘 → 物理发送。 */
  async function drainOne(rec, req) {
    const { deliveryId, chatKey } = rec
    const force = req?.force === true

    // 出队复核一：排队期间被取消 / 台账已变 → 不发
    let current = book.get(deliveryId)
    if (!current || current.state !== 'queued') {
      return { state: current?.state ?? 'cancelled', deliveryId, reason: '排队期间台账已变更（取消 / 重复请求）' }
    }

    // 全局 enabled / dryRun：出队时刻动态读（面板随时可改；入口时刻快照不作数）。force 同 legacy 豁免。
    if (!force) {
      if (dryRun?.() === true) {
        book.mark(deliveryId, 'cancelled', { reason: 'dryRun' })
        return { state: 'cancelled', deliveryId, reason: 'dryRun' }
      }
      if (enabled && !enabled()) {
        book.mark(deliveryId, 'cancelled', { reason: '总开关关闭' })
        return { state: 'cancelled', deliveryId, reason: '总开关关闭' }
      }
    }

    // 授权复核：出队后、标记 sending 前执行（撤权在排队期间发生也能拦住）。
    // authorize 内部有 await：唤醒后必须再复核一次台账（排队期间可能已被 cancel）。
    if (authorize) {
      let ok = false
      try {
        ok = await authorize({ ...current, segments: current.segments })
      } catch {
        ok = false
      }
      if (!ok) {
        book.mark(deliveryId, 'cancelled', { reason: 'authorize 拒绝' })
        return { state: 'cancelled', deliveryId, reason: 'authorize 拒绝' }
      }
      current = book.get(deliveryId)
      if (!current || current.state !== 'queued') {
        return { state: current?.state ?? 'cancelled', deliveryId, reason: '授权期间台账已变更（取消）' }
      }
    }

    // 身份泄露闸（唯一出站点；同 legacy：force 豁免；闸自身异常放行不误伤，legacy 同语义）。
    if (guard && !force) {
      try {
        const g = guard(current)
        if (g && g.ok === false) {
          book.mark(deliveryId, 'cancelled', { reason: `身份泄露闸：${g.message || ''}` })
          return { state: 'cancelled', deliveryId, reason: '身份泄露闸' }
        }
      } catch { /* 闸本身出错：legacy 同语义放行 */ }
    }

    // 标记 sending：关键落盘（fail-closed）——台账写不进去就不发起物理发送
    try {
      book.mark(deliveryId, 'sending')
    } catch (error) {
      return { state: 'failed', deliveryId, reason: `台账 sending 落盘失败，fail-closed 未实发：${error?.message || error}` }
    }
    const parsed = parseChatKey(chatKey)
    const action = parsed.kind === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = parsed.kind === 'group'
      ? { group_id: Number(parsed.id), message: current.segments }
      : { user_id: Number(parsed.id), message: current.segments }
    try {
      const result = await send(action, params)
      // 红线：没有真实 messageId 的「成功」不是 sent——诚实降级为 unknown（副作用未知）
      if (result?.messageId == null || result.messageId === '') {
        book.mark(deliveryId, 'unknown', { reason: '发送调用无异常但网关未回 messageId，不冒充 sent' })
        return { state: 'unknown', deliveryId, reason: '网关未回 messageId' }
      }
      book.mark(deliveryId, 'sent', { gatewayMessageId: result.messageId })
      return { state: 'sent', deliveryId, gatewayMessageId: String(result.messageId) }
    } catch (error) {
      if (error?.unknown === true) {
        // 副作用可能已发生：绝不重试、绝不降级 failed（重发=重复消息）
        book.mark(deliveryId, 'unknown', { reason: String(error?.message || '发送结果未知') })
        return { state: 'unknown', deliveryId, reason: String(error?.message || '发送结果未知') }
      }
      book.mark(deliveryId, 'failed', { reason: String(error?.message || error) })
      return { state: 'failed', deliveryId, reason: String(error?.message || error) }
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

  /** 卸载：拒绝新请求；还在排队的条目全部落 cancelled（链上的 drainOne 出队复核会跳过发送）。 */
  function dispose() {
    if (disposed) return
    disposed = true
    for (const deliveryId of [...pending]) {
      try {
        const rec = book.get(deliveryId)
        if (rec && rec.state === 'queued') book.mark(deliveryId, 'cancelled', { reason: 'outbox 已卸载' })
      } catch { /* 单条清理失败不阻断卸载 */ }
    }
    pending.clear()
    chains.clear()
  }

  /**
   * 外部发送记账（真机审计 §2 收口的 B 方案）：语音/文件这类必须走 legacy 上载管线的发送，
   * 发成功后补一条台账，保证「台账覆盖全部出站」。不重发、不参与队列。
   * @returns {string|null} 台账 deliveryId
   */
  function recordExternal({ chatKey, sourceModuleId, segments, gatewayMessageId, state = 'sent', reason } = {}) {
    if (!ledger) return null
    const id = newDeliveryId()
    ledger.enqueue({ deliveryId: id, chatKey: String(chatKey), sourceModuleId: String(sourceModuleId || 'module'), segments: segments || [] })
    ledger.mark(id, 'sending')
    if (state === 'sent' && gatewayMessageId != null && gatewayMessageId !== '') {
      ledger.mark(id, 'sent', { gatewayMessageId: String(gatewayMessageId) })
    } else {
      ledger.mark(id, 'unknown', { reason: reason || 'external: 网关没回执' })
    }
    return id
  }

  return { request, cancel, dispose, recordExternal, ledger: book }
}
