// 缺陷 C 回归：Token 账本启动期误熔断。
//
// 现象（改前实测）：进程刚起来、当天还没有任何 session/usage 时，账本是空的
// （limits/tiers 都没填），于是 remaining()=0 → isExhausted()=true →
// 早晨的主动问候被误熔断，/speakup/fire 还会谎报「配额已用完」。
//
// 根因：`limit === 0` 被当成「配额用完」，但它其实有三种完全不同的含义：
//   ① 还没分配（账本刚创建 / 刚重启）      → 应该 fail-open 放行；
//   ② 分配过但不在配额体系里（非主人私聊 / 未授权群）→ 应该照旧不放行；
//   ③ 分配过且真的用完了                   → 应该熔断。
// 这个文件把三者钉死。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTokenLedger } from '../src/chat/token-ledger.js'

const DAY = '2026-11-14'
const owner = { chatKey: 'private:10001', owner: true }
const group = { chatKey: 'group:20001', whitelisted: true }
const stranger = { chatKey: 'private:10002' }        // 非主人私聊
const noGroup = { chatKey: 'group:29999' }           // 未授权群

test('① 尚未分配：isExhausted 为 false（重启后当天还没聊天，不能误熔断）', () => {
  const ledger = createTokenLedger({ today: DAY })
  assert.equal(ledger.isExhausted('private:10001'), false, '空账本不得判「耗尽」')
  assert.equal(ledger.isExhausted('group:20001'), false)
  assert.equal(ledger.hasAllocation(DAY), false, '这个实例还没分配过')
  // 配额详情也要同口径（面板不能显示 exhausted:true）
  const q = ledger.quotaOf('private:10001')
  assert.equal(q.allocated, false)
  assert.equal(q.exhausted, false)
  assert.equal(q.limit, 0, 'limit 仍然是 0（还没分配，本来就没上限）')
})

test('① 尚未分配时 remaining 仍是 0（只读口径不变，避免调用方误以为有大把额度）', () => {
  const ledger = createTokenLedger({ today: DAY })
  assert.equal(ledger.remaining('private:10001'), 0)
  // isExhausted 与 remaining 现在是两个独立语义：没配额 ≠ 用完
  assert.equal(ledger.isExhausted('private:10001'), false)
})

test('② 分配后：主人私聊拿到 60%，且不判耗尽', () => {
  const ledger = createTokenLedger({ today: DAY })
  ledger.allocate([owner, group], undefined, { dateKey: DAY })
  assert.equal(ledger.hasAllocation(DAY), true)
  assert.equal(ledger.remaining('private:10001'), 30_000)
  assert.equal(ledger.isExhausted('private:10001'), false)
  assert.equal(ledger.quotaOf('private:10001').allocated, true)
})

test('② 分配后仍不受配额体系的会话照旧不放行（保持原意）', () => {
  const ledger = createTokenLedger({ today: DAY })
  ledger.allocate([owner, group, stranger, noGroup], undefined, { dateKey: DAY })
  // 这两类「本来就分不到」，必须继续不主动 —— 与缺陷 C 的 fail-open 不冲突
  for (const key of ['private:10002', 'group:29999']) {
    assert.equal(ledger.isExhausted(key), true, `${key} 不该获得主动生活流配额`)
    assert.equal(ledger.quotaOf(key).tier, 'none')
    assert.equal(ledger.quotaOf(key).allocated, true, '已分配过（只是分到 0）')
  }
})

test('② 未经 allocate 的非白名单会话：未分配 → 放行（不误熔断）', () => {
  // 重启后第一天，非白名单会话也会先被 fail-open 放行；这是缺陷 C 的取舍：
  // 「暂时不知道有没有配额」时宁可先放，等分配完成后再按真实配额熔断。
  const ledger = createTokenLedger({ today: DAY })
  assert.equal(ledger.isExhausted('private:10002'), false)
})

test('③ 真耗尽：分配过且用完了，仍然熔断', () => {
  const ledger = createTokenLedger({ today: DAY })
  ledger.allocate([owner], undefined, { dateKey: DAY })
  ledger.record('private:10001', 30_000)
  assert.equal(ledger.remaining('private:10001'), 0)
  assert.equal(ledger.isExhausted('private:10001'), true, '用完就该熔断')
  assert.equal(ledger.quotaOf('private:10001').exhausted, true)
})

