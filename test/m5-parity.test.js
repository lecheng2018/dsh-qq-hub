// M5 审计对账回归（《新核心空转与缺口审计》2026-11-08）——
// 每条钉住审计的一个发现：群回复闸 / 入口 enabled+静音 / 旁路指令 /
// 上下文双层（systemPrompt.context seam + provider chat 形状）/ 按聊天人设 / 模块发送桥 / maxChars。
// 复用 m4 的形态：fake DSH + mock OneBot + 直接装配 createModularCore。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModularCore } from '../src/host/modular-core.js'
import { createModuleSendBridge } from '../src/host/module-send-bridge.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createOneBotClient } from '../src/onebot/client.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }

// 夹具起真 mock 网关 + fake DSH：连接池/会话句柄在用例结束后有残留（m4/e2e 同款既有现象），
// 沿用仓内收尾模式强制退出，避免文件级挂起。
test.after(() => { setTimeout(() => process.exit(0), 200).unref() })

async function coreFixture(over = {}) {
  const mock = await startMockOneBot({ selfId: '20000002' })
  const dsh = createFakeDsh({ brain: over.brain ?? (async () => '好呀') })
  const cfg = {
    enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人',
    allow: { private: ['10000001'], groups: ['777'] }, longTasks: false,
    merge: { waitSec: 0.05, maxSec: 0.2, groupWaitSec: 0.05, groupMaxSec: 0.2 },
    workspaceDir: mkdtempSync(join(tmpdir(), 'm5p-ws-')),
    ...over.cfg,
  }
  const onebot = createOneBotClient({
    endpoint: () => ({ httpUrl: mock.httpUrl, wsUrl: '', httpToken: mock.token, wsToken: '' }),
    log: noopLog, retryDelays: [10, 10, 10],
  })
  const core = createModularCore({
    dsh: dsh.ctx, onebot,
    mods: over.mods ?? { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
    ...over.core,
  })
  return { core, dsh, mock, cfg, onebot }
}

const grpEv = (gid, uid, text, mentioned = false) => ({
  post_type: 'message', message_type: 'group', sub_type: 'normal', self_id: 20000002,
  group_id: Number(gid), user_id: Number(uid), message_id: Math.floor(Math.random() * 1e9), time: Math.floor(Date.now() / 1000),
  sender: { user_id: Number(uid), nickname: 'u' + uid },
  message: mentioned ? [{ type: 'at', data: { qq: 20000002 } }, { type: 'text', data: { text: ' ' + text } }] : [{ type: 'text', data: { text } }],
})
const privEv = (uid, text) => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000002,
  user_id: Number(uid), message_id: Math.floor(Math.random() * 1e9), time: Math.floor(Date.now() / 1000),
  sender: { user_id: Number(uid), nickname: 'u' + uid }, message: [{ type: 'text', data: { text } }],
})
const wait = (ms = 400) => sleep(ms)

test('审计§1 群回复闸：插话关+没@ 不回（group-pass，不烧 token）；被@ 必回', async () => {
  const { core, dsh, mock } = await coreFixture({ cfg: { group: { interjectChance: 0 } } })
  try {
    const r1 = await core.dispatchLegacyEvent(grpEv(777, 555, '今天天气不错'))
    await wait()
    assert.equal(r1.handled, 'group-pass', '普通群消息被闸拦')
    assert.equal(dsh.turns.length, 0, '闸拦 = 不进回合')
    const r2 = await core.dispatchLegacyEvent(grpEv(777, 555, '在吗', true))
    await wait()
    assert.equal(r2.handled, 'offered', '被@ 必回（must）')
    assert.equal(dsh.turns.length, 1)
    assert.equal(mock.sent('send_group_msg').length, 1)
  } finally { await core.dispose(); await mock.close() }
})

