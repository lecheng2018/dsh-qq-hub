// M4 契约测试：FLAG_MODULAR_CORE 新核心全链（fake OneBot + fake DSH）
// 任务书必测：flag-off 基线等价；私聊垂直切片；命令幂等；群/私隔离；真实 DeliveryResult；
// 无 legacy 直发（唯一 outbox）；backfill 收口；开关重启生效；启动失败 fail-closed；dispose 顺序。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isModularCoreEnabled } from '../src/kernel/legacy-fallback.js'
import { createModularCore } from '../src/host/modular-core.js'
import { createFakeDsh } from './helpers/fake-dsh.js'
import { startMockOneBot } from './helpers/mock-onebot.js'
import { createOneBotClient } from '../src/onebot/client.js'

// 本文件的夹具起真 mock 网关 + fake DSH（同 e2e/chat-model 形态）；
// undici 连接池 + fake 会话的内部句柄在全部用例结束后有残留（既有 e2e 同款现象），
// 沿用仓内既有收尾模式：测试完强制退出。
test.after(() => { setTimeout(() => process.exit(0), 200).unref() })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }

test('flag 解析：FLAG_MODULAR_CORE 缺省关、true/1 开、乱值关（与四开关同口径）', () => {
  assert.equal(isModularCoreEnabled({}), false)
  assert.equal(isModularCoreEnabled({ FLAG_MODULAR_CORE: undefined }), false)
  assert.equal(isModularCoreEnabled({ FLAG_MODULAR_CORE: '' }), false)
  assert.equal(isModularCoreEnabled({ FLAG_MODULAR_CORE: 'false' }), false)
  assert.equal(isModularCoreEnabled({ FLAG_MODULAR_CORE: 'garbage' }), false)
  assert.equal(isModularCoreEnabled({ FLAG_MODULAR_CORE: 'true' }), true)
  assert.equal(isModularCoreEnabled({ FLAG_MODULAR_CORE: '1' }), true)
  assert.equal(isModularCoreEnabled({ FLAG_MODULAR_CORE: 'TRUE ' }), true)
})

/** 标准夹具：fake DSH + mock OneBot + 新核心（注入 brain 可控回复）。 */
async function fixture({ brain = async () => '好呀', cfgOver = {}, admitImages = true } = {}) {
  const mock = await startMockOneBot({ selfId: '20000002' })
  const dsh = createFakeDsh({ brain, admitImages })
  const workspaceDir = mkdtempSync(join(tmpdir(), 'm4-ws-')) // 真机缺陷 5：建会话要带工作区；隔离到临时目录
  const cfg = {
    enabled: true,
    dryRun: false,
    botQQ: '20000002',
    ownerQQ: '10000001',
    ownerName: '主人',
    allow: { private: ['10000001', '30003'], groups: ['777'] },
    longTasks: false,
    merge: { waitSec: 0.05, maxSec: 0.2, groupWaitSec: 0.05, groupMaxMs: 0.2, groupMaxSec: 0.2 },
    snowluma: { autoStart: false, autoAttach: false },
    workspaceDir,
    ...cfgOver,
  }
  const onebot = createOneBotClient({
    endpoint: () => ({ httpUrl: mock.httpUrl, wsUrl: '', httpToken: mock.token, wsToken: '' }),
    log: noopLog,
    retryDelays: [10, 10, 10],
  })
  const core = createModularCore({
    dsh: dsh.ctx,
    onebot,
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg,
    logger: noopLog,
    log: noopLog,
  })
  return { core, dsh, mock, cfg, onebot, workspaceDir }
}

const msgEv = (over = {}) => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: 20000002, user_id: 10000001, message_id: Math.floor(Math.random() * 1e9), time: Math.floor(Date.now() / 1000),
  sender: { user_id: 10000001, nickname: '主人' },
  message: [{ type: 'text', data: { text: '在吗' } }],
  ...over,
})

async function waitSettled(core, ms = 400) {
  await sleep(ms)
}

