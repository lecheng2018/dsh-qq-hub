import test from 'node:test'
import assert from 'node:assert/strict'
import { createReplyDelivery } from '../src/chat/reply-delivery.js'

const log = { info() {}, warn() {}, debug() {} }
const config = {
  ownerQQ: 'owner',
  voice: { enabled: false, autoChance: 0, autoMaxChars: 300 },
  stickers: { enabled: false, autoChance: 0 },
  reply: { maxBubbles: 3 },
}

function fixture(overrides = {}) {
  const sent = []
  const logged = []
  const activities = []
  const groups = { refs: () => ({}), leaveTopic() {}, noteSpeak() {}, noteSpokeInGroup() {} }
  const delivery = createReplyDelivery({
    getConfig: () => config,
    log,
    hooks: {},
    reportTurns: new Map(),
    groups,
    stickers: { match: () => null, pickForReply: () => null },
    interaction: { queueAside() {} },
    sendText: async (chatId, text, replyId, missedAt, userId) => { sent.push({ chatId, kind: 'text', text, replyId, userId }); return { message_id: 1 } },
    sendVoice: async (chatId, text) => { sent.push({ chatId, kind: 'voice', text }); return { message_id: 2 } },
    sendSticker: async () => ({ message_id: 3 }),
    sendImage: async () => ({ message_id: 4 }),
    sendMixed: async () => ({ message_id: 5 }),
    pokeBack: async () => {},
    logChat: (...args) => logged.push(args),
    onActivity: (event) => activities.push(event),
    sleep: async () => {},
    ...overrides,
  })
  return { delivery, sent, logged, activities }
}

test('回复编排可独立执行：保留群聊合并、引用和最终流水', async () => {
  const { delivery, sent, logged } = fixture()
  const result = await delivery.deliverNow('group:7', '一|||二|||<reply:2>三|||四', {
    refs: { 2: { mid: '22', uid: 'u2' } },
    autoReply: { mid: '22', uid: 'u2' },
  })
  assert.equal(sent.length, 3)
  assert.equal(sent.map((item) => item.text).join(' '), '一 二 三 四')
  const quoted = sent.find((item) => item.replyId === '22')
  assert.match(quoted.text, /三/)
  assert.equal(quoted.userId, 'u2')
  assert.deepEqual(logged[0].slice(0, 2), ['group:7', 'bot'])
  // 返回值契约在「轮次级谎报」修复后新增了气泡级回执统计：
  // attempted / delivered / failedCount。missedAt 仍在，语义不变。
  assert.equal(result.attempted, 3, '三条气泡都应计入尝试')
  assert.equal(result.delivered, 3, '网关都回了回执 → 全部算送达')
  assert.equal(result.failedCount, 0, '没有未确认的气泡')
  assert.deepEqual(result.missedAt, [])
})

test('气泡级回执：有气泡没拿到网关回执时 failedCount 如实计数，且不重发', async () => {
  // 第 2 条返回 null（网关没回执）——模拟「真丢了一条」
  let call = 0
  const { delivery, sent } = fixture({
    sendText: async (chatId, text) => { call += 1; sent.push({ text }); return call === 2 ? null : { message_id: call } },
  })
  const result = await delivery.deliverNow('private:1', '一|||二|||三', {})
  assert.equal(sent.length, 3, '三条都尝试发了（失败不该中断后面的气泡）')
  assert.equal(result.attempted, 3)
  assert.equal(result.delivered, 2)
  assert.equal(result.failedCount, 1, '必须如实报 1 条未确认，不能谎报全成功')
})

test('气泡级回执：全部失败时 delivered=0 且 failedCount=attempted（不静默）', async () => {
  const { delivery } = fixture({ sendText: async () => null, sendVoice: async () => null })
  const result = await delivery.deliverNow('private:1', '一|||二', {})
  assert.equal(result.attempted, 2)
  assert.equal(result.delivered, 0)
  assert.equal(result.failedCount, 2)
})

test('可选流水和活动回调缺省时仍完成投递', async () => {
  const { delivery, sent } = fixture({ logChat: undefined, onActivity: undefined })
  await delivery.deliverNow('private:1', '正常回复')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, '正常回复')
})

