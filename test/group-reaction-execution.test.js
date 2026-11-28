// T2.1 REACT 执行器真实行为测试：真实 Outbox + 真实 delivery-ledger + 真实 group-state，
// 断言可观察行为（网关调用、台账、预算、缓冲 fed 标记、防重归类），不做源码正则假测试。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeGroupReaction, normalizeReactionResultReason } from '../src/host/core/group-reaction-execution.js'
import { createOutbox } from '../src/chat/outbox.js'
import { createDeliveryLedger } from '../src/chat/delivery-ledger.js'
import { createGroupState } from '../src/chat/group-state.js'

const GID = '30001'
const CHAT = `group:${GID}`
const MID_A = '10001'
const MID_B = '10002'
let dataDir

before(() => { dataDir = mkdtempSync(join(tmpdir(), 'react-exec-')) })
after(() => { try { rmSync(dataDir, { recursive: true, force: true }) } catch {} })

const mkTurn = (turnId = 't1') => ({ turnId, chatKey: CHAT })
const mkIo = ({ members = [MID_A, MID_B], aborted = false } = {}) => {
  const ctl = new AbortController()
  if (aborted) ctl.abort()
  return { members: members.map((mid) => ({ messageId: mid })), signal: ctl.signal }
}
const react = (messageId = MID_A, emojiId = '66', sourceModuleId = 'gp-mod') => ({
  level: 'react', sourceModuleId, reaction: { messageId, emojiId },
})

function mkGroups() {
  const now = Date.now()
  const groups = createGroupState()
  groups.appendMessage(GID, { t: now - 4000, uid: '555', nick: '甲', text: '哈哈', mid: MID_A, self: false })
  groups.appendMessage(GID, { t: now - 3000, uid: '556', nick: '乙', text: '确实', mid: MID_B, self: false })
  groups.appendMessage(GID, { t: now - 2000, uid: '557', nick: '丙', text: '更早的另一条', mid: '99999', self: false })
  return groups
}

function mkOutbox(sendImpl, ledger = createDeliveryLedger({}), extra = {}) {
  const calls = []
  const send = async (action, params, opts) => { calls.push({ action, params, opts }); return sendImpl ? sendImpl({ action, params, opts }) : {} }
  const outbox = createOutbox({ send, ledger, ...extra })
  return { outbox, calls }
}

test('sent：网关一次、载荷固定、noteSpeak/noteInterject 各一次、noteSpokeInGroup 零、本回合成员标 fed', async () => {
  const groups = mkGroups()
  const { outbox, calls } = mkOutbox(() => ({}))
  const now = Date.now()
  const r = await executeGroupReaction({ turn: mkTurn('t1'), io: mkIo(), offeredMode: 'interject', participation: react(), groups, outbox, log: null, now })
  assert.deepEqual(r, { state: 'sent', deliveryId: 'group-react:t1', reason: '' })
  assert.equal(calls.length, 1, '网关恰好一次')
  assert.deepEqual(calls[0].action, 'set_msg_emoji_like')
  assert.deepEqual(calls[0].params, { message_id: MID_A, emoji_id: '66' })
  // 台账如实
  const rec = outbox.ledger.get('group-react:t1')
  assert.equal(rec.state, 'sent')
  assert.equal(rec.action, 'set_msg_emoji_like')
  // 成功预算：noteSpeak + noteInterject 各一次
  assert.equal(groups.speakTimes(GID).length, 1)
  assert.equal(groups.interjectTimes(GID).length, 1)
  // noteSpokeInGroup 绝不能调（否则会 joinTopic）：engaged 窗口/预算必须还是 0
  assert.equal(groups.engagedUntil(GID), 0)
  assert.equal(groups.engagedReplies(GID), 0)
  // fed：只标本回合成员（10001/10002），旧消息 99999 不误标
  const buf = groups.buffer(GID)
  assert.equal(buf.find((x) => x.mid === MID_A).fed, true)
  assert.equal(buf.find((x) => x.mid === MID_B).fed, true)
  assert.equal(Boolean(buf.find((x) => x.mid === '99999').fed), false)
})

