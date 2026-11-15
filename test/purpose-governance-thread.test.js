// 回归（目的治理与线索持久化）：
// ① purpose 手动 fire 受配额熔断 / 道别静默期约束（不再绕过治理）
// ② tick 配额耗尽时不追问也不开口（nudge 排在熔断判定之后）
// ③ 熔炉素材挂 scope（私聊素材不再变 global，隐私单向流动）
// ④ 线索账本快照语义（只存活线索、恢复重推）+ host 接线锁
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = '10000001'
const MIN = 60_000
let createPurpose
let createThreadLedger

before(async () => {
  ;({ createPurpose } = await import('../src/purpose/module.js'))
  ;({ createThreadLedger } = await import('../src/chat/thread-ledger.js'))
})

beforeEach(() => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'purpose-gov-'))
})

function stateFile() { return join(process.env.AURABOT_DATA_DIR, 'purpose', 'purpose-state.json') }

const DEFAULT_MEMORIES = [
  { id: 'mm1', text: '主人上周在玩星穹列车', importance: 0.6 },
  { id: 'mm2', text: '主人喜欢下班后打两把游戏放松', importance: 0.5 },
]

function makeHub({ reply = '主人，今天想到一件事想跟你说' } = {}) {
  return {
    lastOwnerChatAt: 0,
    lastBotToOwner: { at: 0, text: '' },
    chatLogDays: () => [],
    chatLogOf: () => [],
    delivered: [],
    turns: [],
    async runSystemTurn(name, title, prompt) { this.turns.push({ name, title, prompt }); return typeof reply === 'function' ? reply(prompt) : reply },
    async deliver(chatId, text) { this.delivered.push({ chatId, text }); return { missedAt: [] } },
  }
}

/** 同 purpose.test 的夹具，额外注入治理依赖（budgetExhausted / proactivelyMuted / crucible）。 */
function makePurpose(hub, { budgetExhausted, proactivelyMuted, crucible } = {}) {
  const cfg = {
    enabled: true, ownerQQ: OWNER, ownerName: '主人',
    speakUp: { enabled: false, awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 10, nudge: true },
    ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
  }
  const p = createPurpose({
    getConfig: () => cfg,
    hub,
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false,
    memory: () => {
      const items = DEFAULT_MEMORIES.map((m) => ({ id: m.id, text: m.text, importance: m.importance, at: Date.now() }))
      return { list: () => items, listFor: () => items, recall: () => items.map((it) => ({ it, score: 1, why: [] })) }
    },
    personaText: () => '',
    budgetExhausted,
    proactivelyMuted,
    crucible,
  })
  return { p, cfg }
}

function dueNow() {
  const s = JSON.parse(readFileSync(stateFile(), 'utf8'))
  s.nextFireAt = Date.now() - 1
  writeFileSync(stateFile(), JSON.stringify(s))
}

// ---- ① 手动 fire 的治理闸门 ----
test('目的：手动 fire 受配额熔断约束，不再绕过', async () => {
  const hub = makeHub()
  const { p } = makePurpose(hub, { budgetExhausted: () => true })
  const r = await p.fire('面板')
  assert.equal(r.outcome, 'budget', '配额耗尽应返回 budget（旧版照跑）')
  assert.equal(hub.delivered.length, 0)
  assert.equal(hub.turns.length, 0)
})

test('目的：手动 fire 受道别静默期约束', async () => {
  const hub = makeHub()
  const { p } = makePurpose(hub, { proactivelyMuted: () => true })
  const r = await p.fire('面板')
  assert.equal(r.outcome, 'muted')
  assert.equal(hub.delivered.length, 0)
})

test('目的：未熔断时手动 fire 照常可跑', async () => {
  const hub = makeHub()
  const { p } = makePurpose(hub, { budgetExhausted: () => false, proactivelyMuted: () => false })
  const r = await p.fire('面板')
  assert.ok(['sent', 'silent'].includes(r.outcome), `未熔断应正常跑（实际 ${r.outcome}）`)
})

// ---- ② tick 配额耗尽不追问不开口 ----
test('目的：配额耗尽时 tick 不追问也不主动开口', async () => {
  const hub = makeHub()
  const { p } = makePurpose(hub, { budgetExhausted: () => true })
  await p.tick() // 首次排程
  dueNow()
  await p.tick() // 到点：熔断 → 不追问（nudge）、不开口（runOnce）
  assert.equal(hub.turns.length, 0, '配额耗尽不应有任何模型调用（含追问）')
  assert.equal(hub.delivered.length, 0)
})

// ---- ③ 熔炉 scope ----
test('熔炉：私聊/记忆素材挂主人私聊 scope，不再落成 global', async () => {
  const hub = makeHub()
  const ingested = []
  const fakeCrucible = {
    entries: () => [],
    ingest: (items) => { ingested.push(...items); return { pool: [], added: items, evicted: [], refreshed: [] } },
    prune: () => ({ pool: [], removed: [] }),
    match: () => [],
  }
  const { p } = makePurpose(hub, { crucible: fakeCrucible })
  await p.tick()
  assert.ok(ingested.length > 0, '应有素材进熔炉')
  for (const e of ingested) {
    assert.equal(e.scope, `private:${OWNER}`, `素材应挂主人私聊 scope（实际 ${e.scope || '（无）'}）：${e.title?.slice(0, 20)}`)
  }
})

// ---- ④ 线索快照 ----
test('线索账本：快照只取活线索，恢复重推后可 peek', () => {
  const a = createThreadLedger({})
  a.push({ chatKey: 'private:10001', type: 'promise', summary: '约定明天分享新歌' })
  a.push({ chatKey: 'private:10001', type: 'temporary_leave', summary: '去洗澡了稍后回来' })
  const doneId = a.push({ chatKey: 'group:555', type: 'topic_postponed', summary: '话题被打断' }).id
  a.resolve(doneId)
  const snapshot = a.list({ status: ['active', 'extended'] })
  assert.equal(snapshot.length, 2, '快照只含活线索（resolved 不入）')

  const b = createThreadLedger({})
  for (const t of snapshot) {
    b.push({ chatKey: t.chatKey, type: t.type, summary: t.summary, ttlMs: t.ttlMs, createdAt: t.createdAt, id: t.id })
  }
  // peek 返回该聊天最近**一条**未闭环线索（单条或 null），不是数组
  const hit = b.peek('private:10001')
  assert.ok(hit, '恢复后可 peek')
  assert.ok(['新歌', '洗澡'].some((w) => String(hit.summary).includes(w)), '恢复的线索内容保真')
})

test('线索接线：host 挂快照落盘、变更防抖、启动恢复', () => {
  const src = readFileSync(new URL('../src/host.js', import.meta.url), 'utf8')
  assert.match(src, /threadLedger\.list\(\{ status: \['active', 'extended'\] \}\)/, '快照只存活线索')
  assert.match(src, /\['push', 'advance', 'resolve', 'pruneExpired'\]/, '变更点挂防抖落盘')
  assert.match(src, /saveThreads\(\)/, 'dispose 收尾落盘')
  assert.match(src, /readJson\(threadFile\(\), null\)/, '启动恢复读快照')
})