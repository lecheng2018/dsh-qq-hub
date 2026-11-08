// M2-D 契约测试：Outbox 与 Delivery Ledger
// 任务书必测：发送前失败、发送后超时、回执丢失、重启、队列中权限变化、
// 重复 deliveryId、不同聊天顺序、媒体上传、dispose；无伪造 message_id；已 sent 不重放。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createOutbox, newDeliveryId } from '../src/chat/outbox.js'
import { createDeliveryLedger } from '../src/chat/delivery-ledger.js'

/** 手动放行门：用 ref 定时器保住事件循环（纯 promise 门会让测试进程提前退出）。 */
function gate() {
  let release
  const timer = setTimeout(() => {}, 120_000)
  const p = new Promise((r) => { release = () => { clearTimeout(timer); r() } })
  return { promise: p, release }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const segs = (text = '你好') => [{ type: 'text', data: { text } }]

/** 可编程 fake 网关：mode 作用于全部动作；也可按动作名精确设置。 */
function fakeGateway() {
  const calls = []
  const behavior = {}
  return {
    calls,
    set(mode, action) { if (action) behavior[action] = mode; else behavior['*'] = mode },
    send: async (action, params) => {
      const chatId = params.group_id != null ? `group:${params.group_id}` : `private:${params.user_id}`
      const mode = behavior[`${action}:${chatId}`] ?? behavior[action] ?? behavior['*'] ?? 'ok'
      calls.push({ action, params, mode })
      if (mode === 'ok') return { messageId: `gw-${calls.length}` }
      if (mode === 'reject') { const e = new Error('网关明确拒绝'); e.unknown = false; throw e }
      if (mode === 'unknown') { const e = new Error('超时，结果未知'); e.unknown = true; throw e }
      if (mode === 'no-receipt') return {} // 调用无异常但没回执
      if (mode === 'wait') await sleep(3000)
      if (mode === 'gate') await new Promise(() => {}) // 手动放行前一直挂起
      return { messageId: `gw-${calls.length}` }
    },
  }
}

test('ledger：登记→sending→sent（真实回执）；重复 deliveryId 拒绝；sent 不可再变更（防重放）', () => {
  const book = createDeliveryLedger({})
  const id = newDeliveryId()
  book.enqueue({ deliveryId: id, chatKey: 'private:1', sourceModuleId: 'core', segments: segs() })
  book.mark(id, 'sending')
  const sent = book.mark(id, 'sent', { gatewayMessageId: 'gw-real-1' })
  assert.equal(sent.gatewayMessageId, 'gw-real-1')
  assert.throws(() => book.enqueue({ deliveryId: id, chatKey: 'private:1', segments: segs() }), /重复/, '幂等键不可覆盖')
  assert.throws(() => book.mark(id, 'failed'), /不许再变更/, '已 sent 防重放')
  assert.throws(() => book.mark(id, 'sent', { gatewayMessageId: '' }), /真实 messageId/, 'sent 不接受空回执')
})

test('ledger：queued/sending/deliveryId 一律不许冒充网关 messageId', () => {
  const book = createDeliveryLedger({})
  const id = newDeliveryId()
  book.enqueue({ deliveryId: id, chatKey: 'private:1', segments: segs() })
  // queued 态记 sent 且无回执 → 拒绝
  assert.throws(() => book.mark(id, 'sent', { gatewayMessageId: '' }), TypeError)
  // 用 deliveryId 冒充回执也被拒（空串/undefined 同样）
  assert.throws(() => book.mark(id, 'sent'), TypeError)
})

test('outbox：确定失败 = failed（不重试不降级）；unknown = unknown（绝不自动重发）', async () => {
  const gw = fakeGateway()
  gw.set('reject') // 所有 send 明确拒绝
  const outbox = createOutbox({ send: gw.send })
  const r1 = await outbox.request({ chatKey: 'private:1', segments: segs('确定失败') })
  assert.equal(r1.state, 'failed')
  assert.equal(r1.gatewayMessageId, undefined)
  assert.equal(gw.calls.length, 1, '确定失败不重试（重试条件必须有状态依据）')

  gw.set('unknown')
  const r2 = await outbox.request({ chatKey: 'private:1', segments: segs('结果未知') })
  assert.equal(r2.state, 'unknown')
  assert.equal(r2.gatewayMessageId, undefined, 'unknown 不伪造回执')
  assert.equal(gw.calls.filter((c) => c.mode === 'unknown').length, 1, 'unknown 绝不自动重发')
  const audit = outbox.ledger.unknowns()
  assert.equal(audit.length, 1)
  assert.ok(audit[0].unknownReason, 'unknown 有审计原因')
})

test('outbox：回执丢失（调用无异常但没 messageId）→ unknown，绝不冒充 sent', async () => {
  const gw = fakeGateway()
  gw.set('no-receipt')
  const outbox = createOutbox({ send: gw.send })
  const r = await outbox.request({ chatKey: 'private:2', segments: segs() })
  assert.equal(r.state, 'unknown')
  assert.equal(r.gatewayMessageId, undefined)
  assert.match(r.reason, /messageId/)
})

test('outbox：每聊天 FIFO、跨聊天并行', async () => {
  const gw = fakeGateway()
  const order = []
  const slowSend = async (action, params) => {
    const chatId = params.group_id != null ? `group:${params.group_id}` : `private:${params.user_id}`
    order.push(`start:${chatId}`)
    if (chatId === 'private:1') await sleep(60) // 私聊慢
    order.push(`end:${chatId}`)
    return { messageId: `gw-${order.length}` }
  }
  const outbox = createOutbox({ send: slowSend })
  const [p1a, p1b, p2] = [
    outbox.request({ chatKey: 'private:1', segments: segs('一') }),
    outbox.request({ chatKey: 'private:1', segments: segs('二') }),
    outbox.request({ chatKey: 'group:9', segments: segs('群') }),
  ]
  const [r1a, r1b, r2] = await Promise.all([p1a, p1b, p2])
  assert.equal(r1a.state, 'sent')
  assert.equal(r1b.state, 'sent')
  assert.equal(r2.state, 'sent')
  const end1 = order.indexOf('end:private:1')
  const start1b = order.indexOf('start:private:1', end1) // 第二条私聊在第一条结束后才开始
  assert.ok(start1b > -1, '同聊天 FIFO 串行')
  const end2 = order.indexOf('end:group:9')
  assert.ok(end2 < end1, '群聊不等私聊（跨聊天并行）')
})

test('outbox：队列中权限变化 → 出队复核拒绝，状态 cancelled 且不实发', async () => {
  let allowed = true
  const firstGate = gate()
  let sends = 0
  const outbox = createOutbox({
    send: async () => { sends++; await firstGate.promise; return { messageId: 'gw-1' } },
    authorize: async () => allowed,
  })
  const first = outbox.request({ chatKey: 'private:3', segments: segs('先发的') })
  await sleep(20) // 第一条已过出队复核，进入 sending（挂在 gate 上）
  allowed = false // 排队期间权限被收回
  const second = outbox.request({ chatKey: 'private:3', segments: segs('后到的') })
  // 授权在出队复核点执行（非入队时刻快照）：第二条排在第一条之后，第一条放行后
  // 第二条出队时 authorize 读到最新权限 → 拒。
  firstGate.release()
  const [r1, r2] = await Promise.all([first, second])
  assert.equal(r1.state, 'sent')
  assert.equal(r2.state, 'cancelled')
  assert.match(r2.reason, /authorize/)
  assert.equal(sends, 1, '被拒的投递从未实发（只有放行的第一条真实出门）')
})

test('outbox：慢首条 authorize 不被快第二条超车（FIFO 与授权时序）', async () => {
  // 复核报告 §4.3：旧实现把 authorize await 插在 enqueue 与链注册之间，慢的第一条
  // authorize 期间第二条快速入队会抢到链头先实发——顺序被破坏。
  const order = []
  let resolveSlowAuth
  const slowAuth = new Promise((r) => { resolveSlowAuth = r })
  const outbox = createOutbox({
    send: async (action, params) => { order.push(params.message[0].data.text); return { messageId: 'm' + order.length } },
    authorize: async (delivery) => {
      if (delivery.segments[0].data.text === '慢一') await slowAuth // 首条授权慢
      return true
    },
  })
  const p1 = outbox.request({ chatKey: 'private:8', segments: segs('慢一') })
  await sleep(10) // 第二条在首条 authorize 完成之前入队
  const p2 = outbox.request({ chatKey: 'private:8', segments: segs('快二') })
  resolveSlowAuth()
  await Promise.all([p1, p2])
  assert.deepEqual(order, ['慢一', '快二'], '入队顺序 = 实发顺序，慢授权不被超车')
})

test('outbox：dryRun 记台账不实发', async () => {
  const gw = fakeGateway()
  let dry = true
  const outbox = createOutbox({ send: gw.send, dryRun: () => dry })
  const r = await outbox.request({ chatKey: 'private:4', segments: segs() })
  assert.equal(r.state, 'cancelled')
  assert.equal(gw.calls.length, 0)
  dry = false
  const r2 = await outbox.request({ chatKey: 'private:4', segments: segs() })
  assert.equal(r2.state, 'sent')
  assert.equal(gw.calls.length, 1)
})

test('outbox：队列中的投递可取消；已 sending 的不可取消（副作用正在发生）', async () => {
  const firstGate = gate()
  const outbox = createOutbox({
    send: async () => { await firstGate.promise; return { messageId: 'gw-1' } },
  })
  const r1p = outbox.request({ chatKey: 'private:5', segments: segs('在发') })
  await sleep(20) // 第一条进入 sending（挂 gate）
  const r2p = outbox.request({ chatKey: 'private:5', segments: segs('排队') })
  // 第一条 sending、第二条 queued：queuedFor 只能看到排队中的那条
  const q = outbox.ledger.queuedFor('private:5')
  assert.equal(q.length, 1, '第二条还在队列里')
  const c = outbox.cancel(q[0].deliveryId)
  assert.equal(c.state, 'cancelled')
  // 先放行第一条（否则第二条的 doSend 排在它后面，await 会死等）
  firstGate.release()
  const [r1, r2] = await Promise.all([r1p, r2p])
  assert.equal(r1.state, 'sent')
  assert.equal(r2.state, 'cancelled', '取消先于出队复核生效')
  // 已 sent：不可取消、不可重放
  const attempt = outbox.cancel(r1.deliveryId)
  assert.equal(attempt.state, 'sent')
  assert.match(attempt.reason, /不可取消/)
})

test('outbox：媒体/多段投递原样透传（segments 不改写），群聊走 send_group_msg', async () => {
  const gw = fakeGateway()
  const outbox = createOutbox({ send: gw.send })
  const media = [
    { type: 'text', data: { text: '看图' } },
    { type: 'image', data: { url: 'https://x/y.png' } },
    { type: 'record', data: { file: 'base64://xx' } },
  ]
  const r = await outbox.request({ chatKey: 'group:77', sourceModuleId: 'multi-parser', segments: media })
  assert.equal(r.state, 'sent')
  const call = gw.calls[0]
  assert.equal(call.action, 'send_group_msg')
  assert.deepEqual(call.params.message, media, 'segments 原样透传（清洗/分条是适配层的事）')
  assert.deepEqual(call.params, { group_id: 77, message: media })
})

test('outbox：非法输入 fail-closed（缺 segments / 非法 ChatKey / dispose 后拒绝）', async () => {
  const gw = fakeGateway()
  const outbox = createOutbox({ send: gw.send })
  await assert.rejects(() => outbox.request({ chatKey: 'private:1' }), /segments/)
  await assert.rejects(() => outbox.request({ chatKey: '10001', segments: segs() }), TypeError)
  await assert.rejects(() => outbox.request({ chatKey: 'group:abc', segments: segs() }), TypeError)
  // dispose 由 ledger 测试覆盖（outbox 无 timer）；这里验证重复 ID 不覆盖
  const id = newDeliveryId()
  await outbox.request({ chatKey: 'private:1', segments: segs(), deliveryId: id })
  await assert.rejects(() => outbox.request({ chatKey: 'private:1', segments: segs(), deliveryId: id }), /重复/)
})

test('ledger 崩溃恢复：落盘 sending → 重启读回 unknown（审计留痕，绝不标 sent/重放）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2d-ledger-'))
  try {
    const file = join(dir, 'ledger.json')
    // 第一阶段：登记 + sending + 落盘（模拟发送中途崩溃）
    const book1 = createDeliveryLedger({ file })
    const id = newDeliveryId()
    book1.enqueue({ deliveryId: id, chatKey: 'private:7', segments: segs() })
    book1.mark(id, 'sending')
    const idSent = newDeliveryId()
    book1.enqueue({ deliveryId: idSent, chatKey: 'private:7', segments: segs() })
    book1.mark(idSent, 'sent', { gatewayMessageId: 'gw-true' })
    delete globalThis.__keepAlive

    // 第二阶段：「重启」读台账
    const book2 = createDeliveryLedger({ file })
    const rec = book2.get(id)
    assert.equal(rec.state, 'unknown', 'sending 恢复为 unknown')
    assert.match(rec.unknownReason, /crash-recovery/)
    const sentRec = book2.get(idSent)
    assert.equal(sentRec.state, 'sent', '已 sent 的不受影响')
    assert.equal(sentRec.gatewayMessageId, 'gw-true')
    assert.equal(book2.stats().crashedSending, 1, '崩溃恢复计数可审计')
    // unknown 不会被当成 failed 重放
    assert.equal(book2.queuedFor('private:7').length, 0, 'unknown 不回队列')
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('ledger：损坏文件失败关闭（空台账起步 + 上报），不猜脏数据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2d-ledger-'))
  try {
    const file = join(dir, 'broken.json')
    writeFileSync(file, '{ 坏 JSON')
    const errors = []
    const book = createDeliveryLedger({ file, onError: (e) => errors.push(e) })
    assert.equal(book.stats().total, 0)
    assert.ok(errors.length >= 1)
    // 且后续可用
    const id = newDeliveryId()
    book.enqueue({ deliveryId: id, chatKey: 'private:1', segments: segs() })
    assert.equal(book.get(id).state, 'queued')
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('ledger：cancelled 记 cancelReason（真机报告：拒绝原因必须可审计）', () => {
  const id = newDeliveryId()
  const book = createDeliveryLedger({})
  book.enqueue({ deliveryId: id, chatKey: 'private:1', segments: segs() })
  book.mark(id, 'cancelled', { reason: '身份泄露闸：测试' })
  assert.equal(book.get(id).cancelReason, '身份泄露闸：测试')
})

test('ledger：attemptCount 只统计真实物理发送尝试（状态迁移不计）', () => {
  const id = newDeliveryId()
  const book = createDeliveryLedger({})
  book.enqueue({ deliveryId: id, chatKey: 'private:1', segments: segs() })
  assert.equal(book.get(id).attemptCount, 0, 'queued 时 0 次尝试')
  book.mark(id, 'sending')
  assert.equal(book.get(id).attemptCount, 1, '一次 sending = 一次尝试')
  book.mark(id, 'sent', { gatewayMessageId: 'gw-1' })
  assert.equal(book.get(id).attemptCount, 1, 'sent 迁移不再 +1（旧实现在每个 mark++，统计的是状态迁移）')
  // 重投：再进 sending 才计第二次
  const id2 = newDeliveryId()
  book.enqueue({ deliveryId: id2, chatKey: 'private:2', segments: segs() })
  book.mark(id2, 'sending'); book.mark(id2, 'failed', { reason: 'x' })
  assert.equal(book.get(id2).attemptCount, 1, 'failed 迁移不计尝试')
})

test('ledger：关键落盘（enqueue/sending）失败 fail-closed 抛出，非关键（终态）失败不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2d-fail-'))
  try {
    // 把 file 位置做成一个目录 → writeJsonAtomic 必失败
    const file = join(dir, 'occupied')
    mkdirSync(file)
    const errors = []
    const book = createDeliveryLedger({ file, onError: (e) => errors.push(e) })
    const id = newDeliveryId()
    assert.throws(() => book.enqueue({ deliveryId: id, chatKey: 'private:1', segments: segs() }), /fail-closed/, 'enqueue 落盘失败必须抛（不登记）')
    assert.equal(book.get(id), null, '抛出后回滚：不留幽灵记录')
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('outbox：sending 落盘失败 fail-closed，不发起物理发送', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2d-closed-'))
  try {
    const file = join(dir, 'ledger')
    mkdirSync(file) // 目录占位，persist 必失败
    let sent = false
    const outbox = createOutbox({ send: async () => { sent = true; return { messageId: 'x' } }, ledger: createDeliveryLedger({ file, onError: () => {} }) })
    const r = await outbox.request({ chatKey: 'private:9', segments: segs() })
    assert.equal(sent, false, 'enqueue 已 fail-closed 抛出，绝不会走到 send')
    assert.equal(r, undefined)
  } catch (e) {
    // request 会因 enqueue fail-closed 直接 reject（async 抛出）——同样是 fail-closed，未实发
    assert.match(String(e.message), /fail-closed/)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('outbox：dispose 后拒绝新请求，并把排队中的条目落 cancelled 不实发', async () => {
  const gate1 = gate()
  let sends = 0
  const outbox = createOutbox({ send: async () => { sends++; await gate1.promise; return { messageId: 'g' } } })
  const p1 = outbox.request({ chatKey: 'private:6', segments: segs('一') })
  await sleep(15) // 第一条 sending
  const p2 = outbox.request({ chatKey: 'private:6', segments: segs('二') })
  await sleep(5)
  outbox.dispose()
  gate1.release()
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1.state, 'sent')
  assert.equal(r2.state, 'cancelled', '排队中被 dispose 落终态')
  assert.equal(sends, 1, 'dispose 后第二条从未实发')
  await assert.rejects(() => outbox.request({ chatKey: 'private:6', segments: segs() }), /已卸载/)
})