test('failed：零成功预算、零 fed、零第二次调用、零文本 fallback', async () => {
  const groups = mkGroups()
  const { outbox, calls } = mkOutbox(() => { throw new Error('result=299 err=机器人不在这个群里') })
  const r = await executeGroupReaction({ turn: mkTurn('t1'), io: mkIo(), offeredMode: 'interject', participation: react(), groups, outbox, log: null, now: Date.now() })
  assert.equal(r.state, 'failed')
  assert.equal(r.deliveryId, 'group-react:t1')
  assert.equal(calls.length, 1, '失败后绝不重试')
  assert.equal(groups.speakTimes(GID).length, 0, 'failed 零成功预算')
  assert.equal(groups.interjectTimes(GID).length, 0)
  assert.equal(groups.engagedUntil(GID), 0)
  for (const x of groups.buffer(GID)) assert.equal(Boolean(x.fed), false, 'failed 不标 fed')
})

test('unknown：零成功预算、零重试，本回合成员缓冲标 fed（抑制下一轮重复）', async () => {
  const groups = mkGroups()
  const { outbox, calls } = mkOutbox(() => { throw Object.assign(new Error('网关连接中断'), { unknown: true }) })
  const r = await executeGroupReaction({ turn: mkTurn('t1'), io: mkIo(), offeredMode: 'interject', participation: react(), groups, outbox, log: null, now: Date.now() })
  assert.equal(r.state, 'unknown')
  assert.equal(calls.length, 1, 'unknown 绝不自动重试')
  assert.equal(groups.speakTimes(GID).length, 0, 'unknown 零成功预算')
  assert.equal(groups.interjectTimes(GID).length, 0)
  const buf = groups.buffer(GID)
  assert.equal(buf.find((x) => x.mid === MID_A).fed, true, 'unknown 也标记成员已处理（副作用未知）')
  assert.equal(Boolean(buf.find((x) => x.mid === '99999').fed), false)
})

test('dryRun / 总开关关闭 / authorize 拒绝：cancelled，零预算零 fed 零网关', async () => {
  for (const [label, extra, reasonRe] of [
    ['dryRun', { dryRun: () => true }, /dryRun/],
    ['总开关', { enabled: () => false }, /总开关/],
    ['ACL', { authorize: async () => false }, /authorize/],
  ]) {
    const groups = mkGroups()
    const { outbox, calls } = mkOutbox(() => ({}), createDeliveryLedger({}), extra)
    const r = await executeGroupReaction({ turn: mkTurn('t1'), io: mkIo(), offeredMode: 'interject', participation: react(), groups, outbox, log: null, now: Date.now() })
    assert.equal(r.state, 'cancelled', `${label} 必须 cancelled`)
    assert.match(r.reason, reasonRe)
    assert.equal(calls.length, 0, `${label} 零网关调用`)
    assert.equal(groups.speakTimes(GID).length, 0)
    for (const x of groups.buffer(GID)) assert.equal(Boolean(x.fed), false, `${label} 不标 fed`)
  }
})

test('重入防重：台账已有 sent → duplicate-suppressed 原状态返回，零新请求、预算不重复', async () => {
  const groups = mkGroups()
  const ledger = createDeliveryLedger({})
  ledger.enqueue({ deliveryId: 'group-react:t1', chatKey: CHAT, turnId: 't1', sourceModuleId: 'gp-mod', action: 'set_msg_emoji_like' })
  ledger.mark('group-react:t1', 'sending')
  ledger.mark('group-react:t1', 'sent', { gatewayMessageId: 'gm-1' })
  const { outbox, calls } = mkOutbox(() => ({}), ledger)
  const r = await executeGroupReaction({ turn: mkTurn('t1'), io: mkIo(), offeredMode: 'interject', participation: react(), groups, outbox, log: null, now: Date.now() })
  assert.deepEqual(r, { state: 'sent', deliveryId: 'group-react:t1', reason: 'duplicate-suppressed' })
  assert.equal(calls.length, 0, '已有终态绝不第二次物理请求')
  assert.equal(groups.speakTimes(GID).length, 0, '重入不重复记成功预算')
  const rec = ledger.get('group-react:t1')
  assert.equal(rec.attemptCount, 1, 'attemptCount 不增加')
})

