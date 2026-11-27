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

// ---------------- 复核补充：停用后不得重发、部分失败不得丢更新 ----------------

const { createVectorChannel, embedKeyOf } = await import('../src/features/memory-vector.js')
const { createHash } = await import('node:crypto')
const sha16 = (s) => createHash('sha1').update(String(s), 'utf8').digest('hex').slice(0, 16)

const item = (id, text) => ({ id, text, tags: [] })
/** 语义：alpha→维0 / beta→维1 / 其它→维2，便于判断磁盘上存的是哪个语义。 */
const vecOf = (t) => Array(64).fill(0).map((_, i) => (t.includes('alpha') ? i === 0 : t.includes('beta') ? i === 1 : i === 2) ? 1 : 0)

function makeChannel(dir, { failOn = () => false, batch = 1, flushDebounceMs = 5, gate } = {}) {
  const cfg = { memory: { embeddings: { enabled: true, url: 'https://emb.example', model: 'm', dim: 64, batch } } }
  const calls = []
  const fetchImpl = async (url, opt) => {
    const input = JSON.parse(opt.body).input
    calls.push(input)
    if (gate) await gate
    if (input.some((t) => failOn(t))) throw new Error('embedding 端点失败')
    return { ok: true, json: async () => ({ data: input.map((t) => ({ embedding: vecOf(t) })) }) }
  }
  const vec = createVectorChannel({
    memoryDir: dir, getConfig: () => cfg, fetchImpl,
    log: { warn() {}, info() {}, debug() {} }, flushDebounceMs,
  })
  return { vec, calls }
}

const vecFileOf = (dir, scope) => createScopeVectorFile(join(dir, scopeToVecFilePath(scope)), 64, { log: { warn() {} } })

test('S13 · 停用后在途请求失败，不会再安排重试（不会把记忆正文重发出去）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vec-dispose-'))
  try {
    let release
    const gate = new Promise((r) => { release = r })
    const { vec, calls } = makeChannel(dir, { flushDebounceMs: 15000, gate })
    vec.queueScope('private:10001', [item('a', 'alpha 主人的正文')])
    const inflight = vec.flush()        // 请求发出并挂住
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(calls.length, 1, '应有一次在途请求')

    vec.dispose()                        // 停用
    release()                            // 迟到的失败
    await inflight.catch(() => {})
    assert.equal(vec.status().pending, 0, '停用后不应留下待重试队列')

    // 等过整个防抖窗口：停用后不得再有任何请求
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(calls.length, 1, `停用后不得再发请求，实际 ${calls.length} 次`)
    assert.equal(vec.enabled(), false, '停用后 enabled() 必须是 false')
    assert.equal(await vec.embedQuery('alpha 查询'), null, '停用后查询也不该打 embedding')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('S13 · 分批中断（前批成功、后批失败）时，成功的那部分仍会落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vec-transaction-'))
  const scope = 'group:777'
  try {
    let fail = true
    const { vec } = makeChannel(dir, { failOn: (t) => fail && t.includes('gamma') })
    const A_OLD = item('A', 'alpha 旧说法')
    const A_NEW = item('A', 'alpha 新说法')
    const B = item('B', 'beta 对照')
    const C = item('C', 'gamma 会失败')

    vec.queueScope(scope, [A_OLD, B])
    await vec.flush()
    const reader = vecFileOf(dir, scope)
    assert.equal(reader.load().get('A').hash, sha16(embedKeyOf(A_OLD)), '初始应是旧语义')

    // 同一快照：A 改语义（先成功）+ C 新增（后失败），batch=1
    vec.queueScope(scope, [A_NEW, B, C])
    await vec.flush()

    // 成功后 C 被删掉 → 新快照只剩 A_NEW/B；端点已恢复
    fail = false
    vec.queueScope(scope, [A_NEW, B])
    await vec.flush()

    const disk = vecFileOf(dir, scope).load()
    assert.equal(
      disk.get('A').hash, sha16(embedKeyOf(A_NEW)),
      'A 的新语义必须落盘：部分成功不能被后续快照覆盖掉（旧实现会停在旧 hash）',
    )
    assert.equal(disk.get('A').vec[0], 1, '磁盘上 A 的向量应已是新语义（alpha 维）')
    assert.equal(disk.has('C'), false, '失败的 C 最终不应留在磁盘上')
    assert.equal(vec.status().pending, 0, '全部消化完后不应有 pending')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('S13 · 失败回填仍保留「摘除」语义：重试成功时死向量不会复活', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vec-prune-retry-'))
  const scope = 'group:888'
  try {
    let fail = true
    const { vec } = makeChannel(dir, { failOn: (t) => fail && t.includes('beta') })
    vec.queueScope(scope, [item('A', 'alpha 活着'), item('B', 'beta 先失败')])
    await vec.flush()
    assert.equal(vec.status().pending, 1, '失败的那批应留在重试队列')

    fail = false
    // 下一次快照只保留 A（B 被删）——重试成功后磁盘上不该有 B
    vec.queueScope(scope, [item('A', 'alpha 活着')])
    await vec.flush()
    const disk = vecFileOf(dir, scope).load()
    assert.equal(disk.has('B'), false, '已删条目的向量不能在重试后复活')
    assert.equal(disk.has('A'), true, '存活条目应保留')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('S13 · 向量关闭期间删空作用域后，重启前开启向量并执行 vectorBackfill 会清理孤儿向量', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vec-backfill-orphan-'))
  const prevDir = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  let vecEnabled = true
  const store = createMemoryStore({
    dsh: {},
    getConfig: () => normalize({
      ownerQQ: '10001',
      model: { provider: 'p', model: 'm' },
      memory: { enabled: true, embeddings: { enabled: vecEnabled, url: 'https://emb.example', model: 'm', dim: 64, batch: 8 } },
    }),
    hub: { chatLogOf: () => [], chatLogDays: () => [] },
    log,
    personaText: () => '',
    vectorFlushDebounceMs: 5,
    vectorFetchImpl: fakeFetch,
  })
  t.after(() => {
    store.dispose()
    if (prevDir === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = prevDir
    rmSync(dir, { recursive: true, force: true })
  })

  store.add({ text: '群里待清理的旧记忆', scope: 'group:777', source: 'manual' })
  store.add({ text: '全局仍存活的记忆', scope: 'global', source: 'manual' })
  await store.vectorBackfill(store.list(''))

  const orphanReader = readerOf(dir, 'group:777')
  const liveReader = readerOf(dir, 'global')
  assert.equal(orphanReader.load().size, 1)
  assert.equal(liveReader.load().size, 1)

  // 运行期先关闭向量并删空 group:777，随后重新打开向量并手动触发补全
  vecEnabled = false
  store.clearScope({ kind: 'group', chatId: 'group:777', groupId: '777' })
  vecEnabled = true

  const res = await store.vectorBackfill(store.list(''))
  assert.equal(res.ok, true)
  assert.equal(orphanReader.load().size, 0, '孤儿作用域的 vectors.bin 应被清空')
  assert.equal(liveReader.load().size, 1, '存活作用域的向量应完整保留')
})
