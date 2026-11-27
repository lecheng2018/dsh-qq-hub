// 413 / 请求体过大自愈（fix/llm-413-auto-reset）：
// DeepSeek 服务端按会话计「上下文 + 图片」硬上限（真机 2026-11-19：
// 413 plugin_request_too_large「本次对话上下文或图片过大……插件内存上限 64 MiB」）。
// DSH 把 413 归类 INVALID_REQUEST（不重试），旧会话的历史每轮重放 → 之后每一轮必然 413，
// 会话永久卡死。修复：识别这类失败 → 提示用户 → 下一条消息进入时归档旧会话自动重建。
//
// 断言面（全部走真实入口 dispatchLegacyEvent，不测私有函数）：
//   1. turn/end reason.error { code:'INVALID_REQUEST', status:413 } → 不发回复 + 提示 + 下条消息换新会话；
//   2. 服务端中文文案（无结构化 status）也命中 —— 防宿主只透传 message；
//   3. 普通 error（非 413）绝不误触发 —— 不发提示、不换会话；
//   4. 主动回合（runPromptTurn 路径）同样命中且不发聊天提示（notify=false）。

import test from 'node:test'
import assert from 'node:assert/strict'

import { createModularCore } from '../src/host/modular-core.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const noopLog = { info() {}, warn() {}, debug() {}, error() {}, child: () => noopLog }

/** 事件可编程的最小 DSH：每轮按脚本投放 assistant/message / turn/end，会话可数（断言「换了新会话」）。 */
function scriptedFakeDsh({ script = [] } = {}) {
  const listeners = new Set()
  const sessionIds = []
  let turnNo = 0
  const workspaces = [{ id: 'ws', path: 'ws' }]
  const contextsMap = new Map()
  function makeAgent(id) {
    return {
      id,
      ctx: { get(name) { if (name === 'contexts') return { set: (k, v) => contextsMap.set(k, v), get: (k) => contextsMap.get(k) }; return null } },
      followup(msg) {
        const n = ++turnNo
        // 会话 id 必须用 agent 自己的 id：不换会话时不会新建 sess-2，按轮次取下标会拿到 undefined，
        // 监听器按 session.id 过滤就把事件全吞掉 —— 整个回合永不 settlement（夹具 bug，别用下标）。
        const session = { id }
        const events = script[n - 1] || [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }]
        for (const ev of events) for (const fn of [...listeners]) fn(session, { ...ev, data: { ...ev.data, turn: n } })
        return Promise.resolve()
      },
    }
  }
  const ctrl = {
    create: async () => { const id = `sess-${sessionIds.length + 1}`; sessionIds.push(id); return { sessionId: id } },
    resolveAgent: async (id) => ({ agent: makeAgent(id) }),
  }
  const ctx = {
    on(name, fn) { if (name !== 'session/event') return () => {}; listeners.add(fn); return () => listeners.delete(fn) },
    get(name) {
      if (name === 'sessionController') return ctrl
      if (name === 'workspaceRegistry') return { list: () => workspaces, create: async () => workspaces[0], archiveSession: (id) => { workspaces.archived = [...(workspaces.archived || []), id] } }
      return null
    },
  }
  return { ctx, sessionIds, workspaces }
}

function mkCore(dshRaw, cfgOver = {}) {
  const sent = []
  const sentTexts = []
  const cfg = {
    enabled: true, dryRun: false, botQQ: '20000002', ownerQQ: '10000001', ownerName: '主人',
    allow: { private: ['10000001'], groups: ['777'] }, longTasks: false,
    merge: { waitSec: 0.02, maxSec: 0.1 },
    ...cfgOver,
  }
  const core = createModularCore({
    dsh: dshRaw.ctx,
    onebot: {
      call: async (action, params) => {
        if (action.startsWith('send_')) {
          sent.push(action)
          const segs = Array.isArray(params?.message) ? params.message : []
          const txt = segs.map((s) => s?.data?.text || '').join('') || (typeof params?.message === 'string' ? params.message : '')
          sentTexts.push(txt)
        }
        return { message_id: String(sent.length) }
      },
    },
    mods: { contextFor: async () => '', commands: () => [], use: () => null },
    getConfig: () => cfg, logger: noopLog, log: noopLog,
  })
  return { core, sent, sentTexts }
}

const msgEv = (over = {}) => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  self_id: 20000002, user_id: 10000001, message_id: Math.floor(Math.random() * 1e9), time: Math.floor(Date.now() / 1000),
  sender: { user_id: 10000001, nickname: '主人' },
  message: [{ type: 'text', data: { text: '在吗' } }],
  ...over,
})

