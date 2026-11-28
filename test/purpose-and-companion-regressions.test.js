// 回归：purpose 单飞锁、启动崩溃恢复不误伤运行期、安静时段追问拦截、【状态】跳过静默、
// silent 历史不串文案、状态备份恢复、crucible 稳定 id/enrich/节流、maxPerDay 默认 0、
// clock 跨日/跨午夜作息、prompt 清理、companion 传 lastPrivateAt 与跨午夜窗口。
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPurpose, purposeConfig } from '../src/purpose/module.js'
import * as engine from '../src/purpose/engine.js'
import { createCrucible } from '../src/purpose/engine/crucible.js'
import purposeMod from '../src/modules/purpose/index.js'
import { createSpeakUp } from '../src/features/companion.js'

const OWNER = '10000001' /* pii-scan:ignore */
const MIN = 60_000

let dataDir = ''
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'qqhub-purpose-reg-'))
  process.env.DSH_QQ_HUB_DATA_DIR = dataDir
  process.env.AURABOT_DATA_DIR = dataDir
})

const stateFile = () => join(dataDir, 'purpose', 'purpose-state.json')

function baseCfg(overrides = {}) {
  return {
    enabled: true,
    ownerQQ: OWNER,
    ownerName: '主人',
    speakUp: { enabled: false, awakeFrom: 0, awakeTo: 24, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 8, nudge: true },
    ext: { purpose: { enabled: true, initialDelayMinutes: 1, minMaterials: 0 } },
    ...overrides,
  }
}

test('单飞锁：执行中并发 tick 跳过、fire 返回 busy，运行期 status 不误改 pending 为 interrupted', async () => {
  let resolveTurn
  let turnCalls = 0
  const delivered = []
  const hub = {
    lastOwnerChatAt: 0,
    lastBotToOwner: { at: 0, text: '' },
    chatLogDays: () => [],
    chatLogOf: () => [],
    async runSystemTurn() {
      turnCalls++
      return await new Promise((r) => { resolveTurn = r })
    },
    async deliver(chatId, text) {
      delivered.push({ chatId, text })
      return { state: 'sent', delivered: 1 }
    },
  }
  const p = createPurpose({
    getConfig: () => baseCfg(),
    hub,
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false,
    memory: () => ({ listFor: () => [{ id: 'm1', text: '主人周末想爬山', importance: 0.8, at: Date.now() }] }),
    personaText: () => '',
  })

  const first = p.fire('手动1')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(turnCalls, 1)

  // 运行期：status() 不应把在途 pending 误判为 interrupted
  assert.equal(p.status().lastOutcome, 'pending')
  // 并发 fire 返回 busy
  const second = await p.fire('手动2')
  assert.equal(second.outcome, 'busy')
  // 并发 tick 跳过
  await p.tick()
  assert.equal(turnCalls, 1)

  resolveTurn('周末爬山准备好了吗\n\n内部备忘\n【目的】问爬山\n【状态】完成')
  const r1 = await first
  assert.equal(r1.outcome, 'sent')
  assert.equal(delivered.length, 1)
  assert.equal(p.status().lastOutcome, 'sent')
})

test('runOnce：【状态】跳过 即使带有过渡正文也按 silent 处理，绝不投递', async () => {
  const delivered = []
  const hub = {
    lastOwnerChatAt: 0,
    lastBotToOwner: { at: 0, text: '' },
    chatLogDays: () => [],
    chatLogOf: () => [],
    async runSystemTurn() {
      return '算了今天先不打扰主人了\n\n内部备忘\n【目的】无\n【需求】陪\n【类型】关心\n【状态】跳过\n【待续】无'
    },
    async deliver(chatId, text) {
      delivered.push({ chatId, text })
      return { state: 'sent', delivered: 1 }
    },
  }
  const p = createPurpose({
    getConfig: () => baseCfg(),
    hub,
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false,
    memory: () => ({ listFor: () => [{ id: 'm1', text: '主人刚加完班', importance: 0.8, at: Date.now() }] }),
    personaText: () => '',
  })
  const r = await p.fire('手动')
  assert.equal(r.outcome, 'silent')
  assert.equal(r.text, '')
  assert.equal(delivered.length, 0, '【状态】跳过不得把过渡语发给主人')
})

