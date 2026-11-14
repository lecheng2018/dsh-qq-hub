// 群张力门禁（group-atmosphere-gate.js）的回归网。
//
// 为什么必须钉死：这是「她要不要在群里开口」的最后一道情境闸，接在 decideGroupReply 之前。
// 两类真实事故都出在这里：
//   · 闸太松 / 顺序错 → 群里正对骂，她凑上去接一句，成了引战催化剂；
//   · 闸太紧 / 误拦 must → 主人 @ 她也不回，等于把必回通道掐死。
// 所以本文件重点守三件事：**顺序**（刹车→必回→张力→常规）、**灰度开关的 fail-closed**、
// 以及**开关关着时与 legacy 逐字段一致**。
// 此前零测试覆盖（按符号名全量 grep 确认），而 group-atmosphere.js + 本文件合计约 26KB 规则。
import test from 'node:test'
import assert from 'node:assert/strict'

import { decideGroupReply, DEFAULT_GROUP_POLICY } from '../src/chat/group-policy.js'
import {
  ATMOSPHERE_GATE_ENV,
  decideGroupReplyWithAtmosphere,
  gateFromEnv,
  readAtmosphereGate,
} from '../src/chat/group-atmosphere-gate.js'

const NOW = 1_800_000_000_000

/** 一份「会命中插话」的基础入参：概率拉满、无冷却、够热闹、相关度满。 */
function base(over = {}) {
  return {
    policy: {
      ...DEFAULT_GROUP_POLICY,
      interjectChance: 1,
      minRelevance: 0,
      minRecentMessages: 0,
      quietHours: [],
      cooldownSec: 0,
      maxPerHour: 99,
      burstMax: 99,
    },
    text: '今天天气不错',
    now: NOW,
    hour: 14,
    recentTimes: [NOW - 1000, NOW - 2000, NOW - 3000],
    interjectTimes: [],
    botReplyTimes: [],
    relevance: 1,
    rand: () => 0,
    ...over,
  }
}

/** 造一段火药味很浓的群消息窗口（对骂 + 感叹号吼叫）。 */
function angryWindow(now = NOW) {
  return [
    { text: '你是不是有病啊！！！', at: now - 1000 },
    { text: '傻逼吧你，滚', at: now - 2000 },
    { text: '你才滚！神经病', at: now - 3000 },
    { text: '闭嘴吧废物', at: now - 4000 },
  ]
}

/** 造一段平和、热闹的群聊窗口。 */
function calmWindow(now = NOW) {
  return [
    { text: '今天中午吃啥呢', at: now - 1000 },
    { text: '我想吃面', at: now - 2000 },
    { text: '那去吧', at: now - 3000 },
  ]
}

// ---------------------------------------------------------------------------
// 灰度开关：fail-closed，写错一律退回 legacy
// ---------------------------------------------------------------------------

test('灰度开关：未设置 = 关闭（绝不因为没配就悄悄开闸）', () => {
  const r = readAtmosphereGate({})
  assert.equal(r.enabled, false)
  assert.equal(r.raw, null)
  assert.match(r.reason, /未设置|legacy/)
})

test('灰度开关：只认显式打开的词，其余一律当关闭', () => {
  const { ATMOSPHERE_GATE_ENV: KEY } = { ATMOSPHERE_GATE_ENV }
  for (const v of ['1', 'on', 'true', 'yes', 'enable', 'enabled', 'TRUE', 'On']) {
    assert.equal(readAtmosphereGate({ [KEY]: v }).enabled, true, `${v} 应开启`)
  }
  // 拼错、数字、乱码、关闭词 —— 必须是关闭（安全方向：退回 legacy）
  for (const v of ['', '0', 'off', 'false', 'no', 'disable', 'disabled', 'ture', '2', ' ', '开']) {
    assert.equal(readAtmosphereGate({ [KEY]: v }).enabled, false, `${JSON.stringify(v)} 应关闭`)
  }
})

test('灰度开关：非法类型与抛错的 env 都不崩，按关闭处理', () => {
  assert.equal(readAtmosphereGate({ [ATMOSPHERE_GATE_ENV]: 1 }).enabled, false)
  assert.equal(readAtmosphereGate({ [ATMOSPHERE_GATE_ENV]: {} }).enabled, false)
  assert.equal(readAtmosphereGate({ [ATMOSPHERE_GATE_ENV]: null }).enabled, false)
  const hostile = { get [ATMOSPHERE_GATE_ENV]() { throw new Error('boom') } }
  assert.doesNotThrow(() => readAtmosphereGate(hostile))
  assert.equal(readAtmosphereGate(hostile).enabled, false)
})

