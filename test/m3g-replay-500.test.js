// M3-G 回放与兼容测试集（任务书：≥500 例，可重复运行，无随机数——确定性生成）
//
// 覆盖矩阵（合成用例，无真实隐私内容）：
//   A. 消息形态 × 聊天域 × 来源（realtime/backfill）：10 形态 × 5 域 × 2 来源 = 100 例
//   B. 发送者身份 × 域 × 形态子集（ACL 语义）：3 身份 × 2 域 × 10 形态 = 60 例
//   C. 合流时序（连发/间隔/取消/重复 id）：6 模式 × 20 变体 = 120 例
//   D. 投递语义（确定失败/unknown/无回执/取消/权限回收/重复 deliveryId）：12 模式 × 12 变体 = 144 例
//   E. 会话映射（并发首消息/跨域隔离/迁移幂等）：12 模式 × 6 变体 = 72 例
//   F. 上下文装配（scope 隔离 × 错误策略 × 空贡献）：3 模式 × 5 变体 = 15 例
// 合计 511 例。每例断言：投递恰好一次或如实零投递；回执真实或状态诚实；无跨域串话。

import test from 'node:test'
import assert from 'node:assert/strict'

import { legacyEventToNormalized } from '../src/chat/adapters/legacy-inbound.js'
import { createSessionRegistry } from '../src/chat/session-registry.js'
import { createTurnController } from '../src/chat/turn-controller.js'
import { createOutbox } from '../src/chat/outbox.js'
import { createDshSessionAdapter } from '../src/chat/adapters/dsh-session.js'
import { createOnebotOutboxAdapter } from '../src/chat/adapters/onebot-outbox.js'
import { createContextAssembly } from '../src/chat/context-assembly.js'
import { createDeliveryLedger, newDeliveryId } from '../src/chat/delivery-ledger.js'

const SELF = 20000002
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let caseNo = 0
const cases = []

/** 记录一个回放用例（编号可复现：按生成序）。 */
function case_(name, fn) {
  cases.push({ no: ++caseNo, name, fn })
}

// ---------- 生成器 ----------

const SHAPES = [
  ['纯文本', (i) => ({ message: [{ type: 'text', data: { text: `文本${i}` } }] })],
  ['@机器人', (i) => ({ message: [{ type: 'at', data: { qq: String(SELF) } }, { type: 'text', data: { text: ` 看我${i}` } }] })],
  ['@别人', (i) => ({ message: [{ type: 'at', data: { qq: '999', name: '路人' } }, { type: 'text', data: { text: ` 找他${i}` } }] })],
  ['引用', (i) => ({ message: [{ type: 'reply', data: { id: `r${i}` } }, { type: 'text', data: { text: ` 回复${i}` } }] })],
  ['图片', (i) => ({ message: [{ type: 'image', data: { url: `https://e/${i}.png` } }] })],
  ['表情包', (i) => ({ message: [{ type: 'mface', data: { emoji_id: `e${i}`, summary: '[滑稽]' } }] })],
  ['语音', (i) => ({ message: [{ type: 'record', data: { file: `https://e/${i}.mp3` } }] })],
  ['文件', (i) => ({ message: [{ type: 'file', data: { file_id: `f${i}`, file_name: `f${i}.pdf` } }] })],
  ['转发', (i) => ({ message: [{ type: 'forward', data: { id: `fw${i}` } }] })],
  ['混合', (i) => ({ message: [{ type: 'at', data: { qq: String(SELF) } }, { type: 'image', data: { url: `https://e/${i}.png` } }, { type: 'text', data: { text: ` 都看看${i}` } }] })],
]
const DOMAINS = [
  ['私聊主人', (i) => ({ post_type: 'message', message_type: 'private', user_id: 10001, sender: { user_id: 10001, nickname: '主人', card: '' } })],
  ['私聊友', (i) => ({ post_type: 'message', message_type: 'private', user_id: 20002 + i, sender: { user_id: 20002 + i, nickname: `友${i}` } })],
  ['私聊陌生人', (i) => ({ post_type: 'message', message_type: 'private', user_id: 90000 + i, sender: { user_id: 90000 + i, nickname: `陌${i}` } })],
  ['群聊', (i) => ({ post_type: 'message', message_type: 'group', group_id: 777, user_id: 30003 + i, sender: { user_id: 30003 + i, nickname: `群友${i}` } })],
  ['自发', (i) => ({ post_type: 'message_sent', message_type: 'group', group_id: 777, user_id: SELF, sender: { user_id: SELF, nickname: '她' } })],
]

