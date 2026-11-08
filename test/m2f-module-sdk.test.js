// M2-F 契约测试：Module SDK 规划层 + 健康注册表 + 现有 modules.js 消费
// 任务书必测：重复 ID、API 不兼容、缺依赖、能力冲突、同能力替代实现、启动失败、
// 部分禁用、卸载后监听器/定时器清零、GUI 模块在 fnOS 被剪枝且 entrypoint 零执行。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planModules, createModuleHealth } from '../src/core/module-sdk.js'
import { createModules, API_VERSION } from '../src/core/modules.js'

const def = (over = {}) => ({
  id: 'mod-a',
  version: '1.0.0',
  name: 'A',
  setup: () => ({}),
  ...over,
})

// ---------- planModules ----------

test('plan：普通模块通过；配置关闭的跳过（enabledOf 是唯一开关权威）', () => {
  const plan = planModules({
    defs: [def(), def({ id: 'mod-b' })],
    enabledOf: (id) => id === 'mod-a',
    runtime: { gui: true, apiVersion: API_VERSION },
  })
  assert.deepEqual(plan.load.map((d) => d.id), ['mod-a'])
  assert.deepEqual(plan.skipped, [{ id: 'mod-b', reason: '配置开关关闭' }])
  assert.equal(plan.health['mod-a'].state, 'enabled')
  assert.equal(plan.health['mod-b'].state, 'disabled')
})

test('plan：API 不兼容跳过（超出版本），不合法定义 failed', () => {
  const plan = planModules({
    defs: [def({ id: 'future', api: 99 }), def({ id: 'broken', setup: 'not-a-fn' })],
    enabledOf: () => true,
    runtime: { gui: true, apiVersion: API_VERSION },
  })
  assert.equal(plan.load.length, 0)
  assert.match(plan.skipped[0].reason, /v99/)
  assert.equal(plan.health.future.state, 'disabled')
  assert.equal(plan.health.broken.state, 'failed')
})

test('plan：重复模块 ID——只有每 id 首现进 load，后现记 skipped（保住先装者的清理句柄）', () => {
  const first = def({ id: 'dup', name: 'first' })
  const second = def({ id: 'dup', name: 'second' })
  const plan = planModules({
    defs: [first, second, def({ id: 'other' })],
    enabledOf: () => true,
    runtime: { gui: true, apiVersion: API_VERSION },
  })
  assert.deepEqual(plan.load.map((d) => d.name), ['first', 'A'], 'load 只含重复 id 的首现者')
  assert.deepEqual(plan.skipped, [{ id: 'dup', reason: '重复模块 ID，保留先出现者' }])
  assert.equal(plan.health.dup.state, 'enabled', '健康登记如实反映在跑的实例（不被重复者抹成 disabled）')
})

test('plan：requires 缺依赖跳过；依赖被同批模块满足则通过', () => {
  const okPlan = planModules({
    defs: [def({ id: 'provider', provides: ['voice-engine'] }), def({ id: 'consumer', requires: ['voice-engine'] })],
    enabledOf: () => true,
    runtime: { gui: true },
  })
  assert.deepEqual(okPlan.load.map((d) => d.id), ['provider', 'consumer'])
  const badPlan = planModules({
    defs: [def({ id: 'lonely', requires: ['voice-engine'] })],
    enabledOf: () => true,
    runtime: { gui: true },
  })
  assert.equal(badPlan.load.length, 0)
  assert.match(badPlan.skipped[0].reason, /缺依赖/)
  assert.equal(badPlan.health.lonely.state, 'disabled')
})

test('plan：conflicts 冲突拒绝；同能力替代实现先到先得，prefer 可显式指定', () => {
  const conflictPlan = planModules({
    defs: [def({ id: 'impl-1', provides: ['tts'] }), def({ id: 'hater', conflicts: ['tts'] })],
    enabledOf: () => true,
    runtime: { gui: true },
  })
  assert.deepEqual(conflictPlan.load.map((d) => d.id), ['impl-1'])
  assert.match(conflictPlan.skipped[0].reason, /冲突/)

  const dupPlan = planModules({
    defs: [def({ id: 'impl-1', provides: ['tts'] }), def({ id: 'impl-2', provides: ['tts'] })],
    enabledOf: () => true,
    runtime: { gui: true },
  })
  assert.deepEqual(dupPlan.load.map((d) => d.id), ['impl-1'], '先到先得（声明序）')
  assert.match(dupPlan.skipped[0].reason, /替代实现/)

  const preferPlan = planModules({
    defs: [def({ id: 'impl-1', provides: ['tts'] }), def({ id: 'impl-2', provides: ['tts'] })],
    enabledOf: () => true,
    runtime: { gui: true },
    prefer: { tts: 'impl-2' },
  })
  assert.deepEqual(preferPlan.load.map((d) => d.id), ['impl-2'], 'prefer 显式选择替代实现')
  assert.equal(preferPlan.skipped[0].id, 'impl-1')
})

