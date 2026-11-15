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
