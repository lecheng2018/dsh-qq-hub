// m7 · 现网 22 项固化的回归钉（《全部修复汇总-20261109.md》对照落码）
//
// 背景：2026-11-09 把 fnOS 现网 1.3.65-test.20261108.5-local5 + 未固化 3 项整体合入
// （commit aa122ea），并转正 FLAG_MODULAR_CORE 默认开（0882ed8）。现网证据在报告与
// 真机日志；本文件是仓库侧的**行为钉**：每条对应报告一项，用 fake DSH + mock OneBot
// 直接打新核心工厂，缺了哪根接线测试就红。
// 尚未拉齐的 legacy 面（引用解析、<reply:n>、模块钩子改写、慢工具提示等）见
// docs/refactor/new-core-parity-ledger.md，不在此假装覆盖。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModularCore } from '../src/host/modular-core.js'
import { checkIdentityLeak } from '../src/chat/identity-guard.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createOneBotClient } from '../src/onebot/client.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }
const OWNER = '10000001'
const BOT = '20000002'

/** 与 m4 同型夹具；coreOver 直插 createModularCore 的新增装配项（现网热修的那些）。 */
async function fixture({ brain = async () => '好呀', cfgOver = {}, coreOver = {}, modsOver = {} } = {}) {
  const mock = await startMockOneBot({ selfId: BOT })
  const dsh = createFakeDsh({ brain })
  const workspaceDir = mkdtempSync(join(tmpdir(), 'm7-ws-'))
  const cfg = {
    enabled: true, dryRun: false, botQQ: BOT, ownerQQ: OWNER, ownerName: '主人',
    allow: { private: [OWNER, '30003'], groups: ['777'] },
    longTasks: false,
    merge: { waitSec: 0.05, maxSec: 0.2, groupWaitSec: 0.05, groupMaxMs: 0.2, groupMaxSec: 0.2 },
    snowluma: { autoStart: false, autoAttach: false },
    workspaceDir, ...cfgOver,
  }
  const onebot = createOneBotClient({
    endpoint: () => ({ httpUrl: mock.httpUrl, wsUrl: '', httpToken: mock.token, wsToken: '' }),
    log: noopLog, retryDelays: [10, 10, 10],
  })
  const core = createModularCore({
    dsh: dsh.ctx, onebot,
    mods: { contextFor: async () => '', commands: () => [], use: () => null, ...modsOver },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
    ...coreOver,
  })
  return { core, dsh, mock, cfg, onebot, workspaceDir }
}

const privEv = (over = {}) => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: Number(BOT), user_id: Number(OWNER), message_id: Math.floor(Math.random() * 1e9),
  time: Math.floor(Date.now() / 1000), sender: { user_id: Number(OWNER), nickname: '主人' },
  message: [{ type: 'text', data: { text: '在吗' } }], ...over,
})
const groupEv = (text = '在吗') => ({
  post_type: 'message', message_type: 'group', sub_type: 'normal',
  self_id: Number(BOT), group_id: 777, user_id: 555, message_id: Math.floor(Math.random() * 1e9),
  time: Math.floor(Date.now() / 1000), sender: { user_id: 555, nickname: '甲' },
  message: [{ type: 'at', data: { qq: Number(BOT) } }, { type: 'text', data: { text: ' ' + text } }],
})

/** 图片 URL 秒回 PNG 字节（同 m4 真机缺陷 10 的桩）；不桩的话新核的 15s 下载超时会拖死等待窗口。 */
function stubPngFetch() {
  const orig = globalThis.fetch
  globalThis.fetch = async (url, opt) => String(url).includes('x/y.png')
    ? { ok: true, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer }
    : orig(url, opt)
  return () => { globalThis.fetch = orig }
}

// —— A6/#6 入站聊天流水：ACL 放行后记一行，出站成功记 bot 行（记忆/蒸馏/黑话/日记的命门）——
test('流水接线：入站 (chatKey,昵称,文本,uid) + 出站成功 bot 行（报告 A 组 #6）', async () => {
  const rows = []
  const { core, mock } = await fixture({ brain: async () => '回你啦', coreOver: { logChat: (...a) => rows.push(a) } })
  try {
    await core.dispatchLegacyEvent(privEv())
    await sleep(600)
    assert.ok(rows.some((r) => r[0] === `private:${OWNER}` && r[1] === '主人' && r[2] === '在吗'), `入站行缺失：${JSON.stringify(rows)}`)
    const bot = rows.find((r) => r[1] === 'bot')
    assert.ok(bot && /回你啦/.test(bot[2]), 'bot 出站行缺失')
  } finally { await core.dispose(); await mock.close() }
})

