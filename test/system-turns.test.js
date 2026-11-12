import test from 'node:test'
import assert from 'node:assert/strict'
import { createSystemTurns } from '../src/chat/system-turns.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

function fixture() {
  const listeners = new Set()
  const agents = new Map()
  const archived = []
  let seq = 0
  const service = createSystemTurns({
    createSession: async ({ key }) => {
      await tick()
      const sessionId = `session-${++seq}`
      const messages = []
      agents.set(sessionId, { messages, followup: async (message) => { messages.push(message) } })
      return { sessionId }
    },
    resolveAgent: async (sessionId) => ({ agent: agents.get(sessionId) }),
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    archiveSession: async (sessionId) => { archived.push(sessionId) },
  })
  const emit = (sessionId, event) => {
    for (const listener of [...listeners]) listener({ id: sessionId }, event)
  }
  const complete = (sessionId, text = '完成', turn = 1) => {
    emit(sessionId, { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } })
    emit(sessionId, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })
  }
  return { service, agents, archived, listeners, complete }
}

test('系统后台回合复用同 key 会话，不同 key 独立且只生成不投递', async () => {
  const { service, agents, complete } = fixture()
  const first = service.run('alpha', '后台甲', '第一句')
  await tick()
  const second = service.run('alpha', '后台甲', '第二句')
  await assert.rejects(second, /上一轮还没结束/)
  complete('session-1', '第一句完成')
  assert.equal(await first, '第一句完成')

  const reused = service.run('alpha', '后台甲', '复用')
  await tick()
  assert.equal(agents.size, 1)
  complete('session-1', '复用完成', 2)
  assert.equal(await reused, '复用完成')

  const keyed = service.run('alpha', '另一种用途', '独立', { key: 'behavior' })
  await tick()
  assert.equal(agents.size, 2)
  complete('session-2', '独立完成')
  assert.equal(await keyed, '独立完成')
  await service.dispose()
})

test('超时及时返回且不结束底层回合，迟到结果只释放占用', async () => {
  const { service, complete } = fixture()
  await assert.rejects(service.run('alpha', '后台甲', '慢慢想', { timeoutMs: 10 }), /等太久了/)
  await assert.rejects(service.run('alpha', '后台甲', '不能插队', { timeoutMs: 10 }), /上一轮还没结束/)
  complete('session-1', '迟到的正文')

  const next = service.run('alpha', '后台甲', '下一轮', { timeoutMs: 1000 })
  await tick()
  complete('session-1', '新正文', 2)
  assert.equal(await next, '新正文')
  await service.dispose()
})

test('重置只归档当前系统会话并清空映射，dispose 摘除全部监听', async () => {
  const { service, archived, listeners, complete } = fixture()
  const pending = service.run('alpha', '后台甲', '第一句')
  await tick()
  complete('session-1')
  await pending
  assert.equal(await service.resetSessions(), 1)
  assert.deepEqual(archived, ['session-1'])

  const fresh = service.run('alpha', '后台甲', '新会话')
  await tick()
  complete('session-2')
  await fresh
  assert.equal(archived.length, 1)
  await service.dispose()
  assert.equal(listeners.size, 0)
})
