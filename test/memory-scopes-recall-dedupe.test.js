// 「一次召回里同一条记忆出现两次」的回归网（真实线上症状）。
//
// 症状：面板「最近想起了什么」里，同一条记忆在同一轮召回里出现两次（同 id、同分数），
// 而且每 60 秒刷一遍 —— 看起来像「一直在重复」。
//
// 根因有两层，本文件分别钉住：
//   ① recall 的 scopes 数组模式按作用域逐个取索引后直接拼起来，而 indexFor(scope)
//      **故意**把 global 也算进去（global 处处可见）→ scopes=['global','private:X']
//      时 global 条目被收两遍。
//   ② purpose 的素材采集拿一句固定的假关键词串每 60 秒 recall 一次，
//      而每次 recall 都会往 recallLog 写一条 → 面板被灌满同样的 20 条。
//
// 本文件只测 ①（纯函数层，好钉）。② 在 purpose 的接线里，换成了 listFor，见
// test/purpose.test.js 与下面关于「后台采集不该写召回日志」的用例。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 每个用例独立数据目录：记忆库是文件，混用会让「有没有数据」变成环境依赖。 */
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'recall-dedupe-'))
  mkdirSync(join(dir, 'memory'), { recursive: true })
  writeFileSync(join(dir, 'memory', 'migration.json'), JSON.stringify({ status: 'success' }))
  writeFileSync(join(dir, 'memory', 'state.json'), JSON.stringify({ items: [] }))
  const prev = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

async function makeStore() {
  const { createMemoryStore } = await import('../src/features/memory.js')
  return createMemoryStore({
    dsh: {}, hub: {},
    log: { info() {}, warn() {}, debug() {} },
    getConfig: () => ({ ownerQQ: '1000', persona: { current: 'dafeiyu' }, memory: { enabled: true, recallCount: 10 } }),
    personaText: () => '',
  })
}

test('scopes 模式召回不重复：global 条目只出现一次（缺陷根因所在）', async (t) => {
  sandbox(t)
  const store = await makeStore()
  store.add({ text: 'nbcs：nobody cares 缩写，没人关心、无奈', scope: 'global' })
  store.add({ text: '亲密动作清单：亲密不是激情是日常练习', scope: 'private:1000', chatId: 'private:1000' })

  const hits = store.recall('最近 在做 想起 关心 日常', { scopes: ['global', 'private:1000'], limit: 10 })
  const ids = hits.map((h) => h.it.id)
  assert.equal(new Set(ids).size, ids.length, `同一轮召回不得出现重复 id（实际 ${ids.join(',')}）`)
  const globals = hits.filter((h) => h.it.scope === 'global')
  assert.equal(globals.length, 1, `global 条目应只出现一次（实际 ${globals.length} 次）`)
})

test('scopes 模式召回不重复：多个私聊域也共享 global 而不重复它', async (t) => {
  sandbox(t)
  const store = await makeStore()
  store.add({ text: '全局知识：咖啡因半衰期大约五小时', scope: 'global' })
  store.add({ text: '私聊 A 的事：周末想去爬山', scope: 'private:1000', chatId: 'private:1000' })
  store.add({ text: '私聊 B 的事：想学做面包', scope: 'private:2000', chatId: 'private:2000' })

  const hits = store.recall('咖啡 爬山 面包', { scopes: ['global', 'private:1000', 'private:2000'], limit: 20 })
  const ids = hits.map((h) => h.it.id)
  assert.equal(new Set(ids).size, ids.length, '跨多个域合并时也不得重复')
  assert.equal(hits.filter((h) => h.it.scope === 'global').length, 1, 'global 只算一次')
})

test('scopes 去重后各域自己的条目仍然都在（不能为了去重把别的域丢掉）', async (t) => {
  sandbox(t)
  const store = await makeStore()
  store.add({ text: '全局：咖啡因半衰期约五小时', scope: 'global' })
  store.add({ text: '私聊：周末想去爬山', scope: 'private:1000', chatId: 'private:1000' })

  const hits = store.recall('咖啡 爬山', { scopes: ['global', 'private:1000'], limit: 20 })
  const scopes = hits.map((h) => h.it.scope).sort()
  assert.deepEqual(scopes, ['global', 'private:1000'], '两个域都必须在结果里')
})

test('scopes 为空/未声明时仍然 fail-closed（不许因为去重就放全库）', async (t) => {
  sandbox(t)
  const store = await makeStore()
  store.add({ text: '私聊秘密：工资单在抽屉里', scope: 'private:1000', chatId: 'private:1000' })
  assert.deepEqual(store.recall('工资单', { scopes: [], limit: 10 }), [], '空 scopes 必须什么都不给')
  assert.deepEqual(store.recall('工资单', { limit: 10 }), [], '不传 chat 也不传 scopes 必须什么都不给')
})

test('chat 模式不受影响：本来就不重复，改完也不能重复', async (t) => {
  sandbox(t)
  const store = await makeStore()
  store.add({ text: '全局：咖啡因半衰期约五小时', scope: 'global' })
  store.add({ text: '私聊：周末想去爬山', scope: 'private:1000', chatId: 'private:1000' })

  const hits = store.recall('咖啡 爬山', { chat: { kind: 'private', userId: '1000' }, limit: 10 })
  const ids = hits.map((h) => h.it.id)
  assert.equal(new Set(ids).size, ids.length, 'chat 模式同样不得重复')
  assert.equal(hits.length, 2, '两个作用域都该看得见')
})

test('listFor 不写召回日志（后台素材采集不该污染「最近想起了什么」）', async (t) => {
  sandbox(t)
  const store = await makeStore()
  store.add({ text: '全局：咖啡因半衰期约五小时', scope: 'global' })
  store.add({ text: '私聊：周末想去爬山', scope: 'private:1000', chatId: 'private:1000' })

  const before = store.recalls().length
  // purpose 每 60 秒采一次素材，连采 5 次（等价于 5 分钟）
  for (let i = 0; i < 5; i += 1) store.listFor(['global', 'private:1000'], { limit: 200 })
  assert.equal(store.recalls().length, before, 'listFor 是素材读取，不是「想起了什么」，不该写日志')

  // 对照：recall 会写日志（它就是给面板看的）
  store.recall('咖啡', { scopes: ['global', 'private:1000'], limit: 5 })
  assert.equal(store.recalls().length, before + 1, 'recall 仍应写日志')
})

test('material 采集不会因为重复跑而让日志膨胀（真实症状：每 60 秒一条一样的）', async (t) => {
  sandbox(t)
  const store = await makeStore()
  store.add({ text: '私聊：周末想去爬山', scope: 'private:1000', chatId: 'private:1000' })

  const before = store.recalls().length
  for (let i = 0; i < 10; i += 1) store.listFor(['global', 'private:1000'], { limit: 200 })
  assert.equal(store.recalls().length, before, `连采 10 次后召回日志不该多出一条（实际多了 ${store.recalls().length - before} 条）`)
})
