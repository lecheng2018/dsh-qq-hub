import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReply, stripMarkdown, bubbleDelay } from '../src/chat/reply.js'
import { decideGroupReply, policyFor, inQuietHours, DEFAULT_GROUP_POLICY } from '../src/chat/group-policy.js'
import { parseMessageEvent, isStickerSegment, stickerSizeOk, imageSize } from '../src/chat/inbound.js'
import { checkAllowed, levelFor, presetFor, isOwner } from '../src/chat/access.js'
import { redact, registerSecret } from '../src/core/redact.js'

test('parseReply 拆 ||| 成多条', () => {
  const r = parseReply('在呢|||刚睡醒 嗯…|||你呢')
  assert.equal(r.silent, false)
  assert.deepEqual(r.items.map((x) => x.value), ['在呢', '刚睡醒 嗯…', '你呢'])
})

test('parseReply 识别语音和表情标记', () => {
  const r = parseReply('哼 谁要你夸 <sticker:卖萌>|||<voice>晚安啦</voice>')
  assert.deepEqual(r.items, [
    { kind: 'text', value: '哼 谁要你夸' },
    { kind: 'sticker', value: '卖萌' },
    { kind: 'voice', value: '晚安啦' },
  ])
  const r2 = parseReply('好耶<sticker:开心></sticker>')
  assert.deepEqual(r2.items.map((x) => x.kind), ['text', 'sticker'])
})

test('parseReply 沉默与空', () => {
  assert.equal(parseReply('[沉默]').silent, true)
  assert.equal(parseReply('   ').silent, true)
  assert.equal(parseReply('|||').silent, true)
})

test('stripMarkdown 洗掉 Markdown', () => {
  assert.equal(stripMarkdown('**好耶** `x` \n# 标题\n- 列表'), '好耶 x\n标题\n列表')
})

test('bubbleDelay 按下一条长短停顿', () => {
  assert.equal(bubbleDelay('嗯', () => 0), 560)
  assert.ok(bubbleDelay('这是一句比较长的话，要打好一会儿才打得完呢', () => 0) > bubbleDelay('嗯', () => 0))
  assert.ok(bubbleDelay('x'.repeat(500), () => 1) <= 4500 * 1.3)
})

test('回复按行拆成多条气泡；列表、代码、长文不拆；最多 5 条', () => {
  const NL = String.fromCharCode(10)
  assert.deepEqual(parseReply(['白米饭！必须是白米饭', '别的都能省 饭不能省'].join(NL)).items.map((x) => x.value), ['白米饭！必须是白米饭', '别的都能省 饭不能省'])
  assert.equal(parseReply(['1. 打开设置', '2. 点插件', '3. 保存'].join(NL)).items.length, 1)
  const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join(NL)
  assert.equal(parseReply(seven).items.length, 5)
  assert.equal(parseReply(seven).items[4].value, ['e', 'f', 'g'].join(NL))
})

const base = (o) => ({
  policy: policyFor({}, {}, 1),
  mentioned: false,
  repliedToBot: false,
  text: '今天吃什么',
  now: 10_000_000,
  hour: 15,
  recentTimes: [9_990_000, 9_995_000, 9_999_000],
  interjectTimes: [],
  rand: () => 0.01,
  ...o,
})

test('群聊：@、引用、唤醒词必回', () => {
  assert.equal(decideGroupReply(base({ mentioned: true, rand: () => 0.99 })).mode, 'must')
  assert.equal(decideGroupReply(base({ repliedToBot: true, rand: () => 0.99 })).mode, 'must')
  assert.equal(decideGroupReply(base({ text: '肥鱼在吗', rand: () => 0.99 })).mode, 'must')
  // 必回不受静默时段影响
  assert.equal(decideGroupReply(base({ mentioned: true, hour: 3 })).reply, true)
})

test('群聊：插话受概率、冷却、上限、静默、冷群约束', () => {
  assert.equal(decideGroupReply(base({})).mode, 'interject')
  assert.equal(decideGroupReply(base({ rand: () => 0.5, relevance: 0.3 })).reply, false)
  assert.equal(decideGroupReply(base({ interjectTimes: [10_000_000 - 30_000] })).reason, '插话冷却中')
  const six = [1, 2, 3, 4, 5, 6].map((i) => 10_000_000 - 100_000 * i - 200_000)
  assert.equal(decideGroupReply(base({ interjectTimes: six })).reason, '这小时说得够多了')
  assert.equal(decideGroupReply(base({ hour: 3 })).reason, '静默时段')
  assert.equal(decideGroupReply(base({ recentTimes: [1] })).reason, '群里没在聊')
})

