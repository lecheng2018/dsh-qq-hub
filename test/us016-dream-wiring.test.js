// US-016 接线验收：梦境巩固真正跑起来，且墓碑语义不破坏事实源。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryArchive } from '../src/features/memory-archive.js'
import { createMemoryLearning } from '../src/features/memory-learning.js'

function realHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'dream-harness-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'migration.json'), JSON.stringify({ status: 'success' }))
  writeFileSync(join(dir, 'memory', 'state.json'), JSON.stringify({ items: [] }))
  process.env.DSH_QQ_HUB_DATA_DIR = dir

  const logs = []
  const archive = createMemoryArchive({
    dsh: {}, getConfig: () => ({ memory: { enabled: true, dailyConsolidate: true, consolidateTimes: ['04:00'] } }),
    hub: {}, log: { info: (m) => logs.push(String(m)), warn: (m) => logs.push('WARN:' + String(m)) },
    extend: (arch) => createMemoryLearning(arch),
  })
  return { archive, dir, logs }
}

test('真实实例梦境接线生效：无条目时安全跳过', async (t) => {
  const { archive, dir } = realHarness()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const res = await archive.dreamConsolidate()
  assert.equal(res.ok, true)
  assert.equal(res.skipped, 'no-facts')
})

test('真实实例梦境巩固去重：立墓碑且绝不产生多余重复副本', async (t) => {
  const { archive, dir } = realHarness()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const t1 = '主人下雨天喜欢呆在家里看书'
  const t2 = '下雨天主人最喜欢呆在家里面看书'
  archive.add({ text: t1, importance: 0.4, scope: 'private:10001', chatId: 'private:10001' })
  archive.add({ text: t2, importance: 0.9, scope: 'private:10001', chatId: 'private:10001' })

  const before = archive.listFor(['private:10001'])
  assert.equal(before.length, 2, '初始应有 2 条有效事实')

  const res = await archive.dreamConsolidate({ options: { dedupeSimilarity: 0.5 } })
  assert.equal(res.ok, true)
  assert.ok(res.applied >= 1, '应成功为冗余事实立墓碑')

  // 有效事实变为 1 条，绝不能因为 supersede 插入第 3 条条目
  const after = archive.listFor(['private:10001'])
  assert.equal(after.length, 1, '去重后有效事实应为 1 条')

  // 检查底层条目：旧事实被打上 invalidAt 和 supersededBy
  const all = archive.indexAll().docs.map((d) => d.it)
  assert.equal(all.length, 2, '物理事实总数依然为 2 条（只增不改，不增多也不物理删除）')
  const invalid = all.find((m) => m.invalidAt > 0)
  assert.ok(invalid, '应有 1 条事实被打上墓碑')
  assert.ok(invalid.supersededBy, '墓碑应标明由哪条事实替代')
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

test('模块接口完整性：dreamConsolidate 成功暴露在 api 与 archive 根部', () => {
  const { archive, dir } = realHarness()
  assert.equal(typeof archive.dreamConsolidate, 'function', 'archive 根部应暴露 dreamConsolidate')
  rmSync(dir, { recursive: true, force: true })
})
