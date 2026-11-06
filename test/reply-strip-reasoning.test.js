// 回归：发到 QQ 的回复必须剥除思考标签与内容（2026-11-06 线上真实 bug）。
//
// 线上事故 1: 模型/中转（Gemini/CPA/DeepSeek）泄漏闭合标签：
//   「别发表情了 小心我把你周五的摸鱼证据全抖出来</thought>」
//   「饭呢 空手套白鲸是吧</thought>」
// 线上事故 2: 推理模型输出成对的 <think>...</think> 或 <thought>...</thought>，
//   如果不剥除，整段思考心理活动会被发到 QQ 群里，丧失拟人感。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReply, stripReasoning, stripMarkdown } from '../src/chat/reply.js'

const textsOf = (s) => parseReply(s).items.filter((i) => i.kind === 'text').map((i) => i.value)

test('剥除孤立泄漏的 </thought> 闭合标签（线上真实 bug）', () => {
  const raw = '别发表情了 小心我把你周五的摸鱼证据全抖出来</thought>'
  const out = textsOf(raw)
  assert.deepEqual(out, ['别发表情了 小心我把你周五的摸鱼证据全抖出来'])
  assert.equal(out.some((t) => t.includes('thought')), false, '不能残留 thought 标签')
})

test('剥除孤立泄漏的 </think> 闭合标签', () => {
  const raw = '饭呢 空手套白鲸是吧</think>'
  const out = textsOf(raw)
  assert.deepEqual(out, ['饭呢 空手套白鲸是吧'])
})

test('整段闭合的 <thought>...</thought> 思考过程被彻底剔除', () => {
  const raw = '<thought>\n用户在摸鱼开玩笑，我打算幽默回怼回去\n</thought>好家伙 把我当成周五KPI了是吧'
  const out = textsOf(raw)
  assert.deepEqual(out, ['好家伙 把我当成周五KPI了是吧'])
})

test('整段闭合的 <think>...</think>（DeepSeek/Qwen 思考块）被彻底剔除', () => {
  const raw = '<think>分析：用户问我吃不吃鱼，我人设是鲸鱼</think>不吃 我是鲸鱼 跟鱼不是一码事'
  const out = textsOf(raw)
  assert.deepEqual(out, ['不吃 我是鲸鱼 跟鱼不是一码事'])
})

test('大小写不敏感：</THOUGHT> 或 <Think> 同样能被干净剔除', () => {
  const raw = '<Think>思考</Think>你好呀</THOUGHT>'
  const out = textsOf(raw)
  assert.deepEqual(out, ['你好呀'])
})

test('若模型只输出了思考块而无正文，整轮判定为沉默不发言', () => {
  const res1 = parseReply('<think>我想不出来该说什么</think>')
  assert.equal(res1.silent, true)
  assert.equal(res1.items.length, 0)

  const res2 = parseReply('<thought>仅有思考</thought>')
  assert.equal(res2.silent, true)
})

test('思考标签不破坏气泡切分（|||）和合法标签（表情/语音）', () => {
  const raw = '<thought>思考1</thought>第一句 <sticker:无语> ||| 第二句</thought>'
  const res = parseReply(raw)
  const texts = res.items.filter((i) => i.kind === 'text').map((i) => i.value)
  const stickers = res.items.filter((i) => i.kind === 'sticker').map((i) => i.value)
  assert.deepEqual(texts, ['第一句', '第二句'])
  assert.deepEqual(stickers, ['无语'])
})

test('stripReasoning 与 stripMarkdown 导出函数直接可用', () => {
  assert.equal(stripReasoning('abc</thought>'), 'abc')
  assert.equal(stripMarkdown('**粗体**</think>'), '粗体')
})
