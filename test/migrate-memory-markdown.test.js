import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrateToMarkdown } from '../scripts/migrate-memory-markdown.js'
import { openMemoryFiles } from '../src/features/memory-files.js'

let dir

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'migrate-md-test-'))
})

test('migrate-memory-markdown: 旧 SQLite + meta.json 完整迁移至 Markdown 档案', () => {
  const dataDir = join(dir, 'legacy1')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'memories.db')
  const metaPath = join(dataDir, 'memories.meta.json')

  // 构造旧 SQLite 数据库
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE items (
    id TEXT PRIMARY KEY, text TEXT, about TEXT, aboutName TEXT,
    tags TEXT, importance REAL, source TEXT, chatId TEXT,
    scope TEXT, at INTEGER, hits INTEGER, hitDays INTEGER,
    lastHit INTEGER, clarity TEXT, invalidAt INTEGER,
    pinned INTEGER, retention REAL, embeddedAt INTEGER
  )`)
  const ins = db.prepare(`INSERT INTO items (id, text, about, scope, at) VALUES (?, ?, ?, ?, ?)`)
  ins.run('item_1', '阿强喜欢钓鱼', '10001', 'private:10001', 1794300000000)
  ins.run('item_2', '大家都在讨论NAS', '', 'group:20001', 1794310000000)
  ins.run('item_no_scope', '无作用域老数据', '', '', 1794320000000)
  db.close()

  // 构造旧 meta.json
  const meta = {
    profiles: {
      '10001@private:10001': { qq: '10001', scope: 'private:10001', name: '阿强', text: '钓鱼大师' },
    },
    insights: {
      'group:20001': [{ id: 'ins_1', text: '群里技术交流多' }],
    },
    distillTargets: [{ gid: '20001', uid: '10001', name: '阿强' }],
  }
  writeFileSync(metaPath, JSON.stringify(meta), 'utf8')

  // 执行迁移
  const res = migrateToMarkdown(dataDir)
  assert.equal(res.ok, true)
  assert.equal(res.record.totalItems, 3)
  assert.equal(res.record.quarantinedCount, 1)

  // 验证目标 memory 目录
  const memoryDir = join(dataDir, 'memory')
  assert.ok(existsSync(join(memoryDir, 'migration.json')))
  assert.ok(existsSync(join(memoryDir, 'private', '10001', 'memory.md')))
  assert.ok(existsSync(join(memoryDir, 'group', '20001', 'memory.md')))
  assert.ok(existsSync(join(memoryDir, 'quarantine', 'memory.md')), '无 scope 的老数据必须归入隔离区')

  // 验证由 openMemoryFiles 打开（quarantine 正常不被装配进活动条目）
  const store = openMemoryFiles(memoryDir)
  const loaded = store.load()
  assert.equal(loaded.items.length, 2)
  const item1 = loaded.items.find((m) => m.id === 'item_1')
  assert.equal(item1.text, '阿强喜欢钓鱼')

  // 验证 quarantine 独立文件存在且包含隔离条目
  const qRaw = readFileSync(join(memoryDir, 'quarantine', 'memory.md'), 'utf8')
  assert.ok(qRaw.includes('无作用域老数据'))

  assert.equal(loaded.distillTargets.length, 1)
  assert.equal(loaded.distillTargets[0].name, '阿强')
  store.close()

  // 验证幂等：再次执行直接跳过
  const res2 = migrateToMarkdown(dataDir)
  assert.equal(res2.ok, true)
  assert.equal(res2.skipped, true)
})