test('扩展 hooks 可拦截正文和条目，拦截后不产生发送或流水', async () => {
  const { delivery, sent, logged } = fixture({ hooks: { reply: async () => null } })
  await delivery.deliverNow('private:1', '不应发送')
  assert.equal(sent.length, 0)
  assert.equal(logged.length, 0)
})

test('同会话在媒体准备期间保留 Outbox 票，独立会话不排队', async () => {
  let releaseCount = 0
  const outbox = {
    reserve() {
      return { ticket: {}, release: () => { releaseCount++ } }
    },
  }
  let finish
  const gate = new Promise((resolve) => { finish = resolve })
  const { delivery, sent } = fixture({
    outbox: () => outbox,
    sendText: async (chatId, text) => {
      sent.push({ chatId, text })
      if (text === 'first') await gate
    },
  })
  const first = delivery.deliver('group:7', 'first')
  const second = delivery.deliver('group:7', 'second')
  await delivery.deliver('group:8', 'other')
  assert.deepEqual(sent.map((x) => x.text), ['first', 'other'])
  finish()
  await Promise.all([first, second])
  assert.deepEqual(sent.map((x) => x.text), ['first', 'other', 'second'])
  assert.equal(releaseCount, 3)
})

test('模拟回复不占 Outbox 队列票，失败回复也会释放队列', async () => {
  let reserves = 0
  let releases = 0
  const { delivery } = fixture({
    outbox: () => ({ reserve: () => { reserves++; return { ticket: {}, release: () => { releases++ } } } }),
    sendText: async (chatId, text) => { if (text === 'failure') throw new Error('expected') },
  })
  const items = await delivery.deliver('private:1', 'simulation', { simulate: true })
  assert.equal(items[0].value, 'simulation')
  await assert.rejects(() => delivery.deliver('private:1', 'failure'), /expected/)
  assert.equal(reserves, 1)
  assert.equal(releases, 1)
})

// ---- 上游遗留缺陷①：流水只记实发 ----
test('流水只记实发：部分气泡失败时聊天流水不含未送达内容', async () => {
  let call = 0
  const { delivery, logged } = fixture({
    sendText: async () => { call += 1; return call === 2 ? null : { message_id: call } },
  })
  await delivery.deliverNow('private:1', '甲|||乙|||丙', {})
  assert.equal(logged.length, 1)
  assert.equal(logged[0][2], '甲 丙', '失败的「乙」不该出现在流水里（旧版会记满 甲 乙 丙）')
})

test('流水只记实发：整轮都没发出去时不记流水/旁白', async () => {
  const asides = []
  const { delivery, logged } = fixture({
    sendText: async () => null,
    interaction: { queueAside: (...args) => asides.push(args) },
  })
  await delivery.deliverNow('private:1', '甲|||乙', { own: false })
  assert.equal(logged.length, 0, '一条都没实发就不该记 bot 流水')
  assert.equal(asides.length, 0, '也不该记旁白')
})

test('流水只记实发：mixed 整泡拿到回执时其全部 parts 都进流水', async () => {
  // 用 hooks.items 直接注入一个 mixed 条目（文字+图片），整泡拿到回执 → 两部分都进流水
  const { delivery, logged } = fixture({
    hooks: { items: async () => [{ kind: 'mixed', parts: [{ kind: 'text', value: '你好' }, { kind: 'image', value: 'x' }] }] },
    sendMixed: async () => ({ message_id: 5 }),
  })
  await delivery.deliverNow('private:1', '原文', {})
  assert.equal(logged[0][2], '你好 [image]', 'mixed 送达 → 文字与媒体占位都记')
})

// ---- 上游遗留缺陷④：随机源可注入 ----
test('随机源可注入：random 命中阈值时短回复整条变语音', async () => {
  const voiceCfg = { ...config, voice: { enabled: true, autoChance: 0.5, autoMaxChars: 300 } }
  const { delivery, sent } = fixture({ getConfig: () => voiceCfg, random: () => 0 })
  await delivery.deliverNow('private:1', '你好呀', {})
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'voice', 'random()=0 < 0.5 应整条变语音')
})

