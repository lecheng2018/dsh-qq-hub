// PR3 回复分条、群聊策略/氛围门禁、补收/入站与防护链综合回归测试
import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'

import { decideGroupReplyWithAtmosphere } from '../src/chat/group-atmosphere-gate.js'
import { evaluate as evalAtmosphere } from '../src/chat/group-atmosphere.js'
import { isCommandLike, selectBackfill } from '../src/chat/backfill.js'
import { parseMessageEvent } from '../src/chat/inbound.js'
import { parseReply, segmentUnits, mergeUnits, capBubbles } from '../src/chat/reply.js'
import { createReplyDelivery } from '../src/chat/reply-delivery.js'
import { resolveEngagedBudget, isOfficialBotSender, topicRelevance, policyFor, decideGroupReply } from '../src/chat/group-policy.js'
import { normalize as normalizeConfig } from '../src/core/config.js'
import { dedupConvo, assessFishDensity, assessPairLoop, normalizeFishGuard } from '../src/chat/fish-guard.js'
import { findIdentityLeaks, maskLeakValue } from '../src/chat/identity-guard.js'
import { detectSignal } from '../src/chat/conversation-closure.js'
import { createGroupQuota } from '../src/chat/group-quota.js'
import { createContextAssembly, createTimeScaleProvider } from '../src/chat/context-assembly.js'
import { rulesLayers } from '../src/persona/personas.js'
import { createModularCore } from '../src/host/modular-core.js'

const NOW = 1_800_000_000_000 /* pii-scan:ignore */
const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// 1. group-atmosphere-gate & group-atmosphere
// ---------------------------------------------------------------------------

test('group-atmosphere-gate：先评氛围张力再决定是否消耗 rand', () => {
  let randCalls = 0
  const angry = [
    { text: '你是不是有病啊！！！', t: NOW - 1000 },
    { text: '傻逼吧你，滚', t: NOW - 2000 },
    { text: '你才滚！神经病', t: NOW - 3000 },
    { text: '闭嘴吧废物', t: NOW - 4000 },
  ]
  const res = decideGroupReplyWithAtmosphere({
    policy: {
      interjectChance: 0.5,
      minRelevance: 0,
      minRecentMessages: 0,
      quietHours: [],
      cooldownSec: 0,
      maxPerHour: 99,
      burstMax: 99,
    },
    text: '正常说话',
    now: NOW,
    hour: 14,
    recentTimes: [NOW - 1000],
    interjectTimes: [],
    botReplyTimes: [],
    relevance: 1,
    rand: () => { randCalls += 1; return 0 },
    messages: angry,
  }, { gate: { enabled: true, tensionLimit: 0.7 } })
  assert.equal(res.reply, false)
  assert.match(res.reason, /群里在吵/)
  assert.equal(randCalls, 0, '张力已超限时不应无谓消耗调用方 rand')
})

test('group-atmosphere：技术群缩写/代码块/URL 不误判为咆哮，连续非常规全大写词仍识别', () => {
  const techMsgs = [
    { uid: '1', text: 'HTTP 500 JSON 解析报错，看下 NGINX 和 REDIS 日志', t: NOW - 3000 },
    { uid: '2', text: 'NVIDIA RTX CUDA VRAM OOM 了，https://EXAMPLE.COM/ISSUE_TRACKER', t: NOW - 2000 },
    { uid: '3', text: 'MAX_BUBBLES 和 `DOCKER COMPOSE` 都检查过了', t: NOW - 1000 },
  ]
  const techRes = evalAtmosphere(techMsgs, { now: NOW })
  assert.equal(techRes.tension, 0, `技术缩写不应拉高张力（实际 ${techRes.tension}）`)

  const shoutRes = evalAtmosphere([
    { uid: '1', text: 'SHUT UP RIGHT NOW', t: NOW - 3000 },
    { uid: '2', text: 'GET OUT', t: NOW - 2000 },
    { uid: '3', text: 'STOP IT', t: NOW - 1000 },
  ], { now: NOW })
  assert.ok(shoutRes.tension > 0, `连续非常规全大写词应计入张力（实际 ${shoutRes.tension}）`)
})