test('群聊：话题无关不插话，越相关越容易插，加入话题后接着聊', () => {
  assert.match(decideGroupReply(base({ relevance: 0.1 })).reason, /关系不大/)
  assert.equal(decideGroupReply(base({ relevance: 0.3, rand: () => 0.3 })).mode, 'interject')
  assert.equal(decideGroupReply(base({ relevance: 0.3, rand: () => 0.4 })).reply, false)
  assert.equal(decideGroupReply(base({ relevance: 0.9, rand: () => 0.65 })).mode, 'interject')
  // 已经在聊这个话题：不受插话冷却限制，可以接着聊
  assert.equal(decideGroupReply(base({ relevance: 0.5, engagedUntil: 10_100_000, interjectTimes: [10_000_000 - 30_000], botReplyTimes: [10_000_000 - 30_000] })).mode, 'engaged')
  // 但刚说完不会马上又说，也不是每段都接
  assert.equal(decideGroupReply(base({ relevance: 0.5, engagedUntil: 10_100_000, botReplyTimes: [10_000_000 - 5_000] })).reason, '刚说过，先听听')
  assert.equal(decideGroupReply(base({ relevance: 0.5, engagedUntil: 10_100_000, rand: () => 0.9 })).reply, false)
  // 每小时上限照样管着接话
  const six = [1, 2, 3, 4, 5, 6].map((i) => 10_000_000 - 100_000 * i)
  assert.equal(decideGroupReply(base({ relevance: 0.5, engagedUntil: 10_100_000, interjectTimes: six })).reply, false)
  // 话题跑偏了就不接着聊
  assert.notEqual(decideGroupReply(base({ relevance: 0.1, engagedUntil: 10_100_000 })).mode, 'engaged')
})

test('群聊防炸群：刹车、单字唤醒词、和别的号对叫', () => {
  const now = 10_000_000
  const four = [1, 2, 3, 4].map((i) => now - 10_000 * i)
  // 两分钟里说了 4 次：@ 也不回，只有主人 @ 能叫动
  assert.match(decideGroupReply(base({ mentioned: true, botReplyTimes: four })).reason, /歇一会儿/)
  assert.equal(decideGroupReply(base({ mentioned: true, fromOwner: true, botReplyTimes: four })).mode, 'must')
  // 单个字的唤醒词只加分，不算必回
  const p = policyFor({ wakeWords: ['鱼', '大肥鱼'] }, {}, 1)
  assert.notEqual(decideGroupReply(base({ policy: p, text: '这鱼真大', rand: () => 0.99 })).mode, 'must')
  assert.equal(decideGroupReply(base({ policy: p, text: '大肥鱼你好', rand: () => 0.99 })).mode, 'must')
  // 刚说过话又被叫到：不算必回（防止和名字里带「大肥鱼」的号来回对叫）
  assert.notEqual(decideGroupReply(base({ policy: p, text: '大肥鱼你好', rand: () => 0.99, botReplyTimes: [now - 5_000] })).mode, 'must')
})

test('topicRelevance', async () => {
  const { topicRelevance } = await import('../src/chat/group-policy.js')
  assert.equal(topicRelevance(['今天天气不错', '中午吃啥'], ['白米饭', '天气']), 0.3)
  assert.equal(topicRelevance(['量子力学'], ['白米饭']), 0)
  assert.equal(topicRelevance(['量子力学'], ['白米饭'], 1), 0.5)
})

test('群聊：按群覆盖策略', () => {
  const p = policyFor({ interjectChance: 0.05 }, { 123: { interjectChance: 0 } }, '123')
  assert.equal(p.interjectChance, 0)
  assert.equal(decideGroupReply(base({ policy: p })).reason, '插话关着')
  assert.equal(policyFor({}, {}, 1).cooldownSec, DEFAULT_GROUP_POLICY.cooldownSec)
})

test('inQuietHours 跨零点', () => {
  assert.equal(inQuietHours(23, [23, 9]), true)
  assert.equal(inQuietHours(5, [23, 9]), true)
  assert.equal(inQuietHours(12, [23, 9]), false)
  assert.equal(inQuietHours(2, [1, 8]), true)
})

const SELF = '20000002'

