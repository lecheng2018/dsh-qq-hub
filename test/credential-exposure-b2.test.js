// Batch 2 / T2.7：凭据暴露与身份泄露闸越界。
// 全部用例真实构造对象、调用导出函数。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createSharedOutbox } from '../src/host/shared-outbox.js'
import { vncPublicState } from '../src/browser/service.js'
import { collectSecretValues } from '../src/core/config-secrets.js'
import { registerSecret, redact } from '../src/core/redact.js'
import { createBridge } from '../src/core/bridge.js'

const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }

function outboxFixture() {
  const calls = []
  const cfg = {
    enabled: true,
    dryRun: false,
    ownerQQ: '10001',
    botQQ: '20002',
    allow: { private: ['10001', '20002'], groups: [] },
    security: { identityGuard: { enabled: true, mode: 'block' } },
  }
  const outbox = createSharedOutbox({
    onebot: { call: async (action, params) => { calls.push({ action, params }); return { message_id: 1 } } },
    getConfig: () => cfg,
    log: noopLog,
  })
  return { outbox, calls }
}

test('T2.7：非主人私聊不再豁免主人 QQ 号，只有发给主人本人那条才放行', async () => {
  const { outbox, calls } = outboxFixture()
  const leak = '我主人的号是 10001，记一下'
  const blocked = await outbox.request({
    chatKey: 'private:20002',
    segments: [{ type: 'text', data: { text: leak } }],
  })
  assert.equal(blocked.state, 'cancelled', '非主人私聊必须被身份泄露闸拦下')
  assert.match(String(blocked.reason), /身份泄露闸/)
  assert.equal(calls.length, 0, '被拦下的消息绝不能真的发出去')

  const ok = await outbox.request({
    chatKey: 'private:10001',
    segments: [{ type: 'text', data: { text: leak } }],
  })
  assert.equal(ok.state, 'sent', '发给主人本人要放行')
  assert.equal(calls.length, 1)
})

test('T2.7：浏览器状态视图绝不带明文 VNC 密码', () => {
  const view = vncPublicState({ port: 5900, password: 'a1b2c3d4', lan: false })
  assert.equal('password' in view, false, '状态对象里不能有 password 字段')
  assert.equal(view.passwordSet, true)
  assert.equal(view.port, 5900)
  assert.equal(view.running, true)
  assert.deepEqual(vncPublicState(null), { running: false })
})

test('T2.7：redact 能抹掉全部已登记密钥（含向量/精排/语音凭据）', () => {
  const cfg = {
    snowluma: { webuiPassword: 'panel-pass-1', httpToken: 'http-tok-2', wsToken: 'ws-tok-3' },
    imageGen: { apiKey: 'img-key-4' },
    voice: { doubao: { apiKey: 'asr-key-5' }, qwentts: { apiKey: 'tts-key-6' }, mimo: { apiKey: 'mimo-key-7' } },
    ext: { memory: { vectorApiKey: 'vec-key-8', rerankApiKey: 'rerank-key-9' } },
    memory: { embeddings: { apiKey: 'emb-key-10' } },
    bridge: { token: 'bridge-tok-11' },
  }
  const values = collectSecretValues(cfg)
  for (const v of values) registerSecret(v)
  for (const v of values) {
    const masked = redact(`日志里有 ${v} 这个值`)
    assert.equal(masked.includes(v), false, `没有被抹掉：${v}`)
    assert.match(masked, /\[已隐藏|已隐藏|\*\*\*/)
  }
  // 至少覆盖任务点出的这几类路径
  for (const must of ['vec-key-8', 'rerank-key-9', 'asr-key-5', 'tts-key-6', 'bridge-tok-11']) {
    assert.ok(values.includes(must), `${must} 必须被登记`)
  }
})

test('T2.7：联动接口只认请求头，不再接受 ?token=', () => {
  const cfg = { bridge: { http: true, token: 'tok-secret' } }
  const noop = () => {}
  const bridge = createBridge({
    ctx: { get: () => null, on: noop, effect: noop },
    getConfig: () => cfg,
    setConfig: noop,
    hub: { deliverRaw: async () => ({ ok: true }), sendSegments: async () => ({ ok: true }) },
    mods: { listen: noop, emit: noop, list: () => [] },
    log: noopLog,
    version: '0.0.0-test',
    apiVersion: 1,
    overview: {},
  })
  assert.equal(
    bridge.authorized({ headers: {}, url: '/qq-hub/api/open/send?token=tok-secret' }),
    false,
    'URL 里的 token 绝不能当凭据',
  )
  assert.equal(bridge.authorized({ headers: { authorization: 'Bearer tok-secret' }, url: '/x' }), true)
  assert.equal(bridge.authorized({ headers: { 'x-qq-hub-token': 'tok-secret' }, url: '/x' }), true)
  assert.equal(bridge.authorized({ headers: { authorization: 'Bearer wrong' }, url: '/x' }), false)
})
