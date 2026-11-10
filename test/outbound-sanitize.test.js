import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReply } from '../src/chat/reply.js'

const textsOf = (text, rules) => parseReply(text, rules).items.filter((item) => item.kind === 'text').map((item) => item.value)

test('移除 DSML 中的工具调用、工具结果和 analysis，只发送 final 正文', () => {
  const raw = [
    '<|im_start|>assistant to=python.exec<|meta_sep|>analysis<|im_sep|>print(1 + 1)<|ghissue|><|im_end|>',
    '<|im_start|>python.exec<|meta_sep|>tool<|im_sep|>2<|im_end|>',
    '<|im_start|>assistant<|meta_sep|>analysis<|im_sep|>我应该先检查上下文。<|im_end|>',
    '<|im_start|>assistant<|meta_sep|>final<|im_sep|>算出来是 2。<|im_end|>',
  ].join('\n')

  assert.deepEqual(textsOf(raw), ['算出来是 2。'])
})

test('移除 DeepSeek DSML function_calls/invoke 工具调用块', () => {
  const raw = '结果是 2。<｜DSML｜function_calls><｜DSML｜invoke name="python"><｜DSML｜parameter name="code">print(1 + 1)</｜DSML｜parameter></｜DSML｜invoke><｜DSML｜/function_calls>'
  assert.deepEqual(textsOf(raw), ['结果是 2。'])
})

test('移除没有完整 DSML 外壳的 assistant 工具调用残片', () => {
  assert.deepEqual(textsOf('我查一下。\nassistant to=qq_chat_history 查聊天记录\n{"limit":10}'), ['我查一下。'])
})

test('提示词或人设全文复读时只保留复读前的普通正文', () => {
  const raw = '你先等我一下。你是大肥鱼，一个真实存在的人，正在用手机 QQ 和对面聊天。不是 AI，不是助手，不是机器人。'
  assert.deepEqual(textsOf(raw), ['你先等我一下。'])
})

test('复读多个系统提示章节时从第一节起截断', () => {
  const raw = '我知道了。\n【你现在在 QQ 上】只写你要说的话。\n【怎么说话：像人在打字】每条最多两句。'
  assert.deepEqual(textsOf(raw), ['我知道了。'])
})

test('普通回复、@、引用和合法 QQ 特殊标记不受影响', () => {
  const raw = '在呢 <at:10002>。<reply:42>我看到你引用的消息了 <sticker:开心>'
  assert.deepEqual(parseReply(raw).items, [
    { kind: 'text', value: '在呢 <at:10002>。' },
    { kind: 'text', value: '我看到你引用的消息了', replyTo: '42' },
    { kind: 'sticker', value: '开心' },
  ])
})

test('代码块和 JSON 示例中的 DSML 与人设字样按示例原样保留', () => {
  const code = '```text\n<|im_start|>assistant to=python.exec\n你是大肥鱼，一个真实存在的人\n```'
  const json = '{"example":"<|im_start|>assistant to=python.exec","persona":"你是大肥鱼，一个真实存在的人"}'

  assert.deepEqual(textsOf(code), ['<|im_start|>assistant to=python.exec\n你是大肥鱼，一个真实存在的人'])
  assert.deepEqual(textsOf(json, { maxChars: 1000 }), [json])
})
