// US-016 接线验收：梦境巩固真正跑起来，且墓碑语义不破坏事实源。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryStore } from '../src/features/memory.js'
import { createMemoryLearning } from '../src/features/memory-learning.js'

function realHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'dream-harness-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'migration.json'), JSON.stringify({ status: 'success' }))
  writeFileSync(join(dir, 'memory', 'state.json'), JSON.stringify({ items: [] }))
  process.env.DSH_QQ_HUB_DATA_DIR = dir

  const logs = []
  const store = createMemoryStore({
    dsh: {}, getConfig: () => ({ memory: { enabled: true, dailyConsolidate: true, consolidateTimes: ['04:00'] } }),
    hub: {}, log: { info: (m) => logs.push(String(m)), warn: (m) => logs.push('WARN:' + String(m)) },
  })
  return { store, dir, logs }
}

test('真实实例梦境接线生效：无条目时安全跳过', async (t) => {
  const { store, dir } = realHarness()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const res = await store.dreamConsolidate()
  assert.equal(res.ok, true)
  assert.equal(res.skipped, 'no-facts')
})

test('真实实例梦境巩固去重：立墓碑且绝不产生多余重复副本', async (t) => {
  const { store, dir } = realHarness()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const t1 = '主人下雨天喜欢呆在家里看书'
  const t2 = '下雨天主人最喜欢呆在家里面看书'
  store.add({ text: t1, importance: 0.4, scope: 'private:10001', chatId: 'private:10001' })
  store.add({ text: t2, importance: 0.9, scope: 'private:10001', chatId: 'private:10001' })

  const before = store.listFor(['private:10001'])
  assert.equal(before.length, 2, '初始应有 2 条有效事实')

  const res = await store.dreamConsolidate({ options: { dedupeSimilarity: 0.5 } })
  assert.equal(res.ok, true)
  assert.ok(res.applied >= 1, '应成功为冗余事实立墓碑')

  // 有效事实变为 1 条，绝不能因为 supersede 插入第 3 条条目
  const after = store.listFor(['private:10001'])
  assert.equal(after.length, 1, '去重后有效事实应为 1 条')

  // 检查底层条目：旧事实被打上 invalidAt 和 supersededBy
  const all = store.indexAll().docs.map((d) => d.it)
  assert.equal(all.length, 2, '物理事实总数依然为 2 条（只增不改，不增多也不物理删除）')
  const invalid = all.find((m) => m.invalidAt > 0)
  assert.ok(invalid, '应有 1 条事实被打上墓碑')
  assert.ok(invalid.supersededBy, '墓碑应标明由哪条事实替代')
})

test('真实实例梦境共性归纳：归纳出的经验条目成功持久化进 insights', async (t) => {
  const { store, dir } = realHarness()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  store.add({ text: '主人在周末喜欢看科幻电影', topic: '电影', scope: 'private:10001', chatId: 'private:10001' })
  store.add({ text: '主人平时也常看纪录片和经典电影', topic: '电影', scope: 'private:10001', chatId: 'private:10001' })

  const res = await store.dreamConsolidate()
  assert.equal(res.ok, true)
  assert.ok(Array.isArray(res.experiences) && res.experiences.length > 0, '梦境应产出共性归纳经验')

  const insights = store.insights()
  const dreamInsight = insights.find((item) => item.name === '梦境归纳')
  assert.ok(dreamInsight, '应存在名称为“梦境归纳”的洞察项')
  assert.ok(dreamInsight.list.length > 0, '归纳经验条目应持久化进 insights 列表')
  assert.equal(dreamInsight.list[0].origin, 'derived', '洞察来源应标记为 derived')
  assert.equal(dreamInsight.list[0].sourceFingerprint, 'dream-consolidate')
})

test('单条墓碑写入异常不中断整体，且不删除事实', async () => {
  const learning = createMemoryLearning({
    dsh: {}, getConfig: () => ({ memory: { enabled: true } }),
    hub: {}, log: { info: () => {}, warn: () => {} },
    isActive: () => true,
    load: () => ({ items: [{ id: '1', text: '事实A', scope: 'global' }, { id: '2', text: '事实A。', scope: 'global' }] }),
    save: () => {}, health: () => ({ ok: true }), relatedTo: () => [],
    add: () => ({ ok: true }), revise: () => true, supersede: () => true,
    invalidate: () => { throw new Error('磁盘只读模拟错误') },
    listFor: () => [{ id: '1', text: '事实A', scope: 'global' }, { id: '2', text: '事实A。', scope: 'global' }],
    scopeFromChatId: (s) => s,
    insightsOf: () => [], setDerivedInsights: () => {}, styleOf: () => [], setDerivedStyle: () => {},
    personKey: (s) => s, profileOf: () => null, setDerivedProfile: () => true, profileKeyOf: (s) => s,
    createGenerationSignal: () => ({ isValid: () => true, cleanup: () => {} }),
    generationOf: () => ({ signal: { isValid: () => true }, cleanup: () => {} }),
  })
  const res = await learning.api.dreamConsolidate()
  assert.equal(res.ok, true, '单条失败时整体依然安全完成')
  assert.equal(res.applied, 0, '失败条目未记入成功计数')
})