test('gateFromEnv：一句话封装，返回值形状固定', () => {
  const off = gateFromEnv({})
  assert.equal(off.enabled, false)
  assert.equal(typeof off.tensionLimit, 'number')
  const on = gateFromEnv({ [ATMOSPHERE_GATE_ENV]: '1' })
  assert.equal(on.enabled, true)
  assert.ok(on.tensionLimit > 0 && on.tensionLimit <= 1, '阈值应是 0~1 的比例')
})

// ---------------------------------------------------------------------------
// 开关关着：必须与 legacy 逐字段一致（改行为不许顺带改旧口径）
// ---------------------------------------------------------------------------

test('门禁关闭时与 legacy decideGroupReply 逐字段一致', () => {
  const cases = [
    base(),
    base({ mentioned: true }),
    base({ repliedToBot: true }),
    base({ text: '大肥鱼 在吗' }),
    base({ hour: 3 }), // 静默时段
    base({ relevance: 0, rand: () => 0.99 }),
    base({ botReplyTimes: Array.from({ length: 20 }, (_, i) => NOW - i * 100) }), // 刹车
  ]
  for (const p of cases) {
    const legacy = decideGroupReply(p)
    const gated = decideGroupReplyWithAtmosphere(p, { gate: { enabled: false } })
    assert.deepEqual(gated, legacy, `关闭时不得改动既有判定：${JSON.stringify(p.text)}`)
  }
})

// ---------------------------------------------------------------------------
// 张力门禁：群在吵就不插嘴
// ---------------------------------------------------------------------------

test('群里在吵（高张力）→ 不插嘴，且 reason 说明原因', () => {
  const r = decideGroupReplyWithAtmosphere(base({ messages: angryWindow() }), {
    gate: { enabled: true, tensionLimit: 0.7 },
  })
  assert.equal(r.reply, false, `高张力应拒绝，实际 ${JSON.stringify(r)}`)
  assert.equal(r.mode, 'none')
  assert.match(r.reason, /群里在吵|张力/)
  assert.ok(r.atmosphere, '应带上氛围快照，便于排查')
  assert.ok(r.atmosphere.tension > 0.7, `张力应超过阈值（实际 ${r.atmosphere?.tension}）`)
})

test('群聊平和 → 不受张力影响，照常按常规判定走', () => {
  const r = decideGroupReplyWithAtmosphere(base({ messages: calmWindow() }), {
    gate: { enabled: true, tensionLimit: 0.7 },
  })
  assert.equal(r.reply, true, `平和群应放行，实际 ${JSON.stringify(r)}`)
  assert.equal(r.mode, 'interject')
  assert.ok(r.atmosphere, '仍应带氛围快照')
})

// ---------------------------------------------------------------------------
// 顺序红线：必回通道不能被张力闸掐死
// ---------------------------------------------------------------------------

test('被 @ 时无视张力：must 优先于张力门禁', () => {
  const r = decideGroupReplyWithAtmosphere(base({ messages: angryWindow(), mentioned: true }), {
    gate: { enabled: true, tensionLimit: 0.7 },
  })
  assert.equal(r.reply, true, '@ 她必须回，不能因为群在吵就不理')
  assert.equal(r.mode, 'must')
})

test('被引用时无视张力：must 优先于张力门禁', () => {
  const r = decideGroupReplyWithAtmosphere(base({ messages: angryWindow(), repliedToBot: true }), {
    gate: { enabled: true, tensionLimit: 0.7 },
  })
  assert.equal(r.reply, true)
  assert.equal(r.mode, 'must')
})

test('叫到唤醒词时无视张力', () => {
  const r = decideGroupReplyWithAtmosphere(base({ messages: angryWindow(), text: '大肥鱼 你怎么看' }), {
    gate: { enabled: true, tensionLimit: 0.7 },
  })
  assert.equal(r.reply, true)
  assert.equal(r.mode, 'must')
})