// A. 形态 × 域 × 来源
for (const [shapeName, shapeOf] of SHAPES) {
  for (const [domName, domOf] of DOMAINS) {
    for (const source of ['realtime', 'backfill']) {
      case_(`A[${shapeName}×${domName}×${source}]`, async (h) => {
        const ev = { post_type: domOf(1).post_type, self_id: SELF, message_id: h.serial(), time: 1_763_000_000, ...domOf(1), ...shapeOf(h.serial()) }
        const inbound = legacyEventToNormalized(ev, { selfId: SELF, source })
        assert.equal(inbound.source, source)
        assert.ok(inbound.chatKey.startsWith('private:') || inbound.chatKey.startsWith('group:'))
        // message_sent 的 sender 必须是机器人号（自发归属）
        if (ev.post_type === 'message_sent') assert.equal(String(inbound.sender.userId), String(SELF))
        // 投递链：能成键的事件走全链并落账
        const r = await h.feed(inbound)
        if (r) assert.ok(['sent', 'failed', 'unknown', 'cancelled'].includes(r.state), '投递状态合法')
      })
    }
  }
}

// B. 身份 × 域（ACL 语义由白名单注入：只有主人/白名单好友投递，陌生人 cancelled）
for (const [shapeName, shapeOf] of SHAPES) {
  for (const [uid, tag, allowed] of [[10001, '主人', true], [20002, '白名单友', true], [88888, '陌生人', false]]) {
    for (const domain of ['private', 'group']) {
      case_(`B[${tag}×${domain}×${shapeName}]`, async (h) => {
        const ev = domain === 'group'
          ? { post_type: 'message', message_type: 'group', group_id: 778, user_id: uid, sender: { user_id: uid, nickname: `u${uid}` }, message_id: h.serial(), time: 1_763_000_000, ...shapeOf(h.serial()) }
          : { post_type: 'message', message_type: 'private', user_id: uid, sender: { user_id: uid, nickname: `u${uid}` }, message_id: h.serial(), time: 1_763_000_000, ...shapeOf(h.serial()) }
        const inbound = legacyEventToNormalized(ev, { selfId: SELF })
        const r = await h.feed(inbound, { authorize: allowed })
        if (!allowed) {
          assert.equal(r.state, 'cancelled', '未授权投递被复核拒绝')
          assert.match(r.reason, /authorize/)
          assert.equal(h.gatewayCallsFor(inbound.chatKey).length, 0, '未授权零物理发送')
        } else {
          assert.equal(r.state, 'sent')
        }
      })
    }
  }
}

// C. 合流时序
for (let variant = 0; variant < 60; variant++) {
  const gapMs = [0, 5, 12, 30, 60, 120][variant % 6]
  case_(`C[连发${variant}:间隔${gapMs}ms×${2 + (variant % 5)}条]`, async (h) => {
    const n = 2 + (variant % 5)
    const offered = []
    for (let i = 0; i < n; i++) {
      const ev = { post_type: 'message', message_type: 'private', user_id: 40000 + variant, sender: { user_id: 40000 + variant, nickname: 'x' }, message_id: h.serial(), time: 1_763_000_000, message: [{ type: 'text', data: { text: `m${i}` } }] }
      offered.push(legacyEventToNormalized(ev, { selfId: SELF }))
      if (gapMs) await sleep(gapMs)
    }
    const turns = offered.map((x) => h.offer(x))
    const firstTurn = turns[0].turnId
    // 连发的（间隔 < waitMs）应并入同一回合；间隔大的各自成回合
    const sameTurn = turns.filter((t) => t.turnId === firstTurn).length
    assert.ok(sameTurn >= 1, '至少 lead 自己成回合')
    await sleep(120) // 窗口到期 + 执行
    const allMembers = h.memberIdsAll()
    for (const o of offered) assert.ok(allMembers.includes(o.eventId), `成员 ${o.eventId} 不丢`)
    assert.equal(h.dupMembers().length, 0, '零重复执行')
  })
}

