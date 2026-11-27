import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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
  const questions = {
    async ask(chatId, req) {
      calls.push(['qq', chatId, req])
      return { source: 'qq' }
    },
  }
  const effectsApi = createHostEffects({
    ctx, logger: log, log, getConfig: () => ({}), hub: {},
    interactions: { questions },
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


test('userQuestions：主人私聊 preset 声明提问工具，social 不声明', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const presetBlock = (id) => {
    const start = patch.indexOf(`    - id: preset-${id}`)
    assert.ok(start >= 0, `缺少 preset ${id}`)
    const rest = patch.slice(start)
    const next = rest.slice(1).search(/\n    - id: preset-/)
    return next < 0 ? rest : rest.slice(0, next + 1)
  }
  for (const id of ['qq-hub-private', 'qq-hub-private-long']) {
    assert.match(presetBlock(id), /name: '@deepseek-ai\/dsh-tool-ask-user'/, `${id} 首轮不会有 ask_user_question`)
  }
  assert.doesNotMatch(presetBlock('qq-hub-social'), /dsh-tool-ask-user/, '群聊不开放提问卡')
})

test('userQuestions：Cordis 4 优先通过 ctx.on("user-questions/request", ..., { prepend: true }) 挂载', async () => {
  const listeners = []
  const effects = []
  const calls = []
  const ctx = {
    get root() { throw new Error('cannot get property "root" without inject') },
    effect(fn) { effects.push(fn) },
    on(event, fn, opts) {
      assert.equal(event, 'user-questions/request')
      assert.equal(opts?.prepend, true)
      listeners.push(fn)
      return () => {
        const i = listeners.indexOf(fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
  }
  const effectsApi = createHostEffects({
    ctx, logger: log, log, getConfig: () => ({}), hub: {},
    interactions: {
      questions: {
        async ask(chatId, req) { calls.push({ chatId, req }); return { answers: [{ id: 'q1', selected: ['A'] }] } },
      },
    },
    mods: {}, use: () => null, snowluma: {}, onebot: {}, gatewayState: {},
    chatKeyOfSession: (sid) => (sid === 'qq-session' ? 'private:10001' : ''),
  })
  effectsApi.setupUserQuestions()
  const cleanup = effects[0]()
  assert.equal(listeners.length, 1)

  const qqRes = await listeners[0]({ agent: { id: 'session-qq-session' }, questions: [] }, async () => ({ answers: [] }))
  assert.deepEqual(qqRes, { answers: [{ id: 'q1', selected: ['A'] }] })
  assert.equal(calls.length, 1)

  let nextCalled = false
  const otherRes = await listeners[0]({ agent: { id: 'session-other' }, questions: [] }, async () => {
    nextCalled = true
    return { answers: [{ id: 'q1', selected: ['GUI'] }] }
  })
  assert.equal(nextCalled, true)
  assert.deepEqual(otherRes, { answers: [{ id: 'q1', selected: ['GUI'] }] })

  cleanup()
  assert.equal(listeners.length, 0)
})

test('userQuestions：无 ctx.on 时通过 ctx.inject(["userQuestions"], ...) 惰性挂载避免启动竞态', async () => {
  const effects = []
  let injectCb = null
  const calls = []
  const service = {
    async ask(req) {
      calls.push(['original', req])
      return { source: 'original' }
    },
  }
  const ctx = {
    effect(fn) { effects.push(fn) },
    inject(deps, cb) {
      assert.deepEqual(deps, ['userQuestions'])
      injectCb = cb
      return () => { injectCb = null }
    },
  }
  const effectsApi = createHostEffects({
    ctx, logger: log, log, getConfig: () => ({}), hub: {},
    interactions: {
      questions: {
        async ask(chatId, req) { calls.push(['qq', chatId, req]); return { source: 'qq' } },
      },
    },
    mods: {}, use: () => null, snowluma: {}, onebot: {}, gatewayState: {},
    chatKeyOfSession: (sid) => (sid === 'qq-session' ? 'private:10001' : ''),
  })
  effectsApi.setupUserQuestions()
  const cleanup = effects[0]()
  assert.equal(typeof injectCb, 'function')

  // 服务后到时触发 inject 回调
  injectCb({ get: (name) => (name === 'userQuestions' ? service : null) })
  const res = await service.ask({ agent: { id: 'qq-session' } })
  assert.equal(res.source, 'qq')

  cleanup()
  const after = await service.ask({ agent: { id: 'qq-session' } })
  assert.equal(after.source, 'original')
})