// ---------------------------------------------------------------------------
// 2. backfill & inbound
// ---------------------------------------------------------------------------

test('backfill：支持毫秒时间戳、selfId 空串回落 m.self_id、放行 ok 与年份', () => {
  assert.equal(isCommandLike('ok'), false)
  assert.equal(isCommandLike('OK!'), false)
  assert.equal(isCommandLike('ok #1'), true)
  assert.equal(isCommandLike('#2 ok'), true)
  assert.equal(isCommandLike('2025'), false)
  assert.equal(isCommandLike('2026'), false)
  assert.equal(isCommandLike('1999'), false)
  assert.equal(isCommandLike('123456'), true)

  const now = 1_763_000_000_000 /* pii-scan:ignore */
  const res = selectBackfill([
    { message_id: '1', time: now - 30_000, self_id: '90001', user_id: '90001', message: [{ type: 'text', data: { text: '机器人自发' } }] },
    { message_id: '2', time: now - 20_000, self_id: '90001', user_id: '10000001', message: [{ type: 'text', data: { text: 'ok' } }] }, /* pii-scan:ignore */
    { message_id: '3', time: Math.floor((now - 10_000) / 1000), self_id: '90001', user_id: '10000002', message: [{ type: 'text', data: { text: '2026' } }] }, /* pii-scan:ignore */
  ], { key: 'group:777', since: now - 60_000, now, selfId: '' })

  assert.deepEqual(res.items.map((x) => x.event.message_id), ['2', '3'])
  assert.equal(res.skippedCommands.length, 0)
})

test('inbound：@all 写入文本且不置 mentioned=true', () => {
  const ev = {
    post_type: 'message',
    message_type: 'group',
    group_id: 777,
    user_id: 10000001, /* pii-scan:ignore */
    self_id: 20000002, /* pii-scan:ignore */
    message_id: 10,
    sender: { nickname: '甲' },
    message: [
      { type: 'at', data: { qq: 'all' } },
      { type: 'text', data: { text: ' 今晚开会' } },
    ],
  }
  const parsed = parseMessageEvent(ev, '20000002') /* pii-scan:ignore */
  assert.equal(parsed.mentioned, false)
  assert.match(parsed.text, /@all\s+今晚开会/)

  const evNamed = {
    ...ev,
    message: [
      { type: 'at', data: { qq: 'all', name: '全体成员' } },
      { type: 'text', data: { text: ' 集合' } },
    ],
  }
  const parsedNamed = parseMessageEvent(evNamed, '20000002') /* pii-scan:ignore */
  assert.equal(parsedNamed.mentioned, false)
  assert.match(parsedNamed.text, /@全体成员\s+集合/)
})

// ---------------------------------------------------------------------------
// 3. 私聊分条 reply.js
// ---------------------------------------------------------------------------

test('reply：连续省略号/感叹号/问号与闭合引号不劈开；ASCII 单引号不锁中文引号', () => {
  const units = segmentUnits("It's fine……真的吗？！她说：“没问题。”后面还有一句。")
  assert.ok(!units.some((u) => /^[。！？!?…]+$/.test(u.text)), `不应产出纯标点单元：${JSON.stringify(units)}`)
  assert.ok(units.some((u) => u.text.includes('……')), `应保留连续省略号：${JSON.stringify(units)}`)
  assert.ok(units.some((u) => u.text.includes('？！')), `应保留连续？！：${JSON.stringify(units)}`)
  assert.ok(units.some((u) => u.text.includes('“没问题。”')), `ASCII 单引号不应锁死中文引号边界：${JSON.stringify(units)}`)
})

