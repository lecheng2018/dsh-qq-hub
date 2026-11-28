// T2.3 TEXT_LITE 真实行为测试：applyTextLiteRules 纯函数语义 + 真实穿过 reply-delivery 的
// parseReply / groupLimit 群合包（收紧生效、绝不放宽原规则、must/engaged/私聊零影响、
// forceReport / 代码块 / 引用 / ||| / 非文本段不被截坏）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyTextLiteRules } from '../src/chat/text-lite.js'
import { createReplyDelivery } from '../src/chat/reply-delivery.js'

const log = { info() {}, warn() {}, debug() {} }

// ---------- 纯函数 ----------

test('applyTextLiteRules：只收紧不放宽，返回新对象且不改原始输入', () => {
  const rules = { maxChars: 40, maxBubbles: 6, keepReports: true }
  const limits = { maxBubbles: 2, maxChars: 80 }
  const out = applyTextLiteRules(rules, limits)
  assert.deepEqual(out, { maxChars: 40, maxBubbles: 2, softMaxBubbles: 2, keepReports: true })
  assert.equal(rules.maxBubbles, 6, '原始 rules 不被修改')
  assert.equal(rules.maxChars, 40)
  assert.deepEqual(limits, { maxBubbles: 2, maxChars: 80 }, '原始 limits 不被修改')
  assert.notEqual(out, rules)
  // 原规则更严：保持原值
  assert.equal(applyTextLiteRules({ maxBubbles: 1, maxChars: 20 }, { maxBubbles: 3, maxChars: 100 }).maxBubbles, 1)
  assert.equal(applyTextLiteRules({ maxBubbles: 1, maxChars: 20 }, { maxBubbles: 3, maxChars: 100 }).maxChars, 20)
  // 原规则更松：收紧到插件值
  assert.equal(applyTextLiteRules({ maxBubbles: 6, maxChars: 120 }, { maxBubbles: 2, maxChars: 80 }).maxBubbles, 2)
  assert.equal(applyTextLiteRules({ maxBubbles: 6, maxChars: 120 }, { maxBubbles: 2, maxChars: 80 }).maxChars, 80)
})

test('applyTextLiteRules：softMaxBubbles 原值有效则取最小，不存在时用收紧后的 maxBubbles', () => {
  assert.equal(applyTextLiteRules({ maxBubbles: 6, softMaxBubbles: 4 }, { maxBubbles: 2 }).softMaxBubbles, 2)
  assert.equal(applyTextLiteRules({ maxBubbles: 6, softMaxBubbles: 1 }, { maxBubbles: 2 }).softMaxBubbles, 1, '原软顶更严则保留')
  const out = applyTextLiteRules({ maxBubbles: 6 }, { maxBubbles: 2 })
  assert.equal(out.softMaxBubbles, 2, '缺省时用收紧后的 maxBubbles')
  // 缺失/非法 limits 原样返回
  assert.deepEqual(applyTextLiteRules({ maxBubbles: 6 }, undefined), { maxBubbles: 6 })
  assert.deepEqual(applyTextLiteRules({ maxBubbles: 6 }, null), { maxBubbles: 6 })
  assert.deepEqual(applyTextLiteRules({ maxBubbles: 6 }, []), { maxBubbles: 6 })
  assert.deepEqual(applyTextLiteRules({ maxBubbles: 6 }, { maxBubbles: 0, maxChars: -3 }), { maxBubbles: 6 }, '非法值不生效')
})

// ---------- 真实穿过 reply-delivery（groupLimit / parseReply） ----------

