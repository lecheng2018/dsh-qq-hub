import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/features/memory.js'

test('关闭 memory 旧蒸馏上下文不影响事实召回', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-distill-context-'))
  const previous = process.env.DSH_QQ_HUB_DATA_DIR
  process.env.DSH_QQ_HUB_DATA_DIR = dir
  const store = createMemoryStore({
    distillContext: false,
    getConfig: () => ({ ownerQQ: '10001', memory: { enabled: true, recallCount: 4 } }),
    log: { info() {}, warn() {} },
  })
  t.after(() => {
    store.dispose()
    if (previous === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
    else process.env.DSH_QQ_HUB_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  const chat = { kind: 'group', groupId: '123', chatId: 'group:123' }
  store.addDistillTarget({ gid: '123', uid: '456', name: '小张' })
  store.putDistill('123', '456', { style: ['不应重复注入的风格'] }, 15)
  store.add({ text: '群里讨论过冷萃咖啡', scope: 'group:123' })
  assert.doesNotMatch(store.contextFor(chat), /不应重复注入的风格/)
  assert.equal(store.recall('冷萃咖啡', { chat }).length, 1)
})