test('reply：mergeUnits 不出纯标点泡或极短尾段泡；capBubbles 用双换行且保留 replyTo', () => {
  const merged = mergeUnits([
    { text: '……', brk: 'hard' },
    { text: '好吧', brk: 'punct' },
    { text: '今天确实很忙呢。', brk: 'punct' },
    { text: '嗯', brk: 'punct' },
  ], { cap: 15, minBubble: 6, rand: () => 0 })
  assert.ok(!merged.some((b) => /^[…\s\p{P}]+$/u.test(b)), `不能出现纯标点泡：${JSON.stringify(merged)}`)
  assert.ok(Array.from(merged.at(-1)).length > 2, `极短尾段应回并上一条：${JSON.stringify(merged)}`)

  const capped = capBubbles([
    { kind: 'text', value: '第一段', replyTo: '3' },
    { kind: 'text', value: '第二段' },
    { kind: 'text', value: '第三段' },
  ], 2)
  assert.equal(capped.length, 2)
  assert.equal(capped[0].value, '第一段\n\n第二段')
  assert.equal(capped[0].replyTo, '3')
})

test('reply：文档切分下沉至气泡级（带 ||| 与贴纸时仍生效），支持【小标题】/**加粗标题** 及跨气泡 replyTo 复位', () => {
  const doc = [
    '**硬件选型结论**',
    '这部分先给出主流平台的详细对比和实际压测表现，方便你直接对照需求来挑选，不再逐行拆碎。',
    '',
    '【存储与接口】',
    '• 第一条：支持双盘位与高速 PCIe 通道，读写带宽足够应付日常多任务备份与媒体转码场景。',
    '• 第二条：整机功耗控制得比较克制，满载噪音也比同类入门机型更低一些。',
    '',
    '**部署建议**',
    '建议系统盘和冷备盘物理分开，关键目录启用定期快照和异地增量同步，避免单盘故障拖垮整机。',
  ].join('\n')
  const parsed = parseReply(`<reply：1>先看总结|||<reply:[2]>${doc}|||<sticker:比心>`, { maxBubbles: 4, softMaxBubbles: 1, maxChars: 60 })
  assert.equal(parsed.items[0].replyTo, '1')
  assert.ok(parsed.items.some((it) => it.kind === 'text' && it.value.includes('存储与接口')), '气泡级长文档切分应生效')
  assert.ok(parsed.items.filter((it) => it.kind === 'text').length >= 3, '长文档不受 softMaxBubbles=1 压成一坨')
  const sticker = parsed.items.find((it) => it.kind === 'sticker')
  assert.equal(sticker?.value, '比心')
  assert.equal(sticker?.replyTo, undefined, '跨 ||| 气泡不应泄漏 replyTo')

  const leaked = parseReply('<reply:1>第一句|||第二句')
  assert.equal(leaked.items[0].replyTo, '1')
  assert.equal(leaked.items[1].replyTo, undefined, '第二条 ||| 气泡应复位 replyTo')
})

// ---------------------------------------------------------------------------
// 4. reply-delivery.js
// ---------------------------------------------------------------------------

