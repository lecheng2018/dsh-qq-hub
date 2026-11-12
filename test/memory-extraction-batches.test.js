import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/features/memory.js'
import { extractionBatchOf } from '../src/features/memory-extraction.js'
import { fingerprintChatLog } from '../src/chat/chat-log.js'

const dayOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const yesterday = () => dayOf(new Date(Date.now() - 86400000))
const records = Array.from({ length: 161 }, (_, i) => ({
  t: 1700000000000 + i,
  chatId: 'private:10002',
  who: '小张',
  text: `第 ${i} 条记录包含需要长期保存的具体事实和细节`,
}))

test('提炼批次 ID 同时绑定聊天、块位置和输入指纹', () => {
  const a = extractionBatchOf('private:10002', 0, records.slice(0, 80))
  assert.equal(a.id, extractionBatchOf('private:10002', 0, records.slice(0, 80)).id)
  assert.notEqual(a.id, extractionBatchOf('group:10002', 0, records.slice(0, 80)).id)
  assert.notEqual(a.id, extractionBatchOf('private:10002', 1, records.slice(0, 80)).id)
  assert.notEqual(a.fingerprint, extractionBatchOf('private:10002', 0, [{ ...records[0], text: '被替换' }, ...records.slice(1, 80)]).fingerprint)
})

test('第二块模型失败后，重试跳过已成功块且只在全部成功后推进日进度', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-extraction-batches-'))
  const previous = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  const prompts = []
  let failSecond = true
  const store = createMemoryStore({
    dsh: {
      get: () => null,
      llm: { async *stream(params) {
        if (params.system.includes('整理长期记忆')) {
          const text = params.messages[0].content[0].text
          prompts.push(text)
          if (failSecond && text.includes('第 80 条记录')) throw new Error('第二块模型失败')
        }
        yield { type: 'text-delta', text: params.system.includes('{"insights"') ? '{"insights":[],"style":[]}' : '[]' }
      } },
    },
    getConfig: () => ({ ownerQQ: '10001', model: { provider: 'test', model: 'm' }, memory: { enabled: true } }),
    chatLog: {
      listDays: () => [yesterday()],
      readDaySnapshot: () => ({ records, prefixFingerprint: (count) => fingerprintChatLog(records.slice(0, count)) }),
    },
    log: { info() {}, warn() {} },
  })
  t.after(() => {
    store.dispose()
    if (previous === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })

  const first = await store.consolidate()
  assert.equal(first.ok, false)
  assert.equal(prompts.length, 2, `首次只跑到失败的第二块：${first.message}`)
  const stateFile = join(dir, 'memory/state.json')
  const failedState = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(Object.values(failedState.extractionBatches).filter((batch) => batch.status === 'done').length, 1)
  assert.equal(Object.values(failedState.extractionBatches).filter((batch) => batch.status === 'failed').length, 1)
  assert.equal(failedState.processed[yesterday()], undefined)

  failSecond = false
  const second = await store.consolidate()
  assert.equal(second.ok, true, second.message)
  assert.equal(prompts.filter((text) => text.includes('第 0 条记录')).length, 1, '成功块不得重复请求模型')
  assert.equal(prompts.filter((text) => text.includes('第 80 条记录')).length, 2, '失败块可以重试')
  assert.equal(prompts.filter((text) => text.includes('第 160 条记录')).length, 1, '后续块继续执行')
  const doneState = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(Object.values(doneState.extractionBatches).filter((batch) => batch.status === 'done').length, 3)
  assert.equal(doneState.processed[yesterday()], 161)

  const [interruptedId] = Object.keys(doneState.extractionBatches)
  doneState.extractionBatches[interruptedId].status = 'running'
  delete doneState.processed[yesterday()]
  delete doneState.processedSources[yesterday()]
  writeFileSync(stateFile, JSON.stringify(doneState))
  store.reload()
  const beforePending = prompts.length
  const pending = await store.consolidate()
  assert.equal(pending.ok, false)
  assert.match(pending.failed[0]?.error || pending.message, /状态未确认|待核对/)
  assert.equal(prompts.length, beforePending, '中断批次未经核对不得自动重跑模型')
})