test('413 自愈：turn/end INVALID_REQUEST+413 → 本轮不发 + 提示 + 下条消息换新会话', async () => {
  const dshRaw = scriptedFakeDsh({ script: [
    [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '看不到的话' }] } } },
      { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'INVALID_REQUEST', status: 413, message: '本次对话上下文或图片过大：请求约 5.8 MiB，插件内存上限 64 MiB' } } } },
    ],
    [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新会话的回复' }] } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ],
  ] })
  const { core, sent, sentTexts } = mkCore(dshRaw)
  try {
    await core.dispatchLegacyEvent(msgEv({ message_id: 1 }))
    await sleep(300)
    // 回复不发（error 结束），但自愈提示只发 1 条（绝不能再双发通用「抖了一下」回执）
    assert.equal(sent.length, 1, '413 失败只发 1 条自愈提示，不能双发')
    assert.equal(sent[0], 'send_private_msg')
    assert.match(sentTexts[0], /64 MiB|上下文和图片太多/, '发出的是 413 专用提示')
    assert.doesNotMatch(sentTexts[0], /看不到的话|抖了一下/, '不发半截回复、也不混入通用失败提示')
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-1', '失败后映射保留（下一条消息才重建）')
    // 下一条消息：自动归档旧会话、新建并回复
    await core.dispatchLegacyEvent(msgEv({ message_id: 2 }))
    await sleep(300)
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-2', '下一条消息进入 → 换新会话')
    assert.equal(sent.length, 2, '1 条 413 提示 + 1 条新会话回复')
    assert.match(sentTexts[1], /新会话的回复/, '新会话正常回复')
    const archived = dshRaw.workspaces.archived || []
    assert.ok(archived.includes('sess-1'), '旧会话已归档（侧栏可找回）')
  } finally { await core.dispose() }
})

test('413 自愈：服务端中文文案（无结构化字段）也命中 —— 防宿主只透传 message', async () => {
  const dshRaw = scriptedFakeDsh({ script: [
    [
      { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'INVALID_REQUEST', message: '413 {"code":"plugin_request_too_large","message":"本次对话上下文或图片过大：请求约 5.8 MiB，插件内存上限 64 MiB","type":"invalid_request_error"}' } } } },
    ],
    [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新会话的回复' }] } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ],
  ] })
  const { core } = mkCore(dshRaw)
  try {
    await core.dispatchLegacyEvent(msgEv({ message_id: 1 }))
    await sleep(300)
    await core.dispatchLegacyEvent(msgEv({ message_id: 2 }))
    await sleep(300)
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-2', '文案命中 → 下一条消息换新会话')
  } finally { await core.dispose() }
})

test('413 自愈：普通错误（非 413）不换会话 —— 不误伤正常失败重试路径（但会给失败回执）', async () => {
  const dshRaw = scriptedFakeDsh({ script: [
    [{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', status: 429, message: 'rate limit exceeded' } } } }],
    [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新会话的回复' }] } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ],
  ] })
  const { core, sent, sentTexts } = mkCore(dshRaw)
  try {
    await core.dispatchLegacyEvent(msgEv({ message_id: 1 }))
    await sleep(300)
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-1', '普通失败不换会话（429 该走重试，不该归档重建）')
    assert.equal(sent.length, 1, '429 回合只发 1 条限流回执')
    assert.match(sentTexts[0], /限流/, '429 回执必须准确命中 rate-limit（含「限流」），不能退回通用「抖了一下」')
    assert.doesNotMatch(sentTexts[0], /抖了一下/)
    await core.dispatchLegacyEvent(msgEv({ message_id: 2 }))
    await sleep(300)
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-1', '第二个回合仍在同一会话')
    // 2026-11-27 起：429 这类普通失败不再静默 —— 会发一条「模型限流了，等一会儿」的分类回执
    //（真机：上游 403/429 过去在 QQ 侧一个字都没有，用户以为她不理人）。
    // 但「不换会话」这条 413 自愈契约不变：429 该走重试，不该归档重建。
    const sends = sent.filter((a) => a === 'send_private_msg').length
    assert.equal(sends, 2, '429 回合给 1 条限流回执 + 第二个回合 1 条正常回复')
    assert.match(sentTexts[1], /新会话的回复/)
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-1', '仍然不换会话')
  } finally { await core.dispose() }
})

test('413 自愈：纯文本 no-code message（"413 … 上下文或图片过大"）也命中 —— 兜底旧宿主', async () => {
  const dshRaw = scriptedFakeDsh({ script: [
    [{ type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'HTTP 413：请求约 5.8 MiB，上下文或图片过大' } } } }],
    [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新会话的回复' }] } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ],
  ] })
  const { core } = mkCore(dshRaw)
  try {
    await core.dispatchLegacyEvent(msgEv({ message_id: 1 }))
    await sleep(300)
    await core.dispatchLegacyEvent(msgEv({ message_id: 2 }))
    await sleep(300)
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-2', '兜底文案命中 → 换新会话')
  } finally { await core.dispose() }
})

test('413 自愈：主动回合（runPromptTurn）同样命中且不往聊天里发提示（notify=false）', async () => {
  const dshRaw = scriptedFakeDsh({ script: [
    [{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'INVALID_REQUEST', status: 413, message: '413 plugin_request_too_large' } } } }],
    [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '主动回合的正文' }] } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ],
  ] })
  const { core, sent } = mkCore(dshRaw)
  try {
    await assert.rejects(() => core.runPromptTurn('private:10000001', '写日记'), /未正常结束/)
    assert.deepEqual(sent, [], '主动回合失败不往聊天里灌提示（这轮本来就不投递）')
    // 下一次主动回合：先归档重建，再正常返回正文
    const text = await core.runPromptTurn('private:10000001', '再写一次')
    assert.equal(text, '主动回合的正文')
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-2', '主动回合路径也换新会话')
    assert.ok((dshRaw.workspaces.archived || []).includes('sess-1'), '旧会话已归档')
  } finally { await core.dispose() }
})