test('parseMessageEvent：@、引用、图片、表情包、语音', () => {
  const e = {
    post_type: 'message', message_type: 'group', group_id: 555, user_id: 777, message_id: 42, self_id: SELF,
    sender: { nickname: '小明', card: '明明', role: 'member' },
    message: [
      { type: 'reply', data: { id: '41' } },
      { type: 'at', data: { qq: SELF } },
      { type: 'text', data: { text: ' 看这个' } },
      { type: 'image', data: { url: 'http://x/a.jpg', sub_type: 0 } },
      { type: 'mface', data: { emoji_id: 'abc', summary: '[开心]', url: 'http://x/b.gif' } },
      { type: 'image', data: { url: 'http://x/c.gif', sub_type: 1 } },
    ],
  }
  const m = parseMessageEvent(e, SELF)
  assert.equal(m.kind, 'group')
  assert.equal(m.chatId, 'group:555')
  assert.equal(m.nickname, '明明')
  assert.equal(m.mentioned, true)
  assert.equal(m.replyId, '41')
  assert.equal(m.images.length, 1)
  assert.equal(m.stickers.length, 2)
  assert.match(m.text, /看这个/)
})

test('isStickerSegment：普通照片不算表情', () => {
  assert.equal(isStickerSegment({ type: 'image', data: { sub_type: 0, url: 'x' } }), false)
  assert.equal(isStickerSegment({ type: 'image', data: { sub_type: '1' } }), true)
  assert.equal(isStickerSegment({ type: 'image', data: { emoji_id: 'e' } }), true)
  assert.equal(isStickerSegment({ type: 'mface', data: {} }), true)
})

test('stickerSizeOk 尺寸兜底', () => {
  assert.equal(stickerSizeOk({ width: 240, height: 240, bytes: 50_000 }), true)
  assert.equal(stickerSizeOk({ width: 1080, height: 1080, bytes: 50_000 }), false)
  assert.equal(stickerSizeOk({ width: 300, height: 100, bytes: 50_000 }), false)
  assert.equal(stickerSizeOk({ width: 240, height: 240, bytes: 2_000_000 }), false)
})

test('imageSize 读 PNG 宽高', () => {
  const png = Buffer.alloc(24)
  png[0] = 0x89; png[1] = 0x50
  png.writeUInt32BE(200, 16); png.writeUInt32BE(180, 20)
  assert.deepEqual(imageSize(png), { width: 200, height: 180 })
})

const cfg = { ownerQQ: '10000001', ownerLevel: 'full', allow: { private: ['10000001'], groups: ['555'] } }

test('白名单', () => {
  assert.equal(checkAllowed(cfg, { kind: 'private', userId: '10000001' }).allowed, true)
  assert.equal(checkAllowed(cfg, { kind: 'private', userId: '999' }).allowed, false)
  assert.equal(checkAllowed(cfg, { kind: 'group', groupId: '555', userId: '1' }).allowed, true)
  assert.equal(checkAllowed(cfg, { kind: 'group', groupId: '556', userId: '1' }).allowed, false)
})

test('权限档位：主人私聊完整，群聊永远受限', () => {
  assert.equal(levelFor(cfg, { kind: 'private', userId: '10000001' }), 'full')
  assert.equal(levelFor({ ...cfg, ownerLevel: 'chat' }, { kind: 'private', userId: '10000001' }), 'chat')
  assert.equal(levelFor(cfg, { kind: 'group', userId: '10000001' }), 'social')
  assert.equal(presetFor('full'), 'aurabot-private')
  assert.equal(presetFor('social'), 'aurabot-social')
})

test('群管发起人校验：只认主人', () => {
  assert.equal(isOwner(cfg, '10000001'), true)
  assert.equal(isOwner(cfg, '12345'), false)
  assert.equal(isOwner(cfg, ''), false)
})

test('脱敏', () => {
  registerSecret('SuperSecretToken123')
  assert.equal(redact('token=abcdef123456'), 'token=***')
  assert.equal(redact('the value SuperSecretToken123 leaked'), 'the value *** leaked')
  assert.equal(redact('Authorization: Bearer abcdefghijklmnop'), 'Authorization: ***')
  assert.equal(redact('cookie: MUSIC_U=xyz12345'), 'cookie: ***')
  assert.equal(redact('普通的话'), '普通的话')
})

test('wantsVoice：明确要语音才算', async () => {
  const { wantsVoice } = await import('../src/chat/reply.js')
  for (const t of ['用语音跟我发晚安', '发个语音呗', '语音说一下', '给我来段语音', '录个语音']) assert.equal(wantsVoice(t), true, t)
  for (const t of ['晚安', '你的语音好好听', '不要语音', '刚才那条语音是啥']) assert.equal(wantsVoice(t), false, t)
})