test('history：outcome=silent 写入历史时绝不复制上一条已发的 lastText', () => {
  const now = Date.now()
  const config = engine.normalizePurposeConfig({})
  const st = engine.createPurposeState(now)
  engine.applyPurposeOutcome(st, {
    now, config, outcome: 'sent', text: '上一条真正发出去的话',
    memo: { purpose: '问候', kind: 'share', need: 'share', status: '完成', emotionText: '开心' },
    planned: { text: '问候', kind: 'share', need: 'share', action: 'share', emotion: 'happy' },
  })
  assert.equal(st.lastText, '上一条真正发出去的话')
  assert.equal(st.lastEmotion, '', '有 memo.emotionText 时不再死回落 planned.emotion')
  assert.equal(st.lastEmotionText, '开心')

  engine.applyPurposeOutcome(st, {
    now: now + 60_000, config, outcome: 'silent', text: '',
    memo: { purpose: '无', kind: 'share', need: 'share', status: '跳过', emotionText: '' },
    planned: { text: '本来想聊的', kind: 'share', need: 'share', action: 'share', emotion: 'curious' },
  })
  assert.equal(st.history.length, 2)
  assert.equal(st.history[0].text, '上一条真正发出去的话')
  assert.equal(st.history[1].outcome, 'silent')
  assert.equal(st.history[1].text, '', 'silent 历史条目不得混入上一条发言')
})

test('maybeNudge：安静时段内绝不触发追问', async () => {
  const now = Date.now()
  const h = new Date(now).getHours()
  // 构造一个必然把当前小时包进安静时段的醒着窗口：只醒 [ (h+2)%24, (h+3)%24 )
  const awakeFrom = (h + 2) % 24
  const awakeTo = (h + 3) % 24
  let turnCalls = 0
  const hub = {
    lastOwnerChatAt: now - 30 * MIN,
    lastBotToOwner: { at: now - 20 * MIN, text: '你吃饭了吗？' },
    chatLogDays: () => [],
    chatLogOf: () => [],
    async runSystemTurn() { turnCalls++; return '人呢？' },
    async deliver() { return { state: 'sent', delivered: 1 } },
  }
  const origRand = Math.random
  Math.random = () => 0.1 // 原本必中追问
  try {
    const p = createPurpose({
      getConfig: () => baseCfg({ speakUp: { enabled: false, awakeFrom, awakeTo, idleMinutes: 30, minIntervalMinutes: 5, maxIntervalMinutes: 5, maxPerDay: 8, nudge: true } }),
      hub,
      log: { info() {}, warn() {}, debug() {} },
      isMuted: () => false,
      memory: () => ({ listFor: () => [] }),
      personaText: () => '',
    })
    await p.tick()
    assert.equal(turnCalls, 0, '安静时段内不得发起追问')
  } finally {
    Math.random = origRand
  }
})

test('purpose-state.json 使用备份读写：主文件损坏时自动从 .bak 恢复', async () => {
  const hub = {
    lastOwnerChatAt: 0,
    lastBotToOwner: { at: 0, text: '' },
    chatLogDays: () => [],
    chatLogOf: () => [],
    async runSystemTurn() { return '你好呀' },
    async deliver() { return { state: 'sent', delivered: 1 } },
  }
  const p = createPurpose({
    getConfig: () => baseCfg(),
    hub,
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false,
    memory: () => ({ listFor: () => [{ id: 'm1', text: '主人喜欢喝咖啡', importance: 0.8, at: Date.now() }] }),
    personaText: () => '',
  })
  await p.fire('手动')
  assert.equal(p.state().countToday, 1)

  // 破坏主状态文件，应从 purpose-state.json.bak 恢复
  writeFileSync(stateFile(), '{broken json', 'utf8')
  assert.equal(p.state().countToday, 1, '主文件损坏应从 .bak 恢复今日计数')
})

test('crucible：补齐稳定 id + enrichMaterial，goals subjectOf 不回落 media，且 crucibleCycle 按间隔节流', async () => {
  const now = Date.now()
  const c = createCrucible([
    { source: 'group', title: '露营装备选购指南', summary: '轻量化帐篷推荐', fingerprint: 'fp-camp-1', capturedAt: now, tags: ['露营'] },
  ])
  let chatLogReads = 0
  const hub = {
    lastOwnerChatAt: 0,
    lastBotToOwner: { at: 0, text: '' },
    chatLogDays: () => { chatLogReads++; return [] },
    chatLogOf: () => [],
  }
  const p = createPurpose({
    getConfig: () => baseCfg({ ext: { purpose: { enabled: true, interests: ['露营'], minMaterials: 0 } } }),
    hub,
    crucible: c,
    crucibleIntervalMs: 15 * MIN,
    log: { info() {}, warn() {}, debug() {} },
    memory: () => ({ listFor: () => [] }),
    personaText: () => '',
  })

  // 连续两次 tick：第二次在 15 分钟节流窗口内，不应重复扫 chatLog
  await p.tick()
  const readsAfterFirst = chatLogReads
  assert.equal(readsAfterFirst, 1)
  await p.tick()
  assert.equal(chatLogReads, readsAfterFirst, '节流间隔内不应每 60s 重跑 crucibleCycle')

  // preview 中熔炉素材应有稳定 id 与 enrich 字段；goals 不回落 media
  const enriched = engine.enrichMaterial({
    id: 'crucible:fp-camp-1',
    source: 'group',
    kind: 'crucible',
    fingerprint: 'fp-camp-1',
    text: '露营装备选购指南',
    at: now,
  })
  assert.ok(enriched.needAffinity)
  assert.ok(enriched.topic)
  const { goals } = engine.formGoalHypotheses({
    materials: [enriched],
    goals: [], observations: [], now, lastMasterAt: now - 3600_000,
    roleName: '小助手', persona: { hasText: false, traits: [], text: '', bias: {} },
  })
  assert.ok(goals.every((g) => g.owner !== 'media'), `crucible(group) 目标不应回落 media：${JSON.stringify(goals.map((g) => g.owner))}`)
})

