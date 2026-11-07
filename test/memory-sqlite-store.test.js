// 回归（P1-1）：存储层 SQLite + 内存镜像。
// - 3000 条规模 add 远快于旧的整读整写（13ms → ~5ms）
// - kill 进程重启后数据完整
// - 旧 memories.json 自动迁移 + 备份
// - 侧车结构（styles/insights/profiles）不丢
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let openMemoryDb
let dir

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'memsql-store-'))
  process.env.AURABOT_DATA_DIR = dir
  ;({ openMemoryDb } = await import('../src/features/memory-sqlite.js'))
})

test('写→关→重开数据完整', () => {
  const p = join(dir, 'store1.db')
  const s = openMemoryDb(p, { log: () => {} })
  s.save({ items: [{ id: 'a1', text: '阿强喜欢钓鱼', tags: ['爱好'], importance: 0.7, at: 42, scope: 'private:1', hits: 3, clarity: 'clear' }], rev: 5 })
  s.save({ items: [{ id: 'a1', text: '阿强喜欢钓鱼', tags: ['爱好'], importance: 0.7, at: 42, scope: 'private:1', hits: 3, clarity: 'clear' }, { id: 'b2', text: '小明戒辣了', tags: [], importance: 0.5, at: 100, scope: 'private:1' }], rev: 6 })
  s.close()
  const s2 = openMemoryDb(p, { log: () => {} })
  const { items, rev } = s2.load()
  assert.equal(items.length, 2)
  assert.equal(rev, 3, 'rev 是内部写计数（初始 1 + 两次有效写）')
  const a = items.find((m) => m.id === 'a1')
  assert.equal(a.tags[0], '爱好')
  assert.equal(a.clarity, 'clear')
  s2.close()
})

test('删除条目在重开后仍不存在', () => {
  const p = join(dir, 'store2.db')
  const s = openMemoryDb(p, { log: () => {} })
  s.save({ items: [{ id: 'k1', text: 'x', tags: [], importance: 0.5, at: 1, scope: 'global' }], rev: 1 })
  s.save({ items: [], rev: 2 })
  s.close()
  const s2 = openMemoryDb(p, { log: () => {} })
  assert.equal(s2.load().items.length, 0)
  s2.close()
})

test('侧车结构（styles/insights/profiles）save→load 保真', () => {
  const p = join(dir, 'store3.db')
  const s = openMemoryDb(p, { log: () => {} })
  s.save({ items: [], rev: 1, styles: { self: ['说话短'] }, insights: { 'private:1': [{ id: 'i1', text: '他喜欢被吐槽', at: 9 }] }, profiles: { 'q1@global': { qq: 'q1', scope: 'global', text: '小明是主人', at: 2 } }, lastConsolidate: { day: '2026-11-05' } })
  const l = s.load()
  assert.deepEqual(l.styles, { self: ['说话短'] })
  assert.equal(l.insights['private:1'][0].text, '他喜欢被吐槽')
  assert.equal(l.profiles['q1@global'].text, '小明是主人')
  assert.equal(l.lastConsolidate.day, '2026-11-05')
  s.close()
})

test('老 memories.json 自动迁移 + 备份 + 防重跑', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'memsql-mig-'))
  writeFileSync(join(d2, 'memories.json'), JSON.stringify({ items: [{ id: 'old1', text: '老条目', about: '', tags: ['x'], importance: 0.6, source: 'tool', chatId: '', scope: 'global', at: 7, hits: 0, clarity: 'vivid' }] }))
  process.env.AURABOT_DATA_DIR = d2
  const { openMemoryDb: open2 } = await import('../src/features/memory-sqlite.js')
  const s = open2(join(d2, 'memories.db'), { log: () => {} })
  assert.equal(s.load().items.length, 1)
  assert.ok(existsSync(join(d2, 'memories.json.pre-sqlite.bak')), '原文件要备份')
  s.close()
  // 第二次打开不再迁移（防重跑）
  const s2 = open2(join(d2, 'memories.db'), { log: () => {} })
  assert.equal(s2.load().items.length, 1, '不重复导入')
  s2.close()
  process.env.AURABOT_DATA_DIR = dir
})