test('重入防重：台账 queued/sending → unknown / duplicate-in-flight，零新请求', async () => {
  for (const state of ['queued', 'sending']) {
    const groups = mkGroups()
    const ledger = createDeliveryLedger({})
    ledger.enqueue({ deliveryId: 'group-react:t1', chatKey: CHAT, turnId: 't1', action: 'set_msg_emoji_like' })
    if (state === 'sending') ledger.mark('group-react:t1', 'sending')
    const { outbox, calls } = mkOutbox(() => ({}), ledger)
    const r = await executeGroupReaction({ turn: mkTurn('t1'), io: mkIo(), offeredMode: 'interject', participation: react(), groups, outbox, log: null, now: Date.now() })
    assert.deepEqual(r, { state: 'unknown', deliveryId: 'group-react:t1', reason: 'duplicate-in-flight' })
    assert.equal(calls.length, 0)
  }
})

test('重复 deliveryId 异常：读台账归类（竞态赢家 queued → duplicate-in-flight；sent → duplicate-suppressed），绝不当首次成功', async () => {
  // 模拟两个执行器竞态：败者的 outbox.request 在 enqueue 时抛重复异常。
  for (const winnerState of ['queued', 'sent']) {
    const groups = mkGroups()
    const ledger = createDeliveryLedger({})
    const calls = []
    const outbox = {
      ledger,
      request: async (req) => {
        // 竞态赢家先入账，败者的 enqueue 抛重复
        ledger.enqueue({ deliveryId: req.deliveryId, chatKey: req.chatKey, turnId: req.turnId, action: req.action })
        if (winnerState === 'sent') ledger.mark(req.deliveryId, 'sending')
        if (winnerState === 'sent') ledger.mark(req.deliveryId, 'sent', { gatewayMessageId: 'gm-2' })
        throw new Error(`deliveryId 重复：${req.deliveryId}（已存在记录，不覆盖）`)
      },
    }
    const r = await executeGroupReaction({ turn: mkTurn('t1'), io: mkIo(), offeredMode: 'interject', participation: react(), groups, outbox, log: null, now: Date.now() })
    assert.equal(r.state, winnerState === 'sent' ? 'sent' : 'unknown')
    assert.equal(r.reason, winnerState === 'sent' ? 'duplicate-suppressed' : 'duplicate-in-flight')
    assert.equal(calls.length, 0)
    assert.equal(groups.speakTimes(GID).length, 0, '重复异常绝不记成功预算')
  }
})

test('锚点缺失 → skipped / react-anchor-missing，零 Outbox 调用', async () => {
  const groups = createGroupState() // 缓冲里没有锚点
  const { outbox, calls } = mkOutbox(() => ({}))
  const r = await executeGroupReaction({ turn: mkTurn('t1'), io: mkIo(), offeredMode: 'interject', participation: react(), groups, outbox, log: null, now: Date.now() })
  assert.deepEqual(r, { state: 'skipped', deliveryId: 'group-react:t1', reason: 'react-anchor-missing' })
  assert.equal(calls.length, 0)
})

test('漂移：锚点后非本人新消息达到 6 → skipped / react-drift；5 条（self 不计入）→ 照常执行', async () => {
  // mkGroups 的锚点后已有 2 条非本人消息（10002、99999），再补 driftCount 条凑边界
  const mkDrifted = (driftCount, padding) => {
    const groups = mkGroups()
    const now = Date.now()
    for (let i = 0; i < driftCount; i++) groups.appendMessage(GID, { t: now - 500 - i, uid: `60${i}`, nick: `路${i}`, text: `刷屏${i}`, mid: `4000${i}`, self: false })
    for (let i = 0; i < padding; i++) groups.appendMessage(GID, { t: now - 100 - i, uid: '20002', nick: '她', text: '自己的话', mid: `5000${i}`, self: true })
    return groups
  }
  { // 2 + 4 = 6 条真实漂移 → 放弃（阈值 = 文本漂移放弃阈值 6）
    const groups = mkDrifted(4, 3)
    const { outbox, calls } = mkOutbox(() => ({}))
    const r = await executeGroupReaction({ turn: mkTurn('t1'), io: mkIo(), offeredMode: 'interject', participation: react(), groups, outbox, log: null, now: Date.now() })
    assert.deepEqual(r, { state: 'skipped', deliveryId: 'group-react:t1', reason: 'react-drift' })
    assert.equal(calls.length, 0)
  }
  { // 2 + 3 = 5 条真实漂移，再加 3 条 self（不计入）→ 照常执行
    const groups = mkDrifted(3, 3)
    const { outbox, calls } = mkOutbox(() => ({}))
    const r = await executeGroupReaction({ turn: mkTurn('t1'), io: mkIo(), offeredMode: 'interject', participation: react(), groups, outbox, log: null, now: Date.now() })
    assert.equal(r.state, 'sent')
    assert.equal(calls.length, 1)
  }
})

