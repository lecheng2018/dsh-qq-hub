// 群聊 engaged 并发竞争 & 单槽 pendingMode 退化回落 must 的回归测试（2026-11-25 真机刷屏事故）。
//
// 事故复盘：
//   1. 旧版 pendingMode 是按 chatKey 存的单槽 Map，前轮执行时 delete 后，紧跟排队的后轮拿不到值，
//      兜底成 mode='must' → 提示词变成「有人在叫你」且发完后走 noteSpokeInGroup 重置 engaged 3 分钟，
//      连聊上限和 [沉默] 退场都被直接架空。
//   2. noteEngagedReply 要等发完后才加计数，模型思考期间新消息看到的 engagedReplies 仍是旧值，
//      瞬间把多个 engaged 回合塞进队列，超卖 engagedMaxReplies。
//   3. interjectChance <= 5% 仍被 (1 + 4 * rel) 放大最高 5 倍（1% 变成 5%）。
import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decideGroupReply, policyFor } from '../src/chat/group-policy.js'
import { createModularCore } from '../src/host/modular-core.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let dataDir
let previousDataDir
let fixtures

beforeEach(() => {
  previousDataDir = process.env.DSH_QQ_HUB_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'group-engaged-race-'))
  process.env.DSH_QQ_HUB_DATA_DIR = dataDir
  fixtures = []
})

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.DSH_QQ_HUB_DATA_DIR
  else process.env.DSH_QQ_HUB_DATA_DIR = previousDataDir
  for (const f of fixtures || []) {
    await f.core?.dispose?.()
    f.fake?.dispose?.()
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

function groupMsg(mid, text, { uid = '30001', atBot = false, groupId = '777', botQQ = '20000002' } = {}) {
  const message = []
  if (atBot) message.push({ type: 'at', data: { qq: botQQ } })
  message.push({ type: 'text', data: { text } })
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: Number(botQQ),
    group_id: Number(groupId),
    user_id: Number(uid),
    message_id: mid,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: Number(uid), nickname: `群友${uid}` },
    raw_message: text,
    message,
  }
}

function makeFixture({ brain, groupOverrides = {} } = {}) {
  const seenPrompts = []
  const fake = createFakeDsh({
    brain: (msg, ctx) => {
      const promptText = typeof msg === 'string'
        ? msg
        : Array.isArray(msg?.content)
          ? msg.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
          : String(msg?.text || '')
      seenPrompts.push(promptText)
      return brain ? brain(promptText, ctx) : '收到'
    },
  })
  const sent = []
  const onebot = {
    async call(action, params) {
      if (action === 'send_group_msg') sent.push(params)
      return { message_id: sent.length + 1 }
    },
  }
  const cfg = {
    ownerQQ: '10000001',
    botQQ: '20000002',
    workspaceDir: dataDir,
    enabled: true,
    dryRun: false,
    allow: { private: ['10000001'], groups: ['777'] },
    merge: { enabled: true, waitSec: 0.02, maxSec: 0.04, groupWaitSec: 0.02, groupMaxSec: 0.04 },
    security: { identityGuard: { enabled: false } },
    voice: { enabled: false, autoChance: 0 },
    stickers: { enabled: false, faces: false, autoChance: 0 },
    reply: { groupMaxChars: 200, maxBubbles: 4 },
    group: {
      wakeWords: [],
      interjectChance: 0.01,
      minRelevance: 0.1,
      minRecentMessages: 1,
      cooldownSec: 600,
      maxPerHour: 24,
      quietHours: [0, 0],
      interests: ['游戏'],
      engagedMaxReplies: 1,
      engagedMaxMs: 360000,
      burstMax: 20,
      burstWindowSec: 60,
      fishGuard: { enabled: false },
      quota: { enabled: false },
      ...groupOverrides,
    },
  }
  const core = createModularCore({
    dsh: fake.ctx,
    onebot,
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg,
    logger: noopLog,
    log: noopLog,
    stickers: { match: () => null, segmentFor: () => null, pickForReply: () => null },
    tts: { speak: async () => null },
    buildTools: () => [],
  })
  const f = { fake, core, sent, seenPrompts, cfg }
  fixtures.push(f)
  return f
}

test('低概率档（interjectChance <= 5%）不再被相关度放大 5 倍', () => {
  const NOW = 1_800_000_000_000
  const pol = policyFor({ interjectChance: 0.01, minRelevance: 0.1, quietHours: [0, 0] }, {}, '777')
  // 即使相关度高达 1.0，rand=0.015 也必须拦下（旧公式会放大成 0.05 放行）
  const d = decideGroupReply({
    policy: pol,
    text: '游戏',
    now: NOW,
    hour: 13,
    recentTimes: [NOW - 1000, NOW - 800, NOW - 500],
    interjectTimes: [],
    botReplyTimes: [],
    relevance: 1.0,
    rand: () => 0.015,
  })
  assert.equal(d.reply, false, '1% 概率在 rand=0.015 时不该因相关度放大被放行')

  // rand=0.005 仍应正常放行
  const d2 = decideGroupReply({
    policy: pol,
    text: '游戏',
    now: NOW,
    hour: 13,
    recentTimes: [NOW - 1000, NOW - 800, NOW - 500],
    interjectTimes: [],
    botReplyTimes: [],
    relevance: 1.0,
    rand: () => 0.005,
  })
  assert.equal(d2.mode, 'interject')
})

