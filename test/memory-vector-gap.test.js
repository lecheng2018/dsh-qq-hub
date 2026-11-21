// 审计 S13 的行为锁：作用域被删空后，向量文件必须跟着清空。
//
// 过去 archive.save() 的向量对账队列只来自**现存**条目——某作用域被清空/删除后
// 它不再出现在 byScope 里，flush 永远不会碰它的向量文件，已删正文的旧向量留在
// 磁盘上继续参与语义召回（向量死区）。
//
// 修复：save() 用「上次保存的 scope 集合 − 本次集合」找消失的作用域，
// 对其入队空对账（该 scope 全摘除）。vectorFlushDebounceMs / vectorFetchImpl
// 可注入供测试观察（生产默认 15s 防抖 + 真实 fetch，行为不变）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createMemoryStore } = await import('../src/features/memory.js')
const { normalize } = await import('../src/core/config.js')
const { scopeToVecFilePath } = await import('../src/features/memory-files.js')
const { createScopeVectorFile } = await import('../src/features/memory-vector.js')

const log = { info() {}, warn() {}, debug() {} }

const fakeFetch = async (url, opt) => {
  const body = JSON.parse(opt.body)
  return { ok: true, json: async () => ({ data: body.input.map(() => ({ embedding: Array(64).fill(0.1) })) }) }
}

function makeStore() {
  const d = mkdtempSync(join(tmpdir(), 'vecgap-'))
  process.env.DSH_QQ_HUB_DATA_DIR = d
  const cfg = normalize({
    ownerQQ: '10001',
    model: { provider: 'p', model: 'm' },
    memory: { enabled: true, embeddings: { enabled: true, url: 'https://emb.example', model: 'm', dim: 64, batch: 8 } },
  })
  const store = createMemoryStore({
    dsh: {},
    getConfig: () => cfg,
    hub: { chatLogOf: () => [], chatLogDays: () => [] },
    log,
    personaText: () => '',
    vectorFlushDebounceMs: 5,  // 防抖注入：不等 15s
    vectorFetchImpl: fakeFetch, // 假 embedding：不打真实网络
  })
  return { store, dir: d }
}

const readerOf = (dir, scope) => createScopeVectorFile(join(dir, 'memory', scopeToVecFilePath(scope)), 64, { log: { warn() {} } })

/** 等谓词成立（每 20ms 轮询，最多 3s）。 */
async function waitUntil(fn, { tries = 150 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { if (fn()) return true } catch {}
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}

test('S13 · clearScope（/new 语义）删空作用域后，向量条目被摘光', async () => {
  const { store, dir } = makeStore()
  store.add({ text: '主人喜欢养猫', scope: 'private:10001', source: 'manual' })
  store.add({ text: '主人不爱吃香菜', scope: 'private:10001', source: 'manual' })
  // reader 要在文件**落盘后**再创建：createScopeVectorFile 内部按 stat 缓存，
  // 对尚不存在的路径构造会缓存一次空态。
  assert.ok(await waitUntil(() => existsSync(join(dir, 'memory', scopeToVecFilePath('private:10001')))), '向量文件应落盘')
  const reader = readerOf(dir, 'private:10001')
  assert.ok(await waitUntil(() => reader.load().size === 2), '初始应有两条向量')

  // /new 的清空路径：clearScope(chat) → save → 差集 → 空对账 → flush 摘光
  const r = store.clearScope({ kind: 'private', chatId: 'private:10001', userId: '10001' })
  assert.ok(r.items >= 2, `clearScope 应删掉该域条目，实际 ${JSON.stringify(r)}`)
  assert.ok(
    await waitUntil(() => reader.load().size === 0),
    `删空后向量应被摘光，实际残留 ${reader.load().size} 条`,
  )
})

test('S13 · 逐条 remove 到作用域清空，同样触发向量摘除', async () => {
  const { store, dir } = makeStore()
  const a = store.add({ text: '群A的事一', scope: 'group:777', source: 'manual' })
  const b = store.add({ text: '群A的事二', scope: 'group:777', source: 'manual' })
  assert.ok(await waitUntil(() => existsSync(join(dir, 'memory', scopeToVecFilePath('group:777')))), '向量文件应落盘')
  const reader = readerOf(dir, 'group:777')
  assert.ok(await waitUntil(() => reader.load().size === 2), '初始应有两条向量')

  store.remove(a.id)
  store.remove(b.id)
  assert.ok(
    await waitUntil(() => reader.load().size === 0),
    `逐条删空后向量应被摘光，实际残留 ${reader.load().size} 条`,
  )
})

test('S13 · 只删其中一条时，剩余条目的向量保留（差集不误伤）', async () => {
  const { store, dir } = makeStore()
  const a = store.add({ text: '记住第一件事', scope: 'group:888', source: 'manual' })
  store.add({ text: '记住第二件事', scope: 'group:888', source: 'manual' })
  assert.ok(await waitUntil(() => existsSync(join(dir, 'memory', scopeToVecFilePath('group:888')))), '向量文件应落盘')
  const reader = readerOf(dir, 'group:888')
  assert.ok(await waitUntil(() => reader.load().size === 2), '初始两条')
  store.remove(a.id)
  assert.ok(
    await waitUntil(() => reader.load().size === 1),
    '删一条后应剩一条向量',
  )
})
