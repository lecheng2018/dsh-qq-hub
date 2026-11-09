import test from 'node:test'
import assert from 'node:assert/strict'

import { createHostEffects } from '../src/host/effects.js'

const log = { debug() {}, info() {}, warn() {}, error() {} }

function setup() {
  const calls = []
  const effects = []
  const service = {
    async ask(req) {
      calls.push(['original', req])
      return { source: 'original' }
    },
  }
  const ctx = {
    effect(fn) { effects.push(fn) },
    get(name) { return name === 'userQuestions' ? service : null },
  }
  const hub = {
    async askUserQuestion(chatId, req) {
      calls.push(['qq', chatId, req])
      return { source: 'qq' }
    },
  }
  const effectsApi = createHostEffects({
    ctx, logger: log, log, getConfig: () => ({}), hub,
    mods: {}, use: () => null, snowluma: {}, onebot: {}, gatewayState: {},
    chatKeyOfSession: (sid) => sid === 'qq-session' ? 'private:10000001' : '',
  })
  effectsApi.setupUserQuestions()
  return { calls, effects, service }
}

test('userQuestions：QQ 会话走 QQ 提问卡，其他会话调用原服务', async () => {
  const { calls, effects, service } = setup()
  assert.equal(effects.length, 1, '必须注册可卸载的服务包装')
  const cleanup = effects[0]()
  const qq = await service.ask({ agent: { session: { id: 'qq-session' } } })
  assert.equal(qq.source, 'qq')
  const other = await service.ask({ agent: { session: { id: 'other-session' } } })
  assert.equal(other.source, 'original')
  assert.equal(calls[0][0], 'qq')
  assert.equal(calls[1][0], 'original')
  cleanup()
})

test('userQuestions：卸载后恢复原服务，不保留旧会话闭包', async () => {
  const { calls, effects, service } = setup()
  const cleanup = effects[0]()
  const original = calls
  assert.equal(typeof cleanup, 'function')
  cleanup()
  const result = await service.ask({ agent: { session: { id: 'qq-session' } } })
  assert.equal(result.source, 'original')
  assert.equal(original.length, 1)
})
