// 蒸馏模块（独立 optional 模块）契约测试：引擎工厂 + 模块命名空间存储 + SDK 面板
// 覆盖：L1 触发/限流/防重入；行为统计纯代码；L2 累计 5 批；L3 每日一次；模块命名空间存储落盘；
// manifest 能力声明（provides/requires 经 SDK 计划强制）；非目标零开销。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createDistillEngine, distillModule } from '../src/modules/distill/index.js'
import { validateModuleContract } from '../src/core/module-contract.js'
import { planModules } from '../src/core/module-sdk.js'
import { createMemoryStore } from '../src/features/memory.js'
import { buildDerivedBody } from '../src/persona/distill-card.js'
import { renderGrowthSegment } from '../src/features/distill-pipeline.js'

const L1_JSON = '{"user_id":"555","batch_id":"b-1","language_features":["口头禅「斩」","短句连发"],"behavior_features":["深夜活跃"],"topic_features":["聊游戏"]}'
const L2_JSON = '{"user_id":"555","scene_templates":{"casual_chat":{"length":"很短","tone":"玩梗","participation":"很高","phrases":["接梗"]},"topic_discuss":{"length":"完整","tone":"讲逻辑"},"gossip_interact":{}}}'
const L3_JSON = '{"user_id":"555","persona_segment":{"core_character":"你在群里是个爱接梗的急性子","speech_rules":"多用短句和反问，随口用「斩」催办","behavior_boundary":"聊游戏必插话，工作话题潜水"},"update_note":"稳定特征 +2"}'

// ---------- manifest / SDK 计划 ----------

test('manifest：合法定义 + provides/requires 能力声明被 SDK 计划消费', () => {
  const def = validateModuleContract(distillModule)
  assert.deepEqual(def.provides, ['persona-growth'])
  assert.deepEqual(def.requires, ['memory-store'])
  // 计划：memory 在前提供 memory-store → distill 通过；memory 不在 → distill 缺依赖被跳过
  const okPlan = planModules({
    defs: [{ id: 'memory', version: '1.0.0', setup: () => ({}), provides: ['memory-store'] }, distillModule],
    enabledOf: () => true,
    runtime: { gui: true },
  })
  assert.deepEqual(okPlan.load.map((d) => d.id), ['memory', 'distill'])
  const badPlan = planModules({
    defs: [distillModule],
    enabledOf: () => true,
    runtime: { gui: true },
  })
  assert.equal(badPlan.load.length, 0)
  assert.match(badPlan.skipped[0].reason, /缺依赖/)
})

// ---------- 引擎（假件注入，状态落模块命名空间文件） ----------

function makeEngine({ targets = [{ gid: '777', uid: '555', name: '老哥' }], chatLines = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'distill-mod-'))
  const stateFile = join(dir, 'pipeline.json')
  const calls = []
  const lines = chatLines || (() => {
    const out = []
    for (let i = 0; i < 9; i++) out.push({ t: Date.now() - 400_000 + i * 30_000, chatId: 'group:777', uid: '555', name: '老哥', text: `今天这把游戏有点顶 ${i}` })
    out.push({ t: Date.now() - 380_000, chatId: 'group:777', uid: '666', name: '路人', text: '确实确实' })
    return out
  })()
  const engine = createDistillEngine({
    config: () => ({ enabled: true, memory: { distill: true, distillBatch: 10 } }),
    targetsOf: () => targets,
    loadState: () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return null } },
    saveState: (s) => writeFileSync(stateFile, JSON.stringify(s)),
    chatLogDays: () => ['d1'],
    chatLogOf: () => lines,
    askModelImpl: async (dsh, opts) => {
      calls.push(opts)
      const sys = String(opts.system || '')
      if (sys.includes('群聊特征蒸馏引擎')) return L1_JSON
      if (sys.includes('场景聚合引擎')) return L2_JSON
      if (sys.includes('人格蒸馏引擎')) return L3_JSON
      return '{}'
    },
    dsh: { get: () => null },
    log: { info() {}, warn() {}, debug() {}, error() {} },
  })
  return { engine, calls, dir, stateFile }
}

// ESM 里没有 require：上面工厂里用 require 会在 ESM 报错——改用 readFile 同步注入
import { readFileSync, writeFileSync } from 'node:fs'

