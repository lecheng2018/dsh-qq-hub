// PR-1（ADR-0002）· Hub Egress：legacy hub 物理发送转进统一 Outbox 的适配层。
//
// 语义映射（保证 legacy 调用方零感知）：
//   - sent      → 返回网关 raw 回执（legacy 返回形状原样保留；台账已记）；
//   - cancelled → 返回 null（等同 legacy「试运行/总开关关着」没发的返回）；
//   - unknown   → 抛 error.unknown=true（M1-C 红线：调用方不得据此自动重试/改发）；
//   - failed    → 抛 error.unknown=false（确定没发出，legacy 重试/fallback 语义照常）。
// dryRun/enabled/身份闸/白名单在 outbox 出队时统一执行——flag 开时 legacy 出口从此
// 有 deliveryId、有台账、可试运行、过泄露闸；flag 关时本模块根本不接线（egressRef.current=null）。

export function createHubEgress({ outbox, log }) {
  const debug = (m) => { try { log?.debug?.(m) } catch {} }
  return {
    outbox,
    /**
     * @param {object} req
     * @param {string} req.action OneBot 动作（send_·_msg / upload_·_file / send_poke / send_qzone_msg / forward…）
     * @param {object} req.params 完整 RPC 参数（wire 形状由 hub 保证=legacy 等价）
     * @param {object} [req.opts] RPC 选项（timeoutMs/retries：legacy 语义透传）
     * @param {string} req.chatKey 目标会话（台账/闸/授权用）
     * @param {'required'|'optional'} [req.receipt] 回执要求（msg 类 required；upload/poke/qzone optional）
     * @param {string} [req.note] 台账备注
     * @param {string} [req.sourceModuleId]
     * @param {boolean} [req.force] legacy force：豁免全局闸（台账照记）
     */
    async deliver(req) {
      // 安全网：egress 只承载发信类动作（set_/delete_/handle_ 等管理操作若混进来被
      // receipt:'optional' 当成 sent 记账=风险洗白）。fail-closed 拒执行。
      if (!/^(send|upload)_/.test(String(req.action || ''))) {
        throw new TypeError(`egress 拒绝非发信动作：${req.action}（管理操作请直接 onebot.call）`)
      }
      const segments = Array.isArray(req.params?.message) ? req.params.message : []
      const r = await outbox.request({ ...req, segments })
      if (r.state === 'sent') {
        debug(`egress sent → ${req.chatKey} ${req.action || 'msg'}（delivery ${r.deliveryId}）`)
        return r.raw ?? { message_id: r.gatewayMessageId }
      }
      if (r.state === 'cancelled') return null
      if (r.state === 'unknown') {
        const e = new Error(r.reason || '发送结果未知（egress）')
        e.unknown = true
        throw e
      }
      const e = new Error(r.reason || `发送失败（egress）`)
      e.unknown = false
      throw e
    },
  }
}
