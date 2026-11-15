// Token 预算可配置化（token-billing 设置 + 账本再分配语义）的回归网。
//
// 关键语义：allocate 只重算限额、不清已用——面板改预算后「剩余 = 新上限 − 已用」
// 即时生效，绝不把已烧掉的 token 凭空还回来（那等于无限配额）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createTokenLedger, todayKey } from '../src/chat/token-ledger.js'
import { budgetFromSettings } from '../src/modules/token-billing/index.js'

const CHATS = [
  { chatKey: 'private:1000', owner: true },
  { chatKey: 'group:2000', whitelisted: true },
  { chatKey: 'group:3000', whitelisted: true },
]

test('budgetFromSettings：合法值直通、非法回退默认、百分比边界收口', () => {
  assert.deepEqual(budgetFromSettings({ dailyBudget: 80000, ownerSharePercent: 50 }), { total: 80000, ownerShare: 0.5 })
  // 缺省 → 默认 50000 / 60%
  assert.deepEqual(budgetFromSettings({}), { total: 50000, ownerShare: 0.6 })
  assert.deepEqual(budgetFromSettings({ dailyBudget: 'abc', ownerSharePercent: '' }), { total: 50000, ownerShare: 0.6 })
  // 边界收口：下限 1000、上限 5,000,000；占比 0 与 100 都合法
  assert.deepEqual(budgetFromSettings({ dailyBudget: 1, ownerSharePercent: 0 }), { total: 1000, ownerShare: 0 })
  assert.deepEqual(budgetFromSettings({ dailyBudget: 99999999, ownerSharePercent: 150 }), { total: 5000000, ownerShare: 1 })
  // 显式 0 占比是合法值（主人不分预算，全给群）
  const zero = budgetFromSettings({ dailyBudget: 10000, ownerSharePercent: 0 })
  assert.equal(zero.ownerShare, 0)
})

test('allocate({total, ownerShare})：限额按占比拆分', () => {
  const l = createTokenLedger()
  l.allocate(CHATS, { total: 10000, ownerShare: 0.5 })
  const snap = l.snapshot()
  assert.equal(snap.totalLimit, 10000)
  assert.equal(snap.allocations['private:1000'], 5000)
  assert.equal(snap.allocations['group:2000'], 2500)
  assert.equal(snap.allocations['group:3000'], 2500)
})

test('同日重新 allocate：已用保留，剩余 = 新上限 − 已用（即时生效不退款）', () => {
  const l = createTokenLedger()
  l.allocate(CHATS, { total: 10000, ownerShare: 0.6 }) // 主人 6000
  const r1 = l.record('private:1000', 5500)
  assert.equal(r1.state ?? r1.reason ?? '', '')
  assert.equal(l.remaining('private:1000'), 500)
  // 预算提到 20000：已用 5500 保留，剩余 = 12000 − 5500
  l.allocate(CHATS, { total: 20000, ownerShare: 0.6 })
  assert.equal(l.quotaOf('private:1000').limit, 12000)
  assert.equal(l.remaining('private:1000'), 6500)
  // 预算降到 4000：剩余归零、状态 exhausted，但不为负
  l.allocate(CHATS, { total: 4000, ownerShare: 0.6 })
  assert.equal(l.quotaOf('private:1000').limit, 2400)
  assert.equal(l.remaining('private:1000'), 0)
  assert.equal(l.isExhausted('private:1000'), true)
})

test('resetDaily：清空已用、保留分配，剩余回满（面板重置按钮的后端语义）', () => {
  const l = createTokenLedger()
  l.allocate(CHATS, { total: 10000, ownerShare: 0.6 })
  l.record('private:1000', 5500)
  assert.equal(l.remaining('private:1000'), 500)
  l.resetDaily(todayKey())
  assert.equal(l.remaining('private:1000'), 6000, '用量清零，限额保留')
  assert.equal(l.quotaOf('private:1000').limit, 6000, '分配保留')
})

test('record 超预算只记到上限，状态 exhausted（记账口径回归钉）', () => {
  const l = createTokenLedger()
  l.allocate([{ chatKey: 'private:1000', owner: true }], { total: 1000, ownerShare: 1 })
  const r = l.record('private:1000', 1500)
  assert.equal(r.applied, 1000)
  assert.equal(r.reason, 'exhausted')
  assert.equal(l.remaining('private:1000'), 0)
})
