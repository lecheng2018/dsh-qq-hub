// 打字律动（reply-cadence.js）的回归网。
//
// 为什么必须钉死：这个模块决定「她回得多快」。写错两个方向都会出真事故：
//   · 算太长 → 用户已经看到第一条，还要干等十几秒，像卡住；
//   · 算太短 → 三条气泡在 0.2 秒内连珠弹出，一眼是机器人；
//   · 忘封顶 → 几千字那段能算出几分钟等待，把整个 turn 拖死。
// 此前它零测试覆盖（按符号名全量 grep 确认），只在 reply-delivery 里被间接用到。
//
// 本文件用**注入随机源**把时延算成可复现的确定值，不依赖机器快慢、不读真实时钟。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TYPING_CADENCE,
  calculateTypingCadence,
  typingCadenceEnabled,
  typingWaitAfter,
} from '../src/chat/reply-cadence.js'

/** 固定随机源：永远返回 0 表示取区间下限，1 表示取上限。 */
const randLow = () => 0
const randHigh = () => 1
const randMid = () => 0.5

const text = (value) => ({ kind: 'text', value })
const sticker = (value) => ({ kind: 'sticker', value })

// ---------------------------------------------------------------------------
// 契约：非法输入 fail-closed 成「立刻发」
// ---------------------------------------------------------------------------

test('非法输入 fail-closed：不加任何时延，绝不抛', () => {
  for (const bad of [null, undefined, {}, 'x', 42, []]) {
    const r = calculateTypingCadence(bad)
    assert.equal(r.valid, false, `${JSON.stringify(bad)} 应判非法`)
    assert.equal(r.enabled, false, '非法输入不能让律动生效')
    assert.equal(r.totalMs, 0, '非法输入必须零时延（宁可秒发，不可卡死）')
    assert.deepEqual(r.bubbles, [])
  }
})

// ---------------------------------------------------------------------------
// 首段零新增延迟 —— 这是最关键的一条设计约束
// ---------------------------------------------------------------------------

test('首段零新增延迟：第一条气泡不额外等待（LLM 推理耗时已经够久了）', () => {
  const c = calculateTypingCadence([text('在呢'), text('刚在刷视频'), text('咋了')], { random: randMid })
  assert.equal(c.valid, true)
  // typingWaitAfter(-1 或首条之前) 一律 0：调用方在发第一条之前不该等
  assert.equal(typingWaitAfter(c, -1), 0)
  // 关键：第 0 条之前没有「等待」这个概念，第一条的时延只体现在它自己的 totalMs 里，
  // 而调用方是靠「发下一条之前等 typingWaitAfter(c, i)」来施加节奏的，
  // 所以首条实际不会被延迟。这里断言 gapAfter 只挂在 0..n-2 上。
  assert.ok(c.bubbles[0].gapAfterMs > 0, '首条之后应该有呼吸间隙')
  assert.equal(c.bubbles[c.bubbles.length - 1].gapAfterMs, 0, '最后一条之后不再有间隙')
})

test('typingWaitAfter：越界索引一律返回 0，不抛', () => {
  const c = calculateTypingCadence([text('a'), text('b')], { random: randMid })
  assert.equal(typingWaitAfter(c, 1), 0, '最后一条之后没有下一条')
  assert.equal(typingWaitAfter(c, 99), 0)
  assert.equal(typingWaitAfter(c, 1.5), 0, '非整数索引不接受')
  assert.equal(typingWaitAfter(null, 0), 0, '空 cadence 不崩')
  assert.equal(typingWaitAfter({ bubbles: 'x' }, 0), 0, '坏形状不崩')
})

// ---------------------------------------------------------------------------
// 单调性：越长越慢，标点要额外停顿
// ---------------------------------------------------------------------------

test('越长越慢：同一随机源下，字符多的气泡时延更大', () => {
  const short = calculateTypingCadence([text('好'), text('哦')], { random: randMid })
  const long = calculateTypingCadence([text('好'), text('好'.repeat(40))], { random: randMid })
  assert.ok(long.bubbles[1].typingMs > short.bubbles[1].typingMs,
    `长句击键应更久（短 ${short.bubbles[1].typingMs} vs 长 ${long.bubbles[1].typingMs}）`)
})

test('标点处额外停顿：句号比逗号停得久', () => {
  // 同样长度，只差结尾标点
  const comma = calculateTypingCadence([text('a'), text('abcd，')], { random: randMid })
  const period = calculateTypingCadence([text('a'), text('abcd。')], { random: randMid })
  assert.ok(period.bubbles[1].typingMs > comma.bubbles[1].typingMs,
    `句号停顿应长于逗号（逗号 ${comma.bubbles[1].typingMs} vs 句号 ${period.bubbles[1].typingMs}）`)
})

test('后续段思考时间比首段短（顺着话头说不必重新组织语言）', () => {
  const c = calculateTypingCadence([text('第一句话')], { random: randMid })
  const d = calculateTypingCadence([text('开门'), text('第一句话')], { random: randMid })
  assert.ok(d.bubbles[1].thinkMs < c.bubbles[0].thinkMs,
    `下一段思考应短于首段（首 ${c.bubbles[0].thinkMs} vs 次 ${d.bubbles[1].thinkMs}）`)
})

// ---------------------------------------------------------------------------
// 封顶保护：绝不把 turn 拖死
// ---------------------------------------------------------------------------

