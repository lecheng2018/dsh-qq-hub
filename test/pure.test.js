import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReply, stripMarkdown, bubbleDelay, stripInternalMemo } from '../src/chat/reply.js'
import { decideGroupReply, policyFor, inQuietHours, DEFAULT_GROUP_POLICY } from '../src/chat/group-policy.js'
import { parseMessageEvent, isStickerSegment, stickerSizeOk, imageSize } from '../src/chat/inbound.js'
import { checkAllowed, levelFor, presetFor, isOwner, profileToolVisible, profilePermits } from '../src/chat/access.js'
import { avatarSource } from '../src/modules/profile/index.js'
import { redact, registerSecret } from '../src/core/redact.js'

test('parseReply 拆 ||| 成多条', () => {
  const r = parseReply('在呢|||刚睡醒 嗯…|||你呢')
  assert.equal(r.silent, false)
  assert.deepEqual(r.items.map((x) => x.value), ['在呢', '刚睡醒 嗯…', '你呢'])
})

test('parseReply 剥离 purpose 内部备忘，不污染普通回复', () => {
  const r = parseReply('这是正常回复\n【目的】邀请主人玩游戏\n【需求】玩\n【状态】完成\n【待续】无')
  assert.equal(r.silent, false)
  assert.deepEqual(r.items.map((x) => x.value), ['这是正常回复'])
  const onlyMemo = parseReply('【目的】无\n【状态】跳过')
  assert.equal(onlyMemo.silent, true)
})

test('parseReply 单个备忘样式标签只是正文，两个标签才按内部块截断', () => {
  const r = parseReply('她问：\n【目的】是什么意思？')
  assert.equal(r.silent, false)
  assert.equal(r.items.map((x) => x.value).join('\n'), '她问：\n【目的】是什么意思？')
})

// 2026-11-23 线上事故：私聊里连着发出两条只有六个字的「【内部备忘】」。
// 模型把提示词要求的「内部备忘」小标题当成一条独立气泡（前面还带 |||），
// stripInternalMemo 只按行首标签截断 → 截断点是【目的】，小标题留在正文尾巴上，
// 按 ||| 分条后单独发给了主人。下面四条钉住"小标题不许出现在任何气泡里"。
test('parseReply 切掉【内部备忘】小标题，不单独发出去（||| 分隔的真机形状）', () => {
  const r = parseReply('刚刷到一个 2500 块装黑色海景房的视频，槽点挺多。|||【内部备忘】\n【目的】分享装机\n【需求】分享\n【状态】完成\n【待续】无')
  assert.equal(r.silent, false)
  assert.deepEqual(r.items.map((x) => x.value), ['刚刷到一个 2500 块装黑色海景房的视频，槽点挺多。'])
})

test('parseReply 切掉换行分隔的【内部备忘】小标题', () => {
  const r = parseReply('昨晚拷固件时老弹审批弹窗，我琢磨了一下破甲插件。\n\n【内部备忘】\n【目的】聊审批\n【状态】完成')
  assert.deepEqual(r.items.map((x) => x.value), ['昨晚拷固件时老弹审批弹窗，我琢磨了一下破甲插件。'])
})

test('parseReply 认加粗 / 冒号写法的备忘小标题', () => {
  const bold = parseReply('正文。|||**【内部备忘】**\n内容')
  assert.deepEqual(bold.items.map((x) => x.value), ['正文。'])
  const colon = parseReply('正文。\n内部备忘：\n【目的】x\n【状态】完成')
  assert.deepEqual(colon.items.map((x) => x.value), ['正文。'])
})

// 真机 2026-11-23 21:14：模型给这块加了修饰，写成「【内部备忘·非QQ内容】」。
// 只认「备忘 紧接 】」的写法会漏掉它，于是又发出一条只有小标题的消息。
test('parseReply 认带修饰的备忘小标题（【内部备忘·非QQ内容】这类）', () => {
  const withLabels = parseReply('刷到个视频。|||【内部备忘·非QQ内容】\n【目的】分享\n【状态】完成')
  assert.deepEqual(withLabels.items.map((x) => x.value), ['刷到个视频。'])
  const bare = parseReply('正文一句。|||【内部备忘·非QQ内容】')
  assert.deepEqual(bare.items.map((x) => x.value), ['正文一句。'])
  const paren = parseReply('正文。\n内部备忘（不发）：\n【状态】完成')
  assert.deepEqual(paren.items.map((x) => x.value), ['正文。'])
})

