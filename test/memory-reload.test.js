import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/features/memory.js'

const log = { info() {}, warn() {} }
function fixture(t, dsh = {}, hub = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-reload-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  const store = createMemoryStore({ dsh, hub, log, getConfig: () => ({ model: { provider: 'test', model: 'test' }, memory: { enabled: true, recallCount: 4 } }) })
  t.after(() => {
    store.dispose()
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, store }
}

test('reload: 返回真实健康状态，修复后可恢复读写和召回', (t) => {
  const { dir, store } = fixture(t)
  store.add({ text: '档案原始正文', scope: 'global' })
  const file = join(dir, 'memory/global/memory.md')
  const original = readFileSync(file, 'utf8')
  writeFileSync(file, '---\n损坏档案')
  const broken = store.reload()
  assert.equal(broken.ok, false)
  assert.equal(broken.health.brokenScopes.length, 1)
  assert.equal(store.health().ok, false)
  writeFileSync(file, original.replace('档案原始正文', '人工修复正文'))
  assert.equal(store.reload().ok, true)
  assert.equal(store.health().ok, true)
  assert.equal(store.recall('人工修复', { scopes: ['global'] }).length, 1)
  assert.equal(store.add({ text: '修复后新增', scope: 'global' }).ok, true)
})

test('reload: 取消在途模型，模型忽略取消后的迟到结果也不能写回', async (t) => {
  let finish, entered
  const ready = new Promise((resolve) => { entered = resolve })
  const gate = new Promise((resolve) => { finish = resolve })
  let signal
  const dsh = { llm: { async *stream(params) {
    signal = params.signal
    entered()
    await gate
    yield { type: 'text-delta', text: '[{"op":"add","text":"迟到的新事实","scope":"global"}]' }
  } } }
  const day = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE')
  const lines = Array.from({ length: 6 }, () => ({ chatId: 'private:2', who: '小张', text: '我最近在学习整理档案，内容需要持久保存' }))
  const { store } = fixture(t, dsh, { chatLogDays: () => [day], chatLogOf: () => lines })
  const task = store.consolidate()
  await ready
  store.reload()
  const cancelled = signal.aborted
  finish()
  const result = await task
  assert.equal(cancelled, true)
  assert.equal(result.ok, false)
  assert.equal(store.list().length, 0)
})