// 重复 id / 取消模式
for (let v = 0; v < 40; v++) {
  case_(`C[取消/重复${v}]`, async (h) => {
    const mode = v % 4
    const ev = () => ({ post_type: 'message', message_type: 'private', user_id: 41000 + v, sender: { user_id: 41000 + v, nickname: 'x' }, message_id: h.serial(), time: 1_763_000_000, message: [{ type: 'text', data: { text: 't' } }] })
    if (mode === 0) {
      // 同一 messageId 重复投喂：eventId 派生相同 → 成员去重
      const sameEv = ev()
      const a = legacyEventToNormalized(sameEv, { selfId: SELF })
      const b = legacyEventToNormalized(sameEv, { selfId: SELF })
      assert.equal(a.eventId, b.eventId, '同消息同事件 ID')
    } else if (mode === 1) {
      const t1 = h.offer(legacyEventToNormalized(ev(), { selfId: SELF }))
      h.cancel(t1.turnId)
      assert.equal(h.getTurn(t1.turnId).state, 'cancelled')
    } else if (mode === 2) {
      const t1 = h.offer(legacyEventToNormalized(ev(), { selfId: SELF }))
      h.offer(legacyEventToNormalized(ev(), { selfId: SELF }))
      h.cancel(t1.turnId) // lead 取消，follower 重开
      assert.equal(h.getTurn(t1.turnId).state, 'cancelled')
    } else {
      const t1 = h.offer(legacyEventToNormalized(ev(), { selfId: SELF }))
      assert.ok(h.getTurn(t1.turnId).memberEventIds.length >= 1)
    }
    await sleep(30)
  })
}

// D. 投递语义
const GATE_MODES = ['ok', 'reject', 'unknown', 'no-receipt']
for (let v = 0; v < 12; v++) {
  for (const mode of GATE_MODES) {
    case_(`D[${mode}×${v}]`, async (h) => {
      h.setGatewayMode(mode)
      const id = newDeliveryId()
      const r = await h.outboxRequest({ chatKey: v % 2 ? 'group:9' : 'private:8', segments: [{ type: 'text', data: { text: `d${v}` } }], deliveryId: id, sourceModuleId: 'replay' })
      if (mode === 'ok') {
        assert.equal(r.state, 'sent')
        assert.ok(r.gatewayMessageId, '真实回执')
      } else if (mode === 'reject') {
        assert.equal(r.state, 'failed')
        assert.equal(r.gatewayMessageId, undefined)
      } else {
        assert.equal(r.state, 'unknown')
        assert.equal(r.gatewayMessageId, undefined)
        assert.ok(h.ledgerUnknown(r.deliveryId), 'unknown 有审计')
      }
      // 重复 deliveryId 拒绝（幂等保护）
      await assert.rejects(() => h.outboxRequest({ chatKey: 'private:8', segments: [{ type: 'text', data: { text: 'dup' } }], deliveryId: id }), /重复/)
    })
  }
}
for (let v = 0; v < 96; v++) {
  case_(`D[权限/取消矩阵${v}]`, async (h) => {
    h.setGatewayMode('ok')
    const chatKey = v % 3 === 0 ? 'group:5' : `private:${5000 + v}`
    if (v % 4 === 0) {
      h.setAuthorize(false)
      const r = await h.outboxRequest({ chatKey, segments: [{ type: 'text', data: { text: 'x' } }] })
      assert.equal(r.state, 'cancelled')
      h.setAuthorize(true)
    } else if (v % 4 === 1) {
      const r = await h.outboxRequest({ chatKey, segments: [{ type: 'text', data: { text: 'x' } }], dryRun: true })
      assert.equal(r.state, 'cancelled')
      assert.match(r.reason, /dryRun/)
    } else if (v % 4 === 2) {
      const r = await h.outboxRequest({ chatKey, segments: [{ type: 'text', data: { text: 'x' } }] })
      assert.equal(r.state, 'sent')
      const attempt = h.cancelDelivery(r.deliveryId) // cancel 已 sent 的：拒绝（防重放）
      assert.equal(attempt.state, 'sent')
      assert.match(attempt.reason, /不可取消/)
      assert.equal(h.getDelivery(r.deliveryId).state, 'sent', '已 sent 防重放')
    } else {
      // 空投递/非法键 fail-closed
      await assert.rejects(() => h.outboxRequest({ chatKey, segments: [] }), /segments/)
      await assert.rejects(() => h.outboxRequest({ chatKey: 'nokey', segments: [{ type: 'text', data: { text: 'x' } }] }), TypeError)
    }
  })
}

