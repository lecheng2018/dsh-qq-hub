import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/features/memory.js'
import { fingerprintChatLog } from '../src/chat/chat-log.js'

const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const yesterday = () => dayOf(new Date(Date.now() - 86400000))
const recordsOf = (count, chatId = 'private:10002') => Array.from({ length: count }, (_, i) => ({
  t: Date.now() - (count - i) * 1000,
  chatId,
  who: '小张',
  text: `我最近在认真整理生活里的重要事情，第 ${i} 条记录有具体内容需要长期保存`,
}))

function fixture(t, records = recordsOf(6), onModel = () => '[]') {
  const dir = mkdtempSync(join(tmpdir(), 'memory-chatlog-progress-'))
  const previous = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  let calls = 0
  const logs = new Map([[yesterday(), records]])
  const chatLog = {
    listDays: () => [...logs.keys()].sort(),
    readDaySnapshot: (day) => {
      const rows = structuredClone(logs.get(day) || [])
      return { records: rows, prefixFingerprint: (count) => fingerprintChatLog(rows.slice(0, count)) }
    },
  }
  const dsh = { get: () => null, llm: { async *stream(params) {
    calls++
    yield { type: 'text-delta', text: await onModel(params) }
  } } }
  const store = createMemoryStore({
    dsh,
    getConfig: () => ({ ownerQQ: '10001', model: { provider: 'test', model: 'm' }, memory: { enabled: true } }),
    chatLog,
    log: { info() {}, warn() {} },
  })
  t.after(() => {
    store.dispose()
    if (previous === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, store, logs, calls: () => calls, state: () => JSON.parse(readFileSync(join(dir, 'memory/state.json'), 'utf8')) }
}

test('memory progress: appending preserves the consumed prefix and advances only this consumer', async (t) => {
  const f = fixture(t)
  assert.equal((await f.store.consolidate()).ok, true)
  const day = yesterday()
  const before = f.state().processedSources[day]
  assert.equal(before.count, 6)
  f.logs.get(day).push(...recordsOf(1))
  assert.equal((await f.store.consolidate()).ok, true)
  const after = f.state().processedSources[day]
  assert.equal(after.count, 7)
  assert.notEqual(after.fingerprint, before.fingerprint)
  const calls = f.calls()
  assert.equal((await f.store.consolidate()).ok, true)
  assert.equal(f.calls(), calls, '同一来源不重复请求模型')
})

test('memory progress: same-length replacement is rejected without advancing the cursor', async (t) => {
  const f = fixture(t)
  assert.equal((await f.store.consolidate()).ok, true)
  const day = yesterday()
  const before = f.state().processedSources[day]
  f.logs.set(day, recordsOf(6).map((row, i) => i === 0 ? { ...row, text: '同长度替换的流水内容，需要拒绝沿用旧游标' } : row))
  const calls = f.calls()
  const result = await f.store.consolidate()
  assert.equal(result.ok, false)
  assert.match(result.message, /被替换/)
  assert.equal(f.calls(), calls)
  assert.deepEqual(f.state().processedSources[day], before)
})

test('memory progress: a shortened source is rejected instead of treating the day as complete', async (t) => {
  const f = fixture(t)
  assert.equal((await f.store.consolidate()).ok, true)
  const day = yesterday()
  f.logs.set(day, recordsOf(5))
  const result = await f.store.consolidate()
  assert.equal(result.ok, false)
  assert.match(result.message, /缩短/)
  assert.equal(f.state().processed[day], 6)
})

test('memory consolidation: every 80-row batch is processed, including rows before the old 640-row cap', async (t) => {
  const prompts = []
  const f = fixture(t, recordsOf(641), ({ system, messages }) => {
    const text = messages[0].content[0].text
    if (system.includes('整理长期记忆')) prompts.push(text)
    return system.includes('{"insights"') ? '{"insights":[],"style":[]}' : '[]'
  })
  assert.equal((await f.store.consolidate()).ok, true)
  assert.equal(prompts.length, 9)
  assert.match(prompts[0], /第 0 条记录/)
  assert.match(prompts.at(-1), /第 640 条记录/)
})

test('memory progress: replacement during extraction does not certify the changed source as consumed', async (t) => {
  let f
  f = fixture(t, recordsOf(6), () => {
    f.logs.get(yesterday())[0] = { ...f.logs.get(yesterday())[0], text: '模型运行期间替换来源' }
    return '[]'
  })
  const result = await f.store.consolidate()
  assert.equal(result.ok, false)
  assert.match(result.message, /替换/)
  assert.throws(() => f.state(), { code: 'ENOENT' }, '首次整理失败不应创建进度文件')
})
