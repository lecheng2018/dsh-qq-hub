// US-019 · 线索生产者接线（S1 规则层 + S2 慢思考 → 挂起线索账本）
//
// 这个文件守的是「账本为什么一直空」这件事的**接线**：
//   ① 提示词里真的教了 <inner> 的四行独白契约（不教 = 模型永不产出，账本永远空）；
//   ② 每轮投递之后 S1/S2 的产出真的进了账本（peek 读得到）；
//   ③ 新线索不会被同一轮的 advance() 提前推成 extended（接线位置的核心不变式）；
//   ④ 下一轮写【顺承前情】能 resolve，不写只 advance；
//   ⑤ 账本容量满时只记日志，回复照发、进程不崩；
//   ⑥ TTL 到期会 prune 成 dormant 并走 onDormant → memory addEvent({kind:'thread-dormant'})。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createThreadLedger, ThreadLedgerCapacityError } from '../src/chat/thread-ledger.js'
import { createThreadObserver } from '../src/chat/thread-wiring.js'
import { rulesText, rulesLayers } from '../src/persona/personas.js'
import { normalize } from '../src/core/config.js'

const KEY = 'private:1000'
const quietLog = { info() {}, warn() {}, debug() {}, error() {} }

/** 真账本 + 归档钩子（用数组接 onDormant，模拟 memory.addEvent）。 */
function ledgerWithArchive({ maxThreads } = {}) {
  const archived = []
  const ledger = createThreadLedger({
    ...(maxThreads ? { maxThreads } : {}),
    onDormant: (payload) => { archived.push(payload); return { ok: true } },
  })
  return { ledger, archived }
}

/** 观察者工厂；judge 默认返回空（只测 S1），要测 S2 就显式注入。 */
function observerOf({ ledger, judge, cfg = { threads: { enabled: true } }, now } = {}) {
  return createThreadObserver({
    dsh: {}, getConfig: () => cfg, ledger, log: quietLog,
    ...(judge ? { judge } : {}),
    ...(now ? { now } : {}),
    pruneIntervalMs: 0, // 每轮都裁剪，测试里不用等节流窗口
  })
}

// ---------- ① 提示词契约 ----------

test('L0 协议层教了 <inner> 四行独白契约（不教模型就永不产出）', () => {
  for (const kind of ['private', 'social']) {
    const rules = rulesText(kind, normalize({ ownerQQ: '1' }))
    assert.match(rules, /<inner>…<\/inner>/, '要明确写出标签形态')
    assert.match(rules, /【意图】/, '要有【意图】')
    assert.match(rules, /【闭环】/, '要有【闭环】')
    assert.match(rules, /【情感】/, '要有【情感】')
    assert.match(rules, /【备忘】/, '要有【备忘】')
    assert.match(rules, /【顺承前情】/, '要有可选的第五行【顺承前情】')
    assert.match(rules, /100% 剥离|100%剥离/, '要说明用户看不到')
    assert.match(rules, /可以明确收线时写 close/, '【闭环】只有在能收线时才写 close')
    // 【闭环】的默认值是「留空」：continue 在 inner-thread-link 里是 no-close 硬红线（全场刹车），
    // 教模型「一律写 continue」会让每一轮都刹住，线索永不闭环也永不沉淀。
    assert.match(rules, /平时空着不写/, '平时的默认值是留空，不是 continue')
    assert.doesNotMatch(rules, /一律写 continue/, '不许再教「一律写 continue」（那会让整条链路空转）')
    assert.match(rules, /正文写在/, '正文写在 <inner> 之外')
    assert.match(rules, /正文里不要出现 <inner>/, '正文不许出现 <inner> 字样')
  }
})

test('<inner> 契约在 L0 协议层里（不是 L1/L2/L3），且排在协议层末尾', () => {
  const layers = rulesLayers('private', normalize({ ownerQQ: '1' }))
  const protocol = layers.protocol.join('\n')
  assert.match(protocol, /【心里先过一遍：<inner> 独白】/, '应在 protocol 层')
  for (const other of ['cognitive', 'safety', 'relationship']) {
    assert.doesNotMatch(layers[other].join('\n'), /【备忘】/, `${other} 层不该有独白契约`)
  }
  const tail = layers.protocol.slice(-8).join('\n')
  assert.match(tail, /【顺承前情】|【备忘】/, '契约应该补在协议层末尾附近')
})

// ---------- ② 生产者写进账本 ----------

test('一轮「我去洗个澡」→ 账本里真的多出一条 temporary_leave', async () => {
  const { ledger } = ledgerWithArchive()
  const observer = observerOf({ ledger, now: () => 1_000_000 })
  const stat = await observer.recordTurn({ chatKey: KEY, userText: '我先去洗个澡，等我一下', replyText: '去吧去吧' })
  assert.equal(stat.pushed, 1, JSON.stringify(stat))
  const hit = ledger.peek(KEY, { now: 1_000_000 })
  assert.ok(hit, 'peek 应该读到刚写进去的线索')
  assert.equal(hit.type, 'temporary_leave')
  assert.equal(hit.status, 'active', '新线索必须还是 active（不能被同一轮推进）')
  assert.equal(hit.ttlMs, 2 * 3600_000)
})

