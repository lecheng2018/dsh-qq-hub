// 审计 Q03 / Q08 的回归锁。
//   Q03 · 模块能力计划必须只有一份，boot / sync / reload / 回退都用它；依赖被停时依赖者也要停。
//         过去 planModules 只在 boot() 跑一次，紧接着 sync() 又按 wanted() 直接启动 ——
//         计划在启动一瞬就被绕开，关掉 memory 后 reflection / style 仍会被 sync 拉起来。
//   Q08 · 同步启动与异步启动的差异只允许是「要不要等 setup」。
//         过去 startSync 跳过密码字段登记、默认值补齐与 module/start 事件。
//
// 说明：这里不去读源码字符串（那正是审计批评的「抽象测试」），而是真的把 modules.js
// 装起来，用假模块定义走 boot / sync / stop，观察实际行为。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModules } from '../src/core/modules.js'
import { publicConfig, normalize } from '../src/core/config.js'

const log = {
  info() {}, warn() {}, error() {}, debug() {},
  child: () => log,
}

/** 一套最小宿主：只实现 modules.js 真正会碰的那几样。 */
function harness({ builtins, config = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'qqhub-mod-'))
  let cfg = { ...config }
  const events = []
  const ctx = {
    effect: (fn) => { const off = fn?.(); return () => { try { off?.() } catch {} } },
    get: () => null,
  }
  const mods = createModules({
    ctx,
    core: {
      bridge: { refresh() {} },
      hub: {},
      http: { body: async () => ({}) },
    },
    getConfig: () => cfg,
    setConfig: (next) => { cfg = next; return cfg },
    logger: log,
    version: 'test',
    builtins,
  })
  mods.listen('module/start', (id) => events.push(`start:${id}`))
  mods.listen('module/stop', (id) => events.push(`stop:${id}`))
  return { mods, dir, events, getCfg: () => cfg, setCfg: (c) => { cfg = c }, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const defOf = (id, over = {}) => ({ id, name: id, version: '1.0.0', api: 1, setup: () => ({}), ...over })

test('Q03 · 缺依赖的模块在 sync 阶段也不会被启动（不只是 boot 那一瞬）', async () => {
  const { mods, events, cleanup } = harness({
    builtins: [
      defOf('memory', { provides: ['memory-store'] }),
      defOf('reflection', { requires: ['memory-store'] }),
    ],
    config: { modules: { memory: { enabled: false } } }, // 主库关着
  })
  try {
    mods.boot()
    await new Promise((r) => setTimeout(r, 30))
    // 冷启动 + 首次同步 + 再同步一次：三个时点都不该看到 reflection
    await mods.sync()
    await mods.sync()
    const running = mods.status().filter((m) => m.running).map((m) => m.id)
    assert.ok(!running.includes('reflection'), `缺依赖的模块不得运行，实际：${JSON.stringify(running)}`)
    assert.ok(!events.includes('start:reflection'), '不得发 module/start')
  } finally { await mods.dispose(); cleanup() }
})

test('Q03 · 依赖被停时，依赖者跟着停（不留抓着失效服务的闭包）', async () => {
  const { mods, events, cleanup } = harness({
    builtins: [
      defOf('memory', { provides: ['memory-store'] }),
      defOf('reflection', { requires: ['memory-store'] }),
      defOf('style', { requires: ['memory-store'] }),
      defOf('unrelated', {}),
    ],
  })
  try {
    mods.boot()
    await new Promise((r) => setTimeout(r, 30))
    let running = mods.status().filter((m) => m.running).map((m) => m.id)
    assert.ok(running.includes('memory') && running.includes('reflection') && running.includes('style'), `三个都该跑：${JSON.stringify(running)}`)

    mods.stop('memory')
    running = mods.status().filter((m) => m.running).map((m) => m.id)
    assert.ok(!running.includes('reflection'), '依赖者必须一并停下')
    assert.ok(!running.includes('style'), '依赖者必须一并停下')
    assert.ok(running.includes('unrelated'), '无关模块不受影响')
  } finally { await mods.dispose(); cleanup() }
})

test('Q03 · 配置关掉主库后依赖者不跑；重新打开后两者一起恢复', async () => {
  // 用**配置**控制开关（wanted() 的唯一权威），而不是手动 stop —— 手动 stop 之后
  // sync() 本来就会按配置重新拉起主库，那条路径测不到「依赖缺失」。
  const h = harness({
    builtins: [
      defOf('memory', { provides: ['memory-store'] }),
      defOf('reflection', { requires: ['memory-store'] }),
    ],
    config: { modules: { memory: { enabled: false } } },
  })
  const { mods, cleanup } = h
  try {
    mods.boot()
    await new Promise((r) => setTimeout(r, 30))
    await mods.sync()
    let running = mods.status().filter((m) => m.running).map((m) => m.id)
    assert.ok(!running.includes('memory'), '主库按配置关着，不该跑')
    assert.ok(!running.includes('reflection'), '主库关着时不能拉起依赖者')

    // 重新打开主库 → 下一次 sync 让两者都恢复
    h.setCfg({ ...h.getCfg(), modules: { memory: { enabled: true } } })
    await mods.sync()
    running = mods.status().filter((m) => m.running).map((m) => m.id)
    assert.ok(running.includes('memory'), '主库应重新运行')
    assert.ok(running.includes('reflection'), `依赖者也应随之恢复：${JSON.stringify(running)}`)
  } finally { await mods.dispose(); cleanup() }
})

test('Q08 · 同步启动也要登记密码字段（内置模块不再明文回显）', async () => {
  const { mods, cleanup } = harness({
    builtins: [
      defOf('voice', {
        defaults: { cloudAsrApiKey: '', cloudAsrEnabled: false },
        settings: [{ key: 'cloudAsrApiKey', label: 'API Key', type: 'password' }],
      }),
    ],
  })
  try {
    mods.boot()
    await new Promise((r) => setTimeout(r, 30))
    // 登记发生在启动时（prepareStart → registerSecretField）。
    // 这里要验的是「登记之后面板不再回显明文」，所以把值写进配置再读面板视图；
    // 注意 publicConfig 需要完整配置结构（它逐条走 SECRETS），先 normalize 一份。
    const full = normalize({ ext: { voice: { cloudAsrApiKey: 'sk-secret-value', cloudAsrEnabled: true } } })
    const shown = publicConfig(full)
    assert.equal(shown.ext.voice.cloudAsrApiKey, '', '密码字段不得原样回显')
    assert.equal(shown.ext.voice.cloudAsrApiKey, '', '密码字段不得原样回显')
    assert.equal(shown.ext.voice.cloudAsrApiKeySet, true, '但要告诉面板「已填」')
  } finally { await mods.dispose(); cleanup() }
})

test('Q08 · 同步启动补默认值（面板表单冷启动后就有值可改）', async () => {
  const { mods, getCfg, cleanup } = harness({
    builtins: [defOf('demo', { defaults: { a: 1, b: 'x' } })],
  })
  try {
    mods.boot()
    await new Promise((r) => setTimeout(r, 30))
    const ext = getCfg().ext?.demo || {}
    assert.equal(ext.a, 1, '默认值必须在冷启动后补齐')
    assert.equal(ext.b, 'x')
  } finally { await mods.dispose(); cleanup() }
})

test('Q08 · 同步启动也发 module/start 事件（与异步路径同契约）', async () => {
  const { mods, events, cleanup } = harness({ builtins: [defOf('demo')] })
  try {
    mods.boot()
    await new Promise((r) => setTimeout(r, 30))
    assert.ok(events.includes('start:demo'), `内置模块启动应发 module/start：${JSON.stringify(events)}`)
  } finally { await mods.dispose(); cleanup() }
})

test('Q03 · 定义不合法 / apiVersion 超版的模块被计划剪枝且登记原因', async () => {
  const { mods, cleanup } = harness({
    builtins: [
      defOf('future', { api: 999 }),
      { id: 'broken' }, // 缺 setup
    ],
  })
  try {
    mods.boot()
    await new Promise((r) => setTimeout(r, 30))
    const running = mods.status().filter((m) => m.running).map((m) => m.id)
    assert.ok(!running.includes('future'), 'apiVersion 超版的模块不得运行')
    assert.ok(!running.includes('broken'), '定义不合法的模块不得运行')
  } finally { await mods.dispose(); cleanup() }
})

test('P2 · 依赖倒伏防环：互相声明依赖的用户模块在切安全模式停止时不栈溢出，且全部干净停下', async () => {
  const prevEnv = process.env.DSH_QQ_HUB_DATA_DIR
  const tempDir = mkdtempSync(join(tmpdir(), 'qqhub-p2-cycle-'))
  process.env.DSH_QQ_HUB_DATA_DIR = tempDir
  try {
    const modADir = join(tempDir, 'modules', 'mod-a')
    const modBDir = join(tempDir, 'modules', 'mod-b')
    mkdirSync(modADir, { recursive: true })
    mkdirSync(modBDir, { recursive: true })
    writeFileSync(join(modADir, 'index.mjs'), `export default { id: 'mod-a', name: 'A', version: '1.0.0', api: 1, provides: ['cap-a'], requires: ['cap-b'], setup() { return {} } }`)
    writeFileSync(join(modBDir, 'index.mjs'), `export default { id: 'mod-b', name: 'B', version: '1.0.0', api: 1, provides: ['cap-b'], requires: ['cap-a'], setup() { return {} } }`)

    const h = harness({ builtins: [] })
    const { mods, cleanup } = h
    try {
      await mods.sync()
      let running = mods.status().filter((m) => m.running).map((m) => m.id)
      assert.deepEqual(running.sort(), ['mod-a', 'mod-b'])

      // 切安全模式（safeMode: true），触发停止
      h.setCfg({ ...h.getCfg(), safeMode: true })
      await mods.sync()
      running = mods.status().filter((m) => m.running).map((m) => m.id)
      assert.deepEqual(running, [], '环形依赖双方必须都干净停下')
    } finally {
      await mods.dispose()
      cleanup()
    }
  } finally {
    if (prevEnv) process.env.DSH_QQ_HUB_DATA_DIR = prevEnv
    else delete process.env.DSH_QQ_HUB_DATA_DIR
    rmSync(tempDir, { recursive: true, force: true })
  }
})