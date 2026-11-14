// 四态话语权与收尾算法（计划书 v3.4 阶段 0b 验收）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMINANT, BALANCED, YIELDING, CLOSED, MUTE_LOCK_MS, closureUpdate as update, detectSignal, lengthTrend } from '../src/chat/conversation-closure.js'

const HOUR = 60 * 60 * 1000
// 走一轮（把上一轮返回值喂回去，模拟真实调用）
const step = (state, signal) => update(state, signal)

test('四态常量是稳定字符串，CLOSED 硬锁正好一小时', () => {
  assert.equal(DOMINANT, 'dominant')
  assert.equal(BALANCED, 'balanced')
  assert.equal(YIELDING, 'yielding')
  assert.equal(CLOSED, 'closed')
  assert.equal(MUTE_LOCK_MS, HOUR)
})

test('空历史 → BALANCED，输出形状齐全且是纯函数', () => {
  const r = update(null, {})
  assert.equal(r.state, BALANCED)
  assert.equal(typeof r.maxBubbles, 'number')
  assert.equal(r.muteLockMs, 0)
  assert.equal(r.allowQuestion, true)
  assert.deepEqual(update(null, {}), r, '同样输入必须同样输出')
  assert.deepEqual(update(undefined, {}), r, 'undefined 等同首轮')
})

test('空历史不回写调用方对象（无副作用）', () => {
  const signal = { lengths: [10] }
  const snapshot = JSON.parse(JSON.stringify(signal))
  update(null, signal)
  assert.deepEqual(signal, snapshot)
})

test('对方展开/反问 → DOMINANT，气泡上限最高且允许反问', () => {
  const bal = update(null, { text: '今天去看了展，人挺多的' })
  assert.equal(bal.state, BALANCED)
  const asked = update(bal, { text: '你觉得这种展览值得再去一次吗？' })
  assert.equal(asked.state, DOMINANT)
  assert.equal(asked.reason, 'question')
  assert.equal(asked.allowQuestion, true)
  assert.ok(asked.maxBubbles >= bal.maxBubbles)
  assert.equal(asked.muteLockMs, 0)

  const longer = update(bal, { lengths: [8, 20] })
  assert.equal(longer.state, DOMINANT)
  assert.equal(longer.reason, 'length-up')
})

test('连续单字附和 → YIELDING（第一句就收缩，第二句确认为附和）', () => {
  let s = update(null, { text: '今天加班到十点' })
  assert.equal(s.state, BALANCED)
  s = step(s, { text: '嗯' })
  assert.equal(s.state, YIELDING, '第一句附和就已经收缩')
  assert.equal(s.ackStreak, 1)
  s = step(s, { text: '哦' })
  assert.equal(s.state, YIELDING)
  assert.equal(s.reason, 'ack-streak', '第二条附和高亮为「把话头交回去了」')
  assert.equal(s.ackStreak, 2)
  assert.equal(s.allowQuestion, false, '收缩态不该再反问')
  assert.equal(s.maxBubbles, 1)
  assert.ok(s.muteLockMs > 0 && s.muteLockMs < HOUR)
})

test('附和到底 → CLOSED，且带 60 分钟硬锁、不带问句', () => {
  let s = update(null, { text: '在吗' })
  for (const t of ['嗯', '嗯嗯', '哦', '好']) s = step(s, { text: t })
  assert.equal(s.state, CLOSED)
  assert.equal(s.reason, 'ack-streak-closed')
  assert.equal(s.muteLockMs, HOUR)
  assert.equal(s.allowQuestion, false)
})

test('隔着实质内容的单字附和不算连续（不升级为 CLOSED）', () => {
  let s = update(null, { text: '在吗' })
  s = step(s, { text: '嗯' })
  s = step(s, { text: '刚才在看电影' })
  s = step(s, { text: '哦' })
  assert.equal(s.ackStreak, 1)
  assert.equal(s.state, YIELDING)
})

test('YIELDING 里对方重新反问／展开 → 回到 DOMINANT', () => {
  let s = update(null, { lengths: [20, 2] })
  assert.equal(s.state, YIELDING)
  s = step(s, { text: '那你说说如果是你会怎么选？' })
  assert.equal(s.state, DOMINANT)
  assert.equal(s.maxBubbles, 3)
  assert.equal(s.muteLockMs, 0, '重新展开要解掉礼让期的主动搭话短锁')
})

test('中间插一句实质内容会把附和计数归零', () => {
  let s = update(null, { text: '在吗' })
  s = step(s, { text: '嗯' })
  s = step(s, { text: '其实我刚刚在想那个方案' })
  assert.equal(s.state, BALANCED, '有内容就回到对等')
  assert.equal(s.ackStreak, 0)
})

test('道别词 → CLOSED，muteLockMs 恰为 60*60*1000 且建议发言不带问句', () => {
  const s = update(update(null, { text: '聊得挺开心' }), { text: '我先去洗澡啦，拜拜' })
  assert.equal(s.state, CLOSED)
  assert.equal(s.reason, 'farewell')
  assert.equal(s.muteLockMs, 60 * 60 * 1000)
  assert.equal(s.allowQuestion, false)
  assert.equal(s.maxBubbles, 1)

  // 单独跑也成立（不依赖上一轮）
  const cold = update(null, { text: '晚安' })
  assert.equal(cold.state, CLOSED)
  assert.equal(cold.muteLockMs, HOUR)
})

