import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/features/memory.js'

const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const yesterday = () => dayOf(new Date(Date.now() - 86400000))
const linesOf = (chatId) => Array.from({ length: 6 }, (_, i) => ({ chatId, who: '小张', text: `我在测试共享聊天流水，第 ${i} 条有具体内容` }))
function fixture(t, respond) {
  const dir = mkdtempSync(join(tmpdir(), 'consolidate-safety-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  let calls = 0
  const deleted = []
  const logs = new Map([[yesterday(), linesOf('private:10002')]])
  const dsh = { get: () => null, llm: { async *stream(params) {
    calls++
    yield { type: 'text-delta', text: await respond(params) }
  } } }
  const store = createMemoryStore({ dsh, getConfig: () => ({ ownerQQ: '10001', model: { provider: 'test', model: 'm' }, memory: { enabled: true } }),
    hub: { chatLogDays: () => [...logs.keys()], chatLogOf: (day) => logs.get(day), deleteChatLog: (day) => deleted.push(day) },
    log: { info() {}, warn() {} } })
  t.after(() => {
    store.dispose()
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, store, logs, deleted, calls: () => calls, state: () => JSON.parse(readFileSync(join(dir, 'memory/state.json'), 'utf8')) }
}

for (const mode of ['throw', 'invalid-json', 'reflect-failure']) {
  test(`consolidate safety: ${mode} 返回可定位失败、不推进当天进度、不删除流水`, async (t) => {
    const f = fixture(t, ({ system }) => {
      if (mode === 'throw' || (mode === 'reflect-failure' && system.includes('{"insights"'))) throw new Error('模型服务不可用')
      if (mode === 'invalid-json') return '不是合法的 JSON 数组'
      return '[]'
    })
    const r = await f.store.consolidate()
    assert.equal(r.ok, false)
    assert.equal(r.failed[0].chatId, 'private:10002')
    assert.equal(r.failed[0].day, yesterday())
    assert.match(r.failed[0].error, /模型|JSON/)
    assert.equal(f.state().processed[yesterday()], undefined)
    assert.deepEqual(f.deleted, [])
  })
}

test('consolidate safety: 成功只推进自己的进度，昨日共享流水保留且重跑不再请求模型', async (t) => {
  const f = fixture(t, ({ system }) => system.includes('{"insights"') ? '{"insights":[],"style":[]}' : '[]')
  const r = await f.store.consolidate()
  assert.equal(r.ok, true, r.message)
  assert.equal(f.state().processed[yesterday()], 6)
  assert.deepEqual(f.deleted, [])
  const calls = f.calls()
  await f.store.consolidate()
  assert.equal(f.calls(), calls)
})

test('consolidate safety: 内容太少或纯寒暄是明确跳过，不当作模型失败', async (t) => {
  const f = fixture(t, () => { throw new Error('不应调用模型') })
  f.logs.set(yesterday(), Array.from({ length: 6 }, () => ({ chatId: 'private:10002', who: '人', text: '早' })))
  const r = await f.store.consolidate()
  assert.equal(r.ok, true, r.message)
  assert.equal(f.calls(), 0)
  assert.equal(f.state().processed[yesterday()], 6)
  assert.deepEqual(f.deleted, [])
})

test('consolidate safety: 同日部分聊天失败不得推进整日进度', async (t) => {
  const f = fixture(t, ({ messages, system }) => {
    if (JSON.stringify(messages).includes('失败聊天')) throw new Error('模型拒绝')
    return system.includes('{"insights"') ? '{"insights":[],"style":[]}' : '[]'
  })
  f.logs.get(yesterday()).push(...linesOf('group:20001').map((l) => ({ ...l, text: '失败聊天的具体内容需要保留' })))
  const r = await f.store.consolidate()
  assert.equal(r.ok, false)
  assert.equal(r.failed.length, 1)
  assert.equal(r.failed[0].chatId, 'group:20001')
  assert.equal(f.state().processed[yesterday()], undefined)
  assert.deepEqual(f.deleted, [])
})

test('consolidate safety: 状态损坏时不调用模型、不自动重跑', async (t) => {
  const f = fixture(t, () => '[]')
  mkdirSync(join(f.dir, 'memory'), { recursive: true })
  writeFileSync(join(f.dir, 'memory/state.json'), '{坏状态')
  f.store.reload()
  const r = await f.store.consolidate()
  assert.equal(r.ok, false)
  assert.match(r.message, /状态|档案/)
  assert.equal(f.calls(), 0)
  assert.deepEqual(f.deleted, [])
})