test('新线索不会被同一轮的 advance 推成 extended（接线顺序的核心不变式）', async () => {
  const { ledger } = ledgerWithArchive()
  const observer = observerOf({ ledger, now: () => 1_000_000 })
  await observer.recordTurn({ chatKey: KEY, userText: '我去吃饭了', replyText: '好' })
  // 模拟这一轮的 advance（reply-delivery 里先跑）：如果生产者错接在前面，这里会把它推成 extended
  const before = ledger.peek(KEY, { now: 1_000_000 })
  assert.equal(before.status, 'active')
  const advanced = ledger.advance(KEY, { didContinue: false, now: 1_000_000 })
  assert.equal(advanced.extended.length, 1, 'advance 之后才轮到它变 extended')
  assert.equal(ledger.peek(KEY, { now: 1_000_000 }), null, '默认 peek 只看 active')
})

test('S2 的产出也入账，且与 S1 重复时不写两条', async () => {
  const { ledger } = ledgerWithArchive()
  const judge = async () => [
    { type: 'promise', summary: '明天把链接发我' }, // 与 S1 重复
    { type: 'topic_postponed', summary: '说到一半被打断' }, // S1 认不出（这条原文里的确没写）
  ]
  const observer = observerOf({ ledger, judge, now: () => 1_000_000 })
  const stat = await observer.recordTurn({
    chatKey: KEY, userText: '明天把链接发你', replyText: '好', recentText: '甲：明天把链接发你',
  })
  assert.equal(stat.produced, 2, JSON.stringify(stat))
  assert.equal(stat.pushed, 2)
  const rows = ledger.list({ chatKey: KEY })
  assert.deepEqual(rows.map((r) => r.type).sort(), ['promise', 'topic_postponed'])
})

test('S2 报错不影响 S1 入账（fail-open 到底）', async () => {
  const { ledger } = ledgerWithArchive()
  const judge = async () => { throw new Error('判定层炸了') }
  const observer = observerOf({ ledger, judge, now: () => 1_000_000 })
  const stat = await observer.recordTurn({ chatKey: KEY, userText: '我去洗澡了', replyText: '好' })
  assert.equal(stat.pushed, 1)
  assert.ok(ledger.peek(KEY, { now: 1_000_000 }), 'S1 的线索照样入账')
})

test('配置关掉 judge 时只剩 S1（每轮不多一次模型调用）', async () => {
  const { ledger } = ledgerWithArchive()
  let called = 0
  const judge = async () => { called += 1; return [] }
  const observer = observerOf({ ledger, judge, cfg: { threads: { enabled: true, judge: false } }, now: () => 1_000_000 })
  await observer.recordTurn({ chatKey: KEY, userText: '我去洗澡了' })
  assert.equal(called, 0, 'judge:false 时不许调模型')
  assert.ok(ledger.peek(KEY, { now: 1_000_000 }), 'S1 仍然工作')
})

test('群聊默认不跑 S2（每条群消息一次模型调用成本压不住），私聊跑', async () => {
  const { ledger } = ledgerWithArchive()
  const keys = []
  const judge = async ({ chatKey }) => { keys.push(chatKey); return [] }
  const observer = observerOf({ ledger, judge, now: () => 1_000_000 })
  await observer.recordTurn({ chatKey: 'group:777', userText: '我去洗澡了' })
  await observer.recordTurn({ chatKey: KEY, userText: '我去洗澡了' })
  assert.deepEqual(keys, [KEY], JSON.stringify(keys))
})

test('<inner> 的【备忘】是 S1 的第二数据源', async () => {
  const { ledger } = ledgerWithArchive()
  const observer = observerOf({ ledger, now: () => 1_000_000 })
  await observer.recordTurn({
    chatKey: KEY,
    userText: '嗯',
    replyRaw: '<inner>【意图】接话\n【闭环】continue\n【情感】平静\n【备忘】他说明天把链接发我\n</inner>嗯嗯',
  })
  const rows = ledger.list({ chatKey: KEY })
  assert.equal(rows.length, 1, JSON.stringify(rows))
  assert.equal(rows[0].type, 'promise')
})

// ---------- ③ 端到端：写入 → peek → 顺承闭环 / 只推进 ----------