test('parseReply 不把【备忘录】当内部块（正常词要留住）', () => {
  const r = parseReply('【备忘录】\n1. 买牛奶')
  assert.equal(r.silent, false)
  assert.match(r.items.map((x) => x.value).join('\n'), /备忘录/)
})

test('parseReply 只有备忘（小标题 + 标签）时沉默；只写了小标题也不发', () => {
  assert.equal(parseReply('【内部备忘】\n【目的】无\n【状态】跳过').silent, true)
  // 小标题后面什么都没写：切完只剩正文，绝不能把「【内部备忘】」本身当正文发出去
  assert.deepEqual(parseReply('正文一句。|||【内部备忘】').items.map((x) => x.value), ['正文一句。'])
})

test('parseReply 漏写 <inner> 的独白标签（意图/情感/备忘）也不外发', () => {
  const r = parseReply('正文。\n【意图】接话\n【情感】轻松\n【备忘】他说明天发链接')
  assert.deepEqual(r.items.map((x) => x.value), ['正文。'])
})

// 真机 2026-11-25 08:00 / 09:40 / 12:32：purpose 提示词要求「另起一段写『内部备忘』」，
// 模型照做，但写成**无方括号、无冒号的裸行** `内部备忘`，上一版小标题正则只认
// 【内部备忘】/`内部备忘：`，于是这块没被切掉，`内部备忘` 四个字作为一条气泡漏进了私聊。
test('parseReply 切掉无冒号裸行「内部备忘」小标题（真机 11-25 形状）', () => {
  const raw = '早八要困死了|||昨晚熬那么晚你起得来吗\n\n内部备忘\n【目的】早八犯困无聊戳他一下看起没起床\n【需求】陪\n【状态】完成'
  assert.deepEqual(parseReply(raw).items.map((x) => x.value), ['早八要困死了', '昨晚熬那么晚你起得来吗'])
  // 裸行小标题后面紧跟标签（同一段没有空行）也要切
  assert.deepEqual(parseReply('正文一句。\n内部备忘\n【目的】x\n【状态】完成').items.map((x) => x.value), ['正文一句。'])
  // 加粗 / 标题号 / 引号 / 带说明后缀的裸行写法
  assert.deepEqual(parseReply('正文。\n**内部备忘**\n【目的】x\n【状态】完成').items.map((x) => x.value), ['正文。'])
  assert.deepEqual(parseReply('正文。\n### 内部备忘\n【目的】x\n【状态】完成').items.map((x) => x.value), ['正文。'])
  assert.deepEqual(parseReply('正文。\n内部备忘·非QQ内容\n【目的】x\n【状态】完成').items.map((x) => x.value), ['正文。'])
})

// 上面那条的护栏：正文里正常提到「内部备忘」三个字不能被误删。
test('parseReply 不误杀正文里正常出现的「内部备忘」', () => {
  assert.deepEqual(parseReply('内部备忘发我看看').items.map((x) => x.value), ['内部备忘发我看看'])
  assert.deepEqual(parseReply('你把内部备忘写哪了').items.map((x) => x.value), ['你把内部备忘写哪了'])
  // 裸行但后面跟的是正常句子（不是标签、不是换行结尾）——当正文
  assert.match(parseReply('内部备忘这词是谁想出来的\n\n我也想知道').items.map((x) => x.value).join('\n'), /内部备忘这词/)
})

// 真机 2026-11-25 08:00 的根因之一：stripInternalMemo 直接吃原始回包时，会命中
// <inner> 里的【意图】【闭环】并从那里截断，把 </inner> 和正文一起切掉。
// 现在已闭合的 <inner> 段整体遮蔽，正文照常留下。
test('stripInternalMemo 跳过已闭合的 <inner> 段，不把正文一起切掉', () => {
  const raw = '<inner>\n【意图】早八犯困\n【闭环】\n【情感】犯困\n【备忘】插件还没说完\n</inner>早八要困死了|||昨晚熬那么晚你起得来吗\n\n内部备忘\n【目的】戳他一下\n【需求】陪\n【状态】完成'
  const cut = stripInternalMemo(raw)
  assert.match(cut, /早八要困死了\|\|\|昨晚熬那么晚你起得来吗/, '正文必须留下')
  assert.ok(!/【目的】|【状态】/.test(cut), '备忘标签必须切掉')
  assert.ok(!/内部备忘/.test(cut.replace('</inner>', '')), '小标题本身不能留')
  // 未闭合的 <inner>（泄漏形态）不遮蔽，仍按备忘截断处理（切点落在标签前的换行处）
  assert.equal(stripInternalMemo('<inner>【意图】x\n【目的】y\n【状态】完成'), '<inner>【意图】x')
})