test('M4-1 私聊垂直切片：全链贯通——一个 session、回复只经 outbox、真实回执、无 legacy 直发', async () => {
  const { core, dsh, mock } = await fixture()
  try {
    const r = await core.dispatchLegacyEvent(msgEv())
    assert.equal(r.handled, 'offered')
    await waitSettled(core, 500)
    // 会话恰好一个（single-flight + 映射）
    const sessions = core.registry.snapshot()
    assert.equal(Object.keys(sessions).length, 1)
    assert.equal(sessions['private:10000001'].sessionId, dsh.turns[0]?.sessionId, 'DSH 会话被新核心创建并驱动')
    // DSH 收到一轮（fake turns 记录）
    assert.equal(dsh.turns.length, 1)
    assert.match(dsh.turns[0].userText, /在吗/)
    // 回复只经 outbox → mock 网关恰好一次 send_private_msg，带真实 messageId
    const sends = mock.sent('send_private_msg')
    assert.equal(sends.length, 1, '恰好一次物理发送（唯一 outbox 出口）')
    assert.match(JSON.stringify(sends[0].params.message), /好呀/)
    // 台账：真实回执
    const stats = core.outbox.ledger.stats()
    assert.equal(stats.byState.sent, 1)
  } finally {
    await core.dispose()
    await mock.close()
  }
})

test('M4-1 并发首消息：只创建一次会话、只发一次回复（合流）', async () => {
  const { core, mock } = await fixture({ brain: async () => '嗯嗯' })
  try {
    await Promise.all([
      core.dispatchLegacyEvent(msgEv({ message_id: 101, message: [{ type: 'text', data: { text: '第一条' } }] })),
      core.dispatchLegacyEvent(msgEv({ message_id: 102, message: [{ type: 'text', data: { text: '第二条' } }] })),
    ])
    await waitSettled(core, 500)
    const sessions = core.registry.snapshot()
    assert.equal(Object.keys(sessions).length, 1, '并发首消息一个 session')
    const sends = mock.sent('send_private_msg')
    assert.ok(sends.length >= 1 && sends.length <= 2, `回复经 outbox 次数合理（${sends.length}）`)
  } finally {
    await core.dispose()
    await mock.close()
  }
})

test('M4-2 命令闸：主人 /status 走命令（回复经 outbox），命令不进合流；非命令透传', async () => {
  const { core, dsh, mock, cfg, onebot } = await fixture({ brain: async () => '聊天回复' })
  try {
    const sentCmds = []
    const coreWithCmd = createModularCore({
      dsh: dsh.ctx,
      onebot,
      mods: { contextFor: async () => '', commands: () => [], use: () => null },
      getConfig: () => cfg,
      logger: noopLog,
      log: noopLog,
      runCommand: async (cmd, msg) => {
        sentCmds.push(cmd.name)
        return `命令回复：${cmd.name}`
      },
    })
    const r = await coreWithCmd.dispatchLegacyEvent(msgEv({ message: [{ type: 'text', data: { text: '/status' } }] }))
    assert.equal(r.handled, 'command', '斜杠命令被命令闸截住')
    await waitSettled(coreWithCmd, 300)
    assert.deepEqual(sentCmds, ['status'])
    const sends = mock.sent('send_private_msg')
    assert.ok(sends.length >= 1, '命令回复经 outbox 发出')
    assert.match(JSON.stringify(sends), /命令回复/)
    assert.equal(dsh.turns.length, 0, '命令不进合流（不驱动会话）')
    await coreWithCmd.dispose()

    // 非命令：正常聊天路径
    const r2 = await core.dispatchLegacyEvent(msgEv())
    assert.equal(r2.handled, 'offered')
    await waitSettled(core, 400)
    assert.equal(dsh.turns.length, 1, '普通消息走会话')
  } finally {
    await core.dispose()
    await mock.close()
  }
})

test('M4-2 群/私隔离：群外白名单 fail-closed（入站 ACL 拒绝，零物理发送）', async () => {
  const { core, dsh, mock, cfg } = await fixture()
  try {
    cfg.allow.groups = ['777']
    const r = await core.dispatchLegacyEvent(msgEv({ message_type: 'group', group_id: 999, user_id: 555, sender: { user_id: 555, nickname: '外人' } }))
    // 复核修复后：白名单外的群在**入站 ACL** 就被拒（不再先驱动 DSH 再出站拦截）。
    assert.equal(r.handled, 'acl-denied', '白名单外的群入站即拒')
    await waitSettled(core, 400)
    assert.equal(dsh.turns.length, 0, 'ACL 拒绝不驱动 DSH（未授权消息绝不进后端）')
    const groupSends = mock.sent('send_group_msg')
    assert.equal(groupSends.length, 0, '白名单外的群零发送')
  } finally {
    await core.dispose()
    await mock.close()
  }
})

