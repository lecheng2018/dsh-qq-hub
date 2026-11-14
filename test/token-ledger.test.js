// 回归：每日 Token 配额账本（Phase 3 · 成本熔断）。
// 口径来自计划书 §八.2 / §十一.1：单日 50,000 硬顶，主人私聊 60%、白名单群均分 40%，
// 非主人私聊与未授权群 0 配额；超限熔断，跨日自动滚动，非法输入 fail-closed。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DAILY_BUDGET,
  OWNER_SHARE,
  GROUP_SHARE,
  createTokenLedger,
  todayKey,
  defaultLedger,
  tokenLedgerRecord as defaultRecord,
} from '../src/chat/token-ledger.js'

const DAY = '2026-11-13'
const chats = [
  { chatKey: 'private:10001', role: 'owner' },
  { chatKey: 'group:20001', whitelisted: true },
  { chatKey: 'group:20002', whitelisted: true },
  { chatKey: 'private:10002' },            // 非主人私聊
  { chatKey: 'group:29999' },              // 未授权群
]

function fresh(budget = undefined, day = DAY) {
  const ledger = createTokenLedger({ budget, today: day })
  ledger.allocate(chats, budget, { dateKey: day })
  return ledger
}

test('默认单日预算 50,000，权重 60/40', () => {
  assert.equal(DEFAULT_DAILY_BUDGET, 50_000)
  assert.equal(OWNER_SHARE, 0.6)
  assert.equal(GROUP_SHARE, 0.4)
})

test('60/40 分配：主人私聊 30,000，白名单群各 10,000', () => {
  const ledger = fresh()
  const snap = ledger.snapshot()
  assert.equal(snap.budget, 50_000)
  assert.equal(snap.ownerBudget, 30_000)
  assert.equal(snap.groupBudget, 20_000)
  assert.equal(snap.allocations['private:10001'], 30_000)
  assert.equal(snap.allocations['group:20001'], 10_000)
  assert.equal(snap.allocations['group:20002'], 10_000)
  // 40% 在两个白名单群之间均分，总数不因取整丢失
  assert.equal(snap.allocations['group:20001'] + snap.allocations['group:20002'], 20_000)
})

test('非主人私聊与未授权群不分配主动生活流配额（恒 0）', () => {
  const ledger = fresh()
  for (const key of ['private:10002', 'group:29999']) {
    assert.equal(ledger.remaining(key), 0)
    assert.equal(ledger.isExhausted(key), true)
    assert.equal(ledger.quotaOf(key).tier, 'none')
    const r = ledger.record(key, 10)
    assert.equal(r.applied, 0, '0 配额不许记账')
    assert.equal(r.refused, true)
    assert.equal(r.reason, 'no-quota')
    assert.equal(ledger.quotaOf(key).used, 0)
  }
})

test('记账累计到配额后熔断，且超额部分不会被吞进来', () => {
  const ledger = fresh()
  const key = 'group:20001'
  assert.equal(ledger.record(key, 9_000).remaining, 1_000)
  assert.equal(ledger.isExhausted(key), false)
  // 踩线：一次给 5,000，只吃掉剩余 1,000
  const over = ledger.record(key, 5_000)
  assert.equal(over.applied, 1_000)
  assert.equal(over.used, 10_000)
  assert.equal(over.remaining, 0)
  assert.equal(over.exhausted, true)
  assert.equal(over.reason, 'exhausted')
  assert.equal(ledger.isExhausted(key), true)
  // 熔断后继续记账：一条都不再吃，但也不抛错（调用方据此降级）
  const after = ledger.record(key, 500)
  assert.equal(after.applied, 0)
  assert.equal(after.reason, 'exhausted')
  assert.equal(ledger.quotaOf(key).used, 10_000)
})

test('主人私聊配额独立于群配额', () => {
  const ledger = fresh()
  ledger.record('group:20001', 10_000)
  assert.equal(ledger.isExhausted('group:20001'), true)
  assert.equal(ledger.isExhausted('private:10001'), false)
  assert.equal(ledger.remaining('private:10001'), 30_000)
})

test('跨日自动滚动：换天用量清零，配额不变', () => {
  const ledger = fresh()
  ledger.record('private:10001', 30_000)
  assert.equal(ledger.isExhausted('private:10001'), true)

  // 只读查询带上新日期就能看到「新的一天」，不会把旧用量算进去
  assert.equal(ledger.remaining('private:10001', { dateKey: '2026-11-14' }), 30_000)

  // 显式 resetDaily 翻页
  const snap = ledger.resetDaily('2026-11-14')
  assert.equal(snap.dateKey, '2026-11-14')
  assert.equal(snap.totalUsed, 0)
  assert.equal(ledger.isExhausted('private:10001'), false)
  assert.equal(ledger.remaining('private:10001'), 30_000)

  // 记账时带新日期也会自动滚动
  ledger.record('private:10001', 10_000)
  ledger.record('private:10001', 5_000, { dateKey: '2026-11-15' })
  assert.equal(ledger.quotaOf('private:10001').used, 5_000)
  assert.equal(ledger.quotaOf('private:10001').dateKey, '2026-11-15')
})

