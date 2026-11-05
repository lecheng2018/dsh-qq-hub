// 说话的样子（2026-11-05，1.3.43）。
//
// 1.3.43 删掉了「多问一次模型挑断点」，分条重新只剩规则一处判断。这意味着 ||| 这个契约
// 必须真的写进提示词：以前没人教她，她只会糊成一坨，规则只能按句号硬切。
// 这个文件守住三件事：
//   ① 共享规则教 |||、教说人话、教反报表；
//   ② 人设卡里不许再有「空一行留出阅读呼吸感」这类排版要求（报表腔的源头）；
//   ③ 代码里不许再把分条交给模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { rulesText } from '../src/persona/personas.js'
import { normalize } from '../src/core/config.js'
import { parseReply } from '../src/chat/reply.js'

const src = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')

test('共享规则把 ||| 写成唯一的分条记号', () => {
  const r = rulesText('private', normalize({}))
  assert.match(r, /【怎么说话：像人在打字】/)
  assert.ok(r.includes('|||'), '要明确告诉她用 ||| 分条')
  assert.match(r, /换行和空行只是排版/, '别让她以为换行/空行能分条')
  assert.match(r, /一次两三条/)
  assert.match(r, /每条都得是完整的一句话/)
})

test('说人话：反客服腔、先反应再说事、反报表', () => {
  const r = rulesText('social', normalize({}))
  assert.match(r, /不客服腔/)
  assert.match(r, /先反应，再说事/)
  assert.match(r, /说人话，别写报表/)
  assert.doesNotMatch(r, /分行由系统按语义自动处理/, '那句会让她以为分条不归自己管')
})

test('群里比私聊更短：社交规则多一节群聊口径，私聊没有', () => {
  const s = rulesText('social', normalize({}))
  const p = rulesText('private', normalize({}))
  assert.match(s, /【群里怎么说话】/)
  assert.doesNotMatch(p, /【群里怎么说话】/)
  assert.match(s, /群里比私聊更短/)
})

test('人设卡不许教排版：呼吸感 / 【加粗中文括号】那条必须清掉', () => {
  const card = src('personas/dafeiyu.md')
  assert.ok(!card.includes('空一行留出阅读呼吸感'), '营销排版那条规则必须删掉')
  assert.ok(!card.includes('【加粗中文括号】标注'), '同上')
  assert.ok(card.includes('平铺在一条里发完'), '长回答也要按一条人话来写')
})

test('分条不再问模型：代码里没有 llm-split，也没有第二个判断分条的地方', () => {
  assert.equal(existsSync(new URL('../src/chat/llm-split.js', import.meta.url)), false, 'llm-split 已删')
  assert.ok(!/llmSplit|llm-split/.test(src('src/chat/hub.js')), '发送链路不许再调模型断句')
  const cfg = src('src/core/config.js')
  assert.ok(!/bool\(c\.reply\.llmSplit/.test(cfg), '配置不再读这个开关')
  assert.ok(!/reply\.llmSplit/.test(src('client/client.js')), '面板不再有这个开关')
})

test('老配置里的 llmSplit 残留会被丢掉，别的字段照常保留', () => {
  const cfg = normalize({ reply: { llmSplit: true, maxBubbles: 4 } })
  assert.equal('llmSplit' in cfg.reply, false)
  assert.equal(cfg.reply.maxBubbles, 4)
})

test('||| 在发送链路上仍然是硬边界（删模型断句不能把它一起删了）', () => {
  const items = parseReply('在呢|||刚在刷视频', { maxChars: 40, maxBubbles: 6 }).items
  assert.deepEqual(items.map((i) => i.value), ['在呢', '刚在刷视频'])
})
