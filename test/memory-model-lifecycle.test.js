import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/features/memory.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-model-lifecycle-'))
  const previous = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  const store = createMemoryStore({
    dsh: { get: () => null, llm: { async *stream() { await new Promise(() => {}) } } },
    getConfig: () => ({ ownerQQ: '10001', botQQ: '20002', model: { provider: 'test', model: 'm' }, memory: { enabled: true } }),
    log: { info() {}, warn() {} },
  })
  t.after(() => {
    store.dispose()
    if (previous === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

async function settle(promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('模型任务未在 dispose 后退出')), 500)),
  ])
}

test('importCandidates 的独立模型任务在 dispose 后退出', async (t) => {
  const store = fixture(t)
  const pending = store.importCandidates('一段值得提炼的旧档案')
  await new Promise((resolve) => setTimeout(resolve, 20))
  store.dispose()
  assert.deepEqual(await settle(pending), [])
})

test('buildProfile 的独立模型任务在 dispose 后退出且不写人物档案', async (t) => {
  const store = fixture(t)
  for (const text of ['偏好一', '偏好二', '偏好三']) store.add({ text, about: '10002', aboutName: '小张', scope: 'private:10002' })
  const pending = store.buildProfile('10002', 'private:10002')
  await new Promise((resolve) => setTimeout(resolve, 20))
  store.dispose()
  assert.equal(await settle(pending), false)
  const archive = readFileSync(join(process.env.DSH_QQ_HUB_DATA_DIR, 'memory/private/10002/memory.md'), 'utf8')
  assert.doesNotMatch(archive, /"kind":"profile"/)
})
