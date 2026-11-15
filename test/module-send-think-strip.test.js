// 模块发送桥的出站思考剥离（cleanSegments）回归网。
//
// 背景真机 2026-11-15：主回复链路在 reply-delivery 有 4 层清洗，但模块的
// sendText/sendSegments/reply 直发走 module-send-bridge——spark-x2.6 的思考残片
// 会从这里漏到 QQ。修复在适配层统一过 sanitizeOutbound（含代码块豁免）；
// outbox 本身保持「segments 原样透传」的既有契约（清洗是适配层的事）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createModuleSendBridge } from '../src/host/module-send-bridge.js'

/** 造一个最小桥：outbox.request 捕获收到的 segments（原样记录，供断言）。 */
function makeBridge() {
  const captured = []
  const bridge = createModuleSendBridge({
    hub: { captureOnly: null },
    outbox: { request: async (req) => { captured.push(req); return { gatewayMessageId: 'm1', state: 'sent' } } },
    log: { debug: () => {} },
  })
  return { bridge, captured }
}

const textSegs = (...texts) => texts.map((t) => ({ type: 'text', data: { text: t } }))

test('显式 <think> 思考块在桥上被剥掉，正文保留', async () => {
  const { bridge, captured } = makeBridge()
  await bridge.sendText('private:1000', '<think>用户在问我天气</think>今天晴天')
  const segs = captured[0].segments
  assert.equal(segs[0].data.text, '今天晴天')
})

test('未标记思考段（（思考：…）括号内心段）同样被剥', async () => {
  const { bridge, captured } = makeBridge()
  await bridge.sendText('private:1000', '（思考：要不要回应）晴天')
  assert.equal(captured[0].segments[0].data.text, '晴天')
})

test('整段都是思考残片 → 丢弃不发送（发送一条空消息没有价值）', async () => {
  const { bridge, captured } = makeBridge()
  const r = await bridge.sendText('private:1000', '<think>全是思考没有正文</think>')
  assert.equal(r.state, 'cancelled')
  assert.equal(captured.length, 0, '不进 outbox')
})

test('干净文本零改动（幂等：主链路二次清洗零副作用）', async () => {
  const { bridge, captured } = makeBridge()
  await bridge.sendText('private:1000', '今天天气不错')
  assert.deepEqual(captured[0].segments, [{ type: 'text', data: { text: '今天天气不错' } }])
})

test('代码块豁免：块内文本不被清洗', async () => {
  const { bridge, captured } = makeBridge()
  await bridge.sendText('private:1000', '用法如下\n```\n（思考：这是示例代码）\n```')
  assert.match(captured[0].segments[0].data.text, /（思考：这是示例代码）/, '代码块里的示例不被误剥')
})
