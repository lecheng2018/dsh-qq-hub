// 群参与契约 T1.1：claimResult 带回真实注册模块 id；无监听器同步返回 null；旧 claim 行为不变。
// 用真实模块内核（createModules + boot + api.on 注册）验证可观察行为，不做源码正则假测试。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModules } from '../src/core/modules.js'

const noop = () => {}
const mkLogger = () => ({ info: noop, warn: noop, error: noop, debug: noop, child: mkLogger })

// 三个真实内置模块：setup 里用 api.on 注册监听（和线上模块同一条注册路径，guard 包装一致）。
const calls = { a: 0, b: 0, c: 0, boom: 0 }
const defOf = (id, fn) => ({ id, name: id, version: '1.0.0', api: 1, setup(api) { api.on('group/participate', fn); return {} } })

const defs = [
  defOf('gp-a', () => { calls.a++; return undefined }), // 永不接管
  defOf('gp-b', () => { calls.b++; return { level: 'react', reaction: { messageId: '10001', emojiId: '66' } } }), // 接管
  defOf('gp-c', () => { calls.c++; return { level: 'full' } }), // 排在 b 后面，b 接管后必须零调用
]

let dataDir
let mods

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gp-modules-'))
  process.env.AURABOT_DATA_DIR = dataDir
  mods = createModules({
    ctx: { effect: () => () => {}, on: () => () => {}, webServer: { register: () => () => {} }, get: () => null, logger: mkLogger() },
    core: { hub: {}, onebot: {}, logger: mkLogger() },
    getConfig: () => ({ modules: {} }),
    setConfig: noop,
    logger: mkLogger(),
    version: '1.4.0',
    builtins: defs,
  })
  await mods.boot()
})

after(() => {
  mods?.dispose()
  delete process.env.AURABOT_DATA_DIR
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
})

test('claimResult：首个 falsy、第二个 truthy → 返回第二个的真实注册 id 和原始值；其后监听器零调用', async () => {
  const r = await mods.claimResult('group/participate', { decision: { reply: true, mode: 'interject' } }, {})
  assert.deepEqual(r, { id: 'gp-b', value: { level: 'react', reaction: { messageId: '10001', emojiId: '66' } } })
  assert.equal(calls.a, 1)
  assert.equal(calls.b, 1)
  assert.equal(calls.c, 0, '首个 truthy 后面的监听器不能被调用')
  // id 来自注册记录，不是值里自报的字段（插件伪造 sourceModuleId 无效）
  assert.notEqual(r.id, r.value.sourceModuleId ?? '')
})

test('claimResult：值里自报 sourceModuleId 也不采信，id 仍来自注册记录', async () => {
  const lone = createModules({
    ctx: { effect: () => () => {}, on: () => () => {}, webServer: { register: () => () => {} }, get: () => null, logger: mkLogger() },
    core: { hub: {}, onebot: {}, logger: mkLogger() },
    getConfig: () => ({ modules: {} }),
    setConfig: noop,
    logger: mkLogger(),
    version: '1.4.0',
    builtins: [defOf('gp-real', () => ({ sourceModuleId: 'fake', level: 'react' }))],
  })
  try {
    await lone.boot()
    const r = await lone.claimResult('group/participate', {}, {})
    assert.equal(r.id, 'gp-real', 'id 必须是真实注册 id')
    assert.equal(r.value.sourceModuleId, 'fake', '原始值原样带回，由宿主自行取舍')
  } finally { lone.dispose() }
})

test('claimResult：完全无监听器的事件同步返回 null（不是 Promise）；有监听器时返回 Promise', async () => {
  const none = mods.claimResult('group/participate-none', {})
  assert.equal(none, null)
  assert.equal(none instanceof Promise, false)
  const some = mods.claimResult('group/participate', {})
  assert.equal(some instanceof Promise, true)
  await some
})

test('claimResult：监听器抛错沿用现有隔离，跳过继续问下一个', async () => {
  const lone = createModules({
    ctx: { effect: () => () => {}, on: () => () => {}, webServer: { register: () => () => {} }, get: () => null, logger: mkLogger() },
    core: { hub: {}, onebot: {}, logger: mkLogger() },
    getConfig: () => ({ modules: {} }),
    setConfig: noop,
    logger: mkLogger(),
    version: '1.4.0',
    builtins: [
      defOf('gp-boom', () => { calls.boom++; throw new Error('炸了') }),
      defOf('gp-after', () => ({ level: 'text_lite', limits: { maxBubbles: 1, maxChars: 80 } })),
    ],
  })
  try {
    await lone.boot()
    const r = await lone.claimResult('group/participate', {}, {})
    assert.equal(calls.boom, 1, '抛错监听器确实被问过')
    assert.deepEqual(r, { id: 'gp-after', value: { level: 'text_lite', limits: { maxBubbles: 1, maxChars: 80 } } })
  } finally { lone.dispose() }
})

test('旧 claim：仍只返回 boolean，true/false 语义不变', async () => {
  const hit = await mods.claim('group/participate', {}, {})
  assert.equal(hit, true)
  assert.equal(typeof hit, 'boolean')
  const miss = await mods.claim('group/participate-none', {}, {})
  assert.equal(miss, false)
  assert.equal(typeof miss, 'boolean')
})
test('claimResult：异步等待期间经 api.on 新注册的监听器不加入本轮（遍历注册快照）', async () => {
  const lateCalls = []
  // api.on 对 listeners 的数组做原地 push；claimResult 若直接 for-of 这个活数组，
  // 等待期间插队的监听器会被本轮问到 —— 必须按提问瞬间的快照走完本轮。
  const snapshotDef = {
    id: 'gp-snapshot', name: '快照测试', version: '1.0.0', api: 1,
    setup(api) {
      api.on('group/participate', async () => {
        api.on('group/participate', () => { lateCalls.push(1); return { level: 'react', late: true } })
        return undefined // falsy：本轮继续往下问
      })
      return {}
    },
  }
  const lone = createModules({
    ctx: { effect: () => () => {}, on: () => () => {}, webServer: { register: () => () => {} }, get: () => null, logger: mkLogger() },
    core: { hub: {}, onebot: {}, logger: mkLogger() },
    getConfig: () => ({ modules: {} }),
    setConfig: noop,
    logger: mkLogger(),
    version: '1.4.0',
    builtins: [snapshotDef],
  })
  try {
    await lone.boot()
    const r = await lone.claimResult('group/participate', {}, {})
    assert.equal(r, null, '本轮必须按快照走完：插队者不参与本轮')
    assert.equal(lateCalls.length, 0, '等待期间经 api.on 注册的监听器不得在本轮被问到')
    // 下一轮才轮到插队者（返回值来自注册记录 id，与上一监听器同 id 也证明它真的被问过）
    const r2 = await lone.claimResult('group/participate', {}, {})
    assert.deepEqual(r2, { id: 'gp-snapshot', value: { level: 'react', late: true } })
    assert.equal(lateCalls.length, 1)
  } finally { lone.dispose() }
})