test('reply-delivery：嵌套 deliver 复用外层票不死锁；长文本解除收尾软顶；空 userText 不污染；主人引用兜底；状态上限 500', async () => {
  const deliveryContext = new AsyncLocalStorage()
  const sent = []
  let activeCalls = 0
  let maxConcurrent = 0
  const outboxObj = {
    reserve() {
      activeCalls += 1
      return { ticket: { id: activeCalls }, release() {} }
    },
  }
  let delivery
  delivery = createReplyDelivery({
    getConfig: () => ({ ownerQQ: '10000001', ownerName: '阿主人', voice: { enabled: false }, stickers: { enabled: false }, reply: { privateMaxChars: 80, maxBubbles: 4 } }), /* pii-scan:ignore */
    log: noopLog,
    hooks: {
      async reply(text) {
        if (text === '触发嵌套') {
          await delivery.deliver('private:10000001', '内层消息') /* pii-scan:ignore */
          return '外层消息'
        }
        return text
      },
    },
    groups: { refs: () => ({}), leaveTopic() {}, noteSpeak() {}, noteSpokeInGroup() {} },
    stickers: { match: () => null, pickForReply: () => null },
    interaction: { queueAside() {} },
    sendText: async (chatId, text, replyId) => {
      maxConcurrent = Math.max(maxConcurrent, 1)
      sent.push({ chatId, text, replyId })
      return { message_id: sent.length }
    },
    sendVoice: async () => null,
    sendSticker: async () => null,
    sendImage: async () => null,
    sendMixed: async () => null,
    pokeBack: async () => {},
    outbox: () => outboxObj,
    deliveryContext,
    sleep: async () => {},
  })

  // 1) 嵌套 deliver 不死锁且只 reserve 一次
  await Promise.race([
    delivery.deliver('private:10000001', '触发嵌套'), /* pii-scan:ignore */
    sleep(500).then(() => { throw new Error('嵌套 deliver 死锁超时') }),
  ])
  assert.equal(activeCalls, 1)
  assert.deepEqual(sent.map((s) => s.text), ['内层消息', '外层消息'])

  // 2) 空 userText 不推进 closureStates，即使先收到「晚安」，后续空 userText 也不出错
  await delivery.deliverNow('private:10000001', '晚安呀', { userText: '晚安' }) /* pii-scan:ignore */
  await delivery.deliverNow('private:10000001', '第一句|||第二句|||第三句', { userText: '' }) /* pii-scan:ignore */
  // 3) 长回复 (>=260字) 解除 softMaxBubbles=1 压制
  const longText = '第一段内容。'.repeat(25) + '|||' + '第二段内容。'.repeat(25)
  const longRes = await delivery.deliverNow('private:10000001', longText, { userText: '嗯' }) /* pii-scan:ignore */
  assert.ok(longRes.items.length >= 2, '长回复应解除 softMaxBubbles=1 压制')

  // 4) <reply:主人> 兜底匹配 ref.owner === true，[reply:…] 全角与方括号兼容
  sent.length = 0
  const refs = { 1: { mid: 'mid-owner', uid: '10000001', nick: 'OwnerNick', owner: true }, 2: { mid: 'mid-2', uid: '10000002', nick: '路人' } } /* pii-scan:ignore */
  await delivery.deliverNow('group:777', '<reply:主人>收到', { refs })
  await delivery.deliverNow('group:777', '[reply：2]好的', { refs })
  assert.equal(sent[0].replyId, 'mid-owner')
  assert.equal(sent[1].replyId, 'mid-2')

  // 5) closureStates 容量上限 500 不抛异常
  for (let i = 0; i < 520; i += 1) {
    await delivery.deliverNow(`private:${20000 + i}`, '好', { userText: '晚安' })
  }
  assert.equal(maxConcurrent, 1)
})

// ---------------------------------------------------------------------------
// 5. 群聊策略 / config overrides / official bot / fresh / drift / personas
// ---------------------------------------------------------------------------

