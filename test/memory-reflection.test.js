import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/features/memory.js'

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-reflection-'))
  const previous = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  const store = createMemoryStore({
    dsh: { llm: { async *stream() { yield { type: 'text-delta', text: '{"insights":["他累的时候要少说一点"],"style":["短句回复"]}' } } } },
    getConfig: () => ({ ownerQQ: '10001', model: { provider: 'test', model: 'm' }, memory: { enabled: true, recallCount: 4 } }),
    log: { info() {}, warn() {} },
    ...options,
  })
  t.after(() => {
    store.dispose()
    if (previous === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

const chat = { kind: 'private', userId: '10002', chatId: 'private:10002', nickname: '小张' }

test('自动相处经验记录来源指纹和版本', async (t) => {
  const store = fixture(t)
  assert.equal(await store.reflect(chat, '小张：今天有点累\n我：那先休息'), 1)
  const row = store.insights().find((item) => item.key === 'qq:10002')
  assert.equal(row.list[0].origin, 'derived')
  assert.equal(typeof row.list[0].sourceFingerprint, 'string')
  assert.equal(row.list[0].sourceFingerprint.length, 64)
  assert.equal(typeof row.list[0].sourceRev, 'number')
  assert.match(store.contextFor(chat), /他累的时候要少说一点/)
})

test('reload 使自动经验失效，手工经验仍可使用', async (t) => {
  const store = fixture(t)
  await store.reflect(chat, '小张：今天有点累')
  store.setInsights('qq:10003', ['手工确认的经验'])
  store.reload()
  const generated = store.insights().find((item) => item.key === 'qq:10002').list[0]
  assert.equal(generated.stale, true)
  assert.doesNotMatch(store.contextFor(chat), /他累的时候要少说一点/)
  assert.match(store.contextFor({ ...chat, userId: '10003', chatId: 'private:10003' }), /手工确认的经验/)
})

test('关闭 reflection 上下文不影响手工记事和事实召回', (t) => {
  const store = fixture(t, { reflectionContext: false })
  store.setInsights('qq:10002', ['不应由 memory 重复注入的经验'])
  store.add({ text: '小张喜欢冷萃咖啡', about: '10002', scope: 'private:10002' })
  assert.doesNotMatch(store.contextFor(chat), /不应由 memory 重复注入的经验/)
  assert.equal(store.recall('冷萃咖啡', { chat }).length, 1)
})
