import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatLog, createChatLogApi } from '../src/chat/chat-log.js'
import { createMemoryStore } from '../src/features/memory.js'
import { withAbortTimeout } from '../src/core/llm.js'

const log = { info() {}, warn() {}, debug() {} }
const day = '2026-11-10'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'chatlog-consumers-'))
  const previous = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  let time = new Date(2026, 10, 10, 12).getTime()
  const service = createChatLog({ now: () => time, log })
  const chatLog = createChatLogApi(service)
  const config = () => ({ ownerQQ: '10001', enabled: true, model: { provider: 'test', model: 'm' }, memory: { enabled: true } })
  const append = (count, offset = 0) => {
    for (let i = offset; i < offset + count; i++) service.append('group:777', '群友', `石化流配装这次很有趣，具体原话编号 ${i}`, '555')
  }
  t.after(() => {
    service.dispose()
    if (previous === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, service, chatLog, config, append,
    setTime: (value) => { time = value },
  }
}

test('shared logs remain readable by other consumers after memory consolidation or disposal', async (t) => {
  const f = fixture(t)
  f.append(14)
  const memory = createMemoryStore({
    dsh: { get: () => null, llm: { async *stream() { yield { type: 'text-delta', text: '[]' } } } },
    getConfig: f.config, chatLog: f.chatLog, log,
  })
  assert.equal((await memory.consolidate()).ok, true)
  memory.dispose()
  assert.equal(f.chatLog.readDay(day).length, 14)
})

test('model timeout wrapper also cancels immediately on parent disposal', async () => {
  const controller = new AbortController()
  let seen
  let started
  const ready = new Promise((resolve) => { started = resolve })
  const pending = withAbortTimeout(async (signal) => {
    seen = signal
    started()
    return await new Promise(() => {})
  }, 120000, '测试', controller.signal)
  await ready
  controller.abort(new Error('consumer disposed'))
  await assert.rejects(pending, /consumer disposed/)
  assert.equal(seen.aborted, true)
})