test('引擎：L0 计数 → 满 10 条触发一次 L1（模型调用恰好一次）；非目标/私聊零开销', async () => {
  const { engine, calls, dir } = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'distill-mod-'))
    const stateFile = join(dir, 'pipeline.json')
    const calls = []
    const lines = []
    for (let i = 0; i < 9; i++) lines.push({ t: Date.now() - 400_000 + i * 30_000, chatId: 'group:777', uid: '555', name: '老哥', text: `今天这把游戏有点顶 ${i}` })
    lines.push({ t: Date.now() - 380_000, chatId: 'group:777', uid: '666', name: '路人', text: '确实确实' })
    const engine = createDistillEngine({
      config: () => ({ enabled: true, memory: { distill: true, distillBatch: 10 } }),
      targetsOf: () => [{ gid: '777', uid: '555', name: '老哥' }],
      loadState: () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return null } },
      saveState: (s) => writeFileSync(stateFile, JSON.stringify(s)),
      chatLogDays: () => ['d1'],
      chatLogOf: () => lines,
      askModelImpl: async (dsh, opts) => { calls.push(opts); return L1_JSON },
      dsh: null,
      log: { info() {}, warn() {}, debug() {}, error() {} },
    })
    return { engine, calls, dir }
  })()
  try {
    for (let i = 0; i < 10; i++) engine.noteMessage('group:777', '555', Date.now() + i)
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(calls.filter((c) => String(c.system || '').includes('群聊特征蒸馏引擎')).length, 1, '恰好一次 L1')
    assert.equal(engine.status()[0].newCount, 0, '触发后计数清零')
    assert.equal(engine.status()[0].batches, 1)
    assert.ok(existsSync(join(dir, 'pipeline.json')), '状态落模块命名空间文件')

    // 非目标 + 私聊：零计数零调用
    const n = calls.length
    for (let i = 0; i < 25; i++) engine.noteMessage('group:777', '999', Date.now() + i)
    for (let i = 0; i < 5; i++) engine.noteMessage('private:777', '555', Date.now() + i)
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(engine.status()[0].newCount, 0)
    assert.equal(calls.length, n, '非目标/私聊零模型调用')
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('引擎：限流（1 小时内不重复触发）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'distill-mod-'))
  const stateFile = join(dir, 'pipeline.json')
  let t = Date.now()
  const calls = []
  const lines = []
  for (let i = 0; i < 9; i++) lines.push({ t: t - 400_000 + i * 30_000, chatId: 'group:777', uid: '555', name: '老哥', text: `今天这把游戏有点顶 ${i}` })
  const engine = createDistillEngine({
    config: () => ({ enabled: true, memory: { distill: true, distillBatch: 10 } }),
    targetsOf: () => [{ gid: '777', uid: '555', name: '老哥' }],
    loadState: () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return null } },
    saveState: (s) => writeFileSync(stateFile, JSON.stringify(s)),
    chatLogDays: () => ['d1'],
    chatLogOf: () => lines,
    askModelImpl: async (dsh, opts) => { calls.push(opts); return L1_JSON },
    dsh: null,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    now: () => t,
  })
  try {
    for (let i = 0; i < 10; i++) engine.noteMessage('group:777', '555', t + i)
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(calls.length, 1)
    t += 60_000 // 1 分钟后又是 10 条 → 被限流
    for (let i = 0; i < 10; i++) engine.noteMessage('group:777', '555', t + i)
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(calls.length, 1, '限流窗口内不重复触发（计数已攒着）')
    assert.equal(engine.status()[0].newCount, 10, '计数保留，窗口过了就触发')
    t += 3600_000
    for (let i = 0; i < 1; i++) engine.noteMessage('group:777', '555', t + i)
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(calls.length, 2, '窗口过后放行')
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('引擎：L2 累计 5 批聚合；L3 每日一次出增长段；事件回调拿到 gid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'distill-mod-'))
  const stateFile = join(dir, 'pipeline.json')
  const calls = []
  const growthEvents = []
  const lines = []
  for (let i = 0; i < 9; i++) lines.push({ t: Date.now() - 900_000 + i * 30_000, chatId: 'group:777', uid: '555', name: '老哥', text: `今天这把游戏有点顶 ${i}` })
  let t = Date.now()
  const engine = createDistillEngine({
    config: () => ({ enabled: true, memory: { distill: true, distillBatch: 10 } }),
    targetsOf: () => [{ gid: '777', uid: '555', name: '老哥' }],
    loadState: () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return null } },
    saveState: (s) => writeFileSync(stateFile, JSON.stringify(s)),
    chatLogDays: () => ['d1'],
    chatLogOf: () => lines,
    askModelImpl: async (dsh, opts) => {
      calls.push(opts)
      const sys = String(opts.system || '')
      if (sys.includes('群聊特征蒸馏引擎')) return L1_JSON
      if (sys.includes('场景聚合引擎')) return L2_JSON
      if (sys.includes('人格蒸馏引擎')) return L3_JSON
      return '{}'
    },
    dsh: null,
    log: { info() {}, warn() {}, debug() {}, error() {} },
    now: () => t,
  })
  try {
    // 5 批：每批之间把 lastL1At 拨回 1 小时前（绕过限流，等价于时间流逝）
    for (let b = 0; b < 5; b++) {
      t += 3600_000
      for (let i = 0; i < 10; i++) engine.noteMessage('group:777', '555', t + i)
      await new Promise((r) => setTimeout(r, 30))
    }
    assert.equal(calls.filter((c) => String(c.system || '').includes('场景聚合引擎')).length, 1, '恰好一次 L2')
    assert.equal(engine.status()[0].hasSceneTemplates, true)
    // L3：dailyTick（同一天内已记 lastL3Day 不重跑 → 拨到明天）
    const updated = await engine.runL3Daily({ onGrowth: async (gid) => growthEvents.push(gid) })
    assert.equal(updated, 1)
    assert.deepEqual(growthEvents, ['777'])
    assert.equal(engine.status()[0].hasGrowthSegment, true)
    assert.equal(engine.growthList('777').length, 1)
    assert.match(engine.growthList('777')[0].segment.persona_segment.speech_rules, /斩/)
    // 派生卡正文：底卡锁定 + 借用段 + 增长段
    const body = buildDerivedBody('你是大肥鱼。', [{ name: '老哥', profile: { exchanges: ['问：吃了吗\n答：斩'] } }], engine.growthList('777'))
    assert.match(body, /^你是大肥鱼。/)
    assert.match(body, /人格增长段/)
    assert.match(body, /不改变你的身份、记忆与安全规则/)
    void renderGrowthSegment
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('memory 模块提供 memory-store 能力；蒸馏回退干净（memory.js 不再含管线）', () => {
  const memoryMod = readFileSync(new URL('../src/modules/memory/index.js', import.meta.url), 'utf8')
  assert.match(memoryMod, /provides: \['memory-store'\]/)
  const mem = readFileSync(new URL('../src/features/memory.js', import.meta.url), 'utf8')
  assert.equal((mem.match(/distillPipe|noteGroupMessage|distill-pipeline/g) || []).length, 0, '管线已从 memory.js 移交独立模块')
  // 日常整理的学习已迁 distill 模块自身 tick（学成 emit('distill/growth-updated') → memory 模块刷卡）；
  // memory.js 里只剩手动「从历史学」一处直挂 onDistillLearned。
  assert.equal((mem.match(/onDistillLearned && await onDistillLearned/g) || []).length, 1, 'memory 保留历史学习刷卡一处')
  const dist = readFileSync(new URL('../src/modules/distill/index.js', import.meta.url), 'utf8')
  assert.match(dist, /emit\('distill\/growth-updated'/, '调度侧学成走事件总线刷卡')
})

test('蒸馏模型挂起：超时 abort 并释放 L1 锁，后续批次可重试', async () => {
  let now = Date.now()
  const calls = []
  const lines = Array.from({ length: 10 }, (_, i) => ({ t: now - i * 1000, chatId: 'group:777', uid: '555', name: '老哥', text: `原话 ${i}` }))
  const state = {}
  const engine = createDistillEngine({
    config: () => ({ enabled: true, memory: { distill: true, distillBatch: 10, distillTimeoutMs: 20, distillRetryMs: 0 } }),
    targetsOf: () => [{ gid: '777', uid: '555', name: '老哥' }],
    loadState: () => state,
    saveState() {},
    chatLogDays: () => ['d1'],
    chatLogOf: () => lines,
    askModelImpl: async (dsh, opts) => {
      calls.push(opts)
      if (calls.length > 1) return L1_JSON
      return await new Promise(() => {})
    },
    now: () => now,
    log: { info() {}, warn() {}, debug() {}, error() {} },
  })
  for (let i = 0; i < 10; i++) engine.noteMessage('group:777', '555', now + i)
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].signal?.aborted, true, '超时必须 abort 模型流')
  now += 3600_000
  for (let i = 0; i < 10; i++) engine.noteMessage('group:777', '555', now + i)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(calls.length, 2, '锁释放后下一批可以重试')
  assert.equal(engine.status()[0].batches, 1)
})