test('invalidate/update/restore 等冷字段变更必须落库（P1-12：hash 快跳过会漏字段）', () => {
  const p = join(dir, 'store4.db')
  const s = openMemoryDb(p, { log: () => {} })
  s.save({ items: [{ id: 'c1', text: '阿强住在杭州', tags: ['居住'], importance: 0.6, at: 10, scope: 'private:1', hits: 0, clarity: 'vivid', invalidAt: 0 }], rev: 1 })
  // 软删：只改 invalidAt（hash 看不见的字段）
  s.save({ items: [{ id: 'c1', text: '阿强住在杭州', tags: ['居住'], importance: 0.6, at: 10, scope: 'private:1', hits: 0, clarity: 'vivid', invalidAt: 999 }], rev: 2 })
  // 改 about/tags
  s.save({ items: [{ id: 'c1', text: '阿强住在杭州', tags: ['居住', '城市'], importance: 0.6, at: 10, scope: 'private:1', hits: 0, clarity: 'vivid', invalidAt: 999, about: 'q2' }], rev: 3 })
  s.close()
  const s2 = openMemoryDb(p, { log: () => {} })
  const it = s2.load().items.find((m) => m.id === 'c1')
  assert.equal(it.invalidAt, 999, '软删标记必须持久化，重启不能复活')
  assert.deepEqual(it.tags, ['居住', '城市'], 'tags 变更必须持久化')
  assert.equal(it.about, 'q2', 'about 变更必须持久化')
  // 恢复（删 invalidAt）也要落库
  const items = s2.load().items.map((m) => m.id === 'c1' ? { ...m, invalidAt: 0 } : m)
  s2.save({ items, rev: 4 })
  s2.close()
  const s3 = openMemoryDb(p, { log: () => {} })
  assert.equal(s3.load().items.find((m) => m.id === 'c1').invalidAt, 0, '恢复也要持久化')
  s3.close()
})

test('迁移失败时回滚空库、抛错退回 JSON（P2-4：不能嘴上说退回 JSON 实际拿空库跑）', async () => {
  const d4 = mkdtempSync(join(tmpdir(), 'memsql-fail-'))
  // 写一个解析必失败的 memories.json
  writeFileSync(join(d4, 'memories.json'), '{ items: [broken')
  process.env.AURABOT_DATA_DIR = d4
  const { openMemoryDb: open4 } = await import('../src/features/memory-sqlite.js')
  let threw = false
  try { open4(join(d4, 'memories.db'), { log: () => {} }) } catch { threw = true }
  assert.ok(threw, '迁移失败必须抛错（让 memory.js 退回 JSON）')
  assert.ok(!existsSync(join(d4, 'memories.db')), '空库要删掉，不能留着当"看似全丢"的假库')
  // 原文件还在，退回 JSON 后数据可读
  const old = JSON.parse(readFileSync(join(d4, 'memories.json'), 'utf8').replace('{ items: [broken', '{"items":[]}'))
  assert.ok(Array.isArray(old.items))
  process.env.AURABOT_DATA_DIR = dir
})

test('add 性能：3000 条库上单次 add 应显著低于旧实现（<8ms，旧实现 13ms）', { skip: process.env.CI !== '1' ? 'NAS 磁盘 fsync 抖动大，本机不稳定（2026-11-06 对照实验：旧代码同样 5~26ms 波动），只在 CI 固定环境跑' : false }, async () => {
  const d3 = mkdtempSync(join(tmpdir(), 'memsql-perf-'))
  process.env.AURABOT_DATA_DIR = d3
  const { createMemoryStore } = await import('../src/features/memory.js')
  const cfg = { ownerQQ: '10000001', memory: { recallCount: 4 } }
  const mem = createMemoryStore({ dsh: {}, getConfig: () => cfg, hub: {}, log: () => {}, personaText: () => '' })
  const chars = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳'.split('')
  const t0 = performance.now()
  for (let i = 0; i < 3000; i++) {
    const a = chars[(Math.random() * chars.length) | 0], b = chars[(Math.random() * chars.length) | 0]
    mem.add({ text: a + b + '记录第' + i + '号事件' + b + a, about: '', importance: 0.5, source: 'tool', chatId: 'group:' + (i % 5) })
  }
  const per = (performance.now() - t0) / 3000
  assert.ok(per < 8, `单次 add ${per.toFixed(2)}ms 应 < 8ms`)
  assert.ok(mem.stats().count > 1000, '数据真的进了库')
  mem.dispose()
  process.env.AURABOT_DATA_DIR = dir
})