test('maxPerDay 双源冲突修复：模块默认 maxPerDay=0，沿用 speakUp.maxPerDay', () => {
  assert.equal(purposeMod.defaults.maxPerDay, 0)
  const c = purposeConfig({
    enabled: true,
    ownerQQ: OWNER,
    speakUp: { maxPerDay: 6 },
    ext: { purpose: { ...purposeMod.defaults, enabled: true } },
  })
  assert.equal(c.dailyMax, 6)
})

test('clock.js nextDayStartAfter 严格跨自然日 + 跨午夜作息（awakeFrom > awakeTo）', () => {
  const early = new Date(2026, 4, 10, 2, 0, 0).getTime()
  const next = engine.nextDayStartAfter(early, { quietStart: '23:00', quietEnd: '08:00' })
  assert.equal(engine.localDateKey(next), '2026-05-11', '02:00 调 nextDayStartAfter 必须推到次日 08:00，不能落回当天 08:00')
  assert.equal(new Date(next).getHours(), 8)

  // 跨午夜作息：20:00 ~ 04:00 醒着 → 安静时段 04:00 ~ 20:00
  const owlCfg = purposeConfig({
    enabled: true, ownerQQ: OWNER,
    speakUp: { awakeFrom: 20, awakeTo: 4 },
    ext: { purpose: { enabled: true } },
  })
  assert.equal(owlCfg.quietStart, '04:00')
  assert.equal(owlCfg.quietEnd, '20:00')
  assert.equal(engine.inQuietHours(new Date(2026, 4, 10, 12, 0).getTime(), owlCfg), true)
  assert.equal(engine.inQuietHours(new Date(2026, 4, 10, 22, 0).getTime(), owlCfg), false)
  assert.equal(engine.inQuietHours(new Date(2026, 4, 11, 2, 0).getTime(), owlCfg), false)
})

test('prompt.js 清理：不含错字 🧀，也不再输出 reserved2 发送工具指令', () => {
  const prompt = engine.buildPurposePrompt({ mode: 'reserved2', ownerName: '主人' })
  assert.equal(prompt.includes('🧀'), false)
  assert.equal(prompt.includes('qq_send_private_message'), false)
})

test('companion.js：tick 传入 lastPrivateAt 避免刚聊完还发早晚安，且支持跨午夜醒着窗口', async () => {
  const now = Date.now()
  const d = new Date(now)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  // 构造跨午夜窗口 [ (h+22)%24, (h+2)%24 ) 保证当且仅当跨午夜且包含当前小时
  const awakeFrom = (d.getHours() + 22) % 24
  const awakeTo = (d.getHours() + 2) % 24
  let fired = 0
  const hub = {
    lastOwnerChatAt: now - 2 * MIN, // 2 分钟前刚聊过
    lastBotToOwner: { at: 0, text: '' },
    async runPromptTurn() { fired++; return '早呀' },
    async deliver() { return { state: 'sent', delivered: 1 } },
  }
  const sp = createSpeakUp({
    getConfig: () => ({
      enabled: true, ownerQQ: OWNER, ownerName: '主人',
      speakUp: {
        enabled: true, awakeFrom, awakeTo, idleMinutes: 60,
        minIntervalMinutes: 60, maxIntervalMinutes: 60, maxPerDay: 3, nudge: false,
        greeting: { enabled: true, morning: `${hh}:${mm}`, night: '23:59' },
      },
    }),
    hub,
    log: { info() {}, warn() {}, debug() {} },
    isMuted: () => false,
  })
  await sp.tick()
  assert.equal(fired, 0, '主人 2 分钟前刚说过话，tick 应把 lastPrivateAt 传给 greetingDue 而不重复问候')

  // 把最近私聊时间拉回 2 小时前：跨午夜窗口内到点应发问候
  hub.lastOwnerChatAt = now - 120 * MIN
  await sp.tick()
  assert.equal(fired, 1, '跨午夜醒着窗口内且超过 10 分钟未说话，应正常发出问候')
})