test('模块接口完整性：dreamConsolidate 成功暴露在 api 与 store 根部', () => {
  const { store, dir } = realHarness()
  assert.equal(typeof store.dreamConsolidate, 'function', 'store 根部应暴露 dreamConsolidate')
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 缺陷 A 回归：梦境巩固必须由**每日整理（真实 tick 路径）**触发。
//
// 之前的用例全部直调 store.dreamConsolidate()，恰好绕开了断点：
// tick() 里按 r.scopes / r.committed 推导作用域，但 consolidate() 的返回值里
// 根本没有这两个字段（见 memory-extractor.js 的 return），于是 scopes 恒为 []，
// `if (scopes.length) await dreamConsolidate(...)` 永远为假 —— 梦境一次都没跑过。
// 所以这里必须走 store.tick()，只断言「真实调度链路上梦境确实执行了」。
// ---------------------------------------------------------------------------

/** 造一个「昨天有聊天流水 + LLM 可脚本化」的真实 store，用于驱动 tick()。 */
function tickHarness(t, { facts = [], replyText = '[]' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-tick-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'migration.json'), JSON.stringify({ status: 'success' }))
  writeFileSync(join(dir, 'memory', 'state.json'), JSON.stringify({ items: [] }))
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  const logs = []
  const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const yesterday = dayOf(new Date(Date.now() - 86_400_000))
  // 6 条以上非机器人发言，才过提炼器的「内容太少/都是寒暄」闸门
  const lines = Array.from({ length: 8 }, (_, i) => ({
    chatId: 'private:10001', who: '主人', uid: '10001', text: `今天聊的第 ${i} 件具体事情，说得很清楚`,
  }))
  const store = createMemoryStore({
    dsh: {
      get: () => null,
      llm: {
        async *stream(params) {
          const system = String(params.system || '')
          let text = replyText
          if (system.includes('整理长期记忆')) text = JSON.stringify(facts)
          else if (system.includes('{"insights"')) text = '{"insights":[],"style":[]}'
          yield { type: 'text-delta', text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    },
    // consolidateTimes 设 00:00：当天任何时刻 tick 都到点（真实时钟下稳定）
    getConfig: () => ({ ownerQQ: '10001', model: { provider: 'p', model: 'm' }, memory: { enabled: true, dailyConsolidate: true, consolidateTimes: ['00:00'] } }),
    hub: { chatLogDays: () => [yesterday], chatLogOf: () => lines, deleteChatLog() {} },
    log: { info: (m) => logs.push(String(m)), warn: (m, e) => logs.push('WARN:' + String(m) + (e?.message || '')) },
  })
  t.after(() => {
    try { store.dispose() } catch { /* 已关闭 */ }
    rmSync(dir, { recursive: true, force: true })
  })
  return { store, dir, logs }
}

test('缺陷 A：真实 tick 路径会执行梦境巩固（去重真的发生，不是只跑提炼）', async (t) => {
  const { store, logs } = tickHarness(t)
  // 预置两条近似改写的重复事实（同一作用域、同一实体槽位）
  store.add({ text: '主人下雨天喜欢呆在家里看书', importance: 0.4, scope: 'private:10001', chatId: 'private:10001' })
  store.add({ text: '下雨天主人最喜欢呆在家里面看书', importance: 0.9, scope: 'private:10001', chatId: 'private:10001' })
  assert.equal(store.listFor(['private:10001']).length, 2, '前置：应有 2 条有效事实')

  await store.tick()

  // 断点 1：梦境确实被调度了
  assert.ok(
    logs.some((l) => l.includes('梦境巩固')),
    `tick 之后必须有梦境巩固日志，实际日志：${JSON.stringify(logs)}`,
  )
  // 断点 2：事实真的收敛了（不是空转）
  const after = store.listFor(['private:10001'])
  const dup = after.filter((m) => /下雨天/.test(String(m.text || '')))
  assert.equal(dup.length, 1, `近似改写应被合并成 1 条，实际 ${dup.length} 条：${JSON.stringify(after.map((m) => m.text))}`)
  // 红线不破：物理事实只增不改，被合并的立墓碑而不是删除
  const all = store.indexAll().docs.map((d) => d.it)
  assert.equal(all.filter((m) => /下雨天/.test(String(m.text || ''))).length, 2, '物理条目仍是 2 条（墓碑语义）')
  assert.ok(all.some((m) => m.invalidAt > 0 && m.supersededBy), '旧条目应被打上墓碑')
})

test('缺陷 A：作用域从实际存储推导，不依赖提炼器返回值（多作用域同时覆盖）', async (t) => {
  const { store, logs } = tickHarness(t)
  // 两个作用域各有重复事实：只有「覆盖全部非空作用域」才会两边都合并
  store.add({ text: '主人喜欢在雨天喝热咖啡', importance: 0.4, scope: 'private:10001', chatId: 'private:10001' })
  store.add({ text: '主人喜欢在雨天喝热咖啡', importance: 0.9, scope: 'private:10001', chatId: 'private:10001' })
  store.add({ text: '群里聊到周末去公园散步', importance: 0.4, scope: 'group:20001', chatId: 'group:20001' })
  store.add({ text: '群里聊到周末去公园散步', importance: 0.9, scope: 'group:20001', chatId: 'group:20001' })

  await store.tick()

  assert.ok(logs.some((l) => l.includes('梦境巩固')), `应有梦境日志，实际：${JSON.stringify(logs)}`)
  const priv = store.listFor(['private:10001']).filter((m) => /雨天/.test(String(m.text || '')))
  const grp = store.listFor(['group:20001']).filter((m) => /公园/.test(String(m.text || '')))
  assert.equal(priv.length, 1, `private 作用域应合并成 1 条，实际 ${priv.length}`)
  assert.equal(grp.length, 1, `group 作用域应合并成 1 条，实际 ${grp.length}`)
})

test('缺陷 A：没有可巩固的事实时 tick 不抛错、不误报梦境成功', async (t) => {
  const { store, logs } = tickHarness(t)
  // 库里一条事实都没有：dreamConsolidate 会 skipped:'no-facts'
  await store.tick()
  assert.ok(!logs.some((l) => l.startsWith('WARN:梦境巩固')), `不应有梦境异常，实际：${JSON.stringify(logs)}`)
  assert.equal(store.listFor(['private:10001']).length, 0)
})