test('group-policy & config：预算严格解析、overrides 归一化、0 不死锁、leaveTopic、topicRelevance、官方机器人过滤', () => {
  assert.deepEqual(resolveEngagedBudget({ engagedMaxReplies: '', engagedMaxMs: null }), { maxReplies: 3, maxMs: 360_000 })
  assert.deepEqual(resolveEngagedBudget({ engagedMaxReplies: false, engagedMaxMs: undefined }), { maxReplies: 3, maxMs: 360_000 })
  assert.deepEqual(resolveEngagedBudget({ engagedMaxReplies: 0, engagedMaxMs: 0 }), { maxReplies: 0, maxMs: 0 })

  const cfg = normalizeConfig({
    group: {
      interjectChance: 0.1,
      overrides: {
        '777': { interjectChance: '0.5', engagedMaxReplies: '0', wakeWords: '小鱼，鱼宝', interests: ['番剧', ''] },
        '': { interjectChance: 0.9 },
      },
    },
  })
  assert.equal(cfg.group.overrides['777'].interjectChance, 0.5)
  assert.equal(cfg.group.overrides['777'].engagedMaxReplies, 0)
  assert.deepEqual(cfg.group.overrides['777'].wakeWords, ['小鱼', '鱼宝'])
  assert.deepEqual(cfg.group.overrides['777'].interests, ['番剧'])

  // engagedMaxReplies=0 时不进入 engaged、不打印「已连着接了 0 条」，直接走常规摇号
  const pol0 = policyFor(cfg.group, cfg.group.overrides, '777')
  const d0 = decideGroupReply({
    policy: { ...pol0, interjectChance: 1, minRelevance: 0, minRecentMessages: 0, quietHours: [], cooldownSec: 0 },
    text: '普通消息',
    now: NOW,
    hour: 14,
    recentTimes: [NOW - 1000],
    interjectTimes: [],
    botReplyTimes: [],
    engagedUntil: NOW + 60_000,
    engagedReplies: 0,
    rand: () => 0,
  })
  assert.equal(d0.reply, true)
  assert.equal(d0.mode, 'interject')

  // 超限返回 leaveTopic: true
  const dLeave = decideGroupReply({
    policy: { ...DEFAULT_POLICY_FOR_TEST(), engagedMaxReplies: 2 },
    text: '普通消息',
    now: NOW,
    hour: 14,
    recentTimes: [NOW - 1000],
    engagedUntil: NOW + 60_000,
    engagedSince: NOW - 10_000,
    engagedReplies: 2,
    relevance: 0.8,
  })
  assert.equal(dLeave.reply, false)
  assert.equal(dLeave.leaveTopic, true)

  // topicRelevance：旧词在前面、最新 2 条完全无关时不蹭到 >=0.25 门槛
  const relOldOnly = topicRelevance(['刚才聊了游戏和番剧', '又聊了电影', '今天代码报错', '重启试试'], ['游戏', '番剧', '电影'])
  assert.ok(relOldOnly <= 0.2, `仅旧消息命中不应蹭高分（实际 ${relOldOnly}）`)
  const relTail = topicRelevance(['前面闲聊', '最新在聊游戏'], ['游戏', '番剧'])
  assert.ok(relTail >= 0.3)

  // QQ 官方系统机器人识别与阻断
  assert.equal(isOfficialBotSender('2854196310', '随便'), true) /* pii-scan:ignore */
  assert.equal(isOfficialBotSender('10000001', 'Q群管家'), true) /* pii-scan:ignore */
  assert.equal(isOfficialBotSender('10000001', '普通群友'), false) /* pii-scan:ignore */
  const botDecision = decideGroupReply({
    policy: { ...DEFAULT_POLICY_FOR_TEST(), wakeWords: ['管家'], interjectChance: 1 },
    text: '管家提醒大家打卡',
    fromOfficialBot: true,
    now: NOW,
    hour: 14,
    recentTimes: [NOW - 1000, NOW - 2000, NOW - 3000],
  })
  assert.equal(botDecision.reply, false)

  // personas 提示词引导主动引用 <reply:编号>
  const groupLayers = rulesLayers('social', { group: {} }, { extra: [] })
  assert.ok(groupLayers.protocol.some((l) => l.includes('早于最后一条') && l.includes('<reply:编号>')))
})

function DEFAULT_POLICY_FOR_TEST() {
  return policyFor({}, {}, 1)
}