test('③ 跨日：换天后未分配 → 又回到 fail-open（新的一天重新开始）', () => {
  const ledger = createTokenLedger({ today: DAY })
  ledger.allocate([owner], undefined, { dateKey: DAY })
  ledger.record('private:10001', 30_000)
  assert.equal(ledger.isExhausted('private:10001'), true)
  // 只读查询带新日期：这一天还没分配过 → 放行
  assert.equal(ledger.isExhausted('private:10001', { dateKey: '2026-11-15' }), false)
  // 真正翻页后再分配，恢复配额
  ledger.resetDaily('2026-11-15')
  assert.equal(ledger.hasAllocation('2026-11-15'), false, 'resetDaily 只清用量，不算分配过')
  ledger.allocate([owner], undefined, { dateKey: '2026-11-15' })
  assert.equal(ledger.isExhausted('private:10001'), false)
  assert.equal(ledger.remaining('private:10001'), 30_000)
})

test('非法 chatKey 仍然抛 TypeError（fail-closed 不被 fail-open 破坏）', () => {
  const ledger = createTokenLedger({ today: DAY })
  for (const bad of ['10001', '', 'private:abc', null, undefined]) {
    assert.throws(() => ledger.isExhausted(bad), TypeError)
  }
})

// ---------------- 落盘恢复（跨重启不误熔断） ----------------
test('restore：同一天快照能恢复分配与用量，重启后不误熔断', () => {
  const first = createTokenLedger({ today: DAY })
  first.allocate([owner, group], undefined, { dateKey: DAY })
  first.record('private:10001', 12_000)
  const snap = first.snapshot()

  // 模拟重启：新实例（内存全空）
  const revived = createTokenLedger({ today: DAY })
  assert.equal(revived.isExhausted('private:10001'), false, '重启瞬间（恢复前）也是放行的')
  assert.equal(revived.restore(snap), true)
  assert.equal(revived.remaining('private:10001'), 18_000, '用量要接上，不能清零')
  assert.equal(revived.isExhausted('private:10001'), false)
  assert.equal(revived.quotaOf('private:10001').allocated, true)
})

test('restore：恢复出「已耗尽」时仍然熔断（用量没有被重置掉）', () => {
  const first = createTokenLedger({ today: DAY })
  first.allocate([owner], undefined, { dateKey: DAY })
  first.record('private:10001', 30_000)
  const revived = createTokenLedger({ today: DAY })
  assert.equal(revived.restore(first.snapshot()), true)
  assert.equal(revived.isExhausted('private:10001'), true, '昨天的用量恢复后应当继续熔断')
})

test('restore：拒绝跨日快照（昨天的用量绝不能算进今天）', () => {
  const first = createTokenLedger({ today: '2026-11-13' })
  first.allocate([owner], undefined, { dateKey: '2026-11-13' })
  first.record('private:10001', 30_000)

  const today = createTokenLedger({ today: DAY })
  assert.equal(today.restore(first.snapshot()), false, '跨日快照必须拒收')
  assert.equal(today.hasAllocation(DAY), false)
  assert.equal(today.isExhausted('private:10001'), false, '拒收后回到 fail-open，而不是沿用昨天的耗尽状态')
})

test('restore：结构非法一律拒收，不写坏账', () => {
  const ledger = createTokenLedger({ today: DAY })
  for (const bad of [null, undefined, 42, 'x', [], {}, { dateKey: 'not-a-day' },
    { dateKey: DAY, allocations: { 'private:10001': -1 }, usage: {} },
    { dateKey: DAY, allocations: { 'private:10001': 1.5 }, usage: {} },
    { dateKey: DAY, allocations: { 'private:10001': 'many' }, usage: {} },
    { dateKey: DAY, allocations: [], usage: {} }]) {
    assert.equal(ledger.restore(bad), false, `应拒收：${JSON.stringify(bad)}`)
    assert.equal(ledger.isExhausted('private:10001'), false, '拒收后账本仍是空的（fail-open）')
  }
})

// ---------------- token-billing 接线：启动即分配（缺陷 C 第 2 点） ----------------
// 单独一个文件放模块接线更清楚，但这里复用 token-ledger 的隔离实例开销太小、
// 且要验证的正是「账本语义 + 模块 setup」这条链路，放一起读起来更完整。
import tokenBilling from '../src/modules/token-billing/index.js'
import { defaultLedger, tokenLedgerResetDaily } from '../src/chat/token-ledger.js'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 最小 api：把 dataDir 指到临时目录，方便验证落盘/恢复。 */
function billingApi(t, { ownerQQ = '1000', groups = [], dir } = {}) {
  const dataDir = dir || mkdtempSync(join(tmpdir(), 'token-billing-'))
  if (!dir) t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const handlers = new Map()
  const timers = []
  const offs = []
  const cfg = { enabled: true, ownerQQ, allow: { groups } }
  const api = {
    config: () => cfg,
    log: { info() {}, warn() {} },
    on: (ev, fn) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(fn) },
    onDispose: (fn) => offs.push(fn),
    every: (ms, fn) => timers.push({ ms, fn }),
    route: () => {},
    dataDir: (...p) => (p.length ? join(dataDir, ...p) : dataDir),
    core: { hub: {}, mutes: { muted: () => false } },
    emit(ev, payload) { for (const fn of (handlers.get(ev) || [])) fn(payload) },
    runTimers() { for (const t of timers) t.fn() },
    dispose() { for (const fn of offs) fn() },
    dataDirPath: dataDir,
  }
  return api
}

