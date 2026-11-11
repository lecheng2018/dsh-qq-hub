import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createMemoryStore } from '../src/features/memory.js'
import { openMemoryFiles } from '../src/features/memory-files.js'
import { migrateToMarkdown } from '../scripts/migrate-memory-markdown.js'

const log = { info() {}, warn() {}, error() {} }
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'migration-safety-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  t.after(() => {
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  const open = () => createMemoryStore({ dsh: {}, getConfig: () => ({ memory: {} }), hub: {}, log })
  return { dir, open }
}

test('migration safety: 旧库存在时启动拒绝隐式迁移，显式迁移后才读取 MD', (t) => {
  const { dir, open } = fixture(t)
  const legacy = JSON.stringify({ items: [{ id: 'old', text: '旧事实', scope: 'private:1' }] })
  writeFileSync(join(dir, 'memories.json'), legacy)
  assert.throws(open, /migrate-memory-markdown/)
  assert.equal(existsSync(join(dir, 'memory')), false)
  migrateToMarkdown(dir, { log })
  const store = open()
  assert.equal(store.list()[0].text, '旧事实')
  assert.equal(readFileSync(join(dir, 'memories.json'), 'utf8'), legacy)
  store.dispose()
})

test('migration safety: 新安装不需要迁移；旧新并存且无成功凭据时禁止覆盖或复活删除', (t) => {
  const { dir, open } = fixture(t)
  const store = open()
  store.add({ text: '新档案事实', scope: 'global' })
  store.dispose()
  const md = join(dir, 'memory/global/memory.md')
  const before = readFileSync(md, 'utf8')
  writeFileSync(join(dir, 'memories.json'), JSON.stringify({ items: [{ id: 'deleted', text: '已删的旧事实', scope: 'global' }] }))
  assert.throws(open, /迁移/)
  assert.throws(() => migrateToMarkdown(dir, { log }), /已存在|冲突/)
  assert.equal(readFileSync(md, 'utf8'), before)
  assert.equal(readdirSync(dir).some((n) => n.startsWith('memory.staging') || n.startsWith('memory.bak')), false)
})

test('migration safety: 损坏的迁移凭据不能视为成功', (t) => {
  const { dir, open } = fixture(t)
  const files = openMemoryFiles(join(dir, 'memory'), { log })
  files.save({ items: [] })
  files.close()
  writeFileSync(join(dir, 'memories.json'), '{"items":[]}')
  writeFileSync(join(dir, 'memory/migration.json'), '{损坏')
  assert.throws(open, /迁移/)
})

test('migration safety: meta 损坏必须中止而非丢弃画像和进度后宣称成功', (t) => {
  const { dir } = fixture(t)
  const db = new DatabaseSync(join(dir, 'memories.db'))
  db.exec('CREATE TABLE items (id TEXT PRIMARY KEY)')
  db.close()
  writeFileSync(join(dir, 'memories.meta.json'), '{坏元数据')
  assert.throws(() => migrateToMarkdown(dir, { log }), /meta/)
  assert.equal(existsSync(join(dir, 'memory')), false)
})
