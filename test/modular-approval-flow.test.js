import test from 'node:test'
import assert from 'node:assert/strict'

import { createHostEffects } from '../src/host/effects.js'

const log = { debug() {}, info() {}, warn() {}, error() {} }

/** 构造 Cordis 4 风格 waterfall 桩：访问 ctx.root 会像 Cordis 4 一样直接抛错。 */
function createWaterfallBus() {
  const listeners = new Map()
  return {
    listeners,
    on(event, fn, opts = {}) {
      const list = listeners.get(event) || []
      const entry = { fn, opts }
      if (opts?.prepend) list.unshift(entry)
      else list.push(entry)
      listeners.set(event, list)
      return () => {
        const cur = listeners.get(event) || []
        listeners.set(event, cur.filter((x) => x !== entry))
      }
    },
    async dispatch(event, req, fallback) {
      const list = [...(listeners.get(event) || [])]
      let idx = 0
      const next = async () => {
        if (idx >= list.length) return fallback(req)
        const cur = list[idx++]
        return cur.fn(req, next)
      }
      return next()
    },
  }
}

function setup({ bus = createWaterfallBus(), approvalOverride, initialService } = {}) {
  const calls = []
  const effects = []
  const service = initialService || {
    async request(req) {
      calls.push(['original', req])
      return bus.dispatch('approval/request', req, async () => 'gui-allowed')
    },
  }
  const origRequestRef = service.request
  const ctx = {
    get root() {
      throw new Error('cannot get property "root" without inject')
    },
    effect(fn) { effects.push(fn) },
    on: (event, fn, opts) => bus.on(event, fn, opts),
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
    chatKeyOfSession: (sid) => (sid === 'qq-session' ? 'private:10000001' : ''), /* pii-scan:ignore */
  })
  effectsApi.installApprovalFlow()
  return { calls, effects, service, origRequestRef, bus }
}

test('approval: Cordis 4 直接在 ctx 上挂 approval/request（prepend），不碰 ctx.root 且不 monkey-patch svc.request', async () => {
  const bus = createWaterfallBus()
  // 先挂一个默认 GUI 监听，验证 prepend 优先截获 QQ 会话、非 QQ 会话交回 next()
  bus.on('approval/request', async () => 'gui-fallback')

  const { calls, effects, service, origRequestRef } = setup({ bus })
  assert.equal(effects.length, 1, '必须注册可卸载的 approval/request 监听')
  const cleanup = effects[0]()

  assert.equal(service.request, origRequestRef, '绝不 monkey-patch approval.request（保持审计对完整）')
  const list = bus.listeners.get('approval/request') || []
  assert.equal(list[0]?.opts?.prepend, true, '必须使用 { prepend: true } 注册在 waterfall 队首')

  // DSH 0.2.3 事件形状：arguments 缺省，带 displayReason
  const qq = await service.request({
    agent: { id: 'session-qq-session' },
    toolName: 'bash',
    displayReason: { en: 'Run shell command', zh: '需要执行终端命令' },
    reason: 'fallback reason',
  })
  assert.equal(qq, 'qq-allowed')
  const qqCall = calls.find((c) => c[0] === 'qq')
  assert.ok(qqCall)
  assert.equal(qqCall[2].chatId, 'private:10000001') /* pii-scan:ignore */
  assert.equal(qqCall[2].reason, '需要执行终端命令', '优先使用 displayReason')
  assert.equal(qqCall[2].args, null, 'DSH 0.2.3 缺 arguments 时不报错')

  const other = await service.request({
    agent: { id: 'session-other-session' },
    toolName: 'bash',
  })
  assert.equal(other, 'gui-fallback', '非 QQ 会话必须调用 next() 交给后续应答者')

  cleanup()
})

test('approval: 卸载后摘除 waterfall 监听，不再截获 QQ 会话', async () => {
  const bus = createWaterfallBus()
  const { calls, effects, service } = setup({ bus })
  const cleanup = effects[0]()

  assert.equal(typeof cleanup, 'function')
  cleanup()

  const result = await service.request({
    agent: { session: { id: 'qq-session' } },
    toolName: 'bash',
  })
  assert.equal(result, 'gui-allowed')
  assert.equal(calls.filter((c) => c[0] === 'qq').length, 0)
})

test('approval: 插件热重载时接管新注册表，不闭包悬挂旧实例', async () => {
  const bus = createWaterfallBus()
  const service = {
    async request(req) {
      return bus.dispatch('approval/request', req, async () => 'root-original')
    },
  }

  const gen1Calls = []
  const gen1 = setup({
    bus,
    initialService: service,
    approvalOverride: {
      async request(req, opts) {
        gen1Calls.push(['gen1', req, opts])
        return 'gen1-handled'
      },
    },
  })
  const cleanup1 = gen1.effects[0]()
  cleanup1()

  const gen2Calls = []
  const gen2 = setup({
    bus,
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
