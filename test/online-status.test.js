// 在线与已读模块（online-status/）的回归网：防抖合并 + 参数整形 + 幂等。
import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { createReadDebouncer, pickStatusParams } from '../src/modules/online-status/index.js'

test('防抖：窗口内多条消息只上报一次', async () => {
  let calls = 0
  const d = createReadDebouncer({
    delayMs: 30,
    call: async () => { calls += 1 },
  })
  d.note(); d.note(); d.note(); d.note()
  assert.equal(d.pending(), true, '窗口内挂着计时器')
  await sleep(80)
  assert.equal(calls, 1, '五条消息合并成一次 mark_all_as_read')
  assert.equal(d.pending(), false)
  d.dispose()
})

test('防抖：上报后新一轮又能挂起（持续消息持续合并）', async () => {
  let calls = 0
  const d = createReadDebouncer({ delayMs: 20, call: async () => { calls += 1 } })
  d.note()
  await sleep(60)
  d.note()
  await sleep(60)
  assert.equal(calls, 2)
  d.dispose()
})

test('dispose：撤掉挂起的计时器，之后 note 不再上报', async () => {
  let calls = 0
  const d = createReadDebouncer({ delayMs: 30, call: async () => { calls += 1 } })
  d.note()
  d.dispose()
  assert.equal(d.pending(), false, '计时器已撤')
  d.note()
  await sleep(60)
  assert.equal(calls, 0, 'dispose 后绝不再调')
})

test('call 抛错被吞掉（已读上报失败不冒泡）', async () => {
  const d = createReadDebouncer({ delayMs: 20, call: async () => { throw new Error('网关断开') } })
  d.note()
  await sleep(60)
  d.dispose()
})

test('pickStatusParams：文字非空才给参数，双字段名都带（网关各取所需），超长截断', () => {
  const p = pickStatusParams(' 在线，可喊 ')
  assert.equal(p.status_text, '在线，可喊')
  assert.equal(p.text, '在线，可喊')
  assert.equal(pickStatusParams('  '), null, '空串不给参数')
  assert.equal(pickStatusParams(null), null)
  assert.equal(pickStatusParams('长'.repeat(100)).status_text.length, 60)
})