test('端到端：写入 → peek 读得到 → 给【顺承前情】能 resolve', async () => {
  const { ledger } = ledgerWithArchive()
  const now = 1_000_000
  const observer = observerOf({ ledger, now: () => now })
  await observer.recordTurn({ chatKey: KEY, userText: '我先去洗个澡', replyText: '去吧' })
  const hit = ledger.peek(KEY, { now })
  assert.ok(hit, 'peek 应能读到挂起线索')

  // 下一轮她写了【顺承前情】洗澡：resolve 由 reply-delivery 的 applyThreadContinuation 负责
  const { adaptThreadLedger, applyThreadContinuation } = await import('../src/chat/inner-thread-link.js')
  const applied = applyThreadContinuation(adaptThreadLedger(ledger), KEY,
    // 【顺承前情】必须是账本摘要里的**连续片段**（keywordHits 用 key.includes(marker)）：
  // 摘要存的是原话「我先去洗个澡」，所以抄「洗个澡」能命中，概括成「洗澡」就静默闭不上环。
  '<inner>【意图】他回来了\n【闭环】close\n【情感】轻松\n【备忘】\n【顺承前情】洗个澡\n</inner>')
  assert.deepEqual(applied.resolved, [hit.id], JSON.stringify(applied))
  assert.equal(ledger.get(hit.id).status, 'resolved')
})

test('端到端：没有【顺承前情】时只 advance，绝不误闭环', async () => {
  const { ledger } = ledgerWithArchive()
  const now = 1_000_000
  const observer = observerOf({ ledger, now: () => now })
  await observer.recordTurn({ chatKey: KEY, userText: '我先去洗个澡', replyText: '去吧' })
  const hit = ledger.peek(KEY, { now })
  const { adaptThreadLedger, applyThreadContinuation } = await import('../src/chat/inner-thread-link.js')
  // 普通的「没接上」轮次：【闭环】留空（不是 continue），否则会触发全场刹车、连拓扑都不推
  const applied = applyThreadContinuation(adaptThreadLedger(ledger), KEY,
    '<inner>【意图】换个话题\n【闭环】\n【情感】平静\n【备忘】\n</inner>今天天气不错')
  assert.deepEqual(applied.resolved, [], '没有标记绝不能闭环')
  assert.equal(ledger.get(hit.id).status, 'extended', '只推进一格')
})

test('回归钉：【闭环】continue 是全场刹车，提示词绝不能教它当默认值', async () => {
  // 这是 US-019 第二轮的隐性空转点：若提示词让模型每轮写【闭环】continue，
  // parseInnerClosure 会判 blocked（no-close 硬红线，19 条既有测试锁死），
  // 于是 resolve 与 advance 全被拦住 —— 账本有线索，却永远不闭环、不沉淀。
  const { ledger } = ledgerWithArchive()
  const now = 1_000_000
  const observer = observerOf({ ledger, now: () => now })
  await observer.recordTurn({ chatKey: KEY, userText: '我先去洗个澡' })
  const hit = ledger.peek(KEY, { now })
  const { adaptThreadLedger, applyThreadContinuation } = await import('../src/chat/inner-thread-link.js')
  const blocked = applyThreadContinuation(adaptThreadLedger(ledger), KEY,
    '<inner>【意图】接话\n【闭环】continue\n【情感】平静\n【备忘】\n【顺承前情】洗澡\n</inner>')
  assert.equal(blocked.blocked, true, 'continue 必须仍然拦下（红线不能改）')
  assert.deepEqual(blocked.resolved, [], '被拦下时不许闭环')
  assert.equal(ledger.get(hit.id).status, 'active', '被拦下时连拓扑都不动')

  // 提示词里因此不能出现「一律写 continue」这种教法
  const rules = rulesText('private', normalize({ ownerQQ: '1' }))
  assert.doesNotMatch(rules, /一律写 ?continue/)
})

// ---------- ④ 容量与裁剪 ----------

test('账本容量满时不崩，只记日志（回复照发）', async () => {
  // 容量 1：先塞满一条活线索，再让生产者写第二条
  const { ledger } = ledgerWithArchive({ maxThreads: 1 })
  const warns = []
  const observer = createThreadObserver({
    dsh: {}, getConfig: () => ({ threads: { enabled: true, judge: false } }), ledger,
    log: { info() {}, debug() {}, warn: (m) => warns.push(String(m)) },
    now: () => 1_000_000, pruneIntervalMs: 0,
  })
  ledger.push({ chatKey: KEY, type: 'promise', summary: '活线索占位' }, { now: 1_000_000 })
  const stat = await observer.recordTurn({ chatKey: KEY, userText: '我去洗个澡' })
  assert.equal(stat.failed, 1, JSON.stringify(stat))
  assert.equal(warns.some((m) => m.includes('线索账本已满')), true, JSON.stringify(warns))
  assert.equal(ledger.list({ chatKey: KEY }).length, 1, '活线索不许被物理删除')
  // 直接 push 仍然 fail-closed 抛（账本语义不变）
  assert.throws(() => ledger.push({ chatKey: KEY, type: 'promise', summary: '再来一条' }), ThreadLedgerCapacityError)
})