test('前置防御：私聊 / 非 interject / 非 react 声明 / 非法 emoji / aborted / 锚点不属于本回合 → cancelled 零调用', async () => {
  const groups = mkGroups()
  const { outbox, calls } = mkOutbox(() => ({}))
  const run = (over = {}) => executeGroupReaction({
    turn: mkTurn('t1'), io: mkIo(), offeredMode: 'interject', participation: react(), groups, outbox, log: null, now: Date.now(), ...over,
  })
  assert.equal((await run({ turn: { turnId: 't1', chatKey: 'private:10001' } })).reason, 'react-not-group-chat')
  assert.equal((await run({ offeredMode: 'must' })).reason, 'react-not-interject')
  assert.equal((await run({ participation: { level: 'text_lite', limits: { maxBubbles: 1 } } })).reason, 'react-declaration-invalid')
  assert.equal((await run({ participation: { level: 'react', reaction: { messageId: MID_A, emojiId: 'abc' } } })).reason, 'react-declaration-invalid')
  assert.equal((await run({ participation: { level: 'react', reaction: { messageId: '0', emojiId: '66' } } })).reason, 'react-declaration-invalid')
  assert.equal((await run({ io: mkIo({ aborted: true }) })).reason, 'react-turn-aborted')
  assert.equal((await run({ io: mkIo({ members: [MID_B] }) })).reason, 'react-anchor-not-in-turn', '跨回合/非本回合成员一律拒绝')
  assert.equal((await run({ participation: { level: 'react', reaction: { messageId: '99999', emojiId: '66' } } })).reason, 'react-anchor-not-in-turn')
  assert.equal(calls.length, 0, '全部前置失败零网关调用')
  assert.equal(groups.speakTimes(GID).length, 0)
})

test('重启恢复：真实台账 WAL，sending → unknown，重入零第二次网关请求、attemptCount 不增加', async () => {
  const file = join(dataDir, `ledger-${Date.now()}.json`)
  const ledger1 = createDeliveryLedger({ file, onError: () => {} })
  ledger1.enqueue({ deliveryId: 'group-react:r1', chatKey: CHAT, turnId: 'r1', sourceModuleId: 'gp-mod', action: 'set_msg_emoji_like' })
  ledger1.mark('group-react:r1', 'sending') // 崩溃点：物理发送中
  // 进程重启：新台账实例从主快照 + WAL 恢复
  const ledger2 = createDeliveryLedger({ file, onError: () => {} })
  const rec = ledger2.get('group-react:r1')
  assert.equal(rec.state, 'unknown', 'sending → unknown（副作用未知）')
  assert.equal(rec.attemptCount, 1)
  const groups = mkGroups()
  const { outbox, calls } = mkOutbox(() => { throw new Error('不应该被调用') }, ledger2)
  const r = await executeGroupReaction({ turn: mkTurn('r1'), io: mkIo(), offeredMode: 'interject', participation: react(), groups, outbox, log: null, now: Date.now() })
  assert.deepEqual(r, { state: 'unknown', deliveryId: 'group-react:r1', reason: 'duplicate-suppressed' })
  assert.equal(calls.length, 0, '重启后重入零第二次网关请求')
  assert.equal(ledger2.get('group-react:r1').attemptCount, 1, 'attemptCount 不增加')
  assert.equal(groups.speakTimes(GID).length, 0)
})