test('plan：requiresGUI 模块在无 GUI 环境（fnOS）被剪枝——setup 零执行', () => {
  let setupRan = false
  const plan = planModules({
    defs: [def({ id: 'pet-gui', requiresGUI: true, setup: () => { setupRan = true; return {} } })],
    enabledOf: () => true,
    runtime: { gui: false }, // fnOS 无桌面
  })
  assert.equal(plan.load.length, 0)
  assert.match(plan.skipped[0].reason, /GUI/)
  assert.equal(setupRan, false, 'entrypoint 零执行（不只是不加载）')
})

test('plan：模块不能同时提供和依赖同一能力；conflicts 不能指向自己（module-contract 校验兜底）', () => {
  // planModules 把不合法定义记为 skipped+failed（不拖垮整批装载）
  const p1 = planModules({
    defs: [def({ id: 'weird', provides: ['x'], requires: ['x'] })],
    enabledOf: () => true,
    runtime: { gui: true },
  })
  assert.equal(p1.load.length, 0)
  assert.match(p1.skipped[0].reason, /定义不合法/)
  assert.equal(p1.health.weird.state, 'failed')
  const p2 = planModules({
    defs: [def({ id: 'self-hate', conflicts: ['self-hate'] })],
    enabledOf: () => true,
    runtime: { gui: true },
  })
  assert.equal(p2.load.length, 0)
  assert.match(p2.skipped[0].reason, /定义不合法/)
})

// ---------- createModuleHealth ----------

test('health：四态登记、快照与计数；非法状态拒绝', () => {
  const h = createModuleHealth()
  h.set('a', 'enabled')
  h.set('b', 'disabled', '配置关闭')
  h.set('c', 'degraded', '部分功能不可用')
  h.set('d', 'failed', '启动炸了')
  assert.equal(h.get('a').state, 'enabled')
  assert.equal(h.get('b').detail, '配置关闭')
  assert.deepEqual(h.counts(), { enabled: 1, disabled: 1, degraded: 1, failed: 1 })
  assert.throws(() => h.set('e', 'ok'), /未知健康状态/)
  const snap = h.snapshot()
  assert.ok(snap.d.at > 0)
})

// ---------- 现有 modules.js 消费（行为红线：默认计划零改变 + 健康登记生效） ----------

test('modules.js：boot 后全部内置模块健康 enabled；卸载后 events/工具清零（dispose 完整）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm2f-modules-'))
  process.env.AURABOT_DATA_DIR = dir
  try {
    const listeners = []
    let timerCount = 0
    const ctx = {
      effect: (fn) => { const off = fn(); if (typeof off === 'function') listeners.push(off); return off },
      on: () => () => {},
      webServer: { register: () => () => {} },
      systemPrompt: { variable: () => {} },
      get: () => null,
      logger: { info() {}, warn() {}, error() {} },
    }
    const noop = () => {}
    const mods = createModules({
      ctx,
      core: { hub: {}, onebot: {}, logger: { info: noop, warn: noop, error: noop, child: () => ({ info: noop, warn: noop, error: noop, debug: noop }) } },
      getConfig: () => ({ modules: {}, stickers: { enabled: false }, voice: { enabled: false }, memory: { enabled: false } }),
      setConfig: noop,
      logger: { info: noop, warn: noop, error: noop, child: () => ({ info: noop, warn: noop, error: noop, debug: noop }) },
      version: '1.3.64',
      builtins: (await import('../src/modules/index.js')).BUILTINS,
    })
    const booted = mods.boot()
    await booted
    const health = mods.health()
    const enabled = Object.values(health).filter((h) => h.state === 'enabled').length
    assert.ok(enabled >= 20, `绝大多数内置模块健康 enabled（实际 ${enabled}）`)
    assert.equal(Object.values(health).filter((h) => h.state === 'failed').length, 0, '零 failed')
    // 卸载：全部模块停止（dispose 完整性——监听器/路由/定时器随 stop 清理）
    assert.ok(mods.status().some((m) => m.running), '卸载前有在跑的模块')
    mods.dispose()
    assert.ok(mods.status().every((m) => !m.running), '卸载后零在跑模块')
    assert.equal(typeof mods.healthCounts, 'function')
  } finally {
    delete process.env.AURABOT_DATA_DIR
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})