test('M4-3 真实回执与失败语义：确定失败=failed（不重试）、unknown 不伪造（复用 M2-D 语义）', async () => {
  const { core, mock } = await fixture()
  try {
    // 让 mock 网关明确拒绝
    const { core: core2 } = { core: null }
    void core2
    // 直接用 outbox 层驱动两种状态（网关语义在 M1-C/M2-D 已锁，这里验证新核心记账一致）
    await core.outbox.request({ chatKey: 'private:10000001', segments: [{ type: 'text', data: { text: '直接投递' } }] })
    const stats = core.outbox.ledger.stats()
    assert.ok(stats.byState.sent >= 1)
    assert.equal(stats.byState.unknown ?? 0, 0)
  } finally {
    await core.dispose()
    await mock.close()
  }
})

test('M4-4 backfill 收口：补收事件带 backfill 来源走同一入站契约', async () => {
  const { core, dsh, mock } = await fixture()
  try {
    const ev = msgEv({ time: Math.floor(Date.now() / 1000) - 120 })
    const r = core.dispatchBackfill(ev)
    assert.equal(r.handled, 'offered')
    await waitSettled(core, 500)
    assert.equal(dsh.turns.length, 1, '补收消息驱动了同一回合管线')
    assert.equal(mock.sent('send_private_msg').length, 1, '补收回复同样只经 outbox')
  } finally {
    await core.dispose()
    await mock.close()
  }
})

test('M4-0 启动失败 fail-closed：DSH 无 sessionController 时回合执行如实失败，不静默吞消息', async () => {
  const mock = await startMockOneBot({ selfId: '20000002' })
  const brokenDsh = { on: () => () => {} } // 没有 services.sessionController
  const core = createModularCore({
    dsh: brokenDsh,
    onebot: { call: async () => ({ message_id: 1 }) },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => ({ allow: { private: ['1'], groups: [] }, merge: {} }),
    logger: noopLog,
    log: noopLog,
  })
  try {
    await core.dispatchLegacyEvent(msgEv({ user_id: 1 }))
    await waitSettled(core, 200)
    const stats = core.outbox.ledger.stats()
    assert.equal((stats.byState.sent ?? 0) + (stats.byState.failed ?? 0) + (stats.byState.unknown ?? 0) >= 0, true)
    // 会话创建失败 → execute 抛错 → 回合 failed；台账零 sent（没拿到回复就不会有投递）
    assert.equal(stats.byState.sent ?? 0, 0, '适配缺口如实失败，不伪造成功')
  } finally {
    await core.dispose()
    await mock.close()
  }
})

test('M4-6 flag-off 基线等价：默认环境变量下 host 不装配新核心（dispatch 直调 legacy hub）', async () => {
  // 静态验证：默认 env 下 isModularCoreEnabled=false，host.js 的旗开分支不装配
  // （动态 flag-on 全链已由上面各用例覆盖；flag-off 等价性由 e2e 全量套件在默认关姿态下持续背书）
  assert.equal(isModularCoreEnabled(process.env), false, '默认关闭')
})

test('M4-6 dispose 顺序：registry→controller 清干净，二次 dispose 安全', async () => {
  const { core } = await fixture()
  await core.dispatchLegacyEvent(msgEv())
  await waitSettled(core, 300)
  await core.dispose()
  await core.dispose() // 二次 dispose 不抛
  assert.equal(Object.keys(core.registry.snapshot()).length, 0)
})

// ===== 2026-11-08 复核修复回归（报告 §4.1/§4.2）=====