// —— #17 turnState 说话人登记（新核心不经 pushToSession，之前恒空）——
test('说话人登记：noteSpeakers 收到 sessionId 与 sender 列表（报告 C 组 #17）', async () => {
  const noted = []
  const { core, mock } = await fixture({ coreOver: { noteSpeakers: (sid, senders) => noted.push([sid, senders]) } })
  try {
    await core.dispatchLegacyEvent(privEv())
    await sleep(600)
    const sid = Object.values(core.registry.snapshot())[0]?.sessionId
    assert.ok(sid && noted.some(([s, list]) => s === String(sid) && list.includes(OWNER)), `未登记：${JSON.stringify(noted)}`)
  } finally { await core.dispose(); await mock.close() }
})

// —— #18 偷表情：入站表情/图片交给 stickers.collect 入口（ask 模式由 host 侧拦截，核心只转发）——
test('偷表情接线：collectInboundStickers 收到 (chatKey, segments, userId)（报告 C 组 #18）', async () => {
  const got = []
  const { core, mock } = await fixture({
    coreOver: { collectInboundStickers: (chatKey, segments, userId) => got.push([chatKey, segments.map((s) => s.type), userId]) },
  })
  const restore = stubPngFetch()
  try {
    await core.dispatchLegacyEvent(privEv({ message: [{ type: 'image', data: { url: 'https://x/y.png' } }] }))
    await sleep(600)
    assert.ok(got.some(([, types]) => types.includes('image')), `未收集：${JSON.stringify(got)}`)
  } finally { restore(); await core.dispose(); await mock.close() }
})

// —— #8 面板统计 + recentMedia（开旗后曾恒 0 / 丢失）——
test('统计与 recentMedia：入站 received、出站 sent、媒体段登记（报告 B 组 #8）', async () => {
  const stats = []
  const media = []
  const { core, mock } = await fixture({
    brain: async () => '嗯',
    coreOver: {
      onStats: (k) => stats.push(k),
      noteMedia: (chatKey, segments, userId) => media.push([String(chatKey), segments.map((s) => s.type), String(userId)]),
    },
  })
  const restore = stubPngFetch()
  try {
    await core.dispatchLegacyEvent(privEv({ message: [{ type: 'text', data: { text: '看这张图' } }, { type: 'image', data: { url: 'https://x/y.png' } }] }))
    await sleep(700)
    assert.ok(stats.includes('received'), 'received 计数缺失')
    assert.ok(stats.includes('sent'), 'sent 计数缺失')
    assert.ok(media.some(([ck, types, uid]) => ck === `private:${OWNER}` && types.includes('image') && uid === OWNER), `recentMedia 缺失：${JSON.stringify(media)}`)
  } finally { restore(); await core.dispose(); await mock.close() }
})

// —— A1/#1 模块工具挂载：会话级一次挂载、清单变化整套重挂、系统聊天不挂 ——
test('工具挂载：buildTools 按会话注册进 agent；名字清单变化整套重挂（报告 A 组 #1，26→66 的那条）', async () => {
  let generation = 0
  const buildTools = () => generation === 0
    ? [{ name: 'fake_ping', description: 'd', execute: async () => ({ ok: true }) }]
    : [{ name: 'fake_pong', description: 'd', execute: async () => ({ ok: true }) }]
  const { core, dsh, mock } = await fixture({ brain: async ({ toolNames }) => String(toolNames.includes('fake_pong') ? '有pong' : '有ping'), coreOver: { buildTools } })
  try {
    await core.dispatchLegacyEvent(privEv())
    await sleep(500)
    const sid = Object.values(core.registry.snapshot())[0]?.sessionId
    const agent = dsh.agents.get(sid)
    assert.ok(agent.tools.has('fake_ping'), '首轮未挂 fake_ping')
    generation = 1
    await core.dispatchLegacyEvent(privEv({ message_id: 987654, message: [{ type: 'text', data: { text: '再来' } }] }))
    await sleep(500)
    assert.ok(agent.tools.has('fake_pong') && !agent.tools.has('fake_ping'), '清单变化未整套重挂')
  } finally { await core.dispose(); await mock.close() }
})

// —— #7/3.1 上下文跟轮：holder 键必须是 sessionId（旧代码用 agent 对象键 → 永远冻结在第 1 轮）——
test('上下文跟轮：第 2 轮的 systemPrompt.context 内容是第 2 轮的（报告 3.1，WeakMap→sessionId 键）', async () => {
  let ver = 0
  const { core, dsh, mock } = await fixture({
    brain: async ({ ctxText }) => `看到[${ctxText}]`,
    modsOver: { contextFor: async () => `记忆第${++ver}版` },
  })
  try {
    await core.dispatchLegacyEvent(privEv())
    await sleep(500)
    await core.dispatchLegacyEvent(privEv({ message_id: 13579, message: [{ type: 'text', data: { text: '还有呢' } }] }))
    await sleep(500)
    assert.equal(dsh.turns.length, 2)
    const ctx1 = dsh.turns[0].ctxText
    const ctx2 = dsh.turns[1].ctxText
    assert.match(ctx1, /记忆第1版/, `第1轮上下文异常：${ctx1}`)
    assert.match(ctx2, /记忆第2版(?!.*记忆第1版)/, `上下文冻结或未更新：${ctx2}`)
  } finally { await core.dispose(); await mock.close() }
})

