// 回归（目的治理）：
// ① purpose 手动 fire 受配额熔断 / 道别静默期约束（不再绕过治理）
// ② tick 配额耗尽时不追问也不开口（nudge 排在熔断判定之后）
// ③ 熔炉素材挂 scope（私聊素材不再变 global，隐私单向流动）
import { test, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = '10000001'
let createPurpose

before(async () => {
  ;({ createPurpose } = await import('../src/purpose/module.js'))
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