function fixture(overrides = {}, replyConfig = {}) {
  const sent = []
  const config = {
    ownerQQ: 'owner',
    voice: { enabled: false, autoChance: 0, autoMaxChars: 300 },
    stickers: { enabled: false, autoChance: 0 },
    reply: { maxBubbles: 3, groupMaxChars: 40, ...replyConfig },
  }
  const groups = { refs: () => ({}), leaveTopic() {}, noteSpeak() {}, noteSpokeInGroup() {} }
  const delivery = createReplyDelivery({
    getConfig: () => config,
    log,
    hooks: {},
    groups,
    stickers: { match: () => null, pickForReply: () => null },
    interaction: { queueAside() {} },
    sendText: async (chatId, text) => { sent.push({ chatId, kind: 'text', text }); return { message_id: 1 } },
    sendVoice: async (chatId, text) => { sent.push({ chatId, kind: 'voice', text }); return { message_id: 2 } },
    sendSticker: async (chatId, value) => { sent.push({ chatId, kind: 'sticker', value }); return { message_id: 3 } },
    sendImage: async (chatId, value) => { sent.push({ chatId, kind: 'image', value }); return { message_id: 4 } },
    sendMixed: async (chatId, parts) => { sent.push({ chatId, kind: 'mixed', parts }); return { message_id: 5 } },
    pokeBack: async () => {},
    sleep: async () => {},
    // 固定随机源：自动分条/合并使用 rules.rand，不注入会让气泡数非确定
    random: () => 0.5,
    ...overrides,
  })
  return { delivery, sent }
}

// 三句话各 ~11 字：默认群规则 maxChars 40 → 自动合成 1 条；maxChars 20 → 3 条
const LONG = '今天天气真的很不错呀。我们出去走走怎么样呢。顺便带点喝的也是可以的。'

test('群合包：text_lite 收紧后的 maxBubbles 真实生效（groupLimit=1 → 3 条自动气泡合 1）', async () => {
  // 先证明：宽松的 explicit ||| 三条在默认 groupLimit(3) 下发 3 条
  const { delivery: d0, sent: sent0 } = fixture()
  await d0.deliverNow('group:30001', '一|||二|||三', { participationLevel: 'full', topicMode: 'interject' })
  assert.equal(sent0.length, 3, '前置：默认规则 3 条 ||| 各自发出')

  // text_lite maxBubbles 1 → groupLimit 收紧到 1 → 合包成 1 条（内容不丢）
  const { delivery, sent } = fixture()
  const result = await delivery.deliverNow('group:30001', '一|||二|||三', {
    participationLevel: 'text_lite', textLiteLimits: { maxBubbles: 1, maxChars: 80 }, topicMode: 'interject',
  })
  assert.equal(sent.length, 1, '收紧后的 maxBubbles 真实穿过群合包')
  assert.match(sent[0].text, /一/, '内容合并不丢字')
  assert.match(sent[0].text, /三/)
  assert.equal(result.state, 'sent')
})

test('群合包：maxChars 收紧改变自动分条目标（40 → 20：1 条变 3 条更短的分条）', async () => {
  const { delivery: d0, sent: sent0 } = fixture()
  const r0 = await d0.deliverNow('group:30001', LONG, { participationLevel: 'full', topicMode: 'interject' })
  assert.equal(sent0.length, 1, `前置：默认 maxChars 40 合成 1 条（实际 ${sent0.length}）`)

  const { delivery, sent } = fixture()
  await delivery.deliverNow('group:30001', LONG, {
    participationLevel: 'text_lite', textLiteLimits: { maxChars: 20 }, topicMode: 'interject',
  })
  assert.ok(sent.length >= 2, `maxChars 20 应切出多条更短的气泡（实际 ${sent.length}）`)
  for (const item of sent) assert.ok(item.text.length <= 22, `每条不超过收紧目标（${item.text.length} 字）`)
})

test('不能放宽：原规则 maxBubbles=1 时插件给 3 也仍发 1 条', async () => {
  const { delivery, sent } = fixture({}, { maxBubbles: 1 })
  await delivery.deliverNow('group:30001', '一|||二|||三', {
    participationLevel: 'text_lite', textLiteLimits: { maxBubbles: 3, maxChars: 80 }, topicMode: 'interject',
  })
  assert.equal(sent.length, 1, '原规则更严时不被插件放宽')
})

test('must / engaged / 私聊：participationLevel 不是 text_lite 或非群聊 → 零影响', async () => {
  // 私聊 + text_lite opts：不收紧
  const { delivery: dp, sent: sentP } = fixture({}, { privateMaxChars: 20 })
  await dp.deliverNow('private:10001', '一|||二|||三', {
    participationLevel: 'text_lite', textLiteLimits: { maxBubbles: 1, maxChars: 80 },
  })
  assert.equal(sentP.length, 3, '私聊不受 TEXT_LITE 影响（显式三条仍三条）')
  // 群聊 must / engaged（participationLevel full）：不收紧
  const { delivery: dm, sent: sentM } = fixture()
  await dm.deliverNow('group:30001', '一|||二|||三', { participationLevel: 'full', topicMode: 'must' })
  assert.equal(sentM.length, 3)
  await dm.deliverNow('group:30001', '一|||二|||三', { participationLevel: 'full', topicMode: 'engaged' })
  assert.equal(sentM.length, 6, 'engaged 同样零影响（累计 6 条）')
})

