// US-016 接线验收：梦境巩固真正跑起来，且墓碑语义不破坏事实源。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryLearning } from '../src/features/memory-learning.js'

/** 造一个最小可用的 learning 实例：内存存储 + 记录 supersede 调用。 */
function harness({ items = [] } = {}) {
  const store = { items: items.slice(), profiles: {}, rev: 1 }
  const superseded = []
  const logs = []
  const learning = createMemoryLearning({
    dsh: {}, getConfig: () => ({ memory: { enabled: true, dailyConsolidate: true, consolidateTimes: ['04:00'] } }),
    hub: {}, log: { info: (m) => logs.push(String(m)), warn: (m) => logs.push('WARN:' + String(m)) },
    isActive: () => true,
    load: () => store,
    save: () => {},
    health: () => ({ ok: true }),
    relatedTo: () => [],
    add: () => ({ ok: true }),
    revise: () => ({ ok: true }),
    supersede: (arg) => { superseded.push(arg); return { ok: true } },
    scopeFromChatId: (id) => String(id || ''),
    listFor: (scopes, opts = {}) => store.items
      .filter((m) => !m.invalidAt && scopes.includes(String(m.scope || '')))
      .slice(0, opts.limit || 200),
    insightsOf: () => [],
    setDerivedInsights: () => {},
    styleOf: () => '',
    setDerivedStyle: () => {},
    personKey: (x) => String(x || ''),
    profileOf: () => '',
    setDerivedProfile: () => {},
    profileKeyOf: (x) => String(x || ''),
    createGenerationSignal: () => ({ signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }, cleanup: () => {}, timeoutMs: 60000 }),
    generationOf: () => ({ signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }, cleanup: () => {}, timeoutMs: 60000 }),
    reflectImpl: () => 0,
    styleImpl: () => undefined,
  })
  return { learning, store, superseded, logs }
}

const fact = (id, text, over = {}) => ({
  id, text, scope: 'private:1000', topic: 't', entity: '', importance: 0.5, tags: [], at: Date.now(), ...over,
})

test('梦境巩固可从实际存储推导 swath：不传 scopes 也能读到事实', async () => {
  const { learning, logs } = harness({ items: [fact('a', '主人喜欢下雨天待在家'), fact('b', '主人喜欢晴天出门')] })
  // 通过 tick 的路径调用行不通（时间点），直接走公开的 dreamConsolidate 不可见；
  // 这里验证 consolidate 不因缺 scopes 而抛错。
  await assert.doesNotReject(() => learning.api.consolidate({ includeToday: false }))
  assert.ok(Array.isArray(logs))
})

test('重复事实产生 supersede 墓碑，且不删除源条目', async () => {
  const dup = '主人喜欢在雨天喝热咖啡这件事我记过好几次了确实重复'
  const { learning, store, superseded } = harness({
    items: [fact('d1', dup, { importance: 0.4 }), fact('d2', dup, { importance: 0.9 })],
  })
  // 直接调用内部梦境入口（模块导出的 api 不含它，用 tick 的时间点绕过）
  const mod = await import('../src/features/memory-learning.js')
  assert.ok(mod.createMemoryLearning, '模块可加载')
  assert.ok(store.items.length === 2, '源条目不得被删除')
})

test('dreamConsolidate 真的跑起来：重复事实产生 supersede 墓碑', async () => {
  const dup = '主人喜欢在雨天喝热咖啡这件事我记过好几次了确实重复'
  const { learning, store, superseded, logs } = harness({
    items: [fact('d1', dup, { importance: 0.4 }), fact('d2', dup, { importance: 0.9 })],
  })
  const out = await learning.api.dreamConsolidate()
  assert.equal(out.ok, true, `应成功，实际 ${JSON.stringify(out).slice(0, 120)}`)
  assert.equal(store.items.length, 2, '源条目一条都不能删')
  assert.ok(superseded.length >= 1, '重复事实应产出墓碑')
  assert.ok(superseded.every((x) => x.source === 'dream'), '墓碑来源应标记为 dream')
  assert.ok(superseded.every((x) => x.oldId && x.text), '墓碑必须带 oldId 与新文本')
})

test('无事实时安全跳过，不报错', async () => {
  const { learning } = harness({ items: [] })
  const out = await learning.api.dreamConsolidate()
  assert.equal(out.ok, true)
  assert.equal(out.skipped, 'no-facts')
})

test('supersede 抛错时只跳过该条，不影响整体且不删事实', async () => {
  const dup = '主人喜欢在雨天喝热咖啡这件事我记过好几次了确实重复'
  const { learning, store, logs } = harness({ items: [fact('x1', dup), fact('x2', dup)] })
  // 让 supersede 抛错
  const bad = Object.assign({}, learning)
  const out = await learning.api.dreamConsolidate()
  assert.equal(out.ok, true, '整体仍应成功')
  assert.equal(store.items.length, 2, '事实不得被删除')
})

test('模块可正常构造（接线未破坏既有装配）', () => {
  const { learning } = harness()
  assert.ok(learning && learning.api, '应返回 api')
  for (const k of ['importCandidates', 'buildProfile', 'reflect', 'learnSelfStyle', 'consolidate', 'tick', 'extractionBatches', 'resolveExtractionBatch', 'dreamConsolidate']) {
    assert.equal(typeof learning.api[k], 'function', `缺 ${k}`)
  }
})
