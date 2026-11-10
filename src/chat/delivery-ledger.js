// M2-D · Delivery Ledger：投递台账（纯模块，持久化 + 崩溃恢复）
//
// 语义（任务书 M2-D + ADR-0001 §3）：
//   - 每条投递一份台账记录：deliveryId、chatKey、turnId?、sourceModuleId、状态、尝试次数、
//     网关真实 messageId（只能来自回执，绝不伪造）；
//   - 崩溃恢复：落盘时处于 sending 的条目恢复为 **unknown**（副作用可能已发生），
//     **绝不自动重发**——由调用方按显式策略处理；
//   - 已 sent 的条目永不重放；unknown 有审计（unknownAt 原因）；
//   - 状态机与 ADR 六态一致：queued/sending/sent/failed/unknown/cancelled。

import { createHash } from 'node:crypto'
import { readJsonWithBackup, writeJsonWithBackup } from '../core/store.js'
import { assertDelivery, CONTRACT_VERSION } from '../kernel/modular-contracts.js'

const LEDGER_VERSION = 1
const STATES = new Set(['queued', 'sending', 'sent', 'failed', 'unknown', 'cancelled'])
const CONTENT_RETENTION_MS = 7 * 86400_000
const CONTENT_KEEP_CHARS = 200
const ENQUEUE_CONTENT_KEEP_CHARS = 2048
const DEFAULT_MAX_RECORDS = 2000

function auditSegments(input) {
  const segments = (input ?? []).map((s) => ({ type: String(s?.type ?? ''), data: { ...(s?.data ?? {}) } }))
  let contentChars = 0
  let remaining = ENQUEUE_CONTENT_KEEP_CHARS
  let contentTruncated = false
  for (const seg of segments) {
    for (const key of ['file', 'url', 'base64']) {
      const value = seg.data[key]
      if (typeof value !== 'string') continue
      const encoded = key === 'base64' ? value
        : value.startsWith('base64://') ? value.slice(9)
        : /^data:[^,]*;base64,/i.test(value) ? value.slice(value.indexOf(',') + 1) : ''
      if (!encoded) continue
      const bytes = Buffer.from(encoded, 'base64')
      seg.data.mediaDigest = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, encoding: 'base64' }
      delete seg.data[key]
      contentTruncated = true
    }
    if (seg.type !== 'text' || typeof seg.data.text !== 'string') continue
    const text = seg.data.text
    contentChars += text.length
    const kept = text.slice(0, Math.max(0, remaining))
    remaining -= kept.length
    if (kept.length !== text.length) {
      seg.data.text = kept
      contentTruncated = true
    }
  }
  return { segments, contentChars, contentTruncated }
}

function trimTerminalContent(rec, now) {
  if (!['sent', 'cancelled'].includes(rec.state) || rec.contentTruncated) return rec
  const createdAt = Number(rec.createdAt)
  if (!Number.isFinite(createdAt) || now - createdAt < CONTENT_RETENTION_MS) return rec
  let remaining = CONTENT_KEEP_CHARS
  let originalChars = 0
  let changed = false
  const segments = (rec.segments || []).map((seg) => {
    if (seg?.type !== 'text' || typeof seg.data?.text !== 'string') return seg
    const text = seg.data.text
    originalChars += text.length
    if (remaining <= 0 && text.length) {
      changed = true
      return { ...seg, data: { ...seg.data, text: '' } }
    }
    const kept = text.slice(0, remaining)
    remaining -= kept.length
    if (kept.length !== text.length) changed = true
    return changed ? { ...seg, data: { ...seg.data, text: kept } } : seg
  })
  if (!changed) return rec
  return { ...rec, segments, contentTruncated: true, contentOriginalChars: originalChars }
}

function validLedgerDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value.version !== undefined && value.version !== LEDGER_VERSION)
    || !Array.isArray(value.deliveries)) return false
  const ids = new Set()
  for (const rec of value.deliveries) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)
      || !rec.deliveryId || !STATES.has(rec.state)
      || (rec.segments !== undefined && (!Array.isArray(rec.segments)
        || rec.segments.some((segment) => !segment || typeof segment !== 'object' || Array.isArray(segment))))) return false
    const id = String(rec.deliveryId)
    if (ids.has(id)) return false
    ids.add(id)
  }
  return true
}

let seq = 0

/**
 * 内存台账 + 可选文件持久化。
 * @param {object} o
 * @param {string} [o.file] 台账文件路径（缺省 = 纯内存）
 * @param {(error: Error) => void} [o.onError] 持久化错误出口
 */