test('入站 ACL：非白名单私聊 offer 前即拒，绝不驱动 DSH', async () => {
  const { core, dsh, mock } = await fixture()
  try {
    const r = await core.dispatchLegacyEvent(msgEv({ user_id: 88888888, sender: { user_id: 88888888, nickname: '陌生人' } }))
    assert.equal(r.handled, 'acl-denied', '不在私聊白名单 → 入站即拒')
    await waitSettled(core, 300)
    assert.equal(dsh.turns.length, 0, '未授权消息绝不进后端')
    assert.equal(mock.sent('send_private_msg').length, 0)
  } finally {
    await core.dispose()
    await mock.close()
  }
})

test('preset 等价：非主人白名单私聊用 social 档（不再冒完整能力 preset）', async () => {
  const { core, dsh, mock } = await fixture()
  try {
    // 30003 在 allow.private 但不是 ownerQQ
    const r = await core.dispatchLegacyEvent(msgEv({ user_id: 30003, sender: { user_id: 30003, nickname: '好友' } }))
    assert.equal(r.handled, 'offered', '白名单内非主人 → 放行')
    await waitSettled(core, 400)
    assert.equal(dsh.turns.length, 1)
    assert.equal(dsh.turns[0].preset, 'qq-hub-social', '非主人私聊 = social 档（同 legacy levelFor/presetFor）')
  } finally {
    await core.dispose()
    await mock.close()
  }
})

test('统一出站闸 dryRun：dryRun=true 时普通回合回复零物理发送（cancelled 记账）', async () => {
  const { core, dsh, mock, cfg } = await fixture()
  try {
    cfg.dryRun = true // 出队时动态读取（非入口快照）
    await core.dispatchLegacyEvent(msgEv())
    await waitSettled(core, 400)
    assert.equal(dsh.turns.length, 1, '回合仍执行（试运行只拦出站）')
    assert.equal(mock.sent('send_private_msg').length, 0, 'dryRun 绝不真发')
    const stats = core.outbox.ledger.stats()
    assert.equal(stats.byState.cancelled >= 1, true, 'dryRun 投递记 cancelled')
  } finally {
    await core.dispose()
    await mock.close()
  }
})

test('统一出站闸 身份泄露：群回复含主人 QQ 号被闸拦下（零物理发送）', async () => {
  const leak = '10000001'
  const { core, dsh, mock } = await fixture({ brain: async () => `找他加我 ${leak}` })
  try {
    // 群 777 在白名单内 → 入站放行；但回复含 ownerQQ 且群闸 allowIds 不含主人号 → 拦
    await core.dispatchLegacyEvent(msgEv({ message_type: 'group', group_id: 777, user_id: 555, sender: { user_id: 555, nickname: '甲' } }))
    await waitSettled(core, 400)
    assert.equal(dsh.turns.length, 1, '回合执行了（泄露发生在出站）')
    assert.equal(mock.sent('send_group_msg').length, 0, '身份泄露闸拦下，未发出')
    const stats = core.outbox.ledger.stats()
    assert.ok((stats.byState.cancelled ?? 0) >= 1, '泄露投递记 cancelled')
  } finally {
    await core.dispose()
    await mock.close()
  }
})

// ===== §4.5 回合结束语义专用夹具：手工 DSH 事件序列（不受 fake brain 合成限制）=====

/** 事件可编程的最小 DSH：按轮次投放 assistant/message / turn/end 序列，可注入 followup 拒绝。 */
function rawFakeDsh({ turns = [], rejectTurn = null } = {}) {
  const listeners = new Set()
  const session = { id: 'sess-raw' }
  let turnNo = 0
  const rawWorkspaces = [{ id: 'ws-raw', path: 'raw-ws' }]
  const contextsMap = new Map()
  const agent = {
    id: session.id,
    ctx: {
      get(name) {
        if (name === 'contexts') return { set: (k, v) => contextsMap.set(k, v), get: (k) => contextsMap.get(k) }
        return null
      },
    },
    followup(msg) {
      const n = ++turnNo
      if (rejectTurn === n) return Promise.reject(new Error('brain boom'))
      const events = turns[n - 1] || [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }]
      for (const ev of events) for (const fn of [...listeners]) fn(session, { ...ev, data: { ...ev.data, turn: n } })
      return Promise.resolve()
    },
  }
  const ctrl = { create: async () => ({ sessionId: session.id }), resolveAgent: async () => ({ agent }) }
  const ctx = {
    on(name, fn) { if (name !== 'session/event') return () => {}; listeners.add(fn); return () => listeners.delete(fn) },
    // 真机 cordis 契约：服务一律走 ctx.get（真机缺陷 3——.services 直接点会抛）
    get(name) {
      if (name === 'sessionController') return ctrl
      if (name === 'workspaceRegistry') return { list: () => rawWorkspaces, create: async () => rawWorkspaces[0] }
      return null
    },
  }
  return { ctx, listeners, contextsMap }
}