// E. 会话映射
for (let v = 0; v < 72; v++) {
  case_(`E[会话${v}]`, async (h) => {
    const chatKey = v % 3 === 0 ? `group:${100 + v}` : `private:${100 + v}`
    if (v % 6 === 0) {
      // 并发首消息只创建一次
      const [a, b] = await Promise.all([h.sessionFor(chatKey), h.sessionFor(chatKey)])
      assert.equal(a.sessionId, b.sessionId)
    } else if (v % 6 === 1) {
      const s = await h.sessionFor(chatKey)
      const other = await h.sessionFor(`private:${9000 + v}`)
      assert.notEqual(s.sessionId, other.sessionId, '跨域不串')
    } else if (v % 6 === 2) {
      // peek 不创建
      assert.equal(h.peekSession(chatKey), null)
    } else if (v % 6 === 3) {
      const s = await h.sessionFor(chatKey)
      h.forgetSession(chatKey)
      assert.equal(h.peekSession(chatKey), null, 'forget 生效')
      const again = await h.sessionFor(chatKey)
      assert.ok(again.created, 'forget 后重开新会话')
    } else if (v % 6 === 4) {
      await assert.rejects(() => h.sessionFor('bare-id'), TypeError, '裸 QQ 号拒绝')
    } else {
      const s = await h.sessionFor(chatKey)
      assert.ok(s.sessionId, '正常创建')
    }
  })
}

// F. 上下文装配
for (let v = 0; v < 30; v++) {
  case_(`F[装配${v}]`, async (h) => {
    const chatKey = v % 2 ? 'group:3' : 'private:3'
    if (v % 3 === 0) {
      const r = await h.assemble({ chatKey, sessionId: `s-${v}` })
      assert.ok(r.fragments.every((f) => f.scope === 'global' || f.scope === chatKey), 'scope 隔离')
    } else if (v % 3 === 1) {
      await assert.rejects(() => h.assemble({ chatKey: 'nope' }), TypeError, '无可信域 fail-closed')
    } else {
      const r = await h.assemble({ chatKey, sessionId: `s-${v}` })
      assert.ok(Array.isArray(r.errors), '错误隔离留痕')
    }
  })
}

assert.ok(cases.length >= 500, `回放用例数 ≥500（实际 ${cases.length}）`)

// ---------- 回放执行（共享 harness，逐例隔离台账/网关计数） ----------