test('modular-core：发前高漂移(>=6)放弃发送且不标违规发送；触发消息带引用标记', async () => {
  const listeners = new Set()
  const session = { id: 'sess-drift' }
  const contextsMap = new Map()
  const prompts = []
  const sentCalls = []
  let coreRef
  let turnNo = 0
  let injectDrift = false
  const cfg = {
    enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人', /* pii-scan:ignore */
    allow: { private: ['10000001'], groups: ['777'] }, longTasks: false, /* pii-scan:ignore */
    merge: { waitSec: 0.01, maxSec: 0.05, groupWaitSec: 0.01, groupMaxSec: 0.05 },
    group: { interjectChance: 1, cooldownSec: 0, minRecentMessages: 0, minRelevance: 0, quietHours: [], maxPerHour: 99, burstMax: 99, quota: { enabled: false } },
    security: { identityGuard: { enabled: false } },
    voice: { enabled: false, autoChance: 0 }, stickers: { enabled: false, faces: false, autoChance: 0 },
    reply: { groupMaxChars: 500, maxBubbles: 3 },
  }

  const agent = {
    id: session.id,
    ctx: { get: (name) => (name === 'contexts' ? { set: (k, v) => contextsMap.set(k, v), get: (k) => contextsMap.get(k), values: () => contextsMap.values() } : null) },
    async followup(msg) {
      const n = ++turnNo
      prompts.push((msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'))
      if (injectDrift) {
        injectDrift = false
        cfg.group.interjectChance = 0
        // 模拟模型生成期间群里刷了 6 条新真人消息
        for (let i = 0; i < 6; i += 1) {
          await coreRef.dispatchLegacyEvent({
            post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: 777,
            self_id: 20000002, user_id: 600 + i, message_id: 900 + i, time: Math.floor(Date.now() / 1000), /* pii-scan:ignore */
            sender: { user_id: 600 + i, nickname: `路人${i}` },
            message: [{ type: 'text', data: { text: `新刷消息${i}` } }],
          })
        }
      }
      for (const fn of [...listeners]) fn(session, { type: 'assistant/message', data: { turn: n, message: { content: [{ type: 'text', text: '接一句无引用的话' }] } } })
      for (const fn of [...listeners]) fn(session, { type: 'turn/end', data: { turn: n, reason: { kind: 'completed' } } })
    },
  }
  const dsh = {
    on(name, fn) { if (name !== 'session/event') return () => {}; listeners.add(fn); return () => listeners.delete(fn) },
    get(name) {
      if (name === 'sessionController') return { create: async () => ({ sessionId: session.id }), resolveAgent: async () => ({ agent }) }
      if (name === 'workspaceRegistry') return { list: () => [{ id: 'ws-drift', path: 'ws-drift' }], create: async () => ({ id: 'ws-drift', path: 'ws-drift' }) }
      return null
    },
  }
  coreRef = createModularCore({
    dsh,
    onebot: { call: async (action, params) => { if (action === 'send_group_msg') sentCalls.push({ action, params }); return { message_id: sentCalls.length + 1 } } },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
  })
  try {
    injectDrift = true
    await coreRef.dispatchLegacyEventSettled({
      post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: 777,
      self_id: 20000002, user_id: 502, message_id: 102, time: Math.floor(Date.now() / 1000), /* pii-scan:ignore */
      sender: { user_id: 502, nickname: '新人' },
      message: [{ type: 'text', data: { text: '刚说的新话题' } }],
    })
    await sleep(80)
    assert.equal(prompts.length, 1)
    assert.match(prompts[0], /\[1\][^\n]*刚说的新话题（← 触发本轮）/)
    assert.equal(sentCalls.length, 0, '漂移 >= 6 且无显式引用时应放弃发送')

    // 中等漂移 (drift === 2) + Q群管家不计入漂移：应补挂 reply 引用触发消息
    cfg.group.interjectChance = 1
    let injectMidDrift = true
    const prevFollowup = agent.followup
    agent.followup = async (msg) => {
      const n = ++turnNo
      prompts.push((msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'))
      if (injectMidDrift) {
        injectMidDrift = false
        cfg.group.interjectChance = 0
        for (let i = 0; i < 2; i += 1) {
          await coreRef.dispatchLegacyEvent({
            post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: 777,
            self_id: 20000002, user_id: 700 + i, message_id: 950 + i, time: Math.floor(Date.now() / 1000), /* pii-scan:ignore */
            sender: { user_id: 700 + i, nickname: `路人B${i}` },
            message: [{ type: 'text', data: { text: `插播${i}` } }],
          })
        }
        // 官方机器人发 5 条也不应把漂移推高到 >= 6
        for (let i = 0; i < 5; i += 1) {
          await coreRef.dispatchLegacyEvent({
            post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: 777,
            self_id: 20000002, user_id: 2854196305, message_id: 960 + i, time: Math.floor(Date.now() / 1000), /* pii-scan:ignore */
            sender: { user_id: 2854196305, nickname: 'Q群管家' }, /* pii-scan:ignore */
            message: [{ type: 'text', data: { text: `系统提醒${i}` } }],
          })
        }
      }
      for (const fn of [...listeners]) fn(session, { type: 'assistant/message', data: { turn: n, message: { content: [{ type: 'text', text: '中等漂移跟一句' }] } } })
      for (const fn of [...listeners]) fn(session, { type: 'turn/end', data: { turn: n, reason: { kind: 'completed' } } })
    }
    void prevFollowup
    await coreRef.dispatchLegacyEventSettled({
      post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: 777,
      self_id: 20000002, user_id: 503, message_id: 103, time: Math.floor(Date.now() / 1000), /* pii-scan:ignore */
      sender: { user_id: 503, nickname: '丙' },
      message: [{ type: 'text', data: { text: '第二轮话题' } }],
    })
    await sleep(80)
    assert.equal(sentCalls.length, 1, '官方机器人不计漂移，drift=2 仍可发送')
    assert.ok(sentCalls[0].params.message.some((s) => s.type === 'reply' && String(s.data?.id) === '103'), 'drift=2..5 应自动补挂引用指向触发消息')
  } finally {
    await coreRef.dispose()
  }
})

// ---------------------------------------------------------------------------
// 6. fish-guard
// ---------------------------------------------------------------------------

test('fish-guard：dedupConvo 兼容 userId 且空文本不去重、乒乓同侧连发 continue、pairLoop 认名字与群名检测', () => {
  const deduped = dedupConvo([
    { userId: '501', text: '' },
    { userId: '501', text: '' },
    { userId: '501', text: '' },
    { userId: '502', text: '重复话' },
    { userId: '502', text: '重复话' },
    { userId: '502', text: '重复话' },
  ], 2)
  assert.equal(deduped.filter((x) => !x.text).length, 3, '空文本不参与去重')
  assert.equal(deduped.filter((x) => x.text === '重复话').length, 2)

  const fg = normalizeFishGuard({ fishIds: ['555666777'] }) /* pii-scan:ignore */
  const ping = []
  for (let i = 0; i < 4; i += 1) {
    ping.push({ userId: '555666777', time: NOW - (4 - i) * 10000, isSelf: false }) /* pii-scan:ignore */
    ping.push({ userId: '20000002', time: NOW - (4 - i) * 10000 + 2000, isSelf: true }) /* pii-scan:ignore */
    if (i === 2) ping.push({ userId: '20000002', time: NOW - (4 - i) * 10000 + 3000, isSelf: true }) /* pii-scan:ignore */
  }
  const dens = assessFishDensity(ping, { now: NOW, guard: fg, groupId: '777', groupName: '普通群' })
  assert.equal(dens.pingPong, 8, '同侧多泡连发 continue 不打断乒乓交替计数')

  const pairRes = assessPairLoop([
    { isSelf: true, userId: '20000002' }, /* pii-scan:ignore */
    { isSelf: false, userId: '701', nick: '小肥鱼' },
    { isSelf: true, userId: '20000002' }, /* pii-scan:ignore */
    { isSelf: false, userId: '701', nick: '小肥鱼' },
  ], '701', { guard: fg })
  assert.equal(pairRes.isFish, true, 'assessPairLoop 应按 isFishName 识别同类 bot')
  assert.equal(pairRes.blocked, true)
})

// ---------------------------------------------------------------------------
// 7. identity-guard / conversation-closure / group-quota / context-assembly
// ---------------------------------------------------------------------------

test('identity-guard：屏蔽 URL、放行日期/时间戳/整千万、支持 QQ号： 与 4 位数字打码', () => {
  assert.deepEqual(findIdentityLeaks('看 https://example.com/av123456789?id=987654321 挺好'), []) /* pii-scan:ignore */
  assert.deepEqual(findIdentityLeaks('版本 20261127 发布于 1763000000，总计 10000000 次'), []) /* pii-scan:ignore */
  const hitCase = findIdentityLeaks('联系 qq号：12345678 看看') /* pii-scan:ignore */
  assert.ok(hitCase.some((h) => h.kind === 'qq-context'))

  // 4 位已知 ID 不误命中 6 位数字子串，且 maskLeakValue 支持 4 位打码
  assert.deepEqual(findIdentityLeaks('编号 123456', { ids: ['2345'] }), [])
  assert.equal(findIdentityLeaks('编号 2345', { ids: ['2345'] }).length, 1)
  assert.equal(maskLeakValue('2345'), '2**5')
})

test('conversation-closure：收窄道别/敷衍误判，补齐无问号疑问句', () => {
  assert.equal(detectSignal('聊得开心，先这样吧').isFarewell, true)
  assert.equal(detectSignal('先这样').isFarewell, false)
  assert.equal(detectSignal('要挂了').isFarewell, false)
  assert.equal(detectSignal('明天出门').isFarewell, false)
  assert.equal(detectSignal('哈哈哈').isAck, false)
  assert.equal(detectSignal('好好好').isAck, false)
  assert.equal(detectSignal('嗯').isAck, true)
  assert.equal(detectSignal('这个怎么弄').isQuestion, true)
  assert.equal(detectSignal('为啥不行').isQuestion, true)
  assert.equal(detectSignal('能不能改一下').isQuestion, true)
})

test('group-quota：放行 windowMs+500 缓冲等待，unknown 不重试', async () => {
  let clock = 100_000
  let slept = 0
  let sendCalls = 0
  const quota = createGroupQuota({
    getConfig: () => ({ group: { quota: { enabled: true, perMinute: 1, windowMs: 60_000, maxRetries: 2 } } }),
    now: () => clock,
    sleep: async (ms) => { slept += ms; clock += ms },
  })
  await quota.send('777', async () => ({ ok: 1 }))
  // 同毫秒触发第 2 条：wait = 60_000 + 250 = 60_250 <= 60_500，应等待而非跳过
  await quota.send('777', async () => ({ ok: 2 }))
  assert.equal(slept, 60_250)

  const rUnknown = await quota.send('778', async () => {
    sendCalls += 1
    const err = new Error('46 rate limit uncertain')
    err.unknown = true
    throw err
  })
  assert.equal(rUnknown.ok, false)
  assert.equal(sendCalls, 1, 'unknown 错误绝不自动重试')
})

test('context-assembly：nextOrder 单调递增、按对象引用注销、lastAt<=0 跳过、并发 Promise.allSettled', async () => {
  const ca = createContextAssembly()
  const off1 = ca.register({ moduleId: 'dup', priority: 10, scope: 'global', provide: () => 'A' })
  ca.register({ moduleId: 'dup', priority: 10, scope: 'global', provide: () => 'B' })
  off1()
  const out = await ca.assemble({ chatKey: 'private:10000001' }) /* pii-scan:ignore */
  assert.deepEqual(out.fragments.map((f) => f.content), ['B'])

  const tp = createTimeScaleProvider({ scope: 'private:10000001', resolveLastAt: () => 0, now: () => 1000 }) /* pii-scan:ignore */
  assert.equal(await tp.provide({ chatKey: 'private:10000001' }), '') /* pii-scan:ignore */

  // 并发拉取：两个各耗 40ms 的 provider 总耗时显著小于 80ms，且输出顺序仍按 priority
  const caPar = createContextAssembly({
    providers: [
      { moduleId: 'low', priority: 1, scope: 'global', provide: async () => { await sleep(40); return 'L' } },
      { moduleId: 'high', priority: 9, scope: 'global', provide: async () => { await sleep(40); return 'H' } },
    ],
  })
  const t0 = Date.now()
  const parOut = await caPar.assemble({ chatKey: 'private:10000001' }) /* pii-scan:ignore */
  const elapsed = Date.now() - t0
  assert.deepEqual(parOut.fragments.map((f) => f.content), ['H', 'L'])
  assert.ok(elapsed < 75, `应并发执行（耗时 ${elapsed}ms）`)
})