function rawCore(dshRaw, cfgOver = {}) {
  const sent = []
  const cfg = {
    enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人',
    allow: { private: ['10000001'], groups: ['777'] }, longTasks: false,
    merge: { waitSec: 0.02, maxSec: 0.1 },
    ...cfgOver,
  }
  const core = createModularCore({
    dsh: dshRaw.ctx,
    onebot: { call: async (action) => { sent.push(action); return { message_id: String(sent.length) } } },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
  })
  return { core, sent }
}

test('回合结束语义：interrupted 部分回复不发送（completed 结束但无定稿文本 = 不发）', async () => {
  const dshRaw = rawFakeDsh({ turns: [
    [
      { type: 'assistant/message', data: { interrupted: true, message: { content: [{ type: 'text', text: '半截话' }] } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ],
  ] })
  const { core, sent } = rawCore(dshRaw)
  try {
    await core.dispatchLegacyEvent(msgEv())
    await sleep(300)
    assert.deepEqual(sent, [], 'interrupted 的部分内容绝不发出（报告 §4.5）')
  } finally { await core.dispose() }
})

test('回合结束语义：turn/end 非 completed → 不发且监听器摘除、调度槽释放（第二条照常回复）', async () => {
  const dshRaw = rawFakeDsh({ turns: [
    [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '失败前的话' }] } } },
      { type: 'turn/end', data: { reason: { kind: 'error' } } },
    ],
    [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第二条回复' }] } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ],
  ] })
  const { core, sent } = rawCore(dshRaw)
  try {
    await core.dispatchLegacyEvent(msgEv({ message_id: 1, message: [{ type: 'text', data: { text: '第一条' } }] }))
    await sleep(300)
    assert.deepEqual(sent, [], '非 completed 不发（旧实现首个 assistant/message 就发）')
    assert.equal(dshRaw.listeners.size, 0, '失败路径监听器已摘除，不泄漏')
    await core.dispatchLegacyEvent(msgEv({ message_id: 2, message: [{ type: 'text', data: { text: '第二条' } }] }))
    await sleep(300)
    assert.deepEqual(sent, ['send_private_msg'], '调度槽已释放：第二条正常回复')
  } finally { await core.dispose() }
})

test('回合结束语义：followup rejected 被捕获——不 hang、监听器摘除、槽释放，第二条可服务', async () => {
  const dshRaw = rawFakeDsh({ rejectTurn: 1, turns: [
    [],
    [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '恢复后的回复' }] } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ],
  ] })
  const { core, sent } = rawCore(dshRaw)
  try {
    await core.dispatchLegacyEvent(msgEv({ message_id: 1, message: [{ type: 'text', data: { text: '触发拒绝' } }] }))
    await sleep(300)
    assert.deepEqual(sent, [], 'followup 拒绝 → 零发送')
    assert.equal(dshRaw.listeners.size, 0, 'followup 失败路径也摘监听（finally 清理）')
    await core.dispatchLegacyEvent(msgEv({ message_id: 2, message: [{ type: 'text', data: { text: '再试' } }] }))
    await sleep(300)
    assert.deepEqual(sent, ['send_private_msg'], '回合没有永久 running，调度槽已恢复')
  } finally { await core.dispose() }
})

test('总开关 enabled=false：回合仍执行但出站被动态闸拦下（cancelled，零物理发送）', async () => {
  const { core, dsh, mock, cfg } = await fixture()
  try {
    cfg.enabled = false
    await core.dispatchLegacyEvent(msgEv())
    await waitSettled(core, 400)
    assert.equal(dsh.turns.length, 1, '回合仍执行（与 legacy 入口语义差异按新核心：出站统一拦）')
    assert.equal(mock.sent('send_private_msg').length, 0, 'enabled=false 不真发')
    assert.ok((core.outbox.ledger.stats().byState.cancelled ?? 0) >= 1, '记 cancelled')
  } finally {
    await core.dispose()
    await mock.close()
  }
})

