import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryStore } from '../src/features/memory.js'
import { nextConsolidationRetry, consolidationRetryBlocked, CONSOLIDATION_MAX_ATTEMPTS } from '../src/features/memory-learning.js'

const dayOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const yesterday = () => dayOf(new Date(Date.now() - 86_400_000))

function fixture(t, respond) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-consolidation-retry-'))
  const previous = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  let calls = 0
  const logs = new Map([[yesterday(), Array.from({ length: 6 }, (_, index) => ({ chatId: 'private:10002', who: '小张', text: `需要长期保存的具体事实 ${index}` }))]])
  const store = createMemoryStore({
    dsh: {
      get: () => null,
      llm: { async *stream(params) {
        calls++
        yield { type: 'text-delta', text: await respond(params) }
      } },
    },
    getConfig: () => ({ ownerQQ: '10001', model: { provider: 'test', model: 'm' }, memory: { enabled: true, dailyConsolidate: true, consolidateTimes: ['00:00'] } }),
    hub: { chatLogDays: () => [...logs.keys()], chatLogOf: (day) => logs.get(day), deleteChatLog() {} },
    log: { info() {}, warn() {} },
  })
  t.after(() => {
    store.dispose()
    if (previous === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    store,
    calls: () => calls,
    state: () => JSON.parse(readFileSync(join(dir, 'memory/state.json'), 'utf8')),
    expireRetry() {
      const state = JSON.parse(readFileSync(join(dir, 'memory/state.json'), 'utf8'))
      state.lastConsolidate.retry.nextRetryAt = 0
      writeFileSync(join(dir, 'memory/state.json'), JSON.stringify(state))
      store.reload()
    },
  }
}

test('整理退避按 5/15/30 分钟持久化，第三次失败暂停', () => {
  const now = 1_800_000_000_000
  const first = nextConsolidationRetry(null, now, '第一次失败')
  assert.equal(first.attempts, 1)
  assert.equal(first.nextRetryAt, now + 5 * 60_000)
  assert.equal(consolidationRetryBlocked(first, now), true)
  assert.equal(consolidationRetryBlocked(first, first.nextRetryAt), false)
  const second = nextConsolidationRetry(first, now, '第二次失败')
  assert.equal(second.attempts, 2)
  assert.equal(second.nextRetryAt, now + 15 * 60_000)
  const third = nextConsolidationRetry(second, now, '第三次失败')
  assert.equal(third.attempts, CONSOLIDATION_MAX_ATTEMPTS)
  assert.equal(third.nextRetryAt, 0)
  assert.equal(consolidationRetryBlocked(third, now + 30 * 60_000), true)
})

test('自动整理冷却不重复调用，第三次暂停后手动成功解除', async (t) => {
  let valid = false
  const f = fixture(t, ({ system }) => system.includes('整理长期记忆') && !valid
    ? '[{"text":"截断"'
    : system.includes('{"insights"') ? '{"insights":[],"style":[]}' : '[]')
  await f.store.tick()
  assert.equal(f.state().lastConsolidate.retry.attempts, 1)
  assert.equal(f.state().lastConsolidate.retry.nextRetryAt - f.state().lastConsolidate.retry.failedAt, 5 * 60_000)
  let before = f.calls()
  await f.store.tick()
  assert.equal(f.calls(), before, '冷却期不得再次调用模型')

  f.expireRetry()
  await f.store.tick()
  assert.equal(f.state().lastConsolidate.retry.attempts, 2)
  assert.equal(f.state().lastConsolidate.retry.nextRetryAt - f.state().lastConsolidate.retry.failedAt, 15 * 60_000)
  f.expireRetry()
  await f.store.tick()
  assert.equal(f.state().lastConsolidate.retry.attempts, 3)
  assert.equal(f.state().lastConsolidate.retry.nextRetryAt, 0)
  before = f.calls()
  await f.store.tick()
  assert.equal(f.calls(), before, '第三次失败后自动整理暂停')

  valid = true
  const recovered = await f.store.consolidate()
  assert.equal(recovered.ok, true, recovered.message)
  assert.equal(f.state().lastConsolidate.retry, undefined, '手动完整成功清除暂停状态')
  before = f.calls()
  await f.store.tick()
  assert.equal(f.state().runs['00:00'], dayOf(new Date()))
  assert.equal(f.calls(), before, '已完成的当天任务不重复提炼')
})

test('模块卸载后的迟到 tick 不写重试或完成状态', async (t) => {
  let notifyStarted
  let release
  const started = new Promise((resolve) => { notifyStarted = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const f = fixture(t, async () => {
    notifyStarted()
    await gate
    return '[]'
  })
  const ticking = f.store.tick()
  await started
  f.store.dispose()
  release()
  await ticking
  assert.equal(f.state().lastConsolidate.retry, undefined)
  assert.deepEqual(f.state().runs, {})
})
