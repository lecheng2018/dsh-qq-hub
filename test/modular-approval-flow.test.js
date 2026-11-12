import test from 'node:test'
import assert from 'node:assert/strict'

import { createHostEffects } from '../src/host/effects.js'

const log = { debug() {}, info() {}, warn() {}, error() {} }

function setup({ initialService, approvalOverride } = {}) {
  const calls = []
  const effects = []
  const service = initialService || {
    async request(req) {
      calls.push(['original', req])
      return 'original-allowed'
    },
  }
  const ctx = {
    effect(fn) { effects.push(fn) },
    get(name) { return name === 'approval' ? service : null },
  }
  const approvals = approvalOverride || {
    async request(req, opts) {
      calls.push(['qq', req, opts])
      return 'qq-allowed'
    },
  }
  const effectsApi = createHostEffects({
    ctx, logger: log, log, getConfig: () => ({}), hub: {},
    interactions: { approvals },
    mods: {}, use: () => null, snowluma: {}, onebot: {}, gatewayState: {},
    chatKeyOfSession: (sid) => (sid === 'qq-session' ? 'private:10000001' : ''),
  })
  effectsApi.installApprovalFlow()
  return { calls, effects, service }
}

test('approval: QQ 会话走 QQ 审批卡，其他会话走原服务', async () => {
  const { calls, effects, service } = setup()
  assert.equal(effects.length, 1, '必须注册可卸载的 approval 服务包装')
  const cleanup = effects[0]()

  const qq = await service.request({
    agent: { session: { id: 'qq-session' } },
    toolName: 'bash',
    arguments: { command: 'ls' },
  })
  assert.equal(qq, 'qq-allowed')
  assert.equal(calls[0][0], 'qq')
  assert.equal(calls[0][2].chatId, 'private:10000001')

  const other = await service.request({
    agent: { session: { id: 'other-session' } },
    toolName: 'bash',
  })
  assert.equal(other, 'original-allowed')
  assert.equal(calls[1][0], 'original')

  cleanup()
})

test('approval: 卸载后恢复原服务，不保留旧闭包', async () => {
  const { calls, effects, service } = setup()
  const cleanup = effects[0]()

  assert.equal(typeof cleanup, 'function')
  cleanup()

  const result = await service.request({
    agent: { session: { id: 'qq-session' } },
    toolName: 'bash',
  })
  assert.equal(result, 'original-allowed')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'original')
})

test('approval: 插件热重载时接管新注册表，不闭包悬挂旧实例', async () => {
  const service = {
    async request(req) {
      return 'root-original'
    },
  }

  // 第一代加载
  const gen1Calls = []
  const gen1 = setup({
    initialService: service,
    approvalOverride: {
      async request(req, opts) {
        gen1Calls.push(['gen1', req, opts])
        return 'gen1-handled'
      },
    },
  })
  const cleanup1 = gen1.effects[0]()

  // 第二代热重载（cleanup1 执行，或即便是覆盖式重新加载）
  cleanup1()

  const gen2Calls = []
  const gen2 = setup({
    initialService: service,
    approvalOverride: {
      async request(req, opts) {
        gen2Calls.push(['gen2', req, opts])
        return 'gen2-handled'
      },
    },
  })
  const cleanup2 = gen2.effects[0]()

  const res = await service.request({
    agent: { session: { id: 'qq-session' } },
    toolName: 'bash',
  })

  assert.equal(res, 'gen2-handled')
  assert.equal(gen1Calls.length, 0, '旧注册表不应被调用')
  assert.equal(gen2Calls.length, 1, '新注册表必须被正确调用')

  cleanup2()
})