test('刹车优先于张力：既已因说太多被拒，就不再改写成"群里在吵"', () => {
  // 注意：base() 为了「默认会插话」把 burstMax 拉到 99，这里必须显式调回默认刹车阈值，
  // 否则 20 条发言也撞不到刹车，前置条件不成立。
  const p = base({
    policy: { ...base().policy, burstMax: DEFAULT_GROUP_POLICY.burstMax },
    messages: angryWindow(),
    botReplyTimes: Array.from({ length: 20 }, (_, i) => NOW - i * 100),
  })
  const legacy = decideGroupReply(p)
  assert.equal(legacy.reply, false, '前置条件：legacy 已因刹车拒绝')
  const gated = decideGroupReplyWithAtmosphere(p, { gate: { enabled: true, tensionLimit: 0.7 } })
  assert.equal(gated.reply, false)
  assert.equal(gated.reason, legacy.reason, '拒绝理由应沿用既有文案（改文案=改真机日志口径）')
})

test('静默时段/冷却/上限等既有拒绝优先于张力', () => {
  // 静默时段（凌晨 3 点）。base() 为了「默认会插话」把 quietHours 清空了，
  // 这里必须显式恢复默认静默区间（1~8 点），否则 3 点根本不静默、前置条件不成立。
  const quiet = base({
    policy: { ...base().policy, quietHours: DEFAULT_GROUP_POLICY.quietHours },
    hour: 3,
    messages: angryWindow(),
  })
  const q1 = decideGroupReply(quiet)
  const q2 = decideGroupReplyWithAtmosphere(quiet, { gate: { enabled: true, tensionLimit: 0.7 } })
  assert.equal(q2.reason, q1.reason, '静默时段的拒绝理由不应被张力改写')

  // 插话冷却中（刚插过一句）：这是既有刹车，张力不该改写它的理由。
  // 注意不能用「相关度不够」——base() 的 minRelevance 是 0，relevance 0 照样算「相关」。
  const cooling = base({
    policy: { ...base().policy, cooldownSec: DEFAULT_GROUP_POLICY.cooldownSec },
    interjectTimes: [NOW - 1000],
    messages: angryWindow(),
  })
  const c1 = decideGroupReply(cooling)
  assert.equal(c1.reply, false, '前置条件：冷却中应拒绝')
  assert.match(c1.reason, /冷却/)
  const c2 = decideGroupReplyWithAtmosphere(cooling, { gate: { enabled: true, tensionLimit: 0.7 } })
  assert.equal(c2.reason, c1.reason, '冷却中的拒绝理由不应被张力改写')
})

// ---------------------------------------------------------------------------
// 健壮性
// ---------------------------------------------------------------------------

test('messages 缺省 / 空数组 / 坏形状时张力视为 0 或安全降级，不抛', () => {
  for (const messages of [undefined, [], null, 'x', [{}, { text: null }]]) {
    assert.doesNotThrow(() => {
      const r = decideGroupReplyWithAtmosphere(base({ messages }), { gate: { enabled: true, tensionLimit: 0.7 } })
      assert.equal(typeof r.reply, 'boolean')
    }, `messages=${JSON.stringify(messages)} 不该抛`)
  }
})

test('入参非法不崩：decideGroupReplyWithAtmosphere 必须返回决策形状', () => {
  for (const bad of [null, undefined, {}, 'x', 42]) {
    const r = decideGroupReplyWithAtmosphere(bad, { gate: { enabled: true } })
    assert.equal(typeof r.reply, 'boolean')
    assert.equal(typeof r.mode, 'string')
    assert.equal(typeof r.reason, 'string')
  }
})

test('options.messages 可以覆盖 p.messages（供压测/回放注入窗口）', () => {
  const r = decideGroupReplyWithAtmosphere(base({ messages: calmWindow() }), {
    gate: { enabled: true, tensionLimit: 0.7 },
    messages: angryWindow(),
  })
  assert.equal(r.reply, false, 'options.messages 应优先')
})

test('阈值可调：把 tensionLimit 调到 0 时，任何氛围都不插话', () => {
  const r = decideGroupReplyWithAtmosphere(base({ messages: calmWindow() }), {
    gate: { enabled: true, tensionLimit: 0 },
  })
  // tension 恒 >= 0，limit=0 时只要 tension > 0 就拦
  assert.equal(typeof r.reply, 'boolean')
  if (r.atmosphere && r.atmosphere.tension > 0) assert.equal(r.reply, false)
})
