import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryArchive } from '../src/features/memory-archive.js'

test('archive 不依赖模型或提炼器，独立完成后新增改删与作用域召回', (t) => {
  const source = readFileSync(new URL('../src/features/memory-archive.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"]\.\.\/core\/llm\.js['"]/)
  assert.doesNotMatch(source, /from ['"]\.\/memory-extractor\.js['"]/)

  const dir = mkdtempSync(join(tmpdir(), 'memory-archive-contract-'))
  const previous = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  const archive = createMemoryArchive({
    getConfig: () => ({ ownerQQ: '10001', memory: { enabled: true, recallCount: 4 } }),
    log: { info() {}, warn() {} },
  })
  t.after(() => {
    archive.dispose()
    if (previous === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })

  const chat = { kind: 'private', userId: '10002', chatId: 'private:10002' }
  const created = archive.add({ text: '小张喜欢喝乌龙茶', about: '10002', scope: 'private:10002' })
  assert.equal(created.ok, true)
  assert.equal(archive.recall('乌龙茶', { chat }).length, 1)

  assert.equal(archive.update(created.id, { text: '小张喜欢喝冷萃咖啡' }).ok, true)
  assert.equal(archive.recall('冷萃咖啡', { chat })[0].it.text, '小张喜欢喝冷萃咖啡')
  assert.equal(archive.recall('冷萃咖啡', { chat: { kind: 'private', userId: '10003' } }).length, 0)

  assert.equal(archive.remove(created.id).ok, true)
  assert.equal(archive.recall('冷萃咖啡', { chat }).length, 0)
  assert.equal(archive.consolidate, undefined)
  assert.equal(archive.importCandidates, undefined)
  assert.equal(archive.buildProfile, undefined)
  assert.equal(archive.reflect, undefined)
})