test('审计§1 群上下文拼接：上一轮群聊内容进本轮提示词，主人只标「主人」不落号码', async () => {
  const { core, dsh } = await coreFixture({ brain: async ({ text }) => `看见了:${text.slice(0, 20)}` })
  try {
    await core.dispatchLegacyEvent(grpEv(777, 555, '先聊两句'))          // 被闸拦但进缓冲
    await core.dispatchLegacyEvent(privEv('10000001', '主人插一句'))      // 私聊
    await core.dispatchLegacyEvent(grpEv(777, 555, '在吗', true))          // @ → 进回合
    await wait(500)
    assert.equal(dsh.turns.length, 2)
    const g = dsh.turns[1] // 群回合
    assert.match(g.userText, /刚才新说的/, '带缓冲上下文')
    assert.match(g.userText, /u555\(555\)[^\n]*先聊两句/, '上一句群消息进上下文')
    assert.doesNotMatch(g.userText, /主人\(10000001\)/, '主人不落真实号码')
  } finally { await core.dispose(); await coreFixture && null }
})

test('审计1.10 静音：入口拦，不跑回合', async () => {
  const { core, dsh, mock } = await coreFixture({ core: { isMuted: (chatId) => chatId === 'private:10000001' } })
  try {
    const r = await core.dispatchLegacyEvent(privEv('10000001', '在吗'))
    await wait(250)
    assert.equal(r.handled, 'muted')
    assert.equal(dsh.turns.length, 0)
    assert.equal(mock.sent('send_private_msg').length, 0)
  } finally { await core.dispose(); await mock.close() }
})

test('审计1.9 旁路指令：审批/提问批复被 interceptInteraction 消费，不进回合', async () => {
  let intercepted = 0
  const { core, dsh, mock } = await coreFixture({
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    core: { interceptInteraction: (m) => { intercepted++; if (m.text === '通过 #1') return true; return false } },
  })
  try {
    const r1 = await core.dispatchLegacyEvent(privEv('10000001', '通过 #1'))
    await wait(200)
    assert.equal(r1.handled, 'interaction')
    assert.equal(dsh.turns.length, 0, '旁路命中不进回合')
    await core.dispatchLegacyEvent(privEv('10000001', '普通消息'))
    await wait(300)
    assert.equal(dsh.turns.length, 1, '没命中照常走')
    assert.equal(intercepted, 2)
  } finally { await core.dispose(); await mock.close() }
})

test('审计1.1 上下文双层：模块上下文经 systemPrompt.context 通道投喂（provider 吃 chat 对象）', async () => {
  const seen = []
  const { core, dsh, mock } = await coreFixture({
    brain: async ({ ctxText }) => ctxText ? '收到上下文' : '空的',
    mods: {
      commands: () => [], use: () => null,
      contextFor: async (args) => { seen.push(args); return args.chat && args.chat.kind === 'private' ? '【记忆：他喜欢白米饭】' : '' },
    },
  })
  try {
    await core.dispatchLegacyEvent(privEv('10000001', '在吗'))
    await wait(450)
    assert.equal(seen.length >= 1, true, 'provider 被调')
    assert.equal(seen[0].chat.kind, 'private', 'provider 拿到 chat 视图（第二层修复）')
    assert.equal(dsh.turns[0].ctxText.includes('白米饭'), true, '装配产出进 agent 上下文（第一层修复：systemPrompt.context seam）')
    assert.match(dsh.turns[0].reply, /收到上下文/)
  } finally { await core.dispose(); await mock.close() }
})

test('审计1.2 按聊天人设：personaTextFor 提供的专用卡遮蔽全局（蒸馏语感卡生效通道）', async () => {
  const { core, dsh, mock } = await coreFixture({
    brain: async ({ persona }) => `persona=${persona}`,
    core: { personaText: () => '全局人设', personaTextFor: (chat) => (chat.kind === 'private' && chat.userId === '10000001' ? '主人专用卡' : null) },
  })
  try {
    await core.dispatchLegacyEvent(privEv('10000001', '在吗'))
    await wait(450)
    assert.equal(dsh.turns[0].persona, '主人专用卡', 'agent 作用域 variable 遮蔽（hub.js:529 同款通道）')
  } finally { await core.dispose(); await mock.close() }
})