test('forceReport / 代码块：text_lite 不截坏结构与长内容', async () => {
  // forceReport：整轮按报告处理，不被拆碎（text_lite maxChars 20 也不截断）
  const { delivery: dr, sent: sentR } = fixture()
  const report = '<report>第一行比较长的内容。\n第二行也很长。\n第三行更长一些了。</report>'
  await dr.deliverNow('group:30001', report, {
    participationLevel: 'text_lite', textLiteLimits: { maxBubbles: 1, maxChars: 20 }, forceReport: true, topicMode: 'interject',
  })
  assert.equal(sentR.length, 1)
  assert.match(sentR[0].text, /第三行更长一些了/, '报告完整不截断')

  // 代码块：跨行代码不被从中间截断
  const { delivery: dc, sent: sentC } = fixture()
  const code = '这是说明。\n```\nconst a = 1\nconst b = 2\nconst c = a + b\nconsole.log(c)\n```\n结束。'
  await dc.deliverNow('group:30001', code, {
    participationLevel: 'text_lite', textLiteLimits: { maxBubbles: 1, maxChars: 20 }, topicMode: 'interject',
  })
  const joined = sentC.map((s) => s.text).join('\n')
  assert.match(joined, /const a = 1/, '代码块开头在')
  assert.match(joined, /console\.log\(c\)/, '代码块结尾在（未被截坏）')
})

test('引用与非文本 segment：text_lite 群合包不截坏 replyTo 与 sticker（合并为 mixed 完整投出）', async () => {
  const { delivery, sent } = fixture()
  // <reply:2> 引用编号 2 的显式气泡 + 表情气泡（非文本）：maxBubbles 1 时合并成 mixed，
  // replyTo 与 sticker 部件都必须完整保留（引用没被摘掉、表情没被丢）。
  const result = await delivery.deliverNow('group:30001', '<reply:2>看到啦|||<sticker:开心>', {
    participationLevel: 'text_lite', textLiteLimits: { maxBubbles: 1, maxChars: 80 }, topicMode: 'interject',
    refs: { 2: { mid: '22', uid: 'u2' } },
  })
  assert.equal(result.state, 'sent')
  assert.equal(sent.length, 1, 'text_lite maxBubbles 1 → 合并为一条 mixed')
  const mixed = sent[0]
  assert.equal(mixed.kind, 'mixed')
  const textPart = mixed.parts.find((p) => p.kind === 'text')
  const stickerPart = mixed.parts.find((p) => p.kind === 'sticker')
  assert.match(textPart.value, /看到啦/, '正文部件完整')
  assert.equal(textPart.replyTo, '2', 'replyTo 没有被截坏（合并后仍指向编号 2）')
  assert.ok(stickerPart, '非文本 segment（表情）没有被丢弃')
})

test('纵深防御：topicMode must / engaged + participationLevel text_lite → 不收紧（must/engaged 永不降级）', async () => {
  for (const topicMode of ['must', 'engaged']) {
    const { delivery, sent } = fixture()
    await delivery.deliverNow('group:30001', '一|||二|||三', {
      participationLevel: 'text_lite', textLiteLimits: { maxBubbles: 1, maxChars: 80 }, topicMode,
    })
    assert.equal(sent.length, 3, `${topicMode} 回合即使误传 text_lite opts 也不收紧`)
  }
  // 对外口径一致：hookInfo.participation 在 must/engaged 下也是 'full'
  let seen = null
  const { delivery } = fixture({ hooks: { items: (items, info) => { seen = { ...info }; return undefined } } })
  await delivery.deliverNow('group:30001', '一', {
    participationLevel: 'text_lite', textLiteLimits: { maxBubbles: 1 }, topicMode: 'engaged',
  })
  assert.equal(seen.participation, 'full', 'must/engaged 对外 participation 恒为 full')
})