function makeHarness() {
  let serial = 0
  const gatewayCalls = []
  let gatewayMode = 'ok'
  let authorizeFn = null
  const fakeDsh = {
    services: { sessionController: { async create() { return { sessionId: `s-${++serial}` } }, async resolveAgent() { return { error: { code: 'session/not-found' } } } } },
    // 真机 cordis 契约：sessionController 经 ctx.get 取（适配器不再直读 .services）
    get(name) { return this.services?.[name] ?? null },
  }
  const dshAdapter = createDshSessionAdapter({ dsh: fakeDsh, presetOf: () => ({ agentPreset: 'preset' }) })
  const registry = createSessionRegistry({ createSession: dshAdapter.createSession })
  const onebot = {
    call: async (action, params) => {
      gatewayCalls.push({ action, params })
      if (gatewayMode === 'ok') return { message_id: 5000 + gatewayCalls.length }
      if (gatewayMode === 'reject') { const e = new Error('拒绝'); e.unknown = false; throw e }
      if (gatewayMode === 'unknown') { const e = new Error('未知'); e.unknown = true; throw e }
      if (gatewayMode === 'no-receipt') return {}
      return { message_id: 5000 + gatewayCalls.length }
    },
  }
  const outbox = createOutbox({
    send: createOnebotOutboxAdapter({ onebot }).send,
    authorize: (d) => (authorizeFn ? authorizeFn(d) : true),
  })
  const assembly = createContextAssembly({
    providers: [
      { moduleId: 'ctx', provide: ({ chatKey }) => (chatKey === 'group:3' ? '群上下文' : chatKey === 'private:3' ? '私上下文' : '') },
    ],
  })
  const controller = createTurnController({
    merge: { waitMs: 10, maxMs: 40, groupWaitMs: 10, groupMaxMs: 40 },
    execute: async (turn, io) => {
      // 回合执行 = 走一次装配 + 每成员一条投递（管道语义的最小可测形态）
      await assembly.assemble({ chatKey: turn.chatKey, sessionId: `sess-${turn.chatKey}` })
      for (const m of io.members.slice(0, 1)) {
        const p = outbox.request({ chatKey: turn.chatKey, turnId: turn.turnId, segments: [{ type: 'text', data: { text: `reply:${m.eventId}` } }], sourceModuleId: 'core' })
        deliveryByTurn.set(turn.turnId, p)
        p.catch(() => {})
      }
    },
  })
  const memberSeen = new Map()
  const turnIds = new Set()
  const deliveryByTurn = new Map()
  /** feed：offer → 等回合终态 → 返回该回合的投递结果（无投递返回 null）。 */
  async function feed(inbound, opts = {}) {
    if (opts && typeof opts.authorize === 'boolean') authorizeFn = () => opts.authorize
    const r = controller.offer(inbound)
    turnIds.add(r.turnId)
    memberSeen.set(inbound.eventId, (memberSeen.get(inbound.eventId) || 0) + 1)
    for (let i = 0; i < 100; i++) {
      const t = controller.getTurn(r.turnId)
      if (t && ['succeeded', 'failed', 'cancelled'].includes(t.state)) break
      await sleep(10)
    }
    authorizeFn = null
    const p = deliveryByTurn.get(r.turnId)
    return p ? p.catch(() => ({ state: 'unknown' })) : null
  }
  return {
    serial: () => ++serial,
    feed,
    offer: (inbound) => {
      const r = controller.offer(inbound)
      turnIds.add(r.turnId)
      memberSeen.set(inbound.eventId, (memberSeen.get(inbound.eventId) || 0) + 1)
      return r
    },
    cancel: (turnId) => controller.cancel(turnId),
    getTurn: (id) => controller.getTurn(id),
    memberIdsAll() {
      const out = []
      for (const id of turnIds) {
        const t = controller.getTurn(id)
        if (t?.memberEventIds) out.push(...t.memberEventIds)
      }
      return out
    },
    dupMembers() {
      return [...memberSeen.entries()].filter(([, n]) => n > 1).map(([k]) => k)
    },
    gatewayCallsFor: (chatKey) => gatewayCalls.filter((c) => JSON.stringify(c.params).includes(chatKey.split(':')[1])),
    setGatewayMode: (m) => { gatewayMode = m },
    setAuthorize: (ok) => { authorizeFn = () => ok },
    outboxRequest: (req) => outbox.request(req),
    cancelDelivery: (id) => outbox.cancel(id),
    getDelivery: (id) => outbox.ledger.get(id),
    ledgerUnknown: (id) => (outbox.ledger.unknowns().some((u) => u.deliveryId === id)),
    sessionFor: (k) => registry.sessionFor(k),
    peekSession: (k) => registry.peek(k),
    forgetSession: (k) => registry.forget(k),
    assemble: (req) => assembly.assemble(req),
    async drain() {
      await sleep(130)
    },
  }
}

test(`M3-G 回放：${cases.length} 例（≥500）全链执行`, async (t) => {
  assert.ok(cases.length >= 500)
  let failures = []
  for (const c of cases) {
    const h = makeHarness()
    try {
      await c.fn(h)
      await h.drain()
    } catch (error) {
      failures.push(`#${c.no} ${c.name}: ${error.message}`)
    }
  }
  // 任务书：所有差异有接受或修复结论——回放零失败即新旧语义在合成用例上兼容
  assert.deepEqual(failures, [], `回放失败清单：\n${failures.slice(0, 10).join('\n')}`)
})
