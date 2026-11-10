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
 * @param {(action: string, params: object, opts?: object) => Promise<{messageId?: string, raw?: object}>} o.send
 *   物理发送注入点；抛错时 error.unknown === true 表示副作用未知。
 * @param {object} [o.ledger] 已有台账（缺省自建内存台账）
 * @param {(delivery: object) => Promise<boolean>} [o.authorize] 授权复核（缺省全放行；出队时执行）
 * @param {() => boolean} [o.dryRun] 全局试运行注入（出队时动态读取；true = 只记台账不实发）
 * @param {() => boolean} [o.enabled] 全局总开关注入（出队时动态读取；false = 不发）
 * @param {(delivery: object) => {ok: boolean, message?: string}} [o.guard] 身份泄露闸注入
 */
export function createOutbox({ send, ledger, authorize, dryRun, enabled, guard } = {}) {
  if (typeof send !== 'function') throw new TypeError('send 必须是函数')
  const book = ledger || createDeliveryLedger({})
  /** chatKey -> Promise（发送串行链，保证每聊天 FIFO） */
  const chains = new Map()
  /** 还没出队的 deliveryId（dispose 清理对象） */
  const pending = new Set()
  /** PR-1 直通模式登记：deliveryId -> {action, params, opts, receipt} */
  const passMap = new Map()
  let disposed = false

  /**
   * 请求发送（模块/核心统一入口）。
   * 消息模式使用 segments；直通模式使用 action + params + opts + receipt。
   * receipt=required 时无 messageId 必须记 unknown；optional 用于 upload/poke/qzone 等动作。
   */
  async function request(req) {
    if (disposed) throw new Error('outbox 已卸载')
    const chatKey = String(req?.chatKey ?? '')
    parseChatKey(chatKey)
    const passThrough = Boolean(req?.action)
    const segments = req?.segments ?? []
    if (!passThrough && (!Array.isArray(segments) || segments.length === 0)) {
      throw new TypeError('segments 必须是非空数组')
    }
    if (passThrough && (!req.params || typeof req.params !== 'object')) {
      throw new TypeError('直通模式必须提供 params')
    }
    const deliveryId = String(req?.deliveryId || newDeliveryId())
    if (passThrough) passMap.set(deliveryId, { action: req.action, params: req.params, opts: req.opts, receipt: req.receipt || 'required' })
    // 同步登记台账：FIFO 顺序 = enqueue 顺序（台账落盘失败 fail-closed 直接抛出，不发送）
    const rec = book.enqueue({
      deliveryId,
      chatKey,
      turnId: req?.turnId,
      sourceModuleId: req?.sourceModuleId,
      segments,
      note: req.note,
      action: passThrough ? req.action : undefined,
    })

    // 按次试运行：调用方显式语义，不排队（无 await 在 enqueue 与链注册之间插入任何东西）
    if (req?.dryRun === true) {
      book.mark(deliveryId, 'cancelled', { reason: 'dryRun' })
      return { state: 'cancelled', deliveryId, reason: 'dryRun' }
    }

    // 每聊天 FIFO：链注册同步发生，慢授权不会被后入队的快授权超车。
    const prev = chains.get(chatKey) || Promise.resolve()
    const chain = prev.catch(() => {}).then(() => drainOne(rec, req))
    chains.set(chatKey, chain)
    pending.add(deliveryId)
    const cleanup = () => {
      pending.delete(deliveryId)
      if (chains.get(chatKey) === chain) chains.delete(chatKey)
    }
    chain.then(cleanup, cleanup)
    return chain
  }

  /** 出队处理：台账复核 → 全局闸 → 授权（再复核台账）→ 身份闸 → sending 落盘 → 物理发送。 */
  async function drainOne(rec, req) {
    const { deliveryId, chatKey } = rec
    const force = req?.force === true

    let current = book.get(deliveryId)
    if (!current || current.state !== 'queued') {
      return { state: current?.state ?? 'cancelled', deliveryId, reason: '排队期间台账已变更（取消 / 重复请求）' }
    }

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

    const passInfo = passMap.get(deliveryId)
    const view = () => ({ ...current, action: passInfo?.action, params: passInfo?.params, note: current.note })

    if (authorize) {
      let ok = false
      try {
        ok = await authorize(view())
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

    if (guard && !force) {
      try {
        const g = guard(view())
        if (g && g.ok === false) {
          book.mark(deliveryId, 'cancelled', { reason: `身份泄露闸：${g.message || ''}` })
          return { state: 'cancelled', deliveryId, reason: '身份泄露闸' }
        }
      } catch { /* 闸本身出错：legacy 同语义放行 */ }
    }

    // 标记 sending：关键落盘失败时不发起物理发送。
    try {
      book.mark(deliveryId, 'sending')
    } catch (error) {
      return { state: 'failed', deliveryId, reason: `台账 sending 落盘失败，fail-closed 未实发：${error?.message || error}` }
    }
    const pass = passMap.get(deliveryId)
    let action, params, opts, receipt
    if (pass) {
      action = pass.action; params = pass.params; opts = pass.opts; receipt = pass.receipt
    } else {
      const parsed = parseChatKey(chatKey)
      action = parsed.kind === 'group' ? 'send_group_msg' : 'send_private_msg'
      params = parsed.kind === 'group'
        ? { group_id: Number(parsed.id), message: req.segments }
        : { user_id: Number(parsed.id), message: req.segments }
      receipt = 'required'
    }
    try {
      const result = await send(action, params, opts)
      if (receipt !== 'optional' && (result?.messageId == null || result.messageId === '')) {
        book.mark(deliveryId, 'unknown', { reason: '发送调用无异常但网关未回 messageId，不冒充 sent' })
        return { state: 'unknown', deliveryId, reason: '网关未回 messageId' }
      }
      book.mark(deliveryId, 'sent', result?.messageId != null && result.messageId !== '' ? { gatewayMessageId: result.messageId } : {})
      return {
        state: 'sent',
        deliveryId,
        ...(result?.messageId != null && result.messageId !== '' ? { gatewayMessageId: String(result.messageId) } : {}),
        ...(result?.raw !== undefined ? { raw: result.raw } : {}),
      }
    } catch (error) {
      if (error?.unknown === true) {
        book.mark(deliveryId, 'unknown', { reason: String(error?.message || '发送结果未知') })
        return { state: 'unknown', deliveryId, reason: String(error?.message || '发送结果未知') }
      }
      book.mark(deliveryId, 'failed', { reason: String(error?.message || error) })
      return { state: 'failed', deliveryId, reason: String(error?.message || error) }
    }
  }

  /** 取消还在队列里的投递（已 sending/sent 的不可取消）。 */
  function cancel(deliveryId, reason = '调用方取消') {
    const rec = book.get(deliveryId)
    if (!rec) return { state: 'unknown-delivery' }
    if (rec.state === 'queued') {
      book.mark(deliveryId, 'cancelled', { reason })
      return { state: 'cancelled' }
    }
    return { state: rec.state, reason: `已 ${rec.state}，不可取消` }
  }

  /** 卸载：拒绝新请求；还在排队的条目全部落 cancelled。 */
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
    passMap.clear()
    chains.clear()
  }

  /** 外部 legacy 媒体管线的发送补账：不重发、不参与队列。 */
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