test('stripInternalMemo 认同行顿号分隔（提示词原文【目的】无、【状态】跳过），且不跨行误切单标签', () => {
  // prompt.js:142 原文：「写【目的】无、【状态】跳过，然后结束回合」
  assert.equal(stripInternalMemo('【目的】无、【状态】跳过'), '')
  assert.equal(parseReply('【目的】无、【状态】跳过').silent, true)
  assert.equal(stripInternalMemo('晚安啦\n【目的】无、【状态】跳过'), '晚安啦')
  // 护栏：单行首标签后面换了行再在行内提到【状态】，不能跨行误切
  const normal = '她问：\n【目的】是什么意思？\n另外你今天 【状态】 看起来不错'
  assert.equal(stripInternalMemo(normal), normal)
  // 紧跟 </inner> 无换行的备忘小标题 / 双标签也能切掉，且不砍断 </inner> 的闭合尖括号
  assert.equal(stripInternalMemo('<inner>【意图】x</inner>内部备忘\n【目的】a\n【状态】完成'), '<inner>【意图】x</inner>')
  assert.equal(stripInternalMemo('<inner>【意图】x</inner>【目的】无\n【状态】跳过'), '<inner>【意图】x</inner>')
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

test('回复按行拆成多条气泡；列表、代码、长文不拆；最多 6 条', () => {
  const NL = String.fromCharCode(10)
  assert.deepEqual(parseReply(['白米饭！必须是白米饭', '别的都能省 饭不能省'].join(NL)).items.map((x) => x.value), ['白米饭！必须是白米饭', '别的都能省 饭不能省'])
  assert.equal(parseReply(['1. 打开设置', '2. 点插件', '3. 保存'].join(NL)).items.length, 1)
  // 超过 6 条时**均匀分组**（以前是把剩下的全塞进最后一条，出现「4 条极短 + 1 坨巨块」）
  const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join(NL)
  assert.equal(parseReply(seven).items.length, 6)
  assert.equal(parseReply(seven).items[0].value, ['a', 'b'].join(NL))
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

test('群聊：空文本/纯媒体不主动开回合，直接 @ 或引用仍可', () => {
  const engaged = base({ text: ' ', engagedUntil: 10_100_000, relevance: 1, rand: () => 0 })
  assert.equal(decideGroupReply(engaged).reply, false)
  assert.equal(decideGroupReply(engaged).reason, '空文本/纯媒体不主动插话')
  assert.equal(decideGroupReply(base({ text: '', rand: () => 0 })).reply, false)
  assert.equal(decideGroupReply(base({ text: '', mentioned: true })).mode, 'must')
  assert.equal(decideGroupReply(base({ text: '', repliedToBot: true })).mode, 'must')
})

test('群聊：插话受概率、冷却、每小时额度、静默、冷群约束', () => {
  assert.equal(decideGroupReply(base({})).mode, 'interject')
  assert.equal(decideGroupReply(base({ rand: () => 0.5, relevance: 0.3 })).reply, false)
  assert.equal(decideGroupReply(base({ interjectTimes: [10_000_000 - 30_000] })).reason, '插话冷却中')
  // 每小时额度按「她实际说了几次」（botReplyTimes）算，不是「插话了几次」（interjectTimes）——
  // 老口径只数插话，而每次插话还白送 engagedMaxReplies 条连聊，名义 6 的群实际能说 22.5 条/小时。
  // 7 条挤在 90 秒里 = 默认额度容量（⌈20/3⌉）用光；仍低于 burst 刹车线（8 次 / 120 秒）
  const spoke = Array.from({ length: 7 }, (_, i) => 10_000_000 - (6 - i) * 15_000)
  assert.match(decideGroupReply(base({ botReplyTimes: spoke })).reason, /说够了/)
  // 只「插过话」但没真说出来，不该扣额度（额度算的是她说出口的条数）
  const interjected = [1, 2, 3, 4, 5, 6, 7].map((i) => 10_000_000 - 300_000 - 300_000 * i)
  assert.equal(decideGroupReply(base({ interjectTimes: interjected })).mode, 'interject')
  assert.equal(decideGroupReply(base({ hour: 3 })).reason, '静默时段')
  assert.equal(decideGroupReply(base({ recentTimes: [1] })).reason, '群里没在聊')
})

test('群聊：话题无关不插话，越相关越容易插，加入话题后接着聊', () => {
  assert.match(decideGroupReply(base({ relevance: 0.1 })).reason, /关系不大/)
  assert.equal(decideGroupReply(base({ relevance: 0.3, rand: () => 0.3 })).mode, 'interject')
  assert.equal(decideGroupReply(base({ relevance: 0.3, rand: () => 0.4 })).reply, false)
  assert.equal(decideGroupReply(base({ relevance: 0.9, rand: () => 0.65 })).mode, 'interject')
  // 已经在聊这个话题：冷却不拦，每段都接（一段一回由攒消息保证）——
  // 但每小时额度照样管着它（连聊不是免费额度，见 group-reply-budget.test.js）
  const six = [1, 2, 3, 4, 5, 6].map((i) => 10_000_000 - 10_000 * i)
  assert.equal(decideGroupReply(base({ relevance: 0.5, engagedUntil: 10_100_000, interjectTimes: six, rand: () => 0.99 })).mode, 'engaged')
  // 话题跑偏了就不接着聊
  assert.notEqual(decideGroupReply(base({ relevance: 0.1, engagedUntil: 10_100_000 })).mode, 'engaged')
})

test('群聊安全刹车：短时间说太多就歇着，主人 @ 能叫动', () => {
  const now = 10_000_000
  const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => now - 10_000 * i)
  assert.match(decideGroupReply(base({ mentioned: true, botReplyTimes: eight })).reason, /歇一会儿/)
  assert.equal(decideGroupReply(base({ mentioned: true, fromOwner: true, botReplyTimes: eight })).mode, 'must')
  // 没到刹车线照常回
  assert.equal(decideGroupReply(base({ mentioned: true, botReplyTimes: eight.slice(0, 7) })).mode, 'must')
  // 单个字的唤醒词也算必回
  const p = policyFor({ wakeWords: ['鱼'] }, {}, 1)
  assert.equal(decideGroupReply(base({ policy: p, text: '这鱼真大', rand: () => 0.99 })).mode, 'must')
})

test('topicRelevance', async () => {
  const { topicRelevance } = await import('../src/chat/group-policy.js')
  assert.equal(topicRelevance(['今天天气不错', '中午吃啥'], ['白米饭', '天气']), 0.3)
  assert.equal(topicRelevance(['量子力学'], ['白米饭']), 0)
  assert.equal(topicRelevance(['量子力学'], ['白米饭'], 1), 0.5)
  // 未配置任何话题词且无记忆时返回基础相关度 0.35（避免与默认门槛死锁）
  assert.equal(topicRelevance(['随便聊两句'], []), 0.35)
  assert.equal(topicRelevance(['随便聊两句'], null), 0.35)
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

test('stickerSizeOk 尺寸兜底（PR #1 新阈值：maxSide 1920、静态 5MB、GIF 10MB）', () => {
  assert.equal(stickerSizeOk({ width: 240, height: 240, bytes: 50_000 }), true)
  assert.equal(stickerSizeOk({ width: 1080, height: 1080, bytes: 50_000 }), true, '1080 边长在 1920 内')
  assert.equal(stickerSizeOk({ width: 3000, height: 3000, bytes: 50_000 }), false, '超 maxSide 拒')
  assert.equal(stickerSizeOk({ width: 300, height: 100, bytes: 50_000 }), false, '长宽比 3:1 超容差拒')
  assert.equal(stickerSizeOk({ width: 240, height: 240, bytes: 6_000_000 }), false, '静态超 5MB 拒')
  assert.equal(stickerSizeOk({ width: 240, height: 240, bytes: 8_000_000, mime: 'image/gif' }), true, 'GIF 放宽到 10MB')
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
  assert.equal(presetFor('full'), 'qq-hub-private')
  assert.equal(presetFor('full', { longTasks: true }), 'qq-hub-private-long')
  assert.equal(presetFor('social', { longTasks: true }), 'qq-hub-social')
  assert.equal(presetFor('social'), 'qq-hub-social')
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

test('引用回复：<reply:…> 挂到下一条气泡上，一轮最多一条；编号/昵称/QQ号都收，对不上人在投递层丢弃', async () => {
  const { parseReply } = await import('../src/chat/reply.js')
  assert.deepEqual(parseReply('<reply:3>粮收到 省着花\n刷视频那摊我少刷两条').items, [
    { kind: 'text', value: '粮收到 省着花', replyTo: '3' },
    { kind: 'text', value: '刷视频那摊我少刷两条' },
  ])
  assert.equal(parseReply('哈哈\n<reply:2>你说的那个|||<reply:5>还有这个').items.filter((i) => i.replyTo).length, 1)
  assert.equal(parseReply('<reply:1><sticker:开心>').items[0].replyTo, '1')
  // 昵称 / QQ 号写法：解析层原样记住 token，能不能对上人由 reply-delivery 的 resolveRef 判定
  assert.equal(parseReply('<reply:初恋>行吧 画你的').items[0].replyTo, '初恋')
  assert.equal(parseReply('<reply:900000014>说的就是你').items[0].replyTo, '900000014')
  // 空标签仍然是坏标签，不挂引用；写了不存在的名字也留在解析层（投递层查不到人就照常发）
  assert.deepEqual(parseReply('<reply:>坏标签').items, [{ kind: 'text', value: '坏标签' }])
  assert.deepEqual(parseReply('<reply:x>坏标签').items, [{ kind: 'text', value: '坏标签', replyTo: 'x' }])
  assert.equal(parseReply('正常说话').items[0].replyTo, undefined)
})

test('规则：画画、唱歌只在功能真的能用时告诉她', async () => {
  const { rulesText } = await import('../src/persona/personas.js')
  const { normalize } = await import('../src/core/config.js')
  const off = rulesText('social', normalize({ imageGen: { enabled: true } }))
  assert.doesNotMatch(off, /你会画画|你会唱歌/, '没配生图服务就不说会画')
  const on = rulesText('social', normalize({ imageGen: { enabled: true, baseUrl: 'https://x/v1', model: 'm' } }))
  assert.match(on, /你会画画：只给主人画/)
})

test('空间互动：评论清洗、好友动态筛选', async () => {
  const { cleanComment, pickFeeds } = await import('../src/features/qzone-social.js')
  assert.equal(cleanComment('**好看**\n第二句\n第三句'), '好看 第二句')
  assert.equal(cleanComment('[沉默]'), '')
  assert.equal(cleanComment('x'.repeat(100)).length, 60)
  const now = Date.now()
  const feeds = [
    { appid: 311, uin: 1, key: 'a', time: now / 1000 - 60 },
    { appid: 6600, uin: 0, key: 'ad', time: now / 1000 },
    { appid: 311, uin: 9, key: 'mine', time: now / 1000 },
    { appid: 311, uin: 2, key: 'old', time: now / 1000 - 2 * 86400 },
  ]
  assert.deepEqual(pickFeeds(feeds, '9', now).map((f) => f.key), ['a'])
})

test('空间互动：一串评论里没回的新消息', async () => {
  const { pendingInThread } = await import('../src/features/qzone-social.js')
  const me = '9'
  assert.deepEqual(pendingInThread({ uin: 1, time: 1, comment_id: 'c1', replies: [] }, me).pending.map((x) => x.id), ['c1'])
  // 她自己的评论下面别人接着回她
  const mine = { uin: 9, time: 1, comment_id: 'c2', replies: [{ uin: 1, time: 2, comment_id: 'r1' }, { uin: 1, time: 3, comment_id: 'r2' }] }
  assert.deepEqual(pendingInThread(mine, me).pending.map((x) => x.id), ['c2/r1', 'c2/r2'])
  // 她已经在串里说了最后一句
  assert.equal(pendingInThread({ uin: 1, time: 1, comment_id: 'c3', replies: [{ uin: 9, time: 2, comment_id: 'r1' }] }, me).pending.length, 0)
  // 处理过的不再算
  assert.equal(pendingInThread(mine, me, new Set(['c2/r1', 'c2/r2'])).pending.length, 0)
})

test('更新：版本比较、仓库名、更新命令、更新说明', async () => {
  const u = await import('../src/core/update.js')
  assert.ok(u.compareVersions('0.3.0', '0.2.9') > 0)
  assert.ok(u.compareVersions('0.10.0', '0.9.0') > 0)
  assert.equal(u.compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(u.repoOf({ repository: { url: 'https://github.com/a/b.git' } }), 'a/b')
  assert.match(u.updateCommand('a/b'), /plugin --profile desktop add github:a\/b$/)
  const log = '# 更新记录\n\n## 0.3.0\n\n- 新的\n\n## 0.2.0\n\n- 旧的'
  assert.equal(u.changelogSection(log, '0.3.0'), '- 新的')
  assert.equal(u.changelogSection(log, '0.2.0'), '- 旧的')
  assert.equal(u.changelogSection(log, '9.9.9'), '')
  const check = u.createUpdateChecker({ pkg: { version: '0.2.0', repository: 'https://github.com/a/b' }, fetchImpl: async () => ({ ok: true, json: async () => ({ version: '0.3.0' }) }) })
  const r = await check()
  assert.equal(r.newer, true)
  assert.equal(r.latest, '0.3.0')
})

test('更新后：会公开发东西的新功能，老用户先关着，新安装照常默认开', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-upd-'))
  const prev = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  try {
    const { loadConfig } = await import('../src/core/config.js')
    assert.equal(loadConfig().qzoneSocial.enabled, true, '新安装（还没走完向导）默认开')
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ setupDone: true, botQQ: '1', ownerQQ: '2' }))
    assert.equal(loadConfig().qzoneSocial.enabled, false, '老用户更新：先关着')
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ setupDone: true, qzoneSocial: { enabled: true } }))
    assert.equal(loadConfig().qzoneSocial.enabled, true, '自己打开过的保持打开')
  } finally {
    process.env.AURABOT_DATA_DIR = prev
  }
})

test('空间互动：说说下的评论整理成上下文', async () => {
  const { summarizeComments } = await import('../src/features/qzone-social.js')
  const comments = [
    { uin: 1, name: 'A', content: '好看', comment_id: 'c1', replies: [{ uin: 9, name: '大肥鱼', content: '谢谢' }] },
    { uin: 2, name: '小明', content: '在哪拍的', comment_id: 'c2', replies: [] },
  ]
  assert.deepEqual(summarizeComments(comments, { selfId: '9', ownerQQ: '2', ownerName: '主人' }), ['A：好看', '  └ 你：谢谢', '小明（你的主人）：在哪拍的'])
  assert.deepEqual(summarizeComments(comments, { selfId: '9', exclude: 'c1' }), ['小明：在哪拍的'])
  assert.equal(summarizeComments(comments, { selfId: '9', max: 1 }).at(-1), '……还有 2 条')
})

test('解析：合并转发记下 id，回复里的 <poke> 变成戳一戳', async () => {
  const { parseMessageEvent } = await import('../src/chat/inbound.js')
  const { parseReply } = await import('../src/chat/reply.js')
  const m = parseMessageEvent({ message_type: 'group', group_id: 1, user_id: 2, message: [{ type: 'forward', data: { id: 'abc' } }] }, '9')
  assert.deepEqual(m.forwards, ['abc'])
  assert.match(m.text, /合并转发/)
  assert.deepEqual(parseReply('干嘛<poke>').items.map((i) => i.kind), ['text', 'poke'])
  assert.equal(parseReply('<poke><poke>').items.filter((i) => i.kind === 'poke').length, 1, '一轮最多戳一次')
})

test('#6 改资料权限：默认仅主人私聊；所有人含群；关了都不行；执行时再查', async () => {
  const { normalize } = await import('../src/core/config.js')
  const d = normalize({ ownerQQ: '1' })
  assert.deepEqual(d.profilePerms, { qqNickname: 'owner', qqSignature: 'owner', qqAvatar: 'owner', biliSign: 'owner', biliAvatar: 'owner', qqFriendRequest: 'owner', whitelist: 'owner', douyinBrowse: 'owner', douyinLike: 'owner', douyinComment: 'owner', douyinShareOwner: 'owner', douyinDm: 'owner', heyboxBrowse: 'owner', heyboxLike: 'owner', heyboxComment: 'owner', heyboxPost: 'owner' })
  assert.equal(normalize({ profilePerms: { qqAvatar: 'boss', biliSign: 'all' } }).profilePerms.qqAvatar, 'owner', '乱填的回到默认')
  const ownerPm = { kind: 'private', userId: '1' }
  const otherPm = { kind: 'private', userId: '2' }
  const group = { kind: 'group', userId: '1', groupId: '9' }
  assert.equal(profileToolVisible(d, 'qqNickname', ownerPm), true)
  assert.equal(profileToolVisible(d, 'qqNickname', otherPm), false)
  assert.equal(profileToolVisible(d, 'qqNickname', group), false)
  assert.equal(profilePermits(d, 'qqNickname', ownerPm, true).ok, true)
  assert.equal(profilePermits(d, 'qqNickname', ownerPm, false).ok, false, '主人私聊里混进了别人的话也不行')
  const all = normalize({ ownerQQ: '1', profilePerms: { qqNickname: 'all' } })
  assert.equal(profileToolVisible(all, 'qqNickname', group), true)
  assert.equal(profilePermits(all, 'qqNickname', otherPm, false).ok, true)
  // system 会话（定时刷等后台轮次）现在要挂工具：插件自己开的可信上下文，视同主人（修复：定时刷里 heybox_* 挂不上）
  assert.equal(profileToolVisible(all, 'qqNickname', { kind: 'system' }), true)
  const off = normalize({ ownerQQ: '1', profilePerms: { qqNickname: 'off' } })
  assert.equal(profileToolVisible(off, 'qqNickname', ownerPm), false)
  assert.equal(profilePermits(off, 'qqNickname', ownerPm, true).ok, false)
})

test('#6 头像来源：显式网址直接给网关；「刚才那张」和「画作」由工具取字节；本地路径不收', () => {
  assert.deepEqual(avatarSource('https://a.com/x.png'), { ok: true, file: 'https://a.com/x.png' })
  // last / 画作编号 现在在工具里换成本地图片字节，不再走 avatarSource
  assert.equal(avatarSource('last').ok, false)
  assert.equal(avatarSource('C:/Windows/x.png').ok, false)
  assert.equal(avatarSource('file:///etc/passwd').ok, false)
  assert.equal(avatarSource('base64://AAAA').ok, false)
})

test('#28 QQ 网关：默认 SnowLuma；接自己的 OneBot 机器人时用 onebot；乱填的回到 SnowLuma', async () => {
  const { normalize } = await import('../src/core/config.js')
  assert.equal(normalize({}).gateway, 'snowluma')
  assert.equal(normalize({ gateway: 'onebot', snowluma: { wsUrl: 'ws://napcat:3001' } }).gateway, 'onebot')
  assert.equal(normalize({ gateway: 'onebot', snowluma: { wsUrl: 'ws://napcat:3001' } }).snowluma.wsUrl, 'ws://napcat:3001')
  assert.equal(normalize({ gateway: 'whatever' }).gateway, 'snowluma')
})

test('#32 工作区位置：面板填的绝对路径优先，相对路径 / 乱填的当没填', async () => {
  const { normalize } = await import('../src/core/config.js')
  const { workspaceDirOf, WORKSPACE_DIR } = await import('../src/chat/workspace.js')
  assert.equal(normalize({}).workspaceDir, '')
  assert.equal(workspaceDirOf(normalize({})), WORKSPACE_DIR)
  assert.equal(workspaceDirOf(normalize({ workspaceDir: ' D:\\Aurabot\\qq-chats ' })), 'D:\\Aurabot\\qq-chats')
  assert.equal(workspaceDirOf(normalize({ workspaceDir: '/srv/aurabot/chats' })), '/srv/aurabot/chats')
  assert.equal(normalize({ workspaceDir: 'chats' }).workspaceDir, '')
  assert.equal(normalize({ workspaceDir: '..\\x' }).workspaceDir, '')
})