// —— #4/3.2 提示词变量兜底 + 同名 context 被占时「每会话只投一次」的落档路径 ——
test('落档只投一次：sp.context 被宿主占用（热重载残留）→ 第 1 轮拼进消息、第 2 轮不重复（报告 A #4、C #16）', async () => {
  let ver = 0
  const { core, dsh, mock } = await fixture({
    brain: async ({ text }) => `回:${text.slice(0, 8)}`,
    modsOver: { contextFor: async () => `背景板${++ver}` },
  })
  try {
    // 模拟热重载后宿主已占用 qq-hub-context：注册一律抛「已存在」
    const ctrl = dsh.ctx.get('sessionController')
    const orig = ctrl.resolveAgent.bind(ctrl)
    ctrl.resolveAgent = async (sid) => {
      const r = await orig(sid)
      if (r?.agent?.ctx?.systemPrompt) {
        r.agent.ctx.systemPrompt.context = () => { throw new Error('context qq-hub-context 已存在') }
      }
      return r
    }
    await core.dispatchLegacyEvent(privEv())
    await sleep(500)
    await core.dispatchLegacyEvent(privEv({ message_id: 24681, message: [{ type: 'text', data: { text: '第二段' } }] }))
    await sleep(500)
    assert.equal(dsh.turns.length, 2)
    assert.match(dsh.turns[0].userText, /【本聊天背景/, `落档路径未生效：${dsh.turns[0].userText}`)
    assert.doesNotMatch(dsh.turns[1].userText, /【本聊天背景/, '落档内容每轮重复注入（22 轮老毛病复发）')
  } finally { await core.dispose(); await mock.close() }
})

// —— #4(3.2) promptVars：按会话补注册宿主缺失的提示词变量（unknown → 整轮 error 的那条）——
test('promptVars 兜底：sp.variable 按会话补注册 rules 变量（报告 3.2）', async () => {
  const registered = []
  const { core, dsh, mock } = await fixture({
    brain: async () => '好',
    coreOver: { promptVars: { qq_hub_rules_private: () => '私规', qq_hub_rules_social: () => '群规' } },
  })
  try {
    const ctrl = dsh.ctx.get('sessionController')
    const orig = ctrl.resolveAgent.bind(ctrl)
    ctrl.resolveAgent = async (sid) => {
      const r = await orig(sid)
      if (r?.agent?.ctx?.systemPrompt && !r.__spPatched) {
        const sp = r.agent.ctx.systemPrompt
        const v = sp.variable.bind(sp)
        sp.variable = (n, fn) => { registered.push(n); return v(n, fn) }
        r.__spPatched = true
      }
      return r
    }
    await core.dispatchLegacyEvent(privEv())
    await sleep(500)
    assert.ok(registered.includes('qq_hub_rules_private') && registered.includes('qq_hub_rules_social'), `未补注册：${registered}`)
  } finally { await core.dispose(); await mock.close() }
})

// —— #5 语音水合：冻结成员对象 + 网关 fetch_ptt_text → 新对象换段，绝不原地赋值 ——
test('语音水合：record 段经网关转写拼进回合（冻结对象不炸）（报告 A #5 + 1.4）', async () => {
  const { core, dsh, mock } = await fixture({ brain: async ({ text }) => `听到[${text}]` })
  try {
    await core.dispatchLegacyEvent(privEv({ message: [{ type: 'record', data: { file: 'r.slk' } }] }))
    await sleep(800)
    assert.equal(dsh.turns.length, 1, '语音回合未跑起来')
    assert.match(dsh.turns[0].userText, /\[语音\] 今天想吃白米饭/, `未拼出转写文本：${dsh.turns[0].userText}`)
  } finally { await core.dispose(); await mock.close() }
})