test('缺陷 C：token-billing 在 setup 时就分配配额（不必等第一条 usage）', (t) => {
  tokenLedgerResetDaily('1999-01-01')
  const api = billingApi(t, { ownerQQ: '1000', groups: ['20001'] })
  tokenBilling.setup(api)
  // 关键：一帧 usage 都没有，配额也已经就绪
  assert.equal(defaultLedger.isExhausted('private:1000'), false, 'setup 后主人私聊不该是熔断态')
  assert.equal(defaultLedger.hasAllocation(String(defaultLedger.snapshot().dateKey)), true, 'setup 后应当已完成分配')
  assert.ok(defaultLedger.remaining('private:1000') > 0, 'setup 后就该有可用额度')
  assert.ok(defaultLedger.remaining('group:20001') > 0, '白名单群也该分到')
})

test('缺陷 C：未在配额体系的会话，setup 后仍然不放行（不因 fail-open 破例）', (t) => {
  tokenLedgerResetDaily('1999-01-01')
  const api = billingApi(t, { ownerQQ: '1000', groups: ['20001'] })
  tokenBilling.setup(api)
  assert.equal(defaultLedger.isExhausted('private:1999'), true, '陌生人私聊不该获得主动生活流配额')
  assert.equal(defaultLedger.isExhausted('group:29999'), true, '未授权群同样')
})

test('缺陷 C：用量落盘后重启能恢复（节流写入 + setup 时读回）', (t) => {
  tokenLedgerResetDaily('1999-01-01')
  const dir = mkdtempSync(join(tmpdir(), 'token-billing-persist-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  // 第一次启动：记一笔账，然后走 dispose（退出前强制落盘）
  const first = billingApi(t, { ownerQQ: '1000', dir })
  tokenBilling.setup(first)
  first.emit('session/usage', { chatId: 'private:1000', usage: { uncachedInputTokens: 5_000 } })
  const before = defaultLedger.remaining('private:1000')
  assert.equal(before, 25_000)
  first.dispose() // 触发 onDispose → flush(true)

  const raw = JSON.parse(readFileSync(join(dir, 'token-usage.json'), 'utf8'))
  assert.equal(raw.usage['private:1000'], 5_000, '用量应已落盘')

  // 模拟重启：账本退回空，再用同一个数据目录 setup
  tokenLedgerResetDaily(String(defaultLedger.snapshot().dateKey))
  assert.equal(defaultLedger.isExhausted('private:1000'), false)
  const second = billingApi(t, { ownerQQ: '1000', dir })
  tokenBilling.setup(second)
  assert.equal(defaultLedger.remaining('private:1000'), 25_000, '重启后应恢复已用 5,000')
})

test('缺陷 C：落盘文件里的跨日快照会被拒收（重启当天不清零也不能少额度）', (t) => {
  tokenLedgerResetDaily('1999-01-01')
  const dir = mkdtempSync(join(tmpdir(), 'token-billing-stale-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // 写一份昨天用满的快照
  writeFileSync(join(dir, 'token-usage.json'), JSON.stringify({
    dateKey: '1998-12-31',
    budget: 50_000,
    ownerShare: 0.6,
    allocations: { 'private:1000': 30_000 },
    usage: { 'private:1000': 30_000 },
  }))
  const api = billingApi(t, { ownerQQ: '1000', dir })
  tokenBilling.setup(api)
  // 跨日快照被拒 → 重新按今天分配 → 额度是满的，没有被昨天的用量拖累
  assert.equal(defaultLedger.remaining('private:1000'), 30_000, '不应沿用昨天的满额用量')
  assert.equal(defaultLedger.isExhausted('private:1000'), false)
})

test('缺陷 C：每分钟巡检会重新分配（跨日立刻生效）', (t) => {
  tokenLedgerResetDaily('1999-01-01')
  const api = billingApi(t, { ownerQQ: '1000' })
  tokenBilling.setup(api)
  assert.equal(defaultLedger.hasAllocation('1999-01-01'), true)
  // 翻页到另一天：巡检时应当重新分配，而不是沿用旧日状态
  tokenLedgerResetDaily('1999-01-02')
  assert.equal(defaultLedger.hasAllocation('1999-01-02'), false)
  api.runTimers()
  assert.equal(defaultLedger.hasAllocation('1999-01-02'), true, '巡检应完成当日分配')
  assert.equal(defaultLedger.isExhausted('private:1000'), false)
})