test('TTL 到期 → pruneExpired 转 dormant 并走 onDormant 归档（thread-dormant 链路真的被走到）', async () => {
  let clock = 1_000_000
  const { ledger, archived } = ledgerWithArchive()
  const observer = observerOf({ ledger, now: () => clock })
  await observer.recordTurn({ chatKey: KEY, userText: '我去洗个澡', replyText: '去吧' })
  assert.equal(archived.length, 0, '还没到期，不该归档')

  // 2 小时零 1 分之后再来一轮：轮末裁剪应当把它推成 dormant 并归档
  clock += 2 * 3600_000 + 60_000
  const stat = await observer.recordTurn({ chatKey: KEY, userText: '在吗', replyText: '在' })
  assert.equal(stat.pruned, 1, JSON.stringify(stat))
  const rows = ledger.list({ chatKey: KEY, status: 'dormant' })
  assert.equal(rows.length, 1, '应转成 dormant')
  assert.equal(rows[0].dormantReason, 'ttl_expired')
  assert.equal(archived.length, 1, 'onDormant 必须被调到')
  assert.equal(archived[0].summary, rows[0].summary)
  assert.equal(archived[0].scope, KEY, '归档作用域跟随原聊天域')
})

test('归档钩子当时抛错：只记日志，线索本身状态照常（pendingArchive 留给 retryArchive 补写）', async () => {
  const ledger = createThreadLedger({
    onDormant: () => { throw new Error('记忆模块没起来') },
  })
  const warns = []
  const observer = createThreadObserver({
    dsh: {}, getConfig: () => ({ threads: { enabled: true, judge: false } }), ledger,
    log: { info() {}, debug() {}, warn: (m) => warns.push(String(m)) },
    now: () => 1_000_000, pruneIntervalMs: 0,
  })
  await observer.recordTurn({ chatKey: KEY, userText: '我去洗个澡' })
  assert.ok(ledger.peek(KEY, { now: 1_000_000 }))
  assert.doesNotThrow(() => ledger.pruneExpired({ now: 1_000_000 + 3 * 3600_000 }))
  const rows = ledger.list({ chatKey: KEY, status: 'dormant' })
  assert.equal(rows[0].pendingArchive, true, '归档失败要留 pending 标记，不许丢摘要')
})

test('总开关关掉时完全不动作（连裁剪都不做）', async () => {
  const { ledger } = ledgerWithArchive()
  const observer = observerOf({ ledger, cfg: { threads: { enabled: false } }, now: () => 1_000_000 })
  const stat = await observer.recordTurn({ chatKey: KEY, userText: '我去洗澡了' })
  assert.deepEqual(stat, { produced: 0, pushed: 0, pruned: 0, failed: 0 })
  assert.equal(ledger.list({ chatKey: KEY }).length, 0)
})

test('非法 chatKey / 空 chatKey 一律不崩（fail-open）', async () => {
  const { ledger } = ledgerWithArchive()
  const observer = observerOf({ ledger, now: () => 1_000_000 })
  for (const chatKey of ['', null, undefined, '1000', 'qq:1000']) {
    const stat = await observer.recordTurn({ chatKey, userText: '我去洗澡了' })
    assert.equal(stat.pushed, 0, String(chatKey))
  }
  assert.equal(ledger.list({}).length, 0)
})

test('flush() 等到观察链收尾（fire-and-forget 有确定终点）', async () => {
  const { ledger } = ledgerWithArchive()
  let settle = null
  const judge = () => new Promise((resolve) => { settle = resolve })
  const observer = observerOf({ ledger, judge, now: () => 1_000_000 })
  observer.recordTurn({ chatKey: KEY, userText: '我去洗澡了' })
  const flushed = observer.flush()
  await Promise.resolve()
  assert.ok(typeof settle === 'function', 'S2 应该已经开跑')
  settle([])
  await flushed
  assert.ok(ledger.peek(KEY, { now: 1_000_000 }), 'flush 之后账本已经写完')
})

test('配置默认值：threads 开着、群里不跑 S2、超时与裁剪间隔有界', () => {
  const cfg = normalize({})
  assert.equal(cfg.threads.enabled, true)
  assert.equal(cfg.threads.judge, true)
  assert.equal(cfg.threads.judgeInGroups, false)
  assert.equal(cfg.threads.judgeTimeoutMs, 15000)
  assert.equal(cfg.threads.pruneIntervalMs, 60000)
  // 越界夹值
  const clamped = normalize({ threads: { judgeTimeoutMs: 9e9, pruneIntervalMs: 1 } })
  assert.equal(clamped.threads.judgeTimeoutMs, 60000)
  assert.equal(clamped.threads.pruneIntervalMs, 5000)
})