test('413 自愈：pi-ai 把 plugin_request_too_large 误判成 CONTEXT_WINDOW_EXCEEDED 时也要命中', async () => {
  // 真机 2026-11-20：pi-ai 路由下，dsh-llm-pi-ai 的 isContextOverflow() 用
  // /request_too_large/i 匹配错误文案，而 `plugin_request_too_large` 正好含这个子串，
  // 于是 code 被标成 CONTEXT_WINDOW_EXCEEDED（且 pi-ai 路径不填 status）。
  // 旧口径要求 INVALID_REQUEST 或 status===413，两个都不匹配 → 自愈失效、会话连挂 6 轮。
  const dshRaw = scriptedFakeDsh({ script: [
    [{ type: 'turn/end', data: { reason: { kind: 'error', error: {
      code: 'CONTEXT_WINDOW_EXCEEDED',
      message: '413: {"code":"plugin_request_too_large","message":"本次对话上下文或图片过大：请求约 5.3 MiB，插件内存上限 64 MiB；请新建会话或减少图片后重试","type":"invalid_request_error"}',
    } } } }],
    [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新会话的回复' }] } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ],
  ] })
  const { core, sent, sentTexts } = mkCore(dshRaw)
  try {
    await core.dispatchLegacyEvent(msgEv({ message_id: 1 }))
    await sleep(300)
    assert.equal(sent.length, 1, '413 只发 1 条人话提示（绝不双发）')
    assert.equal(sent[0], 'send_private_msg')
    assert.match(sentTexts[0], /64 MiB|上下文和图片太多/, '仍走 413 提示而非通用失败')
    await core.dispatchLegacyEvent(msgEv({ message_id: 2 }))
    await sleep(300)
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-2', 'code 是 CONTEXT_WINDOW_EXCEEDED 也要换会话')
    assert.ok((dshRaw.workspaces.archived || []).includes('sess-1'), '旧会话已归档')
  } finally { await core.dispose() }
})

test('413 自愈：真·上下文窗口超限不误判成 413（走 context-window 提示并兑现换新会话）', async () => {
  // 区分两条链路：
  //   · 413（字节/图片过大）→ handleOversizedTurn，提示「超过 64 MiB 上限 / 图片类内容也会少带一些」；
  //   · 真·token 超窗（turn/end 落 error 且 code=CONTEXT_WINDOW_EXCEEDED）→ handleTurnFailure 归类
  //     context-window，提示「模型的窗口装不下了。你发下一条消息时我会重新开始」，并登记
  //     contextResetChats 在下一条消息到来时真正归档重建会话（兑现承诺）。
  const dshRaw = scriptedFakeDsh({ script: [
    [{ type: 'turn/end', data: { reason: { kind: 'error', error: {
      code: 'CONTEXT_WINDOW_EXCEEDED',
      message: 'prompt is too long: 213462 tokens > 200000 maximum',
    } } } }],
    [
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '新会话的回复' }] } } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ],
  ] })
  const { core, sent, sentTexts } = mkCore(dshRaw)
  try {
    await core.dispatchLegacyEvent(msgEv({ message_id: 1 }))
    await sleep(300)
    assert.equal(sent.length, 1, '只发 1 条超窗提示')
    assert.match(sentTexts[0], /窗口装不下/, '走 context-window 分类提示')
    assert.doesNotMatch(sentTexts[0], /64 MiB|图片/, '不被误判为 413 字节/图片过大')
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-1', '失败当轮保留映射，下一条消息再重建') /* pii-scan:ignore */
    await core.dispatchLegacyEvent(msgEv({ message_id: 2 }))
    await sleep(300)
    assert.equal(core.registry.peek('private:10000001')?.sessionId, 'sess-2', 'context-window 兑现承诺：下一条消息换新会话') /* pii-scan:ignore */
    assert.ok((dshRaw.workspaces.archived || []).includes('sess-1'), '旧会话已归档')
  } finally { await core.dispose() }
})
