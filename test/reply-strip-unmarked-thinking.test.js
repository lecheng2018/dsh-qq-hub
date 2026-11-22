// 无标记思考残片清洗（语义移植上游 aureth-labs/dsh-aurabot-qq PR #348）。
// 背景：stripReasoning 只处理 XML 标签式思考块；模型还会漏出【思考】…【/思考】、
// （思考：…）、「思考过程：」元信息行、「最终回答：」前的推理开场等无标记残片。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReply, stripUnmarkedThinking } from '../src/chat/reply.js'

const textsOf = (s) => parseReply(s).items.filter((i) => i.kind === 'text').map((i) => i.value)

test('无标记思考块：显式【思考】/括号内心段不发出', () => {
  assert.deepEqual(textsOf('【思考】用户想要一个答案，我需要先判断。【/思考】好呀'), ['好呀'])
  assert.deepEqual(textsOf('（思考：她在问我今天做了什么。）今天去散步了'), ['今天去散步了'])
  assert.deepEqual(textsOf('[analysis]user wants a joke[/analysis]好呀'), ['好呀'])
})

test('无标记思考前缀：「思考过程」行与元信息行不会当正文', () => {
  assert.deepEqual(textsOf('思考过程：用户问的是天气，我要简短回答。\n\n今天很晴朗。'), ['今天很晴朗。'])
  assert.deepEqual(textsOf('用户说想听笑话。我需要先判断一下。\n\n好呀，我说一个。'), ['好呀，我说一个。'])
})

test('结构化推理开场后只保留最终回答', () => {
  const text = '用户说想让我讲个故事，我需要先分析一下。\n首先看场景，然后决定怎么回。\n最终回答：从前有一只小鱼。'
  assert.deepEqual(textsOf(text), ['从前有一只小鱼。'])
})

test('正常正文不被误伤（上游保守集合范围内）', () => {
  for (const text of ['分析：这个方案可行。', '我觉得（笑）这个思路很好。', '今天去散步了，风有点大。', '（笑）好呀']) {
    assert.deepEqual(textsOf(text), [text])
  }
})

test('围栏代码块与行内代码里的思考标记豁免', () => {
  const fenced = '看这段代码：\n```\n【思考】示例【/思考】\n```'
  const out = textsOf(fenced)
  assert.equal(out.some((t) => t.includes('【思考】示例【/思考】')), true, '代码块内容必须原样保留')
  const inline = '行内 `【思考】x【/思考】` 不动'
  assert.equal(textsOf(inline).join('').includes('【思考】x【/思考】'), true)
})

test('只有无标记思考而无正文时整轮沉默', () => {
  const res = parseReply('【思考】我想不出来该说什么【/思考】')
  assert.equal(res.silent, true)
  assert.equal(res.items.length, 0)
})

test('与 XML 思考标签串联不冲突', () => {
  assert.deepEqual(textsOf('<think>推理中</think>【思考】残片【/思考】正文在此'), ['正文在此'])
})

test('stripUnmarkedThinking 导出函数直接可用：重叠区间不损坏文本', () => {
  assert.equal(stripUnmarkedThinking('【思考】x【/思考】好呀'), '好呀')
  assert.equal(stripUnmarkedThinking('正常文本'), '正常文本')
  // 显式块与括号段重叠时合并删除，不产生错位
  assert.equal(stripUnmarkedThinking('【思考】（思考：内心）【/思考】尾'), '尾')
  assert.equal(stripUnmarkedThinking(''), '')
})

// 回归：线上事故 2026-11-22（群聊消息泄露内部推理）。
// 反代/上游把**上一轮**推理原样回灌进这一轮的正文 text 块，标记写成
// `[Previous reasoning]…[/Previous reasoning]`。关键词前面多一个 `Previous`，
// 旧的显式块规则（只认紧邻关键词）一条都没匹配上，整段推理被 parseReply 拆成两条
// 气泡发进群，被群友当场发现。
// 夹具用合成内容：只复刻标记结构与「推理段 + 正文段」的拼接形状，不含任何真实昵称或号码。
const LEAKED_SHAPE = '[Previous reasoning]\n'
  + '对方先试探我是不是机器人，按规矩不自证不辩解，随手打发；另一人引用我上一句玩谐音梗，顺着接就行。\n\n'
  + '回两条极短的：\n- 对甲：你猜\n- 对乙：炸吧 归你\n'
  + '[/Previous reasoning]\n\n'
  + '<reply:甲>你猜\n\n<reply:乙>炸吧 归你'

test('回归：反代回灌的 [Previous reasoning] 块不发出，只留正文', () => {
  assert.deepEqual(textsOf(LEAKED_SHAPE), ['你猜', '炸吧 归你'])
  // 推理原文里的任何指纹都不能残留在出站气泡里
  const all = textsOf(LEAKED_SHAPE).join('\n')
  for (const leak of ['Previous reasoning', '不自证不辩解', '回两条极短的', '谐音梗']) {
    assert.equal(all.includes(leak), false, `不能残留推理内容：${leak}`)
  }
})

test('[Previous reasoning] 标记的各种写法都认（大小写／全角／中英前缀）', () => {
  const body = '正文在此'
  for (const marker of [
    ['[Previous reasoning]', '[/Previous reasoning]'],
    ['[previous thinking]', '[/previous thinking]'],
    ['【上一轮思考】', '【/上一轮思考】'],
    ['[Previous reasoning]', '[/reasoning]'],
    ['[分析]', '[/分析]'],
  ]) {
    const raw = `${marker[0]}内部推理不能让群友看见${marker[1]}${body}`
    assert.deepEqual(textsOf(raw), [body], `标记 ${marker[0]} 未被识别`)
  }
})

test('只有 [Previous reasoning] 而没有正文时整轮沉默', () => {
  assert.equal(parseReply('[Previous reasoning]只有推理[/Previous reasoning]').silent, true)
})

test('未闭合的 [Previous reasoning]（截断在开头）删到结尾，不残留半段推理', () => {
  assert.deepEqual(textsOf('[Previous reasoning]推理到一半被截断\n还有第二行'), [])
})

test('裸方括号不算推理标记（误伤边界）：正文里的 [分析] / [思考] 原样保留', () => {
  // 收紧口径：只有带前缀（[Previous reasoning]）或闭合标记才无条件删；裸 [分析] 可能是正常文字。
  // 直接断言清洗函数（不经过气泡切分），避免把「分条」和「清洗」两件事混在一个断言里。
  for (const text of ['[分析]这个方案可行。', '看看[分析]这段', '我[思考]了一下', '[1] 第一点\n[2] 第二点']) {
    assert.equal(stripUnmarkedThinking(text), text)
  }
})