test('随机源可注入：random 未命中阈值时保持文字', async () => {
  const voiceCfg = { ...config, voice: { enabled: true, autoChance: 0.5, autoMaxChars: 300 } }
  const { delivery, sent } = fixture({ getConfig: () => voiceCfg, random: () => 0.9 })
  await delivery.deliverNow('private:1', '你好呀', {})
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'text', 'random()=0.9 ≥ 0.5 应保持文字')
})

test('随机源可注入：random 命中时补一张表情', async () => {
  const stickerCfg = { ...config, stickers: { enabled: true, autoChance: 0.5 } }
  const pick = { md5: 'abc', name: '笑' }
  const { delivery, sent } = fixture({
    getConfig: () => stickerCfg,
    random: () => 0,
    stickers: { match: () => pick, pickForReply: () => pick },
    sendSticker: async (chatId, value) => { sent.push({ kind: 'sticker', value }); return { message_id: 7 } },
  })
  await delivery.deliverNow('private:1', '哈哈', {})
  assert.ok(sent.some((s) => s.kind === 'sticker'), 'random()=0 < 0.5 应补表情')
})

test('随机源透传律动：固定 random 下气泡间隔可复现', async () => {
  const cfg = { ...config, reply: { maxBubbles: 3, cadence: { enabled: true } } }
  const run = async () => {
    const waits = []
    const { delivery } = fixture({ getConfig: () => cfg, random: () => 0.5, sleep: async (ms) => { waits.push(ms) } })
    await delivery.deliverNow('private:1', '一|||二', {})
    return waits
  }
  const first = await run()
  const second = await run()
  assert.ok(first.length > 0 && first.every((w) => w > 0), '律动开启应产生正的等待')
  assert.deepEqual(second, first, '同一 random 序列 → 律动间隔完全一致（随机源已透传）')
})

test('引用目标解析：<reply:…> 收编号/昵称/QQ号；对不上人时照常发，绝不挂错人', async () => {
  const refs = {
    1: { mid: '501', uid: '111', nick: '初恋' },
    2: { mid: '502', uid: '222', nick: '洛书' },
    3: { mid: '503', uid: '111', nick: '初恋' },
  }
  // 编号
  {
    const { delivery, sent } = fixture()
    await delivery.deliverNow('group:7', '<reply:2>回你', { refs })
    assert.equal(sent[0].replyId, '502', '编号 2 应解析到洛书那条')
  }
  // 昵称：同名多条取最后一条
  {
    const { delivery, sent } = fixture()
    await delivery.deliverNow('group:7', '<reply:初恋>回你', { refs })
    assert.equal(sent[0].replyId, '503', '同名多条时取最近一条')
  }
  // QQ 号
  {
    const { delivery, sent } = fixture()
    await delivery.deliverNow('group:7', '<reply:222>回你', { refs })
    assert.equal(sent[0].replyId, '502', 'QQ 号应解析到该人最近一条')
  }
  // 对不上人：不引用，照常发（不能退回 autoReply 挂到别人身上）
  {
    const { delivery, sent } = fixture()
    await delivery.deliverNow('group:7', '<reply:查无此人>回你', {
      refs,
      autoReply: { mid: '502', uid: '222' },
    })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].replyId, undefined, '写错的引用不能悄悄转嫁给 autoReply 那个人')
    assert.equal(sent[0].text, '回你')
  }
})

