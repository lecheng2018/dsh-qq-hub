// 审计 Q09 的行为锁：
// 「清空本分区」过去不分记忆/档案——面板的记忆与人物档案两个分区共用
// /memory-privacy/clear-main，而它只遍历 memory.list() 删记忆点：
//   · 「人物档案」分区点了清空，实际一条档案都不会被删（面板却报「已清空」）；
//   · 「记忆」分区是前端循环逐条 memory.remove(id)，每条全量 save 一次
//     （N 条 = N 次写盘 + N 次索引失效），remove 的返回值没人看——
//     主库关着时每条都静默失败，面板照样报成功。
//
// 修复：store 层批量清（一次 filter 一次 save）+ 如实返回删除数；
// 面板按 kind 分流（memory / profiles），确认状态与 React key 也按 kind 区分。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const log = { info() {}, warn() {}, debug() {} }
const dsh = {}

async function mkStore() {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'qqhub-clear-'))
  const { createMemoryStore } = await import('../src/features/memory.js')
  const { normalize } = await import('../src/core/config.js')
  const cfg = normalize({ model: { provider: 'p', model: 'm' } })
  const mem = createMemoryStore({ dsh, getConfig: () => cfg, log })
  return { mem, cfg }
}

test('Q09 · clearScopeEntries 一次批量清空，返回真实删除数', async () => {
  const { mem } = await mkStore()
  mem.add({ text: '香菜不吃', scope: 'private:10000001', source: 'manual' })
  mem.add({ text: '爱吃火锅', scope: 'private:10000001', source: 'manual' })
  mem.add({ text: '群A的事', scope: 'group:777', source: 'manual' })

  const r = mem.clearScopeEntries('private:10000001')
  assert.equal(r.ok, true)
  assert.equal(r.items, 2, `该作用域应清掉 2 条，实际 ${r.items}`)

  // 别的作用域不受影响
  const rest = mem.clearScopeEntries('group:777')
  assert.equal(rest.items, 1)
})

test('Q09 · clearProfilesInScope 只清该作用域的档案，global 不动', async () => {
  const { mem } = await mkStore()
  // setProfile(qq, text, name, scope, personaId) —— 位置参数
  mem.setProfile('10000001', '主人养猫', '', 'private:10000001')
  mem.setProfile('20000002', '群友爱发图', '', 'group:777')
  mem.setProfile('30000003', '公共设定', '', 'global')

  const r = mem.clearProfilesInScope('private:10000001')
  assert.equal(r.ok, true)
  assert.equal(r.profiles, 1, `应清掉 1 份档案，实际 ${r.profiles}`)
  const rest = mem.profiles().map((p) => p.scope)
  assert.ok(!rest.includes('private:10000001'), '目标作用域档案应被清空')
  assert.ok(rest.includes('global'), 'global 档案不能被殃及')
})

test('Q09 · 主库关闭时批量清除如实失败，不再谎报已清空', async () => {
  const { mem } = await mkStore()
  mem.add({ text: 'x', scope: 'private:10000001', source: 'manual' })
  if (typeof mem.dispose === 'function') await mem.dispose()
  const r = mem.clearScopeEntries('private:10000001')
  assert.equal(r.ok, false, '关库后必须如实失败')
  assert.match(r.message, /已关闭/)
})
