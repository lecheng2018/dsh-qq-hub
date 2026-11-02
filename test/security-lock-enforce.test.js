// 权限锁真正生效：锁着时危险终端命令被直接拦下（不发确认），解锁后回到原确认流程。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDangerGuard } from '../src/security/danger.js'

const OWNER = '10000001'
const DANGER = 'rm -rf /'
const exec = (cmd) => ({ name: 'bash', arguments: { command: cmd }, agent: { session: { id: 's1' } } })
const make = (extra = {}) => createDangerGuard({
  getConfig: () => ({ security: { dangerConfirm: true }, ownerQQ: OWNER }),
  chatOfSession: () => `private:${OWNER}`,
  ownerQQ: () => OWNER,
  timeoutMs: 50,
  log: { warn () {}, info () {} },
  ...extra,
})

test('权限锁锁着时，危险命令直接拦下，且不打扰主人确认', async () => {
  let delivered = 0
  let nextCalled = false
  const r = await make({ deliver: async () => { delivered++ }, securityLock: () => ({ locked: true }) })
    .preExecute(exec(DANGER), () => { nextCalled = true; return 'ALLOWED' })
  assert.equal(r.kind, 'deny')
  assert.match(r.reason, /权限锁/)
  assert.match(r.reason, /\/unlock/)
  assert.equal(nextCalled, false, '不该放行')
  assert.equal(delivered, 0, '锁着时不该发确认消息')
})

test('权限锁锁着时，普通命令照常放行', async () => {
  let nextCalled = false
  await make({ deliver: async () => {}, securityLock: () => ({ locked: true }) })
    .preExecute(exec('ls -la'), () => { nextCalled = true })
  assert.equal(nextCalled, true)
})

test('解锁后回到原来的确认流程，主人确认才放行', async () => {
  let delivered = 0
  let nextCalled = false
  const g = make({
    deliver: async (chatId) => { delivered++; g.handleReply(chatId, OWNER, '确认') },
    securityLock: () => ({ locked: false }),
  })
  await g.preExecute(exec(DANGER), () => { nextCalled = true })
  assert.equal(delivered, 1, '解锁后应该发确认')
  assert.equal(nextCalled, true, '主人确认后放行')
})

test('权限锁没启用时，行为和移植前完全一致', async () => {
  let delivered = 0
  let nextCalled = false
  const g = make({
    deliver: async (chatId) => { delivered++; g.handleReply(chatId, OWNER, '确认') },
    securityLock: () => null,
  })
  await g.preExecute(exec(DANGER), () => { nextCalled = true })
  assert.equal(delivered, 1)
  assert.equal(nextCalled, true)
})

test('dangerConfirm 关着时，权限锁不介入（默认行为不变）', async () => {
  let nextCalled = false
  const g = createDangerGuard({
    getConfig: () => ({ security: { dangerConfirm: false }, ownerQQ: OWNER }),
    deliver: async () => {},
    chatOfSession: () => `private:${OWNER}`,
    ownerQQ: () => OWNER,
    securityLock: () => ({ locked: true }),
    timeoutMs: 50,
    log: { warn () {}, info () {} },
  })
  await g.preExecute(exec(DANGER), () => { nextCalled = true })
  assert.equal(nextCalled, true)
})