test('outbox.request 抛 unknown:true 异常：unknown + 本回合成员标 fed（副作用未知抑制重复）+ 零成功预算', async () => {
  const groups = mkGroups()
  // 包装 outbox：request 直接抛 unknown 异常（模拟执行器外层未捕获的请求层异常）
  const calls = []
  const real = mkOutbox(() => ({}))
  const outbox = {
    ledger: real.outbox.ledger,
    request: async (req) => {
      calls.push(req)
      throw Object.assign(new Error('发送调用异常中断'), { unknown: true })
    },
  }
  const r = await executeGroupReaction({ turn: mkTurn('t1'), io: mkIo(), offeredMode: 'interject', participation: react(), groups, outbox, log: null, now: Date.now() })
  assert.deepEqual(r, { state: 'unknown', deliveryId: 'group-react:t1', reason: 'react-unknown' })
  assert.equal(calls.length, 1, '零重试')
  // 异常 unknown 路径也必须标 fed（副作用未知 → 成员按已处理抑制下一轮重复）
  const buf = groups.buffer(GID)
  assert.equal(buf.find((x) => x.mid === MID_A).fed, true)
  assert.equal(buf.find((x) => x.mid === MID_B).fed, true)
  assert.equal(Boolean(buf.find((x) => x.mid === '99999').fed), false, '旧消息不误标')
  assert.equal(groups.speakTimes(GID).length, 0, 'unknown 零成功预算')
  assert.equal(groups.interjectTimes(GID).length, 0)
})

test('turn.turnId 为空 / 缺失：cancelled / react-missing-turn-id，零 Outbox 调用', async () => {
  const groups = mkGroups()
  const { outbox, calls } = mkOutbox(() => ({}))
  const r1 = await executeGroupReaction({ turn: { turnId: '', chatKey: CHAT }, io: mkIo(), offeredMode: 'interject', participation: react(), groups, outbox, log: null, now: Date.now() })
  assert.deepEqual(r1, { state: 'cancelled', deliveryId: 'group-react:', reason: 'react-missing-turn-id' })
  const r2 = await executeGroupReaction({ turn: { chatKey: CHAT }, io: mkIo(), offeredMode: 'interject', participation: react(), groups, outbox, log: null, now: Date.now() })
  assert.equal(r2.reason, 'react-missing-turn-id')
  const r3 = await executeGroupReaction({ turn: { turnId: '   ', chatKey: CHAT }, io: mkIo(), offeredMode: 'interject', participation: react(), groups, outbox, log: null, now: Date.now() })
  assert.equal(r3.reason, 'react-missing-turn-id', '纯空白 turnId 同样拒绝（防重键碰撞）')
  assert.equal(calls.length, 0, '全部零网关调用')
})

test('normalizeReactionResultReason：reason 归一化为稳定短代码（Outbox 自由文本绝不透传）', () => {
  // 空串 / 白名单 / react-* 短代码原样保留
  assert.equal(normalizeReactionResultReason('sent', ''), '')
  assert.equal(normalizeReactionResultReason('sent', 'duplicate-suppressed'), 'duplicate-suppressed')
  assert.equal(normalizeReactionResultReason('unknown', 'duplicate-in-flight'), 'duplicate-in-flight')
  assert.equal(normalizeReactionResultReason('skipped', 'react-anchor-missing'), 'react-anchor-missing')
  assert.equal(normalizeReactionResultReason('skipped', 'react-drift'), 'react-drift')
  // Outbox 取消原因映射
  assert.equal(normalizeReactionResultReason('cancelled', 'dryRun'), 'outbox-dry-run')
  assert.equal(normalizeReactionResultReason('cancelled', '总开关关闭'), 'outbox-disabled')
  assert.equal(normalizeReactionResultReason('cancelled', 'authorize 拒绝'), 'outbox-unauthorized')
  assert.equal(normalizeReactionResultReason('cancelled', '身份泄露闸'), 'outbox-identity-guard')
  assert.equal(normalizeReactionResultReason('cancelled', '排队期间台账已变更（取消 / 重复请求）'), 'outbox-cancelled')
  // 其余自由文本 / 异常正文按 state 兜底
  assert.equal(normalizeReactionResultReason('failed', 'result=299 err=机器人不在群 30001 里 path=/x'), 'react-failed')
  assert.equal(normalizeReactionResultReason('unknown', '发送调用异常中断'), 'react-unknown')
  assert.equal(normalizeReactionResultReason('cancelled', '随便什么长文本'), 'react-cancelled')
  assert.equal(normalizeReactionResultReason('skipped', '随便什么'), 'react-skipped')
  assert.equal(normalizeReactionResultReason('sent', '多余的自由文本'), '', 'sent 恒为空串')
  // 未知 state 兜底
  assert.equal(normalizeReactionResultReason('mystery', '自由文本'), 'react-cancelled')
})