test('CLOSED 是粘滞的：再来一句「嗯」仍关闭，有实质内容才重新打开', () => {
  let s = update(null, { text: '拜拜' })
  assert.equal(s.state, CLOSED)
  s = step(s, { text: '嗯' })
  assert.equal(s.state, CLOSED)
  assert.equal(s.reason, 'closed-sticky')
  s = step(s, { text: '诶对了你上次说的那个店叫什么' })
  assert.equal(s.state, BALANCED)
  assert.equal(s.reason, 'reopened')
})

test('对方回话越来越短 → YIELDING，越来越长 → DOMINANT', () => {
  const down = update(null, { lengths: [30, 5, 2, 1] })
  assert.equal(down.state, YIELDING)
  assert.equal(down.reason, 'length-down')
  const up = update(null, { lengths: [2, 5, 30] })
  assert.equal(up.state, DOMINANT)
  assert.equal(up.trend, 'up')
})

test('长度趋势：只有一轮或涨跌不明显算 flat', () => {
  assert.equal(lengthTrend([]), 'flat')
  assert.equal(lengthTrend([12]), 'flat')
  assert.equal(lengthTrend([10, 11]), 'flat')
  assert.equal(lengthTrend([20, 45]), 'up')
  assert.equal(lengthTrend([0, 0]), 'flat')
})

test('超短但有内容的回话也算「没劲了」→ YIELDING', () => {
  const s = update(null, { lengths: [5, 4] }) // 跌得不够 TREND_RATIO，但确实很短
  assert.equal(s.trend, 'flat')
  assert.equal(s.state, YIELDING)
  assert.equal(s.reason, 'short-reply')
})

test('信号可由原始文本推断（问句/附和/道别）', () => {
  assert.equal(detectSignal('你在干嘛呢').isQuestion, true)
  assert.equal(detectSignal('吃了吗?').isQuestion, true)
  assert.equal(detectSignal('嗯嗯').isAck, true)
  assert.equal(detectSignal('OK！').isAck, true)
  assert.equal(detectSignal('今天好累啊').isAck, false, '「啊」结尾的实义句不算附和')
  assert.equal(detectSignal('那明天见').isFarewell, true)
  assert.equal(detectSignal('').isAck, false)
  assert.equal(detectSignal(null).length, 0)
})

test('显式标记优先于文本推断（结构化调用方不必再喂原文）', () => {
  const s = update(null, { text: '嗯', isFarewell: false, isAck: false })
  assert.equal(s.ackStreak, 0, '显式 false 覆盖文本推断')
})

test('异常输入抛明确 TypeError（fail-closed，不静默吞）', () => {
  assert.throws(() => update('balanced', {}), { name: 'TypeError', message: /state 必须是对象或 null/ })
  assert.throws(() => update([], {}), TypeError)
  assert.throws(() => update({ state: 'sleeping' }, {}), { name: 'TypeError', message: /未知状态 sleeping/ })
  assert.throws(() => update(null, null), { name: 'TypeError', message: /signal 必须是对象/ })
  assert.throws(() => update(null, 'hi'), TypeError)
  assert.throws(() => update(null, []), TypeError)
  assert.throws(() => update(null, { lengths: 'abc' }), { name: 'TypeError', message: /lengths 必须是数字数组/ })
  assert.throws(() => update(null, { lengths: [1, -2] }), TypeError)
  assert.throws(() => update(null, { lengths: [Number.NaN] }), TypeError)
  assert.throws(() => update(null, { trend: 'sideways' }), { name: 'TypeError', message: /trend/ })
  assert.throws(() => update(null, { isQuestion: 'yes' }), { name: 'TypeError', message: /isQuestion 必须是布尔值/ })
  assert.throws(() => update(null, { text: 42 }), { name: 'TypeError', message: /text 必须是字符串/ })
  assert.throws(() => update({ state: BALANCED, ackStreak: -1 }, {}), TypeError)
  assert.throws(() => update({ state: BALANCED, turns: 1.5 }, {}), TypeError)
})

test('turn 计数会累加，空白信号不推进话轮', () => {
  let s = update(null, { text: '在吗' })
  assert.equal(s.turns, 1)
  s = step(s, { text: '在的' })
  assert.equal(s.turns, 2)
  s = step(s, {})
  assert.equal(s.turns, 2, '空信号只是重申状态，不算对方说话')
})

test('四个状态都能作为上一轮状态被接续（迁移不抛）', () => {
  for (const st of [DOMINANT, BALANCED, YIELDING, CLOSED]) {
    const r = update({ state: st, ackStreak: 0, turns: 3 }, { text: '继续说' })
    assert.ok([DOMINANT, BALANCED, YIELDING, CLOSED].includes(r.state), `${st} → ${r.state}`)
    assert.equal(r.turns, 4)
  }
})

test('回归：升级到 CLOSED 后 muteLockMs 是 HOUR，绝不会返回 undefined', () => {
  for (const sig of [{ text: '晚安' }, { text: '拜拜' }, { lengths: [9, 1, 1, 1, 1] }]) {
    const s = update(null, sig)
    assert.equal(typeof s.muteLockMs, 'number')
    if (s.state === CLOSED) assert.equal(s.muteLockMs, HOUR)
  }
})