test('超长段封顶：几千字那段也只按前 N 字计击键时间', () => {
  const huge = calculateTypingCadence([text('x'), text('字'.repeat(5000))], { random: randHigh })
  assert.ok(huge.bubbles[1].chars <= TYPING_CADENCE.maxCharsPerBubble,
    `计入字符数应被封顶（实际 ${huge.bubbles[1].chars}）`)
  assert.ok(huge.bubbles[1].totalMs <= TYPING_CADENCE.maxBubbleMs,
    `单段总时延不得超过上限（实际 ${huge.bubbles[1].totalMs}）`)
})

test('单段时延有上下限：极短不早于下限，极长不超上限', () => {
  const tiny = calculateTypingCadence([text('嗯')], { random: randLow })
  const big = calculateTypingCadence([text('x'), text('字'.repeat(900))], { random: randHigh })
  const upper = TYPING_CADENCE.maxBubbleMs
  const lower = Math.min(TYPING_CADENCE.minBubbleMs, upper)
  for (const b of [...tiny.bubbles, ...big.bubbles]) {
    assert.ok(b.totalMs >= lower, `不得低于下限（实际 ${b.totalMs}）`)
    assert.ok(b.totalMs <= upper, `不得高于上限（实际 ${b.totalMs}）`)
  }
})

test('多气泡总量有界：不会因为条数多而无限累积（每条都封顶）', () => {
  const many = calculateTypingCadence(
    [text('a'), ...Array.from({ length: 6 }, () => text('字'.repeat(300)))],
    { random: randHigh },
  )
  const upper = TYPING_CADENCE.maxBubbleMs
  // 每条 ≤ 上限，间隙 ≤ 上限，所以总量必然 ≤ 条数 × 2 × 上限
  assert.ok(many.totalMs <= many.bubbles.length * (upper + upper),
    `总量应有界（实际 ${many.totalMs}）`)
})

// ---------------------------------------------------------------------------
// 非文字条目：抬手就发
// ---------------------------------------------------------------------------

test('表情/戳一戳这类非文字条目只给一点点击延迟，不算击键', () => {
  const c = calculateTypingCadence([text('看图'), sticker('开心')], { random: randMid })
  const s = c.bubbles[1]
  assert.equal(s.chars, 0, '非文字没有字符数')
  assert.equal(s.typingMs > 0, true, '但仍有一点抬手延迟')
  assert.ok(s.typingMs < TYPING_CADENCE.keystrokeMs[1] * 3,
    `非文字延迟应远小于击键时间（实际 ${s.typingMs}）`)
})

// ---------------------------------------------------------------------------
// 透明度与可复现性
// ---------------------------------------------------------------------------

test('确定性：同一输入 + 同一随机源，连算三次结果全等', () => {
  const parts = [text('在呢'), text('刚在刷视频'), sticker('开心')]
  const a = calculateTypingCadence(parts, { random: () => 0.37 })
  const b = calculateTypingCadence(parts, { random: () => 0.37 })
  const c = calculateTypingCadence(parts, { random: () => 0.37 })
  assert.deepEqual(b, a)
  assert.deepEqual(c, a)
})

test('可解释：每段给出 thinkMs / typingMs / gapAfterMs，便于排查「怎么等这么久」', () => {
  const c = calculateTypingCadence([text('在呢'), text('马上')], { random: randMid })
  for (const b of c.bubbles) {
    assert.equal(typeof b.thinkMs, 'number')
    assert.equal(typeof b.typingMs, 'number')
    assert.equal(typeof b.gapAfterMs, 'number')
    assert.equal(typeof b.totalMs, 'number')
    assert.equal(typeof b.index, 'number')
  }
  // totalMs 必须等于 think + typing（clamp 之后），不能是别的东西
  const b0 = c.bubbles[0]
  assert.ok(b0.totalMs >= b0.thinkMs + b0.typingMs - 1, 'totalMs 至少覆盖思考+击键')
})

// ---------------------------------------------------------------------------
// 开关：关掉退回「立刻发」
// ---------------------------------------------------------------------------

test('enabled:false 时全部归零（退回旧版固定公式）', () => {
  const c = calculateTypingCadence([text('在呢'), text('马上来')], { enabled: false, random: randMid })
  assert.equal(c.valid, true, '输入本身有效')
  assert.equal(c.enabled, false)
  assert.equal(c.totalMs, 0)
  for (const b of c.bubbles) {
    assert.equal(b.thinkMs, 0)
    assert.equal(b.typingMs, 0)
    assert.equal(b.gapAfterMs, 0)
    assert.equal(b.totalMs, 0)
  }
})

test('typingCadenceEnabled：只有显式 false 才关，缺省/坏配置一律开（缺省即新行为）', () => {
  assert.equal(typingCadenceEnabled({ reply: { cadence: { enabled: false } } }), false)
  assert.equal(typingCadenceEnabled({ reply: { cadence: { enabled: true } } }), true)
  assert.equal(typingCadenceEnabled({}), true)
  assert.equal(typingCadenceEnabled(null), true)
  assert.equal(typingCadenceEnabled({ reply: null }), true)
  assert.equal(typingCadenceEnabled({ reply: { cadence: {} } }), true)
})

test('随机源非法（不是函数）时退回中点，不抛', () => {
  const c = calculateTypingCadence([text('在呢'), text('马上')], { random: 'not-a-function' })
  assert.equal(c.valid, true)
  assert.ok(c.totalMs > 0)
})