// —— #11/#12 富媒体 & 小黄脸整条委托 legacyDeliver ——
test('富媒体出站：带 <sticker:> 或 <face:> 的回复整条交 legacyDeliver（报告 B #11/#12）', async () => {
  const del = []
  const { core, mock } = await fixture({
    brain: async ({ text }) => text.includes('表情') ? '<face:呲牙> 就这个' : '看这个<sticker:测试>',
    coreOver: { legacyDeliver: async (chatId, reply, opts) => { del.push([chatId, reply, opts?.own]); return { state: 'sent' } } },
  })
  try {
    await core.dispatchLegacyEvent(privEv({ message: [{ type: 'text', data: { text: '发个表情' } }] }))
    await sleep(500)
    assert.ok(del.some(([, r]) => /<face:呲牙>/.test(r)), `<face:> 未委托 legacy：${JSON.stringify(del)}`)
    await core.dispatchLegacyEvent(privEv({ message_id: 333444, message: [{ type: 'text', data: { text: '发个贴纸' } }] }))
    await sleep(500)
    assert.ok(del.some(([, r]) => /<sticker:测试>/.test(r)), `<sticker:> 未委托 legacy：${JSON.stringify(del)}`)
    const rawSends = JSON.stringify(mock.sent('send_private_msg'))
    assert.doesNotMatch(rawSends, /face:|sticker:/, '原始标记漏发给 QQ')
  } finally { await core.dispose(); await mock.close() }
})

// —— #14/#15 预算守门员：新核心优先的 resetChat / chatKeyOfSession 反查 ——
test('resetChat 走新核心：归档 + 忘映射，反查 chatKey；unknown 会话返回 false（报告 B #14/#15）', async () => {
  const { core, dsh, mock } = await fixture({ brain: async () => '嗯' })
  try {
    await core.dispatchLegacyEvent(privEv())
    await sleep(500)
    const entry = core.registry.snapshot()[`private:${OWNER}`]
    assert.ok(entry?.sessionId, '首轮未建会话映射')
    assert.equal(core.chatKeyOfSession(entry.sessionId), `private:${OWNER}`, 'chatKeyOfSession 反查失败')
    assert.equal(core.resetChat(`private:${OWNER}`), true, 'resetChat 应成功')
    assert.equal(core.registry.snapshot()[`private:${OWNER}`], undefined, '映射未忘')
    assert.equal(core.resetChat(`private:${OWNER}`), false, '已忘的会话应返回 false')
    // 下一条消息开新会话（token-guardian 压缩生效的前提）
    await core.dispatchLegacyEvent(privEv({ message_id: 556677, message: [{ type: 'text', data: { text: '新的一轮' } }] }))
    await sleep(500)
    const fresh = core.registry.snapshot()[`private:${OWNER}`]
    assert.ok(fresh?.sessionId && fresh.sessionId !== entry.sessionId, '重置后未开新会话')
  } finally { await core.dispose(); await mock.close() }
})

// —— #10 身份闸私聊放宽：allowBareNumbers 只放裸号码，known-id 照拦 ——
test('身份闸：私聊 allowBareNumbers 放行端口/ID 长数字，known-id 与群聊仍拦（报告 B #10）', () => {
  const report = '部署说明：网关端口 13080，任务单 88930771，详见端口 11029 与批次 44200117。'
  const ig = checkIdentityLeak(report, { surface: '私聊消息', ids: ['10000001', '20000002'], allowIds: ['10000001'], allowBareNumbers: true, mode: 'block' })
  assert.equal(ig.ok, true, `私聊报告仍被吞：${ig.message}`)
  const inGroup = checkIdentityLeak(report, { surface: '群消息', ids: ['10000001', '20000002'], allowIds: ['777'], allowBareNumbers: false, mode: 'block' })
  assert.equal(inGroup.ok, false, '群聊裸号码必须仍拦')
  const leakKnown = checkIdentityLeak('他的号是 10001 楼主的 30003', { surface: '私聊消息', ids: ['30003'], allowIds: ['10000001'], allowBareNumbers: true, mode: 'block' })
  assert.equal(leakKnown.ok, false, 'known-id 形态不得被放宽吞掉')
})

// —— 转正补齐：回合开始亮「正在输入」（legacy 有、现网新核心此前没有）——
test('typing 平账：私聊回合亮 set_input_status(1)，群聊不亮（e2e #194 牵出的平账项）', async () => {
  const { core, mock } = await fixture({ brain: async () => '稍等就好' })
  try {
    await core.dispatchLegacyEvent(privEv())
    await sleep(600)
    const pings = mock.calls.filter((c) => c.action === 'set_input_status')
    assert.ok(pings.some((c) => c.params.user_id === Number(OWNER) && c.params.event_type === 1), '私聊未亮 typing')
    await core.dispatchLegacyEvent(groupEv('看看这个'))
    await sleep(600)
    const groupPings = mock.calls.filter((c) => c.action === 'set_input_status' && String(c.params.user_id) === '555')
    assert.equal(groupPings.length, 0, '群聊不该亮 typing')
  } finally { await core.dispose(); await mock.close() }
})