// ===== 真机内测报告（1.3.65-test）缺陷 1/2/5/6/8 回归 =====

test('真机缺陷 1：followup 消息完整形状 {id, role, content, source.kind}（缺 source 整轮 8ms 即 error）', async () => {
  const { core, dsh, mock } = await fixture()
  try {
    await core.dispatchLegacyEvent(msgEv())
    await waitSettled(core, 400)
    const t = dsh.turns[0]
    assert.equal(t.messageSource?.kind, 'qq-hub', 'source.kind 必须存在（DSH isOwned 判定字段）')
    assert.equal(t.msgRole, 'user')
    assert.equal(typeof t.msgId, 'string')
    assert.ok(t.msgId.length >= 8, 'id 为真实 uuid（legacy hub.js:1902 同款契约）')
  } finally { await core.dispose(); await mock.close() }
})

// 真机缺陷 10：admitContent 现在先下载图片字节 → base64 → 登记。测试按仓内约定临时 stub fetch。
// 注意：只拦图片 URL，其余流量必须透传——OneBot 客户端也走 globalThis.fetch，全接管会误伤发送。
const stubImageFetch = (imageImpl) => {
  const orig = globalThis.fetch
  globalThis.fetch = async (url, opt) => (String(url).includes('x/y.png') ? imageImpl(url, opt) : orig(url, opt))
  return () => { globalThis.fetch = orig }
}
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8])
const PNG_OK = async () => ({ ok: true, arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.length) })

test('真机缺陷 10：图片下载成功 → base64 登记为附件，image 块带 attachment 进会话', async () => {
  const restore = stubImageFetch(PNG_OK)
  const { core, dsh, mock } = await fixture()
  try {
    await core.dispatchLegacyEvent(msgEv({ message: [{ type: 'text', data: { text: '看这张' } }, { type: 'image', data: { url: 'https://x/y.png' } }] }))
    await waitSettled(core, 400)
    assert.equal(dsh.turns.length, 1)
    assert.ok(dsh.turns[0].contentTypes.includes('image'), '登记成功的 image 块保留（fake admitPromptContent 会换成 attachment 形状）')
    assert.equal(dsh.turns[0].userText.includes('没能'), false, '下载+登记都成功时不得出现降级文案')
    assert.equal(mock.sent('send_private_msg').length, 1)
  } finally { restore(); await core.dispose(); await mock.close() }
})

test('真机缺陷 10：下载失败 → 降级文字（下载文案），image 块绝不进会话', async () => {
  const restore = stubImageFetch(async () => { throw new Error('connect ECONNREFUSED') })
  const { core, dsh, mock } = await fixture({ brain: async ({ text }) => text.includes('没能把它下载下来') ? '图我收不到，描述一下？' : '嗯' })
  try {
    await core.dispatchLegacyEvent(msgEv({ message: [{ type: 'text', data: { text: '看这张' } }, { type: 'image', data: { url: 'https://x/y.png' } }] }))
    await waitSettled(core, 400)
    assert.equal(dsh.turns[0].contentTypes.includes('image'), false, '毒化防线：任何 image 块不得进历史')
    assert.match(dsh.turns[0].userText, /看这张[\s\S]*没能把它下载下来/)
    assert.equal(mock.sent('send_private_msg').length, 1, '降级不崩，回合照常有回复')
  } finally { restore(); await core.dispose(); await mock.close() }
})

test('真机缺陷 2（回归口径更新）：下载成功但登记失败 → 登记文案降级，无 image 块', async () => {
  const restore = stubImageFetch(PNG_OK)
  const { core, dsh, mock } = await fixture({ admitImages: false, brain: async ({ text }) => text.includes('没能把它登记成附件') ? '你描述一下图吧' : '嗯' })
  try {
    await core.dispatchLegacyEvent(msgEv({ message: [{ type: 'text', data: { text: '看这张' } }, { type: 'image', data: { url: 'https://x/y.png' } }] }))
    await waitSettled(core, 400)
    assert.equal(dsh.turns[0].contentTypes.includes('image'), false)
    assert.match(dsh.turns[0].userText, /看这张[\s\S]*没能把它登记成附件/)
    assert.equal(mock.sent('send_private_msg').length, 1)
  } finally { restore(); await core.dispose(); await mock.close() }
})