test('回归 2026-11-23：群友昵称带零宽字符/不可见字符时，模型写视觉昵称 <reply:☆> 正常命中引用', async () => {
  const refs = {
    1: { mid: '888', uid: '1659823172', nick: '☆\u200B' }, // 真实线上事故：群友昵称末尾带 \u200b
    2: { mid: '889', uid: '1000000001', nick: '\u200E测试\u200F' },
  }
  {
    const { delivery, sent } = fixture()
    await delivery.deliverNow('group:249729644', '<reply:☆>复一次就行了 别把我当复活币使', { refs })
    assert.equal(sent[0].replyId, '888', '应能容忍 \\u200B 零宽空格，成功匹配群友 ☆')
    assert.equal(sent[0].text, '复一次就行了 别把我当复活币使')
  }
  {
    const { delivery, sent } = fixture()
    await delivery.deliverNow('group:249729644', '<reply:测试>正常回复', { refs })
    assert.equal(sent[0].replyId, '889', '应能容忍方向控制符')
  }
  // 反向：模型输出偶然带了零宽空格或首尾空格，也能对上纯文本 nick
  {
    const cleanRefs = {
      1: { mid: '999', uid: '1659823172', nick: '☆' },
    }
    const { delivery, sent } = fixture()
    await delivery.deliverNow('group:249729644', '<reply:☆\u200B>带零宽字符的引用', { refs: cleanRefs })
    assert.equal(sent[0].replyId, '999', '模型输出如果带零宽字符也应能清洗并命中')
  }
})

// ===== 同回合表情去重（真机 2026-11-23 15:01：工具直发一张 + 正文 <sticker:同一张> 又发一张）=====

const stickerConfig = { ...config, stickers: { enabled: true, autoChance: 0, faces: false } }
const stickerLib = (md5 = 'm-1') => ({
  match: (q) => (String(q || '').includes('无语') ? { md5, name: '无语' } : null),
  pickForReply: () => null,
})

test('同回合表情去重：工具刚直发过的那张，正文里重复的 <sticker:…> 不发，文字照发', async () => {
  const sent = []
  const already = new Set(['m-1'])
  const { delivery } = fixture({
    getConfig: () => stickerConfig,
    stickers: stickerLib('m-1'),
    sendText: async (chatId, text) => { sent.push({ kind: 'text', text }); return { message_id: 1 } },
    sendSticker: async () => { sent.push({ kind: 'sticker' }); return { message_id: 3 } },
  })
  const result = await delivery.deliverNow('group:7', '就写点后端 天天看日志|||<sticker:无语>', {
    stickersSentThisTurn: () => already,
  })
  assert.deepEqual(sent.map((s) => s.kind), ['text'], '重复的那张表情被摘掉，只剩文字')
  assert.equal(sent[0].text, '就写点后端 天天看日志')
  assert.equal(result.delivered, 1, '只投递了一条')
})

test('同回合表情去重：整轮只剩重复表情时不空跑投递', async () => {
  const sent = []
  const { delivery } = fixture({
    getConfig: () => stickerConfig,
    stickers: stickerLib('m-1'),
    sendText: async () => { sent.push({ kind: 'text' }); return { message_id: 1 } },
    sendSticker: async () => { sent.push({ kind: 'sticker' }); return { message_id: 3 } },
  })
  const result = await delivery.deliverNow('group:7', '<sticker:无语>', { stickersSentThisTurn: () => new Set(['m-1']) })
  assert.deepEqual(sent, [], '本轮已经直发过这张，正文里再写不再发一遍')
  assert.equal(result, undefined, '没有可发内容 → 不入投递流程')
})

test('同回合表情去重：不是同一张（md5 不同）照常发', async () => {
  const sent = []
  const { delivery } = fixture({
    getConfig: () => stickerConfig,
    stickers: stickerLib('m-2'),
    sendText: async () => ({ message_id: 1 }),
    sendSticker: async () => { sent.push({ kind: 'sticker' }); return { message_id: 3 } },
  })
  await delivery.deliverNow('group:7', '<sticker:无语>', { stickersSentThisTurn: () => new Set(['m-1']) })
  assert.deepEqual(sent.map((s) => s.kind), ['sticker'], '不同 md5 不该被误伤')
})

test('同回合表情去重：没传台账（后台/系统回合）行为不变', async () => {
  const sent = []
  const { delivery } = fixture({
    getConfig: () => stickerConfig,
    stickers: stickerLib('m-1'),
    sendText: async () => ({ message_id: 1 }),
    sendSticker: async () => { sent.push({ kind: 'sticker' }); return { message_id: 3 } },
  })
  await delivery.deliverNow('group:7', '<sticker:无语>', {})
  assert.deepEqual(sent.map((s) => s.kind), ['sticker'])
})