test('审计§2 模块发送桥：文本/图片发送并入 outbox（台账有 sourceModuleId、dryRun 能拦）；语音/文件走 legacy 但补台账（2026-11-09 现网 #13 收口）', async () => {
  const { core, mock, cfg } = await coreFixture()
  try {
    const fakeHubCalls = []
    const bridge = createModuleSendBridge({ hub: { sendText: async (...a) => { fakeHubCalls.push(a); return { message_id: 999 } }, sendSegments: async () => ({ message_id: 998 }) }, outbox: core.outbox, log: noopLog })
    const r = await bridge.sendText('private:10000001', '模块提醒你', 'scheduler')
    assert.equal(r.state, 'sent')
    assert.equal(fakeHubCalls.length, 0, '文本不再直连 hub')
    const sends = mock.sent('send_private_msg')
    assert.match(JSON.stringify(sends.at(-1).params.message), /模块提醒你/)
    // dryRun 能拦模块发送
    cfg.dryRun = true
    const r2 = await bridge.sendText('private:10000001', '试运行消息', 'rss')
    assert.equal(r2.state, 'cancelled')
    assert.equal(JSON.stringify(mock.sent('send_private_msg')).includes('试运行消息'), false)
    cfg.dryRun = false
    // 图片段（带 file/url/path）现在也收口进 outbox（真机：生图主动发要能进台账/被 dryRun 拦）
    const bridgeImg = createModuleSendBridge({ hub: { sendSegments: async (...a) => { fakeHubCalls.push(a); return { message_id: 997 } } }, outbox: core.outbox, log: noopLog })
    const ri = await bridgeImg.sendSegments('group:777', [{ type: 'image', data: { url: 'https://example.com/x.png' } }], 'imagegen')
    assert.equal(ri.state, 'sent', '图片段走 outbox 直发')
    assert.equal(fakeHubCalls.filter((a) => a[2] === 'imagegen').length, 0, '图片不再透传 legacy')
    // 语音/文件段仍走 legacy 上载管线，但发完补一条台账（recordExternal）
    const hubMedia = []
    const bridge2 = createModuleSendBridge({ hub: { sendSegments: async (...a) => { hubMedia.push(a); return { message_id: 4321 } } }, outbox: core.outbox, log: noopLog })
    await bridge2.sendSegments('group:777', [{ type: 'record', data: { file: 'a.slk' } }], 'voice')
    assert.equal(hubMedia.length, 1, '非文本/图片段仍走 hub 管线')
    // 且发完补了台账（recordExternal 是 B 方案收口的公开面）
    assert.equal(typeof core.outbox.recordExternal, 'function', 'outbox 暴露 recordExternal')
    const st1 = core.outbox.ledger.stats()
    const id = core.outbox.recordExternal({ chatKey: 'group:777', sourceModuleId: 'voice', segments: [], gatewayMessageId: '4321' })
    assert.ok(id, '外部发送拿到 deliveryId')
    assert.ok(JSON.stringify(core.outbox.ledger.stats()).length, '台账可查询')
    void st1
  } finally { await core.dispose(); await mock.close() }
})

test('审计1.8 maxChars 钉住：parseReply(replyRules) 已含长度封顶（审计误报为缺口，测试锁定行为）', async () => {
  const long = '白米饭'.repeat(200) // 1000 字，远超私聊默认 400
  const { core, dsh, mock } = await coreFixture({ brain: async () => long })
  try {
    await core.dispatchLegacyEvent(privEv('10000001', '说点长的'))
    await wait(500)
    const sends = mock.sent('send_private_msg')
    assert.ok(sends.length >= 1)
    const total = sends.map((s) => JSON.stringify(s.params.message)).join('').length
    assert.ok(total < long.length + 200, '超长被封顶/拆条，不整段 1000 字外发')
    for (const s of sends) {
      const t = s.params.message.filter((c) => c.type === 'text').map((c) => c.data.text).join('')
      assert.ok(t.length <= 900, `单条气泡不越界（实际 ${t.length}）`)
    }
  } finally { await core.dispose(); await mock.close() }
})