test('非法输入 fail-closed：负数 / 小数 / 非数字 / NaN / Infinity / 非法 ChatKey', () => {
  const ledger = fresh()
  for (const bad of [-1, -0.5, 1.5, NaN, Infinity, -Infinity, '100', null, undefined, true, {}, []]) {
    assert.throws(() => ledger.record('private:10001', bad), TypeError, `tokens=${String(bad)} 必须抛 TypeError`)
  }
  for (const badKey of ['10001', '', 'private:abc', null, undefined, 42, {}]) {
    assert.throws(() => ledger.record(badKey, 10), TypeError)
    assert.throws(() => ledger.remaining(badKey), TypeError)
    assert.throws(() => ledger.isExhausted(badKey), TypeError)
  }
  // 一次非法记账都没落地
  assert.equal(ledger.quotaOf('private:10001').used, 0)

  assert.throws(() => ledger.allocate('not-array'), TypeError)
  assert.throws(() => ledger.allocate([null]), TypeError)
  assert.throws(() => ledger.allocate([{ chatKey: 'private:10001' }], -100), TypeError)
  assert.throws(() => ledger.allocate([{ chatKey: 'private:10001' }], { total: 1000, ownerShare: 1.5 }), TypeError)
  assert.throws(() => ledger.resetDaily('2026-13-40'), TypeError)
  assert.throws(() => ledger.resetDaily(null), TypeError)
})

test('并发同 chatKey 记账不重复也不超支', async () => {
  const ledger = fresh()
  const key = 'private:10001'
  // 同步函数在同一 tick 里被并发调用：每次都基于最新已用量，绝不能各自读到旧值
  await Promise.all(Array.from({ length: 100 }, () => Promise.resolve().then(() => ledger.record(key, 1_000))))
  const quota = ledger.quotaOf(key)
  assert.equal(quota.used, 30_000, '100 × 1,000 只能吃到 30,000 上限')
  assert.equal(quota.remaining, 0)
  assert.equal(quota.exhausted, true)
  // 账本总量守恒
  assert.equal(ledger.snapshot().totalUsed, 30_000)
})

test('空输入与重复 chatKey：不报错、不重复分配', () => {
  const ledger = createTokenLedger({ today: DAY })
  const empty = ledger.allocate([], DEFAULT_DAILY_BUDGET, { dateKey: DAY })
  assert.equal(empty.totalLimit, 0)
  assert.deepEqual(empty.allocations, {})

  const dup = ledger.allocate(
    [{ chatKey: 'private:10001', role: 'owner' }, { chatKey: 'private:10001', role: 'owner' }],
    1_000,
    { dateKey: DAY },
  )
  assert.equal(dup.allocations['private:10001'], 600, '重复项只按一个号分 60%')

  const nullish = ledger.allocate([{ chatKey: 'group:20001', whitelisted: true }], undefined, { dateKey: DAY })
  assert.equal(nullish.budget, 50_000, '不给 budget 时回落默认值')
  assert.equal(nullish.allocations['group:20001'], 20_000)
})

test('返回的分配/用量是副本，改它不污染内部状态', () => {
  const ledger = fresh()
  const snap = ledger.snapshot()
  snap.allocations['private:10001'] = 1
  snap.usage['private:10001'] = 999_999
  const quota = ledger.quotaOf('private:10001')
  quota.limit = 1
  quota.used = 999_999
  assert.equal(ledger.quotaOf('private:10001').limit, 30_000)
  assert.equal(ledger.quotaOf('private:10001').used, 0)
  assert.equal(ledger.remaining('private:10001'), 30_000)

  const first = ledger.allocate(chats, DEFAULT_DAILY_BUDGET, { dateKey: DAY })
  first.allocations['group:20001'] = 0
  const second = ledger.allocate(chats, DEFAULT_DAILY_BUDGET, { dateKey: DAY })
  assert.equal(second.allocations['group:20001'], 10_000)
})

test('确定性：同一序列连算 3 次结果全等', () => {
  const run = () => {
    const ledger = fresh(12_345)
    const out = [
      ledger.record('private:10001', 4_000),
      ledger.record('group:20001', 2_000),
      ledger.record('group:20002', 1_000),
      ledger.record('private:10002', 500),
      ledger.quotaOf('private:10001'),
      ledger.snapshot(),
    ]
    return JSON.stringify(out)
  }
  const a = run()
  assert.equal(run(), a)
  assert.equal(run(), a)
})

test('todayKey 兜底与模块级单例可用', () => {
  assert.match(todayKey(), /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(todayKey(new Date('2026-11-13T10:00:00Z')), '2026-11-13')
  assert.equal(typeof defaultLedger.record, 'function')
  assert.equal(typeof defaultRecord, 'function')
})