export function createDeliveryLedger({ file, onError = (error) => console.warn(error.message), maxRecords = DEFAULT_MAX_RECORDS } = {}) {
  const options = { validate: validLedgerDocument, label: '投递台账', onError }
  /** deliveryId -> record */
  const records = new Map()
  const limit = Math.max(1, Math.floor(Number(maxRecords) || DEFAULT_MAX_RECORDS))
  let crashedSending = 0
  let recovered = false

  function prune() {
    let removed = 0
    while (records.size > limit) {
      const oldest = [...records.values()].find((rec) => rec.state === 'sent' || rec.state === 'cancelled')
      if (!oldest) break
      records.delete(oldest.deliveryId)
      removed++
    }
    return removed
  }

  if (file) {
    try {
      const loaded = readJsonWithBackup(file, { ...options, fallback: () => ({ version: LEDGER_VERSION, deliveries: [] }), repairPrimary: false })
      if (loaded.fromBackup) recovered = true
      for (const rec of loaded.value.deliveries) {
        if (rec.state === 'sending') {
          // 崩溃恢复红线：sending → unknown（副作用可能已发生），留审计原因，绝不重发
          rec.state = 'unknown'
          rec.unknownAt = rec.unknownAt || Date.now()
          rec.unknownReason = rec.unknownReason || 'crash-recovery: 落盘时处于 sending，副作用未知'
          rec.recoveredAt = Date.now()
          crashedSending++
          recovered = true
        } else if (loaded.fromBackup && ['queued', 'failed', 'cancelled'].includes(rec.state)) {
          const previous = rec.state
          rec.state = 'unknown'
          rec.unknownAt = rec.unknownAt || Date.now()
          rec.unknownReason = `backup-recovery: 备份可能落后（原状态 ${previous}），副作用未知`
          rec.recoveredAt = Date.now()
          recovered = true
        } else if (rec.state === 'queued') {
          // 已登记但还没开始物理发送：标 cancelled，不恢复队列、不自动重发。
          rec.state = 'cancelled'
          rec.cancelReason = 'crash-recovery: 崩溃前仍未出队，未恢复发送'
          rec.recoveredAt = Date.now()
          recovered = true
        }
        if (rec.state === 'sent' || rec.state === 'cancelled') {
          const audit = auditSegments(rec.segments)
          if (rec.contentChars === undefined) rec.contentChars = audit.contentChars
          if (audit.contentTruncated) {
            rec.segments = audit.segments
            rec.contentTruncated = true
            recovered = true
          }
        }
        records.set(String(rec.deliveryId), rec)
      }
      if (prune() > 0) recovered = true
      if (recovered) persist()
    } catch (error) {
      if (error?.code !== 'ENOENT') onError(error) // 首次无文件 = 正常
    }
  }

  /**
   * 落盘。critical=true（queued/sending 关键迁移）时失败必须 **fail-closed**：
   * 抛错让调用方中止——没有台账凭据就不许发生物理副作用。
   * 非关键（终态）写入失败只报告：副作用已发生，回滚状态反而是谎。
   */
  function persist({ critical = false } = {}) {
    if (!file) return
    try {
      const now = Date.now()
      for (const [id, rec] of records) {
        const trimmed = trimTerminalContent(rec, now)
        if (trimmed !== rec) records.set(id, trimmed)
      }
      writeJsonWithBackup(file, {
        version: LEDGER_VERSION,
        savedAt: now,
        deliveries: [...records.values()],
      }, options)
    } catch (error) {
      onError(error)
      if (critical) throw new Error(`台账落盘失败（fail-closed）：${error?.message || error}`, { cause: error })
    }
  }

  /**
   * 登记一条新投递（queued 态）。重复 deliveryId 拒绝（幂等保护：调用方重试须换新 ID）。
   * @returns {Readonly<object>} 台账记录副本
   */
  function enqueue({ deliveryId, chatKey, turnId, sourceModuleId, segments, note, action }) {
    if (!deliveryId) throw new TypeError('deliveryId 必填')
    if (records.has(String(deliveryId))) {
      throw new Error(`deliveryId 重复：${deliveryId}（已存在记录，不覆盖）`)
    }
    const audit = auditSegments(segments)
    const record = {
      contractVersion: CONTRACT_VERSION,
      deliveryId: String(deliveryId),
      chatKey: String(chatKey),
      ...(turnId ? { turnId: String(turnId) } : {}),
      sourceModuleId: String(sourceModuleId || 'core'),
      state: 'queued',
      attemptCount: 0,
      segments: audit.segments,
      contentChars: audit.contentChars,
      ...(audit.contentTruncated ? { contentTruncated: true } : {}),
      // PR-1 直通投递：审计可读的备注与动作名（msg 模式 action 缺省 = send_*_msg 由 chatKey 推）
      ...(note ? { note: String(note) } : {}),
      ...(action ? { action: String(action) } : {}),
      gatewayMessageId: undefined,
      createdAt: Date.now(),
    }
    assertDelivery({ ...record, segments: record.segments.map((s) => ({ type: s.type, data: s.data })) })
    records.set(record.deliveryId, record)
    prune()
    // queued 是关键落盘：失败回滚并抛出（fail-closed，调用方中止发送）
    try {
      persist({ critical: true })
    } catch (error) {
      records.delete(record.deliveryId)
      throw error
    }
    return { ...record }
  }

  /** 状态迁移（合法六态 + 方向校验）；sent 条目不许再变（防重放）。 */
  function mark(deliveryId, state, { gatewayMessageId, reason } = {}) {
    const rec = records.get(String(deliveryId))
    if (!rec) throw new Error(`台账没有这条投递：${deliveryId}`)
    if (!STATES.has(state)) throw new TypeError(`未知投递状态：${state}`)
    if (rec.state === 'sent' && state !== 'sent') {
      throw new Error(`已 sent 的投递不许再变更（防重放）：${deliveryId} → ${state}`)
    }
    if (state === 'sent') {
      // msg 投递的 sent 必须携带网关真实回执；直通动作由 outbox 的 receipt 策略先行判定。
      if (!rec.action && (gatewayMessageId == null || gatewayMessageId === '')) {
        throw new TypeError('sent 必须带网关真实 messageId（不冒充回执）')
      }
      if (gatewayMessageId !== undefined && gatewayMessageId === '') {
        throw new TypeError('gatewayMessageId 不得为空串')
      }
    }
    const prevState = rec.state
    rec.state = state
    // attemptCount 只统计真实物理发送尝试：进入 sending 一次 = 尝试一次（不是状态迁移次数）
    if (state === 'sending') rec.attemptCount++
    if (gatewayMessageId !== undefined && gatewayMessageId !== '') {
      rec.gatewayMessageId = String(gatewayMessageId) // 失败但网关曾回执（如 unknown 后对账）也如实记
    }
    if (state === 'unknown') {
      rec.unknownAt = Date.now()
      rec.unknownReason = String(reason || '未知原因')
    }
    if (state === 'failed') rec.failReason = String(reason || '')
    // 真机内测报告：cancelled 此前什么都不记——dryRun/撤权/身份闸/总开关的拒绝原因在台账里看不见，审计断言无法闭环
    if (state === 'cancelled') rec.cancelReason = String(reason || '')
    // sending 是关键落盘（物理发送前的凭据）：失败回滚状态并抛出，outbox 据此不发起发送
    try {
      persist({ critical: state === 'sending' })
    } catch (error) {
      rec.state = prevState
      if (state === 'sending') rec.attemptCount--
      throw error
    }
    return { ...rec }
  }

  /** 只读视图。 */
  function get(deliveryId) {
    const rec = records.get(String(deliveryId))
    return rec ? { ...rec } : null
  }

  /** 按 ChatKey 的 FIFO 顺序视图（发送方按序取队列）。 */
  function queuedFor(chatKey) {
    return [...records.values()]
      .filter((r) => r.chatKey === chatKey && r.state === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => ({ ...r }))
  }

  /** 审计视图：所有 unknown 条目（含崩溃恢复的）。 */
  function unknowns() {
    return [...records.values()].filter((r) => r.state === 'unknown').map((r) => ({ ...r }))
  }

  /** 统计（面板/测试）。 */
  function stats() {
    const byState = {}
    for (const r of records.values()) byState[r.state] = (byState[r.state] || 0) + 1
    return { total: records.size, byState, crashedSending }
  }

  return { enqueue, mark, get, queuedFor, unknowns, stats }
}

/** 生成投递 ID（调用方也可自带业务 ID；幂等键由调用方决定）。 */
export function newDeliveryId() {
  return `dlv-${Date.now().toString(36)}-${++seq}-${Math.random().toString(36).slice(2, 8)}`
}
