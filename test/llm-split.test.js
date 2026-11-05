// 模型断句（2026-11-05，参考 MaiMBot 的 llm_sentence_splitter）：
// 规则分条只能整条发的长回复，多问一次模型让它挑断点。三条纪律都要守住：
// 只准移动断点不准改字、说 no_split 就照规则发、任何异常退回规则分条。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseSplitPayload, acceptSplit, worthLlmSplit, llmSplit, squash, looksStructured } from '../src/chat/llm-split.js'

const BODY = '刚拉的 11:42 那会儿的数 剩 93% 已烧 7% 结论没变 周额度基本没动 这一窗口再烧 35% 就得等 14:22 哥 刚才我查生图那几轮掉得挺快'
const GOOD = [
  '刚拉的 11:42 那会儿的数 剩 93% 已烧 7%',
  '结论没变 周额度基本没动',
  '这一窗口再烧 35% 就得等 14:22',
  '哥 刚才我查生图那几轮掉得挺快',
]

test('模型返回的四种形态都能认：数组、```json 围栏、no_split、看不懂', () => {
  assert.deepEqual(parseSplitPayload('["a。","b。"]').segments, ['a。', 'b。'])
  assert.deepEqual(parseSplitPayload('```json\n["a。","b。"]\n```').segments, ['a。', 'b。'])
  assert.equal(parseSplitPayload('no_split').noSplit, true)
  assert.equal(parseSplitPayload('"no_split"').noSplit, true)
  assert.equal(parseSplitPayload('我觉得不用拆').ok, false)
  assert.equal(parseSplitPayload('').ok, false)
  assert.equal(parseSplitPayload('["只有一条。"]').ok, false, '少于两条不算断句结果')
})

test('只准移动断点：拼接后和原文一致才收，忽略空白差异', () => {
  assert.equal(squash(GOOD.join('')), squash(BODY))
  assert.deepEqual(acceptSplit(BODY, GOOD), GOOD)
  // 模型爱在中文和英文之间补空格，这种不算改字
  const spaced = GOOD.map((x) => ` ${x} `)
  assert.deepEqual(acceptSplit(BODY, spaced), GOOD)
})

test('改了字就整条丢弃（不许它顺手润色）', () => {
  const rewritten = [...GOOD]
  rewritten[1] = '结论变了 周额度基本没动'
  assert.equal(acceptSplit(BODY, rewritten), null)
  const dropped = GOOD.slice(0, 3)
  assert.equal(acceptSplit(BODY, dropped), null, '少了一截也不能收')
})

test('条数超过上限时均匀合并，不把剩下的全塞进最后一条', () => {
  const many = BODY.split(' ')
  const out = acceptSplit(BODY, many, { maxSegments: 3 })
  assert.equal(out.length, 3)
  assert.equal(squash(out.join('')), squash(BODY))
  assert.ok(out.every((x) => x.length > 0))
})

test('只有「规则只分出一条，而且够长」才值得多问一次模型', () => {
  assert.equal(worthLlmSplit('哈哈哈行', ['哈哈哈行']), false, '短句不问')
  assert.equal(worthLlmSplit('x'.repeat(200), ['x'.repeat(200)]), true)
  assert.equal(worthLlmSplit('x'.repeat(200), ['x'.repeat(100), 'x'.repeat(100)]), false, '规则已经分开就不问')
  assert.equal(worthLlmSplit('x'.repeat(2000), ['x'.repeat(2000)]), false, '太长也不问')
  assert.equal(worthLlmSplit('x'.repeat(200), ['x'.repeat(200)], { enabled: false }), false, '关掉不问')
  assert.equal(worthLlmSplit('```\n' + 'x'.repeat(200) + '\n```', ['x']), false, '代码块不问')
})

test('问不成就按规则发：抛错、超时、no_split 都返回 null', async () => {
  assert.equal(await llmSplit(BODY, { ask: async () => { throw new Error('连不上') } }), null)
  assert.equal(await llmSplit(BODY, { ask: async () => 'no_split' }), null)
  assert.equal(await llmSplit(BODY, { ask: async () => '我说不清' }), null)
  assert.equal(await llmSplit(BODY, {}), null, '没有 ask 也不炸')
  const ok = await llmSplit(BODY, { ask: async () => JSON.stringify(GOOD) })
  assert.deepEqual(ok, GOOD)
})

test('发送链路接上了模型断句，且失败退回规则分条', () => {
  const hub = readFileSync(new URL('../src/chat/hub.js', import.meta.url), 'utf8')
  assert.match(hub, /worthLlmSplit\(text,/, '发消息前先判断值不值得问模型')
  assert.match(hub, /await llmSplit\(text, \{ ask: \(o\) => askModel\(dsh, \{ cfg, \.\.\.o \}\)/, '用当前配置的模型问')
  assert.match(hub, /const segs = await llmSplit\(text, \{ ask:/, '断句失败返回 null 时沿用规则结果')
})

test('排版型内容（小标题 + 逐行指标）不许拆，整段发', () => {
  const reportA = '刚拉的 11:42 那会儿的数 【5小时窗口】09:22 开 到 14:22 收 剩 35% 已烧 65% 还剩 2.7 小时 【周窗口】09:22 开 到下周三 09:22\n剩 93% 已烧 7%\n还剩 6.9 天\n结论没变'
  const reportB = '刚拉的 12:02 的数\n\n【5小时窗口】09:22 → 14:22\n剩 33% 已烧 67%\n还剩 2.3 小时\n\n【周窗口】09:22 开 到下周三 09:22\n剩 93% 已烧 7%'
  const chat = '哈啊行 那我晚上再弄 你先把那个视频看了 别又忘了'
  assert.equal(looksStructured(reportA), true)
  assert.equal(looksStructured(reportB), true)
  assert.equal(looksStructured(chat), false)
  assert.equal(looksStructured('嗯\n好\n行'), false, '三行短话不是排版，是正常分行聊天')
  assert.equal(worthLlmSplit(reportA, [reportA]), false, '排版型不问模型')
  assert.equal(worthLlmSplit(reportB, [reportB]), false)
})

test('模型给的断点就是最终气泡，不再被规则二次拆碎', () => {
  const hub = readFileSync(new URL('../src/chat/hub.js', import.meta.url), 'utf8')
  assert.ok(hub.includes("capBubbles(segs.map((v) => ({ kind: 'text', value: v }))"), '断点直接成气泡')
  assert.ok(!hub.includes("parseReply(segs.join('|||'), rules)"), '不许把断点丢回规则再拆一遍')
})

test('人设提示词不再教她写小标题和空行排版（这是串里最像报表的源头）', () => {
  const src = readFileSync(new URL('../src/persona/personas.js', import.meta.url), 'utf8')
  assert.ok(!src.includes('空一行留出阅读呼吸感'), '营销排版那条规则必须删掉')
  assert.ok(!src.includes('推荐型号或小标题用【加粗括号】标注'), '同上')
  assert.ok(src.includes('说人话，别写报表'), '要有明确的反报表规则')
})