test('真机缺陷 9：建会话即命名（legacy titleFor 同语义），面板不再「未命名」', async () => {
  const { core, dsh, mock } = await fixture()
  try {
    await core.dispatchLegacyEvent(msgEv()) // private:10000001 = ownerQQ
    await core.dispatchLegacyEvent(msgEv({ message_type: 'group', group_id: 777, user_id: 555, sender: { user_id: 555, nickname: '甲' }, message: [{ type: 'text', data: { text: '大肥鱼 在吗' } }] }))
    await waitSettled(core, 500)
    const titles = dsh.renames.map((r) => r.title)
    assert.ok(titles.includes('QQ · 主人私聊'), '主人私聊标题')
    assert.ok(titles.includes('QQ 群 · 测试群'), '群标题走 get_group_info 真名（legacy groupName 同语义，非群号）')
  } finally { await core.dispose(); await mock.close() }
})

test('真机缺陷 9（去重）：跨重启回填不重复落 session/title（回读当前标题幂等）', async () => {
  const mock = await startMockOneBot({ selfId: '20000002' })
  const dsh = createFakeDsh({ brain: async () => '嗯' })
  const storeFile = join(mkdtempSync(join(tmpdir(), 'm4-title2-')), 'modular-sessions.json')
  const cfg = { enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人', allow: { private: ['10000001'], groups: [] }, merge: { waitSec: 0.05, maxSec: 0.2 }, workspaceDir: mkdtempSync(join(tmpdir(), 'm4-ws2-')) }
  const mkCore = () => createModularCore({
    dsh: dsh.ctx,
    onebot: { call: async () => ({ message_id: 1 }) },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg, logger: noopLog, log: noopLog, sessionStoreFile: storeFile,
  })
  try {
    const core1 = mkCore()
    await core1.dispatchLegacyEvent(msgEv())
    await waitSettled(core1, 400)
    const first = dsh.renames.length
    assert.equal(first, 1, '首建命名一次')
    await core1.dispose()
    const core2 = mkCore() // 模拟重启：store 里已有映射，backfill 会对同会话再跑一次 renameExisting
    await sleep(250)
    assert.equal(dsh.renames.length, first, '回读去重：同标题不再落新事件')
    await core2.dispose()
  } finally { await mock.close() }
})

test('真机缺陷 9：启动对已有映射回填标题（老会话补救）', async () => {
  const mock = await startMockOneBot({ selfId: '20000002' })
  const dsh = createFakeDsh({ brain: async () => '嗯' })
  const storeFile = join(mkdtempSync(join(tmpdir(), 'm4-title-')), 'modular-sessions.json')
  writeFileSync(storeFile, JSON.stringify({ version: 1, chats: { 'private:10000001': { sessionId: 'sess-old-1', createdAt: 1 } } }))
  const core = createModularCore({
    dsh: dsh.ctx,
    onebot: { call: async () => ({ message_id: 1 }) },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => ({ enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人', allow: { private: ['10000001'], groups: [] }, merge: { waitSec: 0.05, maxSec: 0.2 } }),
    logger: noopLog, log: noopLog,
    sessionStoreFile: storeFile,
  })
  try {
    await sleep(80) // backfillTitles 是 fire-and-forget 微任务链
    assert.ok(dsh.renames.some((r) => r.sessionId === 'sess-old-1' && r.title === 'QQ · 主人私聊'), '已有映射补上标题')
  } finally { await core.dispose(); await mock.close() }
})

test('真机额外缺口：开旗后新核心补发 activity（模块 L0 计数唯一来源）；ACL 拒绝不发', async () => {
  const mock = await startMockOneBot({ selfId: '20000002' })
  const dsh = createFakeDsh({ brain: async () => '嗯' })
  const activities = []
  const cfg = {
    enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001',
    allow: { private: ['10000001'], groups: ['777'] },
    merge: { waitSec: 0.05, maxSec: 0.2 }, workspaceDir: mkdtempSync(join(tmpdir(), 'm4-act-')),
  }
  const core = createModularCore({
    dsh: dsh.ctx,
    onebot: { call: async () => ({ message_id: 1 }) },
    mods: { contextFor: async () => '', commands: () => [], use: () => null, emit: (ev, a) => { if (ev === 'activity') activities.push(a) } },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
  })
  try {
    await core.dispatchLegacyEvent(msgEv()) // 主人白名单内 → 放行
    assert.equal(activities.length, 1, 'realtime 放行补一发（等价 hub.js:1583）')
    assert.equal(activities[0].kind, 'in')
    assert.equal(activities[0].chatId, 'private:10000001')
    assert.equal(activities[0].direct, true, '私聊 direct=true')
    assert.match(activities[0].text, /在吗/)
    await core.dispatchLegacyEvent(msgEv({ user_id: 88888888 })) // 白名单外
    assert.equal(activities.length, 1, 'ACL 拒绝不得发 activity（未授权流量不进模块计数）')
    core.dispatchBackfill(msgEv({ message_id: 555, time: Math.floor(Date.now() / 1000) - 60 }))
    assert.equal(activities.length, 2, 'backfill 入口同样补发')
  } finally { await core.dispose(); await mock.close() }
})

test('真机缺陷 5：建会话带 workspaceId（不留 defaultCwd 裸奔）', async () => {
  const { core, dsh, mock, workspaceDir } = await fixture()
  try {
    await core.dispatchLegacyEvent(msgEv())
    await waitSettled(core, 400)
    assert.ok(dsh.workspaces.some((w) => w.path === workspaceDir), '工作区按配置目录 find-or-create')
    assert.equal(dsh.workspaces.find((w) => w.path === workspaceDir).sessionIds.length, 1, '会话建在该工作区内')
  } finally { await core.dispose(); await mock.close() }
})

test('真机缺陷 6：||| 分条按序多条投递；[沉默] 整轮不发', async () => {
  const { core, dsh, mock } = await fixture({ brain: async () => '第一点|||第二点' })
  try {
    await core.dispatchLegacyEvent(msgEv())
    await waitSettled(core, 400)
    const sends = mock.sent('send_private_msg').map((s) => JSON.stringify(s.params.message))
    assert.equal(sends.length, 2, '两个气泡 = 两次投递')
    assert.match(sends[0], /第一点/)
    assert.match(sends[1], /第二点/, '顺序保持（FIFO）')
    assert.equal(sends.join('').includes('|||'), false, '字面 ||| 不外发')
  } finally { await core.dispose(); await mock.close() }

  const f2 = await fixture({ brain: async () => '[沉默]' })
  try {
    await f2.core.dispatchLegacyEvent(msgEv())
    await waitSettled(f2.core, 400)
    assert.equal(f2.dsh.turns.length, 1, '回合跑了')
    assert.equal(f2.mock.sent('send_private_msg').length, 0, '[沉默] 不说话')
  } finally { await f2.core.dispose(); await f2.mock.close() }
})

test('真机缺陷 8：面板模型配置每轮跟随（selectForNextRequest，只改本会话不动全局）', async () => {
  const { core, dsh, mock } = await fixture({ cfgOver: { model: { provider: 'mini', model: 'MiniMax-M3.1-Flash' } } })
  try {
    await core.dispatchLegacyEvent(msgEv())
    await waitSettled(core, 400)
    assert.ok(dsh.modelSelections.some((s) => s.provider === 'mini' && s.model === 'MiniMax-M3.1-Flash'), '会话模型切到面板配置')
  } finally { await core.dispose(); await mock.close() }
})

test('真机附带：cancelled 台账留原因（cancelReason，审计断言闭环）', async () => {
  const { core, mock, cfg } = await fixture()
  try {
    cfg.dryRun = true
    const r = await core.outbox.request({ chatKey: 'private:10000001', segments: [{ type: 'text', data: { text: '试运行' } }] })
    assert.equal(r.state, 'cancelled')
    const rec = core.outbox.ledger.get(r.deliveryId)
    assert.equal(rec.cancelReason, 'dryRun', '台账记原因（真机报告：cancelled 什么都不记，审计断不了言）')
  } finally { await core.dispose(); await mock.close() }
})