test('在途 engaged 占用立即计入预算：模型思考期间连来多条消息不超卖 engagedMaxReplies', async () => {
  let callIndex = 0
  let releaseSecondTurn = null
  const secondTurnRunning = new Promise((resolve) => {
    const f = makeFixture({
      groupOverrides: { engagedMaxReplies: 1 },
      brain: async () => {
        callIndex += 1
        if (callIndex === 2) {
          resolve()
          await new Promise((r) => { releaseSecondTurn = r })
        }
        return `回复${callIndex}`
      },
    })
    fixtures[fixtures.length - 1] = f
  })
  const f = fixtures[fixtures.length - 1]

  // 第 1 轮：被 @ 必回，发完后进入 engaged 窗口（replies=0）
  await f.core.dispatchLegacyEventSettled(groupMsg(101, '聊聊游戏', { atBot: true }))
  assert.equal(f.sent.length, 1)

  // 第 2 轮：engaged 放行（占用唯一 1 条额度），进入运行并卡在 brain
  const r2 = await f.core.dispatchLegacyEvent(groupMsg(102, '这个游戏真好玩'))
  assert.equal(r2.handled, 'offered')
  await secondTurnRunning

  // 第 2 轮还在思考时连来两条相关消息：因为已有 1 个在途 engaged，必须直接拦下，绝不能再排新回合
  const r3 = await f.core.dispatchLegacyEvent(groupMsg(103, '游戏更新了吗'))
  const r4 = await f.core.dispatchLegacyEvent(groupMsg(104, '游戏活动开了'))
  assert.equal(r3.handled, 'group-pass', `第 3 条应被在途 engaged 预算拦下（实际 ${JSON.stringify(r3)}）`)
  assert.equal(r4.handled, 'group-pass', `第 4 条应被在途 engaged 预算拦下（实际 ${JSON.stringify(r4)}）`)

  // 放行第 2 轮结束
  releaseSecondTurn()
  await f.core.controller.waitForTurn(r2.turnId)
  assert.equal(f.sent.length, 2, '全过程只应发 2 条（1 次被 @ + 1 次 engaged）')
})

test('排队中的后序 engaged 回合：前序选 [沉默] 退场后不再回落 must 复活话题', async () => {
  let callIndex = 0
  let releaseSecondTurn = null
  let markSecondRunning = null
  const secondTurnRunning = new Promise((r) => { markSecondRunning = r })

  const f = makeFixture({
    groupOverrides: { engagedMaxReplies: 2 },
    brain: async () => {
      callIndex += 1
      if (callIndex === 1) return '先搭一句'
      if (callIndex === 2) {
        markSecondRunning()
        await new Promise((r) => { releaseSecondTurn = r })
        return '[沉默]'
      }
      return '不该发出这句'
    },
  })

  // 第 1 轮：被 @ 入场
  await f.core.dispatchLegacyEventSettled(groupMsg(201, '聊游戏', { atBot: true }))
  assert.equal(f.sent.length, 1)

  // 第 2 轮：engaged 放行并进入 running
  const r2 = await f.core.dispatchLegacyEvent(groupMsg(202, '游戏还不错'))
  assert.equal(r2.handled, 'offered')
  await secondTurnRunning

  // 第 2 轮思考期间，第 3 轮（额度第 2 条）合法排队进入队列
  const r3 = await f.core.dispatchLegacyEvent(groupMsg(203, '游戏卡顿了'))
  assert.equal(r3.handled, 'offered')
  assert.notEqual(r3.turnId, r2.turnId)

  // 第 2 轮输出 [沉默] 退出话题
  releaseSecondTurn()
  await f.core.controller.waitForTurn(r2.turnId)
  await f.core.controller.waitForTurn(r3.turnId)

  // 第 3 轮不应退化成 must，也不应再调用模型或复活 engaged
  assert.equal(callIndex, 2, '前序已 [沉默] 退场，排队中的 engaged 回合应直接跳过，不再调模型')
  assert.equal(f.sent.length, 1, '全过程只应有第 1 轮那 1 条物理发送')
  // 验证 engaged 确实已退出（没有被第 3 轮回落 must 复活）
  const r4 = await f.core.dispatchLegacyEvent(groupMsg(204, '游戏继续聊'))
  assert.equal(r4.handled, 'group-pass', '话题已退场，后续消息不该再进 engaged')
})

test('合流窗口内先 @ 后普通 engaged：保持 must 优先级不被降级', async () => {
  const f = makeFixture({
    groupOverrides: { engagedMaxReplies: 2 },
    brain: () => '在呢',
  })

  // 先 @ 入场
  await f.core.dispatchLegacyEventSettled(groupMsg(301, '游戏', { atBot: true }))
  // 在同一合流窗口内先来一条 @（must），紧跟一条普通相关消息（engaged）
  const a = await f.core.dispatchLegacyEvent(groupMsg(302, '游戏怎么玩', { atBot: true }))
  const b = await f.core.dispatchLegacyEvent(groupMsg(303, '游戏好玩吗', { atBot: false }))
  assert.equal(a.turnId, b.turnId, '两条消息应合并进同一回合')
  await f.core.controller.waitForTurn(a.turnId)
  await pause(10)

  const lastPrompt = f.seenPrompts.at(-1) || ''
  assert.match(lastPrompt, /有人在叫你/, '合并了 @ 的回合必须保持 must 提示，不得被后来的 engaged 覆盖')
})
