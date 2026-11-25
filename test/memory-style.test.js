import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/features/memory.js'

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-style-'))
  const previous = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  const output = options.modelOutput || '{"insights":[],"style":["短句回复"]}'
  const store = createMemoryStore({
    dsh: { llm: { async *stream() { yield { type: 'text-delta', text: output } } } },
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

test('自动说话方式保留原数组契约并记录来源元数据', async (t) => {
  const store = fixture(t)
  await store.reflect(chat, '小张：今天有点累')
  assert.deepEqual(store.styleOf('qq:10002'), ['短句回复']) /* pii-scan:ignore */
  const meta = store.styleSourceOf('qq:10002') /* pii-scan:ignore */
  assert.equal(meta.origin, 'derived')
  assert.equal(meta.sourceFingerprint.length, 64)
  assert.equal(typeof meta.sourceRev, 'number')
})

test('reload 使自动风格失效，手工风格不受影响', async (t) => {
  const store = fixture(t)
  await store.reflect(chat, '小张：今天有点累')
  store.setStyle('qq:10003', ['手工确认的说法']) /* pii-scan:ignore */
  store.reload()
  assert.equal(store.styleSourceOf('qq:10002').stale, true) /* pii-scan:ignore */
  assert.deepEqual(store.styleOf('qq:10002'), []) /* pii-scan:ignore */
  assert.doesNotMatch(store.contextFor(chat), /短句回复/)
  assert.match(store.contextFor({ ...chat, userId: '10003', chatId: 'private:10003' }), /手工确认的说法/)
})

test('关闭 style 上下文不影响事实召回', (t) => {
  const store = fixture(t, { styleContext: false })
  store.setStyle('qq:10002', ['不应由 memory 重复注入的说法']) /* pii-scan:ignore */
  store.add({ text: '小张喜欢冷萃咖啡', about: '10002', scope: 'private:10002' })
  assert.doesNotMatch(store.contextFor(chat), /不应由 memory 重复注入的说法/)
  assert.equal(store.recall('冷萃咖啡', { chat }).length, 1)
})

test('自我风格学习也记录输入指纹', async (t) => {
  const store = fixture(t, { modelOutput: '["少用长句"]' })
  store.setStyle('qq:10002', ['短句', '爱叠字', '少用标点']) /* pii-scan:ignore */
  await store.learnSelfStyle()
  assert.deepEqual(store.styleOf('self'), ['少用长句'])
  assert.equal(store.styleSourceOf('self').origin, 'derived')
  assert.equal(store.styleSourceOf('self').sourceFingerprint.length, 64)
})

test('learnSelfStyle 遇到非 JSON 回复自动重试一次并成功写入', async (t) => {
  let calls = 0
  const store = fixture(t, {
    dsh: {
      llm: {
        async *stream(params) {
          calls++
          assert.match(params.messages[0].content[0].text, /JSON/)
          yield { type: 'text-delta', text: calls === 1 ? '请问你需要我如何改写这些句子？' : '["偶尔用hhh","少用标点"]' }
        },
      },
    },
  })
  store.setStyle('qq:10002', ['短句', '爱用hhh', '少标点']) /* pii-scan:ignore */
  await store.learnSelfStyle()
  assert.equal(calls, 2)
  assert.deepEqual(store.styleOf('self'), ['偶尔用hhh', '少用标点'])
})
